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
        let shape = RoundedRectangle(
            cornerRadius: shell.geometry.surfaceCornerRadius, style: .continuous)
        return VStack(alignment: .leading, spacing: 10) {
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
        .background(surfaceBackground(shape))
        .overlay(
            shape.strokeBorder(
                shell.palette.border, lineWidth: shell.palette.rim?.width ?? 1))
    }

    @ViewBuilder
    private func surfaceBackground(_ shape: RoundedRectangle) -> some View {
        switch shell.material {
        case .transparent:
            Color.clear
        case .glass:
            shape.fill(shell.palette.surfaceFill.opacity(0.6))  // illustrative frost
        case .solid, .paper:
            shape.fill(shell.palette.surfaceFill)
        }
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
        Image(systemName: sendSymbol)
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(sendForeground)
            .frame(width: shell.sendButton.size * 0.7, height: shell.sendButton.size * 0.7)
            .background(sendBackground)
    }

    private var sendSymbol: String {
        switch shell.sendButton.glyph {
        case .returnArrow: return "return"
        case .arrowUp: return "arrow.up"
        case .runTriangle: return "play.fill"
        }
    }

    private var sendForeground: Color {
        switch shell.sendButton.fill {
        case .accent, .neutral: return .white
        case .outline, .plain: return shell.sendButton.tint
        }
    }

    @ViewBuilder
    private var sendBackground: some View {
        let shape = sendShape
        switch shell.sendButton.fill {
        case .accent: shape.fill(shell.sendButton.tint)
        case .neutral: shape.fill(shell.palette.textPrimary.opacity(0.9))
        case .outline: shape.stroke(shell.sendButton.tint, lineWidth: 1)
        case .plain: shape.fill(Color.clear)
        }
    }

    private var sendShape: AnyShape {
        switch shell.sendButton.shape {
        case .capsule: return AnyShape(Circle())
        case .rounded(let radius): return AnyShape(RoundedRectangle(cornerRadius: radius))
        case .rect(let radius): return AnyShape(RoundedRectangle(cornerRadius: radius))
        }
    }
}
