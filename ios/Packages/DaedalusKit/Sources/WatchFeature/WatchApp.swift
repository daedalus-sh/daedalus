// The watch app. Everything here is watchOS-only; on iOS (where the package's tests build every target)
// this module is empty.
#if os(watchOS)
import DaedalusShared
import SwiftUI
import WatchKit

/// The watch app's one product. The app target embeds `WatchApp.rootView` and forwards its refresh.
public enum WatchApp {
    public static var rootView: some View { GlanceView() }

    /// The background refresh's name (the app target's `.backgroundTask(.appRefresh(…))`).
    public static let refreshTask = "report"

    /// Read this watch, hand the reading to the iPhone, and ask to be woken again later.
    public static func refresh() async {
        WatchSession.shared.report()
        scheduleRefresh()
    }

    static func scheduleRefresh() {
        WKApplication.shared().scheduleBackgroundRefresh(
            withPreferredDate: Date(timeIntervalSinceNow: 4 * 3600), userInfo: refreshTask as NSString
        ) { _ in }
    }
}

/// The box as the iPhone last saw it, and this watch as the box will see it.
struct GlanceView: View {
    @State private var session = WatchSession.shared

    var body: some View {
        List {
            if let glance = session.glance {
                Section {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: glance.troubles.isEmpty ? "checkmark.circle.fill" : "xmark.octagon.fill")
                            .foregroundStyle(glance.troubles.isEmpty ? .green : .red)
                            .font(.title3)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(glance.troubles.isEmpty ? "Everything is fine"
                                : glance.troubles.count == 1 ? "One thing needs a look"
                                : "\(glance.troubles.count) things need a look")
                                .font(.headline)
                            ForEach(glance.troubles, id: \.self) { trouble in
                                Text(trouble).font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                    }
                } header: {
                    Text(glance.box)
                } footer: {
                    Text("As the iPhone saw it \(glance.at, format: .relative(presentation: .named)).")
                }
            } else {
                Section {
                    Text("Open Daedalus on the iPhone once, and the box shows here.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            Section("This watch") {
                let facts = WatchReading.now()
                if let percent = facts.batteryPercent {
                    LabeledContent("Battery", value: "\(Int(percent.rounded()))%")
                }
                LabeledContent("watchOS", value: facts.osVersion)
                LabeledContent("Reported", value: session.lastReport.map {
                    $0.formatted(.relative(presentation: .named))
                } ?? "Not yet")
            }
        }
        .task {
            session.report()
            WatchApp.scheduleRefresh()
        }
    }
}

/// This watch, read now.
enum WatchReading {
    static func now() -> WatchFacts {
        let device = WKInterfaceDevice.current()
        device.isBatteryMonitoringEnabled = true
        let level = device.batteryLevel
        let volume = try? FileManager.default.attributesOfFileSystem(forPath: NSHomeDirectory())
        return WatchFacts(
            name: device.name,
            model: sysctl("hw.machine") ?? device.model,
            osVersion: device.systemVersion,
            osBuild: sysctl("kern.osversion"),
            batteryPercent: level < 0 ? nil : Double(level) * 100,
            charging: charging(device.batteryState),
            lowPower: ProcessInfo.processInfo.isLowPowerModeEnabled,
            storageTotalBytes: (volume?[.systemSize] as? NSNumber)?.int64Value,
            storageFreeBytes: (volume?[.systemFreeSize] as? NSNumber)?.int64Value,
            sampledAt: .now)
    }

    private static func charging(_ state: WKInterfaceDeviceBatteryState) -> Bool? {
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
#endif
