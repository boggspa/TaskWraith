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
        case .defaultShell: return defaultRecipe(context)
        case .codex: return codexRecipe(context)
        case .claude: return claudeRecipe(context)
        case .cursor: return cursorRecipe(context)
        case .grok: return grokRecipe(context)
        case .gemini: return geminiRecipe(context)
        case .kimi: return kimiRecipe(context)
        case .modular: return modularRecipe(context)
        case .terminal: return terminalRecipe(context)
        case .stub: return stubRecipe(context)
        case .satellite: return satelliteRecipe(context)
        case .obsidian: return obsidianRecipe(context)
        case .alabaster: return alabasterRecipe(context)
        case .unknown:
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

    /// Codex provider shell — recipe form of COMPOSER-SHELL-PARITY.md Part C
    /// "codex". Two-surface dark "card-in-card": a SOLID near-black outer
    /// surface (#212121, r22) holding a distinct slightly-lighter inner module
    /// (#252525, top corners echo the shell, bottom corners tuck tighter) with
    /// every control reduced to a floating satellite text-token. The hallmark
    /// is a solid near-white send circle carrying a dark up-arrow.
    ///
    /// Theme behavior is HYBRID, so this recipe is themeImmune: dark contexts
    /// LOCK the codex palette (#212121 / #252525, border forced transparent
    /// even on focus, outer rim removed); the light family (light/mist/sage)
    /// THEME-DERIVES from surface-2/surface-border/surface-text — reproduced
    /// here with the canonical light-theme literals chosen via appIsLight.
    /// Evidence: 07-composer-shells.css:22-45 (surfaces + radii), :60-73
    /// (focus, rim removed), :323-350 (send light circle 32px, glyph #0d0d0d),
    /// 08-theme-picker-overrides.css:3971-4047 (light derive),
    /// App.tsx:18185-18186 (float above), :20677-20684 (ArrowUpSendIcon).
    private static func codexRecipe(_ context: ComposerShellContext) -> ResolvedComposerShell {
        // Outer surface: dark #212121 (07:26) / light derives to surface-2.
        let surfaceFill = context.appIsLight
            ? Color(hex: 0xEFEFF2)   // light --surface-2 (Theme.swift .light surface2)
            : Color(hex: 0x212121)   // 07-composer-shells.css:26 locked outer
        // Distinct card-in-card module: dark #252525 (07:40). Light themes drop
        // the fill delta to surface-2 as well (controls float on the surface).
        let innerModuleFill = context.appIsLight
            ? Color(hex: 0xEFEFF2)   // light --surface-2
            : Color(hex: 0x252525)   // 07-composer-shells.css:40 inner module
        // Border forced transparent in dark incl :focus-within (07:64-73);
        // light themes carry the surface hairline.
        let border = context.appIsLight
            ? Color.black.opacity(0.10)  // light --surface-border
            : Color.clear                // dark: 1px solid transparent (locked)
        // Dark: focus only deepens the drop shadow, border stays transparent →
        // no focus accent ring. Light: focus border color-mix(--surface-border
        // 44%, --surface-text 18%) ≈ a faint dark hairline.
        let focusAccent = context.appIsLight
            ? Color.black.opacity(0.22)  // light focus hairline approximation
            : Color.clear                // dark: no border accent on focus
        // Model token text color-mix(#ffffff 88%) dark / --surface-text light.
        let textPrimary = context.appIsLight
            ? Color.black.opacity(0.88)  // light --surface-text
            : Color.white.opacity(0.88)  // 07: color-mix(#ffffff 88%, transparent)
        // Placeholder color-mix(#ffffff 38%) dark / --text-tertiary light.
        let placeholder = context.appIsLight
            ? Color.black.opacity(0.38)  // light --text-tertiary
            : Color.white.opacity(0.38)  // 07: color-mix(#ffffff 38%, transparent)

        return ResolvedComposerShell(
            style: .codex,
            // Solid, opaque — NOT glass; no backdrop-filter (07:26/07:40).
            material: .solid,
            palette: ComposerShellPalette(
                surfaceFill: surfaceFill,
                // Distinct card-in-card panel → set innerModuleFill (#252525).
                innerModuleFill: innerModuleFill,
                border: border,
                focusAccent: focusAccent,
                textPrimary: textPrimary,
                placeholder: placeholder,
                // Outer rim REMOVED (07:60-73) — resting look is a drop shadow
                // only, which the view supplies; no inset rim ring here.
                rim: nil),
            geometry: ComposerShellGeometry(
                surfaceCornerRadius: 22,   // 07:22 outer r22
                // Inner module is 21/21/14/14; the contract carries a single
                // scalar, so use the dominant top radius that echoes the shell.
                innerCornerRadius: 21,     // 07:30 inner top corners
                // Controls are mixed (r6 tokens / r999 pills); the prevailing
                // satellite token silhouette is r6.
                controlShape: .rounded(6),
                rowSpacing: 0),
            fontDesign: .system,           // system sans (no mono/serif)
            sendButton: ComposerSendButton(
                glyph: .arrowUp,           // ArrowUpSendIcon (App.tsx:20677-20684)
                shape: .capsule,           // circle r999
                size: 32,                  // 32×32 (07:323-350)
                // Inverse-of-surface: a near-white circle on the dark shell.
                fill: .neutral,
                // Glyph color #0d0d0d (07: dark up-arrow on the light circle).
                tint: Color(hex: 0x0D0D0D)),
            // Above-bar git/Create-PR + secondary-workspace rows float above the
            // merged stack as detached pills (App.tsx:18185-18186).
            rowPolicy: .floatAbove,
            // Defining structural effect is the two-surface card-in-card split.
            // The ▾ caret chips are desktop ::after CSS only → skipped on iOS.
            effects: [.twoSurfaceSplit],
            // Hybrid theme behavior: locks its own dark palette, hand-derives
            // the light family above → NOT theme-immune (the contract reserves it for the fully-locked set: grok/cursor/terminal/obsidian/alabaster).
            themeImmune: false)
    }

    /// Claude — whisper-quiet near-monochrome dark shell mimicking Claude Code's
    /// terminal composer. The desktop strips the OUTER `.composer-surface` to
    /// transparent and re-homes all chrome onto the textarea BUBBLE, so the
    /// rendered surface here IS the bubble. THEME-IMMUNE: white-on-#1e1e1e
    /// literals in dark, with a single light flip to #f0f0f3. Authored from the
    /// 08-theme-picker-overrides.css claude layer (the last-writer over 07).
    /// See ios/COMPOSER-SHELL-PARITY.md (Part C → "claude — Claude").
    private static func claudeRecipe(_ context: ComposerShellContext) -> ResolvedComposerShell {
        let isLight = context.appIsLight

        // Bubble fill — `.composer-textarea` background. 08:7801-7809 overrides
        // 07's #151515 by source order → #1e1e1e (dark) / #f0f0f3 (light).
        let surfaceFill = isLight
            ? Color(hex: 0xF0F0F3)   // 08:7806-7809 light/mist/sage bubble
            : Color(hex: 0x1E1E1E)   // 08:7801-7804 dark bubble (!important)

        // Bubble border — 08:7803 rgba(255,255,255,0.18) dark /
        // rgba(0,0,0,0.14) light (corrected from white 10%).
        let border = isLight
            ? Color.black.opacity(0.14)
            : Color.white.opacity(0.18)

        // Focus-within bubble border — 08:7811-7817 rgba(255,255,255,0.30)
        // (corrected: 30%, not 26%). Light themes mirror as black 0.30.
        let focusAccent = isLight
            ? Color.black.opacity(0.30)
            : Color.white.opacity(0.30)

        // Satellite text-token color — model/provider/workspace/run-glyph use
        // color-mix(#ffffff 70%). Light themes recolor toward var(--text-primary).
        let textPrimary = isLight
            ? Color.black.opacity(0.88)   // light bubble text (≈ --text-primary)
            : Color.white.opacity(0.70)   // dark color-mix(#ffffff 70%)

        // Placeholder — color-mix(#ffffff 30%, transparent); NOT italic.
        let placeholder = isLight
            ? Color.black.opacity(0.30)
            : Color.white.opacity(0.30)

        // Send glyph tint — squared return button glyph color-mix(#ffffff 58%).
        // (The warm #ffb36c orange is the RUN glyph only, not the send button.)
        let sendTint = isLight
            ? Color.black.opacity(0.58)
            : Color.white.opacity(0.58)

        return ResolvedComposerShell(
            style: .claude,
            // Opaque bubble (#1e1e1e !important); surface backdrop-filter stripped.
            material: .solid,
            palette: ComposerShellPalette(
                surfaceFill: surfaceFill,
                // Footer chrome is force-transparent !important — no card-in-card.
                innerModuleFill: nil,
                border: border,
                focusAccent: focusAccent,
                textPrimary: textPrimary,
                placeholder: placeholder,
                // Bubble carries only a drop shadow (0 4px 20px rgba(0,0,0,0.32)),
                // not an inset rim — the visible ring is `border` above.
                rim: nil),
            geometry: ComposerShellGeometry(
                // `.composer-textarea` border-radius 14px (08/07).
                surfaceCornerRadius: 14,
                // No inner module — footer chrome forced transparent.
                innerCornerRadius: 0,
                // Squared radius-md (8px) silhouette — the hallmark squared send
                // button + the contained permission button (08:7900-7906).
                controlShape: .rect(8),
                // Surface padding 4px 12px 8px (07:3322-3360 re-home).
                surfacePadding: EdgeInsets(top: 4, leading: 12, bottom: 8, trailing: 12),
                // Above-bar stack gap 10px.
                rowSpacing: 10),
            // Typography is System sans (NOT mono) despite the terminal essence.
            fontDesign: .system,
            sendButton: ComposerSendButton(
                glyph: .returnArrow,         // ClaudeReturnSymbolIcon (AppChromeSymbols.tsx:418-434)
                shape: .rect(8),             // 28×28, border-radius 8px (squared)
                size: 28,
                fill: .plain,                // bg transparent, border 0
                tint: sendTint),             // glyph color-mix(#ffffff 58%)
            // Above-bar git/branch/ensemble rows sit inside the stack as a matched
            // dark header band (per-row aura fan-out) — NOT detached float / merge.
            rowPolicy: .insideStack,
            // No paper/perforation/caret/two-surface/rim-chase. Per-row agent-aura
            // has no dedicated effect flag in the contract; surface stays opaque so
            // `.transparentChrome` does not apply.
            effects: [],
            // White-on-#1e1e1e literals (and the #f0f0f3 light flip) lock the
            // palette regardless of app theme.
            themeImmune: true)
    }

    /// Cursor — a deliberately chroma-free flat neutral-GRAY shell (desktop
    /// 10-provider-shell-overrides.css:2067-2120). THEME-IMMUNE in both
    /// directions like Obsidian/Alabaster, but it locks to GRAY and flips
    /// gray-on-dark vs dark-on-gray (never a chroma). The filled capsule is the
    /// only opaque module; git/Create-PR rows float ABOVE the merged stack as
    /// detached pills (rowPolicy .floatAbove, shared with codex). Send is a flat
    /// neutral circle: fg-fill, bg-colored arrow-up. At rest there is no outer
    /// glow (the desktop activity aura on the merged stack has no contract slot
    /// here, so effects stay empty).
    private static func cursorRecipe(_ context: ComposerShellContext) -> ResolvedComposerShell {
        // Theme-immune: pick the locked gray palette by app theme, never TWTheme.
        // Dark tokens (10:2067-2087): --cursor-shell-bg #1f1f1f,
        // --cursor-shell-surface #2a2a2a, --cursor-shell-fg #d8d8d8,
        // --cursor-shell-faint rgba(216,216,216,0.38),
        // --cursor-shell-border rgba(216,216,216,0.16),
        // --cursor-shell-border-strong rgba(216,216,216,0.42),
        // --cursor-shell-rim rgba(216,216,216,0.22).
        // Light flip: bg #ededed, surface #f4f4f4, fg #2e2e2e,
        // faint rgba(46,46,46,0.4), border rgba(46,46,46,0.16),
        // border-strong rgba(46,46,46,0.4), rim rgba(46,46,46,0.14).
        let isLight = context.appIsLight

        let surfaceFill = isLight
            ? Color(hex: 0xF4F4F4)   // --cursor-shell-surface (capsule, light)
            : Color(hex: 0x2A2A2A)   // --cursor-shell-surface (capsule, dark)
        let textPrimary = isLight
            ? Color(hex: 0x2E2E2E)   // --cursor-shell-fg (light)
            : Color(hex: 0xD8D8D8)   // --cursor-shell-fg (dark)
        // --cursor-shell-faint
        let placeholder = isLight
            ? Color(red: 46/255, green: 46/255, blue: 46/255, opacity: 0.40)
            : Color(red: 216/255, green: 216/255, blue: 216/255, opacity: 0.38)
        // --cursor-shell-border (hairline)
        let border = isLight
            ? Color(red: 46/255, green: 46/255, blue: 46/255, opacity: 0.16)
            : Color(red: 216/255, green: 216/255, blue: 216/255, opacity: 0.16)
        // No chroma focus accent — focus snaps the capsule border to
        // --cursor-shell-rim-strong (dark 0.42 / light 0.30); use it as the
        // resolved focusAccent so the focused border reads gray, not a hue.
        let focusAccent = isLight
            ? Color(red: 46/255, green: 46/255, blue: 46/255, opacity: 0.30)
            : Color(red: 216/255, green: 216/255, blue: 216/255, opacity: 0.42)
        // Flat top-edge lip on the capsule: inset 0 1px 0 --cursor-shell-rim
        // (dark rgba(216,216,216,0.22) / light rgba(46,46,46,0.14)). No glow.
        let rimColor = isLight
            ? Color(red: 46/255, green: 46/255, blue: 46/255, opacity: 0.14)
            : Color(red: 216/255, green: 216/255, blue: 216/255, opacity: 0.22)

        // Send = 32px flat neutral circle (999px). Fill = --cursor-shell-fg,
        // arrow-up glyph painted in --cursor-shell-bg (#1f1f1f / #ededed). The
        // tint carries the fill color; the view inverts the glyph for .neutral.
        let sendFill = textPrimary   // --cursor-shell-fg

        return ResolvedComposerShell(
            style: .cursor,
            material: .solid,        // flat solid gray, no glass/gradient/chroma
            palette: ComposerShellPalette(
                surfaceFill: surfaceFill,
                innerModuleFill: nil,    // the filled capsule IS the module; no card-in-card
                border: border,
                focusAccent: focusAccent,
                textPrimary: textPrimary,
                placeholder: placeholder,
                rim: ComposerShellRim(color: rimColor, width: 1, glow: nil)),
            geometry: ComposerShellGeometry(
                // Merged stack radius --cursor-shell-stack-radius 14px is the
                // outer surface; capsule radius --cursor-shell-capsule-radius
                // 26px is the inner typing module.
                surfaceCornerRadius: 14,
                innerCornerRadius: 26,
                controlShape: .capsule,
                rowSpacing: 6),          // surface flex column gap 6px
            fontDesign: .system,         // system sans, no mono/serif
            sendButton: ComposerSendButton(
                glyph: .arrowUp,
                shape: .capsule,         // 999px → circle at 32px
                size: 32,
                fill: .neutral,          // inverse-of-surface (gray fg fill, bg glyph)
                tint: sendFill),
            rowPolicy: .floatAbove,      // git/Create-PR rows detached above the stack
            effects: [],                 // no rimChase/grain/etc. at rest
            themeImmune: true)
    }

    private static func grokRecipe(_ context: ComposerShellContext) -> ResolvedComposerShell {
        // grok is THEME-IMMUNE and BIDIRECTIONAL: it locks a monochrome palette and
        // flips light vs dark off the APP theme (not the provider). Desktop tokens:
        // 10-provider-shell-overrides.css:1371-1415 (--grok-* dark/light/system),
        // :1546-1572 (surface 24px + top rim + transparent textarea),
        // :1724-1755 (send 32px inverse circle). No glass, no chroma, no gradients.
        let isLight = context.appIsLight

        // Surface fill: --grok-surface  #111111 dark / #f7f7f7 light.
        let surfaceFill = isLight ? Color(hex: 0xF7F7F7) : Color(hex: 0x111111)

        // Foreground / ink: --grok-fg  #ffffff dark / #000000 light.
        let fg = isLight ? Color(hex: 0x000000) : Color(hex: 0xFFFFFF)

        // Strong structural border: --grok-border-strong
        //   rgba(255,255,255,.5) dark / rgba(0,0,0,.42) light (on surface + rows).
        // High-contrast hardens it toward full opacity (a11y note: raise
        // --grok-border-strong, keep the rim).
        let borderBase = isLight ? Color(hex: 0x000000) : Color(hex: 0xFFFFFF)
        let borderAlpha: Double = context.highContrast ? (isLight ? 0.85 : 1.0) : (isLight ? 0.42 : 0.5)
        let border = borderBase.opacity(borderAlpha)

        // Focus accent: --grok-rim-strong = full-opacity white (dark) / #ffffff (light).
        // On focus-within the surface border AND top rim go full-opacity white.
        let focusAccent = Color(hex: 0xFFFFFF)

        // Placeholder: --grok-faint  rgba(255,255,255,.34) / rgba(0,0,0,.34). Not italic.
        let placeholder = (isLight ? Color(hex: 0x000000) : Color(hex: 0xFFFFFF)).opacity(0.34)

        // Signature TOP-EDGE INNER RIM: inset 0 1px 0 --grok-rim
        //   rgba(255,255,255,.78) dark / rgba(255,255,255,.95) light. Rim stays
        //   white-ish in BOTH modes; no outer glow, no colored shadow.
        let rim = ComposerShellRim(
            color: Color(hex: 0xFFFFFF).opacity(isLight ? 0.95 : 0.78),
            width: 1,
            glow: nil)

        // Send button: 32x32px circle (999px), run fill --grok-fg (white D / black L),
        //   glyph --grok-bg (inverse: #000 D / #fff L), border 0, no shadow.
        //   .neutral = inverse-of-surface fill; tint carries the glyph color.
        let sendGlyphInk = isLight ? Color(hex: 0xFFFFFF) : Color(hex: 0x000000) // --grok-bg

        return ResolvedComposerShell(
            style: .grok,
            material: .solid, // flat, NO glass/backdrop-filter anywhere
            palette: ComposerShellPalette(
                surfaceFill: surfaceFill,
                innerModuleFill: nil, // .composer-chips display:none; textarea sits transparent on the surface
                border: border,
                focusAccent: focusAccent,
                textPrimary: fg, // --grok-fg
                placeholder: placeholder,
                rim: rim),
            geometry: ComposerShellGeometry(
                surfaceCornerRadius: 24, // --grok surface radius 24px
                innerCornerRadius: 0, // no card-in-card panel
                // Controls are bare floating labels with an 8px hit-area radius
                // (transparent, border 0); ensemble-mode is the lone outline capsule.
                controlShape: .rounded(8),
                // surface padding 14px 18px 8px; control row gap 6px.
                surfacePadding: EdgeInsets(top: 14, leading: 18, bottom: 8, trailing: 18),
                rowSpacing: 6),
            fontDesign: .system, // System sans (NOT mono, despite the look)
            sendButton: ComposerSendButton(
                glyph: .arrowUp, // ArrowUpSendIcon (App.tsx:20675-20685)
                shape: .capsule, // 999px circle
                size: 32, // 32x32
                fill: .neutral, // inverse-of-surface (filled with --grok-fg)
                tint: sendGlyphInk), // glyph drawn in --grok-bg
            // Above-row "tucked tab": solo above-row IS the tucked tab; multi-row
            // collapses into a merged frame (the :has(>:nth-child(2)) switch).
            rowPolicy: .tuckedTab,
            effects: [], // top rim is carried by palette.rim; aura suppressed, no bespoke chrome
            themeImmune: true) // locks monochrome regardless of provider/app theme
    }

    private static func geminiRecipe(_ context: ComposerShellContext) -> ResolvedComposerShell {
        // Gemini is theme-IMMUNE at the capsule level: it locks a deep-navy
        // capsule by default and obsidian/alabaster intentionally keep that
        // navy chrome. Only the explicit light family (light/mist/sage/
        // alabaster) repaints the capsule near-white. We pick light vs dark
        // off context.appIsLight and lock our own hexes. (Part C: gemini,
        // 07-composer-shells.css:2131-2210; 08-theme-picker-overrides:4408-4425.)
        let isLight = context.appIsLight

        // CAPSULE fill — the only filled surface. Desktop uses a vertical
        // gradient; we lock the top stop as a single solid Color.
        //   dark  linear-gradient(180deg,#141d30 0%,#0d1320 100%)  → #141D30
        //   light linear-gradient(180deg,#ffffff 0%,#eef3ff 100%)  → #FFFFFF
        let capsuleFill = isLight ? Color(hex: 0xFFFFFF) : Color(hex: 0x141D30)

        // Signature Gemini blue — focus accent + border tint, both themes.
        let geminiBlue = Color(hex: 0x5A8CFF)  // #5a8cff

        // Capsule border: dark color-mix(#5a8cff 22%, transparent);
        // light  color-mix(#5a8cff 30%, --surface-border). Encode as the blue
        // at the documented mix percentage.
        let capsuleBorder = isLight
            ? geminiBlue.opacity(0.30)   // color-mix(#5a8cff 30%)
            : geminiBlue.opacity(0.22)   // color-mix(#5a8cff 22%, transparent)

        // Text + placeholder.
        //   dark  text white; placeholder color-mix(#ffffff 38%)
        //   light text #1d1d1f (--surface-text); placeholder color-mix(#1d1d1f 42%)
        let textPrimary = isLight
            ? Color(hex: 0x1D1D1F)        // --surface-text
            : Color(hex: 0xFFFFFF)
        let placeholder = isLight
            ? Color(hex: 0x1D1D1F).opacity(0.42)
            : Color(hex: 0xFFFFFF).opacity(0.38)

        // Capsule rim/glow: rest box-shadow 0 6px 30px rgba(0,0,0,0.42); on
        // focus the signature blue halo (4px color-mix(#5a8cff 12%) ring +
        // border → color-mix(#5a8cff 58%)). We carry the rest border as the
        // ring color and the blue-12% wash as the focus glow.
        let capsuleRim = ComposerShellRim(
            color: capsuleBorder,
            width: 1,
            glow: geminiBlue.opacity(0.12))  // focus ring color-mix(#5a8cff 12%)

        // Send button: near-white circle 32×32 (999px), glyph #0e1218, flat
        // (no border / no box-shadow). fill .neutral = inverse-of-surface; the
        // dark glyph rides as the tint over the white circle.
        //   circle bg color-mix(#ffffff 90%); glyph #0e1218 (07:2480-2545).
        let sendGlyphInk = Color(hex: 0x0E1218)  // #0e1218

        return ResolvedComposerShell(
            style: .gemini,
            material: .solid,  // opaque capsule, NO backdrop-filter → reduce-transparency is a no-op
            palette: ComposerShellPalette(
                surfaceFill: capsuleFill,   // the navy/near-white CAPSULE; outer surface is transparent
                innerModuleFill: nil,       // n/a — the capsule is the only filled surface
                border: capsuleBorder,
                focusAccent: geminiBlue,    // #5a8cff focus border → color-mix(#5a8cff 58%)
                textPrimary: textPrimary,
                placeholder: placeholder,
                rim: capsuleRim),
            geometry: ComposerShellGeometry(
                surfaceCornerRadius: 0,     // OUTER .composer-surface radius 0 (fully transparent)
                innerCornerRadius: 26,      // single rounded CAPSULE = 26px (07:2188-2210)
                controlShape: .capsule,     // every chip/control is a 999px pill
                rowSpacing: 6),             // surface flex column gap 6px
            fontDesign: .system,            // sans, no italic/tabular/letter-spacing
            sendButton: ComposerSendButton(
                glyph: .arrowUp,            // authoritative (App.tsx:20677-20682 ArrowUpSendIcon)
                shape: .capsule,            // 999px circle
                size: 32,                   // 32×32px
                fill: .neutral,             // inverse-of-surface near-white circle (color-mix(#ffffff 90%))
                tint: sendGlyphInk),        // #0e1218 dark up-arrow on the white circle
            rowPolicy: .insideStack,         // detached-pill family: controls anchor-lifted, per-row aura, no :has() gating
            effects: [.twoSurfaceSplit, .transparentChrome],  // transparent outer + filled capsule; outer ::before killed, children float/anchor
            themeImmune: true)              // locks navy by default; obsidian+alabaster keep navy
    }

    private static func kimiRecipe(_ context: ComposerShellContext) -> ResolvedComposerShell {
        // kimi — Kimi. Single SOLID near-black rounded rectangle (no glass, no
        // card-in-card) with a green-yellow/olive accent that surfaces only on
        // focus. Theme-immune at core: hardcodes #0a0a0c surface, #ffffff/8%
        // border, #ffffff/36% placeholder, #a9bd55 accent regardless of theme.
        // Light family (light/mist/sage/alabaster) re-keys to a soft cream surface
        // and the darker olive #84a33b. See COMPOSER-SHELL-PARITY.md (Part C, kimi)
        // / desktop 07-composer-shells.css:2553-2759.
        let isLight = context.appIsLight

        // surfaceFill — dark: color-mix(#0a0a0c 96%, transparent) ≈ rgba(10,10,12,0.96)
        //               (07:2577). light: var(--unified-soft-surface-bg) → soft cream.
        let surfaceFill = isLight
            ? TWTheme.surface2   // light: unified-soft surface (alabaster surface-2 cream)
            : Color(hex: 0x0A0A0C).opacity(0.96)   // dark: #0a0a0c @ 96%

        // border — dark: color-mix(#ffffff 8%) ≈ rgba(255,255,255,0.08).
        //          light: var(--unified-soft-surface-border) (07:2574-2593).
        let border = isLight
            ? TWTheme.border            // light: soft-surface hairline
            : Color.white.opacity(0.08)            // dark: #ffffff @ 8%

        // focusAccent — dark olive #a9bd55; light darker olive #84a33b. Signature
        // accent surfaces only on focus (border color-mix 50% + 3px 10% ring).
        let focusAccent = isLight
            ? Color(hex: 0x84A33B)                 // light: darker olive
            : Color(hex: 0xA9BD55)                 // dark: green-yellow olive

        // textPrimary — dark: model #ffffff 88%; light: var(--text-primary).
        let textPrimary = isLight
            ? TWTheme.textPrimary            // light: --text-primary
            : Color.white.opacity(0.88)            // dark: #ffffff @ 88%

        // placeholder — dark: color-mix(#ffffff 36%) ≈ rgba(255,255,255,0.36);
        //               light: var(--text-tertiary). NOT italic.
        let placeholder = isLight
            ? TWTheme.textTertiary            // light: --text-tertiary
            : Color.white.opacity(0.36)            // dark: #ffffff @ 36%

        // Send button glyph color (#ffffff on the neutral white/18% fill in dark;
        // the light/alabaster run-btn flips to olive-on-cream with glyph #34410f).
        let sendTint = isLight
            ? Color(hex: 0x34410F)                 // light: olive chip text on cream run-btn
            : Color(hex: 0xFFFFFF)                 // dark: #ffffff glyph

        return ResolvedComposerShell(
            style: .kimi,
            material: .solid,                       // opaque, NO glass / backdrop-filter ever
            palette: ComposerShellPalette(
                surfaceFill: surfaceFill,
                innerModuleFill: nil,               // no card-in-card; textarea sits directly on the surface
                border: border,
                focusAccent: focusAccent,
                textPrimary: textPrimary,
                placeholder: placeholder,
                rim: nil),                          // no rest rim (rest shadow only; focus adds the olive ring)
            geometry: ComposerShellGeometry(
                surfaceCornerRadius: 18,            // surface 18px (above-bar 18px)
                innerCornerRadius: 18,              // no distinct inner module; mirror the surface radius
                controlShape: .capsule,             // provider/workspace/model/ensemble pills are 999px capsules
                rowSpacing: 0),
            fontDesign: .system,                    // sans (NOT mono/serif)
            sendButton: ComposerSendButton(
                glyph: .arrowUp,                    // ArrowUpSendIcon (App.tsx:20681-20682)
                shape: .capsule,                    // 32px filled circle (999px)
                size: 32,                           // 07:2740-2759
                fill: .neutral,                     // dark: color-mix(#ffffff 18%) ≈ rgba(255,255,255,0.18) (hover→olive, ignored on iOS)
                tint: sendTint),
            rowPolicy: .insideStack,                // shared above-bar-stack; rows are sibling cards matching the surface (no tucked-tab / merged-instrument)
            effects: [],                            // surface/above-bar ::before suppressed; aura suppressed; no paper/perforation/caret/two-surface split
            themeImmune: false)                      // locks its own olive palette regardless of app theme
    }

    /// Modular — "deletes the composer container." The surface goes fully
    /// transparent/borderless/shadowless and every element re-materializes as
    /// its own free-standing pill (desktop 08:4817-4906). The textarea becomes a
    /// distinct 18px-radius card; every chip/picker a 999px capsule; send an
    /// accent-filled 999px capsule. backdrop-filter is stripped on the surface
    /// (08:6669-6670) so the transparent container reads see-through.
    ///
    /// THEME-DERIVED, not immune (08:4831-4906): pills draw from
    /// `--composer-bg-solid` (the lifted deck ≈ TWTheme.surface2, used at 88%),
    /// `--panel-border` (≈ TWTheme.border, at 82%), and `--accent`
    /// (TWTheme.chroma1). Light themes (light/mist/sage) swap pill fill to the
    /// soft-surface tokens and soften shadows — both branches resolve to the same
    /// TWTheme.* tokens here, so a single theme-derived recipe covers both.
    private static func modularRecipe(_ context: ComposerShellContext) -> ResolvedComposerShell {
        // The free-standing textarea pill: fill = composer-bg-solid 88%
        // (08:4831), hairline = panel-border 82% (08:4831). We approximate the
        // 88% body fill with the lifted-deck token surface2 (the desktop's
        // composer-bg-solid family) and the 82% hairline with TWTheme.border.
        // The textarea's per-pill drop shadow (dark `0 4px 18px rgba(0,0,0,.18)`,
        // light `0 2px 8px rgba(0,0,0,.05)`, 08:4904/09:1764) is carried as the
        // pill rim's soft glow so the card lifts off the transparent page.
        let pillFill = TWTheme.surface2          // --composer-bg-solid (88% body)
        let pillBorder = TWTheme.border          // color-mix(--panel-border 82%, transparent)
        let accent = TWTheme.chroma1             // --accent (focus ring + send fill)

        return ResolvedComposerShell(
            style: .modular,
            material: .transparent,              // container transparent !important (08:4817)
            palette: ComposerShellPalette(
                surfaceFill: .clear,             // surface fully transparent/borderless
                // The textarea IS the inner module — its own 18px card on the
                // page (composer-bg-solid 88% fill). nil would sit it on the
                // (transparent) surface; modular wants the distinct pill.
                innerModuleFill: pillFill,
                border: pillBorder,              // per-pill 1px hairline (container has none)
                // Focus = border color-mix(--accent 48%, --panel-border) +
                // `0 0 0 3px color-mix(--accent 14%)` ring (08:4831 / Effects).
                focusAccent: accent,
                textPrimary: TWTheme.textPrimary,   // var(--text-primary); light forces #4a-ink via token
                placeholder: TWTheme.textTertiary,  // inherited from base (no modular override)
                // The textarea pill's drop shadow, expressed as an inset rim +
                // accent glow so the floating card and its focus ring read.
                rim: ComposerShellRim(
                    color: pillBorder,
                    width: 1,
                    glow: accent.opacity(0.14))),   // color-mix(--accent 14%, transparent) focus ring
            geometry: ComposerShellGeometry(
                // Surface is shapeless/transparent (padding 6px 0 4px on desktop);
                // all visual radius lives on the children.
                surfaceCornerRadius: 0,
                innerCornerRadius: 18,           // textarea card radius (08:4831, padding 14/16 + top 44)
                controlShape: .capsule,          // every chip/picker is a 999px capsule (08:4817-4906)
                rowSpacing: 8),                  // above-bar pure flex gap:8px (footer 6px)
            fontDesign: .system,                 // inherits app default sans — no override
            sendButton: ComposerSendButton(
                glyph: .runTriangle,             // RunSymbolIcon (App.tsx:20675-20685)
                shape: .capsule,                 // r999 accent capsule (08:4831 / base 03:6324)
                size: 40,                        // 40×40 base
                fill: .accent,                   // color-mix(--accent 86%, transparent) filled capsule
                tint: accent),                   // var(--accent) — send capsule accent
            // Inside-stack-dissolved family: the stack wrapper paints nothing
            // (stack aura suppressed, 05:3030/3087) and each present row floats
            // as its own pill with a per-row rim — not a fused instrument and not
            // a detached float-above git/PR row.
            rowPolicy: .insideStack,
            // transparentChrome = surface draws no chrome, children float
            // (08:6669-6670 backdrop strip + ::before/::after killed).
            effects: .transparentChrome,
            themeImmune: false)                  // theme-derived from composer-bg-solid/panel-border/accent
    }

    private static func terminalRecipe(_ context: ComposerShellContext) -> ResolvedComposerShell {
        // Terminal — REPL/terminal-emulator shell. Near-black green-tinted OPAQUE
        // surface, sharp 2px corners, monospace everything, a bright green `>`
        // prompt caret, `[ ]`-bracketed picker chips, and a small square green send
        // button with an outline run-triangle. THEME-IMMUNE by design: it locks its
        // dark-green look and refuses to flip under light app themes (desktop
        // re-states the dark fill + border with !important + `color-scheme:dark` in
        // the light family), so the SAME locked hexes are used regardless of
        // `context.appIsLight`.
        // Source: ios/COMPOSER-SHELL-PARITY.md "### terminal";
        // 08-theme-picker-overrides.css:4915-5226, theme.css:235.

        // Locked terminal-green palette (identical light & dark → themeImmune).
        // Desktop surface = color-mix(in srgb, #0a0e0a 92%, #00ff88 8%) => #092114.
        let surface = Color(hex: 0x092114)
        // Bright terminal green #00ff88 — focus accent, border base, send fill/tint.
        let green = Color(hex: 0x00FF88)
        // textPrimary = color-mix(#ccffe4 92%, #ffffff 8%) => #D0FFE6 pale mint.
        let textMint = Color(hex: 0xD0FFE6)
        // placeholder = color-mix(#ccffe4 36%, transparent) => #ccffe4 @ 36% alpha
        // (font-style:normal, NOT italic).
        let placeholderMint = Color(hex: 0xCCFFE4).opacity(0.36)

        return ResolvedComposerShell(
            style: .terminal,
            material: .solid,  // opaque near-black, NO backdrop-filter (08:4915-4949); reduce-transparency is a no-op
            palette: ComposerShellPalette(
                surfaceFill: surface,  // color-mix(#0a0e0a 92%, #00ff88 8%)
                innerModuleFill: nil,  // textarea sits directly on the surface; chips/footer/inline-pickers transparent (no card-in-card)
                border: green.opacity(0.24),  // 1px color-mix(#00ff88 24%, transparent)
                focusAccent: green,  // focus ring 0 0 0 2px color-mix(#00ff88 18%); prompt caret green
                textPrimary: textMint,  // color-mix(#ccffe4 92%, #ffffff)
                placeholder: placeholderMint,  // color-mix(#ccffe4 36%, transparent)
                // rimOrGlow = inset green top hairline `inset 0 1px 0 color-mix(#00ff88 8%, transparent)`
                // + drop shadow `0 6px 18px rgba(0,0,0,0.4)` (glow carries the drop tone).
                rim: ComposerShellRim(
                    color: green.opacity(0.08),
                    width: 1,
                    glow: Color(hex: 0x000000).opacity(0.4))),
            geometry: ComposerShellGeometry(
                surfaceCornerRadius: 2,  // SHARP 2px corners (08:4915)
                innerCornerRadius: 2,
                controlShape: .rect(2),  // every chip/button/image-picker/schedule/runtime is a 2px-radius rect
                surfacePadding: EdgeInsets(top: 12, leading: 14, bottom: 12, trailing: 14),  // surface padding 12px 14px
                rowSpacing: 0),
            fontDesign: .monospaced,  // var(--font-mono) on surface/textarea/pickers/footer (theme.css:235)
            sendButton: ComposerSendButton(
                glyph: .runTriangle,  // outline run-triangle (RunSymbolIcon), stroke #ccffe4
                shape: .rect(2),  // SQUARE ~2px radius (base 999px overridden to 2px, 08:5100-5107)
                size: 40,  // 40x40px
                fill: .accent,  // green-filled (desktop fill color-mix(#00ff88 24%, #0a0e0a) + green border)
                tint: green),  // #00FF88
            rowPolicy: .insideStack,  // no terminal-specific :has() — above-bar/ensemble rows styled unconditionally as separate segments
            effects: [.terminalCaret, .bracketChips],  // green `>` prompt caret + literal `[ ]`-wrapped picker labels
            themeImmune: true)  // locks dark green, refuses light (08:5113-5226 !important + color-scheme:dark)
    }

    private static func stubRecipe(_ context: ComposerShellContext) -> ResolvedComposerShell {
        // stub — "Ticket stub": opaque cream PAPER (no glass) over a faint 135deg
        // paper grain, warm tan border @14px, dashed gold perforation, serif type,
        // squared gold send button. THEME-DERIVED, not immune (spec Part C:208/259):
        // dark themes wash 14% cream over the theme surface; light/mist/sage flip to
        // a flat cream card. The gold send button is the only piece locked across
        // all themes. Evidence: 08-theme-picker-overrides.css:5284-5403, :5383-5403
        // (light flip), :5373-5381 (gold send), :5308-5321 (perforation),
        // theme.css:234 (--font-serif); App.tsx:20675-20685 (run-triangle).

        // Gold accents NEVER re-theme — the same warm tan/gold ink in every theme
        // (spec: "Gold send button NOT re-themed — stays gold #c19a4d / #2a1d05").
        let tanBorder = Color(hex: 0xD4C89A)          // de-facto tan accent (focus = border deepen, no glow ring)
        let goldFill = Color(hex: 0xC19A4D)           // action/send gold #c19a4d

        let surfaceFill: Color
        let border: Color
        let textPrimary: Color
        let placeholder: Color
        if context.appIsLight {
            // Light/mist/sage: flat cream card, cocoa ink. Concrete hexes from the
            // spec's light branch (08:5383-5403) — these are fixed, not mixed.
            surfaceFill = Color(hex: 0xFBF3DF)        // flat cream #fbf3df (grain rgba(120,90,40,0.03) on top, drawn by .paperGrain)
            border = Color(hex: 0xC19A4D).opacity(0.28) // light border rgba(193,154,77,0.28)
            textPrimary = Color(hex: 0x4A3A16)        // cocoa ink #4a3a16 (all text in light)
            placeholder = Color(hex: 0x4A3A16).opacity(0.6) // italic placeholder, derived from cocoa ink
        } else {
            // Dark/default: theme-DERIVED. surfaceFill = color-mix(#fcf6e6 14%,
            // composer-bg-solid=var(--surface-1)); the 14% cream wash is faint, so
            // we track the theme surface (the cream character is carried by the
            // always-on .paperGrain + the warm tan border/ink). Warm ink ~ var(--text-primary).
            surfaceFill = TWTheme.surface1            // composer-bg-solid default = --surface-1 (theme token)
            border = TWTheme.border                   // 1px color-mix(#d4c89a 36%, var(--panel-border)); panel-border base
            textPrimary = TWTheme.textPrimary         // warm ink color-mix(var(--text-primary) 96%, #c19a4d) ~ text-primary
            placeholder = TWTheme.textSecondary       // color-mix(var(--text-secondary) 60%, #c19a4d), italic
        }

        return ResolvedComposerShell(
            style: .stub,
            material: .paper,                         // opaque PAPER, no glass / no backdrop-filter
            palette: ComposerShellPalette(
                surfaceFill: surfaceFill,
                innerModuleFill: nil,                 // textarea sits directly on paper; pickers/footer forced transparent (no card-in-card)
                border: border,
                focusAccent: tanBorder,               // focus = tan border deepen + shadow, NO glowing ring; tan #d4c89a is the de-facto accent
                textPrimary: textPrimary,
                placeholder: placeholder,
                // Static inset top highlight `inset 0 1px 0 #ffffff@6%` (always on; 8% on focus).
                rim: ComposerShellRim(color: Color.white.opacity(0.06), width: 1, glow: nil)),
            geometry: ComposerShellGeometry(
                surfaceCornerRadius: 14,              // surface + above-bar + ensemble all 14px
                innerCornerRadius: 14,               // no inner module — rows mirror the surface radius
                controlShape: .rounded(4),           // pickers/labels/commands/chips all rounded 4px
                surfacePadding: EdgeInsets(top: 14, leading: 18, bottom: 12, trailing: 18), // surface padding 14px 18px 12px
                rowSpacing: 0),
            fontDesign: .serif,                       // SERIF everywhere — var(--font-serif) "New York","Times New Roman",Georgia (theme.css:234)
            sendButton: ComposerSendButton(
                glyph: .runTriangle,                  // App.tsx:20675-20685 else → RunSymbolIcon
                shape: .rect(4),                      // squared 4px button — "rounded 4px square (NOT circle)"
                size: 40,                             // no explicit width/height in CSS — inherits base sizing
                fill: .accent,                        // solid gold fill (color-mix(#c19a4d 60%, #fcf6e6)) — treated as accent fill
                tint: goldFill),                      // gold #c19a4d, locked across all themes; glyph ink #2a1d05 drawn by the view
            rowPolicy: .insideStack,                  // inside/stacked family — each row its own cream ticket-head card, NOT merged
            effects: [.paperGrain, .perforation],     // 135deg diagonal grain + dashed gold perforation line, both always on
            themeImmune: false)                       // theme-DERIVED: derives in dark, flat-cream flip in light
    }

    private static func satelliteRecipe(_ context: ComposerShellContext) -> ResolvedComposerShell {
        // satellite — "Everything floats." THEME-DERIVED (not immune): every color is a
        // live theme token, so the shell re-tints with the app theme. Spec: Part C
        // "### satellite — Satellite" (ios/COMPOSER-SHELL-PARITY.md:213-226).
        //
        // Material: transparent/borderless on EVERY container — surface bg transparent,
        // border 0, box-shadow none, backdrop-filter none (08:5405-5491, :6628-6704).
        // Textarea fully transparent (no border/radius/shadow). The ONLY shaped/visible
        // element is the send button: accent-fill r999 circle + colored glow.

        // Accent drives the send fill + glow. Desktop --accent = #5a8cff dark / #6f93ff
        // light; data-accent-selectable can repaint it. Honor a per-message provider
        // accent when present, else the live theme accent token (TWTheme.chroma1).
        let accent = context.providerAccent ?? TWTheme.chroma1

        return ResolvedComposerShell(
            style: .satellite,
            material: .transparent,  // NOT glass/solid — every container draws no chrome (08:5405-5491)
            palette: ComposerShellPalette(
                // surfaceFill transparent: the surface draws nothing and its children float.
                surfaceFill: .clear,
                innerModuleFill: nil,  // n/a — no card-in-card panel (textarea sits on nothing)
                // border none/transparent everywhere (surface + textarea, even on focus).
                border: .clear,
                // focusAccent: spec has NO focus ring/glow (:focus-within keeps box-shadow:none
                // + border-color transparent). The only accent in the shell is the send
                // button fill+glow, so we surface the same accent token here.
                focusAccent: accent,  // --accent (#5a8cff dark / #6f93ff light), theme-derived
                // Textarea text is full-strength --text-primary (rgba(255,255,255,0.92) D /
                // rgba(18,21,27,0.92) L). Theme-derived → TWTheme.textPrimary.
                textPrimary: TWTheme.textPrimary,
                // Placeholder inherits the base composer-textarea (not overridden) → tertiary.
                placeholder: TWTheme.textTertiary,
                // The ONE visible effect: the send button's outer glow
                // `0 4px 14px color-mix(var(--accent) 36%, transparent)`. The contract's only
                // glow channel is palette.rim.glow; surface/above-bar box-shadow stays none,
                // so we express a pure glow (transparent ring, zero-ish width) carrying the
                // accent at ~36% (08:5405-5491, Effects line 222).
                rim: ComposerShellRim(
                    color: .clear,           // no inset rim ring on the surface
                    width: 0,
                    glow: accent.opacity(0.36))  // 0 4px 14px color-mix(var(--accent) 36%)
            ),
            geometry: ComposerShellGeometry(
                // surfaceRadius 0/none — surface is transparent and unset (08:5405-5491).
                surfaceCornerRadius: 0,
                // innerRadius 8px — the hover-only soft tint pill + roster chips.
                innerCornerRadius: 8,
                // Controls are plain-text tokens with NO shape at rest (only a hover tint
                // pill, radius 8). Closest at-rest contract value = rounded(8).
                controlShape: .rounded(8),
                // surface padding 6px 4px 0 (top/sides/bottom-0).
                surfacePadding: EdgeInsets(top: 6, leading: 4, bottom: 0, trailing: 4),
                // above-bar / pickers / footer / ensemble rows all gap 12-14px; use 12.
                rowSpacing: 12),
            fontDesign: .system,  // App sans — no mono, no serif (Typography line 220)
            sendButton: ComposerSendButton(
                glyph: .runTriangle,        // authoritative — desktop else→RunSymbolIcon (App.tsx:20675-20685)
                shape: .rounded(999),       // satellite sets radius 999 explicitly → perfect circle
                size: 40,                   // 40×40px (Geometry line 217)
                fill: .accent,              // accent-filled circle, color-mix(var(--accent) 92%)
                // tint = the accent fill token (#5a8cff dark / #6f93ff light, theme-derived).
                // (The desktop glyph itself is var(--success) green, a render detail of the
                // triangle, not the button's fill/accent the contract carries here.)
                tint: accent),
            // Above-bar/ensemble/roster rows are unconditionally flattened to transparent
            // and the git/changes + create-pr rows detach above the stack with a fanned
            // per-row aura → floatAbove.
            rowPolicy: .floatAbove,
            // transparentChrome: the surface draws no chrome and children float (the one
            // satellite/modular effect; the send glow rides on palette.rim above).
            effects: [.transparentChrome],
            themeImmune: false)  // THEME-DERIVED — consumes active theme tokens directly
    }

    private static func obsidianRecipe(_ context: ComposerShellContext) -> ResolvedComposerShell {
        // THEME-IMMUNE: obsidian locks a DARK charcoal palette regardless of the app
        // theme (08:5594-5626 doubled-attribute scope + color-scheme:dark). In LIGHT
        // app themes it still renders charcoal-with-white-rim and does NOT flip, so we
        // ignore context.appIsLight and hardcode the dark tokens. (Spec: Theme behavior.)

        // Charcoal fill #181818 (--obsidian-composer-fill, 08:5554). Same tone for the
        // inner module: the two-surface split re-applies the SAME #181818 to both the
        // textarea-wrap and the bottom-controls as two independently-lit rects
        // (08:6354-6430), so innerModuleFill matches surfaceFill exactly.
        let charcoal = Color(hex: 0x181818)

        // The white-rim identity is encoded as white-at-opacity (white is theme-stable
        // in any color space). Border rgba(255,255,255,0.10) (--obsidian-composer-border);
        // focus rim-strong rgba(255,255,255,0.42) (--obsidian-composer-rim-strong, brightens
        // on :focus-within); textPrimary rgba(255,255,255,0.92); placeholder rgba(255,255,255,0.32).
        let border = Color.white.opacity(0.10)
        let rimStrong = Color.white.opacity(0.42)
        let textPrimary = Color.white.opacity(0.92)
        let placeholder = Color.white.opacity(0.32)

        // STATIC RIM: inset 0 2px 0 rgba(255,255,255,0.28) (08:5671-5705), width 2.
        // glow carries the AMBIENT OUTER GLOW (0 0 28px rgba(255,255,255,0.05)) so CS6
        // can draw the white halo behind each lit rect.
        let obsidianRim = ComposerShellRim(
            color: Color.white.opacity(0.28),   // static rim
            width: 2,                            // 2px white inset rim (live token, not stale 1px)
            glow: Color.white.opacity(0.05))     // ambient outer glow 0 0 28px rgba(255,255,255,0.05)

        // Send fill is color-mix(var(--accent) 90%, transparent) (08:6006-6015): an
        // accent-filled capsule. tint = the provider/app accent that the mix is built
        // from. (The run-triangle glyph itself renders GREEN via var(--success) — a CS6
        // glyph-color detail, corrected in the skeptic note; the button FILL is accent.)
        let sendTint = context.providerAccent ?? TWTheme.chroma1

        return ResolvedComposerShell(
            style: .obsidian,
            material: .solid,   // solid opaque charcoal; backdrop-filter:none regardless of mode (08:5671)
            palette: ComposerShellPalette(
                surfaceFill: charcoal,        // #181818 (--obsidian-composer-fill)
                innerModuleFill: charcoal,    // split rects share #181818, separately bordered/lit
                border: border,               // rgba(255,255,255,0.10)
                focusAccent: rimStrong,       // rim brightens to rgba(255,255,255,0.42) on focus
                textPrimary: textPrimary,     // rgba(255,255,255,0.92)
                placeholder: placeholder,     // rgba(255,255,255,0.32)
                rim: obsidianRim),
            geometry: ComposerShellGeometry(
                surfaceCornerRadius: 8,       // --obsidian-composer-radius 8px (lives on the two rects in split form)
                innerCornerRadius: 8,         // each split rect 8px
                controlShape: .rect(0),       // controls flattened: NOT pills — bg transparent, border 0, radius 0 (08:5927-6001)
                rowSpacing: 0),
            fontDesign: .system,              // System sans, no override (Typography section)
            sendButton: ComposerSendButton(
                glyph: .runTriangle,          // run-triangle (authoritative; App.tsx:20675-20685)
                shape: .capsule,              // round capsule 999px
                size: 40,                     // 40×40px
                fill: .accent,                // color-mix(var(--accent) 90%, transparent), border 0
                tint: sendTint),
            rowPolicy: .insideStack,           // detached above-rows each become their own lit charcoal rim-satellite (08:5808-5872)
            effects: [.rimChase, .twoSurfaceSplit],  // 16s conic lighthouse rim-chase + two-surface split
            themeImmune: true)                // locks dark palette regardless of app theme
    }

    /// Alabaster — the polar inverse of Obsidian: warm opaque cream (#f4f3ef),
    /// NO glass/blur, ringed by an animated CHARCOAL rim-shimmer (16s) over a
    /// soft warm ambient glow. THEME-IMMUNE: hard-locks light charcoal-on-cream
    /// regardless of app theme (no dark variant), so we set our own hexes and
    /// `themeImmune: true` and ignore context.appIsLight. Ships in the
    /// two-surface split (shared with obsidian): the outer surface goes
    /// transparent and the textarea-wrap + bottom-controls each become an
    /// independent lit cream rect — modeled here via innerModuleFill +
    /// .twoSurfaceSplit. Desktop source: 08-theme-picker-overrides.css:6040-6597.
    private static func alabasterRecipe(_ context: ComposerShellContext) -> ResolvedComposerShell {
        // Locked light palette (08:6040-6086 doubled-attribute token lock).
        // Charcoal base = rgba(18,21,27,*) → 0x12151B (18,21,27).
        let charcoal = Color(hex: 0x12151B)
        let cream = Color(hex: 0xF4F3EF) // --alabaster-composer-fill, applied !important
        // Warm ambient glow tint rgba(180,160,120,*) → 0xB4A078 (180,160,120).
        let warmGlow = Color(hex: 0xB4A078).opacity(0.06) // 0 0 28px rgba(180,160,120,0.06)

        return ResolvedComposerShell(
            style: .alabaster,
            // Solid opaque cream — NOT glass; backdrop-filter forced none so
            // reduce-transparency is a no-op (08:6114-6115, 6200-6201, 6272-6273).
            material: .solid,
            palette: ComposerShellPalette(
                surfaceFill: cream, // #f4f3ef
                // Same #f4f3ef on the second lit split rect (textarea-wrap +
                // bottom-controls share one tone, separately bordered/rim-lit).
                innerModuleFill: cream,
                border: charcoal.opacity(0.12), // --alabaster-composer-border rgba(18,21,27,0.12)
                // :focus-within border-color → rgba(18,21,27,0.22) (rim strengthens to 0.34).
                focusAccent: charcoal.opacity(0.22),
                textPrimary: charcoal.opacity(0.92), // rgba(18,21,27,0.92)
                placeholder: charcoal.opacity(0.42), // rgba(18,21,27,0.42)
                // Charcoal inset top-rim hairline `inset 0 2px 0 rgba(18,21,27,0.20)`
                // (--alabaster-composer-rim; strong 0.34), over the warm ambient glow.
                rim: ComposerShellRim(
                    color: charcoal.opacity(0.20),
                    width: 2,
                    glow: warmGlow)),
            geometry: ComposerShellGeometry(
                surfaceCornerRadius: 8, // --alabaster-composer-radius (8px)
                innerCornerRadius: 8, // each split rect is also 8px
                // Controls flattened to floating charcoal text: bg transparent,
                // border 0, radius 0, no shadow (08:6256-6314) → no pill shape.
                controlShape: .rect(0),
                rowSpacing: 8), // split bottom-controls flex column gap
            fontDesign: .system, // System sans, no override
            sendButton: ComposerSendButton(
                glyph: .runTriangle, // App.tsx:20675-20685 else → RunSymbolIcon
                shape: .capsule, // circular pill (999px), border 0
                size: 40, // inherited from base run-btn
                fill: .accent, // bg color-mix(var(--accent) 90%, transparent)
                // Glyph color var(--success) GREEN; statusSuccess is a constant
                // Color(hex: 0x46A758), theme-independent → safe under themeImmune.
                tint: TWTheme.statusSuccess),
            // Detached above-rows: each row its own lit cream tile (no merged
            // instrument); the two-surface split detaches the row stack.
            rowPolicy: .insideStack,
            // Animated charcoal conic rim-chase + the two-surface split.
            effects: [.rimChase, .twoSurfaceSplit],
            themeImmune: true) // locks light cream regardless of app theme
    }
}
