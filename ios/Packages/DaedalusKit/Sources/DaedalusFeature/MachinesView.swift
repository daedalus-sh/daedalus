import SwiftUI

/// Every machine of the box: the box itself, the computers, the phones and tablets.
struct MachinesView: View {
    @State private var box = Box.shared
    @State private var feed = Feed<Machines> { try await Box.shared.call(API.machines) }

    var body: some View {
        NavigationStack {
            List {
                FeedView(feed: feed, unavailableTitle: "Machines could not be read") { value in
                    ForEach(value.machines) { machine in
                        NavigationLink(value: machine) {
                            MachineRow(machine: machine)
                        }
                    }
                }
            }
            .navigationTitle("Machines")
            .navigationDestination(for: MachineItem.self) { MachineDetailView(machine: $0) }
            .refreshable { await feed.refresh() }
            .task(id: box.epoch) { await feed.poll(every: 20) }
        }
    }
}

extension MachineItem {
    var symbol: String {
        if isBox { return "server.rack" }
        switch os {
        case "ios": return "iphone"
        case "ipados": return "ipad"
        case "macos": return "laptopcomputer"
        default: return "desktopcomputer"
        }
    }

    var osName: String {
        switch os {
        case "ios": "iOS"
        case "ipados": "iPadOS"
        case "macos": "macOS"
        case "windows": "Windows"
        case "linux": "Linux"
        default: os
        }
    }

    /// Where it stands, in a few words. A phone that is away is only away.
    var presence: String {
        if state == "revoked" { return "Revoked" }
        if connected == true { return "Connected" }
        if connected == nil { return "Unknown" }
        return "Seen " + Format.ago(seconds: lastSeenAgo)
    }

    var level: Level {
        if state == "revoked" { return .idle }
        if connected == true { return .ok }
        return light || connected == nil ? .idle : .bad
    }
}

private struct MachineRow: View {
    let machine: MachineItem

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: machine.symbol)
                .font(.title2)
                .foregroundStyle(DS.brand)
                .frame(width: 34)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(machine.name).font(.body.weight(.medium))
                    if machine.isSelf {
                        Text("this device").font(.caption2.weight(.semibold))
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(.quaternary, in: Capsule())
                    }
                }
                HStack(spacing: 5) {
                    Circle().fill(machine.level.color).frame(width: 7, height: 7)
                    Text("\(machine.presence) · \(machine.osName)")
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            if let percent = machine.battery?.percent {
                Label(Format.percent(percent), systemImage: machine.battery?.charging == true ? "battery.100.bolt" : "battery.75")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .labelStyle(.titleAndIcon)
            } else if machine.updateAvailable != nil {
                Image(systemName: "arrow.down.circle").foregroundStyle(.orange)
                    .accessibilityLabel("Agent update available")
            }
        }
        .padding(.vertical, 2)
    }
}

/// One machine: what it is, how it is doing, and what it can be told to do.
struct MachineDetailView: View {
    let machine: MachineItem
    @State private var box = Box.shared
    @State private var feed: Feed<MachineDetail>

    init(machine: MachineItem) {
        self.machine = machine
        _feed = State(initialValue: Feed { try await Box.shared.call(API.machine(machine.id)) })
    }

    var body: some View {
        List {
            FeedView(feed: feed, unavailableTitle: "This machine could not be read") { detail in
                identity(detail.machine)
                if detail.kind == "box" {
                    boxParts(detail)
                } else {
                    if let note = detail.note {
                        Text(note).font(.callout).foregroundStyle(.secondary)
                    }
                    if let device = detail.device { deviceParts(device) }
                    if let releases = detail.osReleases { releaseParts(releases) }
                    ForEach(detail.device?.accessories ?? []) { accessoryParts($0) }
                    if let system = detail.system, !detail.machine.light {
                        systemParts(system, spark: detail.cpuSpark ?? [])
                    }
                    if !detail.machine.light, detail.machine.state == "approved" { commands(detail.machine) }
                }
            }
        }
        .navigationTitle(machine.name)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await feed.refresh() }
        .task(id: box.epoch) { await feed.poll(every: 15) }
    }

    @ViewBuilder
    private func identity(_ item: MachineItem) -> some View {
        Section {
            FactRow(title: "State", value: item.presence, level: item.level)
            FactRow(title: "System", value: "\(item.osName) · \(item.arch)")
            if let model = item.model { FactRow(title: "Model", value: model) }
            if let version = item.agentVersion {
                FactRow(title: item.light ? "App" : "Agent", value: version)
            }
            if let update = item.updateAvailable {
                FactRow(title: "Agent update", value: update, level: .warn)
            }
            if item.restartPending {
                FactRow(title: "Restart", value: "Pending", level: .warn)
            }
        }
    }

    @ViewBuilder
    private func boxParts(_ detail: MachineDetail) -> some View {
        if let host = detail.host?.value {
            Section("Processor") { HostCard(host: host) }
            if !host.temps.isEmpty {
                Section("Temperatures") {
                    ForEach(host.temps) { FactRow(title: $0.label, value: Format.celsius($0.value)) }
                }
            }
        }
        if let memory = detail.memory?.value {
            Section("Memory") { MemoryCard(memory: memory) }
        }
        if let storage = detail.storage?.value {
            Section("Storage") { StorageCard(storage: storage) }
        }
    }

    @ViewBuilder
    private func deviceParts(_ device: DeviceView) -> some View {
        Section {
            if let version = device.osVersion { FactRow(title: "Version", value: version) }
            if let percent = device.battery?.percent {
                FactRow(title: "Battery",
                        value: Format.percent(percent) + (device.battery?.charging == true ? ", charging" : ""),
                        level: percent < 20 && device.battery?.charging != true ? .warn : .ok)
            }
            if let storage = device.storage, let total = storage.totalBytes, let free = storage.freeBytes {
                Meter(title: "Storage", fraction: Format.fraction(used: total - free, total: total),
                      detail: "\(Format.bytes(free)) free of \(Format.bytes(total))")
            }
            if let memory = device.memoryBytes { FactRow(title: "Memory", value: Format.bytes(memory)) }
        } header: {
            Text("Device")
        } footer: {
            Text("As it last reported, \(Format.ago(device.at)). A phone or tablet reports while its app is open.")
        }
    }

    @ViewBuilder
    private func releaseParts(_ releases: AppleOsReleases) -> some View {
        Section {
            FactRow(title: "Installed", value: releases.current.version)
            if releases.behind > 0 {
                FactRow(title: "Newest", value: releases.latest ?? "–", level: .warn)
            } else if releases.latest != nil {
                FactRow(title: "State", value: "Up to date")
            }
            if let error = releases.error { Text(error).font(.footnote).foregroundStyle(.secondary) }
            ForEach(releases.releases) { release in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(release.version).font(.body.weight(.medium))
                        Spacer()
                        if let date = release.date { Text(date).font(.caption).foregroundStyle(.secondary) }
                    }
                    if let summary = release.summary {
                        Text(summary).font(.footnote).foregroundStyle(.secondary)
                    }
                    HStack(spacing: 16) {
                        if let notes = release.notesUrl.flatMap({ URL(string: $0) }), notes.scheme == "https" {
                            Link("Release notes", destination: notes)
                        }
                        if let security = release.securityUrl.flatMap({ URL(string: $0) }), security.scheme == "https" {
                            Link("Security", destination: security)
                        }
                    }
                    .font(.footnote)
                }
            }
        } header: {
            Text(releases.os == "ipados" ? "iPadOS" : releases.os == "watchos" ? "watchOS" : "iOS")
        }
    }

    /// The device's watch, as the device last reported it.
    @ViewBuilder
    private func accessoryParts(_ accessory: DeviceView.Accessory) -> some View {
        Section {
            if let model = accessory.model { FactRow(title: "Model", value: model) }
            if let version = accessory.osVersion { FactRow(title: "watchOS", value: version) }
            if let percent = accessory.battery?.percent {
                FactRow(title: "Battery",
                        value: Format.percent(percent) + (accessory.battery?.charging == true ? ", charging" : ""),
                        level: percent < 20 && accessory.battery?.charging != true ? .warn : .ok)
            }
            if let storage = accessory.storage, let total = storage.totalBytes, let free = storage.freeBytes {
                Meter(title: "Storage", fraction: Format.fraction(used: total - free, total: total),
                      detail: "\(Format.bytes(free)) free of \(Format.bytes(total))")
            }
        } header: {
            Label(accessory.name ?? "Watch", systemImage: "applewatch")
        } footer: {
            if let at = accessory.at { Text("As its iPhone last reported, \(Format.ago(at)).") }
        }
        if let releases = accessory.osReleases { releaseParts(releases) }
    }

    @ViewBuilder
    private func systemParts(_ system: MachineSystem, spark: [Double]) -> some View {
        Section {
            FactRow(title: "System", value: "\(system.osName) \(system.osVersion)")
            FactRow(title: "Processor", value: system.cpu)
            FactRow(title: "Busy", value: Format.percent(system.cpuPct))
            if spark.count > 1 {
                Sparkline(values: spark, ceiling: 100).frame(height: 56)
            }
            FactRow(title: "Up", value: Format.duration(seconds: system.uptimeSeconds))
            if let pending = system.osUpdatesPending, pending > 0 {
                FactRow(title: "System updates", value: "\(pending) pending", level: .warn)
            }
            if system.osRebootPending == true {
                FactRow(title: "Reboot", value: "Pending", level: .warn)
            }
        } header: {
            Text("System")
        } footer: {
            Text("Sampled \(Format.ago(system.sampledAt)).")
        }
        Section("Memory and disks") {
            Meter(title: "Memory",
                  fraction: Format.fraction(used: system.memory.usedBytes, total: system.memory.totalBytes),
                  detail: "\(Format.bytes(system.memory.usedBytes)) of \(Format.bytes(system.memory.totalBytes))")
            ForEach(system.disks) { disk in
                Meter(title: disk.name ?? disk.mount,
                      fraction: Format.fraction(used: disk.usedBytes, total: disk.totalBytes),
                      detail: "\(Format.bytes(disk.freeBytes)) free")
            }
        }
        if let battery = system.battery, let percent = battery.percent {
            Section("Battery") {
                FactRow(title: "Charge", value: Format.percent(percent) + (battery.charging == true ? ", charging" : ""))
                if let health = battery.healthPct { FactRow(title: "Health", value: Format.percent(health)) }
            }
        }
        if !system.temperatures.isEmpty {
            Section("Temperatures") {
                ForEach(system.temperatures.prefix(8)) { FactRow(title: $0.label, value: Format.celsius($0.celsius)) }
            }
        }
    }

    @ViewBuilder
    private func commands(_ item: MachineItem) -> some View {
        Section {
            ActionButton(title: "Check for an agent update", systemImage: "arrow.clockwise") {
                try await box.send(API.command(machine: item.id, "check_update"))
                await feed.refresh()
            }
        } footer: {
            Text("Claude Code on this machine is under the Claude tab.")
        }
    }
}
