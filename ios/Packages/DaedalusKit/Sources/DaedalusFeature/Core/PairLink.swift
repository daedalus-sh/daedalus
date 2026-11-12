import Foundation

/// The box's WireGuard client config for this device, as the pair link carries it and the tunnel takes it.
nonisolated struct WireguardConfig: Codable, Hashable, Sendable {
    var privateKey: String
    var address: String
    var serverPublicKey: String
    var presharedKey: String?
    var endpoint: String
    var allowedIps: [String]

    enum CodingKeys: String, CodingKey {
        case privateKey = "private_key"
        case address
        case serverPublicKey = "server_public_key"
        case presharedKey = "preshared_key"
        case endpoint
        case allowedIps = "allowed_ips"
    }
}

/// What the QR code in Settings › Machines says: `daedalus://pair?p=<base64url JSON>`.
/// The tunnel config is usable at once; the code is spent once, through the tunnel, for this device's token.
nonisolated struct PairLink: Codable, Hashable, Sendable {
    var v: Int
    /// The control plane's origin, `https://host`.
    var app: String
    /// The box's hostname, for display.
    var box: String
    var code: String
    var wireguard: WireguardConfig

    static let scheme = "daedalus"
    static let version = 1

    init?(string: String) {
        guard let url = URL(string: string.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
        self.init(url: url)
    }

    init?(url: URL) {
        guard url.scheme?.lowercased() == Self.scheme, url.host() == "pair",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let payload = items.first(where: { $0.name == "p" })?.value,
              let data = Data(base64URL: payload),
              let link = try? JSONDecoder().decode(PairLink.self, from: data),
              link.v == Self.version, link.appURL != nil, !link.code.isEmpty
        else { return nil }
        self = link
    }

    /// The origin as a URL: https, a host, no path.
    var appURL: URL? {
        guard let url = URL(string: app), url.scheme == "https", let host = url.host(), !host.isEmpty,
              url.path().isEmpty || url.path() == "/"
        else { return nil }
        return url
    }
}

nonisolated extension Data {
    /// Base64url, with or without padding.
    init?(base64URL: String) {
        var s = base64URL.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s.append("=") }
        self.init(base64Encoded: s)
    }
}
