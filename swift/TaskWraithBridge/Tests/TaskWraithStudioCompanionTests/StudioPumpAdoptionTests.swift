import XCTest

@testable import TaskWraithStudioCompanion
@testable import TaskWraithStudioCore

/// Guards the hop that has silently dropped a payload TWICE.
///
/// HISTORY, because it is the entire justification for this file. The stdio pump
/// parsed proposals and discarded them until `5ca5a06e2`; it then parsed the
/// committed sequence and discarded that until `c062d109b`. Both were found by
/// hand — one by @Advisor reading the code, one by @Orchestrator probing for a
/// callback that did not exist. Neither was found by a test, because until now
/// nothing under Tests/ referenced `StudioCompanionStdioPump` at all.
///
/// WHAT `c062d109b` ACTUALLY FIXED, stated more carefully than I stated it at
/// the time. Making the pump forward one `Update` moved the enumeration; it did
/// not remove it. The pump can no longer forget a payload — but
/// `StudioViewerAppState.adopt(update:)` still needs one branch per payload, and
/// the compiler does not ask for it. The compiler forced that site to be
/// rewritten ONCE. It does not force it to stay complete.
///
/// WHAT THIS FILE DOES AND DOES NOT PROVE — said plainly, because a guard that
/// reads stronger than it is would be the exact failure this round keeps
/// catching. It pins the SHAPE of the payload types, so adding a seventh field
/// fails here and sends the next person to the adoption list. It does NOT
/// execute adoption or assert its effects: those land on private state, and
/// widening it for a test would buy coverage with the honesty this lane has
/// spent the round defending. Behavioural adoption coverage remains open and is
/// named as such in the ledger.
final class StudioPumpAdoptionTests: XCTestCase {

    /// Every payload `Step` carries must have a branch in
    /// `StudioViewerAppState.adopt(update:)`.
    ///
    /// If this fails you have added a field. That is fine — add its branch to
    /// `adopt(update:)`, confirm the pump forwards it, then update this number
    /// IN THE SAME COMMIT. The number is not the point; being made to look at
    /// the adoption list is.
    func testStepCarriesExactlyTheFieldsAdoptionKnowsAbout() {
        let step = StudioCompanionSession.Step(
            outboundLines: [],
            exitCode: nil,
            protocolErrors: [],
            openedAssets: [],
            proposals: [],
            resolvedProposalIds: [],
            transcripts: []
        )
        let fields = Mirror(reflecting: step).children.compactMap(\.label).sorted()
        XCTAssertEqual(
            fields,
            [
                "exitCode", "openedAssets", "outboundLines", "proposals",
                "protocolErrors", "resolvedProposalIds", "transcripts",
            ],
            "StudioCompanionSession.Step changed shape — does "
                + "StudioViewerAppState.adopt(update:) handle the new field, or is it "
                + "being dropped the way proposals were before 5ca5a06e2 and the "
                + "sequence was before c062d109b?"
        )
    }

    /// Same guard for the hydration payload, which is where the sequence lives —
    /// the field that was parsed and reached nothing at all.
    func testHydrationCarriesExactlyTheFieldsAdoptionKnowsAbout() {
        let fields = Mirror(reflecting: StudioCompanionSession.Hydration.empty)
            .children.compactMap(\.label).sorted()
        XCTAssertEqual(
            fields,
            ["assets", "proposals", "sequence", "transcripts"],
            "StudioCompanionSession.Hydration changed shape — adopt(update:) reads "
                + "sequence and assets from it; a new field reaches nothing until it "
                + "is added there"
        )
    }

    /// And the transport value itself. `Update` is the shape that made carrying
    /// compiler-enforced; this pins that it still carries all three parts, so a
    /// field cannot be quietly dropped from the envelope either.
    func testUpdateCarriesStepRevisionAndHydration() {
        let update = StudioCompanionStdioPump.Update(
            step: StudioCompanionSession.Step(
                outboundLines: [],
                exitCode: nil,
                protocolErrors: [],
                openedAssets: [],
                proposals: [],
                resolvedProposalIds: [],
                transcripts: []
            ),
            latestRevision: 7,
            hydration: .empty
        )
        let fields = Mirror(reflecting: update).children.compactMap(\.label).sorted()
        XCTAssertEqual(fields, ["hydration", "latestRevision", "step"])
        XCTAssertEqual(update.latestRevision, 7, "the envelope must carry what it was given")
    }
}
