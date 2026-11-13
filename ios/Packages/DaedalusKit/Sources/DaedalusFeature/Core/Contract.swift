import Foundation

// The box's answers, as ios/docs/api.md spells them. Field names are the wire's; a field the app does
// not read is left out (the contract says to ignore unknown ones).

/// A part of a composite answer: its value, or why its source did not respond.
nonisolated enum Partial<Value: Decodable & Sendable>: Decodable, Sendable {
    case value(Value)
    case unavailable(String)

    private enum Keys: String, CodingKey { case unavailable }

    init(from decoder: Decoder) throws {
        if let keyed = try? decoder.container(keyedBy: Keys.self),
           let why = try? keyed.decode(String.self, forKey: .unavailable)
        {
            self = .unavailable(why)
        } else {
            self = .value(try Value(from: decoder))
        }
    }

    var value: Value? {
        if case .value(let value) = self { return value }
        return nil
    }

    var unavailable: String? {
        if case .unavailable(let why) = self { return why }
        return nil
    }
}

/// Text the box did not write (log lines, release notes): shown as text, never interpreted.
nonisolated struct Untrusted<Content: Decodable & Sendable>: Decodable, Sendable {
    var notice: String
    var content: Content
}

nonisolated struct Me: Decodable, Sendable {
    var node: Node
    var box: BoxInfo

    struct Node: Decodable, Sendable {
        var id: String
        var name: String
        var os: String
    }

    struct BoxInfo: Decodable, Sendable {
        var hostname: String
        var engineRev: String?
    }
}

// MARK: Overview

nonisolated struct Overview: Decodable, Sendable {
    var at: String
    var hours: Int
    var head: Partial<Head>
    var host: Partial<OverviewHost>
    var memory: Partial<OverviewMemory>
    var health: Partial<Health>
    var alerts: Partial<AlertCounts>
    var storage: Partial<StorageHealth>
    var jobs: Partial<Jobs>
    var errors: Partial<ErrorCounts>
    var updates: Partial<UpdateCounts>
    var apply: Partial<ApplySummary>

    struct Head: Decodable, Sendable {
        var hostname: String
        var os: String
        var kernel: String?
        var arch: String
        var model: String?
    }

    struct Health: Decodable, Sendable {
        var probes: Int
        var failing: [String]
    }

    struct AlertCounts: Decodable, Sendable {
        var firing: Int?
        var pending: Int?
        var active: [ActiveAlert]
    }

    struct Jobs: Decodable, Sendable {
        var watched: Int
        var trouble: [Job]

        struct Job: Decodable, Sendable, Identifiable {
            var unit: String
            var result: String?
            var status: String?
            var id: String { unit }
        }
    }

    struct ErrorCounts: Decodable, Sendable {
        var containers: [ContainerCount]
        var more: Int
    }

    struct UpdateCounts: Decodable, Sendable {
        var behind: Int
        var engine: String
        var claudeCodeBehind: Int?
        var queued: Int
        var running: Bool
    }

    struct ApplySummary: Decodable, Sendable {
        var pending: Int
        var changed: [Changed]
        var state: String
        var phase: String
        var rebootPending: Bool
    }
}

nonisolated struct ContainerCount: Decodable, Sendable, Identifiable {
    var container: String
    var count: Int
    var id: String { container }
}

nonisolated struct Changed: Decodable, Sendable, Identifiable {
    var name: String
    var fields: [String]
    var id: String { name }
}

nonisolated struct OverviewHost: Decodable, Sendable {
    var cpuPct: Double?
    var cpuSpark: [Double]
    var cores: Int?
    var load: Load
    var uptimeSeconds: Double?
    var temps: [Temp]
    var pressure: Pressure
    var containers: Containers
    var failedUnits: [FailedUnit]

    struct Load: Decodable, Sendable {
        var m1: Double?
        var m5: Double?
        var m15: Double?
    }

    struct Temp: Decodable, Sendable, Identifiable {
        var label: String
        var value: Double
        var id: String { label }
    }

    struct Pressure: Decodable, Sendable {
        var cpu: Double?
        var io: Double?
        var memory: Double?
    }

    struct Containers: Decodable, Sendable {
        var total: Int?
        var down: [String]
    }

    struct FailedUnit: Decodable, Sendable, Identifiable {
        var unit: String
        var description: String?
        var subState: String?
        var id: String { unit }
    }
}

nonisolated struct OverviewMemory: Decodable, Sendable {
    var totalBytes: Double?
    var usedBytes: Double?
    var availableBytes: Double?
    var arcBytes: Double?
    var swapUsedBytes: Double?
    var swapTotalBytes: Double?
    var oomKills: Int?
}

nonisolated struct StorageHealth: Decodable, Sendable {
    var pools: [Pool]
    var snapshots: Snapshots
    var disks: [Disk]
    var smartdActive: Bool?

    struct Pool: Decodable, Sendable, Identifiable {
        var name: String
        var health: String
        var capacityPct: Double
        var freeBytes: Double
        var scrub: Scrub?
        var id: String { name }

        struct Scrub: Decodable, Sendable {
            var state: String?
            var endedAt: Double?
            var errors: Double?
        }
    }

    struct Snapshots: Decodable, Sendable {
        var count: Int
        var bytes: Double
    }

    struct Disk: Decodable, Sendable, Identifiable {
        var device: String
        var model: String?
        var passed: Bool?
        var temperature: Double?
        var id: String { device }
    }
}

nonisolated struct ActiveAlert: Decodable, Sendable, Identifiable {
    var name: String
    var folder: String
    var severity: String
    var summary: String
    var id: String { folder + "/" + name }
}

nonisolated struct ErrorsDetail: Decodable, Sendable {
    var hours: Int
    var containers: [ContainerCount]
    var moreContainers: Int
    var top: [Top]

    struct Top: Decodable, Sendable, Identifiable {
        var container: String
        var count: Int
        var lines: [String]
        var id: String { container }
    }
}

nonisolated struct LogLine: Decodable, Sendable, Hashable {
    var at: String
    var line: String
}

// MARK: Updates

nonisolated struct Updates: Decodable, Sendable {
    var checkedAt: String?
    var probeMissing: Bool
    var behind: Int
    var images: [PendingImage]
    var engine: Engine
    var claudeCode: Gap?
    var queue: [QueueItem]
    var status: UpdatesStatus

    struct Engine: Decodable, Sendable {
        var verdict: String
        var pinned: String?
        var behindOrigin: Int?
        var override: Bool
    }
}

nonisolated struct Gap: Decodable, Sendable {
    var installed: String?
    var latest: String?
    var behind: Int
}

nonisolated struct PendingImage: Decodable, Sendable, Identifiable, Hashable {
    var container: String
    var running: String?
    var tag: String?
    var target: String?
    var verdict: String
    var newer: [String]
    var updatable: Bool
    var ceremony: String?
    var majorCeremony: String?
    var movesWith: [String]
    var hasChangelog: Bool
    var id: String { container }

    /// The ceremony text a move to `toTag` needs typed back, if any (api.md, "The confirmation").
    func ceremony(movingTo toTag: String?) -> String? {
        if let ceremony { return ceremony }
        guard let majorCeremony, let toTag, let tag,
              Self.leadingNumber(toTag) != Self.leadingNumber(tag)
        else { return nil }
        return majorCeremony
    }

    static func leadingNumber(_ tag: String) -> String {
        String(tag.drop(while: { !$0.isNumber }).prefix(while: \.isNumber))
    }
}

nonisolated struct QueueItem: Decodable, Sendable, Identifiable, Hashable {
    var container: String
    var toTag: String?
    var tag: String
    var ceremony: String?
    var id: String { container }
}

nonisolated struct QueueAnswer: Decodable, Sendable {
    var queue: [QueueItem]
}

nonisolated struct UpdatesStatus: Decodable, Sendable {
    var images: RunStatus
    var engine: RunStatus
    var claudeCode: RunStatus

    var running: Bool { images.isRunning || engine.isRunning || claudeCode.isRunning }
}

/// A run on the box: an image update, the engine's, Claude Code's, an Apply.
nonisolated struct RunStatus: Decodable, Sendable {
    var id: String?
    var state: String
    var phase: String
    var error: String
    var startedAt: String?
    var finishedAt: String?
    var commit: String?
    /// An image update's pins.
    var targets: [String]?
    /// An Apply that ended needing a reboot.
    var rebootPending: Bool?

    var isRunning: Bool { state == "running" }
    var failed: Bool { state == "failed" }
}

nonisolated struct Started: Decodable, Sendable {
    var id: String
}

nonisolated struct Changelog: Decodable, Sendable {
    var container: String
    var repo: String?
    var installed: String?
    var latest: String?
    var releases: [Release]?
    var commits: [Commit]?
    var note: String?

    struct Release: Decodable, Sendable, Identifiable {
        var version: String
        var date: String
        var url: String
        var sections: [Part]
        var truncated: Bool
        var id: String { version }

        struct Part: Decodable, Sendable, Identifiable {
            var name: String
            var items: [String]
            var id: String { name }
        }
    }

    struct Commit: Decodable, Sendable, Identifiable {
        var sha: String
        var date: String
        var subject: String
        var id: String { sha }
    }
}

nonisolated struct PendingApply: Decodable, Sendable {
    var changed: [Changed]
    var status: RunStatus
}

// MARK: Machines

nonisolated struct Machines: Decodable, Sendable {
    var machines: [MachineItem]
}

nonisolated struct MachineItem: Decodable, Sendable, Identifiable, Hashable {
    var id: String
    var kind: String
    var name: String
    var os: String
    var arch: String
    var agentVersion: String?
    var state: String
    var connected: Bool?
    var lastSeenAgo: Double
    var light: Bool
    var isSelf: Bool
    var model: String?
    var updateAvailable: String?
    var restartPending: Bool
    var claude: ClaudeSummary?
    var battery: Battery?

    var isBox: Bool { kind == "box" }

    enum CodingKeys: String, CodingKey {
        case id, kind, name, os, arch, agentVersion, state, connected, lastSeenAgo, light, model
        case updateAvailable, restartPending, claude, battery
        case isSelf = "self"
    }

    struct Battery: Decodable, Sendable, Hashable {
        var percent: Double?
        var charging: Bool?
    }
}

nonisolated struct ClaudeSummary: Decodable, Sendable, Hashable {
    var state: String
    var detail: String?
    var cliVersion: String?
    var sessions: Int
    var signedIn: Bool
}

/// `GET /machines/:id`: the box's own parts, or a node's, in one shape (each side's fields are optional).
nonisolated struct MachineDetail: Decodable, Sendable {
    var machine: MachineItem
    var kind: String
    var host: Partial<OverviewHost>?
    var memory: Partial<OverviewMemory>?
    var storage: Partial<StorageHealth>?
    var system: MachineSystem?
    var cpuSpark: [Double]?
    var device: DeviceView?
    var osReleases: AppleOsReleases?
    var note: String?
}

nonisolated struct MachineSystem: Decodable, Sendable {
    var sampledAt: String
    var osName: String
    var osVersion: String
    var kernel: String?
    var cpu: String
    var cpuPct: Double?
    var uptimeSeconds: Double?
    var model: String?
    var memory: Memory
    var disks: [Disk]
    var battery: Battery?
    var temperatures: [Temperature]
    var osUpdatesPending: Int?
    var osRebootPending: Bool?

    struct Memory: Decodable, Sendable {
        var totalBytes: Double?
        var usedBytes: Double?
        var availableBytes: Double?
    }

    struct Disk: Decodable, Sendable, Identifiable {
        var mount: String
        var name: String?
        var totalBytes: Double?
        var usedBytes: Double?
        var freeBytes: Double?
        var id: String { mount }
    }

    struct Battery: Decodable, Sendable {
        var percent: Double?
        var charging: Bool?
        var healthPct: Double?
        var cycles: Double?
    }

    struct Temperature: Decodable, Sendable, Identifiable {
        var label: String
        var celsius: Double
        var id: String { label }
    }
}

nonisolated struct DeviceView: Decodable, Sendable {
    var model: String?
    var osVersion: String?
    var appVersion: String?
    var battery: MachineItem.Battery?
    var storage: Storage?
    var memoryBytes: Double?
    var at: String
    /// What the device reports beside itself: its watch. Absent from a box older than the addition.
    var accessories: [Accessory]?

    struct Storage: Decodable, Sendable {
        var totalBytes: Double?
        var freeBytes: Double?
    }

    struct Accessory: Decodable, Sendable, Identifiable {
        var kind: String
        var name: String?
        var model: String?
        var osVersion: String?
        var battery: MachineItem.Battery?
        var storage: Storage?
        var at: String?
        var osReleases: AppleOsReleases?
        var id: String { kind + (name ?? "") + (model ?? "") }
    }
}

nonisolated struct AppleOsReleases: Decodable, Sendable {
    var os: String
    var current: Current
    var latest: String?
    var behind: Int
    var releases: [Release]
    var error: String?

    struct Current: Decodable, Sendable {
        var version: String
        var build: String?
    }

    struct Release: Decodable, Sendable, Identifiable {
        var version: String
        var build: String?
        var date: String?
        var notesUrl: String?
        var securityUrl: String?
        var summary: String?
        var id: String { version + (build ?? "") }
    }
}

nonisolated struct CommandSent: Decodable, Sendable {
    var delivered: Bool
    var queued: Bool
}

// MARK: Claude

nonisolated struct ClaudeFleet: Decodable, Sendable {
    var machines: [ClaudeMachine]
}

nonisolated struct ClaudeMachine: Decodable, Sendable, Identifiable {
    var id: String
    var name: String
    var server: Server
    var update: Gap?
    var sessions: [Session]
    var agents: [Agent]
    var transcripts: [Transcript]
    var actions: [Action]
    var note: String?

    struct Server: Decodable, Sendable {
        var state: String
        var detail: String?
        var version: String?
        var cliVersion: String?
        var restarts: Int?
        var startedAt: String?
        var signedIn: Bool
    }

    struct Session: Decodable, Sendable, Identifiable {
        var sessionID: String?
        var remoteId: String?
        var name: String?
        var cwd: String?
        var kind: String?
        var status: String?
        var startedAt: Double?
        var lastActivityAt: Double?
        var alive: Bool

        enum CodingKeys: String, CodingKey {
            case sessionID = "id"
            case remoteId, name, cwd, kind, status, startedAt, lastActivityAt, alive
        }

        var id: String { sessionID ?? remoteId ?? "\(startedAt ?? 0)" }
    }

    struct Agent: Decodable, Sendable, Identifiable {
        var id: String
        var state: String?
        var name: String?
        var cwd: String?
        var startedAt: Double?
    }

    struct Transcript: Decodable, Sendable, Identifiable {
        var id: String
        var title: String?
        var project: String
        var cwd: String
        var modifiedAt: Double
    }

    struct Action: Decodable, Sendable, Identifiable {
        var request: String
        var action: String
        var session: String
        var state: String
        var detail: String
        var id: String { request }
    }
}

nonisolated struct ClaudeRestarted: Decodable, Sendable {
    var queued: Bool
    var delivered: Bool
}

nonisolated struct ClaudeSessionSent: Decodable, Sendable {
    var request: String
}

nonisolated struct ClaudeAction: Decodable, Sendable {
    var outcome: Outcome?

    struct Outcome: Decodable, Sendable {
        var state: String
        var detail: String
    }
}

/// An answer the app does not read.
nonisolated struct Ignored: Decodable, Sendable {}
