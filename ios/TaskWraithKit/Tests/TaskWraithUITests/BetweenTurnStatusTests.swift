import Foundation
import Testing
import TaskWraithKit

@testable import TaskWraithUI

/// The gap between one seat finishing and the next being seeded. Nobody is
/// working in it — `activeParticipantId` is cleared and no lane is live — so the
/// phone projected an empty working set and then showed a running round with no
/// account of itself. The Mac now says what the interval IS; these pin that the
/// phone repeats the Mac's words rather than inventing its own.
@Suite("Between-turn status")
struct BetweenTurnStatusTests {
    private func state(_ json: String) throws -> RemoteEnsembleState {
        try JSONDecoder().decode(RemoteEnsembleState.self, from: Data(json.utf8))
    }

    @Test func decodesTheProjectedTransitionLabel() throws {
        let handing = try state(
            #"{"threadId":"t1","status":"running","turnTransitionLabel":"Handing off to Reviewer"}"#)
        #expect(handing.turnTransitionLabel == "Handing off to Reviewer")

        // Older Mac: absent, and the phone must behave exactly as it used to.
        let older = try state(#"{"threadId":"t1","status":"running"}"#)
        #expect(older.turnTransitionLabel == nil)
    }

    @Test func showsTheLabelOnlyWhileTheRoundIsRunningAndNobodyWorks() throws {
        let transitioning = try state(
            #"{"threadId":"t1","status":"running","turnTransitionLabel":"Finalizing turn"}"#)
        #expect(twBetweenTurnStatusLabel(transitioning) == "Finalizing turn")

        // A seat IS working — that seat owns the indicator, not the interval.
        // The Mac should not send both, but if it ever does, the working seat
        // wins: naming a seat is more specific than naming the gap.
        let working = try state(
            """
            {"threadId":"t1","status":"running","turnTransitionLabel":"Finalizing turn",
             "workingParticipantIds":["reader-1"]}
            """)
        #expect(twBetweenTurnStatusLabel(working) == nil)

        // Round over: no interval to describe.
        let idle = try state(
            #"{"threadId":"t1","status":"idle","turnTransitionLabel":"Finalizing turn"}"#)
        #expect(twBetweenTurnStatusLabel(idle) == nil)

        // Blank/whitespace from an odd Mac build is not a status.
        let blank = try state(
            #"{"threadId":"t1","status":"running","turnTransitionLabel":"   "}"#)
        #expect(twBetweenTurnStatusLabel(blank) == nil)
        #expect(twBetweenTurnStatusLabel(nil) == nil)
    }
}
