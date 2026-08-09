import Foundation
import Testing

@testable import TaskWraithKit

@Suite("Paired Host projection")
struct PairedHostProjectionTests {
  @Test("derives the Mac-compatible pair identity and encodes exact requests")
  func identityAndRequestEncoding() throws {
    let identity = try #require(makeIdentity())
    #expect(identity.clientId == "iphone-4bb06f8e4e3a7715")

    let snapshotRequest = try encodePairedHostRequest(
      kind: .snapshotGet, params: PairedHostEmptyParameters())
    let object = try #require(
      JSONSerialization.jsonObject(with: snapshotRequest) as? [String: Any])
    #expect(object["kind"] as? String == "snapshot.get")
    #expect((object["params"] as? [String: Any])?.isEmpty == true)

    let command = makePairedHostCommand(
      identity: identity, name: .runCancel,
      target: ["threadId": "thread-1"], arguments: [:],
      commandId: "command-1", idempotencyKey: "idem-1",
      issuedAt: "2026-08-09T20:00:00Z")
    #expect(command.actor.actorId == identity.clientId)
    #expect(command.actor.clientId == identity.clientId)
    #expect(command.actor.clientClass == .ios)
    #expect(command.name == .runCancel)
  }

  @Test("rejects a welcome bound to any identity other than this phone")
  func rejectsSpoofedWelcomeIdentity() throws {
    let identity = try #require(makeIdentity())
    var replica = PairedHostProjectionReplica(identity: identity)
    var frame = welcome(identity: identity)
    frame.authenticatedClient.subjectId = "spoofed-phone"

    let result = replica.receive(
      method: PairedHostProjectionMethods.welcome,
      params: try JSONEncoder().encode(frame))
    guard case .rejected(let reason) = result else {
      Issue.record("expected rejection, got \(result)")
      return
    }
    #expect(reason.contains("does not match"))
    #expect(replica.welcome == nil)
    #expect(replica.snapshot == nil)
  }

  @Test("publishes a coherent welcome, snapshot, delta, and live cursor")
  func appliesCoherentSequence() throws {
    let identity = try #require(makeIdentity())
    var replica = PairedHostProjectionReplica(identity: identity)
    #expect(
      replica.receive(
        method: PairedHostProjectionMethods.welcome,
        params: try JSONEncoder().encode(welcome(identity: identity))) == .updated)
    #expect(
      replica.receive(
        method: PairedHostProjectionMethods.snapshot,
        params: try JSONEncoder().encode(snapshotFrame())) == .updated)

    let delta = warningDelta(cursor: 1, previousCursor: 0)
    let deltas = HostDeltasFrame(
      result: .deltas(
        .init(generation: 7, fromCursor: 0, toCursor: 1, deltas: [delta])))
    #expect(
      replica.receive(
        method: PairedHostProjectionMethods.deltas,
        params: try JSONEncoder().encode(deltas)) == .updated)
    #expect(replica.snapshot?.cursor == 1)
    #expect(replica.snapshot?.warnings.map(\.warningId) == ["warning-1"])

    let live = PairedHostProjectionStateMessage(
      phase: .live, generation: 7, cursor: 1)
    #expect(
      replica.receive(
        method: PairedHostProjectionMethods.state,
        params: try JSONEncoder().encode(live)) == .updated)
    #expect(replica.phase == .live)
    #expect(replica.snapshot?.generation == 7)
    #expect(replica.snapshot?.cursor == 1)
  }

  @Test("duplicate and late frames cannot roll the replica backward")
  func duplicateAndLateFramesAreIgnored() throws {
    let identity = try #require(makeIdentity())
    var replica = try seededReplica(identity: identity, cursor: 1)
    let duplicate = HostDeltasFrame(
      result: .deltas(
        .init(
          generation: 7, fromCursor: 0, toCursor: 1,
          deltas: [warningDelta(cursor: 1, previousCursor: 0)])))

    #expect(
      replica.receive(
        method: PairedHostProjectionMethods.deltas,
        params: try JSONEncoder().encode(duplicate)) == .ignored)
    #expect(replica.snapshot?.cursor == 1)

    let lateSnapshot = snapshotFrame(cursor: 0)
    #expect(
      replica.receive(
        method: PairedHostProjectionMethods.snapshot,
        params: try JSONEncoder().encode(lateSnapshot)) == .ignored)
    #expect(replica.snapshot?.cursor == 1)
  }

  @Test("gaps and explicit resets request a full authoritative snapshot")
  func gapsRequireSnapshot() throws {
    let identity = try #require(makeIdentity())
    var replica = try seededReplica(identity: identity)
    let gap = HostDeltasFrame(
      result: .deltas(
        .init(
          generation: 7, fromCursor: 2, toCursor: 3,
          deltas: [warningDelta(cursor: 3, previousCursor: 2)])))
    guard
      case .requireSnapshot(let reason) = replica.receive(
        method: PairedHostProjectionMethods.deltas,
        params: try JSONEncoder().encode(gap))
    else {
      Issue.record("expected gap resnapshot")
      return
    }
    #expect(reason == "previous_cursor_mismatch")
    #expect(replica.snapshot?.cursor == 0)

    let reset = HostDeltasFrame(
      result: .fullResnapshotRequired(
        .init(
          reason: "generation_mismatch", generation: 8, cursor: 0,
          clientGeneration: 7, clientCursor: 0)))
    #expect(
      replica.receive(
        method: PairedHostProjectionMethods.deltas,
        params: try JSONEncoder().encode(reset))
        == .requireSnapshot(reason: "generation_mismatch"))
  }

  @Test("a malformed later delta rejects the whole frame without partial publish")
  func malformedFrameRollsBack() throws {
    let identity = try #require(makeIdentity())
    var replica = try seededReplica(identity: identity)
    let malformed = HostDeltaEnvelope(
      generation: 7, cursor: 2, previousCursor: 1,
      kind: .upsert, family: .thread, entityId: "broken",
      payload: .object(["id": "broken"]), at: "2026-08-09T20:00:02Z")
    let frame = HostDeltasFrame(
      result: .deltas(
        .init(
          generation: 7, fromCursor: 0, toCursor: 2,
          deltas: [warningDelta(cursor: 1, previousCursor: 0), malformed])))

    guard
      case .rejected(let reason) = replica.receive(
        method: PairedHostProjectionMethods.deltas,
        params: try JSONEncoder().encode(frame))
    else {
      Issue.record("expected malformed frame rejection")
      return
    }
    #expect(reason.contains("delta[1]"))
    #expect(replica.snapshot?.cursor == 0)
    #expect(replica.snapshot?.warnings.isEmpty == true)
  }

  @Test("transport loss preserves only a coherent stale snapshot")
  func transportLossMarksSnapshotStale() throws {
    let identity = try #require(makeIdentity())
    var replica = try seededReplica(identity: identity)
    replica.markTransportClosed()

    #expect(replica.phase == .reconnecting)
    #expect(replica.welcome == nil)
    #expect(replica.snapshot?.freshness == .stale)
    #expect(replica.snapshot?.health.freshness == .stale)
    #expect(replica.snapshot?.health.connectionPhase == .staleCache)
  }

  @Test("snapshot response and command receipt decode fail closed")
  func responseDecoders() throws {
    let response = SnapshotResponseFixture(kind: .snapshotGet, frame: snapshotFrame())
    let decoded = decodePairedHostSnapshotResponse(try JSONEncoder().encode(response))
    guard case .ok(let frame) = decoded else {
      Issue.record("expected snapshot response")
      return
    }
    #expect(frame.snapshot.cursor == 0)

    let identity = try #require(makeIdentity())
    let receipt = HostCommandReceipt(
      commandId: "command-1", idempotencyKey: "idem-1", name: .ping,
      actor: HostActorIdentity(
        actorId: identity.clientId, clientId: identity.clientId, clientClass: .ios),
      authority: HostAuthorityDecision(decision: .allow), status: .succeeded,
      commandFingerprint: String(repeating: "a", count: 64), generation: 7, cursor: 1,
      createdAt: "2026-08-09T20:00:00Z", updatedAt: "2026-08-09T20:00:01Z")
    let commandResponse = CommandResponseFixture(kind: .commandSubmit, receipt: receipt)
    #expect(
      decodePairedHostCommandResponse(try JSONEncoder().encode(commandResponse)) == .ok(receipt))

    let wrongKind = SnapshotResponseFixture(kind: .healthGet, frame: snapshotFrame())
    guard
      case .error(let reason) = decodePairedHostSnapshotResponse(
        try JSONEncoder().encode(wrongKind))
    else {
      Issue.record("expected wrong-kind rejection")
      return
    }
    #expect(reason == "unexpected response kind")
  }

  @Test("offline cache is per-host, bounded, stale on load, and corruption-safe")
  func offlineCacheRoundTrip() throws {
    let suite = "PairedHostProjectionTests.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let store = UserDefaultsPairedHostSnapshotStore(defaults: defaults, keyPrefix: "test.host.")

    try store.save(snapshotFrame(cursor: 9).snapshot, hostIdentity: "mac-a")
    guard case .ok(let loaded) = store.load(hostIdentity: "mac-a") else {
      Issue.record("expected cached snapshot")
      return
    }
    #expect(loaded.cursor == 9)
    #expect(loaded.freshness == .stale)
    #expect(loaded.health.connectionPhase == .staleCache)
    #expect(store.load(hostIdentity: "mac-b") == nil)

    let key = try #require(
      defaults.dictionaryRepresentation().keys.first { $0.hasPrefix("test.host.") })
    defaults.set(Data("not-json".utf8), forKey: key)
    guard case .error(let reason) = store.load(hostIdentity: "mac-a") else {
      Issue.record("expected corrupt cache rejection")
      return
    }
    #expect(reason.contains("decode failed"))

    store.remove(hostIdentity: "mac-a")
    #expect(store.load(hostIdentity: "mac-a") == nil)
  }

  private struct SnapshotResponseFixture: Codable {
    let kind: PairedHostRequestKind
    let frame: HostSnapshotFrame
  }

  private struct CommandResponseFixture: Codable {
    let kind: PairedHostRequestKind
    let receipt: HostCommandReceipt
  }

  private func makeIdentity() -> PairedHostProjectionIdentity? {
    pairedHostProjectionIdentity(
      identityPublicKeyBase64: Base64.encode(Data(repeating: 7, count: 32)))
  }

  private func welcome(identity: PairedHostProjectionIdentity) -> HostBootstrapWelcome {
    HostBootstrapWelcome(
      hostId: "11111111-1111-4111-8111-111111111111",
      hostVersion: "1.9.4",
      sessionId: "22222222-2222-4222-8222-222222222222",
      generation: 7,
      cursor: 0,
      authenticatedClient: HostAuthenticatedClientIdentity(
        clientId: identity.clientId,
        clientClass: .ios,
        clientVersion: "1.9.4",
        subjectId: identity.subjectId,
        displayName: "Test iPhone"),
      capabilities: HostCapability.ordered,
      freshness: .live)
  }

  private func snapshotFrame(cursor: Int = 0) -> HostSnapshotFrame {
    HostSnapshotFrame(
      snapshot: createEmptyHostSnapshot(
        generation: 7,
        cursor: cursor,
        freshness: .live,
        generatedAt: "2026-08-09T20:00:00Z"))
  }

  private func warningDelta(cursor: Int, previousCursor: Int) -> HostDeltaEnvelope {
    let warning = HostWarningProjection(
      warningId: "warning-\(cursor)", severity: .info,
      code: "test.warning", message: "Warning \(cursor)", at: cursor)
    let payload: HostJSONAny
    do {
      payload = try JSONDecoder().decode(
        HostJSONAny.self, from: JSONEncoder().encode(warning))
    } catch {
      Issue.record("warning payload failed: \(error)")
      payload = .null
    }
    return HostDeltaEnvelope(
      generation: 7, cursor: cursor, previousCursor: previousCursor,
      kind: .upsert, family: .warning, entityId: warning.warningId,
      payload: payload, at: "2026-08-09T20:00:\(String(format: "%02d", cursor))Z")
  }

  private func seededReplica(
    identity: PairedHostProjectionIdentity,
    cursor: Int = 0
  ) throws -> PairedHostProjectionReplica {
    var replica = PairedHostProjectionReplica(identity: identity)
    #expect(
      replica.receive(
        method: PairedHostProjectionMethods.welcome,
        params: try JSONEncoder().encode(welcome(identity: identity))) == .updated)
    #expect(
      replica.receive(
        method: PairedHostProjectionMethods.snapshot,
        params: try JSONEncoder().encode(snapshotFrame(cursor: cursor))) == .updated)
    return replica
  }
}
