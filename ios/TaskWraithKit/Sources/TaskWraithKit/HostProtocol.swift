// Host protocol v2 — Swift port of src/shared/hostProtocol.ts.
//
// Transport-independent Host projection types for iOS TaskWraithKit.
// Desktop / TUI / iOS all consume the same HostSnapshot shape; the decoder
// here is the iOS-side gate. Codable structs so JSON decode is direct from the
// relay transport payload (bridge envelope → host.snapshot / host.welcome / …).
//
// Privacy invariants (matching TS):
//   - transcripts are never forwarded (HostThreadProjection.latestPreview is bounded)
//   - artifact bodies are never included (byteLength / sha256 metadata only)
//   - schedules never leak prompts (title is the schedule's own label)
//   - participants never invent lifecycle vocabulary
//
// Fail-closed: any unrecognised enum value, missing required field, or
// out-of-bounds collection → decode failure. Per-field string bounds
// (maxID/maxString/maxShort) are enforced in decodeHostCommand; the
// snapshot decoder enforces collection caps and structural shape.
// Codable silently ignores unknown JSON keys (privacy-safe for the
// Host shape — schedule prompt fields are absent from the Swift types).

import Foundation

// ── Constants ─────────────────────────────────────────────────────────────

public enum HostProtocolConstants {
    public static let protocolVersion = 2
    public static let projectionVersion = 2
    public static let controlProtocolCompatVersion = 1
    public static let maxString = 16_000
    public static let maxID = 512
    public static let maxShort = 200
    public static let maxCapabilities = 64
    public static let maxCollection = 2_000
    public static let maxDeltas = 500
    public static let maxTranscriptPreview = 2_000
    public static let maxWarning = 1_000
    public static let commandFingerprintHexLength = 64
    public static let questionAnswerMaxChars = 8_000
    public static let questionDismissMessageMaxChars = 1_000
    public static let approvalDecideMessageMaxChars = 1_000
}

// ── Enum-like string sets ─────────────────────────────────────────────────

public enum HostClientClass: String, Codable, Sendable, CaseIterable {
    case desktop
    case tui
    case ios
    case test
}

public enum HostCapability: String, Codable, Sendable, CaseIterable {
    case bootstrap
    case snapshot
    case deltas
    case commands
    case receipts
    case health
    case missions
    case ensemble
    case approvals
    case questions
    case schedules
    case usage
    case artifacts
    case recovery
    case compactExport = "compact-export"

    /// Stable capability order matching TS `HOST_CAPABILITY_ORDER`.
    public static let ordered: [HostCapability] = [
        .bootstrap, .snapshot, .deltas, .commands, .receipts,
        .health, .missions, .ensemble, .approvals, .questions,
        .schedules, .usage, .artifacts, .recovery, .compactExport
    ]
}

public enum HostProjectionFreshness: String, Codable, Sendable, CaseIterable {
    case live
    case cached
    case stale
}

public enum HostConnectionPhase: String, Codable, Sendable, CaseIterable {
    case connecting
    case live
    case reconnecting
    case offline
    case staleCache = "stale-cache"
    case incompatibleProtocol = "incompatible-protocol"
    case hostUnavailable = "host-unavailable"
}

public enum HostProviderTerminalOutcome: String, Codable, Sendable, CaseIterable {
    case running
    case completed
    case failed
    case cancelled
    case requiresAction = "requires_action"
    case unknown
}

public enum HostRoundOutcome: String, Codable, Sendable, CaseIterable {
    case running
    case completed
    case cancelled
    case failed
    case unknown
}

public enum HostMissionOutcome: String, Codable, Sendable, CaseIterable {
    case active
    case completed
    case blocked
    case cancelled
    case failed
    case unknown
}

public enum HostUsageAvailability: String, Codable, Sendable, CaseIterable {
    case available
    case unavailable
    case estimated
}

public enum HostUsageConfidence: String, Codable, Sendable, CaseIterable {
    case exact
    case derived
    case estimated
    case unknown
}

public enum HostUsageBand: String, Codable, Sendable, CaseIterable {
    case low
    case medium
    case high
    case critical
    case unknown
}

public enum HostHealthStatus: String, Codable, Sendable, CaseIterable {
    case ok
    case degraded
    case recovering
    case offline
}

public enum HostReopenStatus: String, Codable, Sendable, CaseIterable {
    case clean
    case recovered
    case degraded
    case unknown
}

public enum HostChatKind: String, Codable, Sendable, CaseIterable {
    case single
    case ensemble
}

public enum HostQuestionStatus: String, Codable, Sendable, CaseIterable {
    case open
    case answered
    case dismissed
    case expired
}

public enum HostApprovalStatus: String, Codable, Sendable, CaseIterable {
    case pending
    case approved
    case denied
    case expired
    case cancelled
}

public enum HostWarningSeverity: String, Codable, Sendable, CaseIterable {
    case info
    case warning
    case error
}

public enum HostDecisionSource: String, Codable, Sendable, CaseIterable {
    case user
    case system
}

public enum HostParticipantStage: String, Codable, Sendable, CaseIterable {
    case scout
    case worker
    case reviewer
    case background
    case any
}

public enum HostCommandName: String, Codable, Sendable, CaseIterable {
    case snapshotGet = "snapshot.get"
    case deltasSince = "deltas.since"
    case receiptLookup = "receipt.lookup"
    case composerSend = "composer.send"
    case runCancel = "run.cancel"
    case questionAnswer = "question.answer"
    case approvalDecide = "approval.decide"
    case ensembleSeatToggle = "ensemble.seat.toggle"
    case threadSelect = "thread.select"
    case ping
}

public enum HostReceiptStatus: String, Codable, Sendable, CaseIterable {
    case pending
    case succeeded
    case failed
    case denied
    case cancelled
    case indeterminate
    case conflict
}

public enum HostDeltaKind: String, Codable, Sendable, CaseIterable {
    case upsert
    case remove
    case tombstone
    case generationReset = "generation-reset"
}

public enum HostDeltaFamily: String, Codable, Sendable, CaseIterable {
    case workspace
    case thread
    case run
    case mission
    case round
    case participant
    case provider
    case routing
    case question
    case approval
    case schedule
    case usage
    case artifact
    case warning
    case recovery
    case health
    case snapshotMeta = "snapshot-meta"
}

public enum HostAuthorityDecisionKind: String, Codable, Sendable {
    case allow
    case deny
    case ask
}

// ── Projection types (the 13 families + metadata) ─────────────────────────

public typealias HostGeneration = Int
public typealias HostCursor = Int

public struct HostCursorPosition: Codable, Sendable, Equatable {
    public var generation: HostGeneration
    public var cursor: HostCursor

    public init(generation: HostGeneration, cursor: HostCursor) {
        self.generation = generation
        self.cursor = cursor
    }
}

public struct HostActorIdentity: Codable, Sendable, Equatable {
    public var actorId: String
    public var clientId: String
    public var clientClass: HostClientClass

    public init(actorId: String, clientId: String, clientClass: HostClientClass) {
        self.actorId = actorId
        self.clientId = clientId
        self.clientClass = clientClass
    }
}

public struct HostAuthenticatedClientIdentity: Codable, Sendable, Equatable {
    public var clientId: String
    public var clientClass: HostClientClass
    public var clientVersion: String
    public var subjectId: String?
    public var displayName: String?

    public init(
        clientId: String, clientClass: HostClientClass, clientVersion: String,
        subjectId: String? = nil, displayName: String? = nil
    ) {
        self.clientId = clientId
        self.clientClass = clientClass
        self.clientVersion = clientVersion
        self.subjectId = subjectId
        self.displayName = displayName
    }
}

// Family 1: health
public struct HostHealthProjection: Codable, Sendable, Equatable {
    public var hostStatus: HostHealthStatus
    public var detail: String?
    public var connectionPhase: HostConnectionPhase
    public var supervised: Bool
    public var freshness: HostProjectionFreshness

    public init(
        hostStatus: HostHealthStatus, detail: String? = nil,
        connectionPhase: HostConnectionPhase, supervised: Bool,
        freshness: HostProjectionFreshness
    ) {
        self.hostStatus = hostStatus
        self.detail = detail
        self.connectionPhase = connectionPhase
        self.supervised = supervised
        self.freshness = freshness
    }
}

// Family 2: workspaces
public struct HostWorkspaceProjection: Codable, Sendable, Equatable {
    public var id: String
    public var name: String
    public var path: String
    public var pinned: Bool
    public var updatedAt: Int

    public init(
        id: String, name: String, path: String, pinned: Bool, updatedAt: Int
    ) {
        self.id = id
        self.name = name
        self.path = path
        self.pinned = pinned
        self.updatedAt = updatedAt
    }
}

// Family 3: threads
public struct HostThreadProjection: Codable, Sendable, Equatable {
    public var id: String
    public var workspaceId: String?  // null on the wire
    public var parentThreadId: String?
    public var title: String
    public var chatKind: HostChatKind
    public var archived: Bool
    public var pinned: Bool
    public var updatedAt: Int
    public var messageCount: Int
    /// Bounded preview only; never full transcript bodies.
    public var latestPreview: String?
    public var previewTruncated: Bool?
    public var providerId: String?
    public var missionOutcome: HostMissionOutcome?
    public var activeRoundId: String?
    public var usage: HostUsageObservation?

    public init(
        id: String, workspaceId: String?, parentThreadId: String? = nil,
        title: String, chatKind: HostChatKind, archived: Bool, pinned: Bool,
        updatedAt: Int, messageCount: Int, latestPreview: String? = nil,
        previewTruncated: Bool? = nil, providerId: String? = nil,
        missionOutcome: HostMissionOutcome? = nil,
        activeRoundId: String? = nil, usage: HostUsageObservation? = nil
    ) {
        self.id = id
        self.workspaceId = workspaceId
        self.parentThreadId = parentThreadId
        self.title = title
        self.chatKind = chatKind
        self.archived = archived
        self.pinned = pinned
        self.updatedAt = updatedAt
        self.messageCount = messageCount
        self.latestPreview = latestPreview
        self.previewTruncated = previewTruncated
        self.providerId = providerId
        self.missionOutcome = missionOutcome
        self.activeRoundId = activeRoundId
        self.usage = usage
    }
}

// Family 4: runs
public struct HostRunProjection: Codable, Sendable, Equatable {
    public var runId: String
    public var threadId: String
    public var providerId: String
    public var providerOutcome: HostProviderTerminalOutcome
    public var startedAt: Int?
    public var endedAt: Int?
    public var modelId: String?
    public var usage: HostUsageObservation?

    public init(
        runId: String, threadId: String, providerId: String,
        providerOutcome: HostProviderTerminalOutcome,
        startedAt: Int? = nil, endedAt: Int? = nil,
        modelId: String? = nil, usage: HostUsageObservation? = nil
    ) {
        self.runId = runId
        self.threadId = threadId
        self.providerId = providerId
        self.providerOutcome = providerOutcome
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.modelId = modelId
        self.usage = usage
    }
}

// Family 5: missions
public struct HostMissionProjection: Codable, Sendable, Equatable {
    public var missionId: String
    public var threadId: String?
    public var title: String
    public var status: HostMissionOutcome
    public var goalId: String?
    public var updatedAt: Int
    public var activeRoundId: String?

    public init(
        missionId: String, threadId: String? = nil, title: String,
        status: HostMissionOutcome, goalId: String? = nil,
        updatedAt: Int, activeRoundId: String? = nil
    ) {
        self.missionId = missionId
        self.threadId = threadId
        self.title = title
        self.status = status
        self.goalId = goalId
        self.updatedAt = updatedAt
        self.activeRoundId = activeRoundId
    }
}

// Family 6: rounds
public struct HostRoutingProjection: Codable, Sendable, Equatable {
    public var mode: String
    public var fanout: String
    public var activeParticipantId: String?
    public var continuationHops: Int?
    public var maxContinuationHops: Int?
    public var bossParticipantId: String?
    public var captainParticipantId: String?

    public init(
        mode: String, fanout: String,
        activeParticipantId: String? = nil,
        continuationHops: Int? = nil,
        maxContinuationHops: Int? = nil,
        bossParticipantId: String? = nil,
        captainParticipantId: String? = nil
    ) {
        self.mode = mode
        self.fanout = fanout
        self.activeParticipantId = activeParticipantId
        self.continuationHops = continuationHops
        self.maxContinuationHops = maxContinuationHops
        self.bossParticipantId = bossParticipantId
        self.captainParticipantId = captainParticipantId
    }
}

public struct HostWaveProjection: Codable, Sendable, Equatable {
    public var waveId: String
    public var label: String?
    public var status: String
    public var participantIds: [String]

    public init(
        waveId: String, label: String? = nil,
        status: String, participantIds: [String]
    ) {
        self.waveId = waveId
        self.label = label
        self.status = status
        self.participantIds = participantIds
    }
}

public struct HostRoundProjection: Codable, Sendable, Equatable {
    public var roundId: String
    public var threadId: String
    public var status: HostRoundOutcome
    public var startedAt: Int?
    public var endedAt: Int?
    public var routing: HostRoutingProjection?
    public var waves: [HostWaveProjection]?
    public var participantIds: [String]
    public var providerRunIds: [String]

    public init(
        roundId: String, threadId: String, status: HostRoundOutcome,
        startedAt: Int? = nil, endedAt: Int? = nil,
        routing: HostRoutingProjection? = nil,
        waves: [HostWaveProjection]? = nil,
        participantIds: [String], providerRunIds: [String]
    ) {
        self.roundId = roundId
        self.threadId = threadId
        self.status = status
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.routing = routing
        self.waves = waves
        self.participantIds = participantIds
        self.providerRunIds = providerRunIds
    }
}

// Family 7: participants
public struct HostParticipantProjection: Codable, Sendable, Equatable {
    public var id: String
    public var threadId: String
    public var providerId: String
    public var role: String
    public var modelId: String?
    public var stage: HostParticipantStage?
    public var order: Int
    public var enabled: Bool
    public var status: String?
    public var active: Bool

    public init(
        id: String, threadId: String, providerId: String, role: String,
        modelId: String? = nil, stage: HostParticipantStage? = nil,
        order: Int, enabled: Bool, status: String? = nil, active: Bool
    ) {
        self.id = id
        self.threadId = threadId
        self.providerId = providerId
        self.role = role
        self.modelId = modelId
        self.stage = stage
        self.order = order
        self.enabled = enabled
        self.status = status
        self.active = active
    }
}

// Family 8: providers
public struct HostProviderModelProjection: Codable, Sendable, Equatable {
    public var providerId: String
    public var displayProvider: String
    public var modelId: String?
    public var modelLabel: String?
    public var shortCode: String
    public var hueKey: String?
    /// REQUIRED on the wire; omit/undefined fails decode.
    public var available: Bool
    /// Admission note only — never credentials.
    public var note: String?

    public init(
        providerId: String, displayProvider: String,
        modelId: String? = nil, modelLabel: String? = nil,
        shortCode: String, hueKey: String? = nil,
        available: Bool, note: String? = nil
    ) {
        self.providerId = providerId
        self.displayProvider = displayProvider
        self.modelId = modelId
        self.modelLabel = modelLabel
        self.shortCode = shortCode
        self.hueKey = hueKey
        self.available = available
        self.note = note
    }
}

// Family 9: questions
public struct HostQuestionProjection: Codable, Sendable, Equatable {
    public var questionId: String
    public var threadId: String
    public var status: HostQuestionStatus
    public var promptPreview: String
    public var askedAt: Int
    public var answeredAt: Int?
    public var receiptId: String?

    public init(
        questionId: String, threadId: String,
        status: HostQuestionStatus, promptPreview: String,
        askedAt: Int, answeredAt: Int? = nil, receiptId: String? = nil
    ) {
        self.questionId = questionId
        self.threadId = threadId
        self.status = status
        self.promptPreview = promptPreview
        self.askedAt = askedAt
        self.answeredAt = answeredAt
        self.receiptId = receiptId
    }
}

// Family 10: approvals
public struct HostApprovalProjection: Codable, Sendable, Equatable {
    public var approvalId: String
    /// REQUIRED — the exact commandId this approval governs.
    public var commandId: String
    public var threadId: String?
    public var status: HostApprovalStatus
    public var actionKind: String
    public var createdAt: Int
    public var decidedAt: Int?
    public var decisionSource: HostDecisionSource?
    /// Compact summary only — never raw command bodies.
    public var summary: String

    public init(
        approvalId: String, commandId: String,
        threadId: String? = nil, status: HostApprovalStatus,
        actionKind: String, createdAt: Int,
        decidedAt: Int? = nil,
        decisionSource: HostDecisionSource? = nil,
        summary: String
    ) {
        self.approvalId = approvalId
        self.commandId = commandId
        self.threadId = threadId
        self.status = status
        self.actionKind = actionKind
        self.createdAt = createdAt
        self.decidedAt = decidedAt
        self.decisionSource = decisionSource
        self.summary = summary
    }
}

// Family 11: schedules
public struct HostScheduleProjection: Codable, Sendable, Equatable {
    public var scheduleId: String
    public var title: String
    public var enabled: Bool
    public var nextFireAt: Int?
    public var threadId: String?

    public init(
        scheduleId: String, title: String, enabled: Bool,
        nextFireAt: Int? = nil, threadId: String? = nil
    ) {
        self.scheduleId = scheduleId
        self.title = title
        self.enabled = enabled
        self.nextFireAt = nextFireAt
        self.threadId = threadId
    }
}

// Family 12: usage
public struct HostUsageObservation: Codable, Sendable, Equatable {
    public var availability: HostUsageAvailability
    public var tokens: Int?
    public var costText: String?
    public var confidence: HostUsageConfidence?
    public var band: HostUsageBand?

    public init(
        availability: HostUsageAvailability,
        tokens: Int? = nil, costText: String? = nil,
        confidence: HostUsageConfidence? = nil,
        band: HostUsageBand? = nil
    ) {
        self.availability = availability
        self.tokens = tokens
        self.costText = costText
        self.confidence = confidence
        self.band = band
    }
}

// Family 13: artifacts
public struct HostArtifactProjection: Codable, Sendable, Equatable {
    public var artifactId: String
    public var kind: String
    public var threadId: String?
    public var title: String
    public var createdAt: Int
    /// Metadata only — never artifact body bytes.
    public var byteLength: Int?
    public var sha256: String?

    public init(
        artifactId: String, kind: String, threadId: String? = nil,
        title: String, createdAt: Int,
        byteLength: Int? = nil, sha256: String? = nil
    ) {
        self.artifactId = artifactId
        self.kind = kind
        self.threadId = threadId
        self.title = title
        self.createdAt = createdAt
        self.byteLength = byteLength
        self.sha256 = sha256
    }
}

// Metadata families
public struct HostWarningProjection: Codable, Sendable, Equatable {
    public var warningId: String
    public var severity: HostWarningSeverity
    public var code: String
    public var message: String
    public var at: Int
    public var threadId: String?

    public init(
        warningId: String, severity: HostWarningSeverity,
        code: String, message: String, at: Int,
        threadId: String? = nil
    ) {
        self.warningId = warningId
        self.severity = severity
        self.code = code
        self.message = message
        self.at = at
        self.threadId = threadId
    }
}

public struct HostRecoveryProjection: Codable, Sendable, Equatable {
    public var lastCheckpointAt: Int?
    public var lastGeneration: HostGeneration?
    public var lastCursor: HostCursor?
    public var reopenStatus: HostReopenStatus
    public var detail: String?

    public init(
        lastCheckpointAt: Int? = nil,
        lastGeneration: HostGeneration? = nil,
        lastCursor: HostCursor? = nil,
        reopenStatus: HostReopenStatus,
        detail: String? = nil
    ) {
        self.lastCheckpointAt = lastCheckpointAt
        self.lastGeneration = lastGeneration
        self.lastCursor = lastCursor
        self.reopenStatus = reopenStatus
        self.detail = detail
    }
}

// ── The full snapshot ─────────────────────────────────────────────────────

/// Bounded Host authority projection shared by Desktop / TUI / iOS.
/// Families mirror the Host Arc goal list; bodies stay compact by construction.
public struct HostSnapshot: Codable, Sendable, Equatable {
    public var protocolVersion: Int
    public var projectionVersion: Int
    public var generatedAt: String
    public var generation: HostGeneration
    public var cursor: HostCursor
    public var freshness: HostProjectionFreshness
    public var health: HostHealthProjection
    public var workspaces: [HostWorkspaceProjection]
    public var threads: [HostThreadProjection]
    public var runs: [HostRunProjection]
    public var missions: [HostMissionProjection]
    public var rounds: [HostRoundProjection]
    public var participants: [HostParticipantProjection]
    public var providers: [HostProviderModelProjection]
    public var routing: HostRoutingProjection?
    public var questions: [HostQuestionProjection]
    public var approvals: [HostApprovalProjection]
    public var schedules: [HostScheduleProjection]
    public var usage: HostUsageObservation
    public var artifacts: [HostArtifactProjection]
    public var warnings: [HostWarningProjection]
    public var recovery: HostRecoveryProjection

    public init(
        protocolVersion: Int,
        projectionVersion: Int,
        generatedAt: String,
        generation: HostGeneration,
        cursor: HostCursor,
        freshness: HostProjectionFreshness,
        health: HostHealthProjection,
        workspaces: [HostWorkspaceProjection],
        threads: [HostThreadProjection],
        runs: [HostRunProjection],
        missions: [HostMissionProjection],
        rounds: [HostRoundProjection],
        participants: [HostParticipantProjection],
        providers: [HostProviderModelProjection],
        routing: HostRoutingProjection? = nil,
        questions: [HostQuestionProjection],
        approvals: [HostApprovalProjection],
        schedules: [HostScheduleProjection],
        usage: HostUsageObservation,
        artifacts: [HostArtifactProjection],
        warnings: [HostWarningProjection],
        recovery: HostRecoveryProjection
    ) {
        self.protocolVersion = protocolVersion
        self.projectionVersion = projectionVersion
        self.generatedAt = generatedAt
        self.generation = generation
        self.cursor = cursor
        self.freshness = freshness
        self.health = health
        self.workspaces = workspaces
        self.threads = threads
        self.runs = runs
        self.missions = missions
        self.rounds = rounds
        self.participants = participants
        self.providers = providers
        self.routing = routing
        self.questions = questions
        self.approvals = approvals
        self.schedules = schedules
        self.usage = usage
        self.artifacts = artifacts
        self.warnings = warnings
        self.recovery = recovery
    }
}

// ── Wire frames ───────────────────────────────────────────────────────────

public struct HostBootstrapHello: Codable, Sendable, Equatable {
    public var type: String  // "host.hello"
    public var protocolVersion: Int
    public var controlProtocolCompat: Int?
    public var projectionVersion: Int
    public var client: HostAuthenticatedClientIdentity
    public var capabilities: [HostCapability]

    public init(
        type: String = "host.hello",
        protocolVersion: Int = HostProtocolConstants.protocolVersion,
        controlProtocolCompat: Int? = nil,
        projectionVersion: Int = HostProtocolConstants.projectionVersion,
        client: HostAuthenticatedClientIdentity,
        capabilities: [HostCapability]
    ) {
        self.type = type
        self.protocolVersion = protocolVersion
        self.controlProtocolCompat = controlProtocolCompat
        self.projectionVersion = projectionVersion
        self.client = client
        self.capabilities = capabilities
    }
}

public struct HostBootstrapWelcome: Codable, Sendable, Equatable {
    public var type: String  // "host.welcome"
    public var protocolVersion: Int
    public var controlProtocolCompat: Int
    public var projectionVersion: Int
    public var hostId: String
    public var hostVersion: String
    public var sessionId: String
    public var generation: HostGeneration
    public var cursor: HostCursor
    public var authenticatedClient: HostAuthenticatedClientIdentity
    public var capabilities: [HostCapability]
    public var freshness: HostProjectionFreshness

    public init(
        type: String = "host.welcome",
        protocolVersion: Int = HostProtocolConstants.protocolVersion,
        controlProtocolCompat: Int = HostProtocolConstants.controlProtocolCompatVersion,
        projectionVersion: Int = HostProtocolConstants.projectionVersion,
        hostId: String, hostVersion: String, sessionId: String,
        generation: HostGeneration, cursor: HostCursor,
        authenticatedClient: HostAuthenticatedClientIdentity,
        capabilities: [HostCapability], freshness: HostProjectionFreshness
    ) {
        self.type = type
        self.protocolVersion = protocolVersion
        self.controlProtocolCompat = controlProtocolCompat
        self.projectionVersion = projectionVersion
        self.hostId = hostId
        self.hostVersion = hostVersion
        self.sessionId = sessionId
        self.generation = generation
        self.cursor = cursor
        self.authenticatedClient = authenticatedClient
        self.capabilities = capabilities
        self.freshness = freshness
    }
}

public struct HostSnapshotFrame: Codable, Sendable, Equatable {
    public var type: String  // "host.snapshot"
    public var protocolVersion: Int
    public var snapshot: HostSnapshot

    public init(
        type: String = "host.snapshot",
        protocolVersion: Int = HostProtocolConstants.protocolVersion,
        snapshot: HostSnapshot
    ) {
        self.type = type
        self.protocolVersion = protocolVersion
        self.snapshot = snapshot
    }
}

public struct HostHealthFrame: Codable, Sendable, Equatable {
    public var type: String  // "host.health"
    public var protocolVersion: Int
    public var health: HostHealthProjection

    public init(
        type: String = "host.health",
        protocolVersion: Int = HostProtocolConstants.protocolVersion,
        health: HostHealthProjection
    ) {
        self.type = type
        self.protocolVersion = protocolVersion
        self.health = health
    }
}

public struct HostDeltaEnvelope: Codable, Sendable, Equatable {
    public var protocolVersion: Int
    public var projectionVersion: Int
    public var generation: HostGeneration
    public var cursor: HostCursor
    public var previousCursor: HostCursor
    public var kind: HostDeltaKind
    public var family: HostDeltaFamily
    public var entityId: String?
    public var payload: HostJSONAny?
    public var tombstone: Bool?
    public var at: String

    public init(
        protocolVersion: Int = HostProtocolConstants.protocolVersion,
        projectionVersion: Int = HostProtocolConstants.projectionVersion,
        generation: HostGeneration, cursor: HostCursor,
        previousCursor: HostCursor, kind: HostDeltaKind,
        family: HostDeltaFamily, entityId: String? = nil,
        payload: HostJSONAny? = nil, tombstone: Bool? = nil,
        at: String
    ) {
        self.protocolVersion = protocolVersion
        self.projectionVersion = projectionVersion
        self.generation = generation
        self.cursor = cursor
        self.previousCursor = previousCursor
        self.kind = kind
        self.family = family
        self.entityId = entityId
        self.payload = payload
        self.tombstone = tombstone
        self.at = at
    }
}

/// Opaque JSON payload for delta envelopes — decoded as raw JSON without
/// structural interpretation at the transport layer.
public enum HostJSONAny: Codable, Sendable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: HostJSONAny])
    case array([HostJSONAny])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null; return }
        if let value = try? container.decode(String.self) { self = .string(value); return }
        if let value = try? container.decode(Double.self) { self = .number(value); return }
        if let value = try? container.decode(Bool.self) { self = .bool(value); return }
        if let value = try? container.decode([HostJSONAny].self) { self = .array(value); return }
        if let value = try? container.decode([String: HostJSONAny].self) { self = .object(value); return }
        throw DecodingError.dataCorruptedError(
            in: container, debugDescription: "unexpected JSON value")
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let v): try container.encode(v)
        case .number(let v): try container.encode(v)
        case .bool(let v): try container.encode(v)
        case .object(let v): try container.encode(v)
        case .array(let v): try container.encode(v)
        case .null: try container.encodeNil()
        }
    }
}

extension HostJSONAny: ExpressibleByStringLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
}

extension HostJSONAny: ExpressibleByIntegerLiteral {
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
}

extension HostJSONAny: ExpressibleByFloatLiteral {
    public init(floatLiteral value: Double) { self = .number(value) }
}

extension HostJSONAny: ExpressibleByBooleanLiteral {
    public init(booleanLiteral value: Bool) { self = .bool(value) }
}

extension HostJSONAny: ExpressibleByDictionaryLiteral {
    public init(dictionaryLiteral elements: (String, HostJSONAny)...) {
        var dict: [String: HostJSONAny] = [:]
        for (key, value) in elements { dict[key] = value }
        self = .object(dict)
    }
}

extension HostJSONAny: ExpressibleByArrayLiteral {
    public init(arrayLiteral elements: HostJSONAny...) { self = .array(elements) }
}

public struct HostDeltasFrame: Codable, Sendable, Equatable {
    public var type: String  // "host.deltas"
    public var protocolVersion: Int
    public var result: HostDeltasSinceResult

    public init(
        type: String = "host.deltas",
        protocolVersion: Int = HostProtocolConstants.protocolVersion,
        result: HostDeltasSinceResult
    ) {
        self.type = type
        self.protocolVersion = protocolVersion
        self.result = result
    }
}

public enum HostDeltasSinceResult: Codable, Sendable, Equatable {
    case deltas(DeltasPayload)
    case fullResnapshotRequired(ResnapshotPayload)

    public struct DeltasPayload: Codable, Sendable, Equatable {
        public var generation: HostGeneration
        public var fromCursor: HostCursor
        public var toCursor: HostCursor
        public var deltas: [HostDeltaEnvelope]

        public init(
            generation: HostGeneration, fromCursor: HostCursor,
            toCursor: HostCursor, deltas: [HostDeltaEnvelope]
        ) {
            self.generation = generation
            self.fromCursor = fromCursor
            self.toCursor = toCursor
            self.deltas = deltas
        }
    }

    public struct ResnapshotPayload: Codable, Sendable, Equatable {
        public var reason: String
        public var generation: HostGeneration
        public var cursor: HostCursor
        public var clientGeneration: HostGeneration
        public var clientCursor: HostCursor

        public init(
            reason: String, generation: HostGeneration,
            cursor: HostCursor, clientGeneration: HostGeneration,
            clientCursor: HostCursor
        ) {
            self.reason = reason
            self.generation = generation
            self.cursor = cursor
            self.clientGeneration = clientGeneration
            self.clientCursor = clientCursor
        }
    }

    private enum CodingKeys: String, CodingKey {
        case kind, generation, fromCursor, toCursor, deltas,
             reason, cursor, clientGeneration, clientCursor
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "deltas":
            let payload = DeltasPayload(
                generation: try container.decode(HostGeneration.self, forKey: .generation),
                fromCursor: try container.decode(HostCursor.self, forKey: .fromCursor),
                toCursor: try container.decode(HostCursor.self, forKey: .toCursor),
                deltas: try container.decode([HostDeltaEnvelope].self, forKey: .deltas))
            self = .deltas(payload)
        case "full_resnapshot_required":
            let payload = ResnapshotPayload(
                reason: try container.decode(String.self, forKey: .reason),
                generation: try container.decode(HostGeneration.self, forKey: .generation),
                cursor: try container.decode(HostCursor.self, forKey: .cursor),
                clientGeneration: try container.decode(HostGeneration.self, forKey: .clientGeneration),
                clientCursor: try container.decode(HostCursor.self, forKey: .clientCursor))
            self = .fullResnapshotRequired(payload)
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .kind, in: container,
                debugDescription: "unknown deltas-since kind: \(kind)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .deltas(let p):
            try container.encode("deltas", forKey: .kind)
            try container.encode(p.generation, forKey: .generation)
            try container.encode(p.fromCursor, forKey: .fromCursor)
            try container.encode(p.toCursor, forKey: .toCursor)
            try container.encode(p.deltas, forKey: .deltas)
        case .fullResnapshotRequired(let p):
            try container.encode("full_resnapshot_required", forKey: .kind)
            try container.encode(p.reason, forKey: .reason)
            try container.encode(p.generation, forKey: .generation)
            try container.encode(p.cursor, forKey: .cursor)
            try container.encode(p.clientGeneration, forKey: .clientGeneration)
            try container.encode(p.clientCursor, forKey: .clientCursor)
        }
    }
}

public struct HostAuthorityDecision: Codable, Sendable, Equatable {
    public var decision: HostAuthorityDecisionKind
    public var reason: String?

    public init(decision: HostAuthorityDecisionKind, reason: String? = nil) {
        self.decision = decision
        self.reason = reason
    }
}

public struct HostCommand: Codable, Sendable, Equatable {
    public var type: String  // "host.command"
    public var protocolVersion: Int
    public var commandId: String
    public var idempotencyKey: String
    public var actor: HostActorIdentity
    public var name: HostCommandName
    public var target: [String: String]
    public var arguments: [String: HostJSONAny]
    public var issuedAt: String

    public init(
        type: String = "host.command",
        protocolVersion: Int = HostProtocolConstants.protocolVersion,
        commandId: String, idempotencyKey: String,
        actor: HostActorIdentity, name: HostCommandName,
        target: [String: String], arguments: [String: HostJSONAny],
        issuedAt: String
    ) {
        self.type = type
        self.protocolVersion = protocolVersion
        self.commandId = commandId
        self.idempotencyKey = idempotencyKey
        self.actor = actor
        self.name = name
        self.target = target
        self.arguments = arguments
        self.issuedAt = issuedAt
    }
}

public struct HostCommandReceipt: Codable, Sendable, Equatable {
    public var type: String  // "host.receipt"
    public var protocolVersion: Int
    public var commandId: String
    public var idempotencyKey: String
    public var name: HostCommandName
    public var actor: HostActorIdentity
    public var authority: HostAuthorityDecision
    public var status: HostReceiptStatus
    public var commandFingerprint: String
    public var generation: HostGeneration
    public var cursor: HostCursor
    public var createdAt: String
    public var updatedAt: String
    public var resultSummary: String?
    public var errorCode: String?
    public var errorMessage: String?
    public var conflictCommandId: String?

    public init(
        type: String = "host.receipt",
        protocolVersion: Int = HostProtocolConstants.protocolVersion,
        commandId: String, idempotencyKey: String,
        name: HostCommandName, actor: HostActorIdentity,
        authority: HostAuthorityDecision, status: HostReceiptStatus,
        commandFingerprint: String, generation: HostGeneration,
        cursor: HostCursor, createdAt: String, updatedAt: String,
        resultSummary: String? = nil, errorCode: String? = nil,
        errorMessage: String? = nil, conflictCommandId: String? = nil
    ) {
        self.type = type
        self.protocolVersion = protocolVersion
        self.commandId = commandId
        self.idempotencyKey = idempotencyKey
        self.name = name
        self.actor = actor
        self.authority = authority
        self.status = status
        self.commandFingerprint = commandFingerprint
        self.generation = generation
        self.cursor = cursor
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.resultSummary = resultSummary
        self.errorCode = errorCode
        self.errorMessage = errorMessage
        self.conflictCommandId = conflictCommandId
    }
}

public struct HostBootstrapWelcomeMintInput: Codable, Sendable, Equatable {
    public var hostId: String
    public var hostVersion: String
    public var sessionId: String
    public var generation: HostGeneration
    public var cursor: HostCursor
    public var authenticatedClient: HostAuthenticatedClientIdentity
    public var hostCapabilityOffer: [HostCapability]
    public var clientCapabilityRequest: [HostCapability]
    public var freshness: HostProjectionFreshness

    public init(
        hostId: String, hostVersion: String, sessionId: String,
        generation: HostGeneration, cursor: HostCursor,
        authenticatedClient: HostAuthenticatedClientIdentity,
        hostCapabilityOffer: [HostCapability],
        clientCapabilityRequest: [HostCapability],
        freshness: HostProjectionFreshness
    ) {
        self.hostId = hostId
        self.hostVersion = hostVersion
        self.sessionId = sessionId
        self.generation = generation
        self.cursor = cursor
        self.authenticatedClient = authenticatedClient
        self.hostCapabilityOffer = hostCapabilityOffer
        self.clientCapabilityRequest = clientCapabilityRequest
        self.freshness = freshness
    }
}

public enum HostDeltaApplyOutcome: Equatable, Sendable {
    case applied(generation: HostGeneration, cursor: HostCursor)
    case duplicate(generation: HostGeneration, cursor: HostCursor)
    case late(generation: HostGeneration, cursor: HostCursor)
    case requireResnapshot(
        reason: String, generation: HostGeneration, cursor: HostCursor)
    case rejected(reason: String)
}

// ── Fail-closed decoder ───────────────────────────────────────────────────

/// Decode result with explicit success/failure — never silently drops data.
public enum HostDecodeResult<T>: Equatable where T: Equatable {
    case ok(T)
    case error(String)
}

private func isSafeHostEntityIdComponent(_ value: String) -> Bool {
    let length = value.utf16.count
    guard length > 0, length <= HostProtocolConstants.maxID else { return false }
    guard value.trimmingCharacters(in: .whitespacesAndNewlines) == value else { return false }
    return !value.unicodeScalars.contains { scalar in
        scalar.value <= 0x1F || scalar.value == 0x7F
    }
}

/// Stable participant delta identity. Mirrors TS `encodeHostParticipantEntityId`.
public func encodeHostParticipantEntityId(
    threadId: String, participantId: String
) -> HostDecodeResult<String> {
    guard isSafeHostEntityIdComponent(threadId) else {
        return .error("participant threadId is empty, oversized, or unsafe")
    }
    guard isSafeHostEntityIdComponent(participantId) else {
        return .error("participant id is empty, oversized, or unsafe")
    }
    let entityId = "pt1:\(threadId.utf16.count):\(threadId):\(participantId.utf16.count):\(participantId)"
    guard entityId.utf16.count <= HostProtocolConstants.maxID else {
        return .error("participant composite entity id exceeds Host id bound")
    }
    return .ok(entityId)
}

/// Deterministic capability intersection: host offer ∩ client request.
/// Preserves host offer order, dedupes, and never invents capabilities.
public func intersectHostCapabilities(
    hostOffer: [HostCapability], clientRequest: [HostCapability]
) -> [HostCapability] {
    let requested = Set(clientRequest)
    var seen = Set<HostCapability>()
    var out: [HostCapability] = []
    for entry in hostOffer {
        guard requested.contains(entry), !seen.contains(entry) else { continue }
        seen.insert(entry)
        out.append(entry)
    }
    return out
}

/// Pure cursor-application — mirrors TS `applyHostDeltaCursor`.
public func applyHostDeltaCursor(
    current: HostCursorPosition, delta: HostDeltaEnvelope
) -> HostDeltaApplyOutcome {
    if delta.projectionVersion != HostProtocolConstants.projectionVersion {
        return .requireResnapshot(
            reason: "projection_version_mismatch",
            generation: delta.generation, cursor: delta.cursor)
    }
    if delta.kind == .generationReset || delta.generation != current.generation {
        return .requireResnapshot(
            reason: delta.kind == .generationReset
                ? "generation_reset" : "generation_mismatch",
            generation: delta.generation, cursor: delta.cursor)
    }
    if delta.cursor < current.cursor {
        return .late(generation: current.generation, cursor: current.cursor)
    }
    if delta.cursor == current.cursor {
        return .duplicate(generation: current.generation, cursor: current.cursor)
    }
    if delta.previousCursor != current.cursor {
        return .requireResnapshot(
            reason: "previous_cursor_mismatch",
            generation: delta.generation, cursor: delta.cursor)
    }
    if delta.cursor != current.cursor + 1 {
        return .requireResnapshot(
            reason: "previous_cursor_mismatch",
            generation: delta.generation, cursor: delta.cursor)
    }
    return .applied(generation: delta.generation, cursor: delta.cursor)
}

/// Normalize a wire command fingerprint to lowercase SHA-256 hex.
/// Returns nil when not a valid 64-char hex digest.
public func normalizeHostCommandFingerprint(_ value: String) -> String? {
    let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard normalized.count == HostProtocolConstants.commandFingerprintHexLength else {
        return nil
    }
    guard normalized.allSatisfy({ $0.isHexDigit }) else { return nil }
    return normalized
}

/// Compare retry vs durable receipt fingerprints. Same key + same fingerprint ⇒ replay.
public func evaluateHostIdempotencyReplay(
    nextKey: String, nextFingerprint: String,
    existingKey: String, existingFingerprint: String
) -> String? {
    guard nextKey == existingKey else { return "conflict" }
    guard let nf = normalizeHostCommandFingerprint(nextFingerprint),
          let ef = normalizeHostCommandFingerprint(existingFingerprint),
          nf == ef
    else { return "conflict" }
    return "replay"
}

/// Fail-closed HostSnapshot decode: validate all enum values, required fields,
/// collection size caps (≤maxCollection), and structural shape.
/// Per-field string bounds (maxID/maxString/maxShort) are NOT enforced here —
/// they are enforced in decodeHostCommand only. Codable silently ignores
/// unknown JSON keys, which is privacy-safe for the Host shape.
/// Returns `.error` with a diagnostic on any mismatch.
public func decodeHostSnapshot(from data: Data) -> HostDecodeResult<HostSnapshot> {
    let decoder = JSONDecoder()
    guard let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return .error("snapshot must be a JSON object")
    }
    guard let pv = raw["protocolVersion"] as? Int,
          pv == HostProtocolConstants.protocolVersion else {
        return .error("unsupported protocol version")
    }
    guard let projV = raw["projectionVersion"] as? Int,
          projV == HostProtocolConstants.projectionVersion else {
        return .error("unsupported projection version")
    }
    guard let freshnessRaw = raw["freshness"] as? String,
          let _ = HostProjectionFreshness(rawValue: freshnessRaw) else {
        return .error("freshness is required and must be live/cached/stale")
    }
    guard let _ = raw["generatedAt"] as? String, !String(describing: raw["generatedAt"]!).isEmpty else {
        return .error("generatedAt is required")
    }
    guard let generation = raw["generation"] as? Int, generation >= 0 else {
        return .error("generation must be a non-negative integer")
    }
    guard let cursor = raw["cursor"] as? Int, cursor >= 0 else {
        return .error("cursor must be a non-negative integer")
    }
    // Validate each family decodes structurally
    guard raw["health"] is [String: Any] else {
        return .error("health is required")
    }
    guard raw["workspaces"] is [[String: Any]] else {
        return .error("workspaces must be an array")
    }
    guard raw["threads"] is [[String: Any]] else {
        return .error("threads must be an array")
    }
    guard raw["runs"] is [[String: Any]] else {
        return .error("runs must be an array")
    }
    guard raw["missions"] is [[String: Any]] else {
        return .error("missions must be an array")
    }
    guard raw["rounds"] is [[String: Any]] else {
        return .error("rounds must be an array")
    }
    guard raw["participants"] is [[String: Any]] else {
        return .error("participants must be an array")
    }
    guard raw["providers"] is [[String: Any]] else {
        return .error("providers must be an array")
    }
    guard raw["questions"] is [[String: Any]] else {
        return .error("questions must be an array")
    }
    guard raw["approvals"] is [[String: Any]] else {
        return .error("approvals must be an array")
    }
    guard raw["schedules"] is [[String: Any]] else {
        return .error("schedules must be an array")
    }
    guard raw["usage"] is [String: Any] else {
        return .error("usage is required")
    }
    guard raw["artifacts"] is [[String: Any]] else {
        return .error("artifacts must be an array")
    }
    guard raw["warnings"] is [[String: Any]] else {
        return .error("warnings must be an array")
    }
    guard raw["recovery"] is [String: Any] else {
        return .error("recovery is required")
    }
    // Collection size bounds
    let maxColl = HostProtocolConstants.maxCollection
    if let arr = raw["workspaces"] as? [Any], arr.count > maxColl { return .error("workspaces exceeds max collection") }
    if let arr = raw["threads"] as? [Any], arr.count > maxColl { return .error("threads exceeds max collection") }
    if let arr = raw["runs"] as? [Any], arr.count > maxColl { return .error("runs exceeds max collection") }
    if let arr = raw["missions"] as? [Any], arr.count > maxColl { return .error("missions exceeds max collection") }
    if let arr = raw["rounds"] as? [Any], arr.count > maxColl { return .error("rounds exceeds max collection") }
    if let arr = raw["participants"] as? [Any], arr.count > maxColl { return .error("participants exceeds max collection") }
    if let arr = raw["providers"] as? [Any], arr.count > maxColl { return .error("providers exceeds max collection") }
    if let arr = raw["questions"] as? [Any], arr.count > maxColl { return .error("questions exceeds max collection") }
    if let arr = raw["approvals"] as? [Any], arr.count > maxColl { return .error("approvals exceeds max collection") }
    if let arr = raw["schedules"] as? [Any], arr.count > maxColl { return .error("schedules exceeds max collection") }
    if let arr = raw["artifacts"] as? [Any], arr.count > maxColl { return .error("artifacts exceeds max collection") }
    if let arr = raw["warnings"] as? [Any], arr.count > maxColl { return .error("warnings exceeds max collection") }
    if let participants = raw["participants"] as? [[String: Any]] {
        for (index, participant) in participants.enumerated() {
            guard let threadId = participant["threadId"] as? String,
                  let participantId = participant["id"] as? String
            else {
                return .error("participants[\(index)] threadId/id is required")
            }
            guard case .ok = encodeHostParticipantEntityId(
                threadId: threadId, participantId: participantId)
            else {
                return .error("participants[\(index)] identity is invalid")
            }
        }
    }
    // Now do full Codable decode
    do {
        let snapshot = try decoder.decode(HostSnapshot.self, from: data)
        return .ok(snapshot)
    } catch {
        return .error("snapshot decode failed: \(error.localizedDescription)")
    }
}

/// Fail-closed BootstrapWelcome decode.
public func decodeHostBootstrapWelcome(from data: Data) -> HostDecodeResult<HostBootstrapWelcome> {
    guard let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return .error("welcome must be a JSON object")
    }
    guard let type = raw["type"] as? String, type == "host.welcome" else {
        return .error("type must be host.welcome")
    }
    guard let pv = raw["protocolVersion"] as? Int,
          pv == HostProtocolConstants.protocolVersion else {
        return .error("unsupported protocol version")
    }
    guard let projV = raw["projectionVersion"] as? Int,
          projV == HostProtocolConstants.projectionVersion else {
        return .error("unsupported projection version")
    }
    do {
        let welcome = try JSONDecoder().decode(HostBootstrapWelcome.self, from: data)
        return .ok(welcome)
    } catch {
        return .error("welcome decode failed: \(error.localizedDescription)")
    }
}

/// Fail-closed BootstrapHello decode.
public func decodeHostBootstrapHello(from data: Data) -> HostDecodeResult<HostBootstrapHello> {
    guard let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return .error("hello must be a JSON object")
    }
    guard let type = raw["type"] as? String, type == "host.hello" else {
        return .error("type must be host.hello")
    }
    guard let pv = raw["protocolVersion"] as? Int,
          pv == HostProtocolConstants.protocolVersion else {
        return .error("unsupported protocol version")
    }
    do {
        let hello = try JSONDecoder().decode(HostBootstrapHello.self, from: data)
        return .ok(hello)
    } catch {
        return .error("hello decode failed: \(error.localizedDescription)")
    }
}

/// Fail-closed HostCommand decode.
public func decodeHostCommand(from data: Data) -> HostDecodeResult<HostCommand> {
    guard let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return .error("command must be a JSON object")
    }
    guard let type = raw["type"] as? String, type == "host.command" else {
        return .error("type must be host.command")
    }
    guard let pv = raw["protocolVersion"] as? Int,
          pv == HostProtocolConstants.protocolVersion else {
        return .error("unsupported protocol version")
    }
    guard let cmdId = raw["commandId"] as? String,
          !cmdId.isEmpty, cmdId.count <= HostProtocolConstants.maxID else {
        return .error("commandId is required and bounded")
    }
    guard let idempKey = raw["idempotencyKey"] as? String,
          !idempKey.isEmpty, idempKey.count <= HostProtocolConstants.maxID else {
        return .error("idempotencyKey is required and bounded")
    }
    do {
        let command = try JSONDecoder().decode(HostCommand.self, from: data)
        return .ok(command)
    } catch {
        return .error("command decode failed: \(error.localizedDescription)")
    }
}

/// Fail-closed receipt decode.
public func decodeHostCommandReceipt(from data: Data) -> HostDecodeResult<HostCommandReceipt> {
    guard let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return .error("receipt must be a JSON object")
    }
    guard let type = raw["type"] as? String, type == "host.receipt" else {
        return .error("type must be host.receipt")
    }
    guard let pv = raw["protocolVersion"] as? Int,
          pv == HostProtocolConstants.protocolVersion else {
        return .error("unsupported protocol version")
    }
    guard let fp = raw["commandFingerprint"] as? String,
          normalizeHostCommandFingerprint(fp) != nil else {
        return .error("commandFingerprint must be lowercase SHA-256 hex")
    }
    do {
        let receipt = try JSONDecoder().decode(HostCommandReceipt.self, from: data)
        return .ok(receipt)
    } catch {
        return .error("receipt decode failed: \(error.localizedDescription)")
    }
}

/// Empty compact snapshot skeleton for fixtures / harnesses.
public func createEmptyHostSnapshot(
    generation: HostGeneration, cursor: HostCursor,
    freshness: HostProjectionFreshness = .live,
    generatedAt: String? = nil
) -> HostSnapshot {
    let now = generatedAt ?? ISO8601DateFormatter().string(from: Date())
    return HostSnapshot(
        protocolVersion: HostProtocolConstants.protocolVersion,
        projectionVersion: HostProtocolConstants.projectionVersion,
        generatedAt: now,
        generation: generation,
        cursor: cursor,
        freshness: freshness,
        health: HostHealthProjection(
            hostStatus: .ok, connectionPhase: .live,
            supervised: true, freshness: freshness),
        workspaces: [], threads: [], runs: [], missions: [], rounds: [],
        participants: [], providers: [],
        routing: nil, questions: [], approvals: [], schedules: [],
        usage: HostUsageObservation(availability: .unavailable),
        artifacts: [], warnings: [],
        recovery: HostRecoveryProjection(reopenStatus: .clean)
    )
}
