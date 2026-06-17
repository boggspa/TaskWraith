// ComposerShellContainer.swift — applies a ResolvedComposerShell to the live
// composer surface, and resolves the effective shell from (local preference +
// Mac projection + theme + a11y). The glass path REUSES the existing
// composerShellGlass modifier verbatim, so the signed-off `default` shell is
// byte-for-byte unchanged; only solid/paper/transparent get new chrome here.
// Inner-module/control/font theming and premium effects (rim-chase, grain,
// perforation, terminal caret, two-surface split) land in CS5/CS6.
// See ios/COMPOSER-SHELL-PARITY.md (E.5/E.6).

import SwiftUI
import TaskWraithKit

/// Resolve the effective composer shell: local override → Mac-projected style →
/// default, then the visual recipe for the current theme + accessibility.
@MainActor
func twResolvedComposerShell(
    model: RemoteSessionModel,
    presentation: ComposerShellContext.Presentation = .main,
    width: CGFloat? = nil,
    providerAccent: Color? = nil
) -> ResolvedComposerShell {
    let style = twEffectiveComposerStyle(
        preference: TWThemeStore.shared.composerShellPreference,
        projected: model.projectedComposerStyle)
    return ComposerShellResolver.resolve(
        style,
        context: .current(presentation: presentation, width: width, providerAccent: providerAccent))
}

extension View {
    /// Apply a resolved composer shell's surface chrome.
    func composerShell(_ resolved: ResolvedComposerShell) -> some View {
        modifier(ComposerShellContainerModifier(resolved: resolved))
    }
}

private struct ComposerShellContainerModifier: ViewModifier {
    let resolved: ResolvedComposerShell

    func body(content: Content) -> some View {
        switch resolved.material {
        case .glass:
            // The native default — reuse the signed-off modifier verbatim so it
            // stays pixel-identical (the only .glass shell is `default`).
            content.composerShellGlass(cornerRadius: resolved.geometry.surfaceCornerRadius)
        case .solid, .paper:
            content.modifier(ComposerSolidShellModifier(resolved: resolved))
        case .transparent:
            // Container draws no chrome; children float (modular/satellite).
            // Per-pill chrome is added in CS6.
            content
        }
    }
}

/// Opaque shell surface (codex/claude/gemini/kimi/cursor/grok/terminal/stub/
/// obsidian/alabaster + default-under-Reduce-Transparency). Mirrors the glass
/// modifier's structure (fill → mask → border → static rim) with a solid fill.
private struct ComposerSolidShellModifier: ViewModifier {
    let resolved: ResolvedComposerShell

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(
            cornerRadius: resolved.geometry.surfaceCornerRadius, style: .continuous)
        let rim = resolved.palette.rim
        return content
            .background(shape.fill(resolved.palette.surfaceFill))
            .compositingGroup()
            .mask(shape)
            .overlay(shape.strokeBorder(resolved.palette.border, lineWidth: 1))
            .overlay(
                rim.map { rim in
                    shape.inset(by: 0.5).strokeBorder(rim.color, lineWidth: rim.width)
                }
            )
            .shadow(
                color: rim?.glow ?? .clear,
                radius: rim?.glow == nil ? 0 : 14)
    }
}

// MARK: - Recipe-driven send button (non-default shells)

/// SF Symbol for a composer send glyph. `default` keeps its own
/// `arrow.up.circle.fill` button and never routes through here.
func twSendSymbolName(_ glyph: ComposerSendGlyph) -> String {
    switch glyph {
    case .returnArrow: return "arrow.turn.down.left"
    case .arrowUp: return "arrow.up"
    case .runTriangle: return "play.fill"
    }
}

/// The send/stop button LABEL for non-default shells: a shaped fill + glyph
/// driven by the recipe's ComposerSendButton. The enclosing Button owns the tap.
struct ComposerRecipeSendLabel: View {
    let shell: ResolvedComposerShell
    let isRunActive: Bool
    let enabled: Bool

    var body: some View {
        let spec = shell.sendButton
        let symbol = isRunActive ? "stop.fill" : twSendSymbolName(spec.glyph)
        ZStack {
            shape
                .fill(backgroundColor)
            if spec.fill == .outline {
                shape.stroke(spec.tint, lineWidth: 1)
            }
            Image(systemName: symbol)
                .font(.system(size: max(12, spec.size * 0.42), weight: .bold))
                .foregroundStyle(glyphColor)
        }
        .frame(width: spec.size * 0.9, height: spec.size * 0.9)
        .opacity(enabled ? 1 : 0.4)
        .contentShape(Rectangle())
    }

    private var shape: AnyShape {
        switch shell.sendButton.shape {
        case .capsule: return AnyShape(Circle())
        case .rounded(let r): return AnyShape(RoundedRectangle(cornerRadius: r, style: .continuous))
        case .rect(let r): return AnyShape(RoundedRectangle(cornerRadius: r, style: .continuous))
        }
    }

    private var backgroundColor: Color {
        if isRunActive { return TWTheme.statusFailed }
        switch shell.sendButton.fill {
        case .accent: return shell.sendButton.tint
        case .neutral: return shell.palette.textPrimary  // inverse-of-surface fill
        case .outline, .plain: return .clear
        }
    }

    private var glyphColor: Color {
        if isRunActive { return .white }
        switch shell.sendButton.fill {
        case .accent: return .white
        case .neutral: return shell.sendButton.tint  // the ink rides over the fg fill
        case .outline, .plain: return shell.sendButton.tint
        }
    }
}
