import Foundation
import Testing

@testable import TaskWraithKit

@Suite("HostSnapshotCache")
struct HostSnapshotCacheTests {
  @Test("applies an ordered 30-participant fan-out atomically")
  func appliesThirtyParticipants() throws {
    let snapshot = baseSnapshot()
    let deltas = try (0..<30).map { index in
      let participant = HostParticipantProjection(
        id: "seat-\(index)", threadId: "thread-1", providerId: "codex",
        role: "Worker \(index)", stage: .worker, order: index,
        enabled: true, active: index < 8)
      return HostDeltaEnvelope(
        generation: 7, cursor: index + 1, previousCursor: index,
        kind: .upsert, family: .participant,
        entityId: participantId(participant),
        payload: try payload(participant), at: timestamp(index))
    }

    let result = applyHostSnapshotDeltas(cache: snapshot, deltas: deltas)
    guard
      case .applied(
        let applied, let count, let duplicates, let late) = result
    else {
      Issue.record("expected applied, got \(result)")
      return
    }
    #expect(count == 30)
    #expect(duplicates == 0)
    #expect(late == 0)
    #expect(applied.cursor == 30)
    #expect(applied.participants.count == 30)
    #expect(applied.participants.map(\.order) == Array(0..<30))
    #expect(applied.freshness == .cached)
    #expect(applied.health.freshness == .cached)
    #expect(snapshot.cursor == 0)
    #expect(snapshot.participants.isEmpty)
  }

  @Test("duplicate and late deltas are idempotent skips")
  func duplicateAndLateAreSkipped() throws {
    let snapshot = baseSnapshot(cursor: 5)
    let duplicate = try warningDelta(cursor: 5, previousCursor: 4, id: "duplicate")
    let late = try warningDelta(cursor: 3, previousCursor: 2, id: "late")

    let result = applyHostSnapshotDeltas(
      cache: snapshot, deltas: [duplicate, late])
    guard case .unchanged(let unchanged, let duplicates, let lateCount) = result else {
      Issue.record("expected unchanged, got \(result)")
      return
    }
    #expect(unchanged == snapshot)
    #expect(duplicates == 1)
    #expect(lateCount == 1)
    #expect(unchanged.warnings.isEmpty)
  }

  @Test("generation resets and cursor gaps require a full resnapshot")
  func discontinuitiesRequireResnapshot() throws {
    let snapshot = baseSnapshot(cursor: 2)
    let mismatch = try warningDelta(
      generation: 8, cursor: 1, previousCursor: 0, id: "mismatch")
    #expect(
      applyHostSnapshotDeltas(cache: snapshot, deltas: [mismatch])
        == .requireResnapshot(
          reason: "generation_mismatch", generation: 8, cursor: 1))

    let reset = HostDeltaEnvelope(
      generation: 7, cursor: 3, previousCursor: 2,
      kind: .generationReset, family: .snapshotMeta,
      at: timestamp(3))
    #expect(
      applyHostSnapshotDeltas(cache: snapshot, deltas: [reset])
        == .requireResnapshot(
          reason: "generation_reset", generation: 7, cursor: 3))

    let gap = try warningDelta(cursor: 4, previousCursor: 2, id: "gap")
    #expect(
      applyHostSnapshotDeltas(cache: snapshot, deltas: [gap])
        == .requireResnapshot(
          reason: "previous_cursor_mismatch", generation: 7, cursor: 4))
    #expect(snapshot.cursor == 2)
    #expect(snapshot.warnings.isEmpty)
  }

  @Test("a malformed later delta rolls back the full batch")
  func malformedLaterDeltaRollsBack() throws {
    let snapshot = baseSnapshot()
    let valid = try warningDelta(cursor: 1, previousCursor: 0, id: "valid")
    let malformed = HostDeltaEnvelope(
      generation: 7, cursor: 2, previousCursor: 1,
      kind: .upsert, family: .thread, entityId: "broken",
      payload: .object(["id": "broken"]), at: timestamp(2))

    let result = applyHostSnapshotDeltas(
      cache: snapshot, deltas: [valid, malformed])
    guard case .rejected(let reason) = result else {
      Issue.record("expected rejected, got \(result)")
      return
    }
    #expect(reason.contains("delta[1]"))
    #expect(snapshot.cursor == 0)
    #expect(snapshot.warnings.isEmpty)
  }

  @Test("collection tombstones use stable thread-scoped participant ids")
  func participantTombstoneIsThreadScoped() throws {
    var snapshot = baseSnapshot()
    snapshot.participants = [
      HostParticipantProjection(
        id: "shared", threadId: "thread-a", providerId: "codex",
        role: "A", order: 0, enabled: true, active: true),
      HostParticipantProjection(
        id: "shared", threadId: "thread-b", providerId: "codex",
        role: "B", order: 0, enabled: true, active: true),
    ]
    let first = try #require(snapshot.participants.first)
    let tombstone = HostDeltaEnvelope(
      generation: 7, cursor: 1, previousCursor: 0,
      kind: .tombstone, family: .participant,
      entityId: participantId(first), tombstone: true,
      at: timestamp(1))

    let result = applyHostSnapshotDeltas(cache: snapshot, deltas: [tombstone])
    guard case .applied(let applied, _, _, _) = result else {
      Issue.record("expected applied, got \(result)")
      return
    }
    #expect(applied.participants.count == 1)
    #expect(applied.participants[0].threadId == "thread-b")
    #expect(applied.participants[0].id == "shared")
  }

  @Test("singletons replace, metadata cannot claim live, and removal resnapshots")
  func singletonRules() throws {
    let snapshot = baseSnapshot()
    let health = HostHealthProjection(
      hostStatus: .degraded, detail: "peer offline",
      connectionPhase: .reconnecting, supervised: true,
      freshness: .cached)
    let healthDelta = HostDeltaEnvelope(
      generation: 7, cursor: 1, previousCursor: 0,
      kind: .upsert, family: .health,
      payload: try payload(health), at: timestamp(1))
    let result = applyHostSnapshotDeltas(cache: snapshot, deltas: [healthDelta])
    guard case .applied(let applied, _, _, _) = result else {
      Issue.record("expected applied, got \(result)")
      return
    }
    #expect(applied.health.hostStatus == .degraded)

    let removal = HostDeltaEnvelope(
      generation: 7, cursor: 2, previousCursor: 1,
      kind: .remove, family: .health, at: timestamp(2))
    #expect(
      applyHostSnapshotDeltas(cache: applied, deltas: [removal])
        == .requireResnapshot(
          reason: "unsupported_singleton_removal", generation: 7, cursor: 2))

    let livePromotion = HostDeltaEnvelope(
      generation: 7, cursor: 2, previousCursor: 1,
      kind: .upsert, family: .snapshotMeta,
      payload: .object(["freshness": "live"]), at: timestamp(2))
    guard
      case .rejected(let reason) = applyHostSnapshotDeltas(
        cache: applied, deltas: [livePromotion])
    else {
      Issue.record("expected live promotion rejection")
      return
    }
    #expect(reason.contains("cannot promote cache to live"))
  }

  @Test("provider, run, round, and mission outcomes remain distinct")
  func outcomeTaxonomiesRemainDistinct() throws {
    let snapshot = baseSnapshot()
    let run = HostRunProjection(
      runId: "run-ok", threadId: "thread-1", providerId: "codex",
      providerOutcome: .completed)
    let round = HostRoundProjection(
      roundId: "round-cancelled", threadId: "thread-1", status: .cancelled,
      participantIds: [], providerRunIds: [run.runId])
    let mission = HostMissionProjection(
      missionId: "mission-active", threadId: "thread-1",
      title: "Still going", status: .active, updatedAt: 9)
    let deltas = [
      HostDeltaEnvelope(
        generation: 7, cursor: 1, previousCursor: 0,
        kind: .upsert, family: .run, entityId: run.runId,
        payload: try payload(run), at: timestamp(1)),
      HostDeltaEnvelope(
        generation: 7, cursor: 2, previousCursor: 1,
        kind: .upsert, family: .round, entityId: round.roundId,
        payload: try payload(round), at: timestamp(2)),
      HostDeltaEnvelope(
        generation: 7, cursor: 3, previousCursor: 2,
        kind: .upsert, family: .mission, entityId: mission.missionId,
        payload: try payload(mission), at: timestamp(3)),
    ]

    let result = applyHostSnapshotDeltas(cache: snapshot, deltas: deltas)
    guard case .applied(let applied, _, _, _) = result else {
      Issue.record("expected applied, got \(result)")
      return
    }
    #expect(applied.runs[0].providerOutcome == .completed)
    #expect(applied.rounds[0].status == .cancelled)
    #expect(applied.missions[0].status == .active)
  }

  @Test("oversized delta batches reject without advancing")
  func oversizedBatchRejects() {
    let snapshot = baseSnapshot()
    let delta = HostDeltaEnvelope(
      generation: 7, cursor: 0, previousCursor: 0,
      kind: .upsert, family: .snapshotMeta,
      payload: .object([:]), at: timestamp(0))
    let result = applyHostSnapshotDeltas(
      cache: snapshot,
      deltas: Array(repeating: delta, count: HostProtocolConstants.maxDeltas + 1))
    #expect(result == .rejected(reason: "deltas exceeds max collection"))
    #expect(snapshot.cursor == 0)
  }

  private func baseSnapshot(cursor: Int = 0) -> HostSnapshot {
    createEmptyHostSnapshot(
      generation: 7, cursor: cursor, freshness: .live,
      generatedAt: "2026-08-09T20:00:00Z")
  }

  private func warningDelta(
    generation: Int = 7,
    cursor: Int,
    previousCursor: Int,
    id: String
  ) throws -> HostDeltaEnvelope {
    let warning = HostWarningProjection(
      warningId: id, severity: .info, code: "test.warning",
      message: id, at: cursor)
    return HostDeltaEnvelope(
      generation: generation, cursor: cursor, previousCursor: previousCursor,
      kind: .upsert, family: .warning, entityId: id,
      payload: try payload(warning), at: timestamp(cursor))
  }

  private func participantId(_ participant: HostParticipantProjection) -> String {
    switch encodeHostParticipantEntityId(
      threadId: participant.threadId, participantId: participant.id)
    {
    case .ok(let value): return value
    case .error(let reason):
      Issue.record("participant id failed: \(reason)")
      return "invalid"
    }
  }

  private func payload<T: Encodable>(_ value: T) throws -> HostJSONAny {
    let data = try JSONEncoder().encode(value)
    return try JSONDecoder().decode(HostJSONAny.self, from: data)
  }

  private func timestamp(_ offset: Int) -> String {
    "2026-08-09T20:00:\(String(format: "%02d", offset % 60))Z"
  }
}
