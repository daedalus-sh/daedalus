import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking // URLRequest, when the pure layer is checked on Linux
#endif

/// The box's API for this app (ios/docs/api.md): `/api/v1` with the node's bearer token, and the one
/// pairing call before there is a token. Pure: this builds requests and reads answers; `Box` sends them.
nonisolated enum API {
    struct Endpoint: Sendable {
        var method = "GET"
        var path: String
        var query: [URLQueryItem] = []
        var body: JSONValue?

        static func get(_ path: String, _ query: [String: String?] = [:]) -> Endpoint {
            Endpoint(path: path, query: query.compactMap { key, value in
                value.map { URLQueryItem(name: key, value: $0) }
            }.sorted { $0.name < $1.name })
        }

        static func post(_ path: String, _ body: JSONValue? = nil) -> Endpoint {
            Endpoint(method: "POST", path: path, body: body)
        }
    }

    // MARK: Endpoints

    static let me = Endpoint.get("me")
    static let overview = Endpoint.get("overview")
    static let errors = Endpoint.get("errors")
    static let updates = Endpoint.get("updates")
    static let updatesStatus = Endpoint.get("updates/status")
    static let apply = Endpoint.get("apply")
    static let machines = Endpoint.get("machines")
    static let claude = Endpoint.get("claude")

    static func logs(container: String, text: String?) -> Endpoint {
        .get("logs", ["container": container, "text": text?.isEmpty == false ? text : nil, "limit": "200"])
    }

    static func changelog(container: String) -> Endpoint {
        .get("updates/changelog", ["container": container])
    }

    static func queueAdd(container: String, toTag: String?, confirm: String?) -> Endpoint {
        var add: [String: JSONValue] = ["container": .string(container)]
        if let toTag { add["toTag"] = .string(toTag) }
        if let confirm { add["confirm"] = .string(confirm) }
        return .post("updates/queue", ["add": .object(add)])
    }

    static func queueRemove(container: String) -> Endpoint {
        .post("updates/queue", ["remove": .string(container)])
    }

    /// Run the queue as it stands.
    static let runQueue = Endpoint.post("updates/run", [:])

    /// Update one pin now.
    static func run(container: String, toTag: String?, confirm: String?) -> Endpoint {
        var target: [String: JSONValue] = ["container": .string(container)]
        if let toTag { target["toTag"] = .string(toTag) }
        var body: [String: JSONValue] = ["targets": [.object(target)]]
        if let confirm { body["confirm"] = [.string(confirm)] }
        return .post("updates/run", .object(body))
    }

    static let updateEngine = Endpoint.post("updates/engine")
    static let updateClaudeCode = Endpoint.post("updates/claude-code")
    static let runApply = Endpoint.post("apply")

    static func machine(_ id: String) -> Endpoint { .get("machines/\(id)") }

    static func command(machine: String, _ command: String) -> Endpoint {
        .post("machines/\(machine)/command", ["command": .string(command)])
    }

    static func claudeRestart(machine: String) -> Endpoint {
        .post("claude/restart", ["machine": .string(machine)])
    }

    static func claudeSession(machine: String, action: String, session: String) -> Endpoint {
        .post("claude/session", ["machine": .string(machine), "action": .string(action), "session": .string(session)])
    }

    static func claudeAction(machine: String, request: String) -> Endpoint {
        .get("claude/action", ["machine": machine, "request": request])
    }

    // MARK: Requests

    static func request(_ endpoint: Endpoint, app: URL, token: String) throws -> URLRequest {
        var url = app.appending(path: "api/v1").appending(path: endpoint.path)
        if !endpoint.query.isEmpty { url.append(queryItems: endpoint.query) }
        var request = URLRequest(url: url)
        request.httpMethod = endpoint.method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body = endpoint.body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        return request
    }

    private struct ErrorBody: Decodable {
        var error: Detail

        struct Detail: Decodable {
            var code: String
            var message: String
        }
    }

    static func decode<T: Decodable>(_ type: T.Type, status: Int, data: Data) throws -> T {
        guard (200 ..< 300).contains(status) else { throw error(status: status, data: data) }
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw BoxError.server("The box's answer was not what this app expects: \(describe(error))")
        }
    }

    static func error(status: Int, data: Data) -> BoxError {
        let detail = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error
        switch (status, detail?.code) {
        case (401, _), (_, "unauthorized"): return .unauthorized
        case (_, "refused"): return .refused(detail?.message ?? "The box refused.")
        case (_, "unavailable"): return .unavailable(detail?.message ?? "The box could not answer that now.")
        default: return .server(detail?.message ?? "The box answered \(status).")
        }
    }

    // MARK: Pairing

    /// `POST /api/node/pair`: the ticket from the QR, this device's node key, and what it calls itself.
    struct PairBody: Encodable, Sendable {
        var code: String
        var publicKey: String
        var hostname: String
        var os: String
        var arch: String
        var version: String
        var model: String

        enum CodingKeys: String, CodingKey {
            case code, hostname, os, arch, version, model
            case publicKey = "public_key"
        }
    }

    struct Paired: Decodable, Sendable {
        var node: String
        var controller: Controller
        var box: BoxName
        var token: String

        struct Controller: Codable, Hashable, Sendable {
            var pin: String
            var address: String
        }

        struct BoxName: Decodable, Sendable {
            var hostname: String
        }
    }

    private struct PairError: Decodable {
        var error: String
    }

    static func pairRequest(app: URL, body: PairBody) throws -> URLRequest {
        var request = URLRequest(url: app.appending(path: "api/node/pair"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONEncoder().encode(body)
        return request
    }

    static func paired(status: Int, data: Data) throws -> Paired {
        if status == 200, let paired = try? JSONDecoder().decode(Paired.self, from: data) { return paired }
        if let body = try? JSONDecoder().decode(PairError.self, from: data) { throw BoxError.refused(body.error) }
        throw BoxError.server("Pairing answered \(status).")
    }

    /// A decoding error, as the one line worth showing: which field, and why.
    static func describe(_ error: Error) -> String {
        guard let error = error as? DecodingError else { return error.localizedDescription }
        func path(_ context: DecodingError.Context) -> String {
            context.codingPath.map { $0.intValue.map { "[\($0)]" } ?? $0.stringValue }.joined(separator: ".")
        }
        switch error {
        case .keyNotFound(let key, let context): return "missing \(path(context)).\(key.stringValue)"
        case .typeMismatch(_, let context): return "wrong type at \(path(context))"
        case .valueNotFound(_, let context): return "null at \(path(context))"
        case .dataCorrupted(let context): return "unreadable at \(path(context))"
        @unknown default: return "unreadable"
        }
    }
}

nonisolated enum BoxError: Error, Equatable, LocalizedError, Sendable {
    /// The box no longer accepts this device's token: it was revoked or forgotten in Settings › Machines.
    case unauthorized
    /// The box understood and will not, with the flow's own reason.
    case refused(String)
    /// Something the answer needs did not respond.
    case unavailable(String)
    case server(String)
    /// Nothing answered: no network, or the tunnel could not reach the box.
    case unreachable(String)
    case notPaired

    var errorDescription: String? {
        switch self {
        case .unauthorized: "This device was removed from the box. Pair it again from Settings › Machines."
        case .refused(let why), .unavailable(let why), .server(let why), .unreachable(let why): why
        case .notPaired: "This device is not paired with a box."
        }
    }
}
