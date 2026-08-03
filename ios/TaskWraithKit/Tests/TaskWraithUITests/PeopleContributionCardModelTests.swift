import Foundation
import Testing

@testable import TaskWraithUI

@Suite("People contribution card (desktop External / Action request / Insert as draft)")
struct PeopleContributionCardModelTests {
    @Test func queuedCommentShowsExternalAndInsertAsDraft() {
        let model = peopleContributionCardModel(
            PeopleContributionCardInput(
                messageId: "m1",
                collaboratorDisplayName: "Alex",
                body: "Please look at the flaky test.",
                delivery: .queuedComment
            )
        )
        #expect(model.displayName == "Alex")
        #expect(model.attribution == .externalUntrusted)
        #expect(model.badges.map(\.label) == ["External"])
        #expect(model.showsInsertAsDraft == true)
        #expect(model.insertAsDraftLabel == "Insert as draft")
        #expect(model.insertedAsDraftStatus == nil)
        #expect(!model.accessibilityLabel.localizedCaseInsensitiveContains("System"))
        #expect(!model.accessibilityLabel.localizedCaseInsensitiveContains("Operator"))
        #expect(model.accessibilityLabel.contains("Alex"))
        #expect(model.accessibilityLabel.contains("External"))
    }

    @Test func actionRequestAddsBadgeAndSaferTrustCaption() {
        let model = peopleContributionCardModel(
            PeopleContributionCardInput(
                messageId: "m2",
                collaboratorDisplayName: "Dana",
                body: "Ship the hotfix.",
                delivery: .queuedComment,
                intent: .requestHostAction
            )
        )
        #expect(model.badges.map(\.label) == ["External", "Action request"])
        #expect(model.trustCaption.contains("nothing sends itself"))
        #expect(model.showsInsertAsDraft == true)
        // Spec §6: never label promote as Run / Prompt.
        #expect(model.insertAsDraftLabel == "Insert as draft")
        #expect(!model.insertAsDraftLabel.localizedCaseInsensitiveContains("Run"))
        #expect(!model.insertAsDraftLabel.localizedCaseInsensitiveContains("Prompt"))
    }

    @Test func deliveredExternalNeverOffersInsertAsDraft() {
        let model = peopleContributionCardModel(
            PeopleContributionCardInput(
                messageId: "m3",
                collaboratorDisplayName: "Sam",
                body: "Delivered at my seat.",
                delivery: .deliveredExternalSeat,
                intent: .requestHostAction, // intent is ignored for delivered path chrome
                outOfPosition: false,
                insertedAsDraft: true
            )
        )
        #expect(model.badges.map(\.label) == ["External"])
        #expect(model.showsInsertAsDraft == false)
        #expect(model.insertedAsDraftStatus == nil)
        #expect(model.trustCaption.contains("untrusted"))
    }

    @Test func outOfPositionBadgeOnlyOnDeliveredSweep() {
        let delivered = peopleContributionCardModel(
            PeopleContributionCardInput(
                messageId: "m4",
                collaboratorDisplayName: "Sam",
                body: "Late delivery.",
                delivery: .deliveredExternalSeat,
                outOfPosition: true
            )
        )
        #expect(delivered.badges.map(\.label) == ["External", "Out of position"])

        let queued = peopleContributionCardModel(
            PeopleContributionCardInput(
                messageId: "m5",
                collaboratorDisplayName: "Sam",
                body: "Still queued.",
                delivery: .queuedComment,
                outOfPosition: true
            )
        )
        #expect(queued.badges.map(\.label) == ["External"])
    }

    @Test func blankNameFallsBackAndInsertedDraftStatusShows() {
        let model = peopleContributionCardModel(
            PeopleContributionCardInput(
                messageId: "m6",
                collaboratorDisplayName: "   ",
                body: "Hi",
                delivery: .queuedComment,
                insertedAsDraft: true
            )
        )
        #expect(model.displayName == "Collaborator")
        #expect(model.insertedAsDraftStatus == "Inserted as draft")
        #expect(model.showsInsertAsDraft == true)
    }

    @Test func attributionUnionHasNoSystemMember() {
        // Compile-time closed union; runtime assert the only raw value we emit.
        let model = peopleContributionCardModel(
            PeopleContributionCardInput(
                messageId: "m7",
                collaboratorDisplayName: "Pat",
                body: "x",
                delivery: .queuedComment
            )
        )
        #expect(model.attribution.rawValue == "external-untrusted")
        #expect(PeopleContributionAttribution.externalUntrusted.rawValue != "system")
    }

    @Test func truncatedFlagPropagates() {
        let model = peopleContributionCardModel(
            PeopleContributionCardInput(
                messageId: "m8",
                collaboratorDisplayName: "Pat",
                body: "partial…",
                delivery: .queuedComment,
                truncated: true
            )
        )
        #expect(model.truncated == true)
    }
}
