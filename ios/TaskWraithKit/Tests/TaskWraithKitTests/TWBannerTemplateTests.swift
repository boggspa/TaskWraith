import Foundation
import Testing

@testable import TaskWraithKit

@Suite("Banner template")
struct TWBannerTemplateTests {
    /// The load-bearing invariant of the whole template feature: a user who never
    /// opens the settings tab must see EXACTLY what they saw before it existed.
    /// These strings are the pre-template hard-coded output.
    @Test("default template reproduces the pre-template wording byte-for-byte")
    func defaultTemplateMatchesLegacyWording() {
        let input = CompletionBannerInput(
            title: "Codex", failed: false, preview: "Refactored the card. It is clean now.",
            filesChanged: 3, additions: 128, deletions: 44)
        let r = CompletionBannerRenderer.render(input, template: .default)
        #expect(r.title == "\u{2705} Codex")
        #expect(
            r.body == "Refactored the card. It is clean now.\n"
                + "\u{1F4DD} 3 files \u{00B7} \u{1F7E9} +128 \u{00B7} \u{1F7E5} -44")
    }

    @Test("default template: empty content falls back per status")
    func defaultFallbacks() {
        for (status, expected) in [
            (CompletionBannerStatus.success, "Run finished."),
            (.warning, "Run finished with warnings."),
            (.error, "Run needs your attention."),
            (.quota, "Rate limit or quota wall."),
            (.cancelled, "Run cancelled.")
        ] {
            let r = CompletionBannerRenderer.render(
                CompletionBannerInput(
                    title: "A", failed: false, preview: nil,
                    filesChanged: 0, additions: 0, deletions: 0, status: status),
                template: .default)
            #expect(r.body == expected)
        }
    }

    @Test("a custom template changes wording without changing the data")
    func customTemplate() {
        var t = TWBannerTemplate.default
        t.titleFormat = "{agent} \u{2014} {status}"
        t.bodyLines = ["{diff}", "{summary}"]
        t.statusEmoji["success"] = "\u{1F680}"
        t.diffSegments = [
            TWDiffSegment(field: .additions, format: "+{value}"),
            TWDiffSegment(field: .deletions, format: "-{value}")
        ]
        t.diffSeparator = "/"
        let r = CompletionBannerRenderer.render(
            CompletionBannerInput(
                title: "Claude", failed: false, preview: "Done.",
                filesChanged: 3, additions: 10, deletions: 2),
            template: t)
        #expect(r.title == "Claude \u{2014} success")
        #expect(r.body == "+10/-2\nDone.")
    }

    @Test("unknown tokens are stripped, not leaked to the lock screen")
    func unknownTokensStripped() {
        var t = TWBannerTemplate.default
        t.titleFormat = "{agent} {notAToken}"
        t.bodyLines = ["{fils} {summary}"]
        let r = CompletionBannerRenderer.render(
            CompletionBannerInput(
                title: "Codex", failed: false, preview: "Hi.",
                filesChanged: 0, additions: 0, deletions: 0),
            template: t)
        #expect(r.title == "Codex")
        #expect(r.body == "Hi.")
        #expect(!r.body.contains("{"))
    }

    @Test("an unclosed brace is emitted literally rather than eating the line")
    func unclosedBrace() {
        #expect(CompletionBannerRenderer.substitute("a {b", ["b": "X"]) == "a {b")
        #expect(CompletionBannerRenderer.substitute("{a} {b", ["a": "X"]) == "X {b")
    }

    @Test("a template that renders an empty title falls back to the agent name")
    func emptyTitleFallsBack() {
        var t = TWBannerTemplate.default
        t.titleFormat = "{notAToken}"
        let r = CompletionBannerRenderer.render(
            CompletionBannerInput(
                title: "Codex", failed: false, preview: "Hi.",
                filesChanged: 0, additions: 0, deletions: 0),
            template: t)
        #expect(r.title == "Codex")
    }

    @Test("a template that renders an empty body falls back to the status line")
    func emptyBodyFallsBack() {
        var t = TWBannerTemplate.default
        t.bodyLines = ["{nope}", "  "]
        let r = CompletionBannerRenderer.render(
            CompletionBannerInput(
                title: "Codex", failed: false, preview: "Hi.",
                filesChanged: 1, additions: 1, deletions: 0),
            template: t)
        #expect(r.body == "Run finished.")
    }

    @Test("preview text keeps its own internal spacing")
    func preservesUserSpacing() {
        let r = CompletionBannerRenderer.render(
            CompletionBannerInput(
                title: "Codex", failed: false, preview: "Did  a  thing.",
                filesChanged: 0, additions: 0, deletions: 0),
            template: .default)
        #expect(r.body == "Did  a  thing.")
    }

    @Test("diff line is suppressed for every non-success status")
    func diffSuppressedOnFailure() {
        for status in [
            CompletionBannerStatus.warning, .error, .quota, .cancelled
        ] {
            let r = CompletionBannerRenderer.render(
                CompletionBannerInput(
                    title: "Codex", failed: true, preview: "Broke.",
                    filesChanged: 9, additions: 9, deletions: 9, status: status),
                template: .default)
            #expect(!r.body.contains("+9"))
        }
    }

    // MARK: - decode / sanitize

    @Test("decode returns .default for junk, wrong version, and nil")
    func decodeFallsBack() {
        #expect(TWBannerTemplate.decode(nil) == .default)
        #expect(TWBannerTemplate.decode(Data("not json".utf8)) == .default)
        var future = TWBannerTemplate.default
        future.version = TWBannerTemplate.currentVersion + 1
        #expect(TWBannerTemplate.decode(future.encoded()) == .default)
    }

    @Test("round-trips through JSON")
    func roundTrip() {
        var t = TWBannerTemplate.default
        t.titleFormat = "{agent}!"
        #expect(TWBannerTemplate.decode(t.encoded()) == t.sanitized())
    }

    @Test("sanitize clamps pathological values")
    func sanitizeClamps() {
        var t = TWBannerTemplate.default
        t.previewSentences = 9_999
        t.previewCap = 100_000
        t.bodyLines = Array(repeating: String(repeating: "x", count: 900), count: 40)
        t.titleFormat = String(repeating: "t", count: 900)
        let s = t.sanitized()
        #expect(s.previewSentences == 6)
        #expect(s.previewCap == 400)
        #expect(s.bodyLines.count == 4)
        #expect(s.bodyLines.allSatisfy { $0.count == 200 })
        #expect(s.titleFormat.count == 120)

        var low = TWBannerTemplate.default
        low.previewSentences = 0
        low.previewCap = 1
        #expect(low.sanitized().previewSentences == 1)
        #expect(low.sanitized().previewCap == 20)
    }

    @Test("store saves, loads, and clears against an isolated suite")
    func storeRoundTrip() {
        let suite = "tw.banner.template.tests"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        defer { defaults.removePersistentDomain(forName: suite) }

        #expect(TWBannerTemplateStore.load(defaults: defaults) == .default)
        var t = TWBannerTemplate.default
        t.titleFormat = "{agent} done"
        TWBannerTemplateStore.save(t, defaults: defaults)
        #expect(TWBannerTemplateStore.load(defaults: defaults).titleFormat == "{agent} done")
        TWBannerTemplateStore.clear(defaults: defaults)
        #expect(TWBannerTemplateStore.load(defaults: defaults) == .default)
    }
}
