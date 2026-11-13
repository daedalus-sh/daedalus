import DaedalusShared
import Foundation
import UIKit

/// What this device says about itself as a node: who it is in its hello, and the sample it reports.
struct DeviceFacts {
    var name: String
    /// "ios" | "ipados"
    var os: String
    var osVersion: String
    var osBuild: String?
    var arch = "arm64"
    /// "iPhone17,1"
    var model: String
    var appVersion: String
    var appBuild: String
    var memoryBytes: UInt64
    var storageTotalBytes: Int64?
    var storageFreeBytes: Int64?
    /// 0 to 100; nil when the device does not say (a simulator).
    var batteryPercent: Double?
    var charging: Bool?
    var lowPower: Bool

    /// The app's version and build as one token, as the hello carries it: "0.1.0+42".
    var version: String { "\(appVersion)+\(appBuild)" }

    /// The sample the link reports (ios/core/include/daedalus_ios.h, `daedalus_report`): only what a
    /// phone can say. The name, OS version and app version ride the hello instead.
    func telemetry() -> Data? {
        var sample: [String: JSONValue] = [
            "sampled_at": .string(ISO8601DateFormatter().string(from: .now)),
            "machine": ["manufacturer": "Apple", "model": .string(model),
                        "form": .string(os == "ipados" ? "tablet" : "phone")],
            "memory": ["total_bytes": .integer(Int64(clamping: memoryBytes))],
        ]
        if let osBuild { sample["os"] = ["build": .string(osBuild)] }
        if let total = storageTotalBytes, let free = storageFreeBytes {
            sample["disks"] = [[
                "mount": "/", "name": .string(name), "total_bytes": .integer(total),
                "free_bytes": .integer(free), "used_bytes": .integer(max(total - free, 0)),
            ]]
        }
        if let batteryPercent {
            var battery: [String: JSONValue] = ["percent": .number(batteryPercent), "low_power": .bool(lowPower)]
            if let charging { battery["charging"] = .bool(charging) }
            sample["battery"] = .object(battery)
        }
        if let watch = WatchBridge.shared.facts { sample["accessories"] = [Self.accessory(watch)] }
        return try? JSONEncoder().encode(JSONValue.object(sample))
    }

    /// The paired watch, as its app last read it: an accessory of this node, not a node of its own.
    private static func accessory(_ watch: WatchFacts) -> JSONValue {
        var entry: [String: JSONValue] = [
            "kind": "watch", "name": .string(watch.name), "model": .string(watch.model),
            "os_name": "watchOS", "os_version": .string(watch.osVersion),
            "sampled_at": .string(ISO8601DateFormatter().string(from: watch.sampledAt)),
        ]
        if let build = watch.osBuild { entry["os_build"] = .string(build) }
        if let percent = watch.batteryPercent {
            var battery: [String: JSONValue] = ["percent": .number(percent), "low_power": .bool(watch.lowPower)]
            if let charging = watch.charging { battery["charging"] = .bool(charging) }
            entry["battery"] = .object(battery)
        }
        if let total = watch.storageTotalBytes { entry["storage_total_bytes"] = .integer(total) }
        if let free = watch.storageFreeBytes { entry["storage_free_bytes"] = .integer(free) }
        return .object(entry)
    }

    static func current() -> DeviceFacts {
        let device = UIDevice.current
        device.isBatteryMonitoringEnabled = true
        let info = Bundle.main.infoDictionary
        let home = URL(fileURLWithPath: NSHomeDirectory())
        let volume = try? home.resourceValues(forKeys: [
            .volumeTotalCapacityKey, .volumeAvailableCapacityForImportantUsageKey,
        ])
        let level = device.batteryLevel
        return DeviceFacts(
            name: device.name,
            os: device.userInterfaceIdiom == .pad ? "ipados" : "ios",
            osVersion: device.systemVersion,
            osBuild: sysctl("kern.osversion"),
            model: sysctl("hw.machine") ?? device.model,
            appVersion: info?["CFBundleShortVersionString"] as? String ?? "0",
            appBuild: info?["CFBundleVersion"] as? String ?? "0",
            memoryBytes: ProcessInfo.processInfo.physicalMemory,
            storageTotalBytes: volume?.volumeTotalCapacity.map { Int64($0) },
            storageFreeBytes: volume?.volumeAvailableCapacityForImportantUsage,
            batteryPercent: level < 0 ? nil : Double(level) * 100,
            charging: charging(device.batteryState),
            lowPower: ProcessInfo.processInfo.isLowPowerModeEnabled)
    }

    private static func charging(_ state: UIDevice.BatteryState) -> Bool? {
        switch state {
        case .charging, .full: return true
        case .unplugged: return false
        default: return nil
        }
    }

    private static func sysctl(_ name: String) -> String? {
        var size = 0
        guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return nil }
        var buffer = [CChar](repeating: 0, count: size)
        guard sysctlbyname(name, &buffer, &size, nil, 0) == 0 else { return nil }
        let value = String(cString: buffer)
        return value.isEmpty ? nil : value
    }
}
