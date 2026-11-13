import SwiftUI

/// The app's one product. The app target embeds `DaedalusApp.rootView`.
public enum DaedalusApp {
    public static var rootView: some View { AppRoot() }
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
                    // The node reports itself while the app is open: now, then every minute.
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
        .task { WatchBridge.shared.start() }
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
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background: Task { await box.suspend() }
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
