@testable import DaedalusFeature
import Foundation
import Testing

struct CoreAPITests {
    let app = URL(string: "https://daedalus-app.example.org")!

    @Test func aReadCarriesTheTokenAndItsQuery() throws {
        let request = try API.request(API.logs(container: "sonarr", text: "error"), app: app, token: "dnode_x")
        #expect(request.httpMethod == "GET")
        #expect(request.url?.absoluteString
            == "https://daedalus-app.example.org/api/v1/logs?container=sonarr&limit=200&text=error")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer dnode_x")
        #expect(request.httpBody == nil)
    }

    @Test func anEmptyFilterIsLeftOut() throws {
        let request = try API.request(API.logs(container: "sonarr", text: ""), app: app, token: "t")
        #expect(request.url?.query() == "container=sonarr&limit=200")
    }

    @Test func aWriteSendsItsBodyAsJSON() throws {
        let request = try API.request(API.run(container: "pg", toTag: "17.2", confirm: "pg"), app: app, token: "t")
        #expect(request.httpMethod == "POST")
        #expect(request.url?.path() == "/api/v1/updates/run")
        let body = try JSONDecoder().decode(JSONValue.self, from: #require(request.httpBody))
        #expect(body == ["targets": [["container": "pg", "toTag": "17.2"]], "confirm": ["pg"]])
    }

    @Test func runningTheQueueSendsNoTargets() throws {
        let request = try API.request(API.runQueue, app: app, token: "t")
        #expect(try JSONDecoder().decode(JSONValue.self, from: #require(request.httpBody)) == [:])
    }

    @Test func thePairingCallNamesTheKeyAsTheBoxDoes() throws {
        let body = API.PairBody(code: "c", publicKey: "ab", hostname: "Phone", os: "ios", arch: "arm64",
                                version: "0.1.0", model: "iPhone17,1")
        let request = try API.pairRequest(app: app, body: body)
        #expect(request.url?.path() == "/api/node/pair")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
        let sent = try JSONDecoder().decode(JSONValue.self, from: #require(request.httpBody))
        #expect(sent["public_key"] == "ab")
        #expect(sent["publicKey"] == nil)
    }

    @Test func aByteCountStaysAWholeNumberOnTheWire() throws {
        let json = String(decoding: try JSONEncoder().encode(JSONValue.integer(64_000_000_000)), as: UTF8.self)
        #expect(json == "64000000000")
    }

    @Test func errorsAreReadFromTheEnvelope() {
        func body(_ code: String) -> Data { Data(#"{"error":{"code":"\#(code)","message":"why"}}"#.utf8) }
        #expect(API.error(status: 401, data: body("unauthorized")) == .unauthorized)
        #expect(API.error(status: 409, data: body("refused")) == .refused("why"))
        #expect(API.error(status: 503, data: body("unavailable")) == .unavailable("why"))
        #expect(API.error(status: 500, data: body("internal")) == .server("why"))
        #expect(API.error(status: 502, data: Data("<html>".utf8)) == .server("The box answered 502."))
        #expect(API.error(status: 401, data: Data()) == .unauthorized)
    }

    @Test func aPairingRefusalIsItsSentence() {
        #expect(throws: BoxError.refused("this code expired; add the device again")) {
            try API.paired(status: 400, data: Data(#"{"error":"this code expired; add the device again"}"#.utf8))
        }
    }

    @Test func aWrongShapeNamesTheField() {
        #expect(throws: BoxError.server("The box's answer was not what this app expects: missing .machines")) {
            try API.decode(Machines.self, status: 200, data: Data("{}".utf8))
        }
    }
}
