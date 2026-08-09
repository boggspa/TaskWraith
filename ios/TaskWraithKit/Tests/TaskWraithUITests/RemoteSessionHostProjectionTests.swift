import Foundation
import Testing

@testable import TaskWraithKit
@testable import TaskWraithUI

private struct HostProjectionStaticSeed: IdentitySeedStore {
  func loadOrCreateSeed() throws -> Data { Data(repeating: 7, count: 32) }
}

private actor HostProjectionTestTransport: PairedHostRequestTransport {
  private var replies: [AckResult]
  private var recorded: [Data] = []

  init(replies: [AckResult] = []) {
    self.replies = replies
  }

  func requestSerialized(
    _ method: String,
    paramsData: Data,
    timeoutMs: Int
  ) async throws -> AckResult {
    recorded.append(paramsData)
    guard !replies.isEmpty else {
      return AckResult(ok: false, result: nil, error: "not requested")
    }
    return replies.removeFirst()
  }

  func requests() -> [Data] { recorded }
}

private final class HostProjectionMemoryStore: PairedHostSnapshotStore, @unchecked Sendable {
  private let lock = NSLock()
  private var snapshots: [String: HostSnapshot] = [:]

  func load(hostIdentity: String) -> HostDecodeResult<HostSnapshot>? {
    lock.lock()
    defer { lock.unlock() }
    return snapshots[hostIdentity].map(HostDecodeResult.ok)
  }

  func save(_ snapshot: HostSnapshot, hostIdentity: String) throws {
    lock.lock()
    snapshots[hostIdentity] = snapshot
    lock.unlock()
  }

  func remove(hostIdentity: String) {
    lock.lock()
    snapshots.removeValue(forKey: hostIdentity)
    lock.unlock()
  }

  func contains(_ hostIdentity: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return snapshots[hostIdentity] != nil
  }
}

@Suite("Remote session Host projection lifecycle", .serialized)
@MainActor
struct RemoteSessionHostProjectionTests {
  @Test("disconnect preserves a stale coherent Host replica")
  func disconnectPreservesOfflineReplica() throws {
    let store = HostProjectionMemoryStore()
    let model = makeModel(snapshotStore: store)
    try seedLiveHost(on: model, hostIdentity: "mac-a")

    model.disconnect()

    #expect(model.hostProjection.phase == .reconnecting)
    #expect(model.hostProjection.snapshot?.freshness == .stale)
    #expect(model.hostProjection.snapshot?.health.connectionPhase == .staleCache)
    #expect(store.contains("mac-a"))
  }

  @Test("demo isolation clears the visible Host but retains its offline replica")
  func demoIsolationRetainsOfflineReplica() throws {
    let store = HostProjectionMemoryStore()
    let model = makeModel(snapshotStore: store)
    try seedLiveHost(on: model, hostIdentity: "mac-a")

    model.enterDemoMode()

    #expect(model.hostProjection.phase == .unavailable)
    #expect(model.hostProjection.snapshot == nil)
    #expect(store.contains("mac-a"))
  }

  @Test("a matching iOS question submits exactly once through Host v2")
  func questionAnswerUsesHost() async throws {
    let store = HostProjectionMemoryStore()
    let model = makeModel(snapshotStore: store)
    let identity = try #require(
      pairedHostProjectionIdentity(
        identityPublicKeyBase64: model.identityPublicKeyBase64))
    let receipt = HostCommandReceipt(
      commandId: "11111111-1111-4111-8111-111111111111",
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
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
    let response = HostProjectionCommandResponse(kind: .commandSubmit, receipt: receipt)
    let transport = HostProjectionTestTransport(
      replies: [
        AckResult(
          ok: true,
          result: try JSONEncoder().encode(response),
          error: nil)
      ])
    var snapshot = createEmptyHostSnapshot(
      generation: 7,
      cursor: 0,
      freshness: .live,
      generatedAt: "2026-08-09T20:00:00Z")
    snapshot.questions = [
      HostQuestionProjection(
        questionId: "question-1",
        threadId: "thread-1",
        status: .open,
        promptPreview: "Proceed?",
        askedAt: 1)
    ]
    try seedLiveHost(
      on: model,
      hostIdentity: "mac-a",
      transport: transport,
      snapshot: snapshot)

    model.answer(
      MobileQuestionCard(
        promptId: "question-1",
        questionId: nil,
        question: "Proceed?",
        prompt: nil,
        options: ["Yes", "No"],
        context: nil,
        createdAt: "2026-08-09T20:00:00Z",
        expiresAt: nil,
        provider: "codex",
        workspaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
        status: "pending"),
      "Yes",
      isCustom: false)

    await waitUntil { await transport.requests().count == 1 }
    let requests = await transport.requests()
    let envelope = try #require(
      JSONSerialization.jsonObject(with: requests[0]) as? [String: Any])
    #expect(envelope["kind"] as? String == "command.submit")
    let command = try #require(envelope["params"] as? [String: Any])
    #expect(command["name"] as? String == "question.answer")
    #expect(command["target"] as? [String: String] == ["questionId": "question-1"])
    let arguments = try #require(command["arguments"] as? [String: Any])
    #expect(arguments["decision"] as? String == "answer")
    #expect(arguments["answer"] as? String == "Yes")
    #expect(arguments["isCustom"] as? Bool == false)
    #expect(model.hostProjection.lastReceipt == receipt)
    #expect(model.lastActionMessage == "Answer sent.")

    let resolvedQuestion = HostQuestionProjection(
      questionId: "question-1",
      threadId: "thread-1",
      status: .answered,
      promptPreview: "Proceed?",
      askedAt: 1,
      answeredAt: 2,
      receiptId: receipt.commandId)
    let resolvedPayload = try JSONDecoder().decode(
      HostJSONAny.self,
      from: JSONEncoder().encode(resolvedQuestion))
    let delta = HostDeltaEnvelope(
      generation: 7,
      cursor: 1,
      previousCursor: 0,
      kind: .upsert,
      family: .question,
      entityId: "question-1",
      payload: resolvedPayload,
      at: "2026-08-09T20:00:02Z")
    let update = model.hostProjection.receive(
      method: PairedHostProjectionMethods.deltas,
      params: try JSONEncoder().encode(
        HostDeltasFrame(
          result: .deltas(
            .init(generation: 7, fromCursor: 0, toCursor: 1, deltas: [delta])))))
    #expect(update == .updated)
    let projectedQuestion = try #require(model.hostProjection.snapshot?.questions.first)
    #expect(projectedQuestion.status == .answered)
    #expect(projectedQuestion.receiptId == receipt.commandId)
    #expect(model.hostProjection.snapshot?.generation == 7)
    #expect(model.hostProjection.snapshot?.cursor == 1)
  }

  private func makeModel(snapshotStore: HostProjectionMemoryStore) -> RemoteSessionModel {
    let defaults = UserDefaults(
      suiteName: "RemoteSessionHostProjectionTests.\(UUID().uuidString)")!
    return RemoteSessionModel(
      identityStore: HostProjectionStaticSeed(),
      pairingStore: UserDefaultsPairedHostStore(defaults: defaults),
      hostSnapshotStore: snapshotStore)
  }

  private func seedLiveHost(
    on model: RemoteSessionModel,
    hostIdentity: String,
    transport: HostProjectionTestTransport = HostProjectionTestTransport(),
    snapshot: HostSnapshot? = nil
  ) throws {
    let identity = try #require(
      pairedHostProjectionIdentity(
        identityPublicKeyBase64: model.identityPublicKeyBase64))
    model.hostProjection.activate(
      hostIdentity: hostIdentity,
      phoneIdentity: identity,
      transport: transport)
    _ = model.hostProjection.receive(
      method: PairedHostProjectionMethods.welcome,
      params: try JSONEncoder().encode(
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
          freshness: .live)))
    _ = model.hostProjection.receive(
      method: PairedHostProjectionMethods.snapshot,
      params: try JSONEncoder().encode(
        HostSnapshotFrame(
          snapshot: snapshot
            ?? createEmptyHostSnapshot(
              generation: 7,
              cursor: 0,
              freshness: .live,
              generatedAt: "2026-08-09T20:00:00Z"))))
    _ = model.hostProjection.receive(
      method: PairedHostProjectionMethods.state,
      params: try JSONEncoder().encode(
        PairedHostProjectionStateMessage(
          phase: .live,
          generation: 7,
          cursor: 0)))
    #expect(model.hostProjection.phase == .live)
  }

  private func waitUntil(
    timeoutNanoseconds: UInt64 = 2_000_000_000,
    _ predicate: @escaping @Sendable () async -> Bool
  ) async {
    let started = DispatchTime.now().uptimeNanoseconds
    while !(await predicate()) {
      if DispatchTime.now().uptimeNanoseconds - started > timeoutNanoseconds {
        Issue.record("condition timed out")
        return
      }
      try? await Task.sleep(nanoseconds: 10_000_000)
    }
  }

  private struct HostProjectionCommandResponse: Codable {
    let kind: PairedHostRequestKind
    let receipt: HostCommandReceipt
  }
}
