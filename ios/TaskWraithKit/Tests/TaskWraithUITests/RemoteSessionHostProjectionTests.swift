import Foundation
import Testing

@testable import TaskWraithKit
@testable import TaskWraithUI

private struct HostProjectionStaticSeed: IdentitySeedStore {
  func loadOrCreateSeed() throws -> Data { Data(repeating: 7, count: 32) }
}

private actor HostProjectionNoopTransport: PairedHostRequestTransport {
  func requestSerialized(
    _ method: String,
    paramsData: Data,
    timeoutMs: Int
  ) async throws -> AckResult {
    AckResult(ok: false, result: nil, error: "not requested")
  }
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
    hostIdentity: String
  ) throws {
    let identity = try #require(
      pairedHostProjectionIdentity(
        identityPublicKeyBase64: model.identityPublicKeyBase64))
    model.hostProjection.activate(
      hostIdentity: hostIdentity,
      phoneIdentity: identity,
      transport: HostProjectionNoopTransport())
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
          snapshot: createEmptyHostSnapshot(
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
}
