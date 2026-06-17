// ComposerShellStyle.swift — the 13 desktop composer "shell styles"
// (data-composer-style) modeled for iOS parity. Pure (Foundation only) so it
// lives in TaskWraithKit and is unit-testable; the SwiftUI recipes that turn a
// style into colors/geometry live in TaskWraithUI. Mirrors the desktop union
// `ComposerStyle` (src/main/store/types.ts). See ios/COMPOSER-SHELL-PARITY.md.
//
// `default` is a BESPOKE native shell, not a generic fallback. Unknown/future
// raw values are preserved verbatim for diagnostics but RENDER as `default`.

import Foundation

public enum TWComposerStyle: Equatable, Hashable, Sendable {
    case defaultShell
    case codex
    case claude
    case cursor
    case grok
    case gemini
    case kimi
    case modular
    case terminal
    case stub
    case satellite
    case obsidian
    case alabaster
    /// A raw value the Mac sent that this build doesn't model. Preserved for
    /// diagnostics; `renderStyle` falls back to `.defaultShell` for visuals.
    case unknown(String)

    public init(raw: String) {
        switch raw {
        case "default": self = .defaultShell
        case "codex": self = .codex
        case "claude": self = .claude
        case "cursor": self = .cursor
        case "grok": self = .grok
        case "gemini": self = .gemini
        case "kimi": self = .kimi
        case "modular": self = .modular
        case "terminal": self = .terminal
        case "stub": self = .stub
        case "satellite": self = .satellite
        case "obsidian": self = .obsidian
        case "alabaster": self = .alabaster
        default: self = .unknown(raw)
        }
    }

    /// The on-the-wire / persisted string (matches the desktop literal).
    public var raw: String {
        switch self {
        case .defaultShell: return "default"
        case .codex: return "codex"
        case .claude: return "claude"
        case .cursor: return "cursor"
        case .grok: return "grok"
        case .gemini: return "gemini"
        case .kimi: return "kimi"
        case .modular: return "modular"
        case .terminal: return "terminal"
        case .stub: return "stub"
        case .satellite: return "satellite"
        case .obsidian: return "obsidian"
        case .alabaster: return "alabaster"
        case .unknown(let raw): return raw
        }
    }

    public var isKnown: Bool {
        if case .unknown = self { return false }
        return true
    }

    /// Style to RENDER. Unknown → `.defaultShell` (the raw is still available
    /// via `raw` for diagnostics/telemetry).
    public var renderStyle: TWComposerStyle {
        isKnown ? self : .defaultShell
    }

    /// Human-readable label for the iOS picker.
    public var label: String {
        switch self {
        case .defaultShell: return "Default (Native)"
        case .codex: return "Codex"
        case .claude: return "Claude"
        case .cursor: return "Cursor"
        case .grok: return "Grok"
        case .gemini: return "Gemini"
        case .kimi: return "Kimi"
        case .modular: return "Modular"
        case .terminal: return "Terminal"
        case .stub: return "Ticket Stub"
        case .satellite: return "Satellite"
        case .obsidian: return "Obsidian"
        case .alabaster: return "Alabaster"
        case .unknown(let raw): return raw
        }
    }

    /// All known styles in canonical desktop order (drives the iOS picker).
    public static let known: [TWComposerStyle] = [
        .defaultShell, .codex, .claude, .cursor, .grok, .gemini, .kimi,
        .modular, .terminal, .stub, .satellite, .obsidian, .alabaster,
    ]
}
