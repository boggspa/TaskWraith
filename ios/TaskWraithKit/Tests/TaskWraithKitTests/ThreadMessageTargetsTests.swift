import Foundation
import Testing

@testable import TaskWraithKit

@Suite("Peer thread-message targets")
struct ThreadMessageTargetsTests {
    /// Decoded rather than constructed: RemoteTaskCard has no defaulted
    /// initializer, and this also exercises the real projection decode path.
    private func cards(_ json: String) throws -> [RemoteTaskCard] {
        try JSONDecoder().decode([RemoteTaskCard].self, from: Data(json.utf8))
    }

    private func targets(
        _ json: String, from: String = "chat-a", workspace: String? = "ws-1"
    ) throws -> [ThreadMessageTarget] {
        ThreadMessageTargets.candidates(
            cards: try cards(json), fromThreadId: from, fromWorkspaceId: workspace)
    }

    @Test("offers other threads with their titles")
    func offersOtherThreads() throws {
        let result = try targets(
            """
            [{"id":"chat-a","title":"Sender","workspaceId":"ws-1","threadId":"chat-a"},
             {"id":"chat-b","title":"Byte pin fix","workspaceId":"ws-1","threadId":"chat-b"}]
            """)
        #expect(result.map(\.threadId) == ["chat-b"])
        #expect(result.first?.title == "Byte pin fix")
        #expect(result.first?.crossWorkspace == false)
    }

    // Self-addressing is refused by the Mac, so offering it would be an affordance
    // whose only possible outcome is an error. Both identities are checked because a
    // card carries `id` and `threadId` and they can disagree.
    @Test("never offers the sending thread, under either identity")
    func excludesSelf() throws {
        let byThreadId = try targets(
            #"[{"id":"other","title":"X","workspaceId":"ws-1","threadId":"chat-a"}]"#)
        #expect(byThreadId.isEmpty)
        let byCardId = try targets(
            #"[{"id":"chat-a","title":"X","workspaceId":"ws-1","threadId":"other"}]"#)
        #expect(byCardId.isEmpty)
    }

    @Test("excludes drafts and archived threads")
    func excludesUnreachable() throws {
        let result = try targets(
            """
            [{"id":"chat-b","title":"Draft","workspaceId":"ws-1","threadId":"chat-b","isDraft":true},
             {"id":"chat-c","title":"Gone","workspaceId":"ws-1","threadId":"chat-c","archived":true},
             {"id":"chat-d","title":"Live","workspaceId":"ws-1","threadId":"chat-d"}]
            """)
        #expect(result.map(\.threadId) == ["chat-d"])
    }

    @Test("flags a different workspace and sorts same-workspace first")
    func flagsAndSortsCrossWorkspace() throws {
        let result = try targets(
            """
            [{"id":"chat-b","title":"Alpha","workspaceId":"ws-2","threadId":"chat-b"},
             {"id":"chat-c","title":"Zulu","workspaceId":"ws-1","threadId":"chat-c"}]
            """)
        #expect(result.map(\.threadId) == ["chat-c", "chat-b"])
        #expect(result.first?.crossWorkspace == false)
        #expect(result.last?.crossWorkspace == true)
    }

    // Fails toward the caution: an unknown workspace on either side reads as CROSS,
    // because a missing warning is worse than a redundant one.
    @Test("treats an unknown workspace as cross-workspace")
    func unknownWorkspaceIsCross() throws {
        #expect(
            try targets(#"[{"id":"chat-b","title":"X","threadId":"chat-b"}]"#).first?.crossWorkspace
                == true)
        #expect(
            try targets(
                #"[{"id":"chat-b","title":"X","workspaceId":"ws-1","threadId":"chat-b"}]"#,
                workspace: nil
            ).first?.crossWorkspace == true)
        #expect(ThreadMessageTargets.isCrossWorkspace(target: "", sender: "") == true)
    }

    @Test("falls back to the id for an untitled thread")
    func untitledFallsBackToId() throws {
        let result = try targets(
            #"[{"id":"chat-b","title":"   ","workspaceId":"ws-1","threadId":"chat-b"}]"#)
        #expect(result.first?.title == "chat-b")
    }

    @Test("de-duplicates cards that share a thread id")
    func dedupes() throws {
        let result = try targets(
            """
            [{"id":"chat-b","title":"First","workspaceId":"ws-1","threadId":"shared"},
             {"id":"chat-c","title":"Second","workspaceId":"ws-1","threadId":"shared"}]
            """)
        #expect(result.count == 1)
        #expect(result.first?.title == "First")
    }

    @Test("sorts stably by title within a workspace")
    func sortsByTitle() throws {
        let result = try targets(
            """
            [{"id":"chat-b","title":"beta","workspaceId":"ws-1","threadId":"chat-b"},
             {"id":"chat-c","title":"Alpha","workspaceId":"ws-1","threadId":"chat-c"}]
            """)
        #expect(result.map(\.title) == ["Alpha", "beta"])
    }
}

@Suite("Peer inbox segment label")
struct ThreadMessageBadgeTests {
    @Test("bare label when nothing is waiting")
    func bareWhenEmpty() {
        #expect(ThreadMessageBadge.segmentLabel(count: 0) == "Peers")
        #expect(ThreadMessageBadge.segmentLabel(count: -3) == "Peers")
    }

    @Test("carries a small count inline")
    func carriesCount() {
        #expect(ThreadMessageBadge.segmentLabel(count: 1) == "Peers 1")
        #expect(ThreadMessageBadge.segmentLabel(count: 9) == "Peers 9")
    }

    // The label lives inside a segmented control with five siblings. An uncapped
    // count would stretch this segment and squeeze the rest.
    @Test("caps a runaway count so the control cannot stretch")
    func capsRunaway() {
        #expect(ThreadMessageBadge.segmentLabel(count: 10) == "Peers 9+")
        #expect(ThreadMessageBadge.segmentLabel(count: 4_000) == "Peers 9+")
    }
}

@Suite("Peer thread-message composer rules")
struct ThreadMessageComposeTests {
    private let target = ThreadMessageTarget(
        threadId: "chat-b", title: "Byte pin fix", crossWorkspace: false)
    private let elsewhere = ThreadMessageTarget(
        threadId: "chat-c", title: "Other workspace thread", crossWorkspace: true)

    private func state(
        targetCount: Int = 1, selected: ThreadMessageTarget? = nil, message: String = "hello",
        sending: Bool = false
    ) -> ThreadMessageCompose.State {
        ThreadMessageCompose.state(
            targetCount: targetCount, selected: selected ?? target, message: message,
            sending: sending)
    }

    @Test("a chosen thread and a real message can send")
    func sendable() {
        let s = state()
        #expect(s.canSend)
        #expect(s.blockedReason.isEmpty)
        #expect(s.crossWorkspaceWarning == nil)
    }

    // Each blocked case names itself: the reason doubles as the button's hint, so a
    // disabled control always says why rather than sitting there inert.
    @Test("names every reason a send is blocked")
    func namesBlockedReasons() {
        #expect(
            ThreadMessageCompose.state(
                targetCount: 0, selected: nil, message: "hi", sending: false
            ).blockedReason == "There is no other thread to message.")
        #expect(
            ThreadMessageCompose.state(
                targetCount: 2, selected: nil, message: "hi", sending: false
            ).blockedReason == "Choose a thread to message.")
        #expect(state(message: "   \n ").blockedReason == "Write a message first.")
        #expect(state(sending: true).blockedReason == "Sending…")
        for blocked in [
            ThreadMessageCompose.state(targetCount: 0, selected: nil, message: "hi", sending: false),
            ThreadMessageCompose.state(targetCount: 2, selected: nil, message: "hi", sending: false),
            state(message: " "), state(sending: true),
        ] {
            #expect(blocked.canSend == false)
        }
    }

    // The Mac validator rejects an over-long body, so the phone must refuse first
    // rather than spend a round-trip discovering it.
    @Test("refuses a message over the shared limit and says by how much")
    func refusesOverBudget() {
        let over = state(message: String(repeating: "x", count: ThreadMessageCompose.maxCharacters + 7))
        #expect(over.canSend == false)
        #expect(over.overBudget)
        #expect(over.remaining == -7)
        #expect(over.blockedReason.contains("7 characters over"))

        let exactly = state(message: String(repeating: "x", count: ThreadMessageCompose.maxCharacters))
        #expect(exactly.canSend)
        #expect(exactly.remaining == 0)
    }

    @Test("shows the counter only near the ceiling")
    func counterAppearsLate() {
        #expect(state(message: "short").showCounter == false)
        let near = String(
            repeating: "x",
            count: ThreadMessageCompose.maxCharacters - ThreadMessageCompose.remainingWarnCharacters)
        #expect(state(message: near).showCounter)
    }

    // WARNS rather than blocks, matching the desktop: the Mac gate is the authority
    // and will prompt — but nobody is standing at the Mac, so say so before sending.
    @Test("warns about a cross-workspace target by name without blocking")
    func warnsCrossWorkspace() {
        let s = state(selected: elsewhere)
        #expect(s.canSend)
        let warning = s.crossWorkspaceWarning ?? ""
        #expect(warning.contains("Other workspace thread"))
        #expect(warning.contains("another workspace"))
    }
}
