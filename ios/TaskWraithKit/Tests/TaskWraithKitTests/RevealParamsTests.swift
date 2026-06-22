import Testing

@testable import TaskWraithKit

@Suite("RevealParams + advanceReveal (Swift twin)")
struct RevealParamsTests {
    let P = RevealParams.shared

    @Test func smoothstepClampsAndEases() {
        #expect(revealSmoothstep(-1) == 0)
        #expect(revealSmoothstep(0) == 0)
        #expect(revealSmoothstep(1) == 1)
        #expect(revealSmoothstep(2) == 1)
        #expect(abs(revealSmoothstep(0.5) - 0.5) < 1e-9)
    }

    @Test func fadeOpacityRunsFrontierToSolid() {
        #expect(revealFadeOpacity(0) == 0)
        #expect(revealFadeOpacity(Double(P.fadeTailChars)) == 1)
        #expect(revealFadeOpacity(Double(P.fadeTailChars) * 2) == 1)  // clamped
    }

    @Test func noBacklogReturnsTarget() {
        #expect(advanceReveal(prev: "abc", next: "abc", revealed: 3, isComplete: false, dt: 0.05) == 3)
        #expect(advanceReveal(prev: "abc", next: "abc", revealed: 5, isComplete: false, dt: 0.05) == 3)
    }

    @Test func convergesToFullContent() {
        let content = String(repeating: "The quick brown fox jumps. ", count: 8)
        let target = content.count
        var revealed = 0
        var frames = 0
        while revealed < target && frames < 10000 {
            revealed = advanceReveal(
                prev: content, next: content, revealed: revealed, isComplete: false, dt: 0.05)
            frames += 1
        }
        #expect(revealed == target)
        #expect(frames < target)
    }

    @Test func neverStallsWithTinyDt() {
        let r = advanceReveal(
            prev: "abcdefghij", next: "abcdefghij", revealed: 0, isComplete: false, dt: 0.0001)
        #expect(r >= 1)
    }

    @Test func streamingClampsHugeDt() {
        let content = String(repeating: "x", count: 5000)
        let r = advanceReveal(prev: content, next: content, revealed: 0, isComplete: false, dt: 100)
        #expect(r <= P.maxCharsPerFrame)
    }

    @Test func terminalDrainBypassesAntiSlam() {
        let content = String(repeating: "y", count: 5000)
        let r = advanceReveal(prev: content, next: content, revealed: 0, isComplete: true, dt: 0.1)
        #expect(r > P.maxCharsPerFrame * 10)
        #expect(r < 5000)
    }

    @Test func terminalFinishesWithinBudget() {
        let content = String(repeating: "z", count: 5000)
        let target = content.count
        var revealed = 0
        var frames = 0
        while revealed < target && frames < 100 {
            revealed = advanceReveal(
                prev: content, next: content, revealed: revealed, isComplete: true, dt: 0.05)
            frames += 1
        }
        #expect(revealed == target)
        // 50ms/frame, completeDrainMs=250 => ~5 frames + 1 slack.
        #expect(frames <= Int((P.completeDrainMs / 50).rounded(.up)) + 1)
    }

    @Test func divergenceRewindsToCommonPrefix() {
        let r = advanceReveal(
            prev: "hello world", next: "hello there", revealed: 11, isComplete: false, dt: 0.05)
        #expect(r < 11)
        #expect("hello there".hasPrefix(String(Array("hello there").prefix(r))))
    }

    @Test func graphemeSafetyNeverSplitsClusters() {
        let content = "start 👨‍👩‍👧‍👦 mid 🇬🇧 énd 你好世界 done"
        let chars = Array(content)
        let target = chars.count
        var revealed = 0
        var guardN = 0
        while revealed < target && guardN < 10000 {
            revealed = advanceReveal(
                prev: content, next: content, revealed: revealed, isComplete: false, dt: 0.05)
            // Slicing by Character (grapheme) is always a valid prefix.
            #expect(content.hasPrefix(String(chars.prefix(revealed))))
            guardN += 1
        }
        #expect(revealed == target)
    }
}
