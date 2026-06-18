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
        case "gemini", "google": return Color(hex: 0x2563EB)
        case "codex", "openai": return Color(hex: 0x6366F1)
        case "claude": return Color(hex: 0xD97706)
        case "kimi": return Color(hex: 0x84A33B)
        case "cursor": return Color(hex: 0xE3B91E)
        case "ollama": return Color(hex: 0x20A77A)
        case "ensemble": return Color(hex: 0xE8DDE3)
        case "qwen": return Color(hex: 0xD946EF)
        case "grok": return textPrimary
        default: return chroma1
        }
    }

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
        case "ensemble": return "Ensemble"
        case "qwen": return "Qwen"
        case .some(let other): return other.prefix(1).uppercased() + other.dropFirst()
        case nil: return "Agent"
        }
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
