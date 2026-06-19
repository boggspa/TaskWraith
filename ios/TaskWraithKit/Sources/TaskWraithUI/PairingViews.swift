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

    private var pairEnabled: Bool {
        !pastedCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                hero
                if model.hasStoredPairing { pairedMacSection }
                pairSection
                statusSection
                demoCard
                identitySection
            }
            // Centered reading column — full width on iPhone, a tidy card
            // stack on iPad rather than edge-to-edge form rows.
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 18)
            .padding(.top, 12)
            .padding(.bottom, 40)
        }
        .background(TWTheme.appBg)
        #if os(iOS)
            .scrollDismissesKeyboard(.interactively)
        #endif
        .navigationTitle("")
        #if os(iOS)
            .sheet(isPresented: $showScanner) { scannerSheet }
        #endif
    }

    // ── Brand hero ────────────────────────────────────────────────────────────
    private var hero: some View {
        VStack(spacing: 14) {
            GhostMonolineMarkView(size: 84)
            VStack(spacing: 6) {
                Text("TaskWraith")
                    .font(.largeTitle.bold())
                    .foregroundStyle(TWTheme.textPrimary)
                Text("Your Mac's coding agents, in your pocket.")
                    .font(.subheadline)
                    .foregroundStyle(TWTheme.textSecondary)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 18)
        .padding(.bottom, 4)
    }

    // ── Paired Mac (reconnect / forget) ───────────────────────────────────────
    private var pairedMacSection: some View {
        labeledSection("Paired Mac") {
            card {
                Button { model.reconnectTrusted() } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "arrow.clockwise.circle.fill")
                            .font(.title2)
                            .foregroundStyle(TWTheme.chroma1)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(
                                model.macDisplayName.isEmpty
                                    ? "Reconnect" : "Reconnect to \(model.macDisplayName)"
                            )
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(TWTheme.textPrimary)
                            .lineLimit(1)
                            Text("Pick up where you left off.")
                                .font(.caption)
                                .foregroundStyle(TWTheme.textSecondary)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(TWTheme.textMuted)
                    }
                }
                .buttonStyle(.plain)
                Rectangle().fill(TWTheme.border).frame(height: 1)
                Button(role: .destructive) { model.forgetPairing() } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "trash")
                            .font(.caption)
                        Text("Forget this Mac")
                            .font(.footnote.weight(.medium))
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(TWTheme.statusFailed)
                }
                .buttonStyle(.plain)
            }
        }
    }

    // ── Pair (scan / paste / pair) ────────────────────────────────────────────
    private var pairSection: some View {
        labeledSection("Pair with your Mac") {
            card {
                Text(
                    "In TaskWraith on your Mac, open Settings → Devices, then scan the ghost QR — or paste the pairing code."
                )
                .font(.footnote)
                .foregroundStyle(TWTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

                #if os(iOS)
                    Button { showScanner = true } label: {
                        HStack(spacing: 9) {
                            Image(systemName: "qrcode.viewfinder").font(.body.weight(.semibold))
                            Text("Scan QR code").font(.subheadline.weight(.semibold))
                            Spacer(minLength: 0)
                        }
                        .foregroundStyle(TWTheme.chroma1)
                        .padding(.vertical, 11)
                        .padding(.horizontal, 14)
                        .background(
                            TWTheme.chroma1.opacity(0.12),
                            in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .buttonStyle(.plain)

                    HStack(spacing: 10) {
                        Rectangle().fill(TWTheme.border).frame(height: 1)
                        Text("or").font(.caption2).foregroundStyle(TWTheme.textMuted)
                        Rectangle().fill(TWTheme.border).frame(height: 1)
                    }
                    .padding(.vertical, 2)
                #endif

                TextField("Paste pairing code (JSON)", text: $pastedCode, axis: .vertical)
                    .lineLimit(3...6)
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(TWTheme.textPrimary)
                    // The model also sanitizes smart quotes, but stop iOS
                    // mangling the JSON in the first place.
                    .autocorrectionDisabled(true)
                    #if os(iOS)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.asciiCapable)
                    #endif
                    .padding(12)
                    .background(
                        TWTheme.surface2, in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(TWTheme.border))

                Button { model.pair(fromBootstrapJSON: pastedCode) } label: {
                    Text("Pair")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .foregroundStyle(pairEnabled ? Color.white : TWTheme.textMuted)
                        .background(
                            pairEnabled ? TWTheme.chroma1 : TWTheme.surface3,
                            in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(!pairEnabled)
                .animation(.easeOut(duration: 0.15), value: pairEnabled)
            }
        }
    }

    // ── Connection status ─────────────────────────────────────────────────────
    @ViewBuilder
    private var statusSection: some View {
        switch model.phase {
        case .connecting:
            card {
                HStack(spacing: 11) {
                    ProgressView().controlSize(.small).tint(TWTheme.chroma1)
                    Text("Connecting…")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(TWTheme.textPrimary)
                    Spacer(minLength: 0)
                }
            }
        case .awaitingMacConfirm(let code):
            labeledSection("Confirm on your Mac") {
                card {
                    Text(code)
                        .font(.system(size: 42, weight: .bold, design: .monospaced))
                        .foregroundStyle(TWTheme.chroma3)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, 4)
                    Text("Check this 6-digit code matches the one on your Mac, then confirm there.")
                        .font(.footnote)
                        .foregroundStyle(TWTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        case .error(let message):
            HStack(alignment: .top, spacing: 11) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.subheadline)
                    .foregroundStyle(TWTheme.statusFailed)
                    .padding(.top, 1)
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(TWTheme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                TWTheme.statusFailed.opacity(0.10),
                in: RoundedRectangle(cornerRadius: 14, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(TWTheme.statusFailed.opacity(0.35)))
        default:
            EmptyView()
        }
    }

    // ── Demo CTA (the App Review path) ────────────────────────────────────────
    private var demoCard: some View {
        Button { model.enterDemoMode() } label: {
            HStack(spacing: 13) {
                ZStack {
                    Circle().fill(TWTheme.chroma1.opacity(0.14)).frame(width: 44, height: 44)
                    Image(systemName: "play.fill")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(TWTheme.chroma1)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text("Try the demo")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TWTheme.textPrimary)
                    Text("Explore TaskWraith with sample data — no Mac required.")
                        .font(.caption)
                        .foregroundStyle(TWTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TWTheme.textMuted)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                TWTheme.surface1, in: RoundedRectangle(cornerRadius: 16, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(TWTheme.chroma1.opacity(0.28)))
        }
        .buttonStyle(.plain)
    }

    // ── This device (identity) ────────────────────────────────────────────────
    private var identitySection: some View {
        labeledSection("This device") {
            card {
                HStack(spacing: 10) {
                    Image(systemName: "key.fill")
                        .font(.caption)
                        .foregroundStyle(TWTheme.textTertiary)
                    Text("Identity")
                        .font(.subheadline)
                        .foregroundStyle(TWTheme.textPrimary)
                    Spacer(minLength: 8)
                    Text(model.identityPublicKeyBase64.prefix(16) + "…")
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(TWTheme.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
        }
    }

    // ── Chrome helpers ────────────────────────────────────────────────────────
    private func labeledSection<Content: View>(
        _ title: String, @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title.uppercased())
                .font(.caption2.weight(.semibold))
                .kerning(0.6)
                .foregroundStyle(TWTheme.textTertiary)
                .padding(.leading, 4)
            content()
        }
    }

    private func card<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) { content() }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                TWTheme.surface1, in: RoundedRectangle(cornerRadius: 16, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(TWTheme.border))
    }

    #if os(iOS)
        private var scannerSheet: some View {
            NavigationStack {
                QRScannerView { code in
                    showScanner = false
                    // Mirror the scan into the paste field: visible feedback that
                    // the scan took, and any stale manually-edited text can't
                    // shadow it.
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
