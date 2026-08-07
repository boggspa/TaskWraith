import Foundation
import Testing

@testable import TaskWraithUI

@Suite("Thread inspector column budget")
struct ThreadInspectorColumnPolicyTests {
    private static let preferred: CGFloat = 390

    /// 11-inch iPad, portrait: an 834pt window minus the ~350pt sidebar leaves a
    /// ~484pt detail pane. The FIXED 390 that shipped before this took ~296pt of
    /// it (scaled), leaving the transcript ~180pt — narrower than its rows
    /// compress to, so ThreadDetailView laid out WIDER than its column and was
    /// clipped on both edges ("…our approval", "…auth"). A pane this narrow
    /// cannot afford two columns at all.
    @Test func narrowPortraitPaneRefusesTheInlineInspector() {
        #expect(
            ThreadInspectorColumnPolicy.inlineWidth(paneWidth: 484, preferred: Self.preferred)
                == nil
        )
    }

    /// 13-inch landscape: room for the full inspector and a roomy transcript.
    @Test func widePaneGetsThePreferredWidth() {
        #expect(
            ThreadInspectorColumnPolicy.inlineWidth(paneWidth: 1030, preferred: Self.preferred)
                == 390
        )
    }

    /// In between, the INSPECTOR yields. The transcript floor is the invariant;
    /// the inspector's preferred width is only ever a ceiling.
    @Test func middlePaneShrinksTheInspectorNotTheTranscript() {
        let width = ThreadInspectorColumnPolicy.inlineWidth(
            paneWidth: 800, preferred: Self.preferred)
        #expect(width == 380)
        #expect(800 - (width ?? 0) >= ThreadInspectorColumnPolicy.transcriptFloor)
    }

    /// The invariant that actually matters, swept rather than sampled: whenever a
    /// width comes back the transcript keeps its floor and the inspector keeps
    /// its own, and whenever nil comes back no split could have kept both.
    @Test func theTranscriptFloorHoldsAcrossEveryPaneWidth() {
        for pane in stride(from: CGFloat(320), through: 1600, by: 4) {
            if let width = ThreadInspectorColumnPolicy.inlineWidth(
                paneWidth: pane, preferred: Self.preferred)
            {
                #expect(
                    width >= ThreadInspectorColumnPolicy.inspectorFloor,
                    "pane \(pane) produced an unusable \(width)pt inspector")
                #expect(
                    pane - width >= ThreadInspectorColumnPolicy.transcriptFloor,
                    "pane \(pane) left the transcript \(pane - width)pt, under its floor")
            } else {
                #expect(
                    pane - ThreadInspectorColumnPolicy.inspectorFloor
                        < ThreadInspectorColumnPolicy.transcriptFloor,
                    "pane \(pane) refused a split it could actually afford")
            }
        }
    }

    /// A pane narrower than the transcript floor on its own still refuses —
    /// there is no width to give away, so the inspector must present over the
    /// transcript rather than beside it.
    @Test func aPaneUnderTheTranscriptFloorNeverSplits() {
        #expect(
            ThreadInspectorColumnPolicy.inlineWidth(paneWidth: 320, preferred: Self.preferred)
                == nil
        )
    }
}
