// Guest-card lifecycle decode — the wire contract behind PRE-EXISTING guest
// side chats. The live Guests feature has been removed (no new guest can be
// invited or removed from the client), but old data can still carry a guest
// side chat, so this pins how it must keep decoding and classifying correctly.
//
// Removing a guest used to clear the parent's guestParticipant and mark the
// guest CHILD chat `lifecycleState: 'closed'` (never deleted) — so existing
// data can carry a closed guest child indefinitely. The phone must still
// read `sideChatLifecycleState` and treat a closed child as no-longer-active,
// otherwise a historical guest chip would look live again. This pins the
// decode + the `sideChatIsActive` predicate that Q3 render-safety relies on.

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
