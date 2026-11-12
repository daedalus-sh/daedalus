@testable import DaedalusFeature
import Foundation
import Testing

struct CorePairLinkTests {
    static let payload = """
    {"v":1,"app":"https://daedalus-app.example.org","box":"s2-server","code":"q0b3yJ0Qm1cXwq2m3Cw0n8l1v2o9d5t7u4s6r8a0bCd",\
    "wireguard":{"private_key":"oK56DE9Ue9zK76rAc8pBl6opph+1v36lm7cXXsQKrQM=","address":"10.8.0.9",\
    "server_public_key":"HIgo9xNzJMWLKASShiTqIybxZ0U3wGLiUeJ1PKf8ykw=","endpoint":"s2.example.org:51820",\
    "allowed_ips":["192.168.0.2/32"]}}
    """

    static func link(_ json: String = payload) -> String {
        let encoded = Data(json.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return "daedalus://pair?p=\(encoded)"
    }

    @Test func readsTheLinkTheBoxShows() throws {
        let link = try #require(PairLink(string: Self.link()))
        #expect(link.box == "s2-server")
        #expect(link.appURL?.host() == "daedalus-app.example.org")
        #expect(link.code.count == 43)
        #expect(link.wireguard.allowedIps == ["192.168.0.2/32"])
        #expect(link.wireguard.presharedKey == nil)
    }

    @Test func toleratesWhitespaceAroundAScannedLink() {
        #expect(PairLink(string: "  \(Self.link())\n") != nil)
    }

    @Test func refusesANewerVersion() {
        #expect(PairLink(string: Self.link(Self.payload.replacingOccurrences(of: "\"v\":1", with: "\"v\":2"))) == nil)
    }

    @Test func refusesAnAppThatIsNotAnHTTPSOrigin() {
        let plain = Self.payload.replacingOccurrences(of: "https://daedalus-app.example.org", with: "http://daedalus-app.example.org")
        #expect(PairLink(string: Self.link(plain)) == nil)
        let path = Self.payload.replacingOccurrences(of: "example.org\"", with: "example.org/elsewhere\"")
        #expect(PairLink(string: Self.link(path)) == nil)
    }

    @Test func refusesOtherLinks() {
        #expect(PairLink(string: "https://example.org/pair?p=abc") == nil)
        #expect(PairLink(string: "daedalus://other?p=abc") == nil)
        #expect(PairLink(string: "daedalus://pair?p=not-json") == nil)
        #expect(PairLink(string: "daedalus://pair") == nil)
    }
}
