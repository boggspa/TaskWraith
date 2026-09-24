// Stamps transcript scroll intent for INDIRECT scrolls — trackpad, mouse
// wheel, and any other non-touch scroll source.

import SwiftUI

#if canImport(UIKit)
    import UIKit
#endif

/// Locates the scroll container a probe view belongs to.
///
/// Written against closures rather than `UIView` so the search itself — the
/// part that was wrong the first time — is exercisable on any platform,
/// including the macOS `swift test` build where UIKit does not exist.
///
/// **Ancestors are not enough.** The probe is installed with `.background()`
/// on the `ScrollView`, and a background is layered *behind* the view it
/// decorates, not inside it. So the scroll view is a **sibling** of the probe,
/// never an ancestor, and a superview-only walk finds nothing and silently
/// attaches to nothing. Measured 2026-08-29: the first version of this file did
/// exactly that and was completely inert in the running app while every one of
/// its unit tests passed.
enum TranscriptScrollViewSearch {
    /// Nearest enclosing scroll container, else the nearest one reachable from
    /// an ancestor's subtree (the sibling case), else nil.
    ///
    /// `maxHops` bounds the climb so a probe that somehow lands outside the
    /// transcript cannot walk to the window and attach to unrelated scrolling.
    static func find<Node: AnyObject>(
        from start: Node,
        parent: (Node) -> Node?,
        children: (Node) -> [Node],
        isScrollContainer: (Node) -> Bool,
        maxHops: Int = 6
    ) -> Node? {
        // Ancestors first: cheapest, and correct when the probe really is
        // inside the scrolled content.
        var current = parent(start)
        var hops = 0
        while let candidate = current, hops < maxHops {
            if isScrollContainer(candidate) { return candidate }
            current = parent(candidate)
            hops += 1
        }

        // Then each ancestor's subtree, nearest ancestor first — this is the
        // branch that finds a `.background()` probe's sibling scroll view.
        current = parent(start)
        hops = 0
        while let candidate = current, hops < maxHops {
            if let found = firstScrollContainer(
                in: candidate, children: children, isScrollContainer: isScrollContainer)
            {
                return found
            }
            current = parent(candidate)
            hops += 1
        }
        return nil
    }

    private static func firstScrollContainer<Node: AnyObject>(
        in node: Node,
        children: (Node) -> [Node],
        isScrollContainer: (Node) -> Bool
    ) -> Node? {
        for child in children(node) {
            if isScrollContainer(child) { return child }
            if let found = firstScrollContainer(
                in: child, children: children, isScrollContainer: isScrollContainer)
            {
                return found
            }
        }
        return nil
    }
}

#if canImport(UIKit)

    /// Reports trackpad and mouse-wheel scrolls over the transcript.
    ///
    /// The transcript decides whether the user left the bottom deliberately by
    /// asking when they last touched it (`TranscriptFollowPolicy`). That signal
    /// had one producer: a SwiftUI `DragGesture`, which is a direct-touch pan.
    /// UIKit pans ship with an **empty** `allowedScrollTypesMask`, so a trackpad
    /// two-finger scroll or a mouse wheel never reaches one. On an iPad with a
    /// pointer — and on a Mac running the iPad app, where there is no other way
    /// to scroll — `lastUserTouchAt` therefore stayed at `.distantPast` and a
    /// scroll-up was read as pure layout rather than intent.
    ///
    /// Rather than add a second recognizer and try to configure it correctly,
    /// this hangs a target off the scroll view's **own** `panGestureRecognizer`.
    /// That recognizer already handles indirect scrolls — it is why a
    /// `UIScrollView` scrolls with a trackpad when a bare `DragGesture` does not
    /// — so there is no `allowedScrollTypesMask`, `allowedTouchTypes` or
    /// simultaneous-recognition policy to get wrong, and nothing new that could
    /// starve the scroll view's panning or swallow a tap.
    ///
    /// Deliberately not iOS 18's `onScrollPhaseChange`: this package deploys to
    /// iOS 17, and that callback also fires for the transcript's OWN
    /// programmatic pins, which would stamp user intent for a scroll the user
    /// never made and suppress the follow it had just performed.
    struct TranscriptIndirectScrollTracker: UIViewRepresentable {
        let onScroll: () -> Void

        func makeCoordinator() -> Coordinator { Coordinator(onScroll: onScroll) }

        func makeUIView(context: Context) -> ScrollProbeView {
            let probe = ScrollProbeView(frame: .zero)
            probe.isUserInteractionEnabled = false
            probe.backgroundColor = .clear
            // The scroll view does not exist in the tree yet at make time.
            // `didMoveToWindow` is the first moment the hierarchy is real, and
            // it is deterministic — no dispatch hop to race with layout.
            probe.onEnterWindow = { [weak coordinator = context.coordinator] view in
                coordinator?.attach(from: view)
            }
            return probe
        }

        func updateUIView(_ uiView: ScrollProbeView, context: Context) {
            context.coordinator.onScroll = onScroll
            // Idempotent, and it matters: a pane that re-hosts its content gets
            // a new scroll view, and a tracker still bound to the old one would
            // go quiet without ever reporting an error.
            context.coordinator.attach(from: uiView)
        }

        static func dismantleUIView(_ uiView: ScrollProbeView, coordinator: Coordinator) {
            coordinator.detach()
        }

        /// Zero-sized and non-interactive: it exists only to locate the scroll
        /// view, and must never take a hit or affect layout.
        final class ScrollProbeView: UIView {
            var onEnterWindow: ((UIView) -> Void)?

            override func didMoveToWindow() {
                super.didMoveToWindow()
                guard window != nil else { return }
                onEnterWindow?(self)
            }
        }

        // Main-actor isolated: UIKit gesture targets are main-actor, and Swift 6.3
        // (Xcode 26.3) rejects sending a non-Sendable coordinator into addTarget
        // as a data race; every caller (makeCoordinator, didMoveToWindow, the
        //  selector) already runs on the main actor.
        @MainActor final class Coordinator: NSObject {
            var onScroll: () -> Void
            private weak var attachedTo: UIScrollView?

            init(onScroll: @escaping () -> Void) {
                self.onScroll = onScroll
            }

            func attach(from view: UIView) {
                guard let scrollView = Self.scrollView(near: view) else { return }
                guard attachedTo !== scrollView else { return }
                detach()
                scrollView.panGestureRecognizer.addTarget(
                    self, action: #selector(handleScroll(_:)))
                attachedTo = scrollView
            }

            func detach() {
                attachedTo?.panGestureRecognizer.removeTarget(
                    self, action: #selector(handleScroll(_:)))
                attachedTo = nil
            }

            static func scrollView(near view: UIView) -> UIScrollView? {
                TranscriptScrollViewSearch.find(
                    from: view,
                    parent: { $0.superview },
                    children: { $0.subviews },
                    isScrollContainer: { $0 is UIScrollView }
                ) as? UIScrollView
            }

            @objc func handleScroll(_ recognizer: UIPanGestureRecognizer) {
                onScroll()
            }
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
