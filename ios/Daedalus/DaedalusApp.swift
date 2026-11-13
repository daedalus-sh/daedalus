import AppFeature
import SwiftUI

@main
struct DaedalusApp: App {
    init() {
        AppLifecycle.launch()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
        }
        // A few times a day, when iOS grants it, without being opened: report this device to the box.
        .backgroundTask(.appRefresh(AppLifecycle.refreshTask)) {
            await AppLifecycle.refresh()
        }
    }
}
