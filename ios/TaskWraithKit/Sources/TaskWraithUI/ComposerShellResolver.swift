// ComposerShellResolver.swift — turns a TWComposerStyle + ComposerShellContext
// into a ResolvedComposerShell (the visual recipe). MainActor because the
// theme-derived recipes read TWTheme.* tokens. The pure STYLE-precedence and
// staleness logic lives in TaskWraithKit (twEffectiveComposerStyle); this is
// the VISUAL recipe layer (compile-checked + fixture-QA'd, not unit-tested).
// See ios/COMPOSER-SHELL-PARITY.md (Part C, E.5).

import SwiftUI
import TaskWraithKit

@MainActor
public enum ComposerShellResolver {
    /// Resolve the ready-to-render shell. Unknown styles fall back to the
    /// native default (via `renderStyle`); accessibility downgrades are baked
    /// into the result so views never branch on a11y.
    public static func resolve(
        _ style: TWComposerStyle,
        context: ComposerShellContext
    ) -> ResolvedComposerShell {
        let base = recipe(for: style.renderStyle, context: context)
        return applyAccessibility(base, context: context)
    }

    private static func recipe(
        for style: TWComposerStyle,
        context: ComposerShellContext
    ) -> ResolvedComposerShell {
        switch style {
        case .defaultShell:
            return defaultRecipe(context)
        // CS3b: per-style recipes (codex, claude, gemini, …) land here, each
        // authored from its ios/COMPOSER-SHELL-PARITY.md Part C section. Until
        // then every other known style resolves to the native default so the
        // app stays fully functional and the fixture renders end-to-end.
        default:
            var shell = defaultRecipe(context)
            shell.style = style
            return shell
        }
    }

    /// Bake accessibility downgrades into the resolved shell: Reduce
    /// Transparency turns glass solid; Reduce Motion drops the rim-chase. (High
    /// contrast hardening is applied per-recipe in CS3b/CS6.)
    private static func applyAccessibility(
        _ shell: ResolvedComposerShell,
        context: ComposerShellContext
    ) -> ResolvedComposerShell {
        var resolved = shell
        if context.reduceTransparency, resolved.material == .glass {
            resolved.material = .solid
        }
        if context.reduceMotion {
            resolved.effects.remove(.rimChase)
        }
        return resolved
    }

    // MARK: - Recipes

    /// The native "default" shell in recipe form. MUST reproduce the shipped,
    /// signed-off iOS look (frosted glass deck, 16pt radius, TWTheme tokens).
    /// Note: the shipped iOS native shell sends with `arrow.up.circle.fill`
    /// tinted by the app accent — it forged the native composer with an
    /// up-arrow rather than desktop's run-triangle. Preserved verbatim.
    private static func defaultRecipe(_ context: ComposerShellContext) -> ResolvedComposerShell {
        ResolvedComposerShell(
            style: .defaultShell,
            material: .glass,
            palette: ComposerShellPalette(
                surfaceFill: TWTheme.composerBg,
                innerModuleFill: nil,
                border: TWTheme.border,
                focusAccent: TWTheme.chroma1,
                textPrimary: TWTheme.textPrimary,
                placeholder: TWTheme.textTertiary,
                rim: nil),
            geometry: ComposerShellGeometry(
                surfaceCornerRadius: 16,
                innerCornerRadius: 12,
                controlShape: .capsule,
                rowSpacing: 0),
            fontDesign: .system,
            sendButton: ComposerSendButton(
                glyph: .arrowUp, shape: .capsule, size: 40, fill: .accent,
                tint: TWTheme.chroma1),
            rowPolicy: .mergedInstrument,
            effects: [],
            themeImmune: false)
    }
}
