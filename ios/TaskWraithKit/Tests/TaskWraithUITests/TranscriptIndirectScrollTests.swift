import Foundation
import Testing

#if canImport(UIKit)
    import UIKit
#endif

@testable import TaskWraithUI

@Suite("Transcript indirect scroll")
struct TranscriptIndirectScrollTests {
    /// Runs everywhere, because `configure(_:)` derives every flag from this
    /// spec rather than hard-coding them — so flipping a value here is exactly
    /// as breaking as mis-configuring the recognizer, and reds the same test.
    @Test func pointerScrollsAreRecognizedWithoutClaimingTouches() {
        let spec = TranscriptIndirectScrollPolicy.recognizerSpec

        // The entire defect in one flag. With this false the pointer lane
        // reports nothing, `lastUserTouchAt` stays at `.distantPast`, and the
        // bottom sentinel's `onDisappear` re-pins the transcript to the tail on
        // every scroll-up.
        #expect(spec.acceptsIndirectScrolls)

        // Direct touch already has a producer in `transcriptTouchTracking`'s
        // DragGesture. A second recognizer contending for the same touches
        // risks starving the scroll view's own pan — the failure
        // `TranscriptTouchTrackingPolicy.dragMinimumDistance` already had to
        // work around once on iPad.
        #expect(!spec.acceptsDirectTouches)

        // A pure observer must never swallow a tap on a transcript control.
        #expect(!spec.cancelsTouchesInView)
    }

    #if canImport(UIKit)
        @MainActor
        @Test func configuringARecognizerAppliesTheSpec() {
            let pan = UIPanGestureRecognizer()

            // A stock recognizer ships with an empty `allowedScrollTypesMask`.
            // That default IS the bug this file exists to fix: SwiftUI's
            // DragGesture is one of these, which is why it never saw a wheel.
            #expect(!TranscriptIndirectScrollPolicy.spec(of: pan).acceptsIndirectScrolls)

            TranscriptIndirectScrollPolicy.configure(pan)

            #expect(
                TranscriptIndirectScrollPolicy.spec(of: pan)
                    == TranscriptIndirectScrollPolicy.recognizerSpec)
        }

        @MainActor
        @Test func theProbeFindsTheScrollViewAboveIt() {
            let scrollView = UIScrollView()
            let intermediate = UIView()
            let probe = UIView()
            scrollView.addSubview(intermediate)
            intermediate.addSubview(probe)

            // SwiftUI puts several hosting views between the background probe
            // and the transcript's scroll view, so the walk has to climb rather
            // than check its immediate parent.
            #expect(
                TranscriptIndirectScrollTracker.Coordinator.enclosingScrollView(of: probe)
                    === scrollView)
        }

        @MainActor
        @Test func theProbeReportsNothingOutsideAScrollView() {
            let root = UIView()
            let probe = UIView()
            root.addSubview(probe)

            #expect(
                TranscriptIndirectScrollTracker.Coordinator.enclosingScrollView(of: probe) == nil)
        }
    #endif
}
