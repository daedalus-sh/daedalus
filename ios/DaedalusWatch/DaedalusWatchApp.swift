import SwiftUI
import WatchFeature

@main
struct DaedalusWatchApp: App {
    var body: some Scene {
        WindowGroup {
            WatchApp.rootView
        }
        // A few times a day, without being opened: hand the iPhone a fresh reading of this watch.
        .backgroundTask(.appRefresh(WatchApp.refreshTask)) {
            await WatchApp.refresh()
        }
    }
}
