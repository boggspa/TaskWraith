// Unit tests for the composer-shell plumbing (style model, preference,
// precedence, staleness, payload decode). Pure TaskWraithKit logic — no SwiftUI.
// See ios/COMPOSER-SHELL-PARITY.md (Part E).

import Foundation
import Testing

@testable import TaskWraithKit

@Suite("Composer shell — style model")
struct ComposerShellStyleTests {
    @Test("known raws round-trip; the canonical list has 14 styles")
    func knownRoundTrip() {
        #expect(TWComposerStyle.known.count == 14)
        for style in TWComposerStyle.known {
            #expect(TWComposerStyle(raw: style.raw) == style)
            #expect(style.isKnown)
            #expect(style.renderStyle == style)
        }
        #expect(TWComposerStyle(raw: "default") == .defaultShell)
        #expect(TWComposerStyle(raw: "obsidian") == .obsidian)
        // CS14 — the 14th shell 'chatgpt' (VISUAL-ONLY codex×cursor cross).
        #expect(TWComposerStyle(raw: "chatgpt") == .chatgpt)
        #expect(TWComposerStyle.chatgpt.raw == "chatgpt")
        #expect(TWComposerStyle.chatgpt.label == "ChatGPT")
        #expect(TWComposerStyle.chatgpt.isKnown)
        #expect(TWComposerStyle.chatgpt.renderStyle == .chatgpt)
    }

    @Test("unknown raw is preserved but renders as default")
    func unknownPreserved() {
        let style = TWComposerStyle(raw: "hyperdrive")
        #expect(style == .unknown("hyperdrive"))
        #expect(style.isKnown == false)
        #expect(style.raw == "hyperdrive")          // preserved for diagnostics
        #expect(style.renderStyle == .defaultShell) // visual fallback
    }
}

@Suite("Composer shell — preference + precedence")
struct ComposerShellPreferenceTests {
    @Test("preference persists + restores")
    func persistRoundTrip() {
        #expect(TWComposerShellPreference(persisted: nil) == .followMac)
        #expect(TWComposerShellPreference(persisted: "followMac") == .followMac)
        #expect(TWComposerShellPreference.followMac.persisted == "followMac")

        let pref = TWComposerShellPreference.override(.codex)
        #expect(pref.persisted == "override:codex")
        #expect(TWComposerShellPreference(persisted: "override:codex") == .override(.codex))

        // Garbage / empty → followMac (safe default).
        #expect(TWComposerShellPreference(persisted: "garbage") == .followMac)
        #expect(TWComposerShellPreference(persisted: "override:") == .followMac)
        #expect(TWComposerShellPreference(persisted: "") == .followMac)
    }

    @Test("override of an unknown raw survives persistence")
    func overrideUnknown() {
        let restored = TWComposerShellPreference(persisted: "override:warp")
        #expect(restored == .override(.unknown("warp")))
    }

    @Test("precedence: override → projected → default")
    func precedence() {
        // Override always wins, even over a projected style.
        #expect(twEffectiveComposerStyle(preference: .override(.terminal), projected: .codex) == .terminal)
        // Follow Mac uses the projected style.
        #expect(twEffectiveComposerStyle(preference: .followMac, projected: .grok) == .grok)
        // Follow Mac with nothing projected → native default.
        #expect(twEffectiveComposerStyle(preference: .followMac, projected: nil) == .defaultShell)
    }
}

@Suite("Composer shell — shellAppearance decode + staleness")
struct RemoteShellAppearanceTests {
    @Test("decodes the composerStyle subset and ignores unmodeled fields")
    func decodeSubset() throws {
        let json = """
            {
              "schemaVersion": 1,
              "generatedAt": "2026-06-17T10:00:00.000Z",
              "appearanceMode": "soft_glass",
              "composerStyle": "obsidian",
              "reduceMotion": true,
              "reduceTransparency": false,
              "compactDensity": false,
              "preferredColorScheme": "dark",
              "colors": { "accent": "#5a8cff" },
              "futureField": { "nested": [1, 2, 3] }
            }
            """
        let appearance = try JSONDecoder().decode(TWRemoteShellAppearance.self, from: Data(json.utf8))
        #expect(appearance.composerStyle == "obsidian")
        #expect(appearance.style == .obsidian)
        #expect(appearance.generatedAt == "2026-06-17T10:00:00.000Z")
        #expect(appearance.reduceMotion == true)
        #expect(appearance.reduceTransparency == false)
        #expect(appearance.appearanceMode == "soft_glass")
        #expect(appearance.preferredColorScheme == "dark")
    }

    @Test("missing composerStyle falls back to default; unknown style preserved")
    func decodeFallback() throws {
        let empty = try JSONDecoder().decode(TWRemoteShellAppearance.self, from: Data("{}".utf8))
        #expect(empty.composerStyle == "default")
        #expect(empty.style == .defaultShell)

        let exotic = try JSONDecoder().decode(
            TWRemoteShellAppearance.self,
            from: Data(#"{"composerStyle":"plaid"}"#.utf8))
        #expect(exotic.style == .unknown("plaid"))
    }

    @Test("staleness: newer applies, equal/older/first-ever handled")
    func staleness() {
        let t1 = "2026-06-17T10:00:00.000Z"
        let t2 = "2026-06-17T10:00:05.000Z"
        // First-ever (no prior) always applies.
        #expect(twShouldApplyShellAppearance(incoming: t1, last: nil))
        // Strictly newer applies.
        #expect(twShouldApplyShellAppearance(incoming: t2, last: t1))
        // Equal (same snapshot resent) is ignored.
        #expect(twShouldApplyShellAppearance(incoming: t1, last: t1) == false)
        // Older is ignored.
        #expect(twShouldApplyShellAppearance(incoming: t1, last: t2) == false)
        // Missing incoming timestamp is accepted (payload authoritative).
        #expect(twShouldApplyShellAppearance(incoming: nil, last: t1))
    }

    @Test("staleness tolerates fractional vs whole-second ISO8601")
    func stalenessMixedFormats() {
        let whole = "2026-06-17T10:00:00Z"
        let fractionalLater = "2026-06-17T10:00:00.500Z"
        #expect(twShouldApplyShellAppearance(incoming: fractionalLater, last: whole))
        #expect(twShouldApplyShellAppearance(incoming: whole, last: fractionalLater) == false)
    }
}
