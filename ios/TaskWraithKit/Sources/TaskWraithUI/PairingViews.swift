// SwiftUI surface for the TaskWraith companion.
//
// Design direction (see ios/DESIGN.md): borrow the *format* of the Claude /
// Codex iOS apps — workspaces-as-projects home, thread view with collapsed
// history + tool chips, pill composer — but skinned entirely in TaskWraith's
// own theme tokens (TWTheme mirrors the desktop theme.css). iPhone focuses on
// solid thread management; iPad gets the sidebar (NavigationSplitView) where
// advanced affordances will live. Pure SwiftUI so `swift build` compile-checks
// on macOS; QR camera scanning is the one `#if os(iOS)` extra.

import SwiftUI
import TaskWraithKit

#if canImport(UIKit)
    import PhotosUI
    import UIKit
#endif

struct PairingView: View {
    @ObservedObject var model: RemoteSessionModel
    @State private var pastedCode = ""
    @State private var showScanner = false

    var body: some View {
        Form {
            Section {
                MastheadRow()
            }
            if model.hasStoredPairing {
                Section("Paired Mac") {
                    Button {
                        model.reconnectTrusted()
                    } label: {
                        Label(
                            model.macDisplayName.isEmpty
                                ? "Reconnect" : "Reconnect to \(model.macDisplayName)",
                            systemImage: "arrow.clockwise.circle.fill")
                    }
                    Button("Forget this Mac", role: .destructive) { model.forgetPairing() }
                        .font(.footnote)
                }
            }
            Section("Pair with your Mac") {
                Text(
                    "In TaskWraith on your Mac, open Settings → Devices, then scan the ghost QR — or paste the pairing code."
                )
                .font(.footnote).foregroundStyle(TWTheme.textSecondary)
                #if os(iOS)
                    Button {
                        showScanner = true
                    } label: {
                        Label("Scan QR code", systemImage: "qrcode.viewfinder")
                    }
                #endif
                TextField("Paste pairing code (JSON)", text: $pastedCode, axis: .vertical)
                    .lineLimit(3...6)
                    .font(.system(.footnote, design: .monospaced))
                    // The model also sanitizes smart quotes, but stop iOS
                    // mangling the JSON in the first place.
                    .autocorrectionDisabled(true)
                    #if os(iOS)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.asciiCapable)
                    #endif
                Button("Pair") { model.pair(fromBootstrapJSON: pastedCode) }
                    .disabled(pastedCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            Section {
                Button {
                    model.enterDemoMode()
                } label: {
                    Label("Try the demo", systemImage: "play.circle")
                }
            } footer: {
                Text("Explore TaskWraith with sample data — no Mac required.")
                    .font(.footnote)
            }

            switch model.phase {
            case .connecting:
                Section { Label("Connecting…", systemImage: "antenna.radiowaves.left.and.right") }
            case .awaitingMacConfirm(let code):
                Section("Confirm on your Mac") {
                    Text(code)
                        .font(.system(size: 40, weight: .bold, design: .monospaced))
                        .foregroundStyle(TWTheme.chroma3)
                        .frame(maxWidth: .infinity, alignment: .center)
                    Text("Check this 6-digit code matches the one on your Mac, then confirm there.")
                        .font(.footnote).foregroundStyle(TWTheme.textSecondary)
                }
            case .error(let message):
                Section {
                    Label(message, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(TWTheme.statusFailed)
                }
            default:
                EmptyView()
            }

            Section("This device") {
                LabeledContent("Identity") {
                    Text(model.identityPublicKeyBase64.prefix(16) + "…")
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(TWTheme.textSecondary)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(TWTheme.appBg)
        .navigationTitle("")
        #if os(iOS)
            .sheet(isPresented: $showScanner) {
                NavigationStack {
                    QRScannerView { code in
                        showScanner = false
                        // Mirror the scan into the paste field: visible
                        // feedback that the scan took, and any stale
                        // manually-edited text can't shadow it.
                        pastedCode = code
                        model.pair(fromBootstrapJSON: code)
                    }
                    .navigationTitle("Scan pairing QR")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel") { showScanner = false }
                        }
                    }
                }
            }
        #endif
    }
}
