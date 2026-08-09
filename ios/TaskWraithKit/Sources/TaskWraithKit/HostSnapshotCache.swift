// HostSnapshotCache — atomic Host v2 projection-cache application for iOS.
//
// The paired companion may retain a coherent snapshot for presentation and
// offline use, but it never becomes authority. Ordered deltas are applied to a
// value copy, validated as a complete HostSnapshot, and published only when the
// entire batch succeeds. Cursor discontinuities request an authoritative full
// snapshot; malformed payloads reject without advancing the cache.

import Foundation

public enum HostSnapshotCacheApplyResult: Equatable, Sendable {
  case applied(
    snapshot: HostSnapshot,
    appliedCount: Int,
    skippedDuplicates: Int,
    skippedLate: Int)
  case unchanged(
    snapshot: HostSnapshot,
    skippedDuplicates: Int,
    skippedLate: Int)
  case requireResnapshot(
    reason: String,
    generation: HostGeneration,
    cursor: HostCursor)
  case rejected(reason: String)
}

private enum HostSnapshotMutationResult {
  case applied
  case requireResnapshot(String)
  case rejected(String)
}

private struct HostSnapshotCacheError: Error, LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

private func normalizedHostSnapshot(_ snapshot: HostSnapshot) throws -> HostSnapshot {
  let data: Data
  do {
    data = try JSONEncoder().encode(snapshot)
  } catch {
    throw HostSnapshotCacheError(message: "snapshot encode failed: \(error.localizedDescription)")
  }
  switch decodeHostSnapshot(from: data) {
  case .ok(let decoded):
    return decoded
  case .error(let reason):
    throw HostSnapshotCacheError(message: reason)
  }
}

private func decodedHostPayload<T: Decodable>(
  _ payload: HostJSONAny?, as type: T.Type, family: HostDeltaFamily
) throws -> T {
  guard let payload else {
    throw HostSnapshotCacheError(
      message: "\(family.rawValue) upsert requires a fully valid payload")
  }
  do {
    let data = try JSONEncoder().encode(payload)
    return try JSONDecoder().decode(type, from: data)
  } catch {
    throw HostSnapshotCacheError(
      message: "\(family.rawValue) payload is invalid: \(error.localizedDescription)")
  }
}

private func participantEntityId(_ participant: HostParticipantProjection) -> String? {
  switch encodeHostParticipantEntityId(
    threadId: participant.threadId, participantId: participant.id)
  {
  case .ok(let value): return value
  case .error: return nil
  }
}

private func mutateCollection<T: Codable>(
  _ list: inout [T],
  delta: HostDeltaEnvelope,
  entityId: (T) -> String?
) -> HostSnapshotMutationResult {
  switch delta.kind {
  case .remove, .tombstone:
    guard let deltaEntityId = delta.entityId, !deltaEntityId.isEmpty else {
      return .rejected(
        "\(delta.family.rawValue) \(delta.kind.rawValue) requires entityId")
    }
    guard delta.payload == nil else {
      return .rejected(
        "\(delta.family.rawValue) \(delta.kind.rawValue) forbids payload")
    }
    list.removeAll { entityId($0) == deltaEntityId }
    return .applied

  case .upsert:
    guard let deltaEntityId = delta.entityId, !deltaEntityId.isEmpty else {
      return .rejected("\(delta.family.rawValue) upsert requires entityId")
    }
    do {
      let value = try decodedHostPayload(delta.payload, as: T.self, family: delta.family)
      guard let payloadEntityId = entityId(value) else {
        return .rejected(
          "\(delta.family.rawValue) upsert payload is missing its stable id")
      }
      guard payloadEntityId == deltaEntityId else {
        return .rejected(
          "\(delta.family.rawValue) entityId does not match payload id")
      }
      list.removeAll { entityId($0) == deltaEntityId }
      list.append(value)
      return .applied
    } catch {
      return .rejected(error.localizedDescription)
    }

  case .generationReset:
    return .rejected("collection cannot apply generation-reset")
  }
}

private func mutateSingleton<T: Decodable>(
  _ value: inout T,
  delta: HostDeltaEnvelope,
  as type: T.Type
) -> HostSnapshotMutationResult {
  switch delta.kind {
  case .remove, .tombstone:
    return .requireResnapshot("unsupported_singleton_removal")
  case .generationReset:
    return .rejected("singleton cannot apply generation-reset")
  case .upsert:
    do {
      value = try decodedHostPayload(delta.payload, as: type, family: delta.family)
      return .applied
    } catch {
      return .rejected(error.localizedDescription)
    }
  }
}

private func mutateOptionalSingleton<T: Decodable>(
  _ value: inout T?,
  delta: HostDeltaEnvelope,
  as type: T.Type
) -> HostSnapshotMutationResult {
  switch delta.kind {
  case .remove, .tombstone:
    return .requireResnapshot("unsupported_singleton_removal")
  case .generationReset:
    return .rejected("singleton cannot apply generation-reset")
  case .upsert:
    do {
      value = try decodedHostPayload(delta.payload, as: type, family: delta.family)
      return .applied
    } catch {
      return .rejected(error.localizedDescription)
    }
  }
}

private func mutateSnapshotMetadata(
  _ snapshot: inout HostSnapshot,
  delta: HostDeltaEnvelope
) -> HostSnapshotMutationResult {
  switch delta.kind {
  case .remove, .tombstone:
    return .requireResnapshot("unsupported_singleton_removal")
  case .generationReset:
    return .rejected("snapshot-meta cannot apply generation-reset")
  case .upsert:
    break
  }

  guard let payload = delta.payload else {
    return .rejected("snapshot-meta upsert requires a payload")
  }
  guard case .object(let object) = payload else {
    return .rejected("snapshot-meta payload must be an object")
  }
  let allowed = Set(["generatedAt", "freshness"])
  if let unknown = object.keys.first(where: { !allowed.contains($0) }) {
    return .rejected("snapshot-meta payload has unknown key: \(unknown)")
  }
  if let generatedAt = object["generatedAt"] {
    guard case .string(let value) = generatedAt,
      !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else {
      return .rejected("snapshot-meta generatedAt is invalid")
    }
    snapshot.generatedAt = value
  }
  if let freshness = object["freshness"] {
    guard case .string(let raw) = freshness,
      let decoded = HostProjectionFreshness(rawValue: raw)
    else {
      return .rejected("snapshot-meta freshness is invalid")
    }
    guard decoded != .live else {
      return .rejected("snapshot-meta cannot promote cache to live")
    }
    snapshot.freshness = decoded
  }
  return .applied
}

private func mutateHostSnapshot(
  _ snapshot: inout HostSnapshot,
  delta: HostDeltaEnvelope
) -> HostSnapshotMutationResult {
  let outcome: HostSnapshotMutationResult
  switch delta.family {
  case .workspace:
    outcome = mutateCollection(&snapshot.workspaces, delta: delta) { $0.id }
  case .thread:
    outcome = mutateCollection(&snapshot.threads, delta: delta) { $0.id }
  case .run:
    outcome = mutateCollection(&snapshot.runs, delta: delta) { $0.runId }
  case .mission:
    outcome = mutateCollection(&snapshot.missions, delta: delta) { $0.missionId }
  case .round:
    outcome = mutateCollection(&snapshot.rounds, delta: delta) { $0.roundId }
  case .participant:
    outcome = mutateCollection(
      &snapshot.participants, delta: delta, entityId: participantEntityId)
  case .provider:
    outcome = mutateCollection(&snapshot.providers, delta: delta) { $0.providerId }
  case .question:
    outcome = mutateCollection(&snapshot.questions, delta: delta) { $0.questionId }
  case .approval:
    outcome = mutateCollection(&snapshot.approvals, delta: delta) { $0.approvalId }
  case .schedule:
    outcome = mutateCollection(&snapshot.schedules, delta: delta) { $0.scheduleId }
  case .artifact:
    outcome = mutateCollection(&snapshot.artifacts, delta: delta) { $0.artifactId }
  case .warning:
    outcome = mutateCollection(&snapshot.warnings, delta: delta) { $0.warningId }
  case .health:
    outcome = mutateSingleton(
      &snapshot.health, delta: delta, as: HostHealthProjection.self)
  case .usage:
    outcome = mutateSingleton(
      &snapshot.usage, delta: delta, as: HostUsageObservation.self)
  case .recovery:
    outcome = mutateSingleton(
      &snapshot.recovery, delta: delta, as: HostRecoveryProjection.self)
  case .routing:
    outcome = mutateOptionalSingleton(
      &snapshot.routing, delta: delta, as: HostRoutingProjection.self)
  case .snapshotMeta:
    outcome = mutateSnapshotMetadata(&snapshot, delta: delta)
  }

  guard case .applied = outcome else { return outcome }
  do {
    snapshot = try normalizedHostSnapshot(snapshot)
    return .applied
  } catch {
    return .rejected(error.localizedDescription)
  }
}

private func invalidHostDeltaReason(_ delta: HostDeltaEnvelope) -> String? {
  guard delta.protocolVersion == HostProtocolConstants.protocolVersion else {
    return "unsupported protocol version"
  }
  guard delta.projectionVersion == HostProtocolConstants.projectionVersion else {
    return "unsupported projection version"
  }
  guard delta.generation >= 0 else { return "generation must be a non-negative integer" }
  guard delta.cursor >= 0 else { return "cursor must be a non-negative integer" }
  guard delta.previousCursor >= 0 else {
    return "previousCursor must be a non-negative integer"
  }
  if let entityId = delta.entityId {
    guard !entityId.isEmpty, entityId.utf16.count <= HostProtocolConstants.maxID else {
      return "entityId is invalid"
    }
  }
  guard !delta.at.isEmpty, delta.at.utf16.count <= 80 else { return "at is required" }
  if delta.kind == .tombstone, delta.tombstone != true {
    return "tombstone kind requires tombstone:true"
  }
  return nil
}

/// Apply an ordered batch to a coherent iOS Host projection cache.
///
/// The input value is never mutated. Duplicate and late frames are idempotent
/// skips. Any generation/cursor discontinuity requests an authoritative full
/// snapshot. A malformed delta rejects the whole batch, so callers never
/// publish a partially advanced cursor.
public func applyHostSnapshotDeltas(
  cache: HostSnapshot,
  deltas: [HostDeltaEnvelope]
) -> HostSnapshotCacheApplyResult {
  let original: HostSnapshot
  do {
    original = try normalizedHostSnapshot(cache)
  } catch {
    return .rejected(reason: "invalid base snapshot: \(error.localizedDescription)")
  }

  guard deltas.count <= HostProtocolConstants.maxDeltas else {
    return .rejected(reason: "deltas exceeds max collection")
  }
  guard !deltas.isEmpty else {
    return .unchanged(
      snapshot: cache, skippedDuplicates: 0, skippedLate: 0)
  }

  var working = original
  var appliedCount = 0
  var skippedDuplicates = 0
  var skippedLate = 0

  for (index, delta) in deltas.enumerated() {
    if let reason = invalidHostDeltaReason(delta) {
      return .rejected(reason: "delta[\(index)]: \(reason)")
    }

    switch applyHostDeltaCursor(
      current: HostCursorPosition(
        generation: working.generation, cursor: working.cursor),
      delta: delta)
    {
    case .duplicate:
      skippedDuplicates += 1
      continue
    case .late:
      skippedLate += 1
      continue
    case .requireResnapshot(let reason, let generation, let cursor):
      return .requireResnapshot(
        reason: reason, generation: generation, cursor: cursor)
    case .rejected(let reason):
      return .rejected(reason: reason)
    case .applied(let generation, let cursor):
      switch mutateHostSnapshot(&working, delta: delta) {
      case .applied:
        working.generation = generation
        working.cursor = cursor
        appliedCount += 1
      case .requireResnapshot(let reason):
        return .requireResnapshot(
          reason: reason, generation: delta.generation, cursor: delta.cursor)
      case .rejected(let reason):
        return .rejected(reason: "delta[\(index)]: \(reason)")
      }
    }
  }

  guard appliedCount > 0 else {
    return .unchanged(
      snapshot: cache,
      skippedDuplicates: skippedDuplicates,
      skippedLate: skippedLate)
  }

  if working.freshness == .live { working.freshness = .cached }
  if working.health.freshness == .live { working.health.freshness = .cached }
  do {
    working = try normalizedHostSnapshot(working)
  } catch {
    return .rejected(reason: "post-apply snapshot invalid: \(error.localizedDescription)")
  }
  return .applied(
    snapshot: working,
    appliedCount: appliedCount,
    skippedDuplicates: skippedDuplicates,
    skippedLate: skippedLate)
}
