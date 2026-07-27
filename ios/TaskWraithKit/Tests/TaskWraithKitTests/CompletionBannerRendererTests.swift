import Foundation
import Testing

@testable import TaskWraithKit

@Suite("Completion banner renderer")
struct CompletionBannerRendererTests {
    @Test("success banner: name title + summary + emoji diff line")
    func successBanner() {
        let r = CompletionBannerRenderer.render(
            CompletionBannerInput(
                title: "Codex", failed: false, preview: "Refactored the card. It is clean now.",
                filesChanged: 3, additions: 128, deletions: 44))
        #expect(r.title == "\u{2705} Codex")
        #expect(r.body.contains("Refactored the card."))
        #expect(r.body.contains("\u{1F4DD} 3 files"))
        #expect(r.body.contains("\u{1F7E9} +128"))
        #expect(r.body.contains("\u{1F7E5} -44"))
    }

    @Test("failed banner: warning glyph + diff line suppressed")
    func failedBanner() {
        let r = CompletionBannerRenderer.render(
            CompletionBannerInput(
                title: "Claude", failed: true, preview: "Something broke.",
                filesChanged: 3, additions: 1, deletions: 1))
        #expect(r.title == "\u{26A0}\u{FE0F} Claude")
        #expect(r.body.contains("Something broke."))
        #expect(!r.body.contains("\u{1F7E9}"))
    }

    @Test("empty title → TaskWraith; empty content → default line")
    func fallbacks() {
        let s = CompletionBannerRenderer.render(
            CompletionBannerInput(
                title: nil, failed: false, preview: nil, filesChanged: 0, additions: 0, deletions: 0))
        #expect(s.title == "\u{2705} TaskWraith")
        #expect(s.body == "Run finished.")
        let f = CompletionBannerRenderer.render(
            CompletionBannerInput(
                title: "", failed: true, preview: "  ", filesChanged: 0, additions: 0, deletions: 0))
        #expect(f.title == "\u{26A0}\u{FE0F} TaskWraith")
        #expect(f.body == "Run needs your attention.")
        // A SUCCESSFUL decrypt of degenerate all-empty-string content (a run that
        // changed nothing) must still yield a NON-EMPTY title AND body — the
        // NSE's "never worse than the generic banner" guarantee rests on these
        // two fallbacks, so pin them explicitly.
        let e = CompletionBannerRenderer.render(
            CompletionBannerInput(
                title: "", failed: false, preview: "", filesChanged: 0, additions: 0, deletions: 0))
        #expect(e.title == "\u{2705} TaskWraith")
        #expect(e.body == "Run finished.")
    }

    @Test("diffBannerLine: file count leads, singular/plural, nil when nothing changed")
    func diffLine() {
        #expect(
            CompletionBannerRenderer.diffBannerLine(files: 1, additions: 0, deletions: 0)
                == "\u{1F4DD} 1 file")
        #expect(
            CompletionBannerRenderer.diffBannerLine(files: 2, additions: 0, deletions: 0)
                == "\u{1F4DD} 2 files")
        // The file count is kept ALONGSIDE the +/- counts rather than being a
        // fallback for when both are zero — this is what the foreground banner
        // always showed, and unifying the render paths must not lose it.
        #expect(
            CompletionBannerRenderer.diffBannerLine(files: 2, additions: 23125, deletions: 10055)
                == "\u{1F4DD} 2 files \u{00B7} \u{1F7E9} +23,125 \u{00B7} \u{1F7E5} -10,055")
        // Counts can arrive without a file count (older projections) — still renders.
        #expect(
            CompletionBannerRenderer.diffBannerLine(files: 0, additions: 5, deletions: 0)
                == "\u{1F7E9} +5")
        #expect(CompletionBannerRenderer.diffBannerLine(files: 0, additions: 0, deletions: 0) == nil)
    }

    @Test("quota and cancelled banners use distinct status copy")
    func quotaAndCancelled() {
        let quota = CompletionBannerRenderer.render(
            CompletionBannerInput(
                title: "Codex", failed: true, preview: nil,
                filesChanged: 0, additions: 0, deletions: 0, status: .quota))
        #expect(quota.title == "\u{274C} Codex")
        #expect(quota.body == "Rate limit or quota wall.")

        let cancelled = CompletionBannerRenderer.render(
            CompletionBannerInput(
                title: "Codex", failed: false, preview: nil,
                filesChanged: 0, additions: 0, deletions: 0, status: .cancelled))
        #expect(cancelled.title == "\u{26A0}\u{FE0F} Codex")
        #expect(cancelled.body == "Run cancelled.")
    }

    @Test("bannerSentences: 2-sentence + 180-char cap")
    func sentences() {
        #expect(CompletionBannerRenderer.bannerSentences("One. Two. Three.") == "One. Two.")
        #expect(CompletionBannerRenderer.bannerSentences("   ") == nil)
        let capped = CompletionBannerRenderer.bannerSentences(String(repeating: "x", count: 300))!
        #expect(capped.count == 181)  // 180 + ellipsis
        #expect(capped.hasSuffix("\u{2026}"))
    }
}
