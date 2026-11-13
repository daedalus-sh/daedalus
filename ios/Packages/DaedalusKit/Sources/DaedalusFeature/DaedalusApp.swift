import BackgroundTasks
import SwiftUI

/// The app's one product. The app target embeds `DaedalusApp.rootView`, calls `launch()` when it starts
/// and forwards its background refresh to `refresh()`.
public enum DaedalusApp {
    public static var rootView: some View { AppRoot() }

    /// The background refresh's identifier. Config/Info.plist permits it by the same spelling.
    public static var refreshTask: String { (Bundle.main.bundleIdentifier ?? "") + ".report" }

    /// Every start of the app, in the foreground or not: listen to the watch, which may be why iOS
    /// started it.
    public static func launch() {
        WatchBridge.shared.start()
    }

    /// iOS woke the app for a refresh: ask for the next one, and report this device (and its watch).
    public static func refresh() async {
        scheduleRefresh()
        await Box.shared.reportInBackground()
    }

    /// Ask iOS for a refresh, no sooner than a quarter of an hour from now. When it comes is iOS's
    /// call: a few times a day for an app opened now and then, never once the app is swiped away.
    static func scheduleRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: refreshTask)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }
}

/// Unpaired, the app is one screen: scan the code. Paired, it is the box.
struct AppRoot: View {
    @State private var box = Box.shared
    @State private var offered: PairLink?
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if box.removed {
                ContentUnavailableView {
                    Label("Removed from the box", systemImage: "iphone.slash")
                } description: {
                    Text("This device was revoked or forgotten in Settings › Machines. Pair it again with a new code.")
                } actions: {
                    Button("Pair again") { Task { await box.unpair() } }
                        .buttonStyle(.borderedProminent)
                }
            } else if box.isPaired {
                MainView()
                    // The node reports itself while the app is open: now, then every minute. Closed, it
                    // reports when iOS grants a refresh (`DaedalusApp.refresh`) or the watch asks.
                    .task(id: box.epoch) {
                        while !Task.isCancelled {
                            await box.reportDevice()
                            try? await Task.sleep(for: .seconds(60))
                        }
                    }
            } else {
                PairView()
            }
        }
        .tint(DS.brand)
        .animation(.default, value: box.isPaired)
        .onOpenURL { url in
            guard let link = PairLink(url: url) else { return }
            if box.isPaired {
                offered = link
            } else {
                Task { await box.pair(link) }
            }
        }
        .confirmationDialog("Pair with \(offered?.box ?? "this box") instead?",
                            isPresented: Binding(get: { offered != nil }, set: { if !$0 { offered = nil } }),
                            titleVisibility: .visible) {
            Button("Pair with \(offered?.box ?? "it")") {
                guard let link = offered else { return }
                Task {
                    await box.unpair()
                    await box.pair(link)
                }
            }
        } message: {
            Text("This device forgets \(box.pairing?.boxName ?? "its box"). Remove it there in Settings › Machines.")
        }
        // From the first value on: an app iOS started in the background may meet its scene late.
        .onChange(of: scenePhase, initial: true) { _, phase in
            switch phase {
            case .background:
                DaedalusApp.scheduleRefresh()
                Task { await box.suspend() }
            case .active: box.resume()
            default: break
            }
        }
    }
}

/// The paired app: a tab bar on an iPhone, a sidebar on an iPad.
struct MainView: View {
    var body: some View {
        TabView {
            Tab("Overview", systemImage: "gauge.with.dots.needle.67percent") {
                OverviewView()
            }
            Tab("Updates", systemImage: "arrow.down.circle") {
                UpdatesView()
            }
            Tab("Machines", systemImage: "desktopcomputer") {
                MachinesView()
            }
            Tab("Claude", systemImage: "sparkles") {
                ClaudeView()
            }
            Tab("Settings", systemImage: "gearshape") {
                SettingsView()
            }
        }
        .tabViewStyle(.sidebarAdaptable)
    }
}
