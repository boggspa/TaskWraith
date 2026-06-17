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

/// SwiftUI font for a shell's font design (monospaced = terminal, serif = stub).
func twComposerFont(_ design: ComposerShellFontDesign, _ style: Font.TextStyle = .body) -> Font {
    switch design {
    case .system: return .system(style)
    case .monospaced: return .system(style, design: .monospaced)
    case .serif: return .system(style, design: .serif)
    }
}

/// Background shape for a shell's control silhouette (capsule / rounded / rect).
func twControlShape(_ shape: ComposerControlShape) -> AnyShape {
    switch shape {
    case .capsule: return AnyShape(Capsule())
    case .rounded(let radius): return AnyShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
    case .rect(let radius): return AnyShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
    }
}

extension View {
    /// Apply a resolved composer shell's surface chrome.
    func composerShell(_ resolved: ResolvedComposerShell) -> some View {
        modifier(ComposerShellContainerModifier(resolved: resolved))
    }

    /// Apply the shell surface only when `apply` is true (CS10 detached rows:
    /// each above-row + the composer core get their OWN surface, so the detached
    /// path applies it per card while the merged path applies it once to the
    /// whole stack). `false` returns the view UNTOUCHED — so the merged/default
    /// layout stays byte-identical.
    @ViewBuilder
    func composerShellIf(_ apply: Bool, _ resolved: ResolvedComposerShell) -> some View {
        if apply {
            composerShell(resolved)
        } else {
            self
        }
    }

    /// CS12d — apply the shell surface UNLESS the shell owns its surface at the
    /// INPUT level (claude/gemini/cursor/obsidian/alabaster). Those shells let the
    /// Composer shell its own input internally, so an outer wrap here would
    /// double-chrome and box the bare footer. Used by the welcome + mini side-chat
    /// composer hosts (the main composerShellStack gates this inline).
    @ViewBuilder
    func composerShellUnlessInputOwns(_ resolved: ResolvedComposerShell) -> some View {
        if resolved.layout.inputOwnsSurface {
            self
        } else {
            composerShell(resolved)
        }
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
        let effects = resolved.effects
        return content
            .background(
                ZStack {
                    shape.fill(resolved.palette.surfaceFill)
                    if effects.contains(.paperGrain) {
                        ComposerPaperGrain()  // stub: faint 135° hatch over the cream fill
                    }
                    if effects.contains(.perforation) {
                        ComposerPerforation(color: resolved.palette.border)  // stub ticket tear
                    }
                }
            )
            .compositingGroup()
            .mask(shape)
            .overlay(shape.strokeBorder(resolved.palette.border, lineWidth: 1))
            .overlay(
                rim.map { rim in
                    shape.inset(by: 0.5).strokeBorder(rim.color, lineWidth: rim.width)
                }
            )
            // Animated rim-shimmer (obsidian/alabaster). applyAccessibility drops
            // .rimChase under Reduce Motion, so the static rim above is the fallback.
            .overlay(
                effects.contains(.rimChase)
                    ? ComposerRimChase(
                        color: rim?.color ?? resolved.palette.border,
                        cornerRadius: resolved.geometry.surfaceCornerRadius,
                        lineWidth: rim?.width ?? 2)
                    : nil
            )
            .shadow(
                color: rim?.glow ?? .clear,
                radius: rim?.glow == nil ? 0 : 14)
    }
}

/// 16s conic rim-shimmer that sweeps the surface edge (obsidian/alabaster).
private struct ComposerRimChase: View {
    let color: Color
    let cornerRadius: CGFloat
    let lineWidth: CGFloat

    var body: some View {
        TimelineView(.animation) { timeline in
            let seconds = timeline.date.timeIntervalSinceReferenceDate
            let fraction = seconds.truncatingRemainder(dividingBy: 16) / 16
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .strokeBorder(
                    AngularGradient(
                        gradient: Gradient(colors: [
                            color.opacity(0), color.opacity(0.06), color,
                            color.opacity(0.06), color.opacity(0),
                        ]),
                        center: .center,
                        angle: .degrees(fraction * 360)),
                    lineWidth: lineWidth)
        }
        .allowsHitTesting(false)
    }
}

/// Faint diagonal hatch approximating the stub's 135° paper grain.
private struct ComposerPaperGrain: View {
    var body: some View {
        Canvas { ctx, size in
            let spacing: CGFloat = 6
            var x: CGFloat = -size.height
            while x < size.width {
                var path = Path()
                path.move(to: CGPoint(x: x, y: 0))
                path.addLine(to: CGPoint(x: x + size.height, y: size.height))
                ctx.stroke(path, with: .color(.black.opacity(0.03)), lineWidth: 0.5)
                x += spacing
            }
        }
        .allowsHitTesting(false)
    }
}

/// The stub's dashed perforation tear, ~44pt below the top edge.
private struct ComposerPerforation: View {
    let color: Color

    var body: some View {
        VStack(spacing: 0) {
            Spacer().frame(height: 44)
            ComposerDashedLine()
                .stroke(color, style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
                .frame(height: 1)
            Spacer(minLength: 0)
        }
        .allowsHitTesting(false)
    }
}

private struct ComposerDashedLine: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: 0, y: rect.midY))
        path.addLine(to: CGPoint(x: rect.width, y: rect.midY))
        return path
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
        // A recipe may state its own glyph ink (e.g. stub's #2a1d05 on gold);
        // otherwise derive from fill (.accent -> white, else the tint).
        if let glyphTint = shell.sendButton.glyphTint { return glyphTint }
        switch shell.sendButton.fill {
        case .accent: return .white
        case .neutral: return shell.sendButton.tint  // the ink rides over the fg fill
        case .outline, .plain: return shell.sendButton.tint
        }
    }
}
