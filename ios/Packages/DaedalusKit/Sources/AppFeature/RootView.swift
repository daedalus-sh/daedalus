import DaedalusFeature
import SwiftUI

/// The app's root: Daedalus, directly.
public struct RootView: View {
    public init() {}

    public var body: some View {
        DaedalusApp.rootView
    }
}

/// What the app target wires into its `App`: the start, and the background refresh iOS grants.
public enum AppLifecycle {
    /// The refresh's identifier, for `.backgroundTask(.appRefresh(…))`.
    public static var refreshTask: String { DaedalusApp.refreshTask }

    public static func launch() {
        DaedalusApp.launch()
    }

    public static func refresh() async {
        await DaedalusApp.refresh()
    }
}
