@testable import DaedalusFeature
import Foundation
import Testing

struct CoreContractTests {
    /// The example in ios/docs/api.md, with one part unavailable.
    static let overview = #"""
    {"at":"2026-11-12T19:04:11.512Z","hours":24,
     "head":{"hostname":"s2-server","os":"NixOS 26.05 (Yarara)","kernel":"6.18.60","arch":"x86_64","model":"MSI PRO Z790-P"},
     "host":{"cpuPct":6.4,"cpuSpark":[5.1,7.9,6.2],"cores":20,"load":{"m1":1.2,"m5":1.4,"m15":1.3},"uptimeSeconds":412334,
       "temps":[{"label":"coretemp temp1","value":47}],"pressure":{"cpu":0.1,"io":0,"memory":0},
       "containers":{"total":96,"down":[]},"failedUnits":[]},
     "memory":{"totalBytes":67282206720,"usedBytes":41200000000,"availableBytes":26082206720,"arcBytes":17179869184,"swapUsedBytes":0,"swapTotalBytes":33641103360,"oomKills":0},
     "health":{"probes":61,"failing":[]},
     "alerts":{"unavailable":"Grafana did not answer"},
     "storage":{"pools":[{"name":"rpool","health":"ONLINE","capacityPct":41,"freeBytes":1100000000000,"scrub":{"state":"finished","startedAt":1794000000,"endedAt":1794003600,"examined":800000000000,"errors":0}}],
       "snapshots":{"count":812,"bytes":52000000000},
       "disks":[{"device":"nvme0n1","model":"Samsung SSD 990 PRO 2TB","passed":true,"temperature":41}],"smartdActive":true},
     "jobs":{"watched":34,"trouble":[]},
     "errors":{"containers":[{"container":"sonarr","count":14}],"more":0},
     "updates":{"behind":3,"engine":"current","claudeCodeBehind":0,"queued":0,"running":false},
     "apply":{"pending":0,"changed":[],"state":"idle","phase":"","rebootPending":false}}
    """#

    @Test func theOverviewDecodesWithAPartMissing() throws {
        let overview = try JSONDecoder().decode(Overview.self, from: Data(Self.overview.utf8))
        #expect(overview.head.value?.hostname == "s2-server")
        #expect(overview.host.value?.cpuSpark.count == 3)
        #expect(overview.alerts.value == nil)
        #expect(overview.alerts.unavailable == "Grafana did not answer")
        #expect(overview.storage.value?.pools.first?.scrub?.errors == 0)
        #expect(overview.updates.value?.behind == 3)
    }

    @Test func aMachineKeepsItsSelfFlag() throws {
        let json = #"""
        {"machines":[{"id":"box","kind":"box","name":"s2-server","os":"linux","arch":"x86_64","agentVersion":"0.30.0",
          "state":"approved","connected":true,"lastSeenAgo":0,"lastSeenAt":"2026-11-12T19:04:11Z","light":false,"self":false,
          "model":null,"updateAvailable":null,"restartPending":false,"claude":null,"battery":null},
         {"id":"07122fc9eb01b748","kind":"node","name":"Phone","os":"ios","arch":"arm64","agentVersion":"0.1.0",
          "state":"approved","connected":false,"lastSeenAgo":4000,"lastSeenAt":"2026-11-12T18:00:00Z","light":true,"self":true,
          "model":"iPhone17,1","updateAvailable":null,"restartPending":false,"claude":null,"battery":{"percent":81,"charging":false}}]}
        """#
        let machines = try JSONDecoder().decode(Machines.self, from: Data(json.utf8)).machines
        #expect(machines[0].isBox)
        #expect(!machines[0].isSelf)
        #expect(machines[1].isSelf)
        #expect(machines[1].battery?.percent == 81)
    }

    @Test func theChangelogDecodesBothOfItsShapes() throws {
        let bare = #"{"notice":"n","content":{"container":"x","repo":null,"note":"no source"}}"#
        #expect(try JSONDecoder().decode(Untrusted<Changelog>.self, from: Data(bare.utf8)).content.note == "no source")
        let full = #"""
        {"notice":"n","content":{"container":"x","repo":"o/r","installed":"1.0","latest":"1.1","note":null,"commits":[],
          "releases":[{"version":"1.1","date":"2026-11-01T00:00:00Z","url":"https://github.com/o/r/releases/1.1",
            "sections":[{"name":"Fixes","items":["one"]}],"truncated":false}]}}
        """#
        let log = try JSONDecoder().decode(Untrusted<Changelog>.self, from: Data(full.utf8)).content
        #expect(log.releases?.first?.sections.first?.items == ["one"])
    }

    @Test func aCeremonyIsAskedWhenThePinSaysSo() {
        func image(ceremony: String?, major: String?, tag: String) -> PendingImage {
            PendingImage(container: "pg", running: tag, tag: tag, target: nil, verdict: "newer-tag", newer: [],
                         updatable: true, ceremony: ceremony, majorCeremony: major, movesWith: [], hasChangelog: false)
        }
        #expect(image(ceremony: "restarts the database", major: nil, tag: "17.1").ceremony(movingTo: "17.2")
            == "restarts the database")
        #expect(image(ceremony: nil, major: "migrates the data", tag: "17.1").ceremony(movingTo: "17.2") == nil)
        #expect(image(ceremony: nil, major: "migrates the data", tag: "17.1").ceremony(movingTo: "18.0")
            == "migrates the data")
        #expect(image(ceremony: nil, major: "migrates the data", tag: "v17.1").ceremony(movingTo: "v18.0")
            == "migrates the data")
        #expect(image(ceremony: nil, major: nil, tag: "17.1").ceremony(movingTo: "18.0") == nil)
    }

    @Test func numbersReadWell() {
        #expect(Format.duration(seconds: 412_334) == "4d 18h")
        #expect(Format.duration(seconds: 59) == "59s")
        #expect(Format.ago(seconds: 2) == "now")
        #expect(Format.fraction(used: 5, total: 10) == 0.5)
        #expect(Format.fraction(used: 5, total: 0) == nil)
        #expect(Format.date("2026-11-12T19:04:11.512Z") != nil)
        #expect(Format.date("2026-11-12T19:04:11Z") != nil)
    }
}
