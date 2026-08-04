import Testing

@testable import TaskWraithUI

@MainActor
@Suite("Ensemble roster authority policy")
struct EnsembleRosterAuthorityPolicyTests {
    typealias Entry = RemoteSessionModel.RosterDraftEntry

    private func entry(
        _ id: String,
        boss: Bool = false,
        captain: Bool = false,
        stageRole: String? = nil
    ) -> Entry {
        Entry(
            id: id,
            provider: "codex",
            model: nil,
            role: id,
            brief: "",
            enabled: true,
            stageRole: stageRole,
            isBossman: boss,
            isSecondInCommand: captain
        )
    }

    @Test func preservesThreeCaptainsAcrossReorderAndUnrelatedEdit() {
        let original = [
            entry("boss", boss: true),
            entry("captain-1", captain: true),
            entry("captain-2", captain: true),
            entry("captain-3", captain: true),
        ]
        var reordered = [original[0], original[3], original[1], original[2]]
        reordered[2].role = "Edited role"

        let normalized = EnsembleRosterAuthorityPolicy.normalize(reordered)

        #expect(normalized.filter(\.isBossman).map(\.id) == ["boss"])
        #expect(normalized.filter(\.isSecondInCommand).map(\.id) == [
            "captain-3", "captain-1", "captain-2",
        ])
    }

    @Test func pluralEmptyBeatsStaleScalarAndEntryFlagsDuringHydration() {
        let hydrated = EnsembleRosterAuthorityPolicy.hydrate(
            [entry("captain", captain: true), entry("boss")],
            bossmanParticipantId: "boss",
            captainParticipantIds: [],
            secondInCommandParticipantId: "captain"
        )

        #expect(hydrated.filter(\.isBossman).map(\.id) == ["boss"])
        #expect(hydrated.filter(\.isSecondInCommand).isEmpty)
    }

    @Test func blocksFourthCaptainButLetsAnExistingCaptainClearItself() {
        let roster = [
            entry("boss", boss: true),
            entry("captain-1", captain: true),
            entry("captain-2", captain: true),
            entry("captain-3", captain: true),
            entry("agent"),
        ]
        var fourth = roster[4]
        fourth.isSecondInCommand = true
        #expect(EnsembleRosterAuthorityPolicy.applying(fourth, to: roster) == nil)
        #expect(
            EnsembleRosterAuthorityPolicy.captainAssignmentDisabled(
                for: "agent", in: roster)
        )

        var cleared = roster[2]
        cleared.isSecondInCommand = false
        let result = EnsembleRosterAuthorityPolicy.applying(cleared, to: roster)
        #expect(result?.filter(\.isSecondInCommand).map(\.id) == ["captain-1", "captain-3"])
    }

    @Test func blocksBossDemotionBackgroundingAndRemovalButAllowsAtomicTransfer() {
        let roster = [entry("boss", boss: true), entry("agent")]
        var demoted = roster[0]
        demoted.isBossman = false
        #expect(EnsembleRosterAuthorityPolicy.applying(demoted, to: roster) == nil)

        var backgrounded = roster[0]
        backgrounded.stageRole = "background"
        #expect(EnsembleRosterAuthorityPolicy.applying(backgrounded, to: roster) == nil)
        #expect(EnsembleRosterAuthorityPolicy.removing("boss", from: roster) == nil)

        var replacement = roster[1]
        replacement.isBossman = true
        let transferred = EnsembleRosterAuthorityPolicy.applying(replacement, to: roster)
        #expect(transferred?.filter(\.isBossman).map(\.id) == ["agent"])
    }

    @Test func legacyRecoveryUsesFirstForegroundSeatAndExcludesItFromCaptains() {
        let recovered = EnsembleRosterAuthorityPolicy.hydrate(
            [
                entry("background", boss: true, captain: true, stageRole: "background"),
                entry("foreground", captain: true),
                entry("captain", captain: true),
            ],
            bossmanParticipantId: "missing",
            captainParticipantIds: nil,
            secondInCommandParticipantId: "foreground"
        )

        #expect(recovered.filter(\.isBossman).map(\.id) == ["foreground"])
        #expect(recovered.filter(\.isSecondInCommand).map(\.id) == ["captain"])
    }
}
