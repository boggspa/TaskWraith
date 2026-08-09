// PairedHostProjection — fail-closed Host v2 replica state for the existing
// taskwraith-e2ee-v1 phone boundary.
//
// The Mac remains authoritative. This module only validates versioned Host
// frames, applies coherent snapshots/deltas, composes governed requests, and
// persists a bounded offline snapshot. It never infers lifecycle from legacy
// bridge events and never promotes cached state to live state on its own.

import CryptoKit
import Foundation

public enum PairedHostProjectionMethods {
  public static let request = "bridge.requestHost"
  public static let welcome = "bridge.hostWelcome"
  public static let snapshot = "bridge.hostSnapshot"
  public static let deltas = "bridge.hostDeltas"
  public static let health = "bridge.hostHealth"
  public static let state = "bridge.hostState"
}

public enum PairedHostProjectionPhase: String, Codable, Sendable, Equatable {
  case connecting
  case live
  case reconnecting
  case unavailable
}

public struct PairedHostProjectionStateMessage: Codable, Sendable, Equatable {
  public var phase: PairedHostProjectionPhase
  public var generation: HostGeneration?
  public var cursor: HostCursor?

  public init(
    phase: PairedHostProjectionPhase,
    generation: HostGeneration? = nil,
    cursor: HostCursor? = nil
  ) {
    self.phase = phase
    self.generation = generation
    self.cursor = cursor
  }
}

public struct PairedHostProjectionIdentity: Sendable, Equatable {
  public var clientId: String
  public var subjectId: String

  public init(clientId: String, subjectId: String) {
    self.clientId = clientId
    self.subjectId = subjectId
  }
}

/// Derive the same stable pair id as Mac `pairIdFromIdentityPubKey`.
public func pairedHostProjectionIdentity(
  identityPublicKeyBase64: String
) -> PairedHostProjectionIdentity? {
  guard let raw = Base64.decode(identityPublicKeyBase64), raw.count == 32 else { return nil }
  let digest = SHA256.hash(data: raw)
  let prefix = digest.prefix(8).map { String(format: "%02x", $0) }.joined()
  return PairedHostProjectionIdentity(
    clientId: "iphone-\(prefix)", subjectId: identityPublicKeyBase64)
}

public enum PairedHostProjectionApplyResult: Sendable, Equatable {
  case ignored
  case updated
  case requireSnapshot(reason: String)
  case rejected(reason: String)
}

public enum PairedHostRequestKind: String, Codable, Sendable, Equatable {
  case snapshotGet = "snapshot.get"
  case deltasSince = "deltas.since"
  case receiptLookup = "receipt.lookup"
  case healthGet = "health.get"
  case commandSubmit = "command.submit"
  case twmissionExport = "twmission.export"
}

public struct PairedHostEmptyParameters: Codable, Sendable, Equatable {
  public init() {}
}

private struct PairedHostRequestEnvelope<Parameters: Encodable>: Encodable {
  let kind: PairedHostRequestKind
  let params: Parameters
}

public func encodePairedHostRequest<Parameters: Encodable>(
  kind: PairedHostRequestKind,
  params: Parameters
) throws -> Data {
  try JSONEncoder().encode(PairedHostRequestEnvelope(kind: kind, params: params))
}

public func makePairedHostCommand(
  identity: PairedHostProjectionIdentity,
  name: HostCommandName,
  target: [String: String],
  arguments: [String: HostJSONAny],
  commandId: String = UUID().uuidString.lowercased(),
  idempotencyKey: String = UUID().uuidString.lowercased(),
  issuedAt: String = ISO8601DateFormatter().string(from: Date())
) -> HostCommand {
  HostCommand(
    commandId: commandId,
    idempotencyKey: idempotencyKey,
    actor: HostActorIdentity(
      actorId: identity.clientId,
      clientId: identity.clientId,
      clientClass: .ios),
    name: name,
    target: target,
    arguments: arguments,
    issuedAt: issuedAt)
}

private func normalizedSnapshot(_ snapshot: HostSnapshot) -> HostDecodeResult<HostSnapshot> {
  do {
    return decodeHostSnapshot(from: try JSONEncoder().encode(snapshot))
  } catch {
    return .error("snapshot encode failed: \(error.localizedDescription)")
  }
}

public func stalePairedHostSnapshot(_ snapshot: HostSnapshot) -> HostSnapshot? {
  var copy = snapshot
  copy.freshness = .stale
  copy.health.freshness = .stale
  copy.health.connectionPhase = .staleCache
  guard case .ok(let validated) = normalizedSnapshot(copy) else { return nil }
  return validated
}

private func decodeSnapshotFrame(_ data: Data) -> HostDecodeResult<HostSnapshotFrame> {
  do {
    let frame = try JSONDecoder().decode(HostSnapshotFrame.self, from: data)
    guard frame.type == "host.snapshot" else { return .error("type must be host.snapshot") }
    guard frame.protocolVersion == HostProtocolConstants.protocolVersion else {
      return .error("unsupported protocol version")
    }
    switch normalizedSnapshot(frame.snapshot) {
    case .ok(let snapshot):
      return .ok(HostSnapshotFrame(snapshot: snapshot))
    case .error(let reason):
      return .error(reason)
    }
  } catch {
    return .error("snapshot frame decode failed: \(error.localizedDescription)")
  }
}

private func validateDeltasPayload(
  _ payload: HostDeltasSinceResult.DeltasPayload
) -> String? {
  guard payload.generation >= 0, payload.fromCursor >= 0, payload.toCursor >= 0 else {
    return "delta frame cursors must be non-negative"
  }
  guard payload.toCursor >= payload.fromCursor else {
    return "delta frame cursor range is inverted"
  }
  guard payload.deltas.count <= HostProtocolConstants.maxDeltas else {
    return "deltas exceeds max collection"
  }
  guard let first = payload.deltas.first, let last = payload.deltas.last else {
    return payload.fromCursor == payload.toCursor ? nil : "empty delta frame advances cursor"
  }
  guard first.previousCursor == payload.fromCursor else {
    return "delta frame fromCursor does not match first delta"
  }
  guard last.cursor == payload.toCursor else {
    return "delta frame toCursor does not match last delta"
  }
  guard payload.deltas.allSatisfy({ $0.generation == payload.generation }) else {
    return "delta frame mixes generations"
  }
  return nil
}

private func decodeDeltasFrame(_ data: Data) -> HostDecodeResult<HostDeltasFrame> {
  do {
    let frame = try JSONDecoder().decode(HostDeltasFrame.self, from: data)
    guard frame.type == "host.deltas" else { return .error("type must be host.deltas") }
    guard frame.protocolVersion == HostProtocolConstants.protocolVersion else {
      return .error("unsupported protocol version")
    }
    switch frame.result {
    case .deltas(let payload):
      if let reason = validateDeltasPayload(payload) { return .error(reason) }
    case .fullResnapshotRequired(let payload):
      guard
        payload.generation >= 0, payload.cursor >= 0,
        payload.clientGeneration >= 0, payload.clientCursor >= 0,
        !payload.reason.isEmpty
      else {
        return .error("resnapshot payload is invalid")
      }
    }
    return .ok(frame)
  } catch {
    return .error("deltas frame decode failed: \(error.localizedDescription)")
  }
}

private func decodeHealthFrame(_ data: Data) -> HostDecodeResult<HostHealthFrame> {
  do {
    let frame = try JSONDecoder().decode(HostHealthFrame.self, from: data)
    guard frame.type == "host.health" else { return .error("type must be host.health") }
    guard frame.protocolVersion == HostProtocolConstants.protocolVersion else {
      return .error("unsupported protocol version")
    }
    return .ok(frame)
  } catch {
    return .error("health frame decode failed: \(error.localizedDescription)")
  }
}

public struct PairedHostProjectionReplica: Sendable, Equatable {
  public let identity: PairedHostProjectionIdentity
  public private(set) var phase: PairedHostProjectionPhase
  public private(set) var welcome: HostBootstrapWelcome?
  public private(set) var snapshot: HostSnapshot?
  public private(set) var health: HostHealthProjection?
  public private(set) var lastError: String?

  public init(
    identity: PairedHostProjectionIdentity,
    cachedSnapshot: HostSnapshot? = nil
  ) {
    self.identity = identity
    self.phase = .unavailable
    let stale = cachedSnapshot.flatMap(stalePairedHostSnapshot)
    self.snapshot = stale
    self.health = stale?.health
    self.welcome = nil
    self.lastError = cachedSnapshot != nil && stale == nil ? "cached snapshot is invalid" : nil
  }

  @discardableResult
  public mutating func receive(method: String, params: Data?) -> PairedHostProjectionApplyResult {
    guard let params else { return reject("Host projection params are required") }
    switch method {
    case PairedHostProjectionMethods.welcome:
      return receiveWelcome(params)
    case PairedHostProjectionMethods.snapshot:
      return receiveSnapshot(params)
    case PairedHostProjectionMethods.deltas:
      return receiveDeltas(params)
    case PairedHostProjectionMethods.health:
      return receiveHealth(params)
    case PairedHostProjectionMethods.state:
      return receiveState(params)
    default:
      return .ignored
    }
  }

  public mutating func markTransportClosed() {
    phase = .reconnecting
    welcome = nil
    if let current = snapshot {
      snapshot = stalePairedHostSnapshot(current)
      health = snapshot?.health ?? health
    }
  }

  public mutating func clear() {
    phase = .unavailable
    welcome = nil
    snapshot = nil
    health = nil
    lastError = nil
  }

  private mutating func receiveWelcome(_ data: Data) -> PairedHostProjectionApplyResult {
    let decoded = decodeHostBootstrapWelcome(from: data)
    guard case .ok(let value) = decoded else {
      if case .error(let reason) = decoded { return reject(reason) }
      return reject("welcome decode failed")
    }
    guard value.controlProtocolCompat == HostProtocolConstants.controlProtocolCompatVersion else {
      return reject("unsupported control protocol compatibility version")
    }
    guard value.generation >= 0, value.cursor >= 0 else {
      return reject("welcome cursor is invalid")
    }
    guard value.authenticatedClient.clientClass == .ios,
      value.authenticatedClient.clientId == identity.clientId,
      value.authenticatedClient.subjectId == identity.subjectId
    else {
      return reject("welcome authenticated client does not match this paired device")
    }
    let capabilities = Set(value.capabilities)
    let required: Set<HostCapability> = [.bootstrap, .snapshot, .deltas, .health]
    guard required.isSubset(of: capabilities) else {
      return reject("welcome is missing required projection capabilities")
    }
    if let snapshot, snapshot.generation > value.generation {
      return .ignored
    }
    welcome = value
    phase = .connecting
    lastError = nil
    return .updated
  }

  private mutating func receiveSnapshot(_ data: Data) -> PairedHostProjectionApplyResult {
    let decoded = decodeSnapshotFrame(data)
    guard case .ok(let frame) = decoded else {
      if case .error(let reason) = decoded { return reject(reason) }
      return reject("snapshot frame decode failed")
    }
    guard let welcome else { return requireSnapshot("snapshot_before_welcome") }
    guard frame.snapshot.generation == welcome.generation else {
      return requireSnapshot("snapshot_generation_mismatch")
    }
    if let current = snapshot {
      if frame.snapshot.generation < current.generation { return .ignored }
      if frame.snapshot.generation == current.generation,
        frame.snapshot.cursor < current.cursor
      {
        return .ignored
      }
    }
    snapshot = frame.snapshot
    health = frame.snapshot.health
    lastError = nil
    return .updated
  }

  private mutating func receiveDeltas(_ data: Data) -> PairedHostProjectionApplyResult {
    let decoded = decodeDeltasFrame(data)
    guard case .ok(let frame) = decoded else {
      if case .error(let reason) = decoded { return reject(reason) }
      return reject("deltas frame decode failed")
    }
    switch frame.result {
    case .fullResnapshotRequired(let payload):
      return requireSnapshot(payload.reason)
    case .deltas(let payload):
      guard let current = snapshot else { return requireSnapshot("missing_base_snapshot") }
      guard payload.generation == current.generation else {
        return requireSnapshot("delta_generation_mismatch")
      }
      if payload.deltas.isEmpty {
        if payload.toCursor <= current.cursor { return .ignored }
        return requireSnapshot("empty_delta_frame_advanced_cursor")
      }
      switch applyHostSnapshotDeltas(cache: current, deltas: payload.deltas) {
      case .applied(let next, _, _, _):
        guard next.cursor == payload.toCursor else {
          return requireSnapshot("delta_frame_cursor_mismatch")
        }
        snapshot = next
        health = next.health
        lastError = nil
        return .updated
      case .unchanged:
        return .ignored
      case .requireResnapshot(let reason, _, _):
        return requireSnapshot(reason)
      case .rejected(let reason):
        return reject(reason)
      }
    }
  }

  private mutating func receiveHealth(_ data: Data) -> PairedHostProjectionApplyResult {
    let decoded = decodeHealthFrame(data)
    guard case .ok(let frame) = decoded else {
      if case .error(let reason) = decoded { return reject(reason) }
      return reject("health frame decode failed")
    }
    health = frame.health
    lastError = nil
    return .updated
  }

  private mutating func receiveState(_ data: Data) -> PairedHostProjectionApplyResult {
    let state: PairedHostProjectionStateMessage
    do {
      state = try JSONDecoder().decode(PairedHostProjectionStateMessage.self, from: data)
    } catch {
      return reject("state decode failed: \(error.localizedDescription)")
    }
    if state.phase == .live {
      guard let generation = state.generation, let cursor = state.cursor else {
        return reject("live state requires generation and cursor")
      }
      guard let snapshot,
        snapshot.generation == generation,
        snapshot.cursor == cursor
      else {
        return requireSnapshot("live_state_cursor_mismatch")
      }
    }
    phase = state.phase
    if state.phase != .live, let current = snapshot {
      snapshot = stalePairedHostSnapshot(current)
      health = snapshot?.health ?? health
    }
    lastError = nil
    return .updated
  }

  private mutating func requireSnapshot(_ reason: String) -> PairedHostProjectionApplyResult {
    phase = .reconnecting
    if let current = snapshot {
      snapshot = stalePairedHostSnapshot(current)
      health = snapshot?.health ?? health
    }
    lastError = reason
    return .requireSnapshot(reason: reason)
  }

  private mutating func reject(_ reason: String) -> PairedHostProjectionApplyResult {
    lastError = reason
    return .rejected(reason: reason)
  }
}

private struct PairedHostSnapshotResponse: Codable {
  let kind: PairedHostRequestKind
  let frame: HostSnapshotFrame
}

private struct PairedHostDeltasResponse: Codable {
  let kind: PairedHostRequestKind
  let frame: HostDeltasFrame
}

private struct PairedHostHealthResponse: Codable {
  let kind: PairedHostRequestKind
  let frame: HostHealthFrame
}

private struct PairedHostCommandResponse: Codable {
  let kind: PairedHostRequestKind
  let receipt: HostCommandReceipt
}

public func decodePairedHostSnapshotResponse(
  _ data: Data
) -> HostDecodeResult<HostSnapshotFrame> {
  do {
    let response = try JSONDecoder().decode(PairedHostSnapshotResponse.self, from: data)
    guard response.kind == .snapshotGet else { return .error("unexpected response kind") }
    return decodeSnapshotFrame(try JSONEncoder().encode(response.frame))
  } catch {
    return .error("snapshot response decode failed: \(error.localizedDescription)")
  }
}

public func decodePairedHostDeltasResponse(
  _ data: Data
) -> HostDecodeResult<HostDeltasFrame> {
  do {
    let response = try JSONDecoder().decode(PairedHostDeltasResponse.self, from: data)
    guard response.kind == .deltasSince else { return .error("unexpected response kind") }
    return decodeDeltasFrame(try JSONEncoder().encode(response.frame))
  } catch {
    return .error("deltas response decode failed: \(error.localizedDescription)")
  }
}

public func decodePairedHostHealthResponse(
  _ data: Data
) -> HostDecodeResult<HostHealthFrame> {
  do {
    let response = try JSONDecoder().decode(PairedHostHealthResponse.self, from: data)
    guard response.kind == .healthGet else { return .error("unexpected response kind") }
    return decodeHealthFrame(try JSONEncoder().encode(response.frame))
  } catch {
    return .error("health response decode failed: \(error.localizedDescription)")
  }
}

public func decodePairedHostCommandResponse(
  _ data: Data
) -> HostDecodeResult<HostCommandReceipt> {
  do {
    let response = try JSONDecoder().decode(PairedHostCommandResponse.self, from: data)
    guard response.kind == .commandSubmit else { return .error("unexpected response kind") }
    return decodeHostCommandReceipt(from: try JSONEncoder().encode(response.receipt))
  } catch {
    return .error("command response decode failed: \(error.localizedDescription)")
  }
}

public protocol PairedHostSnapshotStore: Sendable {
  func load(hostIdentity: String) -> HostDecodeResult<HostSnapshot>?
  func save(_ snapshot: HostSnapshot, hostIdentity: String) throws
  func remove(hostIdentity: String)
}

public enum PairedHostSnapshotStoreError: LocalizedError, Sendable {
  case invalidHostIdentity
  case invalidSnapshot(String)
  case snapshotTooLarge(Int)
  case encodeFailed(String)

  public var errorDescription: String? {
    switch self {
    case .invalidHostIdentity:
      return "Host identity is invalid."
    case .invalidSnapshot(let reason):
      return "Host snapshot is invalid: \(reason)"
    case .snapshotTooLarge(let bytes):
      return "Host snapshot exceeds the offline cache bound (\(bytes) bytes)."
    case .encodeFailed(let reason):
      return "Host snapshot cache encode failed: \(reason)"
    }
  }
}

private struct PairedHostSnapshotStoreEnvelope: Codable {
  let schemaVersion: Int
  let savedAt: String
  let snapshot: HostSnapshot
}

public final class UserDefaultsPairedHostSnapshotStore: PairedHostSnapshotStore,
  @unchecked Sendable
{
  public static let maxEncodedBytes = 8 * 1024 * 1024

  private let defaults: UserDefaults
  private let keyPrefix: String
  private let lock = NSLock()

  public init(
    defaults: UserDefaults = .standard,
    keyPrefix: String = "tw.host-projection.v1."
  ) {
    self.defaults = defaults
    self.keyPrefix = keyPrefix
  }

  public func load(hostIdentity: String) -> HostDecodeResult<HostSnapshot>? {
    guard let key = storageKey(hostIdentity) else { return .error("Host identity is invalid") }
    lock.lock()
    let data = defaults.data(forKey: key)
    lock.unlock()
    guard let data else { return nil }
    guard data.count <= Self.maxEncodedBytes else { return .error("cached snapshot is oversized") }
    do {
      let envelope = try JSONDecoder().decode(PairedHostSnapshotStoreEnvelope.self, from: data)
      guard envelope.schemaVersion == 1 else { return .error("unsupported cache schema") }
      switch normalizedSnapshot(envelope.snapshot) {
      case .ok(let snapshot):
        guard let stale = stalePairedHostSnapshot(snapshot) else {
          return .error("cached snapshot cannot be marked stale")
        }
        return .ok(stale)
      case .error(let reason):
        return .error(reason)
      }
    } catch {
      return .error("cached snapshot decode failed: \(error.localizedDescription)")
    }
  }

  public func save(_ snapshot: HostSnapshot, hostIdentity: String) throws {
    guard let key = storageKey(hostIdentity) else {
      throw PairedHostSnapshotStoreError.invalidHostIdentity
    }
    let validated: HostSnapshot
    switch normalizedSnapshot(snapshot) {
    case .ok(let value): validated = value
    case .error(let reason): throw PairedHostSnapshotStoreError.invalidSnapshot(reason)
    }
    let data: Data
    do {
      data = try JSONEncoder().encode(
        PairedHostSnapshotStoreEnvelope(
          schemaVersion: 1,
          savedAt: ISO8601DateFormatter().string(from: Date()),
          snapshot: validated))
    } catch {
      throw PairedHostSnapshotStoreError.encodeFailed(error.localizedDescription)
    }
    guard data.count <= Self.maxEncodedBytes else {
      throw PairedHostSnapshotStoreError.snapshotTooLarge(data.count)
    }
    lock.lock()
    defaults.set(data, forKey: key)
    lock.unlock()
  }

  public func remove(hostIdentity: String) {
    guard let key = storageKey(hostIdentity) else { return }
    lock.lock()
    defaults.removeObject(forKey: key)
    lock.unlock()
  }

  private func storageKey(_ hostIdentity: String) -> String? {
    let bounded = hostIdentity.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !bounded.isEmpty, bounded.utf8.count <= 4_096 else { return nil }
    let digest = SHA256.hash(data: Data(bounded.utf8))
    return keyPrefix + digest.map { String(format: "%02x", $0) }.joined()
  }
}
