import Foundation
import Observation

/// One thing a screen shows, fetched from the box and kept fresh while the screen is up.
/// A refresh never blanks what is already shown: the old value stays until the new one replaces it.
@Observable
final class Feed<Value: Sendable> {
    private(set) var value: Value?
    private(set) var error: String?
    private(set) var isLoading = false
    private(set) var loadedAt: Date?

    @ObservationIgnored private let fetch: () async throws -> Value
    @ObservationIgnored private var running: Task<Void, Never>?

    init(_ fetch: @escaping () async throws -> Value) {
        self.fetch = fetch
    }

    /// Fetch once. Calls that arrive while one is in flight wait for it instead of starting another.
    func refresh() async {
        if let running {
            await running.value
            return
        }
        let task = Task {
            isLoading = true
            defer { isLoading = false }
            do {
                value = try await fetch()
                error = nil
                loadedAt = .now
            } catch is CancellationError {
            } catch {
                self.error = error.localizedDescription
            }
        }
        running = task
        await task.value
        running = nil
    }

    /// Refresh now and then every `seconds`, until the surrounding task is cancelled (the view went away).
    func poll(every seconds: Double) async {
        while !Task.isCancelled {
            await refresh()
            try? await Task.sleep(for: .seconds(seconds))
        }
    }
}
