import Foundation
import Testing

@testable import TaskWraithKit

/// Isolated suite per test — the real store is the shared App Group, and a test
/// that wrote there would leak into the app and the widget on a dev device.
private func scratchDefaults(_ name: String) -> UserDefaults {
    let defaults = UserDefaults(suiteName: "tw.tests.\(name)")!
    defaults.removePersistentDomain(forName: "tw.tests.\(name)")
    return defaults
}

@Suite("Activity preferences")
struct TWActivityPreferencesTests {
    @Test("nothing stored means enabled, default archetype, and NO synced palette")
    func emptyStore() {
        let d = scratchDefaults("empty")
        #expect(TWActivityPreferences.isEnabled(defaults: d))
        #expect(TWActivityPreferences.archetype(defaults: d) == TWActivityArchetype.fallback)
        // nil, not 0. `integer(forKey:)` would return 0 for a missing key, which
        // is indistinguishable from a stored black — and the controller would
        // then paint a finished run in 0x000000 instead of falling back.
        #expect(TWActivityPreferences.syncedSuccessHex(defaults: d) == nil)
        #expect(TWActivityPreferences.syncedFailureHex(defaults: d) == nil)
    }

    @Test("a Mac broadcast lands in full")
    func appliesBroadcast() {
        let d = scratchDefaults("apply")
        TWActivityPreferences.apply(
            TWActivityAppearance(
                enabled: false, archetype: "attention",
                successColor: "#11AA33", failureColor: "#FF0000"),
            defaults: d)
        #expect(!TWActivityPreferences.isEnabled(defaults: d))
        #expect(TWActivityPreferences.archetype(defaults: d) == .attention)
        #expect(TWActivityPreferences.syncedSuccessHex(defaults: d) == 0x11AA33)
        #expect(TWActivityPreferences.syncedFailureHex(defaults: d) == 0xFF0000)
    }

    /// Each field is applied independently on purpose. A newer Mac sending one
    /// value this build cannot parse must not also discard the three it can.
    @Test("one malformed field does not discard the others")
    func partialApplyKeepsGoodFields() {
        let d = scratchDefaults("partial")
        TWActivityPreferences.apply(
            TWActivityAppearance(
                enabled: true, archetype: "holographic",
                successColor: "#2DB777", failureColor: "not-a-colour"),
            defaults: d)
        #expect(TWActivityPreferences.archetype(defaults: d) == TWActivityArchetype.fallback)
        #expect(TWActivityPreferences.syncedSuccessHex(defaults: d) == 0x2DB777)
        #expect(TWActivityPreferences.syncedFailureHex(defaults: d) == nil)
    }

    /// An older Mac sends no `activity` block at all. The dispatch skips
    /// `apply` entirely in that case; this pins that a broadcast carrying an
    /// EMPTY block is also non-destructive, since sanitizeActivityAppearance on
    /// the Mac fills defaults only for fields it actually sends.
    @Test("an all-nil appearance changes nothing that was already set")
    func emptyAppearanceIsNonDestructive() {
        let d = scratchDefaults("nondestructive")
        TWActivityPreferences.setArchetype(.ensemble, defaults: d)
        TWActivityPreferences.apply(TWActivityAppearance(), defaults: d)
        #expect(TWActivityPreferences.archetype(defaults: d) == .ensemble)
    }

    @Test("hex parsing matches the Mac's normaliser, and rejects the rest")
    func hexParsing() {
        #expect(TWActivityPreferences.parseHex("#2DB777") == 0x2DB777)
        #expect(TWActivityPreferences.parseHex("2db777") == 0x2DB777)
        #expect(TWActivityPreferences.parseHex("#0f0") == 0x00FF00)
        #expect(TWActivityPreferences.parseHex("  #FFFFFF  ") == 0xFFFFFF)
        for junk in ["", "#", "#12", "#12345", "rgb(0,0,0)", "red", "#GGGGGG"] {
            #expect(TWActivityPreferences.parseHex(junk) == nil, "should reject \(junk)")
        }
    }

    /// The PICKABLE ids must match `ACTIVITY_ARCHETYPES` in
    /// src/shared/bannerTemplate.ts, which is itself pinned 1:1 to the Mac's
    /// radio buttons (`ACTIVITY_ARCHETYPE_PRESETS`). A layout added on one side
    /// only is either unpickable or a dead radio button on the Mac.
    ///
    /// Deliberately NOT `allCases`: `.workspace` is DERIVED — forced by the
    /// controller for a multi-run roll-up — so it is renderable but never a
    /// preference, and it is correctly absent from the TypeScript list.
    /// `TWRunActivityTests.archetypeIds` pins the full wire set.
    @Test("selectable archetype ids match the TypeScript contract")
    func archetypeIdsMatchTypeScript() {
        #expect(
            Set(TWActivityArchetype.userSelectable.map(\.rawValue))
                == ["minimal", "diff", "attention", "ensemble"])
        // The derived layout stays out of the picker's contract...
        #expect(!TWActivityArchetype.workspace.isUserSelectable)
        // ...but must still exist as a case, or the widget cannot render it.
        #expect(TWActivityArchetype.allCases.contains(.workspace))
    }

    /// A newer Mac naming a DERIVED layout as the preference must not stick.
    /// `.workspace` carries counts for two or more runs and has no room for a
    /// single run's detail, so honouring it would flatten every ordinary
    /// activity into the roll-up.
    @Test("a derived archetype is refused as a stored preference")
    func derivedArchetypeIsNotStorable() {
        let d = scratchDefaults("derived")
        TWActivityPreferences.setArchetype(.attention, defaults: d)
        TWActivityPreferences.apply(
            TWActivityAppearance(archetype: "workspace"), defaults: d)
        #expect(TWActivityPreferences.archetype(defaults: d) == .attention)
    }

    @Test("the appearance block decodes off a real broadcast payload")
    func decodesFromBroadcast() throws {
        let json = Data(
            #"""
            {"template":{"version":1,"titleFormat":"{agent}","bodyLines":["{summary}"],
            "statusEmoji":{},"statusFallback":{},"diffSegments":[],"diffSeparator":" · ",
            "previewSentences":2,"previewCap":180},
            "activity":{"enabled":true,"archetype":"ensemble",
            "successColor":"#2DB777","failureColor":"#EC3D35"}}
            """#.utf8)
        let message = try JSONDecoder().decode(BannerTemplateMessage.self, from: json)
        let activity = try #require(message.activity)
        #expect(activity.archetype == "ensemble")
        #expect(activity.successColor == "#2DB777")
    }

    /// A Mac that predates Live Activities sends only `template`. Decoding must
    /// still succeed, or the banner template stops updating too.
    @Test("a broadcast with no activity block still decodes")
    func decodesWithoutActivityBlock() throws {
        let json = Data(
            #"""
            {"template":{"version":1,"titleFormat":"{agent}","bodyLines":["{summary}"],
            "statusEmoji":{},"statusFallback":{},"diffSegments":[],"diffSeparator":" · ",
            "previewSentences":2,"previewCap":180}}
            """#.utf8)
        let message = try JSONDecoder().decode(BannerTemplateMessage.self, from: json)
        #expect(message.activity == nil)
    }
}
