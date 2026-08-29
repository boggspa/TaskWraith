import Foundation
import Testing

#if canImport(UIKit)
    import UIKit
#endif

@testable import TaskWraithUI

@Suite("Transcript indirect scroll")
struct TranscriptIndirectScrollTests {
    /// Stand-in for a view tree, so the search is exercised on every platform
    /// rather than only where UIKit exists.
    private final class FakeNode {
        let isScroll: Bool
        private(set) var children: [FakeNode] = []
        weak var parent: FakeNode?

        init(isScroll: Bool = false) { self.isScroll = isScroll }

        @discardableResult
        func adding(_ child: FakeNode) -> FakeNode {
            child.parent = self
            children.append(child)
            return self
        }
    }

    private func find(from start: FakeNode, maxHops: Int = 6) -> FakeNode? {
        TranscriptScrollViewSearch.find(
            from: start,
            parent: { $0.parent },
            children: { $0.children },
            isScrollContainer: { $0.isScroll },
            maxHops: maxHops)
    }

    @Test func findsAScrollContainerAmongAncestors() {
        let scroll = FakeNode(isScroll: true)
        let middle = FakeNode()
        let probe = FakeNode()
        scroll.adding(middle)
        middle.adding(probe)

        // SwiftUI seats several hosting views between a view and its scroll
        // view, so the walk has to climb rather than check its parent.
        #expect(find(from: probe) === scroll)
    }

    @Test func findsAScrollContainerThatIsASibling() {
        // THE regression this file exists for. `.background()` on a ScrollView
        // layers the probe BEHIND the scroll view, making them siblings under a
        // shared parent — so an ancestors-only walk finds nothing and the
        // tracker attaches to nothing at all, silently.
        let container = FakeNode()
        let probe = FakeNode()
        let scroll = FakeNode(isScroll: true)
        container.adding(probe)
        container.adding(scroll)

        #expect(find(from: probe) === scroll)
    }

    @Test func findsAScrollContainerNestedUnderASibling() {
        // The sibling is usually a hosting view with the scroll view inside it,
        // not the scroll view itself.
        let container = FakeNode()
        let probe = FakeNode()
        let host = FakeNode()
        let scroll = FakeNode(isScroll: true)
        container.adding(probe)
        container.adding(host)
        host.adding(scroll)

        #expect(find(from: probe) === scroll)
    }

    @Test func prefersTheEnclosingContainerOverASiblingOne() {
        // A probe genuinely inside one scroll view must not bind to an
        // unrelated scroll view sitting beside its ancestor.
        let outer = FakeNode()
        let enclosing = FakeNode(isScroll: true)
        let unrelated = FakeNode(isScroll: true)
        let probe = FakeNode()
        outer.adding(enclosing)
        outer.adding(unrelated)
        enclosing.adding(probe)

        #expect(find(from: probe) === enclosing)
    }

    @Test func reportsNothingWhenThereIsNoScrollContainer() {
        let root = FakeNode()
        let probe = FakeNode()
        root.adding(probe)

        #expect(find(from: probe) == nil)
    }

    @Test func doesNotClimbBeyondTheHopBudget() {
        // Bounded so a probe outside the transcript can never reach the window
        // and start stamping intent for unrelated scrolling.
        let scroll = FakeNode(isScroll: true)
        var node = scroll
        for _ in 0..<9 {
            let child = FakeNode()
            node.adding(child)
            node = child
        }

        #expect(find(from: node, maxHops: 3) == nil)
        #expect(find(from: node, maxHops: 12) === scroll)
    }

    #if canImport(UIKit)
        @MainActor
        @Test func bindsToARealSiblingScrollView() {
            let container = UIView()
            let probe = UIView()
            let scrollView = UIScrollView()
            container.addSubview(probe)
            container.addSubview(scrollView)

            #expect(
                TranscriptIndirectScrollTracker.Coordinator.scrollView(near: probe) === scrollView)
        }
    #endif
}
