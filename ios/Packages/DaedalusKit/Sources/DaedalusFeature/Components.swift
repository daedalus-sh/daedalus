import Charts
import SwiftUI

/// A feed's value, or what stands in for it: a spinner on first sight, the reason when nothing could be
/// read. With a value on screen, a failed refresh is one quiet line above it.
struct FeedView<Value: Sendable, Content: View>: View {
    let feed: Feed<Value>
    var unavailableTitle = "Nothing to show"
    @ViewBuilder let content: (Value) -> Content

    var body: some View {
        if let value = feed.value {
            if let error = feed.error {
                Label(error, systemImage: "wifi.exclamationmark")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .listRowBackground(Color.clear)
            }
            content(value)
        } else if let error = feed.error {
            ContentUnavailableView {
                Label(unavailableTitle, systemImage: "wifi.exclamationmark")
            } description: {
                Text(error)
            } actions: {
                Button("Try again") { Task { await feed.refresh() } }
            }
            .listRowBackground(Color.clear)
        } else {
            HStack {
                Spacer()
                ProgressView()
                Spacer()
            }
            .listRowBackground(Color.clear)
        }
    }
}

/// A level as a small coloured symbol.
struct LevelIcon: View {
    let level: Level

    var body: some View {
        Image(systemName: level.symbol)
            .foregroundStyle(level.color)
            .symbolRenderingMode(.hierarchical)
            .accessibilityHidden(true)
    }
}

/// A name, a value, and an optional level: the app's plain row.
struct FactRow: View {
    let title: String
    let value: String
    var level: Level?

    var body: some View {
        LabeledContent {
            HStack(spacing: 6) {
                Text(value).monospacedDigit()
                if let level, level != .ok, level != .idle { LevelIcon(level: level) }
            }
        } label: {
            Text(title)
        }
    }
}

/// A share of something finite: a label, how much, and a bar coloured by how full it is.
struct Meter: View {
    let title: String
    let fraction: Double?
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                Spacer()
                Text(detail).foregroundStyle(.secondary).monospacedDigit()
            }
            ProgressView(value: fraction ?? 0)
                .tint(Level.usage(fraction).color)
        }
        .accessibilityElement(children: .combine)
    }
}

/// A recent history as a small line: no axes, just the shape.
struct Sparkline: View {
    let values: [Double]
    var color: Color = DS.brand
    /// The top of the scale; nil scales to the data.
    var ceiling: Double?

    private struct Point: Identifiable {
        let id: Int
        let value: Double
    }

    private var points: [Point] {
        values.enumerated().map { Point(id: $0.offset, value: $0.element) }
    }

    var body: some View {
        Chart(points) { point in
            AreaMark(x: .value("t", point.id), y: .value("v", point.value))
                .foregroundStyle(color.opacity(0.15))
                .interpolationMethod(.monotone)
            LineMark(x: .value("t", point.id), y: .value("v", point.value))
                .foregroundStyle(color)
                .interpolationMethod(.monotone)
        }
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartYScale(domain: 0 ... max(ceiling ?? (values.max() ?? 1), 1))
        .accessibilityHidden(true)
    }
}

/// A big number over its label, for the top of a screen.
struct Stat: View {
    let title: String
    let value: String
    var level: Level = .idle

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value)
                .font(.title2.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(level == .idle || level == .ok ? Color.primary : level.color)
                .contentTransition(.numericText())
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// A button for something that changes the box: asks first, shows it is working, and says why it failed.
struct ActionButton: View {
    let title: String
    var systemImage: String?
    var role: ButtonRole?
    /// What the confirmation asks; nil runs at once.
    var confirm: String?
    let action: () async throws -> Void

    @State private var asking = false
    @State private var working = false
    @State private var failure: String?

    var body: some View {
        Button(role: role) {
            if confirm == nil { run() } else { asking = true }
        } label: {
            HStack {
                if let systemImage {
                    Label(title, systemImage: systemImage)
                } else {
                    Text(title)
                }
                if working {
                    Spacer()
                    ProgressView()
                }
            }
        }
        .disabled(working)
        .confirmationDialog(confirm ?? "", isPresented: $asking, titleVisibility: .visible) {
            Button(title, role: role) { run() }
        }
        .alert("That did not work", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(failure ?? "")
        }
        .sensoryFeedback(.success, trigger: working) { old, new in old && !new && failure == nil }
    }

    private func run() {
        working = true
        Task {
            defer { working = false }
            do {
                try await action()
            } catch is CancellationError {
            } catch {
                failure = error.localizedDescription
            }
        }
    }
}
