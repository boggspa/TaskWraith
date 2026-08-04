import Foundation
import Testing
import TaskWraithKit

@testable import TaskWraithUI

@Suite("Transcript navigation adapter")
struct TranscriptNavigationAdapterTests {
    private func row(_ json: String) throws -> RemoteThreadSnapshot.Row {
        try JSONDecoder().decode(RemoteThreadSnapshot.Row.self, from: Data(json.utf8))
    }

    @Test func buildsRosterItemsWithAuthorityAndSystemBucket() throws {
        let state = try JSONDecoder().decode(
            RemoteEnsembleState.self,
            from: Data(
                """
                {"threadId":"thread-1","active":false,
                 "bossmanParticipantId":"seat-boss",
                 "captainParticipantIds":["seat-captain-3","seat-captain-1","seat-captain-2"],
                 "secondInCommandParticipantId":"stale-captain",
                 "roster":[
                   {"id":"seat-captain-3","provider":"cursor","role":"Captain 3","order":4},
                   {"id":"seat-captain-1","provider":"kimi","role":"Captain 1","order":2},
                   {"id":"seat-boss","provider":"codex","role":"Boss","order":1},
                   {"id":"seat-captain-2","provider":"claude","role":"Captain 2","order":3}
                 ]}
                """.utf8
            )
        )

        let items = TranscriptNavigationAdapter.filterItems(for: state)

        #expect(items.map(\.key) == [
            "participant:seat-boss", "participant:seat-captain-1",
            "participant:seat-captain-2", "participant:seat-captain-3", "system",
        ])
        #expect(items[0].isBossman)
        #expect(items[1].isCaptain)
        #expect(items[2].isCaptain)
        #expect(items[3].isCaptain)
    }

    @Test func explicitEmptyCaptainArrayBeatsStaleScalarAndEntryFlag() throws {
        let state = try JSONDecoder().decode(
            RemoteEnsembleState.self,
            from: Data(
                """
                {"bossmanParticipantId":"boss",
                 "captainParticipantIds":[],
                 "secondInCommandParticipantId":"captain",
                 "roster":[
                   {"id":"boss","provider":"codex","order":1},
                   {"id":"captain","provider":"kimi","order":2,
                    "isSecondInCommand":true}
                 ]}
                """.utf8
            )
        )

        let items = TranscriptNavigationAdapter.filterItems(for: state)
        #expect(items.first(where: { $0.key == "participant:captain" })?.isCaptain == false)
    }

    @Test func legacyScalarAndEntryFlagsRemainCompatibleWhenPluralIsAbsent() throws {
        let state = try JSONDecoder().decode(
            RemoteEnsembleState.self,
            from: Data(
                """
                {"bossmanParticipantId":"boss",
                 "secondInCommandParticipantId":"captain-2",
                 "roster":[
                   {"id":"boss","provider":"codex","order":1},
                   {"id":"captain-1","provider":"kimi","order":2,
                    "isSecondInCommand":true},
                   {"id":"captain-2","provider":"claude","order":3}
                 ]}
                """.utf8
            )
        )

        let captainKeys = TranscriptNavigationAdapter.filterItems(for: state)
            .filter(\.isCaptain).map(\.key)
        #expect(captainKeys == ["participant:captain-1", "participant:captain-2"])
    }

    @Test func filtersByDurableParticipantIdentityAndSystemFallback() throws {
        let rows = try [
            row(
                """
                {"id":"assistant-1","ensembleParticipantId":"seat-1",
                 "role":"assistant","kind":"assistant","preview":"one",
                 "truncated":false,"timestamp":"2026-08-03T20:00:00.000Z"}
                """
            ),
            row(
                """
                {"id":"user-1","role":"user","kind":"user","preview":"question",
                 "truncated":false,"timestamp":"2026-08-03T20:00:01.000Z"}
                """
            ),
            row(
                """
                {"id":"assistant-2","ensembleParticipantId":"seat-2",
                 "role":"assistant","kind":"assistant","preview":"two",
                 "truncated":false,"timestamp":"2026-08-03T20:00:02.000Z"}
                """
            ),
        ]

        #expect(
            TranscriptNavigationAdapter.filterRows(
                rows, activeFilterKeys: ["participant:seat-2"]
            ).map(\.id) == ["assistant-2"]
        )
        #expect(
            TranscriptNavigationAdapter.filterRows(
                rows, activeFilterKeys: ["system"]
            ).map(\.id) == ["user-1"]
        )
    }

    @Test func scrubberUsesOnlyLoadedFilteredUserRows() throws {
        let rows = try [
            row(
                """
                {"id":"u1","role":"user","kind":"user","preview":"First question",
                 "truncated":false,"timestamp":"2026-08-03T20:00:00.000Z"}
                """
            ),
            row(
                """
                {"id":"a1","ensembleParticipantId":"seat-1",
                 "role":"assistant","kind":"assistant","preview":"Answer",
                 "truncated":false,"timestamp":"2026-08-03T20:00:01.000Z"}
                """
            ),
            row(
                """
                {"id":"u2","role":"user","kind":"user","preview":"Second question",
                 "truncated":false,"timestamp":"2026-08-03T20:00:02.000Z"}
                """
            ),
        ]

        let markers = TranscriptNavigationAdapter.scrubberMarkers(for: rows)

        #expect(markers.map(\.messageId) == ["u1", "u2"])
        #expect(markers.map(\.rowIndex) == [0, 2])
    }

    @Test func liveSelectionUsesParticipantOrSystemBucket() {
        #expect(
            TranscriptNavigationAdapter.selectedParticipantId(
                activeFilterKeys: ["participant:seat-1"],
                activeParticipantId: "seat-1"
            )
        )
        #expect(
            !TranscriptNavigationAdapter.selectedParticipantId(
                activeFilterKeys: ["participant:seat-2"],
                activeParticipantId: "seat-1"
            )
        )
        #expect(
            TranscriptNavigationAdapter.selectedParticipantId(
                activeFilterKeys: ["system"],
                activeParticipantId: nil
            )
        )
    }
}
