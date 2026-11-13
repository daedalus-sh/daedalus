#if os(watchOS)
import DaedalusShared
import Foundation
import Observation
import WatchConnectivity

/// The watch's end of the channel to its iPhone: it sends its reading and keeps the box's glance.
@Observable
final class WatchSession {
    static let shared = WatchSession()

    private(set) var glance: BoxGlance?
    private(set) var lastReport: Date?
    @ObservationIgnored private let receiver = Receiver()

    private init() {
        guard WCSession.isSupported() else { return }
        glance = WatchLink.decode(BoxGlance.self, from: WCSession.default.receivedApplicationContext,
                                  key: WatchLink.glanceKey)
        receiver.onGlance = { [weak self] glance in
            Task { @MainActor in self?.glance = glance }
        }
        WCSession.default.delegate = receiver
        WCSession.default.activate()
    }

    /// Hand the iPhone a fresh reading. The context is kept until the iPhone app next runs, and a newer
    /// one replaces it, so this is cheap to call often.
    func report() {
        guard WCSession.isSupported(), WCSession.default.activationState == .activated,
              let data = WatchLink.encode(WatchReading.now())
        else { return }
        do {
            try WCSession.default.updateApplicationContext([WatchLink.factsKey: data])
            lastReport = .now
        } catch {}
    }

    func activated() {
        report()
    }
}

/// WatchConnectivity calls its delegate on a background queue. With this package's default main-actor
/// isolation a delegate would be main-actor code and trap there, so the receiver is nonisolated and
/// hands plain values over.
private nonisolated final class Receiver: NSObject, WCSessionDelegate, @unchecked Sendable {
    var onGlance: (@Sendable (BoxGlance) -> Void)?

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
                 error: Error?) {
        guard activationState == .activated else { return }
        Task { @MainActor in WatchSession.shared.activated() }
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        guard let glance = WatchLink.decode(BoxGlance.self, from: applicationContext, key: WatchLink.glanceKey)
        else { return }
        onGlance?(glance)
    }
}
#endif
