import SwiftUI

/// What this device is paired with, how the tunnel is doing, and the way out.
struct SettingsView: View {
    @State private var box = Box.shared
    @State private var status: CoreStatus?
    @State private var confirmingUnpair = false

    var body: some View {
        NavigationStack {
            Form {
                if let pairing = box.pairing {
                    Section("Box") {
                        FactRow(title: "Name", value: pairing.boxName)
                        FactRow(title: "Address", value: pairing.appURL?.host() ?? pairing.app)
                        FactRow(title: "This node", value: pairing.nodeID)
                        FactRow(title: "Link", value: linkState)
                    }
                    Section {
                        FactRow(title: "State", value: tunnelState, level: tunnelLevel)
                        FactRow(title: "Endpoint", value: pairing.wireguard.endpoint)
                        FactRow(title: "Address", value: pairing.wireguard.address)
                        if let ago = status?.tunnel?.handshakeAgoSecs {
                            FactRow(title: "Last handshake", value: Format.ago(seconds: ago))
                        }
                        if let error = status?.tunnel?.error ?? status?.link?.error {
                            Text(error).font(.footnote).foregroundStyle(.secondary)
                        }
                    } header: {
                        Text("Tunnel")
                    } footer: {
                        Text("WireGuard, inside this app. It reaches the box and nothing else, and no other app uses it.")
                    }
                }
                Section {
                    Button("Unpair this device", role: .destructive) { confirmingUnpair = true }
                } footer: {
                    Text("The box forgets this device and deletes its tunnel. Pairing again takes a new code.")
                }
                Section {
                    FactRow(title: "Version", value: Self.version)
                }
            }
            .navigationTitle("Settings")
            .confirmationDialog("Unpair this device?", isPresented: $confirmingUnpair, titleVisibility: .visible) {
                Button("Unpair", role: .destructive) { Task { await box.unpair() } }
            }
            .task(id: box.epoch) {
                while !Task.isCancelled {
                    status = await box.coreStatus()
                    try? await Task.sleep(for: .seconds(3))
                }
            }
        }
    }

    private var linkState: String {
        switch status?.link?.state {
        case "approved": "Reporting"
        case "pending": "Waiting for approval"
        case "revoked": "Revoked"
        case "connecting": "Connecting"
        default: "Off"
        }
    }

    private var tunnelState: String {
        if box.removed { return "Removed on the box" }
        if box.unreachable != nil { return "Not reaching the box" }
        guard let status, status.running else { return "Idle" }
        return status.tunnel?.handshakeAgoSecs == nil ? "Connecting" : "Connected"
    }

    private var tunnelLevel: Level {
        if box.removed || box.unreachable != nil { return .bad }
        guard let status, status.running else { return .idle }
        return status.tunnel?.handshakeAgoSecs == nil ? .warn : .ok
    }

    private static var version: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "–"
        let build = info?["CFBundleVersion"] as? String ?? "–"
        return "\(version) (\(build))"
    }
}
