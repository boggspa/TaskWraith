// ComposerShellFixtureView.swift — visual-QA gallery rendering a representative
// swatch for each of the 13 composer shells via ComposerShellResolver. This is
// the contact-sheet surface for CS3b (per-style recipes) and CS8 (screenshot
// QA). Until the per-style recipes land, all non-default swatches mirror the
// default. Routed from a debug entry in CS8. See ios/COMPOSER-SHELL-PARITY.md.

import SwiftUI
import TaskWraithKit

public struct ComposerShellFixtureView: View {
    public init() {}

    public var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                ForEach(TWComposerStyle.known, id: \.raw) { style in
                    ComposerShellSwatch(
                        shell: ComposerShellResolver.resolve(
                            style, context: .current(presentation: .main)))
                }
            }
            .padding(16)
        }
        .background(TWTheme.appBg)
    }
}

/// A miniature composer mock driven entirely by a resolved shell — the unit the
/// fixture repeats per style so divergences (material/geometry/glyph) are
/// visible side by side.
struct ComposerShellSwatch: View {
    let shell: ResolvedComposerShell

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(shell.style.label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(TWTheme.textSecondary)
            shellMock
        }
    }

    private var shellMock: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Message…")
                .font(fontForDesign)
                .foregroundStyle(shell.palette.placeholder)
            HStack(spacing: 8) {
                mockPill("Claude")
                mockPill("Plan")
                Spacer(minLength: 0)
                sendButton
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        // Use the REAL composer-shell chrome (glass / paper-grain / perforation /
        // rim-chase / inset-rim / glow / mask) so each swatch mirrors the live
        // composer surface instead of a flat illustrative frost.
        .composerShell(shell)
    }

    private var fontForDesign: Font {
        switch shell.fontDesign {
        case .system: return .callout
        case .monospaced: return .system(.callout, design: .monospaced)
        case .serif: return .system(.callout, design: .serif)
        }
    }

    private func mockPill(_ text: String) -> some View {
        Text(text)
            .font(.caption2)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .foregroundStyle(shell.palette.textPrimary.opacity(0.8))
            .background(controlBackground)
    }

    @ViewBuilder
    private var controlBackground: some View {
        let fill = shell.palette.border.opacity(0.6)
        switch shell.geometry.controlShape {
        case .capsule: Capsule().fill(fill)
        case .rounded(let radius): RoundedRectangle(cornerRadius: radius).fill(fill)
        case .rect(let radius): RoundedRectangle(cornerRadius: radius).fill(fill)
        }
    }

    private var sendButton: some View {
        ComposerPreviewSendLabel(shell: shell)
    }
}
