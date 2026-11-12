import AVFoundation
import SwiftUI
import UIKit
import VisionKit

/// The first screen: nothing works until this device is paired, and pairing is one scan.
struct PairView: View {
    @State private var box = Box.shared
    @State private var scanning = false

    var body: some View {
        VStack(spacing: 28) {
            Spacer()
            LabyrinthMark()
                .stroke(DS.brand, style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round))
                .frame(width: 88, height: 88)
                .accessibilityHidden(true)
            VStack(spacing: 10) {
                Text("Pair with your box")
                    .font(.largeTitle.bold())
                Text("On the box, open Settings › Machines and add this device. Then scan the code it shows.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            if let error = box.pairError {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.leading)
            }
            Spacer()
            VStack(spacing: 12) {
                Button {
                    box.clearPairError()
                    scanning = true
                } label: {
                    Group {
                        if box.isPairing {
                            ProgressView()
                        } else {
                            Label("Scan the code", systemImage: "qrcode.viewfinder")
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(box.isPairing)

                Button("Paste a pairing link") {
                    guard let text = UIPasteboard.general.string, let link = PairLink(string: text) else {
                        box.clearPairError()
                        pasteFailed = true
                        return
                    }
                    Task { await box.pair(link) }
                }
                .disabled(box.isPairing)
            }
            Text("The app keeps its own encrypted tunnel to the box. Nothing else on this device uses it.")
                .font(.footnote)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
        }
        .padding(24)
        .frame(maxWidth: 480)
        .frame(maxWidth: .infinity)
        .fullScreenCover(isPresented: $scanning) {
            QRScannerView { link in
                scanning = false
                Task { await box.pair(link) }
            } onCancel: {
                scanning = false
            }
        }
        .alert("No pairing link on the clipboard", isPresented: $pasteFailed) {
            Button("OK", role: .cancel) {}
        }
    }

    @State private var pasteFailed = false
}

/// Scans the QR code Settings › Machines shows (a `daedalus://pair` link) and hands back the link.
struct QRScannerView: View {
    let onFound: (PairLink) -> Void
    let onCancel: () -> Void
    @State private var message = "Point the camera at the code in Settings › Machines."
    /// Camera access, asked for on appear: the scanner reports itself unavailable until it is granted.
    @State private var cameraAllowed: Bool?

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.black.ignoresSafeArea()
            if cameraAllowed == nil {
                ProgressView().tint(.white).frame(maxHeight: .infinity)
            } else if cameraAllowed == false {
                unavailable("Daedalus can't use the camera. Allow it in Settings, or scan the code with the Camera app.")
            } else if DataScannerViewController.isSupported, DataScannerViewController.isAvailable {
                QRScanner { payload in
                    if let link = PairLink(string: payload) {
                        onFound(link)
                    } else {
                        message = "That isn't a Daedalus pairing code. Add this device in Settings › Machines."
                    }
                }
                .ignoresSafeArea()
            } else {
                unavailable("This device can't scan here. Scan the code with the Camera app instead.")
            }
            VStack(spacing: 12) {
                Text(message)
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.white)
                Button("Cancel", action: onCancel)
                    .buttonStyle(.bordered)
                    .tint(.white)
            }
            .padding()
            .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: DS.radius, style: .continuous))
            .padding()
        }
        .preferredColorScheme(.dark)
        .task { cameraAllowed = await AVCaptureDevice.requestAccess(for: .video) }
    }

    private func unavailable(_ text: String) -> some View {
        Text(text)
            .multilineTextAlignment(.center)
            .foregroundStyle(.white)
            .padding()
            .frame(maxHeight: .infinity)
    }
}

private struct QRScanner: UIViewControllerRepresentable {
    let onPayload: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])],
                                                qualityLevel: .balanced,
                                                isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        if !scanner.isScanning { try? scanner.startScanning() }
    }

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
        scanner.stopScanning()
    }

    func makeCoordinator() -> Coordinator { Coordinator(onPayload: onPayload) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onPayload: (String) -> Void
        private var lastPayload: String?

        init(onPayload: @escaping (String) -> Void) {
            self.onPayload = onPayload
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem],
                         allItems: [RecognizedItem]) {
            for item in addedItems {
                guard case .barcode(let barcode) = item, let payload = barcode.payloadStringValue,
                      payload != lastPayload
                else { continue }
                lastPayload = payload
                onPayload(payload)
                return
            }
        }
    }
}
