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
            "memory": ["total_bytes": .number(Double(memoryBytes))],
        ]
        if let osBuild { sample["os"] = ["build": .string(osBuild)] }
        if let total = storageTotalBytes, let free = storageFreeBytes {
            sample["disks"] = [[
                "mount": "/", "name": .string(name), "total_bytes": .number(Double(total)),
                "free_bytes": .number(Double(free)), "used_bytes": .number(Double(max(total - free, 0))),
            ]]
        }
        if let batteryPercent {
            var battery: [String: JSONValue] = ["percent": .number(batteryPercent), "low_power": .bool(lowPower)]
            if let charging { battery["charging"] = .bool(charging) }
            sample["battery"] = .object(battery)
        }
        return try? JSONEncoder().encode(JSONValue.object(sample))
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
