import DaedalusShared
import Foundation
import WatchConnectivity

/// The iPhone's end of the channel to its watch: it keeps the watch's latest reading (to report to the
/// box as an accessory of this node) and hands the watch the box's glance.
///
/// WatchConnectivity calls its delegate on a background queue. With this package's default main-actor
/// isolation a delegate would be main-actor code and trap there, so this type is nonisolated and keeps
/// its one piece of state in UserDefaults, which any thread may use.
nonisolated final class WatchBridge: NSObject, WCSessionDelegate, @unchecked Sendable {
    static let shared = WatchBridge()

    private static let stored = "watch.facts"

    /// Start listening. Safe to call more than once; does nothing on a device that pairs no watch (an iPad).
    func start() {
        guard WCSession.isSupported(), WCSession.default.delegate == nil else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    /// The watch's last reading, if a watch with the app is paired and it has reported.
    var facts: WatchFacts? {
        guard WCSession.isSupported(), WCSession.default.isPaired,
              let data = UserDefaults.standard.data(forKey: Self.stored)
        else { return nil }
        return try? JSONDecoder().decode(WatchFacts.self, from: data)
    }

    /// Hand the watch the box as it stands. The latest replaces the last; it arrives when the watch app
    /// next runs.
    func send(_ glance: BoxGlance) {
        guard WCSession.isSupported(), WCSession.default.activationState == .activated,
              WCSession.default.isWatchAppInstalled, let data = WatchLink.encode(glance)
        else { return }
        try? WCSession.default.updateApplicationContext([WatchLink.glanceKey: data])
    }

    private func keep(_ context: [String: Any]) {
        guard let data = context[WatchLink.factsKey] as? Data,
              (try? JSONDecoder().decode(WatchFacts.self, from: data)) != nil
        else { return }
        UserDefaults.standard.set(data, forKey: Self.stored)
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
                 error: Error?) {
        if activationState == .activated { keep(session.receivedApplicationContext) }
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        keep(applicationContext)
    }

    func sessionDidBecomeInactive(_ session: WCSession) {}

    /// The user switched watches: listen to the new one.
    func sessionDidDeactivate(_ session: WCSession) {
        UserDefaults.standard.removeObject(forKey: Self.stored)
        session.activate()
    }
}
