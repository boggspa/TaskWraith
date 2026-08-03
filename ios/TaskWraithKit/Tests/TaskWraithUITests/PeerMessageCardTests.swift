import Foundation
import Testing

@testable import TaskWraithUI

/// Mirrors desktop `ThreadMessageInboxModel.test.ts` + containment assertions from
/// `ThreadMessageInboxCard.test.tsx` for the extracted iOS peer card model.
@Suite("PeerMessageCard model — attribution")
struct PeerMessageCardAttributionTests {
    private func card(
        origin: PeerMessageCardInput.Origin = .agent,
        title: String = "Byte pin fix",
        fromChatId: String = "chat-a",
        body: String = "The byte budget assertion is red on master.",
        delivery: PeerMessageCardInput.Delivery = .queue,
        truncated: Bool = false
    ) -> PeerMessageCardModel {
        PeerMessageCardMapping.model(
            from: PeerMessageCardInput(
                id: "thread-msg-1",
                fromChatId: fromChatId,
                fromChatTitle: title,
                origin: origin,
                body: body,
                requestedDelivery: delivery,
                createdAt: 1_700_000_000_000,
                truncated: truncated))
    }

    // THE presentation decision: a relayed message is never app-authored.
    @Test("attributes agent and user origins to peer-thread closed union")
    func attributesOrigins() {
        #expect(card(origin: .agent).attribution == .peerThreadAgent)
        #expect(card(origin: .user).attribution == .peerThreadUser)
        for origin: PeerMessageCardInput.Origin in [.agent, .user] {
            let model = card(origin: origin)
            #expect(model.attribution.rawValue.hasPrefix("peer-thread"))
            #expect(model.headerText.range(of: "system", options: .caseInsensitive) == nil)
            #expect(model.headerText.range(of: "operator", options: .caseInsensitive) == nil)
        }
    }

    @Test("names the sending thread for agent and user messages")
    func namesSendingThread() {
        #expect(card(origin: .agent).headerText == "Sent by the agent in “Byte pin fix”")
        #expect(card(origin: .user).headerText == "You sent this from “Byte pin fix”")
    }
}

@Suite("PeerMessageCard model — reader needs to know")
struct PeerMessageCardReaderTests {
    private func card(
        origin: PeerMessageCardInput.Origin = .agent,
        title: String = "Byte pin fix",
        fromChatId: String = "chat-a",
        body: String = "The byte budget assertion is red on master.",
        delivery: PeerMessageCardInput.Delivery = .queue,
        truncated: Bool = false
    ) -> PeerMessageCardModel {
        PeerMessageCardMapping.model(
            from: PeerMessageCardInput(
                id: "thread-msg-1",
                fromChatId: fromChatId,
                fromChatTitle: title,
                origin: origin,
                body: body,
                requestedDelivery: delivery,
                createdAt: 1_700_000_000_000,
                truncated: truncated))
    }

    @Test("flags a wake request so it is visibly different from a queued note")
    func flagsWake() {
        let wake = card(delivery: .wake)
        #expect(wake.requestsWake)
        #expect(wake.wakeBadgeText == "asks to run now")
        #expect(card().requestsWake == false)
        #expect(card().wakeBadgeText == nil)
    }

    @Test("flags a truncated body with a cut-short note")
    func flagsTruncation() {
        let truncated = card(truncated: true)
        #expect(truncated.truncated)
        #expect(truncated.truncationNote?.contains("cut short") == true)
        #expect(card().truncated == false)
        #expect(card().truncationNote == nil)
    }

    @Test("passes the body through unchanged for plain-text rendering")
    func bodyUnchanged() {
        let body = "```json\n{\"ok\":true}\n```\nCheck [this](https://evil.example/pwn)"
        #expect(card(body: body).body == body)
    }

    @Test("falls back through the sender label")
    func senderLabelFallback() {
        #expect(card(title: "   ").senderLabel == "chat-a")
        #expect(card(title: "", fromChatId: "  ").senderLabel == "another thread")
    }

    @Test("exposes an accessibility label naming the peer thread")
    func accessibilityLabel() {
        #expect(card().bodyAccessibilityLabel == "Peer message from Byte pin fix")
    }

    @Test("panel preamble frames messages as requests to judge")
    func panelPreamble() {
        #expect(PeerMessageCardMapping.panelPreamble.contains("requests to judge"))
        #expect(PeerMessageCardMapping.emptyStateText.contains("No messages from other threads"))
    }

    @Test("collapsed viewport height matches desktop peer card")
    func collapsedHeight() {
        #expect(PeerMessageCardMapping.collapsedBodyMaxHeight == 220)
    }
}

@Suite("PeerMessageIndicator model")
struct PeerMessageIndicatorTests {
    @Test("renders nothing useful for an empty inbox")
    func emptyInbox() {
        let model = PeerMessageIndicator.model(
            pendingCount: 0, hasWakeRequest: false, senders: [])
        #expect(model.count == 0)
        #expect(model.urgent == false)
        #expect(model.title == "No thread messages")
    }

    @Test("names the senders in the description")
    func namesSenders() {
        let model = PeerMessageIndicator.model(
            pendingCount: 2,
            hasWakeRequest: false,
            senders: ["Byte pin fix", "ToS audit"])
        #expect(model.title == "2 thread messages from Byte pin fix, ToS audit")
        #expect(model.badge == "2")
    }

    @Test("reads correctly for a single message")
    func singleMessage() {
        let model = PeerMessageIndicator.model(
            pendingCount: 1, hasWakeRequest: false, senders: ["Byte pin fix"])
        #expect(model.title == "1 thread message from Byte pin fix")
    }

    @Test("marks a wake request urgent and says so")
    func wakeUrgent() {
        let model = PeerMessageIndicator.model(
            pendingCount: 1, hasWakeRequest: true, senders: ["Byte pin fix"])
        #expect(model.urgent)
        #expect(model.title.contains("asks this thread to start a turn"))
    }

    @Test("is not urgent on a wake flag with nothing pending")
    func wakeWithoutPending() {
        let model = PeerMessageIndicator.model(
            pendingCount: 0, hasWakeRequest: true, senders: [])
        #expect(model.urgent == false)
    }

    @Test("caps the badge instead of counting up forever")
    func capsBadge() {
        let model = PeerMessageIndicator.model(
            pendingCount: PeerMessageIndicator.maxBadgeCount + 5,
            hasWakeRequest: false,
            senders: ["A"])
        #expect(model.badge == "\(PeerMessageIndicator.maxBadgeCount)+")
        #expect(model.count == PeerMessageIndicator.maxBadgeCount + 5)
    }

    @Test("survives a nonsense count without rendering a negative badge")
    func negativeCount() {
        #expect(
            PeerMessageIndicator.model(
                pendingCount: -3, hasWakeRequest: false, senders: []
            ).badge == "0")
    }

    @Test("falls back when the senders list is empty or blank")
    func blankSenders() {
        let model = PeerMessageIndicator.model(
            pendingCount: 1, hasWakeRequest: false, senders: ["  "])
        #expect(model.title.contains("another thread"))
    }
}
