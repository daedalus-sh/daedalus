import SwiftUI

/// Claude Code across the fleet: where Remote Control runs, what is connected to it, and the verbs.
struct ClaudeView: View {
    @State private var box = Box.shared
    @State private var feed = Feed<ClaudeFleet> { try await Box.shared.call(API.claude) }

    var body: some View {
        NavigationStack {
            List {
                FeedView(feed: feed, unavailableTitle: "Claude could not be read") { fleet in
                    ForEach(fleet.machines) { machine in
                        ClaudeMachineSection(machine: machine) { await feed.refresh() }
                    }
                }
            }
            .navigationTitle("Claude")
            .refreshable { await feed.refresh() }
            .task(id: box.epoch) { await feed.poll(every: 10) }
        }
    }
}

extension ClaudeMachine.Server {
    var level: Level {
        switch state {
        case "running": .ok
        case "starting", "waiting", "no-session": .warn
        case "off", "not-run", "no-report", "unknown": .idle
        default: .bad
        }
    }

    var label: String {
        switch state {
        case "running": "Running"
        case "starting": "Starting"
        case "waiting": "Waiting"
        case "stopped": "Stopped"
        case "off", "not-run": "Off"
        case "not-installed": "Not installed"
        case "no-session": "Nobody logged in"
        case "no-report": "No report yet"
        case "unreachable": "Not reachable"
        default: state.capitalized
        }
    }
}

private struct ClaudeMachineSection: View {
    let machine: ClaudeMachine
    let reload: () async -> Void
    @State private var box = Box.shared

    var body: some View {
        Section {
            HStack(spacing: 8) {
                Circle().fill(machine.server.level.color).frame(width: 8, height: 8)
                Text(machine.server.label)
                Spacer()
                if let version = machine.server.cliVersion {
                    Text(version).font(DS.mono(.caption)).foregroundStyle(.secondary)
                }
            }
            .alert("That did not work", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(failure ?? "")
            }
            if let detail = machine.server.detail, machine.server.level != .ok {
                Text(detail).font(.footnote).foregroundStyle(.secondary)
            }
            if !machine.server.signedIn, machine.server.state != "off", machine.server.state != "not-run" {
                Label("Claude is not signed in there.", systemImage: "person.crop.circle.badge.exclamationmark")
                    .font(.footnote).foregroundStyle(.orange)
            }
            ForEach(machine.sessions) { session in
                SessionRow(title: session.name ?? session.cwd.map(Self.folder) ?? "Session",
                           subtitle: [session.cwd.map(Self.folder), session.lastActivityAt.map { "active " + Self.ago(ms: $0) }]
                               .compactMap { $0 }.joined(separator: " · "),
                           busy: session.status == "busy", alive: session.alive)
            }
            ForEach(machine.agents) { agent in
                SessionRow(title: agent.name ?? "Background agent",
                           subtitle: [agent.state, agent.cwd.map(Self.folder)].compactMap { $0 }.joined(separator: " · "),
                           busy: agent.state == "running", alive: true)
                    .swipeActions {
                        Button("Remove", role: .destructive) { verb("remove", agent.id) }
                        Button("Stop") { verb("stop", agent.id) }.tint(.orange)
                    }
            }
            if machine.sessions.isEmpty, machine.agents.isEmpty, machine.server.level == .ok {
                Text("No sessions connected.").foregroundStyle(.secondary)
            }
            if let working {
                HStack {
                    ProgressView()
                    Text(working).font(.footnote).foregroundStyle(.secondary)
                }
            }
            if !machine.transcripts.isEmpty {
                NavigationLink("Resume a recent session") {
                    TranscriptsView(machine: machine) { verb("resume", $0) }
                }
            }
            if let gap = machine.update, gap.behind > 0 {
                ActionButton(title: "Update Claude Code to \(gap.latest ?? "the newest")", systemImage: "arrow.down.circle",
                             confirm: machine.id == "box" ? "The box pins the newest release and rebuilds."
                                 : "Claude Code is updated there. Running sessions are not interrupted.") {
                    if machine.id == "box" {
                        try await box.send(API.updateClaudeCode)
                    } else {
                        try await box.send(API.command(machine: machine.id, "claude_update"))
                    }
                    await reload()
                }
            }
            if machine.server.state != "off", machine.server.state != "not-run", machine.server.state != "not-installed" {
                ActionButton(title: "Restart Remote Control", systemImage: "arrow.clockwise", role: .destructive,
                             confirm: "Every session on \(machine.name) ends, then resumes by itself.") {
                    try await box.send(API.claudeRestart(machine: machine.id))
                    await reload()
                }
            }
        } header: {
            Text(machine.name)
        } footer: {
            if let note = machine.note { Text(note) }
        }
    }

    @State private var working: String?
    @State private var failure: String?

    /// Send one session verb and follow it to its outcome (api.md: poll for about 30 s).
    private func verb(_ action: String, _ session: String) {
        guard working == nil else { return }
        working = action == "resume" ? "Resuming…" : action == "stop" ? "Stopping…" : "Removing…"
        Task {
            defer { working = nil }
            do {
                let sent: ClaudeSessionSent = try await box.call(
                    API.claudeSession(machine: machine.id, action: action, session: session))
                for _ in 0 ..< 20 {
                    try await Task.sleep(for: .seconds(1.5))
                    let answer: ClaudeAction = try await box.call(
                        API.claudeAction(machine: machine.id, request: sent.request))
                    guard let outcome = answer.outcome, outcome.state != "running" else { continue }
                    if outcome.state != "done" {
                        failure = outcome.detail.isEmpty ? "The machine \(outcome.state) it." : outcome.detail
                    }
                    break
                }
            } catch is CancellationError {
            } catch {
                failure = error.localizedDescription
            }
            await reload()
        }
    }

    static func folder(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }

    static func ago(ms: Double) -> String {
        Format.ago(seconds: Date.now.timeIntervalSince1970 - ms / 1000)
    }
}

private struct SessionRow: View {
    let title: String
    let subtitle: String
    let busy: Bool
    let alive: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: busy ? "circle.dotted.circle" : "circle")
                .foregroundStyle(busy ? DS.brand : Color.secondary)
                .symbolEffect(.pulse, isActive: busy)
                .accessibilityLabel(busy ? "Busy" : "Idle")
            VStack(alignment: .leading, spacing: 2) {
                Text(title).lineLimit(1)
                if !subtitle.isEmpty {
                    Text(subtitle).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                }
            }
        }
        .opacity(alive ? 1 : 0.5)
    }
}

/// The machine's recent transcripts: pick one to bring back as a session.
private struct TranscriptsView: View {
    let machine: ClaudeMachine
    let resume: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List(machine.transcripts) { transcript in
            Button {
                resume(transcript.id)
                dismiss()
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(transcript.title ?? "Untitled session").lineLimit(2)
                    Text("\(ClaudeMachineSection.folder(transcript.cwd)) · \(ClaudeMachineSection.ago(ms: transcript.modifiedAt))")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .tint(.primary)
        }
        .navigationTitle("Resume on \(machine.name)")
        .navigationBarTitleDisplayMode(.inline)
    }
}
