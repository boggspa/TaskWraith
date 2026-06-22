import Foundation

/// Swift twin of `src/shared/revealParams.ts` + `src/renderer/src/lib/advanceReveal.ts`.
///
/// The type-out / reveal cadence is shared across Electron and iOS so a user
/// switching Mac <-> phone sees the same feel. The TypeScript module is the
/// source of truth; THESE VALUES MUST MATCH IT. A drift-guard test
/// (`src/shared/revealParams.test.ts`) reads this file and fails CI if any
/// value diverges (same pattern as AppIconAvailability.swift).
///
/// The reveal is DISPLAY-ONLY: a length cursor over the byte-exact accumulated
/// string. It never writes back into the model's streaming text, so it cannot
/// drop or reorder content — the final rendered text always equals the full
/// content. Rates are TIME-BASED (chars/sec) so a 60Hz and a 120Hz ProMotion
/// device match. The cursor unit is the grapheme cluster — Swift `Character`
/// is grapheme-aware, so `Array(string)` already gives the right units and a
/// ZWJ emoji is never split.
public struct RevealParams: Sendable, Equatable {
    public var baseCharsPerSec: Double
    public var catchUpPerSec: Double
    public var maxCharsPerSec: Double
    public var maxCharsPerFrame: Int
    public var settleCharsPerSec: Double
    public var fadeTailChars: Int
    public var completeDrainMs: Double
    public var clearCeilingMs: Double
    public var coldSnapChars: Int

    public init(
        baseCharsPerSec: Double, catchUpPerSec: Double, maxCharsPerSec: Double,
        maxCharsPerFrame: Int, settleCharsPerSec: Double, fadeTailChars: Int,
        completeDrainMs: Double, clearCeilingMs: Double, coldSnapChars: Int
    ) {
        self.baseCharsPerSec = baseCharsPerSec
        self.catchUpPerSec = catchUpPerSec
        self.maxCharsPerSec = maxCharsPerSec
        self.maxCharsPerFrame = maxCharsPerFrame
        self.settleCharsPerSec = settleCharsPerSec
        self.fadeTailChars = fadeTailChars
        self.completeDrainMs = completeDrainMs
        self.clearCeilingMs = clearCeilingMs
        self.coldSnapChars = coldSnapChars
    }

    /// The cross-platform contract. Mirrors REVEAL_PARAMS in revealParams.ts.
    public static let shared = RevealParams(
        baseCharsPerSec: 55,
        catchUpPerSec: 3.0,
        maxCharsPerSec: 900,
        maxCharsPerFrame: 96,
        settleCharsPerSec: 170,
        fadeTailChars: 26,
        completeDrainMs: 250,
        clearCeilingMs: 300,
        coldSnapChars: 220
    )
}

/// smoothstep(t) = 3t^2 - 2t^3, clamped to [0,1].
public func revealSmoothstep(_ t: Double) -> Double {
    let x = min(1, max(0, t))
    return x * x * (3 - 2 * x)
}

/// Shared opacity-ramp curve. `distanceFromFrontier` is in graphemes back from
/// the reveal frontier: 0 = newest (≈0 opacity, fading in), `fadeTailChars` =
/// fully solid. Both platforms evaluate this so the fade easing matches.
public func revealFadeOpacity(
    _ distanceFromFrontier: Double, fadeTailChars: Int = RevealParams.shared.fadeTailChars
) -> Double {
    if fadeTailChars <= 0 { return 1 }
    return revealSmoothstep(distanceFromFrontier / Double(fadeTailChars))
}

/// Snap a candidate grapheme cursor FORWARD to the next word boundary so the
/// rendered slice ends on a whole word (a single-token span like `**bold**`
/// has no inner whitespace and so is revealed whole). Look-ahead capped at
/// `maxLookahead`; falls back to the raw index for a long unbroken run.
public func snapForwardToWordBoundary(
    _ graphemes: [Character], _ index: Int, _ maxLookahead: Int
) -> Int {
    if index >= graphemes.count { return graphemes.count }
    if index <= 0 { return max(0, index) }
    let limit = min(graphemes.count, index + max(0, maxLookahead))
    var j = index
    while j < limit {
        if graphemes[j].isWhitespace { return min(graphemes.count, j + 1) }
        j += 1
    }
    return index
}

/// The pure reveal-cursor step. Twin of `advanceReveal` in advanceReveal.ts.
/// Returns the next cursor (grapheme count into `next`), in [0, target].
/// Always converges; on a terminal reason drains within `completeDrainMs`.
public func advanceReveal(
    prev: String, next: String, revealed: Int, isComplete: Bool, dt: Double,
    params: RevealParams = .shared
) -> Int {
    let P = params
    let dtc = max(0, min(dt, 0.1))

    let nextChars = Array(next)
    let target = nextChars.count

    var rev = revealed
    if prev != next {
        let prevChars = Array(prev)
        let maxN = min(prevChars.count, nextChars.count)
        var common = 0
        while common < maxN && prevChars[common] == nextChars[common] { common += 1 }
        if rev > common { rev = common }
    }
    if rev < 0 { rev = 0 }
    if rev > target { rev = target }

    let backlog = target - rev
    if backlog <= 0 { return target }

    var rate = min(P.baseCharsPerSec + P.catchUpPerSec * Double(backlog), P.maxCharsPerSec)
    var stepCap = Double(P.maxCharsPerFrame)
    if isComplete {
        // target-based linear drain (not backlog-proportional, which never
        // reaches the end within the window), anti-slam bypassed.
        rate = max(rate, Double(target) / (P.completeDrainMs / 1000))
        stepCap = .infinity
    }

    let step = min(rate * dtc, stepCap)
    var nextRevealed = Int((Double(rev) + step).rounded(.down))
    if nextRevealed <= rev { nextRevealed = rev + 1 }
    if nextRevealed >= target { return target }

    return min(target, snapForwardToWordBoundary(nextChars, nextRevealed, P.fadeTailChars))
}
