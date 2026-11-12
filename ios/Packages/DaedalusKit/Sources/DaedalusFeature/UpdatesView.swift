import SwiftUI

/// What is behind, the queue, and the buttons that move things: images, the engine, Claude Code, Apply.
struct UpdatesView: View {
    @State private var box = Box.shared
    @State private var updates = Feed<Updates> { try await Box.shared.call(API.updates) }
    @State private var apply = Feed<PendingApply> { try await Box.shared.call(API.apply) }
    /// The pin whose ceremony is being typed, and what to do with the typed name.
    @State private var ceremony: CeremonyRequest?
    @State private var typed = ""
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            List {
                FeedView(feed: updates, unavailableTitle: "Updates could not be read") { value in
                    runs(value.status)
                    images(value)
                    queue(value)
                    engine(value)
                    claudeCode(value)
                }
                applySection
            }
            .navigationTitle("Updates")
            .refreshable { await refresh() }
            .task(id: box.epoch) {
                // Quick while something is running, relaxed otherwise.
                while !Task.isCancelled {
                    await refresh()
                    let busy = updates.value?.status.running == true || apply.value?.status.isRunning == true
                    try? await Task.sleep(for: .seconds(busy ? 3 : 20))
                }
            }
            .alert("Type the name to confirm", isPresented: Binding(get: { ceremony != nil }, set: { if !$0 { ceremony = nil } }),
                   presenting: ceremony) { request in
                TextField(request.image.container, text: $typed)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button(request.queue ? "Add to queue" : "Update", role: .destructive) {
                    let name = typed
                    typed = ""
                    act { try await move(request.image, queue: request.queue, confirm: name) }
                }
                Button("Cancel", role: .cancel) { typed = "" }
            } message: { request in
                Text("Updating \(request.image.container) \(request.text). Type \(request.image.container) to go ahead.")
            }
            .alert("That did not work", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(failure ?? "")
            }
        }
    }

    private struct NamedRun: Identifiable {
        var name: String
        var run: RunStatus
        var id: String { name }
    }

    private struct CeremonyRequest {
        var image: PendingImage
        var text: String
        var queue: Bool
    }

    private func refresh() async {
        async let first: Void = updates.refresh()
        async let second: Void = apply.refresh()
        _ = await (first, second)
    }

    /// Run something that changes the box, then read the new state; a refusal is shown with its reason.
    private func act(_ work: @escaping () async throws -> Void) {
        Task {
            do {
                try await work()
            } catch is CancellationError {
            } catch {
                failure = error.localizedDescription
            }
            await refresh()
        }
    }

    private func start(_ image: PendingImage, queue: Bool) {
        if let text = image.ceremony(movingTo: image.target) {
            ceremony = CeremonyRequest(image: image, text: text, queue: queue)
        } else {
            act { try await move(image, queue: queue, confirm: nil) }
        }
    }

    private func move(_ image: PendingImage, queue: Bool, confirm: String?) async throws {
        if queue {
            try await box.send(API.queueAdd(container: image.container, toTag: image.target, confirm: confirm))
        } else {
            try await box.send(API.run(container: image.container, toTag: image.target, confirm: confirm))
        }
    }

    // MARK: Sections

    @ViewBuilder
    private func runs(_ status: UpdatesStatus) -> some View {
        let shown = [NamedRun(name: "Images", run: status.images), NamedRun(name: "Engine", run: status.engine),
                     NamedRun(name: "Claude Code", run: status.claudeCode)]
            .filter { $0.run.isRunning || $0.run.failed }
        if !shown.isEmpty {
            Section("Now") {
                ForEach(shown) { item in
                    RunRow(name: item.name, run: item.run)
                }
            }
        }
    }

    @ViewBuilder
    private func images(_ value: Updates) -> some View {
        Section {
            if value.probeMissing {
                Text("The registry check has not run yet.").foregroundStyle(.secondary)
            } else if value.images.isEmpty {
                Label("Every image is current", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.secondary)
                    .symbolRenderingMode(.hierarchical)
            }
            ForEach(value.images) { image in
                let queued = value.queue.contains { $0.container == image.container }
                NavigationLink {
                    ChangelogView(image: image)
                } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(image.container).font(.body.weight(.medium))
                            if queued {
                                Text("queued").font(.caption2.weight(.semibold))
                                    .padding(.horizontal, 6).padding(.vertical, 2)
                                    .background(DS.brand.opacity(0.15), in: Capsule())
                                    .foregroundStyle(DS.brand)
                            }
                        }
                        Text("\(image.running ?? image.tag ?? "?") → \(image.target ?? "newer build")")
                            .font(DS.mono(.caption))
                            .foregroundStyle(.secondary)
                        if let ceremony = image.ceremony {
                            Label(ceremony, systemImage: "exclamationmark.triangle")
                                .font(.caption).foregroundStyle(.orange)
                        }
                    }
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    if image.updatable, !value.status.running {
                        Button("Update") { start(image, queue: false) }.tint(DS.brand)
                    }
                    if image.updatable, !queued {
                        Button("Queue") { start(image, queue: true) }.tint(.indigo)
                    }
                }
            }
        } header: {
            Text("Images")
        } footer: {
            if !value.images.isEmpty {
                Text("Swipe a row to update it now or add it to the queue. Checked \(Format.ago(value.checkedAt)).")
            }
        }
    }

    @ViewBuilder
    private func queue(_ value: Updates) -> some View {
        if !value.queue.isEmpty {
            Section {
                ForEach(value.queue) { item in
                    LabeledContent(item.container) {
                        Text(item.toTag ?? item.tag).font(DS.mono(.caption))
                    }
                    .swipeActions {
                        Button("Remove", role: .destructive) {
                            act { try await box.send(API.queueRemove(container: item.container)) }
                        }
                    }
                }
                ActionButton(title: "Run the queue", systemImage: "play.fill",
                             confirm: "One commit, one build, one switch. If one fails, all of them are reverted.") {
                    try await box.send(API.runQueue)
                    await refresh()
                }
                .disabled(value.status.running)
            } header: {
                Text("Queue")
            }
        }
    }

    @ViewBuilder
    private func engine(_ value: Updates) -> some View {
        Section("Engine") {
            FactRow(title: "Pinned", value: value.engine.pinned ?? "–")
            switch value.engine.verdict {
            case "behind-origin":
                FactRow(title: "Behind", value: value.engine.behindOrigin.map { "\($0) commits" } ?? "yes", level: .warn)
                if value.engine.override {
                    Text("A developer override is on, so the engine cannot be updated from here.")
                        .font(.footnote).foregroundStyle(.secondary)
                } else {
                    ActionButton(title: "Update the engine", systemImage: "arrow.down.circle",
                                 confirm: "The box rebuilds on the newest engine. The control plane restarts.") {
                        try await box.send(API.updateEngine)
                        await refresh()
                    }
                    .disabled(value.status.running)
                }
            case "current":
                FactRow(title: "State", value: "Current")
            default:
                FactRow(title: "State", value: value.engine.verdict.capitalized)
            }
        }
    }

    @ViewBuilder
    private func claudeCode(_ value: Updates) -> some View {
        if let gap = value.claudeCode {
            Section("Claude Code on the box") {
                FactRow(title: "Installed", value: gap.installed ?? "–")
                if gap.behind > 0 {
                    FactRow(title: "Newest", value: gap.latest ?? "–", level: .warn)
                    ActionButton(title: "Update Claude Code", systemImage: "arrow.down.circle",
                                 confirm: "The box pins the newest release and rebuilds.") {
                        try await box.send(API.updateClaudeCode)
                        await refresh()
                    }
                    .disabled(value.status.running)
                }
            }
        }
    }

    @ViewBuilder
    private var applySection: some View {
        if let pending = apply.value, !pending.changed.isEmpty || pending.status.isRunning || pending.status.failed
            || pending.status.rebootPending == true
        {
            Section {
                if pending.status.isRunning || pending.status.failed {
                    RunRow(name: "Apply", run: pending.status)
                }
                if pending.status.rebootPending == true {
                    Label("The last Apply needs a reboot.", systemImage: "power").foregroundStyle(.orange)
                }
                ForEach(pending.changed) { change in
                    LabeledContent(change.name) {
                        Text(change.fields.joined(separator: ", ")).font(.caption)
                    }
                }
                if !pending.changed.isEmpty {
                    ActionButton(title: "Apply", systemImage: "checkmark.seal",
                                 confirm: "The box commits these changes and rebuilds.") {
                        try await box.send(API.runApply)
                        await refresh()
                    }
                    .disabled(pending.status.isRunning)
                }
            } header: {
                Text("Waiting for Apply")
            }
        }
    }
}

/// A run on the box: what it is doing, or why it failed.
private struct RunRow: View {
    let name: String
    let run: RunStatus

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if run.isRunning {
                ProgressView()
            } else {
                LevelIcon(level: .bad)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(.body.weight(.medium))
                Text(run.isRunning ? (run.phase.isEmpty ? "starting" : run.phase) : (run.error.isEmpty ? "failed" : run.error))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if let targets = run.targets, !targets.isEmpty {
                    Text(targets.joined(separator: ", ")).font(DS.mono(.caption)).foregroundStyle(.tertiary)
                }
            }
        }
    }
}

/// What changed between the running version and the newest: the release notes, as text.
struct ChangelogView: View {
    let image: PendingImage
    @State private var feed: Feed<Untrusted<Changelog>>

    init(image: PendingImage) {
        self.image = image
        _feed = State(initialValue: Feed { try await Box.shared.call(API.changelog(container: image.container)) })
    }

    var body: some View {
        List {
            FeedView(feed: feed, unavailableTitle: "No changelog") { answer in
                let log = answer.content
                Section {
                    FactRow(title: "Running", value: log.installed ?? image.running ?? "–")
                    FactRow(title: "Newest", value: log.latest ?? image.target ?? "–")
                    if let repo = log.repo { FactRow(title: "Source", value: repo) }
                    if let note = log.note { Text(note).font(.footnote).foregroundStyle(.secondary) }
                }
                ForEach(log.releases ?? []) { release in
                    Section {
                        ForEach(release.sections) { part in
                            VStack(alignment: .leading, spacing: 6) {
                                if !part.name.isEmpty {
                                    Text(part.name).font(.subheadline.weight(.semibold))
                                }
                                ForEach(Array(part.items.enumerated()), id: \.offset) { _, item in
                                    Text("• " + item).font(.callout)
                                }
                            }
                        }
                        if release.truncated {
                            Text("Cut short. The full notes are on GitHub.").font(.footnote).foregroundStyle(.secondary)
                        }
                        if let url = URL(string: release.url), url.scheme == "https" {
                            Link("Open the release", destination: url)
                        }
                    } header: {
                        Text("\(release.version) · \(release.date.prefix(10))")
                    }
                }
                if let commits = log.commits, !commits.isEmpty {
                    Section("Commits") {
                        ForEach(commits) { commit in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(commit.subject).font(.callout)
                                Text("\(commit.sha.prefix(8)) · \(commit.date.prefix(10))")
                                    .font(DS.mono(.caption2)).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle(image.container)
        .navigationBarTitleDisplayMode(.inline)
        .task { await feed.refresh() }
    }
}
