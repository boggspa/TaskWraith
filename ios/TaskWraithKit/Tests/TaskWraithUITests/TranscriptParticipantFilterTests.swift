import Foundation
import Testing
@testable import TaskWraithUI

@Suite("Transcript participant filter")
struct TranscriptParticipantFilterTests {
    private func entry(
        id: String,
        provider: String,
        role: String,
        order: Int,
        pooled: Bool = false,
        boss: Bool = false,
        captain: Bool = false
    ) -> TranscriptParticipantFilterRosterEntry {
        TranscriptParticipantFilterRosterEntry(
            id: id,
            provider: provider,
            role: role,
            order: order,
            pooledAgent: pooled,
            isBossman: boss,
            isCaptain: captain
        )
    }

    @Test func buildsOrderedItemsWithAuthorityAndSystemBucket() {
        let items = TranscriptParticipantFilter.buildItems(roster: [
            entry(id: "boss", provider: "codex", role: "Boss", order: 3, boss: true),
            entry(id: "pooled", provider: "kimi", role: "Scout", order: 1, pooled: true),
            entry(id: "captain", provider: "claude", role: "Captain", order: 2, captain: true)
        ])

        #expect(items.map(\.key) == [
            TranscriptParticipantFilter.key(forParticipantId: "pooled"),
            TranscriptParticipantFilter.key(forParticipantId: "captain"),
            TranscriptParticipantFilter.key(forParticipantId: "boss"),
            transcriptSystemFilterKey
        ])
        #expect(items.map(\.ordinal) == [1, 2, 3, nil])
        #expect(items[0].pooledAgent == true)
        #expect(items[1].isCaptain == true)
        #expect(items[2].isBossman == true)
        #expect(items[3].kind == .system)
        #expect(items[3].title == "System messages")
    }

    @Test func emptySelectionShowsAllAndAdditiveFiltersWork() {
        let rows = [
            TranscriptFilterableRow(id: "user", role: "user"),
            TranscriptFilterableRow(id: "a", role: "assistant", ensembleParticipantId: "a"),
            TranscriptFilterableRow(id: "b", role: "assistant", ensembleParticipantId: "b"),
            TranscriptFilterableRow(id: "a-tools", role: "tool", ensembleParticipantId: "a"),
            TranscriptFilterableRow(id: "system", role: "system")
        ]

        let all = TranscriptParticipantFilter.filterRows(rows, activeFilterKeys: [])
        #expect(all.map(\.id) == rows.map(\.id))

        let onlyA = TranscriptParticipantFilter.filterRows(
            rows,
            activeFilterKeys: [TranscriptParticipantFilter.key(forParticipantId: "a")]
        )
        #expect(onlyA.map(\.id) == ["a", "a-tools"])

        let systemOnly = TranscriptParticipantFilter.filterRows(
            rows,
            activeFilterKeys: [transcriptSystemFilterKey]
        )
        #expect(systemOnly.map(\.id) == ["user", "system"])

        let systemAndB = TranscriptParticipantFilter.filterRows(
            rows,
            activeFilterKeys: [
                transcriptSystemFilterKey,
                TranscriptParticipantFilter.key(forParticipantId: "b")
            ]
        )
        #expect(systemAndB.map(\.id) == ["user", "b", "system"])
    }

    @Test func toggleIsAdditiveAndPrunesStaleParticipantKeys() {
        var active: Set<String> = []
        let keyA = TranscriptParticipantFilter.key(forParticipantId: "a")
        let keyB = TranscriptParticipantFilter.key(forParticipantId: "b")

        active = TranscriptParticipantFilter.toggle(key: keyA, in: active)
        active = TranscriptParticipantFilter.toggle(key: keyB, in: active)
        #expect(active == [keyA, keyB])

        active = TranscriptParticipantFilter.toggle(key: keyA, in: active)
        #expect(active == [keyB])

        let remaining = TranscriptParticipantFilter.buildItems(roster: [
            entry(id: "b", provider: "claude", role: "Reviewer", order: 1)
        ])
        // Stale key for removed seat "a" would have been re-added; prune it.
        active.insert(keyA)
        let pruned = TranscriptParticipantFilter.pruneStaleKeys(
            activeFilterKeys: active,
            validItems: remaining
        )
        #expect(pruned == [keyB])
        #expect(TranscriptParticipantFilter.isFilterActive(pruned))
    }

    @Test func capsAtFiftyParticipantsPlusSystem() {
        let roster = (0..<55).map { i in
            entry(id: "p\(i)", provider: "codex", role: "Seat \(i)", order: i)
        }
        let items = TranscriptParticipantFilter.buildItems(roster: roster)
        #expect(items.count == 51) // 50 seats + System
        #expect(items.last?.kind == .system)
        #expect(items.filter { $0.kind == .participant }.count == 50)
        #expect(items[0].participantId == "p0")
        #expect(items[49].participantId == "p49")
    }

    @Test func emptyRosterProducesNoRail() {
        #expect(TranscriptParticipantFilter.buildItems(roster: []).isEmpty)
    }

    @Test func keysStayStableOnParticipantIdsNotOrdinals() {
        let items = TranscriptParticipantFilter.buildItems(roster: [
            entry(id: "stable-id", provider: "grok", role: "Worker", order: 9)
        ])
        #expect(items[0].key == "participant:stable-id")
        #expect(items[0].participantId == "stable-id")
        #expect(items[0].ordinal == 1)
    }
}
