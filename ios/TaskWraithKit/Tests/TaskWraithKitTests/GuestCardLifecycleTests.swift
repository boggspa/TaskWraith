// Guest-card lifecycle decode — the wire contract behind "remove guest".
//
// removeGuestParticipant on the Mac clears the parent's guestParticipant and
// marks the guest CHILD chat `lifecycleState: 'closed'` (it is NOT deleted).
// The phone detects the active guest purely from that child card, so it must
// read `sideChatLifecycleState` and treat a closed child as no-longer-the-guest
// — otherwise the composer guest chip lingers after removal. This pins the
// decode + the `sideChatIsActive` predicate that the active-guest detector uses.

import Foundation
import Testing

@testable import TaskWraithKit

@Suite("Guest card lifecycle")
struct GuestCardLifecycleTests {
    private func card(_ json: String) throws -> RemoteTaskCard {
        try JSONDecoder().decode(RemoteTaskCard.self, from: Data(json.utf8))
    }

    @Test("an active guest child is detected and live")
    func activeGuest() throws {
        let c = try card(
            """
            {"id":"guest-1","parentChatId":"parent-1","parentChatRelation":"sideChat",
             "sideChatMode":"guestParticipant","sideChatLifecycleState":"active","workspaceId":null}
            """)
        #expect(c.isGuestSideChat)
        #expect(c.sideChatIsActive)
    }

    @Test("a removed (closed) guest child stays a guest by mode but is no longer active")
    func closedGuest() throws {
        let c = try card(
            """
            {"id":"guest-1","parentChatId":"parent-1","parentChatRelation":"sideChat",
             "sideChatMode":"guestParticipant","sideChatLifecycleState":"closed","workspaceId":null}
            """)
        // Still labelled "Guest" in the side-chats history…
        #expect(c.isGuestSideChat)
        // …but the active-guest detector (isGuestSideChat && sideChatIsActive)
        // drops it, so the composer chip clears.
        #expect(!c.sideChatIsActive)
        #expect(!(c.isGuestSideChat && c.sideChatIsActive))
    }

    @Test("a terminated guest child is also not active")
    func terminatedGuest() throws {
        let c = try card(
            """
            {"id":"guest-1","parentChatId":"parent-1","parentChatRelation":"sideChat",
             "sideChatMode":"guestParticipant","sideChatLifecycleState":"terminated","workspaceId":null}
            """)
        #expect(!c.sideChatIsActive)
    }

    @Test("absent lifecycle is treated as active (older Mac builds keep showing the guest)")
    func absentLifecycleIsActive() throws {
        let c = try card(
            """
            {"id":"guest-1","parentChatId":"parent-1","parentChatRelation":"sideChat",
             "sideChatMode":"guestParticipant","workspaceId":null}
            """)
        #expect(c.isGuestSideChat)
        #expect(c.sideChatIsActive)
        #expect(c.isGuestSideChat && c.sideChatIsActive)
    }
}
