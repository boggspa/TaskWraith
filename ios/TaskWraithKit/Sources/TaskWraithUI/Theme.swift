// TaskWraith theme tokens — Swift mirrors of the desktop's theme.css
// primitives (src/renderer/src/styles/theme.css), so the phone's transcript
// chrome reads as the SAME product as the Mac, not a generic SwiftUI app.
//
// Keep values in lockstep with the desktop file; the names below match the
// CSS custom properties they mirror. The app runs dark-first (the desktop is
// a dark-chrome product) — RootView forces .dark.

import SwiftUI
#if canImport(UIKit)
    import UIKit
#elseif canImport(AppKit)
    import AppKit
#endif
import TaskWraithKit

public enum TWTheme {
    // ── Backgrounds (--app-bg, --surface-1/2/3) ───────────────────────────────
    @MainActor public static var appBg: Color { TWThemeStore.shared.systemTheme.appBg }
    /// Workspace sidebar / home list — ~4% lighter than appBg so the list
    /// plane reads distinct from the transcript plane.
    @MainActor public static var sidebarBg: Color { TWThemeStore.shared.systemTheme.sidebarBg }
    /// Composer deck — a touch lighter than surface2 on dark themes (the
    /// desktop shell's lifted deck), a touch darker on light themes; the
    /// inner textarea container stays surface2 either way.
    @MainActor public static var composerBg: Color { TWThemeStore.shared.systemTheme.composerBg }
    @MainActor public static var surface1: Color { TWThemeStore.shared.systemTheme.surface1 }
    @MainActor public static var surface2: Color { TWThemeStore.shared.systemTheme.surface2 }
    @MainActor public static var surface3: Color { TWThemeStore.shared.systemTheme.surface3 }
    /** --surface-border: white @ 6%. */
    @MainActor public static var border: Color {
        TWThemeStore.shared.systemTheme.isLight
            ? Color.black.opacity(0.10) : Color.white.opacity(0.06)
    }

    /// Frosted composer shell — disabled when the user has Reduce Transparency on.
    @MainActor public static var composerGlassEnabled: Bool {
        #if canImport(UIKit)
            return !UIAccessibility.isReduceTransparencyEnabled
        #else
            return true
        #endif
    }

    /// Dark tint washed over `.ultraThinMaterial` so the dock stays TaskWraith-dark.
    public static let composerGlassTintOpacity: Double = 0.25

    // ── Text ramp (--text-primary/secondary/tertiary/muted) ──────────────────
    @MainActor public static var textPrimary: Color {
        TWThemeStore.shared.systemTheme.isLight
            ? Color.black.opacity(0.88) : Color.white.opacity(0.92)
    }
    @MainActor public static var textSecondary: Color {
        TWThemeStore.shared.systemTheme.isLight
            ? Color.black.opacity(0.55) : Color.white.opacity(0.55)
    }
    @MainActor public static var textTertiary: Color {
        TWThemeStore.shared.systemTheme.isLight
            ? Color.black.opacity(0.38) : Color.white.opacity(0.35)
    }
    @MainActor public static var textMuted: Color {
        TWThemeStore.shared.systemTheme.isLight
            ? Color.black.opacity(0.26) : Color.white.opacity(0.25)
    }

    // ── Chroma accents (--theme-chroma-1/2/3) ─────────────────────────────────
    /** Primary accent (links, active states, send button). */
    @MainActor public static var chroma1: Color { TWThemeStore.shared.accentTheme.color }
    /// The factory accent (pre-theming) — used as the 'System' accent.
    public static let chroma1Default = Color(hex: 0x5A8CFF)
    /** Secondary accent (ensemble speakers, highlights). */
    public static let chroma2 = Color(hex: 0xBF7CFF)
    /** Tertiary accent (the ghost's cyan glow). */
    public static let chroma3 = Color(hex: 0x41C7E5)

    // ── Status colors (mirror the desktop run-status palette) ────────────────
    @MainActor public static var statusRunning: Color { chroma1 }
    public static let statusAttention = Color(hex: 0xF5A623)
    public static let statusFailed = Color(hex: 0xE5484D)
    public static let statusSuccess = Color(hex: 0x46A758)

    // ── Diff palette (--diff-stat-add/del-color, --diff-add/del-bg/-text) ────
    // Dedicated to DIFF surfaces (± counters, diff rows) so they can't drift
    // with run-status semantics; the desktop defines no light overrides, so
    // these are theme-invariant like the status palette above.
    public static let diffStatAdd = Color(hex: 0x2DB777)
    public static let diffStatDel = Color(hex: 0xEC3D35)
    public static let diffAddText = Color(hex: 0x6DDFA8)
    public static let diffDelText = Color(hex: 0xF08080)
    public static let diffAddBg = Color(hex: 0x4CC38A).opacity(0.10)
    public static let diffDelBg = Color(hex: 0xE54D4D).opacity(0.10)

    /// Sunken well behind inline code chips (--app-bg-sunken).
    @MainActor public static var appBgSunken: Color {
        TWThemeStore.shared.systemTheme.isLight ? Color(hex: 0xE9EDF2) : Color(hex: 0x0E0E0E)
    }

    /// Boss crown — desktop .ensemble-above-chip-crown: the warning hue
    /// lifted 12% toward white; pair with a 4pt statusAttention@34% shadow
    /// for the drop-glow half of the treatment.
    public static let bossCrown = mix(statusAttention, 0.88, Color.white)

    /// CSS `color-mix(in srgb, a W%, b)` twin — premultiplied-alpha weighted
    /// mix so translucent operands (e.g. textPrimary at partial opacity in
    /// the reasoning chip ramp) resolve exactly like the desktop.
    public static func mix(_ a: Color, _ weight: Double, _ b: Color) -> Color {
        let w = max(0, min(1, weight))
        var c1: (r: CGFloat, g: CGFloat, b: CGFloat, a: CGFloat) = (0, 0, 0, 0)
        var c2: (r: CGFloat, g: CGFloat, b: CGFloat, a: CGFloat) = (0, 0, 0, 0)
        #if canImport(UIKit)
            UIColor(a).getRed(&c1.r, green: &c1.g, blue: &c1.b, alpha: &c1.a)
            UIColor(b).getRed(&c2.r, green: &c2.g, blue: &c2.b, alpha: &c2.a)
        #elseif canImport(AppKit)
            (NSColor(a).usingColorSpace(.sRGB) ?? .black)
                .getRed(&c1.r, green: &c1.g, blue: &c1.b, alpha: &c1.a)
            (NSColor(b).usingColorSpace(.sRGB) ?? .black)
                .getRed(&c2.r, green: &c2.g, blue: &c2.b, alpha: &c2.a)
        #endif
        let outA = w * c1.a + (1 - w) * c2.a
        guard outA > 0 else { return .clear }
        return Color(
            red: (w * c1.a * c1.r + (1 - w) * c2.a * c2.r) / outA,
            green: (w * c1.a * c1.g + (1 - w) * c2.a * c2.g) / outA,
            blue: (w * c1.a * c1.b + (1 - w) * c2.a * c2.b) / outA,
            opacity: outA)
    }

    @MainActor public static func statusColor(_ status: String?) -> Color {
        switch status {
        case "running": return statusRunning
        case "awaitingApproval", "awaitingQuestion": return statusAttention
        case "failed", "error": return statusFailed
        case "success": return statusSuccess
        default: return textSecondary
        }
    }

    // ── Provider accents (--provider-*-color) ─────────────────────────────────
    // The desktop composer re-skins per provider; the phone mirrors the same
    // accent on the provider pill, placeholder, and send button.
    @MainActor public static func providerAccent(_ provider: String?) -> Color {
        switch provider?.lowercased() {
        case "gemini": return Color(hex: 0x346EEC)
        case "codex", "openai": return Color(hex: 0x705AFF)
        case "claude": return Color(hex: 0xB16105)
        case "kimi": return Color(hex: 0x0073E6)
        case "cursor": return Color(hex: 0x8D7312)
        case "ollama": return Color(hex: 0x1A8562)
        case "antigravity", "google": return Color(hex: 0x308713)
        case "pi": return Color(hex: 0x68768C)
        case "ensemble": return Color(hex: 0x986781)
        case "grok": return Color(hex: 0x757575)
        // ── Ollama-backed display brands (--provider-*-color) ──────────────
        // Runtime provider stays `ollama`; these spoofed brand classes let
        // local models wear their upstream brand hue. Mirrors theme.css
        // lines 148–159. `google` (Gemma) reuses the AntiGravity accent and
        // `openai` the codex accent above — Gemma deliberately no longer
        // wears the retired Gemini blue. `qwen`/`ornith` retained as legacy
        // speaker heads but now alias to their canonical brand colors
        // (Alibaba / Deep Reinforce).
        case "alibaba", "qwen": return Color(hex: 0x8C52EF)
        case "deep-reinforce", "ornith": return Color(hex: 0xBE5809)
        case "ibm": return Color(hex: 0x3079BC)
        case "liquid": return Color(hex: 0xD72D82)
        case "nvidia": return Color(hex: 0x538200)
        case "openbmb": return Color(hex: 0xE22B17)
        case "poolside": return Color(hex: 0x0C8194)
        // ── Pi-backed BYOK upstream brands (--provider-*-color) ────────────
        // Runtime provider stays `pi`; the wire id names the upstream that
        // serves the run, so a Pi row wears that brand. Mirrors theme.css.
        // `qwen-token-plan` resolves to the `qwen` class handled above, so
        // Qwen reads the same whether it arrives via Ollama or via Pi.
        // Groq wears its own published SECONDARY cyan and Z.ai an azure —
        // their primaries collided with Mistral's orange and DeepSeek's blue.
        case "deepseek": return Color(hex: 0x4E6AEE)
        case "zai": return Color(hex: 0x177DAA)
        case "minimax": return Color(hex: 0xC044A4)
        case "mistral": return Color(hex: 0xD44404)
        case "cerebras": return Color(hex: 0xBB584A)
        case "groq": return Color(hex: 0x088482)
        default: return chroma1
        }
    }

    /// Brand-aware provider accent. For Ollama models the accent resolves to
    /// the spoofed upstream brand hue (e.g. Qwen → Alibaba purple); every
    /// other provider falls through to the flat `providerAccent` above.
    @MainActor public static func providerAccent(
        _ provider: String?, modelId: String?, modelLabel: String? = nil
    ) -> Color {
        providerAccent(
            OllamaDisplayBrands.providerHueClass(
                provider: provider, modelId: modelId, modelLabel: modelLabel))
    }

    /// Black silhouette painted behind provider glyph linework in every theme.
    public static let providerGlyphContrast = Color.black

    /// Display label matching the desktop's provider naming.
    public static func providerLabel(_ provider: String?) -> String {
        switch provider?.lowercased() {
        case "gemini": return "Gemini"
        case "codex": return "Codex"
        case "claude": return "Claude"
        case "kimi": return "Kimi"
        case "grok": return "Grok"
        case "cursor": return "Cursor"
        case "ollama": return "Ollama"
        case "antigravity": return "AntiGravity"
        case "pi": return "Pi"
        case "ensemble": return "Ensemble"
        case "alibaba": return "Alibaba"
        case "deep-reinforce": return "Deep Reinforce"
        case "google": return "Google"
        case "ibm": return "IBM"
        case "liquid": return "Liquid"
        case "nvidia": return "NVIDIA"
        case "openai": return "OpenAI"
        case "openbmb": return "OpenBMB"
        case "poolside": return "Poolside"
        case "qwen": return "Qwen"
        case "ornith": return "Ornith"
        // Pi BYOK upstreams. Present because a hue class is sometimes carried as
        // an id (participant-health entries stamp `displayHueClass`), and the
        // default branch below would title-case them into "Deepseek" / "Zai".
        case "deepseek": return "DeepSeek"
        case "zai": return "Z.ai"
        case "minimax": return "MiniMax"
        case "mistral": return "Mistral"
        case "groq": return "Groq"
        case "cerebras": return "Cerebras"
        case .some(let other): return other.prefix(1).uppercased() + other.dropFirst()
        case nil: return "Agent"
        }
    }

    /// Brand-aware provider label. For Ollama models this returns the spoofed
    /// upstream brand name (e.g. "Alibaba") instead of "Ollama"; every other
    /// provider falls through to the flat `providerLabel` above.
    public static func providerLabel(
        _ provider: String?, modelId: String?, modelLabel: String? = nil
    ) -> String {
        if let brand = OllamaDisplayBrands.brandLabel(
            provider: provider, modelId: modelId, modelLabel: modelLabel)
        {
            return brand
        }
        return providerLabel(provider)
    }

    // ── Retired providers ─────────────────────────────────────────────────────
    /// Providers retired from new use (Gemini, 2026-06-18). Kept for historical
    /// decode/render — the label/accent tables above still resolve them — but
    /// never offered in pickers, and ensemble chips show them greyed + locked.
    /// Mirrors the Mac's src/shared/retiredProviders.ts.
    public static let retiredProviderIds: Set<String> = ["gemini"]

    public static func isRetiredProvider(_ provider: String?) -> Bool {
        guard let provider else { return false }
        return retiredProviderIds.contains(provider.lowercased())
    }

    /// The seven providers approved for static new-run offer by product intent.
    /// Offer membership is independent of run-management maturity: Cursor's
    /// Path-B containment/evidence can strengthen or visibly degrade without
    /// changing whether Cursor is offered, and the same rule applies to Pi and
    /// every other provider. Hand-mirrored copy of the Mac's
    /// LIVE_SELECTABLE_PROVIDER_IDS in src/shared/retiredProviders.ts — there
    /// is no shared source of truth, so every user-approved desktop live-set
    /// change must be mirrored here or iOS ships with a stale roster (build 81
    /// shipped a Cursor lockout exactly this way).
    public static let liveSelectableProviderIds: Set<String> = [
        "codex", "claude", "kimi", "cursor", "grok", "ollama", "pi", "mistral",
    ]

    public static func isLiveSelectableProvider(_ provider: String?) -> Bool {
        guard let provider else { return false }
        return liveSelectableProviderIds.contains(provider.lowercased())
    }

    /// The paired Mac owns the authenticated configured-provider snapshot.
    /// Keep the canonical static live set unchanged; only a nonempty catalog
    /// already projected by that snapshot may dynamically offer AntiGravity.
    public static func isProviderOfferedByModelCatalog(
        _ provider: String?, models: [ModelOption]
    ) -> Bool {
        guard let provider else { return false }
        if isLiveSelectableProvider(provider) { return true }
        return provider.lowercased() == "antigravity" && !models.isEmpty
    }
}

extension Color {
    /// 0xRRGGBB initializer for token tables.
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1)
    }
}


// ── Theme store (desktop Appearance parity, composer shells deferred) ──────
// Persisted in UserDefaults; the root view keys on `revision` so a theme
// change rebuilds the tree (TWTheme statics are computed reads).

public enum TWSystemTheme: String, CaseIterable, Identifiable {
    case dark, midnight, blue, purple, ocean, forest, sunset, obsidian
    case light, alabaster, mist

    public var isLight: Bool {
        switch self {
        case .light, .alabaster, .mist: return true
        default: return false
        }
    }

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .dark: return "Dark"
        case .midnight: return "Midnight"
        case .blue: return "Blue"
        case .purple: return "Purple"
        case .ocean: return "Ocean"
        case .forest: return "Forest"
        case .sunset: return "Sunset"
        case .obsidian: return "Obsidian"
        case .light: return "Light"
        case .alabaster: return "Alabaster"
        case .mist: return "Mist"
        }
    }

    var sidebarBg: Color {
        // appBg + ~4% white lift.
        switch self {
        case .dark: return Color(hex: 0x1E1E1E)
        case .midnight: return Color(hex: 0x161A24)
        case .blue: return Color(hex: 0x18202E)
        case .purple: return Color(hex: 0x1E1A2C)
        case .ocean: return Color(hex: 0x162224)
        case .forest: return Color(hex: 0x18221C)
        case .sunset: return Color(hex: 0x261E1C)
        case .obsidian: return Color(hex: 0x1A1A1E)
        // Light themes: sidebar sits ~4% DARKER than appBg for the same
        // plane separation.
        case .light: return Color(hex: 0xEDEDEF)
        case .alabaster: return Color(hex: 0xEFEDE8)
        case .mist: return Color(hex: 0xE9EEF0)
        }
    }

    var appBg: Color {
        switch self {
        case .dark: return Color(hex: 0x141414)
        case .midnight: return Color(hex: 0x0C0E16)
        case .blue: return Color(hex: 0x0E1420)
        case .purple: return Color(hex: 0x14101E)
        case .ocean: return Color(hex: 0x0C1618)
        case .forest: return Color(hex: 0x0E1610)
        case .sunset: return Color(hex: 0x1A1210)
        case .obsidian: return Color(hex: 0x101012)
        case .light: return Color(hex: 0xF7F7F9)
        case .alabaster: return Color(hex: 0xFAF8F3)
        case .mist: return Color(hex: 0xF2F7F9)
        }
    }

    var surface1: Color {
        switch self {
        case .dark: return Color(hex: 0x1C1C20)
        case .midnight: return Color(hex: 0x141828)
        case .blue: return Color(hex: 0x16202E)
        case .purple: return Color(hex: 0x1E1830)
        case .ocean: return Color(hex: 0x142226)
        case .forest: return Color(hex: 0x16221A)
        case .sunset: return Color(hex: 0x261C18)
        case .obsidian: return Color(hex: 0x18181C)
        case .light: return Color(hex: 0xFFFFFF)
        case .alabaster: return Color(hex: 0xFFFFFE)
        case .mist: return Color(hex: 0xFBFDFE)
        }
    }

    var surface2: Color {
        switch self {
        case .dark: return Color(hex: 0x24242A)
        case .midnight: return Color(hex: 0x1A2034)
        case .blue: return Color(hex: 0x1E2A3C)
        case .purple: return Color(hex: 0x282040)
        case .ocean: return Color(hex: 0x1C2E32)
        case .forest: return Color(hex: 0x1E2E24)
        case .sunset: return Color(hex: 0x322620)
        case .obsidian: return Color(hex: 0x202026)
        case .light: return Color(hex: 0xEFEFF2)
        case .alabaster: return Color(hex: 0xF1EEE7)
        case .mist: return Color(hex: 0xE8F0F3)
        }
    }

    var composerBg: Color {
        switch self {
        case .dark: return Color(hex: 0x2A2A30)
        case .midnight: return Color(hex: 0x20263C)
        case .blue: return Color(hex: 0x243244)
        case .purple: return Color(hex: 0x2E2648)
        case .ocean: return Color(hex: 0x22343A)
        case .forest: return Color(hex: 0x24342A)
        case .sunset: return Color(hex: 0x3A2C26)
        case .obsidian: return Color(hex: 0x26262C)
        case .light: return Color(hex: 0xF4F4F6)
        case .alabaster: return Color(hex: 0xF6F3EC)
        case .mist: return Color(hex: 0xEFF5F7)
        }
    }

    var surface3: Color {
        switch self {
        case .dark: return Color(hex: 0x2E2E36)
        case .midnight: return Color(hex: 0x222A44)
        case .blue: return Color(hex: 0x28364C)
        case .purple: return Color(hex: 0x342A52)
        case .ocean: return Color(hex: 0x263C42)
        case .forest: return Color(hex: 0x283C30)
        case .sunset: return Color(hex: 0x40322A)
        case .obsidian: return Color(hex: 0x2A2A32)
        case .light: return Color(hex: 0xE4E4E8)
        case .alabaster: return Color(hex: 0xE9E5DC)
        case .mist: return Color(hex: 0xDCE8EC)
        }
    }
}

public enum TWAccentTheme: String, CaseIterable, Identifiable {
    case system, blue, purple, pink, orange, green, red, yellow

    public var id: String { rawValue }

    public var label: String {
        rawValue == "system" ? "System" : rawValue.prefix(1).uppercased() + rawValue.dropFirst()
    }

    public var color: Color {
        switch self {
        case .system: return TWTheme.chroma1Default
        case .blue: return Color(hex: 0x4D8DFF)
        case .purple: return Color(hex: 0xA86CFF)
        case .pink: return Color(hex: 0xF562B5)
        case .orange: return Color(hex: 0xF59442)
        case .green: return Color(hex: 0x35C284)
        case .red: return Color(hex: 0xEB5A5A)
        case .yellow: return Color(hex: 0xE5C03E)
        }
    }
}

public enum TWToolTheme: String, CaseIterable, Identifiable {
    case matchAccent, graphite, cyan, amber, violet

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .matchAccent: return "Match accent"
        case .graphite: return "Graphite"
        case .cyan: return "Cyan"
        case .amber: return "Amber"
        case .violet: return "Violet"
        }
    }

    @MainActor public var color: Color {
        switch self {
        case .matchAccent: return TWThemeStore.shared.accentTheme.color
        case .graphite: return Color(hex: 0x9AA0AC)
        case .cyan: return Color(hex: 0x41C7E5)
        case .amber: return Color(hex: 0xE5B53E)
        case .violet: return Color(hex: 0xBF7CFF)
        }
    }
}

@MainActor
/// Transcript response typeface choice (Settings → Transcript). `avenirNext` is
/// the default (the long-standing message-body face); the others map to SwiftUI
/// system designs so they need no bundled fonts and work on every device.
public enum TWTranscriptFont: String, CaseIterable {
    case avenirNext, sfPro, serif, monospaced, rounded
    public var label: String {
        switch self {
        case .avenirNext: return "Avenir Next"
        case .sfPro: return "SF Pro"
        case .serif: return "Serif"
        case .monospaced: return "Monospaced"
        case .rounded: return "Rounded"
        }
    }
}

public final class TWThemeStore: ObservableObject {
    // UI-only singleton, touched from the main actor; `nonisolated(unsafe)` keeps
    // it reachable from the (main-thread) nonisolated TWFont/UserDefaults readers
    // under strict concurrency without forcing @MainActor onto every caller.
    public nonisolated(unsafe) static let shared = TWThemeStore()

    /// Bumped on every change — the root view keys its identity on this so
    /// the whole tree re-reads the TWTheme computed tokens.
    @Published public private(set) var revision = 0

    public var systemTheme: TWSystemTheme {
        get {
            TWSystemTheme(
                rawValue: UserDefaults.standard.string(forKey: "tw.theme.system") ?? "dark")
                ?? .dark
        }
        set {
            UserDefaults.standard.set(newValue.rawValue, forKey: "tw.theme.system")
            revision += 1
        }
    }

    public var accentTheme: TWAccentTheme {
        get {
            TWAccentTheme(
                rawValue: UserDefaults.standard.string(forKey: "tw.theme.accent") ?? "system")
                ?? .system
        }
        set {
            UserDefaults.standard.set(newValue.rawValue, forKey: "tw.theme.accent")
            revision += 1
        }
    }

    public var toolTheme: TWToolTheme {
        get {
            TWToolTheme(
                rawValue: UserDefaults.standard.string(forKey: "tw.theme.tool") ?? "matchAccent")
                ?? .matchAccent
        }
        set {
            UserDefaults.standard.set(newValue.rawValue, forKey: "tw.theme.tool")
            revision += 1
        }
    }

    /// Composer-shell choice for THIS device. `.followMac` (default) mirrors
    /// the Mac's projected `composerStyle`; `.override` pins a style locally.
    /// Only the preference is persisted — never the effective style. The
    /// effective style is resolved at render time via `twEffectiveComposerStyle`.
    /// See ios/COMPOSER-SHELL-PARITY.md (E.4).
    public var composerShellPreference: TWComposerShellPreference {
        get {
            TWComposerShellPreference(
                persisted: UserDefaults.standard.string(forKey: "tw.composerShell"))
        }
        set {
            UserDefaults.standard.set(newValue.persisted, forKey: "tw.composerShell")
            revision += 1
        }
    }

    /// Transcript response typeface for THIS device. Default `.avenirNext`.
    public var transcriptFontPreference: TWTranscriptFont {
        get {
            TWTranscriptFont(
                rawValue: UserDefaults.standard.string(forKey: "tw.transcriptFont")
                    ?? "avenirNext") ?? .avenirNext
        }
        set {
            UserDefaults.standard.set(newValue.rawValue, forKey: "tw.transcriptFont")
            revision += 1
        }
    }

    /// App-scale preference for the iOS `- / Default / +` display-size control.
    /// `standard` is the baseline and equals the current shipped layout.
    public var appScalePreference: TWAppScale {
        get {
            TWAppScaleStore(defaults: .standard).scale
        }
        set {
            var store = TWAppScaleStore(defaults: .standard)
            store.scale = newValue
            revision += 1
        }
    }

    /// Tool-call icon/accent color (ToolActivityCards categories).
    @MainActor public static var toolAccent: Color { shared.toolTheme.color }
}


extension View {
    /// Theme-driven color scheme — light system themes get .light.
    @MainActor public func twColorScheme() -> some View {
        preferredColorScheme(
            TWThemeStore.shared.systemTheme.isLight ? .light : .dark)
    }
}

private struct TWAppScaleEnvironmentKey: EnvironmentKey {
    static let defaultValue: TWAppScale = .standard
}

public extension EnvironmentValues {
    /// App-scale bucket used by settings/controls later; defaults to `.standard`.
    var appScale: TWAppScale {
        get { self[TWAppScaleEnvironmentKey.self] }
        set { self[TWAppScaleEnvironmentKey.self] = newValue }
    }
}

public extension View {
    /// Override the effective app-scale for this subtree.
    @ViewBuilder
    func twAppScale(_ value: TWAppScale) -> some View {
        modifier(TWAppScaleViewModifier(scale: value))
    }
}

private struct TWAppScaleViewModifier: ViewModifier {
    let scale: TWAppScale
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    func body(content: Content) -> some View {
        content
            .environment(\.appScale, scale)
            .dynamicTypeSize(scale.adjustedDynamicTypeSize(from: dynamicTypeSize))
    }
}

private extension TWAppScale {
    func adjustedDynamicTypeSize(from current: DynamicTypeSize) -> DynamicTypeSize {
        guard self != .standard else { return current }
        let sizes: [DynamicTypeSize] = [
            .xSmall, .small, .medium, .large, .xLarge, .xxLarge, .xxxLarge,
            .accessibility1, .accessibility2, .accessibility3, .accessibility4,
            .accessibility5
        ]
        guard let index = sizes.firstIndex(of: current) else { return current }
        let step = rawValue
        if step < 0 {
            // Keep explicit accessibility text sizes intact; compact layouts should
            // not fight a user's OS-level readability setting.
            guard current < .accessibility1 else { return current }
            return sizes[max(0, index + step)]
        }
        return sizes[min(sizes.count - 1, index + step)]
    }
}
