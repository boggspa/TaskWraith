// Stamps transcript scroll intent for INDIRECT scrolls — trackpad, mouse
// wheel, and any other non-touch scroll source.

import SwiftUI

#if canImport(UIKit)
    import UIKit
#endif

/// How the indirect-scroll recognizer must be configured, expressed without
/// UIKit types so the invariant can be asserted on any platform.
///
/// The three flags are the whole contract, and each one is load-bearing:
///
/// - `acceptsIndirectScrolls` is the fix. A `UIPanGestureRecognizer` ships with
///   an **empty** `allowedScrollTypesMask`, and SwiftUI's `DragGesture` is
///   backed by exactly such a recognizer — which is why no amount of trackpad
///   or wheel scrolling ever reached the transcript's intent signal.
/// - `acceptsDirectTouches` stays false. Touch stamping is already
///   `DragGesture`'s job in `transcriptTouchTracking`; a second recognizer
///   contending for the same touches would risk starving the scroll view's own
///   pan, which is the bug `TranscriptTouchTrackingPolicy.dragMinimumDistance`
///   already had to work around once on iPad.
/// - `cancelsTouchesInView` stays false so a pure observer can never swallow a
///   tap on a transcript control.
struct TranscriptIndirectScrollRecognizerSpec: Equatable {
    var acceptsIndirectScrolls: Bool
    var acceptsDirectTouches: Bool
    var cancelsTouchesInView: Bool
}

enum TranscriptIndirectScrollPolicy {
    static let recognizerSpec = TranscriptIndirectScrollRecognizerSpec(
        acceptsIndirectScrolls: true,
        acceptsDirectTouches: false,
        cancelsTouchesInView: false)

    #if canImport(UIKit)
        static func configure(_ pan: UIPanGestureRecognizer) {
            let spec = recognizerSpec
            pan.allowedScrollTypesMask = spec.acceptsIndirectScrolls ? .all : []
            pan.allowedTouchTypes = spec.acceptsDirectTouches ? [NSNumber(value: 0)] : []
            pan.cancelsTouchesInView = spec.cancelsTouchesInView
            pan.delaysTouchesBegan = false
            pan.delaysTouchesEnded = false
        }

        /// Reads a configured recognizer back into the platform-independent
        /// shape, so a test can assert what was actually applied rather than
        /// re-stating the constant.
        static func spec(of pan: UIPanGestureRecognizer) -> TranscriptIndirectScrollRecognizerSpec {
            TranscriptIndirectScrollRecognizerSpec(
                acceptsIndirectScrolls: pan.allowedScrollTypesMask.contains(.continuous)
                    && pan.allowedScrollTypesMask.contains(.discrete),
                acceptsDirectTouches: !pan.allowedTouchTypes.isEmpty,
                cancelsTouchesInView: pan.cancelsTouchesInView)
        }
    #endif
}

#if canImport(UIKit)

    /// Reports trackpad and mouse-wheel scrolls over the transcript.
    ///
    /// The transcript decides whether the user has left the bottom deliberately
    /// by asking when they last touched it (`TranscriptFollowPolicy`). That
    /// signal had exactly one producer: a SwiftUI `DragGesture`, which is a
    /// direct-touch pan and does not recognize indirect scrolls. On an iPad with
    /// a trackpad or mouse — and on every Mac running the iPad app, where there
    /// is no other way to scroll — `lastUserTouchAt` therefore stayed at
    /// `.distantPast` forever.
    ///
    /// Every consequence followed from that one gap.
    /// `sentinelDisappearanceEndsFollowing` read each scroll-up as pure layout,
    /// so the bottom sentinel's `onDisappear` took its repair branch and pinned
    /// straight back to the tail; `shouldScroll` never suppressed a pin either.
    /// Scrolling up was impossible even on an idle thread, and because
    /// `autoFollow` never went false the jump-to-latest pill — the one advertised
    /// way out — never appeared.
    ///
    /// A recognizer rather than iOS 18's `onScrollPhaseChange` for two reasons:
    /// this package deploys to iOS 17, and a phase callback also fires for the
    /// transcript's OWN programmatic pins, which would stamp user intent on a
    /// scroll the user did not perform and suppress the follow it had just done.
    struct TranscriptIndirectScrollTracker: UIViewRepresentable {
        let onScroll: () -> Void

        func makeCoordinator() -> Coordinator { Coordinator(onScroll: onScroll) }

        func makeUIView(context: Context) -> ScrollProbeView {
            let probe = ScrollProbeView(frame: .zero)
            probe.isUserInteractionEnabled = false
            probe.backgroundColor = .clear
            // The enclosing scroll view is an ancestor that does not exist yet
            // at make time. `didMoveToWindow` is the first moment the chain is
            // real, and it is deterministic — no dispatch hop to race.
            probe.onEnterWindow = { [weak coordinator = context.coordinator] view in
                coordinator?.attach(startingFrom: view)
            }
            return probe
        }

        func updateUIView(_ uiView: ScrollProbeView, context: Context) {
            context.coordinator.onScroll = onScroll
            // Idempotent, and it matters: a pane that re-hosts its content gets
            // a new scroll view, and a tracker still attached to the old one
            // would go quiet without ever reporting an error.
            context.coordinator.attach(startingFrom: uiView)
        }

        static func dismantleUIView(_ uiView: ScrollProbeView, coordinator: Coordinator) {
            coordinator.detach()
        }

        /// Zero-sized, non-interactive: it exists only to find the scroll view.
        final class ScrollProbeView: UIView {
            var onEnterWindow: ((UIView) -> Void)?

            override func didMoveToWindow() {
                super.didMoveToWindow()
                guard window != nil else { return }
                onEnterWindow?(self)
            }
        }

        final class Coordinator: NSObject, UIGestureRecognizerDelegate {
            var onScroll: () -> Void
            private weak var attachedTo: UIScrollView?
            private var pan: UIPanGestureRecognizer?

            init(onScroll: @escaping () -> Void) {
                self.onScroll = onScroll
            }

            func attach(startingFrom view: UIView) {
                guard let scrollView = Self.enclosingScrollView(of: view) else { return }
                guard attachedTo !== scrollView else { return }
                detach()
                let recognizer = UIPanGestureRecognizer(
                    target: self, action: #selector(handleScroll(_:)))
                TranscriptIndirectScrollPolicy.configure(recognizer)
                recognizer.delegate = self
                scrollView.addGestureRecognizer(recognizer)
                pan = recognizer
                attachedTo = scrollView
            }

            func detach() {
                if let pan, let attachedTo { attachedTo.removeGestureRecognizer(pan) }
                pan = nil
                attachedTo = nil
            }

            static func enclosingScrollView(of view: UIView) -> UIScrollView? {
                var current = view.superview
                while let candidate = current {
                    if let scrollView = candidate as? UIScrollView { return scrollView }
                    current = candidate.superview
                }
                return nil
            }

            @objc func handleScroll(_ recognizer: UIPanGestureRecognizer) {
                onScroll()
            }

            /// Observe only — never take the gesture away from the scroll view's
            /// own pan, or the scroll this is reporting would stop happening.
            func gestureRecognizer(
                _ gestureRecognizer: UIGestureRecognizer,
                shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
            ) -> Bool { true }
        }
    }
#endif

extension View {
    /// Stamps pointer-scroll intent alongside the touch tracker. A no-op where
    /// UIKit is unavailable (the macOS compile-check build).
    @ViewBuilder
    func transcriptIndirectScrollTracking(onScroll: @escaping () -> Void) -> some View {
        #if canImport(UIKit)
            background(
                TranscriptIndirectScrollTracker(onScroll: onScroll)
                    .frame(width: 0, height: 0)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            )
        #else
            self
        #endif
    }
}
