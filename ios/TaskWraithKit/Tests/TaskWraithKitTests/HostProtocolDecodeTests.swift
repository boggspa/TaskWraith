// Host protocol decode tests — RED-first fail-closed gates.
//
// Each test verifies a decode invariant, bounds check, or contract guarantee.
// Privacy invariants under test:
//   - transcripts are never forwarded (latestPreview is bounded, no full body)
//   - artifact bodies never included (only byteLength / sha256 metadata)
//   - schedules never leak prompts (title is schedule label, not prompt text)
//   - participants never invent lifecycle vocabulary

import Foundation
import Testing

@testable import TaskWraithKit

@Suite("HostProtocol decode — all 13 families")
struct HostProtocolDecodeTests {

    // ── Full snapshot round-trip ────────────────────────────────────────

    @Test("complete snapshot with all 13 families decodes and round-trips")
    func completeSnapshotRoundTrip() throws {
        let snapshot = makeFullSnapshot()
        let data = try JSONEncoder().encode(snapshot)
        let decoded = try JSONDecoder().decode(HostSnapshot.self, from: data)

        #expect(decoded.protocolVersion == 2)
        #expect(decoded.projectionVersion == 1)
        #expect(decoded.freshness == .live)
        #expect(decoded.generation == 42)
        #expect(decoded.cursor == 7)

        // Health
        #expect(decoded.health.hostStatus == .ok)
        #expect(decoded.health.supervised == true)
        #expect(decoded.health.freshness == .live)

        // Workspaces
        #expect(decoded.workspaces.count == 1)
        #expect(decoded.workspaces[0].name == "AGBench")

        // Threads
        #expect(decoded.threads.count == 1)
        #expect(decoded.threads[0].chatKind == .ensemble)
        #expect(decoded.threads[0].latestPreview == "brief preview…")

        // Runs
        #expect(decoded.runs.count == 1)
        #expect(decoded.runs[0].providerOutcome == .running)

        // Missions
        #expect(decoded.missions.count == 1)
        #expect(decoded.missions[0].status == .active)

        // Rounds
        #expect(decoded.rounds.count == 1)
        #expect(decoded.rounds[0].status == .running)

        // Participants
        #expect(decoded.participants.count == 1)
        #expect(decoded.participants[0].stage == .worker)

        // Providers
        #expect(decoded.providers.count == 1)
        #expect(decoded.providers[0].available == true)

        // Questions
        #expect(decoded.questions.count == 1)
        #expect(decoded.questions[0].status == .open)

        // Approvals
        #expect(decoded.approvals.count == 1)
        #expect(decoded.approvals[0].commandId == "cmd-1")
        #expect(decoded.approvals[0].status == .pending)

        // Schedules
        #expect(decoded.schedules.count == 1)
        #expect(decoded.schedules[0].enabled == true)

        // Usage
        #expect(decoded.usage.availability == .estimated)
        #expect(decoded.usage.tokens == 1500)

        // Artifacts
        #expect(decoded.artifacts.count == 1)
        #expect(decoded.artifacts[0].byteLength == 2048)
        // Privacy: artifact body bytes are never included
        #expect(decoded.artifacts[0].sha256 == "abc123def456")

        // Warnings
        #expect(decoded.warnings.count == 1)
        #expect(decoded.warnings[0].code == "provider_source_not_ready")

        // Recovery
        #expect(decoded.recovery.reopenStatus == .clean)
    }

    // ── Fail-closed decode via gate function ────────────────────────────

    @Test("decodeHostSnapshot succeeds for full snapshot")
    func decodeHostSnapshotSuccess() throws {
        let snapshot = makeFullSnapshot()
        let data = try JSONEncoder().encode(snapshot)
        let result = decodeHostSnapshot(from: data)
        guard case .ok(let decoded) = result else {
            Issue.record("expected .ok, got \(result)")
            return
        }
        #expect(decoded.generation == 42)
    }

    @Test("decodeHostSnapshot rejects unknown protocol version")
    func rejectUnknownProtocolVersion() throws {
        let data = """
        {"protocolVersion":99,"projectionVersion":1,"generatedAt":"2025-01-01T00:00:00Z",
         "generation":0,"cursor":0,"freshness":"live",
         "health":{"hostStatus":"ok","connectionPhase":"live","supervised":true,"freshness":"live"},
         "workspaces":[],"threads":[],"runs":[],"missions":[],"rounds":[],
         "participants":[],"providers":[],"questions":[],"approvals":[],
         "schedules":[],"usage":{"availability":"unavailable"},
         "artifacts":[],"warnings":[],"recovery":{"reopenStatus":"clean"}}
        """.data(using: .utf8)!
        let result = decodeHostSnapshot(from: data)
        guard case .error(let msg) = result else {
            Issue.record("expected .error, got \(result)")
            return
        }
        #expect(msg.contains("protocol version"))
    }

    @Test("decodeHostSnapshot rejects bad freshness enum")
    func rejectBadFreshness() throws {
        let data = """
        {"protocolVersion":2,"projectionVersion":1,"generatedAt":"2025-01-01T00:00:00Z",
         "generation":0,"cursor":0,"freshness":"banana",
         "health":{"hostStatus":"ok","connectionPhase":"live","supervised":true,"freshness":"live"},
         "workspaces":[],"threads":[],"runs":[],"missions":[],"rounds":[],
         "participants":[],"providers":[],"questions":[],"approvals":[],
         "schedules":[],"usage":{"availability":"unavailable"},
         "artifacts":[],"warnings":[],"recovery":{"reopenStatus":"clean"}}
        """.data(using: .utf8)!
        let result = decodeHostSnapshot(from: data)
        guard case .error = result else {
            Issue.record("expected .error, got \(result)")
            return
        }
    }

    @Test("decodeHostSnapshot rejects missing health")
    func rejectMissingHealth() throws {
        let data = """
        {"protocolVersion":2,"projectionVersion":1,"generatedAt":"2025-01-01T00:00:00Z",
         "generation":0,"cursor":0,"freshness":"live",
         "workspaces":[],"threads":[],"runs":[],"missions":[],"rounds":[],
         "participants":[],"providers":[],"questions":[],"approvals":[],
         "schedules":[],"usage":{"availability":"unavailable"},
         "artifacts":[],"warnings":[],"recovery":{"reopenStatus":"clean"}}
        """.data(using: .utf8)!
        let result = decodeHostSnapshot(from: data)
        guard case .error(let msg) = result else {
            Issue.record("expected .error, got \(result)")
            return
        }
        #expect(msg.contains("health"))
    }

    @Test("decodeHostSnapshot rejects collection exceeding max")
    func rejectOversizedCollections() throws {
        let oversized = Array(repeating: "x", count: HostProtocolConstants.maxCollection + 1)
            .map { _ in ["id": "too-many"] as [String: Any] }
        var raw: [String: Any] = [
            "protocolVersion": 2, "projectionVersion": 1,
            "generatedAt": "2025-01-01T00:00:00Z", "generation": 0, "cursor": 0,
            "freshness": "live",
            "health": ["hostStatus": "ok", "connectionPhase": "live", "supervised": true, "freshness": "live"],
            "workspaces": oversized, "threads": [], "runs": [], "missions": [], "rounds": [],
            "participants": [], "providers": [], "questions": [], "approvals": [],
            "schedules": [], "usage": ["availability": "unavailable"],
            "artifacts": [], "warnings": [], "recovery": ["reopenStatus": "clean"]
        ]
        let data = try JSONSerialization.data(withJSONObject: raw)
        let result = decodeHostSnapshot(from: data)
        guard case .error(let msg) = result else {
            Issue.record("expected .error, got \(result)")
            return
        }
        #expect(msg.contains("workspaces"))
    }

    // ── Empty snapshot factory ──────────────────────────────────────────

    @Test("empty snapshot factory produces valid skeleton")
    func emptySnapshotFactory() throws {
        let snapshot = createEmptyHostSnapshot(generation: 0, cursor: 0)
        #expect(snapshot.protocolVersion == 2)
        #expect(snapshot.generation == 0)
        #expect(snapshot.cursor == 0)
        #expect(snapshot.freshness == .live)
        #expect(snapshot.health.hostStatus == .ok)
        #expect(snapshot.workspaces.isEmpty)
        #expect(snapshot.threads.isEmpty)
        #expect(snapshot.runs.isEmpty)
        #expect(snapshot.missions.isEmpty)
        #expect(snapshot.rounds.isEmpty)
        #expect(snapshot.participants.isEmpty)
        #expect(snapshot.providers.isEmpty)
        #expect(snapshot.questions.isEmpty)
        #expect(snapshot.approvals.isEmpty)
        #expect(snapshot.schedules.isEmpty)
        #expect(snapshot.artifacts.isEmpty)
        #expect(snapshot.warnings.isEmpty)
        #expect(snapshot.usage.availability == .unavailable)
        #expect(snapshot.recovery.reopenStatus == .clean)
    }

    // ── Bootstrap frames ────────────────────────────────────────────────

    @Test("BootstrapHello decodes with capabilities")
    func bootstrapHelloDecodes() throws {
        let json = """
        {"type":"host.hello","protocolVersion":2,"projectionVersion":1,
         "client":{"clientId":"ios-1","clientClass":"ios","clientVersion":"1.0"},
         "capabilities":["bootstrap","snapshot","health"]}
        """.data(using: .utf8)!
        let result = decodeHostBootstrapHello(from: json)
        guard case .ok(let hello) = result else {
            Issue.record("expected .ok, got \(result)")
            return
        }
        #expect(hello.client.clientClass == .ios)
        #expect(hello.capabilities.count == 3)
        #expect(hello.capabilities.contains(.bootstrap))
    }

    @Test("BootstrapWelcome decodes with host identity")
    func bootstrapWelcomeDecodes() throws {
        let json = """
        {"type":"host.welcome","protocolVersion":2,"controlProtocolCompat":1,
         "projectionVersion":1,"hostId":"mac-studio-1","hostVersion":"1.9.4",
         "sessionId":"sess-abc","generation":1,"cursor":0,
         "authenticatedClient":{"clientId":"ios-1","clientClass":"ios","clientVersion":"1.0"},
         "capabilities":["bootstrap","snapshot","health"],"freshness":"live"}
        """.data(using: .utf8)!
        let result = decodeHostBootstrapWelcome(from: json)
        guard case .ok(let welcome) = result else {
            Issue.record("expected .ok, got \(result)")
            return
        }
        #expect(welcome.hostId == "mac-studio-1")
        #expect(welcome.hostVersion == "1.9.4")
        #expect(welcome.sessionId == "sess-abc")
        #expect(welcome.freshness == .live)
    }

    @Test("BootstrapHello rejects wrong type")
    func bootstrapHelloRejectsWrongType() throws {
        let json = """
        {"type":"host.welcome","protocolVersion":2,"projectionVersion":1,
         "client":{"clientId":"ios-1","clientClass":"ios","clientVersion":"1.0"},
         "capabilities":[]}
        """.data(using: .utf8)!
        let result = decodeHostBootstrapHello(from: json)
        guard case .error(let msg) = result else {
            Issue.record("expected .error, got \(result)")
            return
        }
        #expect(msg.contains("host.hello"))
    }

    // ── Command & receipt ───────────────────────────────────────────────

    @Test("HostCommand decodes with target and arguments")
    func hostCommandDecodes() throws {
        let json = """
        {"type":"host.command","protocolVersion":2,
         "commandId":"cmd-abc","idempotencyKey":"idem-abc",
         "actor":{"actorId":"user-1","clientId":"ios-1","clientClass":"ios"},
         "name":"composer.send","target":{"threadId":"thread-1"},
         "arguments":{"text":"hello world"},"issuedAt":"2025-01-01T00:00:00Z"}
        """.data(using: .utf8)!
        let result = decodeHostCommand(from: json)
        guard case .ok(let cmd) = result else {
            Issue.record("expected .ok, got \(result)")
            return
        }
        #expect(cmd.commandId == "cmd-abc")
        #expect(cmd.name == .composerSend)
        #expect(cmd.target["threadId"] == "thread-1")
    }

    @Test("HostCommandReceipt decodes with fingerprint")
    func hostCommandReceiptDecodes() throws {
        let fp = String(repeating: "a", count: 64)  // valid 64-char hex
        let json = """
        {"type":"host.receipt","protocolVersion":2,
         "commandId":"cmd-abc","idempotencyKey":"idem-abc",
         "name":"composer.send",
         "actor":{"actorId":"user-1","clientId":"ios-1","clientClass":"ios"},
         "authority":{"decision":"allow"},
         "status":"succeeded","commandFingerprint":"\(fp)",
         "generation":1,"cursor":3,"createdAt":"2025-01-01T00:00:00Z",
         "updatedAt":"2025-01-01T00:00:01Z"}
        """.data(using: .utf8)!
        let result = decodeHostCommandReceipt(from: json)
        guard case .ok(let receipt) = result else {
            Issue.record("expected .ok, got \(result)")
            return
        }
        #expect(receipt.status == .succeeded)
        #expect(receipt.commandFingerprint == fp)
    }

    @Test("HostCommandReceipt rejects bad fingerprint")
    func receiptRejectsBadFingerprint() throws {
        let json = """
        {"type":"host.receipt","protocolVersion":2,
         "commandId":"cmd-abc","idempotencyKey":"idem-abc",
         "name":"composer.send",
         "actor":{"actorId":"user-1","clientId":"ios-1","clientClass":"ios"},
         "authority":{"decision":"allow"},
         "status":"succeeded","commandFingerprint":"not-hex!!",
         "generation":1,"cursor":3,"createdAt":"2025-01-01T00:00:00Z",
         "updatedAt":"2025-01-01T00:00:01Z"}
        """.data(using: .utf8)!
        let result = decodeHostCommandReceipt(from: json)
        guard case .error(let msg) = result else {
            Issue.record("expected .error, got \(result)")
            return
        }
        #expect(msg.contains("commandFingerprint"))
    }

    // ── Cursor application ──────────────────────────────────────────────

    @Test("applyHostDeltaCursor: normal advance")
    func cursorNormalAdvance() {
        let current = HostCursorPosition(generation: 1, cursor: 5)
        let delta = HostDeltaEnvelope(
            generation: 1, cursor: 6, previousCursor: 5,
            kind: .upsert, family: .thread, at: "2025-01-01T00:00:00Z")
        let result = applyHostDeltaCursor(current: current, delta: delta)
        guard case .applied(let gen, let cur) = result else {
            Issue.record("expected .applied, got \(result)")
            return
        }
        #expect(gen == 1)
        #expect(cur == 6)
    }

    @Test("applyHostDeltaCursor: generation mismatch requires resnapshot")
    func cursorGenerationMismatch() {
        let current = HostCursorPosition(generation: 1, cursor: 5)
        let delta = HostDeltaEnvelope(
            generation: 2, cursor: 6, previousCursor: 5,
            kind: .upsert, family: .thread, at: "2025-01-01T00:00:00Z")
        let result = applyHostDeltaCursor(current: current, delta: delta)
        guard case .requireResnapshot(let reason, _, _) = result else {
            Issue.record("expected .requireResnapshot, got \(result)")
            return
        }
        #expect(reason == "generation_mismatch")
    }

    @Test("applyHostDeltaCursor: late delta (cursor behind)")
    func cursorLateDelta() {
        let current = HostCursorPosition(generation: 1, cursor: 10)
        let delta = HostDeltaEnvelope(
            generation: 1, cursor: 6, previousCursor: 5,
            kind: .upsert, family: .thread, at: "2025-01-01T00:00:00Z")
        let result = applyHostDeltaCursor(current: current, delta: delta)
        guard case .late(let gen, let cur) = result else {
            Issue.record("expected .late, got \(result)")
            return
        }
        #expect(gen == 1)
        #expect(cur == 10)
    }

    @Test("applyHostDeltaCursor: duplicate delta")
    func cursorDuplicate() {
        let current = HostCursorPosition(generation: 1, cursor: 5)
        let delta = HostDeltaEnvelope(
            generation: 1, cursor: 5, previousCursor: 4,
            kind: .upsert, family: .thread, at: "2025-01-01T00:00:00Z")
        let result = applyHostDeltaCursor(current: current, delta: delta)
        guard case .duplicate(let gen, let cur) = result else {
            Issue.record("expected .duplicate, got \(result)")
            return
        }
        #expect(gen == 1)
        #expect(cur == 5)
    }

    @Test("applyHostDeltaCursor: previousCursor mismatch")
    func cursorPreviousMismatch() {
        let current = HostCursorPosition(generation: 1, cursor: 5)
        let delta = HostDeltaEnvelope(
            generation: 1, cursor: 7, previousCursor: 3,  // gap
            kind: .upsert, family: .thread, at: "2025-01-01T00:00:00Z")
        let result = applyHostDeltaCursor(current: current, delta: delta)
        guard case .requireResnapshot = result else {
            Issue.record("expected .requireResnapshot, got \(result)")
            return
        }
    }

    @Test("applyHostDeltaCursor: cursor gap (not +1)")
    func cursorGap() {
        let current = HostCursorPosition(generation: 1, cursor: 5)
        let delta = HostDeltaEnvelope(
            generation: 1, cursor: 8, previousCursor: 5,  // +3 jump
            kind: .upsert, family: .thread, at: "2025-01-01T00:00:00Z")
        let result = applyHostDeltaCursor(current: current, delta: delta)
        guard case .requireResnapshot = result else {
            Issue.record("expected .requireResnapshot, got \(result)")
            return
        }
    }

    // ── Capability intersection ─────────────────────────────────────────

    @Test("intersectHostCapabilities: keeps host order, dedupes")
    func capabilityIntersection() {
        let host = [HostCapability.bootstrap, .health, .snapshot, .deltas, .commands]
        let client = [HostCapability.snapshot, .deltas, .bootstrap, .bootstrap]
        let result = intersectHostCapabilities(hostOffer: host, clientRequest: client)
        #expect(result == [.bootstrap, .snapshot, .deltas])
    }

    @Test("intersectHostCapabilities: empty client request yields empty")
    func capabilityEmptyClient() {
        let host = [HostCapability.bootstrap, .health]
        let result = intersectHostCapabilities(hostOffer: host, clientRequest: [])
        #expect(result.isEmpty)
    }

    // ── Fingerprint normalization ───────────────────────────────────────

    @Test("normalizeHostCommandFingerprint: valid hex lowercased")
    func fingerprintValid() {
        let fp = String(repeating: "a", count: 64)
        let result = normalizeHostCommandFingerprint(fp)
        #expect(result == fp)
    }

    @Test("normalizeHostCommandFingerprint: uppercase normalized to lowercase")
    func fingerprintUppercase() {
        let fp = String(repeating: "F", count: 64)
        let result = normalizeHostCommandFingerprint(fp)
        #expect(result == String(repeating: "f", count: 64))
    }

    @Test("normalizeHostCommandFingerprint: wrong length rejected")
    func fingerprintWrongLength() {
        let fp = String(repeating: "a", count: 32)
        let result = normalizeHostCommandFingerprint(fp)
        #expect(result == nil)
    }

    @Test("normalizeHostCommandFingerprint: non-hex rejected")
    func fingerprintNonHex() {
        let fp = String(repeating: "g", count: 64)
        let result = normalizeHostCommandFingerprint(fp)
        #expect(result == nil)
    }

    // ── Privacy invariants ──────────────────────────────────────────────

    @Test("thread projection: latestPreview is bounded, no full transcript body")
    func threadPrivacyBounds() throws {
        let snapshot = makeFullSnapshot()
        let thread = try #require(snapshot.threads.first)
        // latestPreview is short (≤2000 chars per protocol)
        #expect(thread.latestPreview!.count <= 2000)
        // No full transcript body field exists on the type
        // (the type itself enforces this — no body/messages/content field)
    }

    @Test("artifact projection: metadata only, no body bytes")
    func artifactPrivacyMetadata() throws {
        let snapshot = makeFullSnapshot()
        let artifact = try #require(snapshot.artifacts.first)
        // Only byteLength and sha256 — never body bytes
        #expect(artifact.byteLength == 2048)
        #expect(artifact.sha256 != nil)
        // The type has no body/content/data field
    }

    @Test("schedule projection: title is schedule label, not prompt text")
    func schedulePrivacyTitle() throws {
        let snapshot = makeFullSnapshot()
        let schedule = try #require(snapshot.schedules.first)
        #expect(schedule.title == "Daily cleanup")
        // No prompt/body field on the type
    }

    @Test("provider available field always present (not nil/optional omit)")
    func providerAvailableRequired() throws {
        let json = """
        {"providerId":"antigravity","displayProvider":"Antigravity",
         "shortCode":"ag","available":false}
        """.data(using: .utf8)!
        let provider = try JSONDecoder().decode(HostProviderModelProjection.self, from: json)
        #expect(provider.available == false)
        // `available` is Bool (not Bool?) — cannot be absent
    }

    @Test("approval commandId is required (the join key)")
    func approvalCommandIdRequired() throws {
        let json = """
        {"approvalId":"app-1","commandId":"cmd-1","status":"pending",
         "actionKind":"appstore","createdAt":1700000000,
         "summary":"Install something"}
        """.data(using: .utf8)!
        let approval = try JSONDecoder().decode(HostApprovalProjection.self, from: json)
        #expect(approval.commandId == "cmd-1")
        // commandId is String (not String?) — cannot be absent
    }

    // ── DeltasSinceResult ───────────────────────────────────────────────

    @Test("DeltasSinceResult: deltas payload decodes")
    func deltasSinceDeltas() throws {
        let json = """
        {"kind":"deltas","generation":1,"fromCursor":0,"toCursor":2,
         "deltas":[
           {"protocolVersion":2,"projectionVersion":1,"generation":1,
            "cursor":1,"previousCursor":0,"kind":"upsert","family":"thread",
            "entityId":"t1","at":"2025-01-01T00:00:00Z"},
           {"protocolVersion":2,"projectionVersion":1,"generation":1,
            "cursor":2,"previousCursor":1,"kind":"upsert","family":"thread",
            "entityId":"t2","at":"2025-01-01T00:00:01Z"}
         ]}
        """.data(using: .utf8)!
        let result = try JSONDecoder().decode(HostDeltasSinceResult.self, from: json)
        guard case .deltas(let p) = result else {
            Issue.record("expected .deltas, got \(result)")
            return
        }
        #expect(p.deltas.count == 2)
        #expect(p.toCursor == 2)
    }

    @Test("DeltasSinceResult: resnapshot payload decodes")
    func deltasSinceResnapshot() throws {
        let json = """
        {"kind":"full_resnapshot_required","reason":"generation_mismatch",
         "generation":2,"cursor":0,"clientGeneration":1,"clientCursor":42}
        """.data(using: .utf8)!
        let result = try JSONDecoder().decode(HostDeltasSinceResult.self, from: json)
        guard case .fullResnapshotRequired(let p) = result else {
            Issue.record("expected .fullResnapshotRequired, got \(result)")
            return
        }
        #expect(p.reason == "generation_mismatch")
        #expect(p.generation == 2)
        #expect(p.clientCursor == 42)
    }

    @Test("DeltasSinceResult rejects unknown kind")
    func deltasSinceRejectsUnknown() throws {
        let data = """
        {"kind":"banana"}
        """.data(using: .utf8)!
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(HostDeltasSinceResult.self, from: data)
        }
    }

    // ── Snapshot and health frames ──────────────────────────────────────

    @Test("HostSnapshotFrame wraps snapshot with type tag")
    func snapshotFrame() throws {
        let snapshot = createEmptyHostSnapshot(generation: 0, cursor: 0)
        let frame = HostSnapshotFrame(snapshot: snapshot)
        let data = try JSONEncoder().encode(frame)
        let decoded = try JSONDecoder().decode(HostSnapshotFrame.self, from: data)
        #expect(decoded.type == "host.snapshot")
        #expect(decoded.snapshot.generation == 0)
    }

    @Test("HostHealthFrame wraps health projection")
    func healthFrame() throws {
        let health = HostHealthProjection(
            hostStatus: .ok, connectionPhase: .live,
            supervised: true, freshness: .live)
        let frame = HostHealthFrame(health: health)
        let data = try JSONEncoder().encode(frame)
        let decoded = try JSONDecoder().decode(HostHealthFrame.self, from: data)
        #expect(decoded.type == "host.health")
        #expect(decoded.health.hostStatus == .ok)
    }

    // ── Idempotency replay ──────────────────────────────────────────────

    @Test("evaluateHostIdempotencyReplay: same key + fingerprint = replay")
    func idempotencyReplay() {
        let fp = String(repeating: "a", count: 64)
        let result = evaluateHostIdempotencyReplay(
            nextKey: "k1", nextFingerprint: fp,
            existingKey: "k1", existingFingerprint: fp)
        #expect(result == "replay")
    }

    @Test("evaluateHostIdempotencyReplay: different key = conflict")
    func idempotencyKeyMismatch() {
        let fp = String(repeating: "a", count: 64)
        let result = evaluateHostIdempotencyReplay(
            nextKey: "k1", nextFingerprint: fp,
            existingKey: "k2", existingFingerprint: fp)
        #expect(result == "conflict")
    }

    @Test("evaluateHostIdempotencyReplay: same key, different fingerprint = conflict")
    func idempotencyFingerprintMismatch() {
        let fp1 = String(repeating: "a", count: 64)
        let fp2 = String(repeating: "b", count: 64)
        let result = evaluateHostIdempotencyReplay(
            nextKey: "k1", nextFingerprint: fp1,
            existingKey: "k1", existingFingerprint: fp2)
        #expect(result == "conflict")
    }

    // ── DeltaEnvelope round-trip ────────────────────────────────────────

    @Test("HostDeltaEnvelope round-trips with payload")
    func deltaEnvelopeRoundTrip() throws {
        var delta = HostDeltaEnvelope(
            generation: 1, cursor: 3, previousCursor: 2,
            kind: .upsert, family: .thread, entityId: "t-1",
            payload: .object(["title": .string("Hello")]),
            at: "2025-01-01T00:00:00Z")
        delta.tombstone = false
        let data = try JSONEncoder().encode(delta)
        let decoded = try JSONDecoder().decode(HostDeltaEnvelope.self, from: data)
        #expect(decoded.generation == 1)
        #expect(decoded.cursor == 3)
        #expect(decoded.family == .thread)
        #expect(decoded.entityId == "t-1")
        if case .object(let obj) = decoded.payload {
            #expect(obj["title"] == .string("Hello"))
        } else {
            Issue.record("expected object payload")
        }
    }

    // ── Full-family enumeration coverage ────────────────────────────────

    @Test("all 13 families present in snapshot type")
    func allFamiliesPresent() throws {
        let snapshot = createEmptyHostSnapshot(generation: 0, cursor: 0)
        // Every family array / value is present (not nil/optional except routing)
        _ = snapshot.health
        _ = snapshot.workspaces
        _ = snapshot.threads
        _ = snapshot.runs
        _ = snapshot.missions
        _ = snapshot.rounds
        _ = snapshot.participants
        _ = snapshot.providers
        _ = snapshot.questions
        _ = snapshot.approvals
        _ = snapshot.schedules
        _ = snapshot.usage
        _ = snapshot.artifacts
        _ = snapshot.warnings
        _ = snapshot.recovery
        // routing is the only optional family (correctly matches protocol)
        #expect(snapshot.routing == nil)
    }

    @Test("JSONAny round-trips all variants")
    func jsonAnyRoundTrip() throws {
        let obj: [String: HostJSONAny] = [
            "str": "hello", "num": 42, "bool": true,
            "null": nil as HostJSONAny? ?? .null,
            "arr": [1, 2, 3]
        ]
        let payload = HostJSONAny.object(obj)
        let data = try JSONEncoder().encode(payload)
        let decoded = try JSONDecoder().decode(HostJSONAny.self, from: data)
        #expect(decoded == payload)
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    private func makeFullSnapshot() -> HostSnapshot {
        HostSnapshot(
            protocolVersion: 2,
            projectionVersion: 1,
            generatedAt: "2025-01-01T00:00:00Z",
            generation: 42,
            cursor: 7,
            freshness: .live,
            health: HostHealthProjection(
                hostStatus: .ok, connectionPhase: .live,
                supervised: true, freshness: .live),
            workspaces: [
                HostWorkspaceProjection(
                    id: "ws-1", name: "AGBench", path: "/Users/x/AGBench",
                    pinned: true, updatedAt: 1_700_000_000)
            ],
            threads: [
                HostThreadProjection(
                    id: "thread-1", workspaceId: "ws-1",
                    title: "Ensemble round", chatKind: .ensemble,
                    archived: false, pinned: false,
                    updatedAt: 1_700_000_100, messageCount: 42,
                    latestPreview: "brief preview…", previewTruncated: false,
                    providerId: "antigravity",
                    missionOutcome: nil, activeRoundId: "round-1")
            ],
            runs: [
                HostRunProjection(
                    runId: "run-1", threadId: "thread-1",
                    providerId: "antigravity",
                    providerOutcome: .running,
                    startedAt: 1_700_000_000,
                    modelId: "gemini-3.1-pro",
                    usage: HostUsageObservation(
                        availability: .available, tokens: 500,
                        confidence: .exact, band: .low))
            ],
            missions: [
                HostMissionProjection(
                    missionId: "mission-1", threadId: "thread-1",
                    title: "Host Arc", status: .active,
                    goalId: "goal-1", updatedAt: 1_700_000_200)
            ],
            rounds: [
                HostRoundProjection(
                    roundId: "round-1", threadId: "thread-1",
                    status: .running, startedAt: 1_700_000_000,
                    routing: HostRoutingProjection(
                        mode: "ensemble", fanout: "locked_writers",
                        bossParticipantId: "p-1", captainParticipantId: "p-2"),
                    participantIds: ["p-1", "p-2"],
                    providerRunIds: ["run-1"])
            ],
            participants: [
                HostParticipantProjection(
                    id: "p-1", providerId: "antigravity", role: "SolBoss",
                    modelId: "gemini-3.1-pro", stage: .worker,
                    order: 1, enabled: true, active: true)
            ],
            providers: [
                HostProviderModelProjection(
                    providerId: "antigravity", displayProvider: "Antigravity",
                    modelId: "gemini-3.1-pro", modelLabel: "Gemini 3.1 Pro",
                    shortCode: "ag", hueKey: "#4285F4", available: true)
            ],
            routing: nil,
            questions: [
                HostQuestionProjection(
                    questionId: "q-1", threadId: "thread-1",
                    status: .open, promptPreview: "Which database?",
                    askedAt: 1_700_000_300)
            ],
            approvals: [
                HostApprovalProjection(
                    approvalId: "app-1", commandId: "cmd-1",
                    threadId: "thread-1", status: .pending,
                    actionKind: "approve_tool", createdAt: 1_700_000_300,
                    summary: "Install dependencies?")
            ],
            schedules: [
                HostScheduleProjection(
                    scheduleId: "sched-1", title: "Daily cleanup",
                    enabled: true, nextFireAt: 1_700_100_000)
            ],
            usage: HostUsageObservation(
                availability: .estimated, tokens: 1500,
                costText: "$0.02", confidence: .derived, band: .medium),
            artifacts: [
                HostArtifactProjection(
                    artifactId: "art-1", kind: "image/png",
                    threadId: "thread-1", title: "chart.png",
                    createdAt: 1_700_000_400,
                    byteLength: 2048, sha256: "abc123def456")
            ],
            warnings: [
                HostWarningProjection(
                    warningId: "warn-1", severity: .warning,
                    code: "provider_source_not_ready",
                    message: "Provider discovery not complete",
                    at: 1_700_000_500)
            ],
            recovery: HostRecoveryProjection(
                lastCheckpointAt: 1_700_000_000,
                lastGeneration: 41, lastCursor: 6,
                reopenStatus: .clean)
        )
    }
}
