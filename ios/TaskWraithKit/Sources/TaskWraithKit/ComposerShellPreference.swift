// ComposerShellPreference.swift — the iOS-local composer-shell choice and the
// pure precedence resolver. Pure (Foundation only); lives in TaskWraithKit and
// is unit-tested. Precedence: local override → Mac-projected style → default.
// No iOS→Mac writeback; only the preference (mode/value) is persisted, never
// the effective style. See ios/COMPOSER-SHELL-PARITY.md (E.4).

import Foundation

public enum TWComposerShellPreference: Equatable, Sendable {
    /// Mirror whatever the Mac projects (the default; auto-follows desktop).
    case followMac
    /// Pin a specific style on THIS device, ignoring the Mac's projection.
    case override(TWComposerStyle)

    /// Scalar persisted in UserDefaults: "followMac" or "override:<raw>".
    public var persisted: String {
        switch self {
        case .followMac: return "followMac"
        case .override(let style): return "override:\(style.raw)"
        }
    }

    public init(persisted: String?) {
        guard let value = persisted, !value.isEmpty else { self = .followMac; return }
        if value == "followMac" { self = .followMac; return }
        let prefix = "override:"
        if value.hasPrefix(prefix) {
            let raw = String(value.dropFirst(prefix.count))
            if !raw.isEmpty {
                self = .override(TWComposerStyle(raw: raw))
                return
            }
        }
        self = .followMac
    }
}

/// The effective composer style to render, given the local preference and the
/// latest Mac-projected style. Pure precedence — local override wins, else the
/// Mac's style, else the native default. The result may be `.unknown(...)`
/// (preserved for diagnostics); callers use `.renderStyle` for visuals.
public func twEffectiveComposerStyle(
    preference: TWComposerShellPreference,
    projected: TWComposerStyle?
) -> TWComposerStyle {
    switch preference {
    case .override(let style): return style
    case .followMac: return projected ?? .defaultShell
    }
}
