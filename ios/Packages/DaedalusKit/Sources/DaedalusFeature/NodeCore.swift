import DaedalusCoreFFI
import Foundation

/// Where the app's requests enter its WireGuard tunnel: a loopback HTTP CONNECT proxy the core runs
/// inside this process, with a credential made at every start (loopback is shared between apps).
nonisolated struct ProxyAccess: Decodable, Hashable, Sendable {
    var port: Int
    var username: String
    var password: String
}

/// This device as a node: an ed25519 key. The seed is the secret, kept in the Keychain; the rest follows
/// from it.
nonisolated struct NodeIdentity: Codable, Hashable, Sendable {
    var seed: String
    var publicKey: String
    var nodeID: String
    var fingerprint: String

    enum CodingKeys: String, CodingKey {
        case seed, fingerprint
        case publicKey = "public_key"
        case nodeID = "node_id"
    }
}

/// What the core says about itself: the tunnel, and the link to the controller.
nonisolated struct CoreStatus: Decodable, Hashable, Sendable {
    var running: Bool
    var connections: Int?
    var tunnel: TunnelStatus?
    var link: Link?

    struct TunnelStatus: Decodable, Hashable, Sendable {
        var endpoint: String?
        /// Seconds since the last WireGuard handshake; nil before the first.
        var handshakeAgoSecs: Double?
        var error: String?

        enum CodingKeys: String, CodingKey {
            case endpoint, error
            case handshakeAgoSecs = "last_handshake_secs"
        }
    }

    struct Link: Decodable, Hashable, Sendable {
        /// off | connecting | pending | approved | revoked | refused | key-changed
        var state: String
        var connected: Bool?
        /// The controller key trusted now: it moves when the controller rotates its key.
        var pin: String?
        var error: String?
    }
}

/// What the core needs to run: the tunnel, the one port its proxy dials, and (once paired) the node.
nonisolated struct CoreConfig: Encodable, Sendable {
    var wireguard: WireguardConfig
    var proxyPort: Int
    var node: Node?

    struct Node: Encodable, Sendable {
        var seed: String
        var controller: API.Paired.Controller
        var hello: Hello
    }

    struct Hello: Encodable, Sendable {
        var hostname: String
        var os: String
        var arch: String
        var agentVersion: String
        var model: String
        var osName: String
        var osVersion: String

        enum CodingKeys: String, CodingKey {
            case hostname, os, arch, model
            case agentVersion = "agent_version"
            case osName = "os_name"
            case osVersion = "os_version"
        }
    }

    enum CodingKeys: String, CodingKey {
        case wireguard, node
        case proxyPort = "proxy_port"
    }
}

/// The Rust core (ios/core): the agent's node link, its userspace WireGuard tunnel and a TCP stack, in
/// this process. No VPN profile, no Network Extension: only this app's traffic rides it, and only to the
/// box. Every call blocks briefly (a bind, a thread join), so each runs off the main actor.
nonisolated enum NodeCore {
    private struct Answer<Value: Decodable>: Decodable {
        var ok: Value?
        var error: String?
    }

    private struct StartedProxy: Decodable {
        var proxy: ProxyAccess
    }

    private struct Sent: Decodable {
        var sent: Bool
    }

    @concurrent
    static func newIdentity() async throws -> NodeIdentity {
        try unwrap(daedalus_identity_new(), as: NodeIdentity.self, doing: "make this device's key")
    }

    /// Bring the tunnel, its proxy and (with a node) the link up, replacing a running core.
    /// Nothing is sent until the first request or the link's first dial.
    @concurrent
    static func start(_ config: CoreConfig) async throws -> ProxyAccess {
        let json = String(decoding: try JSONEncoder().encode(config), as: UTF8.self)
        let pointer = json.withCString { daedalus_start($0) }
        return try unwrap(pointer, as: StartedProxy.self, doing: "start the tunnel").proxy
    }

    /// Hand the link a fresh sample of this device (DeviceReport) to send.
    @concurrent
    static func report(_ telemetry: Data) async {
        let json = String(decoding: telemetry, as: UTF8.self)
        daedalus_free(json.withCString { daedalus_report($0) })
    }

    @concurrent
    static func status() async -> CoreStatus? {
        try? JSONDecoder().decode(CoreStatus.self, from: take(daedalus_status()))
    }

    /// Tell the box this node is leaving (it deletes the token and the tunnel), then stop.
    @concurrent
    static func leave() async -> Bool {
        (try? unwrap(daedalus_leave(), as: Sent.self, doing: "leave"))?.sent ?? false
    }

    @concurrent
    static func stop() async {
        daedalus_stop()
    }

    private static func unwrap<Value: Decodable>(_ pointer: UnsafeMutablePointer<CChar>?, as type: Value.Type,
                                                 doing what: String) throws -> Value {
        guard let answer = try? JSONDecoder().decode(Answer<Value>.self, from: take(pointer)) else {
            throw BoxError.unreachable("The app could not \(what).")
        }
        guard let value = answer.ok else {
            throw BoxError.unreachable("The app could not \(what): \(answer.error ?? "no reason given").")
        }
        return value
    }

    /// The core's string, copied and handed back to it to free.
    private static func take(_ pointer: UnsafeMutablePointer<CChar>?) -> Data {
        guard let pointer else { return Data() }
        defer { daedalus_free(pointer) }
        return Data(String(cString: pointer).utf8)
    }
}
