import Foundation
import Testing

@testable import TaskWraithKit
@testable import TaskWraithUI

private final class MemoryHostSnapshotStore: PairedHostSnapshotStore, @unchecked Sendable {
  private let lock = NSLock()
  private var values: [String: HostSnapshot] = [:]
  private(set) var saveCount = 0

  func load(hostIdentity: String) -> HostDecodeResult<HostSnapshot>? {
    lock.lock()
    defer { lock.unlock() }
    return values[hostIdentity].map(HostDecodeResult.ok)
  }

  func save(_ snapshot: HostSnapshot, hostIdentity: String) throws {
    lock.lock()
    values[hostIdentity] = snapshot
    saveCount += 1
    lock.unlock()
  }

  func remove(hostIdentity: String) {
    lock.lock()
    values.removeValue(forKey: hostIdentity)
    lock.unlock()
  }

  func seed(_ snapshot: HostSnapshot, hostIdentity: String) {
    lock.lock()
    values[hostIdentity] = snapshot
    lock.unlock()
  }

  func contains(_ hostIdentity: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return values[hostIdentity] != nil
  }
}

private actor FakePairedHostTransport: PairedHostRequestTransport {
  struct Recorded: Sendable {
    let method: String
    let params: Data
    let timeoutMs: Int
  }

  private var replies: [AckResult]
  private var recorded: [Recorded] = []

  init(replies: [AckResult] = []) {
    self.replies = replies
  }

  func append(_ reply: AckResult) {
    replies.append(reply)
  }

  func requestSerialized(
    _ method: String,
    paramsData: Data,
    timeoutMs: Int
  ) async throws -> AckResult {
    recorded.append(Recorded(method: method, params: paramsData, timeoutMs: timeoutMs))
    guard !replies.isEmpty else {
      return AckResult(ok: false, result: nil, error: "no fake reply")
    }
    return replies.removeFirst()
  }

  func requests() -> [Recorded] { recorded }
}

@Suite("PairedHostSessionController", .serialized)
@MainActor
struct PairedHostSessionControllerTests {
  @Test("publishes Host pushes, persists coherently, and marks disconnect stale")
  func pushLifecycle() throws {
    let store = MemoryHostSnapshotStore()
    let controller = PairedHostSessionController(snapshotStore: store)
    let identity = try #require(makeIdentity())
    let transport = FakePairedHostTransport()

    controller.activate(
      hostIdentity: "mac-a",
      phoneIdentity: identity,
      transport: transport)
    #expect(controller.phase == .connecting)
    #expect(
      controller.receive(
        method: PairedHostProjectionMethods.welcome,
        params: try JSONEncoder().encode(welcome(identity: identity))) == .updated)
    #expect(
      controller.receive(
        method: PairedHostProjectionMethods.snapshot,
        params: try JSONEncoder().encode(snapshotFrame())) == .updated)
    #expect(
      controller.receive(
        method: PairedHostProjectionMethods.state,
        params: try JSONEncoder().encode(
          PairedHostProjectionStateMessage(
            phase: .live, generation: 7, cursor: 0))) == .updated)

    #expect(controller.phase == .live)
    #expect(controller.snapshot?.generation == 7)
    #expect(controller.snapshot?.cursor == 0)
    #expect(store.saveCount == 1)
    #expect(store.contains("mac-a"))

    controller.markTransportClosed()
    #expect(controller.phase == .reconnecting)
    #expect(controller.snapshot?.freshness == .stale)
    #expect(controller.snapshot?.health.connectionPhase == .staleCache)
  }

  @Test("loads only this Host's offline snapshot and forget removes it")
  func offlineCacheAndForget() throws {
    let store = MemoryHostSnapshotStore()
    store.seed(snapshotFrame(cursor: 4).snapshot, hostIdentity: "mac-a")
    store.seed(snapshotFrame(cursor: 5).snapshot, hostIdentity: "mac-b")
    let controller = PairedHostSessionController(snapshotStore: store)
    let identity = try #require(makeIdentity())

    controller.prepareOffline(
      hostIdentity: "mac-a",
      phoneIdentity: identity)
    #expect(controller.snapshot?.cursor == 4)
    #expect(controller.snapshot?.freshness == .stale)
    #expect(controller.phase == .reconnecting)

    controller.clear(removePersistedSnapshot: true)
    #expect(controller.snapshot == nil)
    #expect(controller.phase == .unavailable)
    #expect(!store.contains("mac-a"))
    #expect(store.contains("mac-b"))

    controller.removePersistedSnapshots(hostIdentities: ["mac-b", "mac-b", ""])
    #expect(!store.contains("mac-b"))
  }

  @Test("a cursor gap pulls one full snapshot and converges atomically")
  func gapTriggersResnapshot() async throws {
    let full = SnapshotResponseFixture(kind: .snapshotGet, frame: snapshotFrame(cursor: 3))
    let transport = FakePairedHostTransport(
      replies: [
        AckResult(
          ok: true,
          result: try JSONEncoder().encode(full),
          error: nil)
      ])
    let controller = PairedHostSessionController(snapshotStore: MemoryHostSnapshotStore())
    let identity = try #require(makeIdentity())
    try seedLive(controller, identity: identity, transport: transport)

    let gap = HostDeltasFrame(
      result: .deltas(
        .init(
          generation: 7,
          fromCursor: 2,
          toCursor: 3,
          deltas: [warningDelta(cursor: 3, previousCursor: 2)])))
    guard
      case .requireSnapshot = controller.receive(
        method: PairedHostProjectionMethods.deltas,
        params: try JSONEncoder().encode(gap))
    else {
      Issue.record("expected gap to request a snapshot")
      return
    }

    await waitUntil {
      controller.snapshot?.cursor == 3 && controller.phase == .live && !controller.resyncInFlight
    }
    #expect(controller.snapshot?.cursor == 3)
    #expect(controller.snapshot?.freshness == .live)
    #expect(controller.health?.freshness == .live)
    #expect(controller.phase == .live)
    let requests = await transport.requests()
    #expect(requests.count == 1)
    #expect(requests[0].method == PairedHostProjectionMethods.request)
    let request = try #require(
      JSONSerialization.jsonObject(with: requests[0].params) as? [String: Any])
    #expect(request["kind"] as? String == "snapshot.get")
  }

  @Test("matching live state cannot certify a missed fresh snapshot")
  func missedFreshSnapshotRequiresResyncBeforeLive() async throws {
    let store = MemoryHostSnapshotStore()
    store.seed(snapshotFrame().snapshot, hostIdentity: "mac-a")
    let fresh = SnapshotResponseFixture(kind: .snapshotGet, frame: snapshotFrame())
    let transport = FakePairedHostTransport(
      replies: [
        AckResult(
          ok: true,
          result: try JSONEncoder().encode(fresh),
          error: nil)
      ])
    let controller = PairedHostSessionController(snapshotStore: store)
    let identity = try #require(makeIdentity())

    controller.activate(
      hostIdentity: "mac-a",
      phoneIdentity: identity,
      transport: transport)
    #expect(controller.phase == .connecting)
    #expect(controller.snapshot?.freshness == .stale)
    #expect(controller.health?.freshness == .stale)
    #expect(controller.health?.connectionPhase == .staleCache)

    #expect(
      controller.receive(
        method: PairedHostProjectionMethods.welcome,
        params: try JSONEncoder().encode(welcome(identity: identity))) == .updated)

    // Deliberately omit the fresh snapshot push. The cached snapshot has the
    // same generation/cursor, so cursor equality alone used to promote these
    // explicitly stale bytes to `.live` and suppress the recovery fallback.
    let liveState = controller.receive(
      method: PairedHostProjectionMethods.state,
      params: try JSONEncoder().encode(
        PairedHostProjectionStateMessage(
          phase: .live,
          generation: 7,
          cursor: 0)))
    #expect(liveState == .requireSnapshot(reason: "live_state_stale_snapshot"))
    #expect(controller.phase == .reconnecting)

    await waitUntil {
      controller.phase == .live && controller.snapshot?.freshness == .live
        && controller.health?.freshness == .live && !controller.resyncInFlight
    }

    #expect(controller.phase == .live)
    #expect(controller.snapshot?.freshness == .live)
    #expect(controller.health?.freshness == .live)
    let liveness = HostLiveness.derive(
      sessionPhase: .connected,
      projectionPhase: controller.phase,
      healthProjection: controller.health,
      probeLedger: HostLivenessProbeLedger())
    #expect(liveness == .live)
    #expect(liveness?.warrantsBanner == false)

    let requests = await transport.requests()
    #expect(requests.count == 1)
    let request = try #require(
      JSONSerialization.jsonObject(with: requests[0].params) as? [String: Any])
    #expect(request["kind"] as? String == "snapshot.get")
  }

  @Test("command timeout looks up the exact durable receipt instead of retrying")
  func commandTimeoutUsesReceiptLookup() async throws {
    let identity = try #require(makeIdentity())
    let receipt = HostCommandReceipt(
      commandId: "command-1",
      idempotencyKey: "idem-1",
      name: .questionAnswer,
      actor: HostActorIdentity(
        actorId: identity.clientId,
        clientId: identity.clientId,
        clientClass: .ios),
      authority: HostAuthorityDecision(decision: .allow),
      status: .succeeded,
      commandFingerprint: String(repeating: "a", count: 64),
      generation: 7,
      cursor: 0,
      createdAt: "2026-08-09T20:00:00Z",
      updatedAt: "2026-08-09T20:00:01Z")
    let lookup = ReceiptResponseFixture(kind: .receiptLookup, receipt: receipt)
    let transport = FakePairedHostTransport(
      replies: [
        AckResult(ok: false, result: nil, error: "timeout"),
        AckResult(ok: true, result: try JSONEncoder().encode(lookup), error: nil),
      ])
    let controller = PairedHostSessionController(snapshotStore: MemoryHostSnapshotStore())
    try seedLive(controller, identity: identity, transport: transport)

    let result = try await controller.submitCommand(
      name: .questionAnswer,
      target: ["questionId": "question-1"],
      arguments: ["answers": .array([.string("Yes")])],
      commandId: "command-1",
      idempotencyKey: "idem-1")
    #expect(result == receipt)
    #expect(controller.lastReceipt == receipt)

    let requests = await transport.requests()
    #expect(requests.count == 2)
    let commandRequest = try #require(
      JSONSerialization.jsonObject(with: requests[0].params) as? [String: Any])
    #expect(commandRequest["kind"] as? String == "command.submit")
    let command = try #require(commandRequest["params"] as? [String: Any])
    let actor = try #require(command["actor"] as? [String: Any])
    #expect(actor["clientId"] as? String == identity.clientId)
    #expect(actor["actorId"] as? String == identity.clientId)
    #expect(actor["clientClass"] as? String == "ios")

    let lookupRequest = try #require(
      JSONSerialization.jsonObject(with: requests[1].params) as? [String: Any])
    #expect(lookupRequest["kind"] as? String == "receipt.lookup")
    let lookupParams = try #require(lookupRequest["params"] as? [String: Any])
    #expect(lookupParams["commandId"] as? String == "command-1")
    #expect(lookupParams["idempotencyKey"] as? String == "idem-1")
  }

  @Test("missing command capability fails before transport mutation")
  func capabilityGate() async throws {
    let identity = try #require(makeIdentity())
    let transport = FakePairedHostTransport()
    let controller = PairedHostSessionController(snapshotStore: MemoryHostSnapshotStore())
    controller.activate(
      hostIdentity: "mac-a", phoneIdentity: identity, transport: transport)
    var limited = welcome(identity: identity)
    limited.capabilities = [.bootstrap, .snapshot, .deltas, .health]
    _ = controller.receive(
      method: PairedHostProjectionMethods.welcome,
      params: try JSONEncoder().encode(limited))
    _ = controller.receive(
      method: PairedHostProjectionMethods.snapshot,
      params: try JSONEncoder().encode(snapshotFrame()))
    _ = controller.receive(
      method: PairedHostProjectionMethods.state,
      params: try JSONEncoder().encode(
        PairedHostProjectionStateMessage(phase: .live, generation: 7, cursor: 0)))

    do {
      _ = try await controller.submitCommand(
        name: .ping, target: ["kind": "host"], arguments: [:])
      Issue.record("expected commands capability failure")
    } catch {
      #expect(error as? PairedHostSessionError == .capabilityUnavailable(.commands))
    }
    #expect(await transport.requests().isEmpty)
  }

  @Test("a receipt for a different command is rejected before publication")
  func mismatchedReceiptFailsClosed() async throws {
    let identity = try #require(makeIdentity())
    let receipt = HostCommandReceipt(
      commandId: "different-command",
      idempotencyKey: "idem-1",
      name: .questionAnswer,
      actor: HostActorIdentity(
        actorId: identity.clientId,
        clientId: identity.clientId,
        clientClass: .ios),
      authority: HostAuthorityDecision(decision: .allow),
      status: .succeeded,
      commandFingerprint: String(repeating: "a", count: 64),
      generation: 7,
      cursor: 0,
      createdAt: "2026-08-09T20:00:00Z",
      updatedAt: "2026-08-09T20:00:01Z")
    let response = CommandResponseFixture(kind: .commandSubmit, receipt: receipt)
    let transport = FakePairedHostTransport(
      replies: [
        AckResult(
          ok: true,
          result: try JSONEncoder().encode(response),
          error: nil)
      ])
    let controller = PairedHostSessionController(snapshotStore: MemoryHostSnapshotStore())
    try seedLive(controller, identity: identity, transport: transport)

    do {
      _ = try await controller.submitCommand(
        name: .questionAnswer,
        target: ["questionId": "question-1"],
        arguments: ["answer": .string("Yes")],
        commandId: "command-1",
        idempotencyKey: "idem-1")
      Issue.record("expected a mismatched receipt failure")
    } catch {
      #expect(
        error as? PairedHostSessionError
          == .invalidResponse("command receipt does not match the submitted Host command"))
    }
    #expect(controller.lastReceipt == nil)
  }

  private struct SnapshotResponseFixture: Codable {
    let kind: PairedHostRequestKind
    let frame: HostSnapshotFrame
  }

  private struct ReceiptResponseFixture: Codable {
    let kind: PairedHostRequestKind
    let receipt: HostCommandReceipt
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
        subjectId: identity.subjectId),
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
      warningId: "warning-\(cursor)",
      severity: .info,
      code: "test.warning",
      message: "Warning \(cursor)",
      at: cursor)
    let payload = try? JSONDecoder().decode(
      HostJSONAny.self,
      from: JSONEncoder().encode(warning))
    return HostDeltaEnvelope(
      generation: 7,
      cursor: cursor,
      previousCursor: previousCursor,
      kind: .upsert,
      family: .warning,
      entityId: warning.warningId,
      payload: payload,
      at: "2026-08-09T20:00:03Z")
  }

  private func seedLive(
    _ controller: PairedHostSessionController,
    identity: PairedHostProjectionIdentity,
    transport: FakePairedHostTransport
  ) throws {
    controller.activate(
      hostIdentity: "mac-a",
      phoneIdentity: identity,
      transport: transport)
    #expect(
      controller.receive(
        method: PairedHostProjectionMethods.welcome,
        params: try JSONEncoder().encode(welcome(identity: identity))) == .updated)
    #expect(
      controller.receive(
        method: PairedHostProjectionMethods.snapshot,
        params: try JSONEncoder().encode(snapshotFrame())) == .updated)
    #expect(
      controller.receive(
        method: PairedHostProjectionMethods.state,
        params: try JSONEncoder().encode(
          PairedHostProjectionStateMessage(
            phase: .live,
            generation: 7,
            cursor: 0))) == .updated)
  }

  private func waitUntil(
    timeoutNanoseconds: UInt64 = 2_000_000_000,
    _ predicate: @MainActor () -> Bool
  ) async {
    let started = DispatchTime.now().uptimeNanoseconds
    while !predicate() {
      if DispatchTime.now().uptimeNanoseconds - started > timeoutNanoseconds {
        Issue.record("condition timed out")
        return
      }
      try? await Task.sleep(nanoseconds: 10_000_000)
    }
  }
}
