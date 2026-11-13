import Foundation
import Network
import Observation
import Security
import UIKit

/// What pairing left on this device: where the box is, the tunnel to it, the controller to link to, and
/// this node's API token. One Keychain item; nothing of it is kept anywhere else.
nonisolated struct Pairing: Codable, Hashable, Sendable {
    var app: String
    var boxName: String
    var nodeID: String
    var token: String
    var wireguard: WireguardConfig
    var controller: API.Paired.Controller

    var appURL: URL? { URL(string: app) }
}

/// This device's link to its box: the pairing, the core that carries it, and every call through it.
///
/// A request goes URLSession → the core's loopback proxy → WireGuard → the box's own HTTPS, so the
/// certificate is checked as on any network and nothing else on the device is routed anywhere. Beside
/// it, the core keeps the node's link to the controller and reports this device over it.
@Observable
final class Box {
    static let shared = Box()

    private(set) var pairing: Pairing?
    private(set) var isPairing = false
    private(set) var pairError: String?
    /// The box answered 401: this node was revoked or forgotten in Settings › Machines.
    private(set) var removed = false
    /// The last transport failure, cleared by the next answer.
    private(set) var unreachable: String?
    /// Counts returns to the foreground: screens key their polling on it, so each starts fresh.
    private(set) var epoch = 0

    @ObservationIgnored private var session: URLSession?
    @ObservationIgnored private var opening: Task<URLSession, Error>?
    /// Out of the foreground: the screens make no calls. True from the start when iOS launched the app
    /// in the background (a refresh, or the watch asking).
    @ObservationIgnored private var suspended = false
    /// A background report is under way: it owns the core until it ends.
    @ObservationIgnored private var reporting = false

    init() {
        suspended = UIApplication.shared.applicationState == .background
        Keychain.openAfterFirstUnlock()
        pairing = Keychain.read(Pairing.self, account: Keychain.pairing)
    }

    var isPaired: Bool { pairing != nil }

    // MARK: Pairing

    /// Bring the link's tunnel up, spend its ticket through it as this device's node key, and keep what
    /// comes back. A device that paired before reuses its key, so the box knows it as the same machine.
    @discardableResult
    func pair(_ link: PairLink) async -> Bool {
        guard !isPairing else { return false }
        guard let app = link.appURL else {
            pairError = "That code does not name a box."
            return false
        }
        isPairing = true
        pairError = nil
        defer { isPairing = false }
        do {
            await close()
            let identity = try await identity()
            let facts = DeviceFacts.current()
            let access = try await NodeCore.start(
                CoreConfig(wireguard: link.wireguard, proxyPort: app.port ?? 443, node: nil))
            let session = try Self.session(through: access)
            defer { session.finishTasksAndInvalidate() }
            let body = API.PairBody(code: link.code, publicKey: identity.publicKey, hostname: facts.name,
                                    os: facts.os, arch: facts.arch, version: facts.version, model: facts.model)
            let (data, response) = try await send(API.pairRequest(app: app, body: body), on: session)
            let paired = try API.paired(status: response.statusCode, data: data)
            guard paired.node == identity.nodeID else {
                throw BoxError.server("The box paired a different device. Add this one again.")
            }
            let pairing = Pairing(app: link.app, boxName: paired.box.hostname, nodeID: paired.node,
                                  token: paired.token, wireguard: link.wireguard, controller: paired.controller)
            guard Keychain.save(pairing, account: Keychain.pairing) else {
                throw BoxError.server("The pairing could not be saved to the Keychain.")
            }
            await close()
            self.pairing = pairing
            removed = false
            unreachable = nil
            return true
        } catch {
            await close()
            pairError = error.localizedDescription
            return false
        }
    }

    func clearPairError() { pairError = nil }

    /// Leave the box: tell it over the link (it deletes this node's token and tunnel), then forget it
    /// here. The node key stays, so pairing again is the same machine.
    func unpair() async {
        if pairing != nil, !removed {
            _ = try? await transport()
            _ = await NodeCore.leave()
        }
        Keychain.delete(account: Keychain.pairing)
        pairing = nil
        removed = false
        unreachable = nil
        await close()
    }

    // MARK: Calls

    /// One API call, decoded.
    func call<T: Decodable & Sendable>(_ endpoint: API.Endpoint, as type: T.Type = T.self) async throws -> T {
        guard let pairing, let app = pairing.appURL, !removed else { throw BoxError.notPaired }
        if suspended { throw CancellationError() }
        let request = try API.request(endpoint, app: app, token: pairing.token)
        do {
            let (data, response) = try await send(request, on: try await transport())
            unreachable = nil
            return try API.decode(type, status: response.statusCode, data: data)
        } catch let error as BoxError {
            switch error {
            case .unauthorized: removed = true
            case .unreachable(let why): unreachable = why
            default: break
            }
            throw error
        }
    }

    /// A call whose answer does not matter beyond having worked.
    func send(_ endpoint: API.Endpoint) async throws {
        _ = try await call(endpoint, as: Ignored.self)
    }

    /// Bring the core up if it is not, and hand the link a fresh sample of this device. The link sends
    /// it now if connected, else when it connects: this is what keeps the box's page for this device true.
    func reportDevice() async {
        guard isPaired, !removed, !suspended, (try? await transport()) != nil else { return }
        guard let sample = DeviceFacts.current().telemetry() else { return }
        await NodeCore.report(sample)
    }

    /// One report with the app out of the foreground: bring the core up, hand the link a sample, wait for
    /// the link to carry it to the controller, and let the core go again. iOS gives a refresh about 30 s.
    /// Does nothing while the app is open: its own loop reports then.
    func reportInBackground() async {
        restorePairing()
        guard isPaired, !removed, !reporting, UIApplication.shared.applicationState == .background else { return }
        reporting = true
        defer { reporting = false }
        if (try? await transport()) != nil, let sample = DeviceFacts.current().telemetry() {
            await NodeCore.report(sample)
            await delivered()
        }
        // Opened meanwhile, the app keeps the core: it is the foreground's now.
        if UIApplication.shared.applicationState == .background { await close() }
    }

    /// The same, when nothing else holds the app awake (the watch asked): iOS is told the work is under
    /// way, and the work stops when iOS says time is up.
    func reportHeld() async {
        let work = Task { await reportInBackground() }
        let hold = UIApplication.shared.beginBackgroundTask(withName: "report") { work.cancel() }
        await work.value
        UIApplication.shared.endBackgroundTask(hold)
    }

    /// Wait until the link is up and approved (it pushes the sample at once then), and give that write a
    /// moment to leave through the tunnel. Gives up after 20 s, or when the task is cancelled.
    private func delivered() async {
        for _ in 0..<40 where !Task.isCancelled {
            if let link = await NodeCore.status()?.link, link.connected == true, link.state == "approved" {
                try? await Task.sleep(for: .seconds(2))
                return
            }
            try? await Task.sleep(for: .milliseconds(500))
        }
    }

    /// A launch before the device's first unlock reads no Keychain: read the pairing again once it can be.
    private func restorePairing() {
        if pairing == nil { pairing = Keychain.read(Pairing.self, account: Keychain.pairing) }
    }

    /// The app left the foreground: iOS stops the core's sockets there, so let it go and start clean.
    /// A background report under way keeps the core and lets it go itself.
    func suspend() async {
        suspended = true
        if !reporting { await close() }
    }

    /// Back in the foreground: calls go out again, over a core the first of them starts.
    func resume() {
        restorePairing()
        guard suspended else { return }
        suspended = false
        epoch += 1
    }

    /// How the core stands. When the controller has rotated its key, the new pin is kept: the link
    /// followed the rotation, and the next start must trust what it trusts now.
    func coreStatus() async -> CoreStatus? {
        let status = await NodeCore.status()
        if let pin = status?.link?.pin, var pairing, Self.bare(pin) != Self.bare(pairing.controller.pin) {
            pairing.controller.pin = pin
            if Keychain.save(pairing, account: Keychain.pairing) { self.pairing = pairing }
        }
        return status
    }

    private static func bare(_ fingerprint: String) -> String {
        fingerprint.lowercased().filter(\.isHexDigit)
    }

    // MARK: Transport

    private func identity() async throws -> NodeIdentity {
        if let stored = Keychain.read(NodeIdentity.self, account: Keychain.identity) { return stored }
        let made = try await NodeCore.newIdentity()
        guard Keychain.save(made, account: Keychain.identity) else {
            throw BoxError.server("This device's key could not be saved to the Keychain.")
        }
        return made
    }

    private func transport() async throws -> URLSession {
        if let session { return session }
        if let opening { return try await opening.value }
        guard let pairing, let app = pairing.appURL else { throw BoxError.notPaired }
        let task = Task { try await self.open(pairing, app: app) }
        opening = task
        defer { opening = nil }
        let session = try await task.value
        self.session = session
        return session
    }

    private func open(_ pairing: Pairing, app: URL) async throws -> URLSession {
        let identity = try await identity()
        let facts = DeviceFacts.current()
        let node = CoreConfig.Node(
            seed: identity.seed, controller: pairing.controller,
            hello: .init(hostname: facts.name, os: facts.os, arch: facts.arch, agentVersion: facts.version,
                         model: facts.model, osName: facts.os == "ipados" ? "iPadOS" : "iOS",
                         osVersion: facts.osVersion))
        let access = try await NodeCore.start(
            CoreConfig(wireguard: pairing.wireguard, proxyPort: app.port ?? 443, node: node))
        return try Self.session(through: access)
    }

    private static func session(through access: ProxyAccess) throws -> URLSession {
        guard let port = NWEndpoint.Port(rawValue: UInt16(clamping: access.port)) else {
            throw BoxError.unreachable("The tunnel gave no port.")
        }
        var proxy = ProxyConfiguration(httpCONNECTProxy: .hostPort(host: "127.0.0.1", port: port))
        proxy.applyCredential(username: access.username, password: access.password)
        proxy.allowFailover = false
        let configuration = URLSessionConfiguration.ephemeral
        configuration.proxyConfigurations = [proxy]
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 120
        configuration.waitsForConnectivity = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        return URLSession(configuration: configuration)
    }

    private func close() async {
        opening?.cancel()
        opening = nil
        session?.invalidateAndCancel()
        session = nil
        await NodeCore.stop()
    }

    private func send(_ request: URLRequest, on session: URLSession) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw BoxError.server("The box did not answer over HTTP.")
            }
            return (data, http)
        } catch let error as URLError {
            if error.code == .cancelled { throw CancellationError() }
            throw BoxError.unreachable(Self.reason(error))
        }
    }

    private static func reason(_ error: URLError) -> String {
        switch error.code {
        case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed:
            "This device is offline."
        case .timedOut, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed:
            "The box did not answer through the tunnel."
        case .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateHasUnknownRoot,
             .secureConnectionFailed:
            "The box's certificate was not accepted."
        default:
            error.localizedDescription
        }
    }
}

/// Generic-password Keychain items, as JSON. This device only, never synced or restored to another: they
/// hold the tunnel's private key, the node's key and its token. Readable once the device has been unlocked
/// since it started, so a background report works with the screen locked.
enum Keychain {
    static let pairing = "box"
    static let identity = "node"
    private static let service = "com.santiagotoscanini.daedalus"

    private static func query(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    static func read<Value: Decodable>(_ type: Value.Type, account: String) -> Value? {
        var query = query(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data
        else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    @discardableResult
    static func save<Value: Encodable>(_ value: Value, account: String) -> Bool {
        guard let data = try? JSONEncoder().encode(value) else { return false }
        let base = query(account)
        let status = SecItemUpdate(base as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        guard status == errSecItemNotFound else { return status == errSecSuccess }
        var item = base
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    /// Items saved before background reports were readable only while unlocked: move them over. Done at
    /// every launch; it changes nothing once moved, and waits for an unlocked launch if the device is locked.
    static func openAfterFirstUnlock() {
        for account in [pairing, identity] {
            _ = SecItemUpdate(query(account) as CFDictionary, [
                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            ] as CFDictionary)
        }
    }

    static func delete(account: String) {
        _ = SecItemDelete(query(account) as CFDictionary)
    }
}
