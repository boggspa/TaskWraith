// Observable Host v2 session for the paired iOS companion.
//
// RelayTransportClient remains the authenticated E2EE carrier. The controller
// owns only a validated projection replica, bounded offline cache, resnapshot
// recovery, and governed command/receipt composition.

import Combine
import Foundation
import TaskWraithKit

public protocol PairedHostRequestTransport: Sendable {
  func requestSerialized(
    _ method: String,
    paramsData: Data,
    timeoutMs: Int
  ) async throws -> AckResult
}

extension RelayTransportClient: PairedHostRequestTransport {}

public enum PairedHostSessionError: LocalizedError, Sendable, Equatable {
  case unavailable
  case capabilityUnavailable(HostCapability)
  case requestRejected(String)
  case invalidResponse(String)

  public var errorDescription: String? {
    switch self {
    case .unavailable:
      return "The authoritative Host projection is unavailable."
    case .capabilityUnavailable(let capability):
      return "The Host did not advertise the \(capability.rawValue) capability."
    case .requestRejected(let reason):
      return "The Host rejected the request: \(reason)"
    case .invalidResponse(let reason):
      return "The Host returned an invalid response: \(reason)"
    }
  }
}

private struct PairedHostReceiptLookupResponse: Codable {
  let kind: PairedHostRequestKind
  let receipt: HostCommandReceipt
}

@MainActor
public final class PairedHostSessionController: ObservableObject {
  @Published public private(set) var phase: PairedHostProjectionPhase = .unavailable
  @Published public private(set) var snapshot: HostSnapshot?
  @Published public private(set) var health: HostHealthProjection?
  @Published public private(set) var welcome: HostBootstrapWelcome?
  @Published public private(set) var lastReceipt: HostCommandReceipt?
  @Published public private(set) var lastError: String?
  @Published public private(set) var resyncInFlight = false

  public var generation: HostGeneration? { snapshot?.generation }
  public var cursor: HostCursor? { snapshot?.cursor }
  public var isLive: Bool { phase == .live }
  public var canSubmitCommands: Bool {
    PairedHostActionRouting.commandsAvailable(
      phase: phase,
      capabilities: welcome?.capabilities)
  }

  private let snapshotStore: any PairedHostSnapshotStore
  private var replica: PairedHostProjectionReplica?
  private var hostIdentity: String?
  private var transport: (any PairedHostRequestTransport)?
  private var activationId = UUID()
  private var fallbackTask: Task<Void, Never>?
  private var resyncTask: Task<Void, Never>?
  private var resyncToken: UUID?

  public init(
    snapshotStore: any PairedHostSnapshotStore = UserDefaultsPairedHostSnapshotStore()
  ) {
    self.snapshotStore = snapshotStore
  }

  /// Publish this paired Mac's last coherent replica before the relay finishes
  /// connecting. Cached bytes are always demoted to stale and no command
  /// transport is installed until the authenticated session establishes.
  public func prepareOffline(
    hostIdentity: String,
    phoneIdentity: PairedHostProjectionIdentity
  ) {
    activationId = UUID()
    fallbackTask?.cancel()
    fallbackTask = nil
    resyncTask?.cancel()
    resyncTask = nil
    resyncToken = nil
    resyncInFlight = false

    let hostChanged = self.hostIdentity != hostIdentity
    self.hostIdentity = hostIdentity
    transport = nil
    lastReceipt = nil
    var cacheError: String?
    if hostChanged || replica?.identity != phoneIdentity {
      var cached: HostSnapshot?
      if let loaded = snapshotStore.load(hostIdentity: hostIdentity) {
        switch loaded {
        case .ok(let value): cached = value
        case .error(let reason): cacheError = reason
        }
      }
      replica = PairedHostProjectionReplica(
        identity: phoneIdentity,
        cachedSnapshot: cached)
    }
    replica?.markTransportClosed()
    publishReplica()
    if let cacheError { lastError = cacheError }
  }

  /// Bind a newly-established E2EE session. The Mac-side gateway will push a
  /// welcome + snapshot immediately; a delayed pull is only a loss-recovery
  /// fallback, not a competing source of state.
  public func activate(
    hostIdentity: String,
    phoneIdentity: PairedHostProjectionIdentity,
    transport: any PairedHostRequestTransport
  ) {
    activationId = UUID()
    fallbackTask?.cancel()
    resyncTask?.cancel()
    resyncTask = nil
    resyncToken = nil
    resyncInFlight = false

    let hostChanged = self.hostIdentity != hostIdentity
    self.hostIdentity = hostIdentity
    self.transport = transport
    lastReceipt = nil

    if hostChanged || replica?.identity != phoneIdentity {
      var cached: HostSnapshot?
      var cacheError: String?
      if let loaded = snapshotStore.load(hostIdentity: hostIdentity) {
        switch loaded {
        case .ok(let value): cached = value
        case .error(let reason): cacheError = reason
        }
      }
      replica = PairedHostProjectionReplica(
        identity: phoneIdentity,
        cachedSnapshot: cached)
      publishReplica()
      if let cacheError { lastError = cacheError }
    }

    markReplicaConnecting()
    let expectedActivation = activationId
    fallbackTask = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: 750_000_000)
      guard !Task.isCancelled, let self, self.activationId == expectedActivation else { return }
      guard self.phase != .live else { return }
      self.requestFullSnapshot()
    }
  }

  @discardableResult
  public func receive(method: String, params: Data?) -> PairedHostProjectionApplyResult {
    apply(method: method, params: params, triggerResync: true)
  }

  /// Keep the coherent cache visible when the relay drops, but make its stale
  /// nature explicit. A later activate replaces the transport and rehydrates.
  public func markTransportClosed() {
    activationId = UUID()
    fallbackTask?.cancel()
    fallbackTask = nil
    resyncTask?.cancel()
    resyncTask = nil
    resyncToken = nil
    resyncInFlight = false
    transport = nil
    replica?.markTransportClosed()
    publishReplica()
  }

  /// Remove the current Host from the visible model. Persistence is retained
  /// for an ordinary disconnect/demo transition and removed only on an explicit
  /// forget/switch wipe.
  public func clear(removePersistedSnapshot: Bool) {
    activationId = UUID()
    fallbackTask?.cancel()
    fallbackTask = nil
    resyncTask?.cancel()
    resyncTask = nil
    resyncToken = nil
    resyncInFlight = false
    transport = nil
    if removePersistedSnapshot, let hostIdentity {
      snapshotStore.remove(hostIdentity: hostIdentity)
    }
    hostIdentity = nil
    replica = nil
    phase = .unavailable
    snapshot = nil
    health = nil
    welcome = nil
    lastReceipt = nil
    lastError = nil
  }

  /// Remove offline replicas for hosts that are no longer paired. The session
  /// model uses this for "Forget all" because only the active Host is bound to
  /// `hostIdentity`; inactive hosts can still have a legitimate per-host cache.
  public func removePersistedSnapshots(hostIdentities: [String]) {
    for hostIdentity in Set(hostIdentities) where !hostIdentity.isEmpty {
      snapshotStore.remove(hostIdentity: hostIdentity)
    }
  }

  public func requestFullSnapshot() {
    guard resyncTask == nil, !resyncInFlight else { return }
    let expectedActivation = activationId
    resyncTask = Task { @MainActor [weak self] in
      guard let self else { return }
      await self.performFullSnapshot(expectedActivation: expectedActivation)
    }
  }

  /// Awaitable form used by explicit retry UI and tests. It shares the same
  /// single-flight latch as the fire-and-forget recovery path.
  public func refreshNow() async {
    if let resyncTask {
      await resyncTask.value
      return
    }
    let expectedActivation = activationId
    await performFullSnapshot(expectedActivation: expectedActivation)
  }

  /// Submit once with a stable command/idempotency pair. An ack timeout never
  /// causes blind re-execution: the durable receipt is looked up instead.
  public func submitCommand(
    name: HostCommandName,
    target: [String: String],
    arguments: [String: HostJSONAny],
    commandId: String = UUID().uuidString.lowercased(),
    idempotencyKey: String = UUID().uuidString.lowercased()
  ) async throws -> HostCommandReceipt {
    guard let replica, let transport else { throw PairedHostSessionError.unavailable }
    guard replica.phase == .live else { throw PairedHostSessionError.unavailable }
    guard replica.welcome?.capabilities.contains(.commands) == true else {
      throw PairedHostSessionError.capabilityUnavailable(.commands)
    }
    guard replica.welcome?.capabilities.contains(.receipts) == true else {
      throw PairedHostSessionError.capabilityUnavailable(.receipts)
    }

    let command = makePairedHostCommand(
      identity: replica.identity,
      name: name,
      target: target,
      arguments: arguments,
      commandId: commandId,
      idempotencyKey: idempotencyKey)
    let params = try encodePairedHostRequest(kind: .commandSubmit, params: command)
    let ack = try await transport.requestSerialized(
      PairedHostProjectionMethods.request,
      paramsData: params,
      timeoutMs: 12_000)

    let receipt: HostCommandReceipt
    if ack.ok {
      guard let result = ack.result else {
        throw PairedHostSessionError.invalidResponse("command result is missing")
      }
      receipt = try decodeCommandReceipt(result)
    } else if ack.error == "timeout" {
      receipt = try await lookupReceipt(
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        transport: transport)
    } else {
      throw PairedHostSessionError.requestRejected(ack.error ?? "unknown error")
    }

    try validate(receipt: receipt, for: command)
    lastReceipt = receipt
    convergeAfterReceipt(receipt)
    return receipt
  }

  private func apply(
    method: String,
    params: Data?,
    triggerResync: Bool
  ) -> PairedHostProjectionApplyResult {
    guard var current = replica else {
      lastError = "Host projection arrived before session activation."
      return .rejected(reason: "session_not_activated")
    }
    let previousSnapshot = current.snapshot
    let result = current.receive(method: method, params: params)
    replica = current
    publishReplica()
    if current.snapshot != previousSnapshot, let snapshot = current.snapshot {
      persist(snapshot)
    }
    if triggerResync, case .requireSnapshot = result {
      requestFullSnapshot()
    }
    return result
  }

  private func markReplicaConnecting() {
    guard
      let data = try? JSONEncoder().encode(
        PairedHostProjectionStateMessage(phase: .connecting))
    else { return }
    _ = apply(
      method: PairedHostProjectionMethods.state,
      params: data,
      triggerResync: false)
  }

  private func performFullSnapshot(expectedActivation: UUID) async {
    guard expectedActivation == activationId, let transport else { return }
    if resyncInFlight { return }
    let token = UUID()
    resyncToken = token
    resyncInFlight = true
    defer {
      if resyncToken == token {
        resyncToken = nil
        resyncInFlight = false
        resyncTask = nil
      }
    }
    do {
      let params = try encodePairedHostRequest(
        kind: .snapshotGet,
        params: PairedHostEmptyParameters())
      let ack = try await transport.requestSerialized(
        PairedHostProjectionMethods.request,
        paramsData: params,
        timeoutMs: 12_000)
      guard expectedActivation == activationId else { return }
      guard ack.ok else {
        throw PairedHostSessionError.requestRejected(ack.error ?? "snapshot request failed")
      }
      guard let result = ack.result else {
        throw PairedHostSessionError.invalidResponse("snapshot result is missing")
      }
      let decoded = decodePairedHostSnapshotResponse(result)
      guard case .ok(let frame) = decoded else {
        if case .error(let reason) = decoded {
          throw PairedHostSessionError.invalidResponse(reason)
        }
        throw PairedHostSessionError.invalidResponse("snapshot decode failed")
      }
      let frameData = try JSONEncoder().encode(frame)
      let applied = apply(
        method: PairedHostProjectionMethods.snapshot,
        params: frameData,
        triggerResync: false)
      if case .rejected(let reason) = applied {
        throw PairedHostSessionError.invalidResponse(reason)
      }
      lastError = nil
    } catch {
      guard expectedActivation == activationId else { return }
      lastError = error.localizedDescription
    }
  }

  private func performDeltas(
    from position: HostCursorPosition,
    expectedActivation: UUID
  ) async {
    guard expectedActivation == activationId, let transport else { return }
    do {
      let params = try encodePairedHostRequest(kind: .deltasSince, params: position)
      let ack = try await transport.requestSerialized(
        PairedHostProjectionMethods.request,
        paramsData: params,
        timeoutMs: 12_000)
      guard expectedActivation == activationId else { return }
      guard ack.ok else {
        throw PairedHostSessionError.requestRejected(ack.error ?? "delta request failed")
      }
      guard let result = ack.result else {
        throw PairedHostSessionError.invalidResponse("delta result is missing")
      }
      let decoded = decodePairedHostDeltasResponse(result)
      guard case .ok(let frame) = decoded else {
        if case .error(let reason) = decoded {
          throw PairedHostSessionError.invalidResponse(reason)
        }
        throw PairedHostSessionError.invalidResponse("delta decode failed")
      }
      let frameData = try JSONEncoder().encode(frame)
      _ = apply(
        method: PairedHostProjectionMethods.deltas,
        params: frameData,
        triggerResync: true)
    } catch {
      guard expectedActivation == activationId else { return }
      lastError = error.localizedDescription
    }
  }

  private func lookupReceipt(
    commandId: String,
    idempotencyKey: String,
    transport: any PairedHostRequestTransport
  ) async throws -> HostCommandReceipt {
    let params = try encodePairedHostRequest(
      kind: .receiptLookup,
      params: ["commandId": commandId, "idempotencyKey": idempotencyKey])
    let ack = try await transport.requestSerialized(
      PairedHostProjectionMethods.request,
      paramsData: params,
      timeoutMs: 12_000)
    guard ack.ok else {
      throw PairedHostSessionError.requestRejected(ack.error ?? "receipt lookup failed")
    }
    guard let result = ack.result else {
      throw PairedHostSessionError.invalidResponse("receipt result is missing")
    }
    do {
      let response = try JSONDecoder().decode(PairedHostReceiptLookupResponse.self, from: result)
      guard response.kind == .receiptLookup else {
        throw PairedHostSessionError.invalidResponse("unexpected receipt response kind")
      }
      let decoded = decodeHostCommandReceipt(from: try JSONEncoder().encode(response.receipt))
      guard case .ok(let receipt) = decoded else {
        if case .error(let reason) = decoded {
          throw PairedHostSessionError.invalidResponse(reason)
        }
        throw PairedHostSessionError.invalidResponse("receipt decode failed")
      }
      return receipt
    } catch let error as PairedHostSessionError {
      throw error
    } catch {
      throw PairedHostSessionError.invalidResponse(error.localizedDescription)
    }
  }

  private func decodeCommandReceipt(_ result: Data) throws -> HostCommandReceipt {
    let decoded = decodePairedHostCommandResponse(result)
    guard case .ok(let receipt) = decoded else {
      if case .error(let reason) = decoded {
        throw PairedHostSessionError.invalidResponse(reason)
      }
      throw PairedHostSessionError.invalidResponse("command receipt decode failed")
    }
    return receipt
  }

  private func validate(receipt: HostCommandReceipt, for command: HostCommand) throws {
    guard receipt.commandId == command.commandId,
      receipt.idempotencyKey == command.idempotencyKey,
      receipt.name == command.name,
      receipt.actor == command.actor
    else {
      throw PairedHostSessionError.invalidResponse(
        "command receipt does not match the submitted Host command")
    }
  }

  private func convergeAfterReceipt(_ receipt: HostCommandReceipt) {
    guard let snapshot else { return }
    let expectedActivation = activationId
    if receipt.generation != snapshot.generation {
      requestFullSnapshot()
      return
    }
    guard receipt.cursor > snapshot.cursor else { return }
    let position = HostCursorPosition(
      generation: snapshot.generation,
      cursor: snapshot.cursor)
    Task { @MainActor [weak self] in
      await self?.performDeltas(
        from: position,
        expectedActivation: expectedActivation)
    }
  }

  private func persist(_ snapshot: HostSnapshot) {
    guard let hostIdentity else { return }
    do {
      try snapshotStore.save(snapshot, hostIdentity: hostIdentity)
    } catch {
      lastError = error.localizedDescription
    }
  }

  private func publishReplica() {
    phase = replica?.phase ?? .unavailable
    snapshot = replica?.snapshot
    health = replica?.health
    welcome = replica?.welcome
    lastError = replica?.lastError
  }
}
