// Shared motion vocabulary for the main-thread composer's compact ⇄ focused
// transition (see ThreadDetailView.composerShellStack). Centralizing the
// curves + transitions here keeps every focus-gated row group — the above-rows
// stack, the telemetry rail, and the compact diff pill — animating in lockstep,
// and gives Reduce Motion a single, auditable off-switch instead of N scattered
// guards at the call sites.
//
// Deliberate constraints (see the composer focus-transition task notes):
//   • The full shell uses a DAMPED spring, never `.bouncy`. The composer frames
//     a text field + telemetry rail; an overshooting wobble reads as a bug, not
//     polish. The response/damping below match the existing TWSharedViews drag
//     spring so the app feels of a piece.
//   • Transitions belong on stable ROW / CARD groups, not deep children — the
//     composer shell masks and clamps its content, so a slide applied to an
//     inner child gets clipped. The host applies these to the focus-gated `if`
//     blocks (whole groups), never to the TextField or composer core.
//   • Reduce Motion collapses every slide / scale / spring to a short opacity
//     crossfade — no positional motion at all.

import SwiftUI

enum ComposerMotion {
    /// Focus in/out for the whole composer shell. A damped spring so the
    /// above-rows + telemetry rail feel like they spring out from just behind
    /// the composer and settle without bounce. NOT `.bouncy`.
    static let focusSpring: Animation = .spring(
        response: 0.32, dampingFraction: 0.82, blendDuration: 0.04)

    /// Neutral fade for inline control swaps inside the composer
    /// (approval / guest / separator chips) that should not pull the eye.
    static let inlineFade: Animation = .easeInOut(duration: 0.16)

    /// Reduce Motion fallback: a near-instant opacity crossfade. Short enough to
    /// read as "instant" while still avoiding a hard pop. No spring, no slide.
    static let reducedFade: Animation = .easeOut(duration: 0.12)

    /// Animation to drive a `composerFocused` toggle with, honoring Reduce
    /// Motion (spring → flat fade).
    static func focusAnimation(reduceMotion: Bool) -> Animation {
        reduceMotion ? reducedFade : focusSpring
    }

    /// Animation for inline control swaps, honoring Reduce Motion.
    static func inlineAnimation(reduceMotion: Bool) -> Animation {
        reduceMotion ? reducedFade : inlineFade
    }

    /// Above-rows group (changes pills, roster, queued). Springs UP from behind
    /// the composer on insert; fades on removal so a dropping keyboard never
    /// yanks the rows down THROUGH the input. Reduce Motion ⇒ opacity both ways.
    static func aboveRowsTransition(reduceMotion: Bool) -> AnyTransition {
        reduceMotion
            ? .opacity
            : .asymmetric(
                insertion: .move(edge: .bottom).combined(with: .opacity),
                removal: .opacity)
    }

    /// Telemetry rail. Drops DOWN from behind the composer's bottom edge on
    /// insert; fades on removal. Reduce Motion ⇒ opacity both ways.
    static func telemetryTransition(reduceMotion: Bool) -> AnyTransition {
        reduceMotion
            ? .opacity
            : .asymmetric(
                insertion: .move(edge: .top).combined(with: .opacity),
                removal: .opacity)
    }

    /// Compact diff pill (shown only while UNFOCUSED). A small lift as the
    /// keyboard drops on insert; a plain fade when focus returns. Reduce Motion
    /// ⇒ opacity both ways.
    static func compactPillTransition(reduceMotion: Bool) -> AnyTransition {
        reduceMotion
            ? .opacity
            : .asymmetric(
                insertion: .move(edge: .bottom).combined(with: .opacity),
                removal: .opacity)
    }
}
