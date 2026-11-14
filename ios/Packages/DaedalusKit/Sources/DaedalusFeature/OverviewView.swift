import DaedalusShared
import SwiftUI

/// The box at a glance: is anything wrong, and how hard is it working.
struct OverviewView: View {
    @State private var box = Box.shared
    @State private var feed = Feed<Overview> { try await Box.shared.call(API.overview) }

    private let columns = [GridItem(.adaptive(minimum: 320), spacing: DS.gap, alignment: .top)]

    var body: some View {
        NavigationStack {
            ScrollView {
                if let overview = feed.value {
                    VStack(spacing: DS.gap) {
                        if let error = feed.error {
                            Label(error, systemImage: "wifi.exclamationmark")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        VerdictCard(overview: overview)
                        LazyVGrid(columns: columns, spacing: DS.gap) {
                            section("Processor", "cpu", overview.host) { HostCard(host: $0) }
                            section("Memory", "memorychip", overview.memory) { MemoryCard(memory: $0) }
                            section("Alerts", "bell", overview.alerts) { AlertsCard(alerts: $0) }
                            section("Services", "square.stack.3d.up", overview.host) {
                                ServicesCard(host: $0, health: overview.health.value, jobs: overview.jobs.value)
                            }
                            section("Storage", "internaldrive", overview.storage) { StorageCard(storage: $0) }
                            section("Errors", "exclamationmark.bubble", overview.errors) {
                                ErrorsCard(errors: $0, hours: overview.hours)
                            }
                            section("Updates", "arrow.down.circle", overview.updates) {
                                UpdatesCard(updates: $0, apply: overview.apply.value)
                            }
                        }
                    }
                    .padding()
                } else if let error = feed.error {
                    ContentUnavailableView {
                        Label("The box did not answer", systemImage: "wifi.exclamationmark")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("Try again") { Task { await feed.refresh() } }
                    }
                    .padding(.top, 80)
                } else {
                    // Full width: a scroll view is only as wide as what it holds, and its
                    // grey background would otherwise be a band behind the spinner.
                    ProgressView().padding(.top, 120).frame(maxWidth: .infinity)
                }
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle(box.pairing?.boxName ?? "Overview")
            .refreshable { await feed.refresh() }
            .task(id: box.epoch) { await feed.poll(every: 15) }
            // The watch shows the box as this screen last read it.
            .onChange(of: feed.loadedAt) {
                guard let overview = feed.value, let name = box.pairing?.boxName else { return }
                WatchBridge.shared.send(BoxGlance(box: name, troubles: overview.troubles, at: .now))
            }
        }
    }

    /// A card for one part of the answer, or the reason that part is missing.
    @ViewBuilder
    private func section<Value: Decodable & Sendable, Content: View>(_ title: String, _ symbol: String, _ part: Partial<Value>,
                                               @ViewBuilder content: (Value) -> Content) -> some View {
        Card(title: title, systemImage: symbol) {
            switch part {
            case .value(let value): content(value)
            case .unavailable(let why): Text(why).font(.callout).foregroundStyle(.secondary)
            }
        }
    }
}

/// A titled surface: the unit the overview is made of.
struct Card<Content: View>: View {
    let title: String
    let systemImage: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(title, systemImage: systemImage)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            content
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: .secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: DS.radius, style: .continuous))
    }
}

/// The one-line answer at the top: fine, or what is not.
private struct VerdictCard: View {
    let overview: Overview

    var body: some View {
        let troubles = overview.troubles
        let level: Level = troubles.isEmpty ? .ok : .bad
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: level.symbol)
                .font(.system(size: 34))
                .foregroundStyle(level.color)
                .symbolRenderingMode(.hierarchical)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(troubles.isEmpty ? "Everything is fine" : troubles.count == 1 ? "One thing needs a look" : "\(troubles.count) things need a look")
                    .font(.title3.weight(.semibold))
                if troubles.isEmpty {
                    if let head = overview.head.value {
                        Text([head.os, overview.host.value.map { "up " + Format.duration(seconds: $0.uptimeSeconds) }]
                            .compactMap { $0 }.joined(separator: " · "))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    ForEach(troubles, id: \.self) { trouble in
                        Text(trouble).font(.subheadline).foregroundStyle(.secondary)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: .secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: DS.radius, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

struct HostCard: View {
    let host: OverviewHost

    var body: some View {
        HStack(alignment: .top) {
            Stat(title: host.cores.map { "of \($0) cores" } ?? "processor", value: Format.percent(host.cpuPct),
                 level: (host.cpuPct ?? 0) >= 90 ? .warn : .idle)
            Stat(title: "load, 1 min", value: host.load.m1.map { $0.formatted(.number.precision(.fractionLength(2))) } ?? "–")
            if let hottest = host.temps.map(\.value).max() {
                Stat(title: "hottest", value: Format.celsius(hottest), level: hottest >= 85 ? .warn : .idle)
            }
        }
        if host.cpuSpark.count > 1 {
            Sparkline(values: host.cpuSpark, ceiling: 100)
                .frame(height: 56)
            Text("Processor, last 6 hours").font(.caption).foregroundStyle(.tertiary)
        }
    }
}

struct MemoryCard: View {
    let memory: OverviewMemory

    var body: some View {
        Meter(title: "In use", fraction: Format.fraction(used: memory.usedBytes, total: memory.totalBytes),
              detail: "\(Format.bytes(memory.usedBytes)) of \(Format.bytes(memory.totalBytes))")
        if let arc = memory.arcBytes, arc > 0 {
            FactRow(title: "Of that, ZFS cache", value: Format.bytes(arc))
        }
        if let total = memory.swapTotalBytes, total > 0 {
            FactRow(title: "Swap", value: "\(Format.bytes(memory.swapUsedBytes)) of \(Format.bytes(total))")
        }
        if let kills = memory.oomKills, kills > 0 {
            FactRow(title: "Out-of-memory kills", value: "\(kills)", level: .warn)
        }
    }
}

private struct AlertsCard: View {
    let alerts: Overview.AlertCounts

    var body: some View {
        if alerts.active.isEmpty {
            Label("Nothing firing", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.secondary)
                .symbolRenderingMode(.hierarchical)
        } else {
            ForEach(alerts.active) { alert in
                HStack(alignment: .top, spacing: 10) {
                    LevelIcon(level: alert.severity == "critical" ? .bad : .warn)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(alert.name).font(.callout.weight(.medium))
                        if !alert.summary.isEmpty {
                            Text(alert.summary).font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        if let pending = alerts.pending, pending > 0 {
            Text("\(pending) pending").font(.footnote).foregroundStyle(.secondary)
        }
    }
}

private struct ServicesCard: View {
    let host: OverviewHost
    let health: Overview.Health?
    let jobs: Overview.Jobs?

    var body: some View {
        let down = host.containers.down
        FactRow(title: "Containers",
                value: down.isEmpty ? (host.containers.total.map { "\($0) running" } ?? "–") : "\(down.count) down",
                level: down.isEmpty ? .ok : .bad)
        names(down)
        if let health {
            FactRow(title: "App probes",
                    value: health.failing.isEmpty ? "\(health.probes) answering" : "\(health.failing.count) failing",
                    level: health.failing.isEmpty ? .ok : .bad)
            names(health.failing)
        }
        FactRow(title: "Failed units", value: "\(host.failedUnits.count)", level: host.failedUnits.isEmpty ? .ok : .bad)
        names(host.failedUnits.map(\.unit))
        if let jobs {
            FactRow(title: "Scheduled jobs",
                    value: jobs.trouble.isEmpty ? "\(jobs.watched) fine" : "\(jobs.trouble.count) in trouble",
                    level: jobs.trouble.isEmpty ? .ok : .warn)
            names(jobs.trouble.map(\.unit))
        }
    }

    @ViewBuilder
    private func names(_ list: [String]) -> some View {
        if !list.isEmpty {
            Text(list.prefix(6).joined(separator: ", ") + (list.count > 6 ? " and \(list.count - 6) more" : ""))
                .font(DS.mono(.caption))
                .foregroundStyle(.secondary)
        }
    }
}

struct StorageCard: View {
    let storage: StorageHealth

    var body: some View {
        ForEach(storage.pools) { pool in
            VStack(alignment: .leading, spacing: 4) {
                Meter(title: pool.name, fraction: pool.capacityPct / 100,
                      detail: "\(Format.bytes(pool.freeBytes)) free")
                if pool.health != "ONLINE" {
                    Label(pool.health, systemImage: Level.bad.symbol).font(.footnote).foregroundStyle(.red)
                }
            }
        }
        let failed = storage.disks.filter { $0.passed == false }
        FactRow(title: "Drives",
                value: failed.isEmpty ? "\(storage.disks.count) healthy" : "\(failed.count) failing SMART",
                level: failed.isEmpty ? .ok : .bad)
        if let hottest = storage.disks.compactMap(\.temperature).max() {
            FactRow(title: "Hottest drive", value: Format.celsius(hottest), level: hottest >= 60 ? .warn : .ok)
        }
        FactRow(title: "Snapshots", value: "\(storage.snapshots.count), \(Format.bytes(storage.snapshots.bytes))")
    }
}

private struct ErrorsCard: View {
    let errors: Overview.ErrorCounts
    let hours: Int

    var body: some View {
        if errors.containers.isEmpty {
            Label("No error lines in \(hours) hours", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.secondary)
                .symbolRenderingMode(.hierarchical)
        } else {
            ForEach(errors.containers.prefix(6)) { item in
                NavigationLink {
                    LogsView(container: item.container)
                } label: {
                    HStack {
                        Text(item.container).font(DS.mono(.callout))
                        Spacer()
                        Text("\(item.count)").monospacedDigit().foregroundStyle(.secondary)
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                    }
                }
                .buttonStyle(.plain)
            }
            let rest = errors.containers.count - 6 + errors.more
            if rest > 0 {
                Text("and \(rest) more containers").font(.footnote).foregroundStyle(.secondary)
            }
            Text("Error lines, last \(hours) hours").font(.caption).foregroundStyle(.tertiary)
        }
    }
}

private struct UpdatesCard: View {
    let updates: Overview.UpdateCounts
    let apply: Overview.ApplySummary?

    var body: some View {
        FactRow(title: "Images behind", value: "\(updates.behind)")
        FactRow(title: "Engine", value: updates.engine == "behind-origin" ? "Update available"
            : updates.engine == "current" ? "Current" : updates.engine.capitalized)
        if let behind = updates.claudeCodeBehind {
            FactRow(title: "Claude Code", value: behind == 0 ? "Current" : "\(behind) behind")
        }
        if updates.running {
            Label("An update is running", systemImage: "arrow.triangle.2.circlepath").foregroundStyle(DS.brand)
        }
        if let apply, apply.pending > 0 {
            FactRow(title: "Waiting for Apply", value: "\(apply.pending)", level: .warn)
        }
    }
}

/// One container's recent lines, newest first.
struct LogsView: View {
    let container: String
    @State private var search = ""
    @State private var feed: Feed<Untrusted<[LogLine]>>

    init(container: String) {
        self.container = container
        _feed = State(initialValue: Feed { try await Box.shared.call(API.logs(container: container, text: nil)) })
    }

    var body: some View {
        List {
            FeedView(feed: feed, unavailableTitle: "No lines") { logs in
                let lines = search.isEmpty ? logs.content
                    : logs.content.filter { $0.line.localizedCaseInsensitiveContains(search) }
                if lines.isEmpty {
                    Text("No lines in the last 24 hours.").foregroundStyle(.secondary)
                }
                ForEach(lines, id: \.self) { line in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(Format.ago(line.at)).font(.caption2).foregroundStyle(.tertiary)
                        Text(line.line).font(DS.mono(.caption)).textSelection(.enabled)
                    }
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle(container)
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $search, prompt: "Filter lines")
        .refreshable { await feed.refresh() }
        .task { await feed.refresh() }
    }
}
