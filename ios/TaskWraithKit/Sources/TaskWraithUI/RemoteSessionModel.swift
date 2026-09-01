// RemoteSessionModel — the observable bridge between the SwiftUI views and the
// proven RelayTransportClient. Owns the phone's persisted identity, drives
// pairing (QR/paste → connect → established), decodes the projection snapshot
// into renderable cards, and sends actions. All UI-facing state is @Published on
// the main actor; the transport runs on its own actor and feeds this via its
// AsyncStream of events.

import Foundation
import CryptoKit
import Network
import TaskWraithKit

#if canImport(WidgetKit)
    import WidgetKit
#endif
#if canImport(UIKit)
    import UIKit
    import UserNotifications
#endif

/// Where the phone persists its long-lived Ed25519 identity seed. The iOS app
/// supplies a Keychain-backed implementation; a file-backed default keeps the
/// model usable on macOS for previews + compile-checking.
///
/// Security review (residual MED, fixed): an EXISTING identity that can't be
/// read must surface as an error — silently minting a replacement broke the
/// Mac's pin with no explanation and masked tampering. Implementations only
/// generate when storage reports the identity genuinely absent.
public protocol IdentitySeedStore: Sendable {
    func loadOrCreateSeed() throws -> Data
}

public enum IdentitySeedStoreError: LocalizedError {
    /// The identity exists but can't be read (locked/failed keychain,
    /// corrupt record). Never silently replaced.
    case readFailed(String)
    /// A fresh identity couldn't be durably persisted — proceeding would
    /// break the pairing on the next launch instead of now.
    case persistFailed(String)

    public var errorDescription: String? {
        switch self {
        case .readFailed(let detail):
            return "This device's identity key exists but can't be read (\(detail))."
        case .persistFailed(let detail):
            return "A new identity key couldn't be saved (\(detail))."
        }
    }
}

public struct FileIdentitySeedStore: IdentitySeedStore {
    let url: URL
    public init(url: URL) { self.url = url }
    public func loadOrCreateSeed() throws -> Data {
        if FileManager.default.fileExists(atPath: url.path) {
            let data: Data
            do {
                data = try Data(contentsOf: url)
            } catch {
                throw IdentitySeedStoreError.readFailed(error.localizedDescription)
            }
            guard data.count == 32 else {
                throw IdentitySeedStoreError.readFailed("corrupt seed (\(data.count) bytes)")
            }
            return data
        }
        let seed = Curve25519.Signing.PrivateKey().rawRepresentation
        do {
            try seed.write(to: url, options: [.atomic])
        } catch {
            throw IdentitySeedStoreError.persistFailed(error.localizedDescription)
        }
        return seed
    }
}

public enum SessionPhase: Equatable, Sendable {
    case idle
    case connecting
    /// Handshake reached the confirm code; the user compares it with the Mac and
    /// taps "Pair" ON THE MAC (the phone just waits to become established).
    case awaitingMacConfirm(code: String)
    case connected
    case error(String)
}

/// Fully typed form of a full projection snapshot. The relay payload is decoded
/// directly into this batch on a detached task, so the MainActor never has to
/// re-parse each envelope's `RawJSON` payload during first-connect hydration.
struct DecodedProjectionSnapshot: Decodable, Sendable {
    let projections: [DecodedProjection]

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        projections = try container.decode([DecodedProjection].self, forKey: .projections)
    }

    init(_ snapshot: RemoteProjectionSnapshot) {
        projections = snapshot.projections.map(DecodedProjection.init)
    }

    init(projections: [DecodedProjection]) {
        self.projections = projections
    }

    private enum CodingKeys: String, CodingKey {
        case projections
    }
}

enum DecodedProjection: Decodable, Sendable {
    case taskCard(
        RemoteTaskCard, embedded: EmbeddedTaskCardMetadata?, envelopeThreadId: String?)
    case workflow(RemoteWorkflow)
    case workspaceBoard(RemoteWorkspaceBoard)
    case ensemblePreset(RemoteEnsemblePreset)
    case approval(MobileApprovalCard)
    case question(MobileQuestionCard)
    case threadSnapshot(RemoteThreadSnapshot, fallbackKey: String?)
    case ensembleState(RemoteEnsembleState, envelopeThreadId: String?)
    case diffSummary(MobileDiffSummary, envelopeThreadId: String?)
    case gitSnapshot(GitWorkspaceSnapshot, workspaceId: String)
    case shellAppearance(TWRemoteShellAppearance)
    case ignored

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = (try? container.decode(String.self, forKey: .kind)) ?? ""
        let threadId = try? container.decode(String.self, forKey: .threadId)
        let workspaceId = try? container.decode(String.self, forKey: .workspaceId)

        switch kind {
        case "taskCard":
            guard let card = try? container.decode(RemoteTaskCard.self, forKey: .payload) else {
                self = .ignored
                return
            }
            let embedded = try? container.decode(
                EmbeddedTaskCardMetadata.self, forKey: .payload)
            self = .taskCard(card, embedded: embedded, envelopeThreadId: threadId)
        case "workflows":
            self = Self.decode(RemoteWorkflow.self, from: container).map(Self.workflow) ?? .ignored
        case "workspaceBoards":
            self = Self.decode(RemoteWorkspaceBoard.self, from: container).map(Self.workspaceBoard)
                ?? .ignored
        case "ensemblePresets":
            self = Self.decode(RemoteEnsemblePreset.self, from: container).map(Self.ensemblePreset)
                ?? .ignored
        case "approvalCard":
            self = Self.decode(MobileApprovalCard.self, from: container).map(Self.approval)
                ?? .ignored
        case "questionCard":
            self = Self.decode(MobileQuestionCard.self, from: container).map(Self.question)
                ?? .ignored
        case "threadSnapshot":
            guard let snapshot = try? container.decode(
                RemoteThreadSnapshot.self, forKey: .payload)
            else {
                self = .ignored
                return
            }
            self = .threadSnapshot(
                snapshot, fallbackKey: snapshot.taskId ?? snapshot.threadId ?? threadId)
        case "ensembleState":
            guard let state = try? container.decode(RemoteEnsembleState.self, forKey: .payload)
            else {
                self = .ignored
                return
            }
            self = .ensembleState(state, envelopeThreadId: threadId)
        case "diffSummary":
            guard let diff = try? container.decode(MobileDiffSummary.self, forKey: .payload) else {
                self = .ignored
                return
            }
            self = .diffSummary(diff, envelopeThreadId: threadId)
        case "gitSnapshot":
            guard let workspaceId,
                let git = try? container.decode(GitWorkspaceSnapshot.self, forKey: .payload)
            else {
                self = .ignored
                return
            }
            self = .gitSnapshot(git, workspaceId: workspaceId)
        case "shellAppearance":
            self = Self.decode(TWRemoteShellAppearance.self, from: container)
                .map(Self.shellAppearance) ?? .ignored
        default:
            self = .ignored
        }
    }

    init(_ envelope: RemoteProjectionEnvelope) {
        switch envelope.kind {
        case "taskCard":
            guard let card = envelope.decodePayload(RemoteTaskCard.self) else {
                self = .ignored
                return
            }
            self = .taskCard(
                card,
                embedded: envelope.decodePayload(EmbeddedTaskCardMetadata.self),
                envelopeThreadId: envelope.threadId)
        case "workflows":
            self = envelope.decodePayload(RemoteWorkflow.self).map(Self.workflow) ?? .ignored
        case "workspaceBoards":
            self = envelope.decodePayload(RemoteWorkspaceBoard.self).map(Self.workspaceBoard)
                ?? .ignored
        case "ensemblePresets":
            self = envelope.decodePayload(RemoteEnsemblePreset.self).map(Self.ensemblePreset)
                ?? .ignored
        case "approvalCard":
            self = envelope.decodePayload(MobileApprovalCard.self).map(Self.approval) ?? .ignored
        case "questionCard":
            self = envelope.decodePayload(MobileQuestionCard.self).map(Self.question) ?? .ignored
        case "threadSnapshot":
            guard let snapshot = envelope.decodePayload(RemoteThreadSnapshot.self) else {
                self = .ignored
                return
            }
            self = .threadSnapshot(
                snapshot,
                fallbackKey: snapshot.taskId ?? snapshot.threadId ?? envelope.threadId)
        case "ensembleState":
            guard let state = envelope.decodePayload(RemoteEnsembleState.self) else {
                self = .ignored
                return
            }
            self = .ensembleState(state, envelopeThreadId: envelope.threadId)
        case "diffSummary":
            guard let diff = envelope.decodePayload(MobileDiffSummary.self) else {
                self = .ignored
                return
            }
            self = .diffSummary(diff, envelopeThreadId: envelope.threadId)
        case "gitSnapshot":
            guard let workspaceId = envelope.workspaceId,
                let git = envelope.decodePayload(GitWorkspaceSnapshot.self)
            else {
                self = .ignored
                return
            }
            self = .gitSnapshot(git, workspaceId: workspaceId)
        case "shellAppearance":
            self = envelope.decodePayload(TWRemoteShellAppearance.self).map(Self.shellAppearance)
                ?? .ignored
        default:
            self = .ignored
        }
    }

    private static func decode<T: Decodable>(
        _ type: T.Type,
        from container: KeyedDecodingContainer<CodingKeys>
    ) -> T? {
        try? container.decode(type, forKey: .payload)
    }

    private enum CodingKeys: String, CodingKey {
        case kind
        case workspaceId
        case threadId
        case payload
    }
}

struct EmbeddedTaskCardMetadata: Decodable, Sendable {
    let ensembleState: RemoteEnsembleState?
    let diffSummary: MobileDiffSummary?
}

/// Wrapper used by the oversized-snapshot fallback. New hosts add the three
/// batch fields; old hosts and ordinary low-latency pushes omit them.
struct DecodedProjectionMessage: Decodable, Sendable {
    let envelope: DecodedProjection
    let snapshotBatchId: String?
    let snapshotIndex: Int?
    let snapshotCount: Int?
}

/// Reassembles explicitly identified oversized full snapshots without ever
/// holding their raw JSON on the MainActor. Duplicate indices are idempotent;
/// incomplete batches can be drained as ordered incremental updates at an
/// event-stream barrier so a malformed/old host cannot block later run events.
struct ProjectionSnapshotBatchAssembler {
    enum IngestResult {
        case incremental(DecodedProjection)
        case waiting
        case complete(DecodedProjectionSnapshot)
    }

    private struct PendingBatch {
        let count: Int
        let order: Int
        var projectionsByIndex: [Int: DecodedProjection]
    }

    private var pendingById: [String: PendingBatch] = [:]
    private var nextOrder = 0
    private var completedIds: Set<String> = []
    private var completedOrder: [String] = []
    private static let completedIdLimit = 8

    mutating func ingest(_ message: DecodedProjectionMessage) -> IngestResult {
        guard let id = message.snapshotBatchId, !id.isEmpty,
            let index = message.snapshotIndex,
            let count = message.snapshotCount,
            count > 0, index >= 0, index < count
        else {
            return .incremental(message.envelope)
        }
        guard !completedIds.contains(id) else { return .waiting }

        if pendingById[id]?.count != count {
            pendingById[id] = PendingBatch(
                count: count, order: nextOrder, projectionsByIndex: [:])
            nextOrder += 1
        }
        pendingById[id]?.projectionsByIndex[index] = message.envelope
        guard let pending = pendingById[id], pending.projectionsByIndex.count == count else {
            return .waiting
        }

        pendingById[id] = nil
        rememberCompleted(id)
        let projections = (0..<count).compactMap { pending.projectionsByIndex[$0] }
        guard projections.count == count else { return .waiting }
        return .complete(DecodedProjectionSnapshot(projections: projections))
    }

    mutating func drainIncomplete() -> [DecodedProjection] {
        let projections = pendingById.values
            .sorted { $0.order < $1.order }
            .flatMap { pending in
                pending.projectionsByIndex.keys.sorted().compactMap {
                    pending.projectionsByIndex[$0]
                }
            }
        pendingById.removeAll(keepingCapacity: true)
        return projections
    }

    mutating func reset() {
        pendingById.removeAll()
        nextOrder = 0
        completedIds.removeAll()
        completedOrder.removeAll()
    }

    private mutating func rememberCompleted(_ id: String) {
        completedIds.insert(id)
        completedOrder.append(id)
        if completedOrder.count > Self.completedIdLimit {
            completedIds.remove(completedOrder.removeFirst())
        }
    }
}

// ── Paired-host persistence ─────────────────────────────────────────────────
// After the first pairing the phone remembers WHO it paired with so app
// relaunches and host restarts reconnect silently via the relay's resolve
// directory (each host pins this phone's identity and accepts without a
// prompt). This is PUBLIC material only — each host's identity public key,
// relay URLs, display name; the phone's private identity seed stays in the
// Keychain via IdentitySeedStore and is the SAME single seed for every host.
//
// The phone can pair with MANY hosts. The record/store/migration types live in
// TaskWraithKit (PairedHostStore.swift) — a pure, exhaustively-tested keyed
// collection (PairedHostRecord / PairedHostsDocument / PairedHostStore) that
// mirrors the Mac bridge's v2 RemotePairingStore. `selectedHostId` is the
// active host this model is connected to / showing.

/// Persists the sidebar expand/collapse layout across launches. The sets stay
/// @Published on RemoteSessionModel for live SwiftUI updates; this just mirrors
/// them to UserDefaults so the user's adjustments — and the first-launch iPad
/// collapse-to-headers — survive a relaunch.
enum TWSidebarPersistence {
    enum Key: String {
        case expandedWorkspaces = "tw.sidebar.expandedWorkspaces"
        case collapsedSections = "tw.sidebar.collapsedSections"
        case collapsedParents = "tw.sidebar.collapsedParents"
    }
    static func load(_ key: Key) -> Set<String> {
        Set(UserDefaults.standard.stringArray(forKey: key.rawValue) ?? [])
    }
    static func save(_ value: Set<String>, _ key: Key) {
        UserDefaults.standard.set(Array(value), forKey: key.rawValue)
    }
}

/// Invalidation-coalesce gate for streaming `@Published` dict writes (pass-4 S3).
/// Parse-per-event stays in `appendStreamingDeltas`; this bounds SwiftUI churn.
@MainActor
final class StreamingPublishGate {
    static let streamingPublishCoalesceWindowNs: UInt64 = 80_000_000

    struct Staging: Equatable {
        var segments: [String]
        var provider: String?
        var runId: String?
        var itemId: String?
    }

    enum PublishMode {
        case coalescedIfBurst
        case immediate
    }

    private var stagingByThread: [String: Staging] = [:]
    private var armedThreads: Set<String> = []
    private var flushTasks: [String: Task<Void, Never>] = [:]
    private var onPublish: ((String, Staging) -> Void)?

    private(set) var publishInvocationCount = 0

    func bind(onPublish: @escaping (String, Staging) -> Void) {
        self.onPublish = onPublish
    }

    func staging(
        for threadId: String,
        fallbackSegments: [String],
        fallbackProvider: String?,
        fallbackRunId: String?,
        fallbackItemId: String?
    ) -> Staging {
        stagingByThread[threadId]
            ?? Staging(
                segments: fallbackSegments,
                provider: fallbackProvider,
                runId: fallbackRunId,
                itemId: fallbackItemId)
    }

    func setStaging(_ staging: Staging, for threadId: String, mode: PublishMode) {
        stagingByThread[threadId] = staging
        switch mode {
        case .coalescedIfBurst:
            if !armedThreads.contains(threadId) {
                publish(threadId)
                armedThreads.insert(threadId)
                scheduleFlush(threadId)
            }
        case .immediate:
            cancelFlush(threadId)
            armedThreads.remove(threadId)
            publish(threadId)
        }
    }

    /// Exit-contract: flush staged text before terminal capture; cancel armed window.
    func flushBeforeTerminal(threadId: String) {
        cancelFlush(threadId)
        armedThreads.remove(threadId)
        publish(threadId)
    }

    func reset(threadId: String) {
        cancelFlush(threadId)
        armedThreads.remove(threadId)
        stagingByThread.removeValue(forKey: threadId)
    }

    func resetAll() {
        flushTasks.values.forEach { $0.cancel() }
        flushTasks.removeAll()
        armedThreads.removeAll()
        stagingByThread.removeAll()
    }

    #if DEBUG
        func waitForScheduledFlushForTesting(threadId: String) async {
            await flushTasks[threadId]?.value
        }
    #endif

    private func publish(_ threadId: String) {
        guard let staging = stagingByThread[threadId] else { return }
        publishInvocationCount += 1
        onPublish?(threadId, staging)
    }

    private func scheduleFlush(_ threadId: String) {
        cancelFlush(threadId)
        flushTasks[threadId] = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: Self.streamingPublishCoalesceWindowNs)
            guard !Task.isCancelled, let self else { return }
            self.armedThreads.remove(threadId)
            self.flushTasks.removeValue(forKey: threadId)
            self.publish(threadId)
        }
    }

    private func cancelFlush(_ threadId: String) {
        flushTasks[threadId]?.cancel()
        flushTasks.removeValue(forKey: threadId)
    }
}

public enum CompletionPushGatewayStatus: Equatable, Sendable {
    case directOnly
    case registering(totalHosts: Int)
    case registered(hosts: Int)
    case optedOut(hosts: Int)
    case partial(registered: Int, total: Int, enabled: Bool)
    case failed
}

@MainActor
public final class RemoteSessionModel: ObservableObject {
    private static let notifyFinishedTurnsDefaultsKey =
        "taskwraith.notifications.finishedTurns.projectGateway.v1"
    @Published public private(set) var phase: SessionPhase = .idle
    /// True while the offline DEMO session is showing (App Review / first-look):
    /// no network client, canned data, inert actions. Drives the demo banner.
    @Published public private(set) var isDemo = false
    @Published public private(set) var macDisplayName: String = ""
    @Published public private(set) var taskCards: [RemoteTaskCard] = [] {
        didSet {
            handleTaskCardCompletionTransitions(previous: oldValue)
            syncRunActivities()
            flushPendingThreadSnapshotRequests()
        }
    }
    @Published public private(set) var approvals: [MobileApprovalCard] = []
    @Published public private(set) var questions: [MobileQuestionCard] = []
    /// Ids the user just acted on locally — suppressed from re-display until the
    /// Mac's projection confirms resolution (drops them). Without this the
    /// modal lingered after Accept: the card is only cleared by the next
    /// authoritative snapshot, and a snapshot already in flight when the user
    /// taps would otherwise flash the resolved card straight back.
    private var repliedApprovalToolCallIds: Set<String> = []
    private var repliedQuestionIds: Set<String> = []

    /// True while this device has answered a question but the Mac has not yet
    /// projected the answer back.
    ///
    /// The settled card needs it: the registry drops a question OPTIMISTICALLY on
    /// reply, so for the round-trip window there is no live card AND no projected
    /// answer — and a card that assumed "no answer means skipped" would flash
    /// "Skipped — no answer sent" over an answer the user just gave. A query
    /// method rather than exposing the set, so the only new surface is a read.
    public func hasPendingLocalQuestionReply(_ questionId: String) -> Bool {
        repliedQuestionIds.contains(questionId)
    }
    private static let threadTitleMaxCharacters = 160
    private static let pendingThreadTitleRenameTTL: TimeInterval = 60
    private struct PendingThreadTitleRename {
        let title: String
        let startedAt: Date
    }
    private var pendingThreadTitleRenames: [String: PendingThreadTitleRename] = [:]
    /// Plan messageIds the user just acted on (approve/respond/dismiss), keyed on
    /// the transcript row id (a proposed plan parks NO tool-call, so this can't
    /// reuse repliedApprovalToolCallIds). Unlike approvals/questions — which
    /// re-render by removal from the @Published `approvals`/`questions` arrays —
    /// a plan card stays in the transcript, so this set must be @Published to
    /// drive the action row's disabled state until the Mac's status re-projection
    /// lands. Restored in onAck on `!accepted` so a denied decision re-enables it.
    // `public private(set)`: setter stays internal, but the projected publisher
    // must be observable by ThreadTranscriptStore's re-render gate.
    @Published public private(set) var repliedProposedPlanIds: Set<String> = []
    /// Every Mac-registered workspace (the compose surface). Ungranted entries
    /// are redacted consent stubs with `remoteAccessGranted == false`.
    @Published public private(set) var workspaces: [WorkspaceSummary] = []
    /// Host-authoritative deny wall learned from registered workspace stubs.
    /// Once a workspace is denied, delayed/coalesced projections for it are
    /// discarded until a later workspace-list grant (or grant ack) reopens it.
    private var deniedRemoteWorkspaceIds: Set<String> = []
    /// Thread aliases retained only as revocation tombstones. The readable
    /// threadWorkspaceHints cache is purged, but these ids let us reject a late
    /// ensemble/diff/run-event projection that carries no workspace id itself.
    private var revokedThreadWorkspaceHints: [String: String] = [:]
    /// Task-card ids currently synthesized from `bridge.broadcastThreadList`.
    /// Cleared when an authoritative projection snapshot replaces them.
    private var fallbackThreadListCardIds: Set<String> = []
    /// Scheduled / recurring workflows projected from the Mac (sidebar
    /// "Workflows" section). Tapping opens the workflow's chat; pause/resume
    /// and run-now dispatch via `setWorkflowEnabled` / `runWorkflowNow` with
    /// an optimistic flip reconciled by the ack + the Mac's re-broadcast.
    /// One `workflows` envelope per workflow, like `taskCard`.
    @Published public private(set) var workflows: [RemoteWorkflow] = []
    /// Workspace Boards projected from the Mac. Read-only on the phone for now;
    /// the Mac and agent MCP surface remain the write authority.
    @Published public private(set) var workspaceBoards: [RemoteWorkspaceBoard] = []
    /// Saved ensemble roster presets projected from the Mac (iOS Roster page's
    /// "Load preset"). GLOBAL; one `ensemblePresets` envelope per preset.
    @Published public private(set) var ensemblePresets: [RemoteEnsemblePreset] = []
    /// Latest thread snapshot per taskId/threadId (drives the detail view).
    @Published public private(set) var threadSnapshots: [String: RemoteThreadSnapshot] = [:]
    /// Run summaries the phone hid when the user sent a follow-up turn. The Mac
    /// may continue projecting old terminal summaries until the next run
    /// finishes, so filter those exact old summaries out of later snapshots.
    private var hiddenRunSummaryFingerprintsByThread: [String: Set<String>] = [:]
    /// Per-provider model catalogs (same source as the desktop picker) —
    /// arrives shortly after establish; empty until then.
    @Published public private(set) var providerModels: [String: [ModelOption]] = [:]
    /// Token totals for the heatmap chips (24h/7d/90d, per provider).
    @Published public private(set) var usageRollup: UsageRollupMessage.Rollup? = nil
    /// 90-day daily token series for the Inspector bar charts (Issue 4). Ride
    /// the usage-rollup broadcast alongside `usageRollup`.
    @Published public private(set) var taskwraithTokenDaily: DailyTokenSeries? = nil
    @Published public private(set) var externalTokenDaily: DailyTokenSeries? = nil
    /// Per-provider quota windows (Usage tab; desktop sidebar parity).
    @Published public private(set) var modelUsage: ModelUsageMessage.Usage? = nil
    /// The Electron welcome stats dashboard (Statistics / Models / Workspaces /
    /// Providers). Rides the usage-rollup cadence; nil until the first push.
    @Published public private(set) var welcomeDashboard: WelcomeDashboard? = nil
    /// Redacted Mac-authored first-launch orientation state. Cleared on host
    /// switch/demo exit so provider/readiness data never bleeds between Macs.
    @Published public private(set) var firstLaunchState: FirstLaunchState? = nil
    /// Token-level live text per thread, accumulated from bridge.runEvent
    /// content deltas — renders as the growing assistant bubble between
    /// snapshot pushes. Cleared when the run exits (the final snapshot row
    /// supersedes it).
    @Published public private(set) var streamingTexts: [String: String] = [:]
    /// The live text SPLIT at tool boundaries — element k is the text between
    /// tool call k-1 and tool call k, the last element is the growing tail.
    /// The transcript view interleaves these with the run's tool rows so the
    /// streaming order matches the finished transcript (tool cards between
    /// paragraphs, not clumped above one bubble). `streamingTexts` stays the
    /// joined mirror for single-bubble surfaces (side-chat mini window) and
    /// scroll triggers.
    @Published public private(set) var streamingSegments: [String: [String]] = [:]
    /// Live run id per streaming thread — lets the view hide the in-flight
    /// snapshot row the bubble supersedes.
    @Published public private(set) var streamingRunIds: [String: String] = [:]
    /// Threads whose stream hit its terminal event (agent-exit) but whose live
    /// bubble is still on screen inside the deferred-clear handoff window. The
    /// reveal cursor reads this to DRAIN (advanceReveal isComplete — converges
    /// within completeDrainMs) instead of continuing at streaming cadence, so
    /// the settled snapshot never swaps in over a half-typed tail. Membership
    /// ends when new tokens publish (next run on the thread), when the deferred
    /// exit clear or snapshot reconcile drops the stream, and on the canonical
    /// per-host reset.
    @Published public private(set) var streamingTerminalThreads: Set<String> = []
    /// Provider currently producing each live stream. This comes from the
    /// bridge.runEvent envelope and updates before the next snapshot/ensemble
    /// state pull, so live headers do not briefly show the previous speaker.
    @Published public private(set) var streamingProviders: [String: String] = [:]
    /// Last Codex item id appended to each thread's live bubble — an item
    /// transition gets a paragraph break so bursts don't jam ("…ops.The
    /// first shell…"). Not published: render state derives from the text.
    private var streamingItemIds: [String: String] = [:]
    /// Coalesces `@Published` streaming dict writes during token bursts (S3).
    private let streamingPublishGate = StreamingPublishGate()
    /// Live ensemble round state per thread (desktop roster-chip parity).
    @Published public private(set) var ensembleStates: [String: RemoteEnsembleState] = [:] {
        didSet { syncRunActivities() }
    }
    /// Latest run diff summary per thread (inspector diff tab + changes row).
    /// Drives the Live Activity's ± counts, which is why it re-syncs: a diff can
    /// change without the card changing, and the heartbeat only re-pushes the
    /// state it already has.
    @Published public private(set) var diffSummaries: [String: MobileDiffSummary] = [:] {
        didSet { syncRunActivities() }
    }
    /// Git status snapshots keyed by workspace id. Composer rows use this for
    /// branch/upstream/worktree parity with the desktop native composer.
    @Published public private(set) var gitSnapshots: [String: GitWorkspaceSnapshot] = [:] {
        didSet { syncRunActivities() }
    }
    /// Latest composer shellAppearance projected by the Mac (drives the
    /// "Follow Mac" composer style); stale re-broadcasts ignored via generatedAt.
    @Published public private(set) var projectedShellAppearance: TWRemoteShellAppearance?
    /// generatedAt of the last applied shellAppearance — the staleness gate.
    private var lastShellAppearanceGeneratedAt: String?
    /// The Mac-projected composer style (nil until the first shellAppearance).
    public var projectedComposerStyle: TWComposerStyle? { projectedShellAppearance?.style }
    /// Display name projected from the Mac for the General-chat greeting
    /// (nil / empty = no name; the greeting then shows just the time-of-day).
    public var projectedUserName: String? { projectedShellAppearance?.userName }
    @Published public private(set) var lastActionMessage: String?
    nonisolated static let hostUnavailableActionMessage =
        "Your Mac isn't responding. Wake it, then retry; your synced threads are still available."
    /// Set after createThread succeeds — HomeView navigates to the new chat.
    @Published public var navigationTarget: String?
    /// The chat the user has open (sidebar selection / pushed thread), plus the
    /// sidebar's expand/collapse layout. Hoisted onto the model so they SURVIVE
    /// the theme-revision view teardown: TWThemeStore bumps `revision` on any
    /// settings change and RootView keys `.id(revision)` (TWTheme tokens are
    /// computed statics, so the rebuild is how they re-read) — which would
    /// otherwise drop the open chat + reset the sidebar. `selectedTaskId` drives
    /// the iPad detail column and the iPhone `navigationDestination(item:)`.
    @Published public var selectedTaskId: String? {
        didSet {
            // Only a real change counts. This is the ONLY signal that
            // distinguishes "the user opened a thread" from "SwiftUI rebuilt
            // the thread view": both run ThreadDetailView's arming `.task`,
            // and only the former should snap the transcript to the tail.
            guard oldValue != selectedTaskId else { return }
            threadSelectionGeneration &+= 1
        }
    }
    /// Advances whenever the selected thread changes. Consumed by
    /// `TranscriptFollowStateStore.shouldArmOnOpen` so a remount cannot be
    /// mistaken for an open.
    public private(set) var threadSelectionGeneration = 0
    /// The side chat opened inline in a thread's "Side chats" inspector tab,
    /// keyed by PARENT thread. Hoisted onto the model for the same reason as
    /// `selectedTaskId`: `SideChatsPanel` held it in `@State`, and both the
    /// `switch model.phase` branches and RootView's `.id(themes.revision)`
    /// rebuild the shell as a new identity — so a reconnect, or any settings
    /// change, closed the open side chat back to the list.
    ///
    /// Keyed rather than single-valued because the panel is per-thread. One
    /// global slot would follow the user to the next thread, where
    /// `selectedSideChatCard` rejects it as a non-child and the panel sits on
    /// its "Opening side chat…" spinner for a thread nobody is loading.
    ///
    /// Known limitation of the durability: a side chat that disappears while
    /// its parent survives (deleted on the Mac) leaves the panel on that same
    /// spinner until the user backs out, where the old `@State` forgot it at
    /// the next rebuild. A snapshot request for a missing thread acks with no
    /// thread rather than an error, so nothing here separates "gone" from
    /// "still loading" and a timeout would be a guess.
    @Published public var selectedSideChatByThread: [String: String] = [:]
    // Sidebar layout — persisted across launches (see TWSidebarPersistence). The
    // paren-wrapped initializer disambiguates the didSet block from a trailing
    // closure on `load(_:)`.
    @Published public var expandedWorkspaces: Set<String> = (TWSidebarPersistence.load(.expandedWorkspaces)) {
        didSet { TWSidebarPersistence.save(expandedWorkspaces, .expandedWorkspaces) }
    }
    @Published public var collapsedSections: Set<String> = (TWSidebarPersistence.load(.collapsedSections)) {
        didSet { TWSidebarPersistence.save(collapsedSections, .collapsedSections) }
    }
    @Published public var collapsedParents: Set<String> = (TWSidebarPersistence.load(.collapsedParents)) {
        didSet { TWSidebarPersistence.save(collapsedParents, .collapsedParents) }
    }
    /// Settings sheet presentation — hoisted so a theme/composer/font change
    /// made inside it doesn't tear the sheet down with the rest of the tree.
    /// Presented from RootView (above the `.id(revision)` boundary); the sheet
    /// re-themes live via its own `@ObservedObject themes`.
    @Published public var settingsPresented = false
    /// Presented from RootView alongside settings, but root-owned so it can open
    /// after pairing/demo without being torn down by theme revision rebuilds.
    @Published public var firstLaunchSheetPresented = false
    /// Deep-link target captured from a notification tap before the session is
    /// established (cold launch); applied to navigationTarget on `.established`.
    private var pendingDeepLinkThreadId: String?
    /// Set by a content-bearing wake (`notification-tap` / foreground / resume)
    /// so `.established` from that walk rehydrates instead of waiting for the
    /// Mac to push an unsolicited snapshot. Cleared when consumed or when the
    /// already-alive path rehydrates itself.
    private var pendingWakeRehydrate = false
    /// Slice 5 (RC4): per-thread wake generation. A notification tap / foreground
    /// bumps the target thread's counter; the detail view refetches a cached-but-
    /// stale transcript when the generation advances past what it last applied, so
    /// the user lands on the approval/summary the push pointed at rather than a
    /// pre-event cache. Reset on host switch.
    @Published public private(set) var wakeRefreshGeneration: [String: Int] = [:]
    /// Expanded row bodies keyed by threadId → rowId.
    @Published public private(set) var rowExpansions: [String: [String: RemoteThreadSnapshot.Row]] =
        [:]
    @Published public private(set) var expandingRows: Set<String> = []
    @Published public private(set) var loadingPreviousThreadRows: Set<String> = []

    /// True when an ACTIVE pairing is on disk — drives the "Reconnect" affordance
    /// and launch-time auto-resume. Equivalent to `selectedHostId != nil`.
    @Published public private(set) var hasStoredPairing: Bool
    /// Every paired host (multi-host). The view layer renders this as the host
    /// switcher / paired-hosts list; the active one is `selectedHostId`. Sorted
    /// as persisted (insertion order); `pairedAt` is available for display.
    @Published public private(set) var pairedHosts: [PairedHostRecord] = []
    /// macIdentityPubKey of the host this model is connected to / showing, or
    /// nil when none is paired. Reconnect / resume always target this host.
    @Published public private(set) var selectedHostId: String?
    /// QR-optional discovery (multi-host): OTHER TaskWraith hosts the connected
    /// host ("oracle") found on the tailnet, already deduped against
    /// `pairedHosts`. Populated by `discoverHosts()`; reset on host change.
    @Published public private(set) var discoveredHosts: [DiscoveredHostInfo] = []
    /// True while a `discoverHosts()` enumeration is in flight (drives a spinner).
    @Published public private(set) var isDiscoveringHosts = false
    /// Last discovery failure, surfaced under the search button; nil on success.
    @Published public private(set) var discoveryError: String?
    /// True once a session has established this app launch — drives the
    /// keep-the-shell-during-reconnect behavior (transient drops must NOT
    /// eject the user to the pairing screen).
    @Published public private(set) var wasEverConnected = false
    /// First-connect hydration gate. False until this pairing has either
    /// received real content (workspaces / task cards) or waited out a
    /// short post-establish grace window — views show "Syncing…" tickers
    /// instead of authoritative empty states while it's false. The grace
    /// covers a genuinely empty Mac AND the settling-restart case (the Mac
    /// re-seeds at ~1.5s; 5s leaves margin on a slow relay). Never reset on
    /// transient drops — retained data stays on screen by design.
    @Published public private(set) var projectionHydrated = false
    /// Slice 4 (RC3): true once the post-establish grace window has expired (or
    /// real content arrived). Splits "presumed empty (still loading → spinner +
    /// retry)" from "confirmed empty (setup copy)". Kept DISTINCT from
    /// `projectionHydrated` — which also gates the preset-settling window — so a
    /// slow/asleep Mac can't latch a false confirmed-empty that only force-quit
    /// clears, and so the two concerns don't fight. Reset on host switch.
    @Published public private(set) var projectionGraceExpired = false
    /// The thread currently open in a detail view (nil on home). Used to
    /// re-request its snapshot after a reconnect — it may be outside the
    /// establish broadcast's recent-N window. Drives B2 `setWatchedThread`.
    public var visibleThreadId: String? = nil {
        didSet {
            guard oldValue != visibleThreadId else { return }
            reassertWatchedThreadToHost()
        }
    }
    /// Inspector presentation — hoisted here so the SHELL can attach the
    /// `.inspector` at NavigationStack level (true side-by-side column on
    /// iPad instead of an overlay; sheet on iPhone).
    @Published public var inspectorPresented = false
    /// Per-thread memory of the selected ThreadInspector segment (0=Changes …
    /// 4=Usage). Parity with the desktop right-dock's per-chat surface memory:
    /// each thread reopens its inspector on the segment it was last viewing.
    /// Lives on the model (not @State in the view) so it survives both the
    /// per-thread `.id()` remount AND the theme-revision teardown that wipes
    /// view-local @State — see the iOS theme-revision-teardown note.
    @Published public var inspectorTabByThread: [String: Int] = [:]
    /// Dedicated ensemble Roster page (transcript icon + chip-tap entry).
    /// Ensemble chats only. Replaces the cramped per-chip editor sheet.
    @Published public var rosterPresented = false
    /// When the Roster page opens from a tapped participant chip, auto-open
    /// that participant's detail editor (consumed once on appear, then cleared).
    @Published public var rosterFocusParticipantId: String? = nil
    /// APNs token waiting for an established session (tokens can arrive
    /// before the transport connects on cold launch).
    private var pendingApnsToken: (hex: String, env: String)? = nil
    private var apnsTokenRegistrationInFlight = false
    private var apnsTokenRetryTask: Task<Void, Never>? = nil
    /// Device-wide completion-push preference for the project-operated Tier-2
    /// gateway. Default true preserves the pre-toggle behavior. The signed
    /// registration carries the value, so the relay can enforce it while the
    /// app is force-quit.
    @Published public private(set) var notifyFinishedTurns = true
    @Published public private(set) var completionPushGatewayStatus: CompletionPushGatewayStatus =
        .directOnly
    private var pushGatewayApnsToken: (hex: String, env: String)? = nil
    private var pushGatewayRegistrationTask: Task<Void, Never>? = nil

    /// Whichever env the app delegate last reported. A Live Activity token has
    /// to be registered against the SAME gateway as the device token or the Mac
    /// pushes it to the wrong one and gets BadDeviceToken — the exact trap that
    /// `forceEnv` defaulting to 'production' set on the Mac side.
    private var lastReportedApnsEnv: String?
    private var apnsEnvironment: String {
        if let lastReportedApnsEnv { return lastReportedApnsEnv }
        // An activity can start before the device token arrives, so fall back to
        // the same build-config rule the app delegate uses rather than guessing
        // production (which would strand every sandbox build).
        #if DEBUG
            return "sandbox"
        #else
            return "production"
        #endif
    }

    /// Called by the app delegate when iOS delivers the device token.
    public func handleApnsToken(_ hex: String, env: String) {
        pendingApnsToken = (hex, env)
        pushGatewayApnsToken = (hex, env)
        lastReportedApnsEnv = env
        sendPendingApnsTokenIfReady()
        registerWithProjectPushGatewaysIfReady()
    }

    private func sendPendingApnsTokenIfReady() {
        guard case .connected = phase, client != nil, let token = pendingApnsToken else { return }
        guard !apnsTokenRegistrationInFlight else { return }
        apnsTokenRetryTask?.cancel()
        apnsTokenRetryTask = nil
        apnsTokenRegistrationInFlight = true
        // Publish this device's push-agreement public key so the Mac can seal
        // per-device rich-push blobs. Derived from the same identity seed; nil
        // only if the seed is unloadable (the Mac then sends generic pushes).
        let agreePub = (try? TWPushSeal.agreementPublicRaw(fromSeed: identitySeed))?
            .base64EncodedString()
        // Capture the host this registration is being SENT to, so the ack's
        // macAgreePub is stored against THAT host even if the user switches hosts
        // before the ack lands (a stale ack would otherwise key the wrong record).
        let expectedHostId = pinnedMacIdentityB64 ?? selectedHostId
        send(
            BridgeAction.registerApnsToken(
                deviceToken: token.hex, env: token.env, agreePub: agreePub),
            successLabel: "Notifications ready.",
            navigateOnAck: false,
            silent: true,
            onAck: { [weak self] accepted in
                guard let self else { return }
                self.apnsTokenRegistrationInFlight = false
                if accepted, self.pendingApnsToken?.hex == token.hex,
                    self.pendingApnsToken?.env == token.env
                {
                    self.pendingApnsToken = nil
                    return
                }
                if self.pendingApnsToken?.hex != token.hex || self.pendingApnsToken?.env != token.env {
                    self.sendPendingApnsTokenIfReady()
                } else {
                    self.scheduleApnsTokenRetry()
                }
            },
            onAckResult: { [weak self] accepted, ack in
                guard let self, accepted, let ack else { return }
                self.storePushRegistrationFromAck(ack, expectedHostId: expectedHostId)
            })
    }

    /// Persist the authenticated Mac's push-agreement key and its optional
    /// project-gateway route onto the host the registration was SENT to. The
    /// former feeds NSE decryption; the latter lets this phone author the signed
    /// relay registration needed for force-quit completion banners.
    private func storePushRegistrationFromAck(_ ack: AckResult, expectedHostId: String?) {
        guard let data = ack.result,
            let actionAck = try? TWCoders.decoder.decode(BridgeActionAck.self, from: data),
            let ackData = actionAck.data
        else { return }
        // Key the record by the host captured at send time — never re-derive from
        // live state here, or a host switch between send and ack could store this
        // Mac's key onto a different host (→ the NSE would try the wrong secret).
        guard let hostId = expectedHostId,
            let host = pairingStore.find(macIdentityPubKey: hostId)
        else { return }
        let macAgreePub = ackData.macAgreePub?.isEmpty == false
            ? ackData.macAgreePub : host.macAgreePub
        let pushGatewayUrl: String?
        if ackData.pushGatewayConfigured == false {
            pushGatewayUrl = nil
        } else if ackData.pushGatewayConfigured == true {
            let candidate = ackData.pushGatewayUrl?.trimmingCharacters(
                in: .whitespacesAndNewlines)
            pushGatewayUrl = candidate?.isEmpty == false ? candidate : nil
        } else {
            // Older Macs do not carry either gateway field. Preserve the last
            // authenticated route rather than erasing it during compatibility
            // reconnects; its relay-side token row remains TTL-bounded.
            pushGatewayUrl = host.pushGatewayUrl
        }
        let updated = host
            .withMacAgreePub(macAgreePub)
            .withPushGatewayUrl(pushGatewayUrl)
        if updated != host {
            pairingStore.upsert(updated)
            pairedHosts = pairingStore.list()
        }
        registerWithProjectPushGatewaysIfReady()
    }

    private func scheduleApnsTokenRetry() {
        guard pendingApnsToken != nil else { return }
        apnsTokenRetryTask?.cancel()
        apnsTokenRetryTask = Task { [weak self] in
            await TWRetryDelay.sleep(milliseconds: 5_000)
            guard !Task.isCancelled else { return }
            await MainActor.run { self?.sendPendingApnsTokenIfReady() }
        }
    }

    public func setNotifyFinishedTurns(_ enabled: Bool) {
        notifyFinishedTurns = enabled
        pushGatewayDefaults.set(enabled, forKey: Self.notifyFinishedTurnsDefaultsKey)
        registerWithProjectPushGatewaysIfReady()
    }

    public func retryProjectPushGatewayRegistration() {
        registerWithProjectPushGatewaysIfReady()
    }

    private func registerWithProjectPushGatewaysIfReady() {
        guard identitySeed.count == 32, let token = pushGatewayApnsToken else { return }
        let targets = pairingStore.list().compactMap { host -> ([String], String)? in
            let advertised = host.pushGatewayUrl?.trimmingCharacters(
                in: .whitespacesAndNewlines)
            let candidates: [String]
            if let advertised, !advertised.isEmpty {
                candidates = [advertised]
            } else {
                // P4 shipped before Macs could advertise a dedicated gateway
                // in the authenticated token ack. The design's original shape
                // put /v1/apns/* on the paired relay itself, so try every
                // already-pinned relay door for compatibility. The client
                // still rejects unsafe public cleartext endpoints.
                candidates = RelayCandidates.ordered(
                    from: host.relayUrls,
                    fallback: host.relayUrl,
                    preferRemoteFirst: true)
            }
            guard !candidates.isEmpty else { return nil }
            return (candidates, host.macIdentityPubKey)
        }
        pushGatewayRegistrationTask?.cancel()
        guard !targets.isEmpty else {
            completionPushGatewayStatus = .directOnly
            return
        }
        completionPushGatewayStatus = .registering(totalHosts: targets.count)
        let client = pushGatewayClient
        let seed = identitySeed
        let enabled = notifyFinishedTurns
        pushGatewayRegistrationTask = Task { @MainActor [weak self] in
            var registered = 0
            for (gatewayUrls, macIdentityPubKey) in targets {
                guard !Task.isCancelled else { return }
                var hostRegistered = false
                for gatewayUrl in gatewayUrls {
                    do {
                        _ = try await client.register(
                            gatewayUrl: gatewayUrl,
                            macIdentityPubKey: macIdentityPubKey,
                            identitySeed: seed,
                            deviceTokenHex: token.hex,
                            env: token.env,
                            notifyFinishedTurns: enabled)
                        hostRegistered = true
                        break
                    } catch {
                        // Try the next authenticated relay door for this host.
                    }
                }
                if hostRegistered {
                    registered += 1
                }
            }
            guard !Task.isCancelled, let self else { return }
            if registered == targets.count {
                self.completionPushGatewayStatus =
                    enabled ? .registered(hosts: registered) : .optedOut(hosts: registered)
            } else if registered > 0 {
                self.completionPushGatewayStatus = .partial(
                    registered: registered, total: targets.count, enabled: enabled)
            } else {
                self.completionPushGatewayStatus = .failed
            }
        }
    }

    private func deregisterFromProjectPushGateways(_ hosts: [PairedHostRecord]) {
        guard identitySeed.count == 32 else { return }
        let targets = hosts.compactMap { host -> ([String], String)? in
            let advertised = host.pushGatewayUrl?.trimmingCharacters(
                in: .whitespacesAndNewlines)
            let candidates: [String]
            if let advertised, !advertised.isEmpty {
                candidates = [advertised]
            } else {
                candidates = RelayCandidates.ordered(
                    from: host.relayUrls,
                    fallback: host.relayUrl,
                    preferRemoteFirst: true)
            }
            guard !candidates.isEmpty else { return nil }
            return (candidates, host.macIdentityPubKey)
        }
        guard !targets.isEmpty else { return }
        let client = pushGatewayClient
        let seed = identitySeed
        Task {
            for (gatewayUrls, macIdentityPubKey) in targets {
                for gatewayUrl in gatewayUrls {
                    do {
                        _ = try await client.deregister(
                            gatewayUrl: gatewayUrl,
                            macIdentityPubKey: macIdentityPubKey,
                            identitySeed: seed)
                        break
                    } catch {
                        // Best-effort cleanup walks the remaining pinned doors.
                    }
                }
            }
        }
    }

    public func handleRemoteWake(reason: String, timeoutMs: Int = 10_000) async -> Bool {
        guard hasStoredPairing else { return false }
        if Self.shouldRehydrateAfterWake(reason: reason) {
            pendingWakeRehydrate = true
        }
        #if DEBUG
            remoteWakeBeganHookForTesting?()
        #endif
        switch phase {
        case .connected:
            let attempt = connectAttempt
            let probe = await probeConnectedHealth(peer: false)
            guard connectAttempt == attempt else {
                return await waitForRemoteWakeConnection(timeoutMs: timeoutMs)
            }
            if probe.alive {
                // Rehydrate content on a genuinely-alive wake (RC1), EXCEPT on
                // the approval-ack path (tight background budget) and the silent
                // push (runs outside the background assertion). rehydrate only
                // enqueues fire-and-forget work, so the ack still returns now.
                if Self.shouldRehydrateAfterWake(reason: reason) {
                    rehydrateAfterAliveWake()
                }
                pendingWakeRehydrate = false
                return true
            }
            // Half-open from connected — allowed supersede source (b).
            requestReconnect(.health, socketAlive: false)
        case .connecting, .awaitingMacConfirm:
            // Coalesce APNs into the live dial; never restart on connecting&&!alive.
            requestReconnect(.apns)
        case .idle, .error:
            requestReconnect(.apns)
        }
        return await waitForRemoteWakeConnection(timeoutMs: timeoutMs)
    }

    private func waitForRemoteWakeConnection(timeoutMs: Int) async -> Bool {
        var waitedMs = 0
        while waitedMs < timeoutMs {
            if case .connected = phase { return true }
            guard !Task.isCancelled else { return false }
            await TWRetryDelay.sleep(milliseconds: 250)
            waitedMs += 250
        }
        return false
    }

    /// One-time (per authorization state) UNUserNotificationCenter ask —
    /// AFTER pairing, so the permission prompt has context. Registration
    /// re-runs every launch (tokens rotate).
    private func requestPushAuthorizationIfNeeded() {
        // Registration is runtime-gated below by the notification authorization
        // status and is only reached after a successful pairing — so it is safe
        // (and necessary) in Release/TestFlight too. The previous
        // `#if !DEBUG && !TASKWRAITH_ENABLE_APNS_REGISTRATION return` wrapper
        // compiled this out of every shipped build, leaving no device token to
        // push to; the flag was never defined in the Xcode project.
        #if canImport(UIKit)
            UNUserNotificationCenter.current().getNotificationSettings { settings in
                switch settings.authorizationStatus {
                case .notDetermined:
                    UNUserNotificationCenter.current().requestAuthorization(options: [
                        .alert, .badge, .sound,
                    ]) { granted, _ in
                        guard granted else { return }
                        DispatchQueue.main.async {
                            UIApplication.shared.registerForRemoteNotifications()
                        }
                    }
                case .authorized, .provisional, .ephemeral:
                    DispatchQueue.main.async {
                        UIApplication.shared.registerForRemoteNotifications()
                    }
                default:
                    break
                }
            }
        #endif
    }

    // MARK: - Foreground completion banners

    /// When the Mac marks a task's successful completion as notification-eligible
    /// LIVE while the app is in the foreground, post a rich LOCAL notification
    /// built from data the phone already
    /// holds over the E2EE projection (`card.preview` + `diffSummaries`). The content
    /// is NEVER inlined into the Mac's routing-only remote push — the phone composes
    /// it locally. willPresent (PushAppDelegate) drops the Mac's generic
    /// runComplete/runFailed twin while foregrounded, so a completion never
    /// double-banners. Skipped when the thread is already on-screen (`visibleThreadId`
    /// — you can see the result), in the offline demo, and on the first snapshot
    /// (no prior status ⇒ no live transition, so historical completions stay quiet).
    private func handleTaskCardCompletionTransitions(previous: [RemoteTaskCard]) {
        #if canImport(UIKit)
            guard !isDemo, !previous.isEmpty else { return }
            guard UIApplication.shared.applicationState == .active else { return }
            var previousCards: [String: RemoteTaskCard] = [:]
            previousCards.reserveCapacity(previous.count)
            for card in previous { previousCards[card.id] = card }
            for card in taskCards {
                guard let prior = previousCards[card.id] else { continue }
                guard CompletionNotificationPolicy.shouldNotify(previous: prior, current: card)
                else { continue }
                guard visibleThreadId != card.id else { continue }
                postCompletionBanner(for: card)
            }
        #endif
    }

    /// Suppresses Live Activity churn while a host switch tears the projection
    /// down field by field. Without it, clearing `ensembleStates` would re-plan
    /// against a still-populated `taskCards` and briefly restate an activity we
    /// are about to end anyway.
    private var isTearingDownProjection = false

    /// Reconciles the lock screen / Dynamic Island with the current projection.
    ///
    /// Deliberately NOT gated on `applicationState == .active`, unlike the
    /// completion banner: a Live Activity's whole job is to be right after you
    /// put the phone down, so the last update before the socket drops is the
    /// most valuable one. Freshness past that point is handled by the staleDate
    /// the controller stamps on every push, not by refusing to update here.
    #if os(iOS)
        /// Set once. The controller has no transport of its own, so it hands
        /// tokens back through this and we ship them to the Mac.
        private func bindRunActivityTokenSink() {
            guard TWRunActivityController.shared.onPushToken == nil else { return }
            TWRunActivityController.shared.onPushToken = { [weak self] ref, subject, token in
                guard let self else { return }
                // Fire-and-forget: if it does not land, the card simply stays
                // device-updated (and goes stale when the phone sleeps) rather
                // than breaking. `silent` so a routine token registration never
                // wakes the "Sent." toast.
                self.send(
                    BridgeAction.registerLiveActivityToken(
                        activityRef: ref,
                        token: token,
                        threadId: subject.threadId,
                        workspaceId: subject.workspaceId,
                        env: self.apnsEnvironment),
                    navigateOnAck: false,
                    silent: true)
            }
            TWRunActivityController.shared.onPushToStartToken = { [weak self] token, accents in
                guard let self else { return }
                self.send(
                    BridgeAction.registerLiveActivityStartToken(
                        token: token, accents: accents, env: self.apnsEnvironment),
                    navigateOnAck: false,
                    silent: true)
            }
        }
    #endif

    private func syncRunActivities() {
        guard !isTearingDownProjection else { return }
        #if os(iOS)
            bindRunActivityTokenSink()
            TWRunActivityController.shared.sync(
                cards: taskCards,
                diffs: diffSummaries,
                ensembles: ensembleStates,
                gitSnapshots: gitSnapshots,
                isDemo: isDemo)
            syncGlanceWidgetSnapshot()
        #endif
    }

    /// Maps a card into the glance-widget row the widget extension will render.
    /// Kept static and internal so tests can assert the mapping without
    /// spinning up a full `RemoteSessionModel`.
    static func glanceWidgetRow(for card: RemoteTaskCard) -> TWWidgetSnapshot.Row {
        let mapped = TWWidgetSnapshot.Row.mappedStatus(
            status: card.status,
            provider: card.provider,
            chatKind: card.chatKind,
            updatedAt: card.updatedAt)
        func tintHex() -> UInt32? {
            switch mapped.status {
            case "running":
                return TWTheme.providerAccentHex(mapped.displayProvider)
            case "failed", "error":
                return TWTheme.diffStatDelHex
            case "success":
                return TWTheme.diffStatAddHex
            case "awaitingApproval", "awaitingQuestion":
                return TWTheme.statusAttentionHex
            default:
                return nil
            }
        }
        return TWWidgetSnapshot.Row(
            threadId: card.threadId ?? card.id,
            title: card.title?.isEmpty == false ? (card.title ?? "Task") : "Task",
            status: mapped.status,
            providerLabel: mapped.displayProvider.map { TWTheme.providerLabel($0) },
            tintHex: tintHex(),
            updatedAt: mapped.updatedAtMs)
    }

    /// Urgency rank for glance rows: needs-you first, then active (queued/running),
    /// then terminal/other rows ordered by recency.
    static func glanceWidgetSortRank(_ status: String) -> Int {
        switch status {
        case "awaitingApproval", "awaitingQuestion": return 0
        case "queued", "running": return 1
        default: return 2
        }
    }

    #if os(iOS)
        /// Write the home-screen glance widget's snapshot into the App Group.
        /// Colours resolve HERE (TWTheme is app-side only — the widget links
        /// TaskWraithKit alone and renders whatever hex it is handed).
        /// Rows are ordered by operational urgency (needs-you, active, then the
        /// most recently updated terminals) so the widget surface stays useful even
        /// without exposing task titles.
        private func syncGlanceWidgetSnapshot() {
            guard !isDemo else { return }
            let rows = taskCards
                .map { Self.glanceWidgetRow(for: $0) }
                .sorted { a, b in
                    let rankA = Self.glanceWidgetSortRank(a.status)
                    let rankB = Self.glanceWidgetSortRank(b.status)
                    if rankA != rankB {
                        return rankA < rankB
                    }
                    return (a.updatedAt ?? 0) > (b.updatedAt ?? 0)
                }
            let snapshot = TWWidgetSnapshot(
                generatedAt: Int64(Date().timeIntervalSince1970 * 1000),
                hostName: pairedHosts.first?.macDisplayName,
                rows: rows)
            snapshot.save(suiteName: TWPushKeyAccess.appGroup)
            #if canImport(WidgetKit)
                WidgetCenter.shared.reloadTimelines(ofKind: "TWGlanceWidget")
            #endif
        }
    #endif

    #if canImport(UIKit)
        /// SINGLE RENDER PATH: this defers to `CompletionBannerRenderer`, the same
        /// pure renderer the Notification Service Extension uses for the background
        /// push. It previously re-implemented the title/summary/diff logic inline
        /// with different emoji and a different title shape, so the SAME run banner
        /// looked different depending on whether the app happened to be foregrounded.
        /// Do not re-inline it — add tokens to the renderer instead.
        ///
        /// `CompletionNotificationPolicy.shouldNotify` only passes cards whose status
        /// is "success", so the status is pinned rather than derived.
        private func postCompletionBanner(for card: RemoteTaskCard) {
            // Present-once: replaying this transition (stale→fresh status flap
            // across reconnect/rehydrate churn) re-adds the same identifier,
            // which the notification center re-SOUNDS even though it only
            // visually replaces the banner. See CompletionBannerPresentationLedger.
            guard completionBannerLedger.claimPresentation(threadId: card.id, runId: card.runId)
            else { return }
            let diff = diffSummaries[card.id]
            let rendered = CompletionBannerRenderer.render(
                CompletionBannerInput(
                    title: card.title,
                    failed: false,
                    preview: card.preview,
                    filesChanged: diff?.filesChanged ?? diff?.files?.count ?? 0,
                    additions: diff?.additions ?? 0,
                    deletions: diff?.deletions ?? 0,
                    status: .success))
            let content = UNMutableNotificationContent()
            content.title = rendered.title
            content.body = rendered.body
            content.sound = .default
            content.userInfo = ["tw_rich_local": true, "threadId": card.id]
            let request = UNNotificationRequest(
                identifier: CompletionBannerPresentationLedger.bannerId(
                    threadId: card.id, runId: card.runId),
                content: content, trigger: nil)
            UNUserNotificationCenter.current().add(request)
        }

        /// See CompletionBannerPresentationLedger — one ding per completed run.
        private var completionBannerLedger = CompletionBannerPresentationLedger()
    #endif

    /// Side-chat child that should open inside the inspector instead of
    /// replacing the split-view detail pane.
    @Published public var inspectorSideChatTarget: String?
    @Published public var fileModeRequest: FileModeRequest?
    @Published public var diffModeRequest: DiffModeRequest?

    private var identitySeed: Data
    private let identityStore: IdentitySeedStore
    private let pairingStore: PairedHostStore
    private let pushGatewayClient: PushGatewayRegistrationClient
    private let pushGatewayDefaults: UserDefaults
    public let hostProjection: PairedHostSessionController
    private var client: RelayTransportClient?
    private var eventTask: Task<Void, Never>?
    private var pinnedMacIdentityB64: String?
    private var relayUrl: String?

    /// Set when the identity seed couldn't be loaded/persisted — the shell
    /// shows a dedicated recovery screen and every connect path refuses
    /// until `retryIdentityLoad()` succeeds. Never auto-regenerated: the
    /// Mac pins this identity, so a silent replacement just looks like a
    /// mysteriously dead pairing (and would mask tampering).
    @Published public private(set) var identityError: String?

    public init(
        identityStore: IdentitySeedStore,
        pairingStore: PairedHostStore = UserDefaultsPairedHostStore(),
        hostSnapshotStore: any PairedHostSnapshotStore = UserDefaultsPairedHostSnapshotStore(),
        pushGatewayClient: PushGatewayRegistrationClient = PushGatewayRegistrationClient(),
        pushGatewayDefaults: UserDefaults = .standard
    ) {
        self.identityStore = identityStore
        self.hostProjection = PairedHostSessionController(snapshotStore: hostSnapshotStore)
        self.pushGatewayClient = pushGatewayClient
        self.pushGatewayDefaults = pushGatewayDefaults
        if let storedPreference = pushGatewayDefaults.object(
            forKey: Self.notifyFinishedTurnsDefaultsKey) as? Bool
        {
            self.notifyFinishedTurns = storedPreference
        }
        var seed = Data()
        var loadError: String? = nil
        do {
            seed = try identityStore.loadOrCreateSeed()
        } catch {
            loadError = Self.identityErrorMessage(error)
        }
        self.identitySeed = seed
        self.identityError = loadError
        self.pairingStore = pairingStore
        // Loading triggers the one-shot v1→v2 migration on first launch, so an
        // existing single-host user keeps their host (now the active one).
        let doc = pairingStore.load()
        self.pairedHosts = doc.hosts
        self.selectedHostId = doc.selectedHostId
        self.hasStoredPairing = doc.selectedHostId != nil
        // A stored pairing means this phone established at least once. Restore
        // that so a cold launch (notification / widget / APNs) keeps ConnectedShell
        // instead of flashing PairingView. Also honor an explicit App Group flag
        // so forgetAllHosts can clear the bit independently of a later re-pair.
        self.wasEverConnected =
            self.hasStoredPairing
            || pushGatewayDefaults.bool(forKey: Self.wasEverConnectedDefaultsKey)
        if self.wasEverConnected {
            self.persistWasEverConnectedFlag()
        }
        if let active = doc.selectedHost {
            self.macDisplayName = Self.sanitizedMacName(active.macDisplayName)
            if self.identityError == nil {
                self.prepareHostProjectionOffline(hostIdentity: active.macIdentityPubKey)
            }
        }
        streamingPublishGate.bind { [weak self] threadId, staging in
            self?.applyStreamingStagingPublish(threadId: threadId, staging: staging)
        }
        startPathMonitor()
    }

    // ── Reconnect self-healing ──────────────────────────────────────────────
    // A cold cellular launch races the Tailscale tunnel: the first trusted-
    // reconnect walk usually runs BEFORE the on-demand VPN is up, exhausts
    // its two passes (~35s of dead dials), and parked on the error screen
    // until the user poked the app — field reports of "reconnects after 2-3
    // minutes" were really "reconnects when something finally retried".
    // Two healers: a backoff loop that keeps re-walking while the error
    // screen shows, and a network-path monitor that re-dials the INSTANT a
    // new route (the tunnel, a Wi-Fi join) appears.

    private var autoReconnectTask: Task<Void, Never>?
    private var delayedSocketClosedReconnectTask: Task<Void, Never>?
    private var socketClosedRedialDelayMs: Int {
        #if DEBUG
            if let override = socketClosedRedialDelayMsForTesting { return override }
        #endif
        return 1_200
    }
    /// Shared in-flight health probe. `handleRemoteWake`, `verifyConnectedSocket`,
    /// and `requestActionAckWithWake` join this Task instead of stacking a 2.5s
    /// relay ping on top of a 6s encrypted peer ping.
    private var socketHealthTask: Task<(alive: Bool, peer: Bool), Never>?
    private var socketHealthProbeGeneration = 0
    private var autoReconnectAttempt = 0
    private var pathMonitor: NWPathMonitor?
    private var lastPathSignature = ""
    private var trustedReconnectAttempt: Int?
    /// Single-flight policy for APNs / foreground / path / health wakes.
    private var reconnectCoordinator = ReconnectCoordinator()
    /// True while a trusted dial is walking the relay doors — the wake banner
    /// announces once per dial, not once per queued action.
    private var reconnectDialInFlight: Bool { reconnectCoordinator.inFlight }
    #if DEBUG
        /// How many times `reconnectTrusted()` actually began a dial — the
        /// number the reconnect-storm regression test pins.
        private(set) var trustedReconnectDialsForTesting = 0

        /// Backoff-ladder rung. The storm's second half was this being zeroed
        /// on every dial, pinning the retry timer at its 1.5s first rung.
        var autoReconnectAttemptForTesting: Int {
            get { autoReconnectAttempt }
            set { autoReconnectAttempt = newValue }
        }

        /// In-flight flag the disconnect-invalidation regression pins.
        var reconnectCoordinatorInFlightForTesting: Bool { reconnectCoordinator.inFlight }

        /// Shrink the `handleSocketClosed` 1.2s delayed redial in tests.
        var socketClosedRedialDelayMsForTesting: Int?
    #endif

    private func startPathMonitor() {
        guard pathMonitor == nil else { return }
        let monitor = NWPathMonitor()
        pathMonitor = monitor
        monitor.pathUpdateHandler = { [weak self] path in
            // Interface set + reachability as a change signature — utun
            // appearing (tunnel up) or Wi-Fi joining changes it; idle
            // re-notifications don't.
            let signature =
                path.availableInterfaces.map { "\($0.type)\($0.name)" }.joined(separator: ",")
                + (path.status == .satisfied ? "|up" : "|down")
            Task { @MainActor [weak self] in
                guard let self else { return }
                let previous = self.lastPathSignature
                guard signature != previous else { return }
                self.lastPathSignature = signature
                // First callback just seeds the signature; a route change
                // only matters when a reconnect is winnable AND wanted.
                guard !previous.isEmpty, path.status == .satisfied, self.hasStoredPairing
                else { return }
                self.requestReconnect(.path)
            }
        }
        monitor.start(queue: .global(qos: .utility))
    }

    /// Re-walk after a failed trusted reconnect: 1.5s, 3s, 6s, 12s, 24s,
    /// then every 30s while the error screen is up. Cancelled by success,
    /// disconnect/forget, or a newer reconnect of any kind.
    private func scheduleAutoReconnect() {
        guard hasStoredPairing else { return }
        autoReconnectTask?.cancel()
        let attempt = autoReconnectAttempt
        autoReconnectAttempt += 1
        let delaySeconds = min(30.0, 1.5 * pow(2.0, Double(min(attempt, 4))))
        autoReconnectTask = Task { [weak self] in
            await TWRetryDelay.sleep(nanoseconds: UInt64(delaySeconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                guard let self, self.hasStoredPairing else { return }
                if case .error = self.phase { self.requestReconnect(.resume) }
            }
        }
    }

    private func cancelAutoReconnect(resetAttempts: Bool) {
        autoReconnectTask?.cancel()
        autoReconnectTask = nil
        if resetAttempts { autoReconnectAttempt = 0 }
    }

    private func cancelSocketHealthCheck() {
        socketHealthTask?.cancel()
        socketHealthTask = nil
    }

    private func cancelDelayedSocketClosedReconnect() {
        delayedSocketClosedReconnectTask?.cancel()
        delayedSocketClosedReconnectTask = nil
    }

    private func prepareHostProjectionOffline(hostIdentity: String) {
        guard
            let phoneIdentity = pairedHostProjectionIdentity(
                identityPublicKeyBase64: identityPublicKeyBase64)
        else {
            hostProjection.clear(removePersistedSnapshot: false)
            return
        }
        hostProjection.prepareOffline(
            hostIdentity: hostIdentity,
            phoneIdentity: phoneIdentity)
    }

    private func preferRemoteRelayFirst(relayUrls: [String]?, fallback: String) -> Bool {
        guard let path = pathMonitor?.currentPath, path.status == .satisfied else { return false }
        // Cellular / expensive non-Wi-Fi paths: a LAN ws:// door is unreachable,
        // so the direct/WSS Tailscale doors go first — no LAN timeout to burn.
        if path.usesInterfaceType(.cellular) { return true }
        if path.isExpensive && !path.usesInterfaceType(.wifi)
            && !path.usesInterfaceType(.wiredEthernet) {
            return true
        }
        // On Wi-Fi/Ethernet, LAN-first is the fast home path — but ONLY if a LAN
        // door is actually on THIS network. A Mac advertising 192.168.0.x while
        // the phone is on a different SSID/subnet (guest Wi-Fi, a separate site)
        // can't be reached on that ws:// URL; dialing it first stalls on a long
        // TCP timeout — the "~5 min to connect off-LAN" delay — before a remote
        // Tailscale door is even tried. If there ARE local candidates and none
        // is in this device's subnet, prefer the remote door first. If we can't read the
        // interfaces (nil), keep LAN-first — never hard-skip a door that may route.
        let candidates = RelayCandidates.ordered(from: relayUrls, fallback: fallback)
        let localHosts = candidates
            .compactMap { URL(string: $0)?.host }
            .filter { RelayCandidates.isLocalNetworkHost($0) }
        guard !localHosts.isEmpty else { return false }
        guard let reachableLAN = RelayCandidates.anyHostInDeviceSubnet(localHosts) else {
            return false
        }
        return !reachableLAN
    }

    /// Re-attempt the identity load (e.g. after the user unlocked the
    /// device / freed storage). Clears the error screen on success.
    public func retryIdentityLoad() {
        do {
            identitySeed = try identityStore.loadOrCreateSeed()
            identityError = nil
        } catch {
            identityError = Self.identityErrorMessage(error)
        }
    }

    private static func identityErrorMessage(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? String(describing: error)
    }

    /// Both connect paths refuse while the identity is unavailable — a
    /// 0-byte seed would just fail deeper with an opaque CryptoKit error.
    private func identityReady() -> Bool {
        if let identityError {
            phase = .error(identityError)
            return false
        }
        return identitySeed.count == 32
    }

    /// This phone's identity public key (base64 raw 32B) — shown in pairing UI
    /// so the user can confirm it matches what the Mac pinned.
    public var identityPublicKeyBase64: String {
        (try? Curve25519.Signing.PrivateKey(rawRepresentation: identitySeed))
            .map { Base64.encode($0.publicKey.rawRepresentation) } ?? ""
    }

    public struct FileModeRequest: Identifiable, Sendable {
        public let id = UUID()
        public let workspaceId: String?
        public let targetPath: String?
    }

    public struct DiffModeRequest: Identifiable, Sendable {
        public let id = UUID()
        public let workspaceId: String?
        public let targetPath: String?
    }

    // ── Pairing ────────────────────────────────────────────────────────────────

    /// Pair from a scanned/pasted bootstrap JSON string.
    public func pair(fromBootstrapJSON json: String) {
        let sanitized = Self.sanitizeBootstrapJSON(json)
        guard let data = sanitized.data(using: .utf8),
            let bootstrap = try? TWCoders.decoder.decode(PairingBootstrapPayload.self, from: data)
        else {
            phase = .error(
                "That doesn't look like a valid pairing code. Use the Copy setup payload "
                    + "button on your Mac (don't retype it), then paste the whole thing here."
            )
            return
        }
        connect(bootstrap: bootstrap)
    }

    // ── QR-optional discovery (multi-host) ───────────────────────────────────

    /// Ask the connected host (the "oracle") to enumerate the tailnet and
    /// surface its OTHER TaskWraith machines. The host alone holds the Tailscale
    /// OAuth credential — it never reaches this phone. Results are deduped
    /// against the hosts we've already paired with (the oracle can't see those
    /// pairings) and published to `discoveredHosts`. Read-only and idempotent.
    public func discoverHosts() async {
        guard !isDiscoveringHosts else { return }
        isDiscoveringHosts = true
        discoveryError = nil
        defer { isDiscoveringHosts = false }
        // The enumeration runs on the CURRENT oracle. If the user switches hosts
        // during the await, discard the late result so the old oracle's hosts
        // can't land under the new host (clearCachedProjectionState already reset
        // the list on the switch).
        let oracle = selectedHostId
        do {
            // Enumerate + probe the whole tailnet host-side — give it room.
            let ack = try await requestFileAction(
                BridgeAction.discoverTailnetHosts(), timeoutMs: 20_000)
            guard selectedHostId == oracle else { return }
            let found = ack.data?.hosts ?? []
            let pairedKeys = Set(pairedHosts.map { $0.macIdentityPubKey })
            discoveredHosts = found.filter { !pairedKeys.contains($0.macIdentityPubKey) }
        } catch {
            guard selectedHostId == oracle else { return }
            discoveryError =
                (error as? LocalizedError)?.errorDescription ?? "Couldn't search your tailnet."
            discoveredHosts = []
        }
    }

    /// Pair with a discovered host WITHOUT scanning a QR: POST /v1/beginpair to
    /// its front door, which mints a fresh pairing session and returns the full
    /// bootstrap — then connect with it exactly as if we'd scanned its QR. The
    /// 6-digit SAS confirm still happens on the TARGET host, so an
    /// unauthenticated tailnet POST only opens a window the user must approve;
    /// it can't pair on its own.
    /// Returns true once a pairing connect was kicked off (the SAS flow takes
    /// over); false if every candidate door failed — in which case the live
    /// oracle connection is left untouched and the reason surfaces via
    /// `discoveryError` (shown in the discovery sheet), NOT `phase`.
    @discardableResult
    public func pairDiscoveredHost(_ host: DiscoveredHostInfo) async -> Bool {
        let candidates = RelayCandidates.ordered(
            from: host.relayUrls, fallback: host.relayUrls.first ?? "",
            preferRemoteFirst: preferRemoteRelayFirst(
                relayUrls: host.relayUrls, fallback: host.relayUrls.first ?? ""))
        let label = host.macDisplayName ?? "that host"
        var lastError = "Couldn't reach \(label) to start pairing."
        for relay in candidates {
            // Preflight keeps cleartext limited to LAN + numeric Tailscale IPs;
            // skip anything else and try the next advertised door.
            if let problem = Self.cleartextRelayProblem(relay) {
                lastError = problem
                continue
            }
            guard let url = RelayCandidates.beginPairURL(fromRelay: relay) else { continue }
            do {
                var req = URLRequest(url: url)
                req.httpMethod = "POST"
                // Per-candidate budget: LAN doors fail fast, remote doors get
                // room — a dead LAN door can't hang the whole flow.
                req.timeoutInterval = Double(RelayCandidates.dialTimeoutMs(for: relay)) / 1000.0
                let (data, response) = try await URLSession.shared.data(for: req)
                guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                    lastError = "\(label) declined to open a pairing window — try again."
                    continue
                }
                guard
                    let bootstrap = try? TWCoders.decoder.decode(
                        PairingBootstrapPayload.self, from: data)
                else {
                    lastError = "\(label) returned an unreadable pairing response."
                    continue
                }
                // Defense in depth: the door we reached must be the host the user
                // picked. The SAS still gates pairing, but refuse a silently
                // different identity rather than prompting for an unexpected host.
                guard bootstrap.macIdentityPubKey == host.macIdentityPubKey else {
                    lastError = "\(label) returned a different identity than expected."
                    continue
                }
                connect(bootstrap: bootstrap)
                return true
            } catch {
                lastError =
                    (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                continue
            }
        }
        // Don't clobber `phase` — the oracle connection is still live.
        discoveryError = lastError
        return false
    }

    /// iOS text fields apply smart punctuation: touching the paste field
    /// curls straight quotes (" → “”) and corrupts the JSON — the #1 cause
    /// of "invalid pairing code". Undo that, plus the usual paste debris
    /// (zero-width chars, BOM, surrounding whitespace).
    static func sanitizeBootstrapJSON(_ raw: String) -> String {
        var text = raw
        let replacements: [(String, String)] = [
            ("\u{201C}", "\""), ("\u{201D}", "\""),  // curly double quotes
            ("\u{2018}", "'"), ("\u{2019}", "'"),  // curly single quotes
            ("\u{FEFF}", ""), ("\u{200B}", ""), ("\u{200E}", ""), ("\u{200F}", "")
        ]
        for (from, to) in replacements {
            text = text.replacingOccurrences(of: from, with: to)
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Keep cleartext ws:// constrained to LAN or Tailscale's numeric CGNAT
    /// range. NSAllowsLocalNetworking permits IP-literal loads on current iOS;
    /// the 100.64/10 route is WireGuard-encrypted by Tailscale and the session
    /// remains independently E2EE. Arbitrary public IP/DNS relays stay blocked.
    static func cleartextRelayProblem(_ relayUrl: String) -> String? {
        guard let url = URL(string: relayUrl), url.scheme?.lowercased() == "ws" else {
            return nil
        }
        let host = (url.host ?? "").lowercased()
        if isLocalNetworkHost(host) || RelayCandidates.isTailscaleIPv4Host(host) { return nil }
        return "“\(host)” is a cleartext ws:// relay outside your local network — iOS blocks "
            + "that. Use a LAN address, this Mac's 100.x Tailscale IP, or a wss:// relay."
    }

    static func isLocalNetworkHost(_ host: String) -> Bool {
        // Single-sourced in TaskWraithKit so the candidate-ordering logic
        // and the ATS preflight can never disagree about what "local" means.
        RelayCandidates.isLocalNetworkHost(host)
    }

    /// Monotonic stamp for connect attempts so the dial watchdog only fires
    /// against ITS OWN attempt (a newer scan/reconnect invalidates it).
    private var connectAttempt = 0
    /// The bootstrap's full candidate set, persisted into the pairing
    /// record on establish (T70 multi-door reconnects).
    private var lastRelayUrls: [String]?
    /// The active host's OS ("mac"/"windows"/"linux"), captured from the
    /// bootstrap (fresh pair) or the record (reconnect), persisted for the glyph.
    private var lastHostPlatform: String?

    private func connect(bootstrap: PairingBootstrapPayload) {
        guard identityReady() else { return }
        // T70 — walk the bootstrap's candidate doors in order (LAN first:
        // instant at home, a cheap 5s timeout away from it; then the wss
        // front door). Candidates the ATS preflight rejects are skipped,
        // not fatal — a ws:// LAN door is invalid from cellular while the
        // wss door right after it works fine.
        let candidates = RelayCandidates.ordered(
            from: bootstrap.relayUrls, fallback: bootstrap.relayUrl,
            preferRemoteFirst: preferRemoteRelayFirst(
                relayUrls: bootstrap.relayUrls, fallback: bootstrap.relayUrl))
        cancelSocketHealthCheck()
        teardown()
        trustedReconnectAttempt = nil
        // Connecting to a DIFFERENT host than the active one (e.g. adding a
        // second host from the pairing screen): wipe the outgoing host's cached
        // projection so its transcripts/usage/diffs never bleed into the new
        // host's view. Caches are flat today, so clearing on host change is what
        // keeps them effectively per-host. Re-pairing the SAME host keeps them.
        if let current = pinnedMacIdentityB64, current != bootstrap.macIdentityPubKey {
            wipeProjectionCaches()
        }
        macDisplayName = bootstrap.macDisplayName
        pinnedMacIdentityB64 = bootstrap.macIdentityPubKey
        prepareHostProjectionOffline(hostIdentity: bootstrap.macIdentityPubKey)
        lastRelayUrls = bootstrap.relayUrls
        lastHostPlatform = bootstrap.hostPlatform
        phase = .connecting
        connectAttempt += 1
        let attempt = connectAttempt
        Task {
            var lastFailure: String? = nil
            walk: for candidate in candidates {
                guard self.connectAttempt == attempt else { return }
                if let problem = Self.cleartextRelayProblem(candidate) {
                    lastFailure = problem
                    continue
                }
                // FRESH client per candidate (field bug: a shared client let
                // the abandoned LAN dial's cancellation event — NSURLError
                // -999 — land in the live wss candidate's event stream and
                // stomp its phase mid-handshake). teardown() cancels the
                // previous event consumer before the next client attaches,
                // so a dying door can't touch the live one.
                self.teardown()
                self.phase = .connecting
                self.relayUrl = candidate
                let client: RelayTransportClient
                do {
                    client = try RelayTransportClient(identitySeed: self.identitySeed)
                } catch {
                    lastFailure = TransportErrorCopy.friendlyMessage(
                        for: error, relayUrl: candidate)
                    continue
                }
                self.client = client
                self.consumeEvents(of: client)
                var scoped = bootstrap
                scoped.relayUrl = candidate
                do {
                    try await client.scan(scoped)
                    try await client.connect()
                } catch {
                    lastFailure = TransportErrorCopy.friendlyMessage(
                        for: error, relayUrl: candidate)
                    continue
                }
                // Dial watchdog per candidate — `connect()` is fire-and-
                // forget and an unroutable dial BLACKHOLES instead of
                // erroring. Everything up to the 6-digit confirm code is
                // machine-speed, so still being in .connecting after the
                // candidate's budget means THIS door is dead → try the
                // next. A visible .error from THIS candidate's own events
                // is equally just this door failing — record it and walk
                // on. Only .awaitingMacConfirm/.connected end the walk.
                let budgetMs = RelayCandidates.dialTimeoutMs(for: candidate)
                var waitedMs = 0
                poll: while waitedMs < budgetMs {
                    await TWRetryDelay.sleep(milliseconds: 250)
                    waitedMs += 250
                    guard self.connectAttempt == attempt else { return }
                    switch self.phase {
                    case .connecting:
                        continue poll
                    case .error(let message):
                        lastFailure = message
                        continue walk
                    default:
                        return  // .awaitingMacConfirm / .connected — done
                    }
                }
                lastFailure = TransportErrorCopy.friendlyMessage(
                    for: NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut),
                    relayUrl: candidate)
            }
            guard self.connectAttempt == attempt else { return }
            self.teardown()
            self.phase = .error(
                lastFailure
                    ?? "Couldn't reach the Mac on any advertised address — refresh the QR and try again."
            )
        }
    }

    /// Trusted reconnect to the persisted Mac — resolves the live session id
    /// from the relay directory, no QR. The Mac pinned this phone's identity
    /// at first pairing, so it accepts silently (and denies anyone else).
    public func reconnectTrusted() {
        guard !isDemo else { return }  // demo is standalone — never auto-redial
        guard let record = pairingStore.load().selectedHost else { return }
        guard identityReady() else { return }
        #if DEBUG
            trustedReconnectDialsForTesting += 1
        #endif
        // A fresh walk supersedes any queued auto-retry (attempt count keeps
        // growing so the backoff curve survives across walks).
        cancelAutoReconnect(resetAttempts: false)
        // T70 — walk every door the pairing record knows. Wi-Fi stays LAN
        // first; cellular/expensive paths try the WSS front door first.
        let remoteFirst = preferRemoteRelayFirst(
            relayUrls: record.relayUrls, fallback: record.relayUrl)
        let preferredRelay =
            remoteFirst && RelayCandidates.isLocalCandidate(record.relayUrl) ? nil : record.relayUrl
        let candidates = RelayCandidates.ordered(
            from: record.relayUrls, fallback: record.relayUrl,
            preferRemoteFirst: remoteFirst,
            preferredFirst: preferredRelay)
        cancelSocketHealthCheck()
        teardown()
        macDisplayName = Self.sanitizedMacName(record.macDisplayName)
        pinnedMacIdentityB64 = record.macIdentityPubKey
        prepareHostProjectionOffline(hostIdentity: record.macIdentityPubKey)
        lastRelayUrls = record.relayUrls
        lastHostPlatform = record.hostPlatform
        relayUrl = record.relayUrl
        phase = .connecting
        connectAttempt += 1
        let attempt = connectAttempt
        trustedReconnectAttempt = attempt
        // Supervise this attempt against the walk it ACTUALLY performs, not a
        // single dial: the coordinator's default 15s was shorter than the
        // candidate walk below (5+5+12+12 = 34s for a LAN+relay pairing), so
        // any wake past 15s — and a foregrounded app issues plenty — read a
        // healthy in-flight walk as timed out and superseded it, tearing the
        // client down mid-establish and restarting from the first door.
        // Forever, until the user force-quit.
        reconnectCoordinator.markAttemptStarted(
            budgetSeconds: Double(RelayCandidates.walkBudgetMs(for: candidates)) / 1000)
        Task {
            var lastFailure: String? = nil
            var sawAtsSkip = false
            for candidate in candidates {
                guard self.connectAttempt == attempt else { return }
                if let problem = Self.cleartextRelayProblem(candidate) {
                    // A LAN ws:// door is simply invalid off-network —
                    // skip it and let the wss door take the dial.
                    sawAtsSkip = true
                    if lastFailure == nil { lastFailure = problem }
                    continue
                }
                // Fresh client per attempt — same cross-talk isolation
                // as the pairing walk (a dead door's late events and
                // stale established-timeout waiters must never touch
                // the live attempt).
                self.teardown()
                self.phase = .connecting
                let client: RelayTransportClient
                do {
                    client = try RelayTransportClient(identitySeed: self.identitySeed)
                } catch {
                    lastFailure = TransportErrorCopy.friendlyMessage(
                        for: error, relayUrl: candidate)
                    continue
                }
                self.client = client
                self.consumeEvents(of: client)
                do {
                    let budgetMs = RelayCandidates.dialTimeoutMs(for: candidate)
                    try await client.resolveAndScan(
                        relayUrl: candidate,
                        macIdentityPubKey: record.macIdentityPubKey,
                        timeoutMs: budgetMs)
                    try await client.connectAndWaitEstablished(timeoutMs: budgetMs)
                    // A newer attempt (e.g. switchHost(to: another host) or a
                    // fresh pairing) superseded us while we awaited establish —
                    // do NOT persist this host's door / clear the self-heal
                    // stamp under the new host's identity. Matches the guard the
                    // rest of the walk already enforces per candidate.
                    guard self.connectAttempt == attempt else { return }
                    self.relayUrl = candidate
                    self.trustedReconnectAttempt = nil
                    // Refresh the record so the v1 field tracks the
                    // door that actually works from here.
                    self.persistCurrentPairing()
                    return
                } catch {
                    lastFailure = TransportErrorCopy.friendlyMessage(
                        for: error, relayUrl: candidate)
                }
            }
            guard self.connectAttempt == attempt else { return }
            self.teardown()
            self.trustedReconnectAttempt = nil
            var detail =
                lastFailure
                ?? "Couldn't reach \(record.macDisplayName) — is TaskWraith running on your Mac?"
            // Old single-door record pinned to a home-network address
            // and we're not on it: re-pairing picks up the multi-door
            // bootstrap (new pairings carry both doors and never hit
            // this).
            if record.relayUrls?.isEmpty != false, sawAtsSkip || candidates.count == 1,
                let host = URL(string: record.relayUrl)?.host,
                Self.isLocalNetworkHost(host)
            {
                detail +=
                    " This pairing only knows a home-network address (\(host)); re-pair "
                    + "once with the Mac's current QR to add its Tailscale door."
            }
            self.phase = .error(detail)
            // FAILED, not merely finished: this arms the coordinator's redial
            // floor so the APNs backlog that follows a notification wake defers
            // to the ladder below instead of buying a walk per queued push.
            self.reconnectCoordinator.markAttemptFailed()
            // Self-heal: cold cellular launches race the VPN tunnel — keep
            // re-walking on a backoff (the path monitor also fires the
            // moment a new route appears, whichever comes first).
            self.scheduleAutoReconnect()
        }
    }

    /// Launch-time resume: silently try the stored pairing once.
    public func resumeIfIdle() {
        guard case .idle = phase, hasStoredPairing else { return }
        requestReconnect(.resume)
    }

    /// Foreground resume: iOS can leave a killed background socket looking
    /// connected until URLSession times out, so prove connected sockets with
    /// a short WebSocket ping and reconnect quickly on failure.
    public func reconnectIfStale() {
        requestReconnect(.foreground)
    }

    /// Single-flight reconnect entry — coalesces competing wakes via
    /// `ReconnectCoordinator`. Supersedes only on timeout / half-open-from-
    /// connected / explicit `.user` generation bump.
    public func requestReconnect(
        _ reason: ReconnectWakeReason,
        socketAlive: Bool? = nil
    ) {
        guard !isDemo else { return }
        guard hasStoredPairing else { return }
        let action = reconnectCoordinator.evaluate(
            reason: reason,
            phase: phase,
            socketAlive: socketAlive)
        switch action {
        case .ignore:
            return
        case .probeHealth:
            verifyConnectedSocket()
        case .start, .supersede:
            // Only an explicit user request earns a fresh fast retry ladder.
            // Resetting on EVERY dial pinned the documented 1.5s→30s backoff
            // at its first rung forever: each auto-retry went through here,
            // zeroed the counter, failed, and rescheduled at 1.5s — a
            // permanent flap rather than a curve that backs off. Success
            // resets it via cancelAutoReconnect(resetAttempts: true).
            if reason == .user { autoReconnectAttempt = 0 }
            reconnectTrusted()
        }
    }

    private func verifyConnectedSocket() {
        let attempt = connectAttempt
        Task { [weak self] in
            guard let self else { return }
            let probe = await self.probeConnectedHealth(peer: false)
            guard self.connectAttempt == attempt else { return }
            guard case .connected = self.phase else { return }
            // Socket is alive but the app was suspended and may have missed
            // pushes — rehydrate content instead of bare-returning (RC1). No
            // teardown on the alive path (keeps RC5 masked).
            guard !probe.alive else {
                self.rehydrateAfterAliveWake()
                return
            }
            // Half-open from connected — allowed supersede source (b).
            self.requestReconnect(.health, socketAlive: false)
        }
    }

    /// Single-flight health probe. Concurrent wake / foreground / action
    /// callers join the in-flight Task. A peer caller that joined a socket
    /// probe which came back alive still upgrades to `checkPeerAlive` (socket
    /// up != Mac awake); a dead socket is enough to skip the 6s peer ping.
    /// Evidence backing host-liveness (R1). Updated ONLY at the probe choke
    /// point below, from probes that already run — never from a send timeout,
    /// and never by initiating a probe of its own. The type and its evidence
    /// rule live in `HostLivenessPresentation.swift` beside the derivation they
    /// feed, where they are unit-testable without standing up a session.
    @Published private var hostLivenessProbeLedger = HostLivenessProbeLedger()

    /// Projected host liveness.
    ///
    /// Combines the true socket-vs-peer probe evidence with the live paired-host
    /// projection already owned by this model. Missing projection fields never
    /// become happy defaults; they degrade through `HostLiveness.derive`.
    public var hostLiveness: HostLiveness? {
        return HostLiveness.derive(
            sessionPhase: phase,
            projectionPhase: hostProjection.phase,
            healthProjection: hostProjection.health,
            probeLedger: hostLivenessProbeLedger)
    }

    /// Whether a composer send must be diverted into the offline outbox.
    ///
    /// Only the two states whose delivery path cannot presently be trusted
    /// divert. A stale projection is not itself evidence that sends are broken.
    public var shouldQueueOutboundSends: Bool {
        switch hostLiveness {
        case .asleep, .unreachable: return true
        case .live, .stale, .none: return false
        }
    }

    private var offlineOutboxHostIdentity: String?
    private var offlineOutboxDrainerStorage: OfflineOutboxDrainer?

    /// The outbox, PARTITIONED BY PAIRED-HOST IDENTITY.
    ///
    /// This used to be one global store on the standard defaults suite, which
    /// was a content-leak risk rather than an untidiness: queued prompts are
    /// addressed by thread id, thread ids are not unique across Macs, so a
    /// collision could have delivered one Mac's prompt text into a different
    /// Mac's thread. Partitioning removes that possibility structurally.
    ///
    /// Rebuilt when the pinned identity changes, so a host switch parks the
    /// previous Mac's prompts in ITS OWN partition rather than carrying them
    /// over to be refused. **Nothing is deleted on switch** — the old partition
    /// is still on disk and is re-adopted verbatim if that Mac is paired again.
    /// Silently dropping prompts the user pressed send on is precisely the loss
    /// this feature exists to prevent.
    ///
    /// Owns the drainer so its single-flight guard is real across calls.
    private var offlineOutboxDrainer: OfflineOutboxDrainer {
        // Unpaired gets its own partition rather than sharing a Mac's, so a
        // prompt typed before pairing can never be delivered against a thread
        // id that happens to match on the Mac paired afterwards.
        let identity = pinnedMacIdentityB64 ?? "unpaired"
        if let existing = offlineOutboxDrainerStorage, offlineOutboxHostIdentity == identity {
            return existing
        }
        let store = OfflineComposerQueueStore(hostIdentity: identity)
        let drainer = OfflineOutboxDrainer(queue: store.load(), store: store)
        offlineOutboxDrainerStorage = drainer
        offlineOutboxHostIdentity = identity
        return drainer
    }

    /// Prompts stranded in the pre-partition global outbox. Never adopted (we
    /// cannot know which Mac they were for) and never deleted. Surfaced so the
    /// user can be told they exist.
    public var offlineOutboxLegacyQuarantinedCount: Int {
        OfflineComposerQueueStore.legacyQuarantinedCount()
    }

    /// The quarantined prompts themselves, so a recovery surface can show the
    /// user what is stranded instead of only how much.
    ///
    /// FOLLOW-UP, named rather than implied: nothing renders these yet. Until
    /// something does, a user with legacy prompts can neither read them nor
    /// clear them — smaller than losing them, still not good enough. The UI
    /// belongs in the composer/settings surface, which this lane does not own.
    public var offlineOutboxLegacyQuarantinedPrompts: [QueuedComposerSend] {
        OfflineComposerQueueStore.legacyQuarantinedPrompts()
    }

    /// Accept a prompt the user pressed send on while the Mac was not
    /// answering. The returned outcome is NOT discardable — see the note on
    /// `OfflineComposerQueue.enqueue`; the caller must render every case.
    public func enqueueOfflinePrompt(threadId: String, text: String)
        -> OfflineComposerEnqueueOutcome
    {
        offlineOutboxDrainer.enqueue(
            id: UUID().uuidString, threadId: threadId, text: text, now: Date())
    }

    /// Surface these rather than letting the user discover the condition when a
    /// send is refused.
    public var offlineOutboxIsOverCapacity: Bool { offlineOutboxDrainer.queue.isOverCapacity }
    public var offlineOutboxOverflowCount: Int { offlineOutboxDrainer.queue.overflowCount }
    public func offlineOutboxCount(forThread threadId: String) -> Int {
        offlineOutboxDrainer.queue.count(forThread: threadId)
    }

    /// Deliver everything the outbox is holding, oldest first.
    ///
    /// ## What `.delivered` means here, precisely
    ///
    /// It means the prompt was handed to THE SAME send path a live composer send
    /// uses — not that the agent ran it. That is exactly the promise the outbox
    /// made ("this sends when your Mac answers"), and no more. If the Mac then
    /// refuses, the existing action-failure machinery reports it the same way it
    /// would for a prompt typed while online; the outbox does not claim an
    /// outcome it cannot observe.
    ///
    /// A thread that has vanished from the projection is reported `.rejected`
    /// rather than delivered — we can know that without asking, and silently
    /// dropping it would be the loss this whole type prevents.
    #if DEBUG
        /// Point the outbox at a scratch defaults suite.
        ///
        /// Still needed after per-host partitioning, for a narrower reason:
        /// unpaired test models all resolve to the same `"unpaired"` partition
        /// on the standard suite, so without this they would share one outbox.
        /// The first integration run of this file failed exactly that way,
        /// with prompts accumulating across tests (7, 8, 6…) — which was a real
        /// production finding, since it is what led to the partitioning above.
        func useOfflineOutboxStoreForTesting(_ store: OfflineComposerQueueStore) {
            offlineOutboxDrainerStorage = OfflineOutboxDrainer(
                queue: store.load(), store: store)
            // Pin the identity to whatever is current, so the partitioned
            // accessor treats the injected store as already-matching and does
            // not rebuild it out from under the test on first read.
            offlineOutboxHostIdentity = pinnedMacIdentityB64 ?? "unpaired"
        }

        /// Test seam replacing the real bridge send, so `flushOfflineOutbox` can
        /// be driven end to end without a transport.
        ///
        /// It exists because of a real defect: the drain's unit tests passed
        /// against an HONEST stub while the production closure could only ever
        /// answer `.delivered`. The protocol was tested; the wiring was not.
        var offlineOutboxSendOverrideForTesting:
            ((QueuedComposerSend) async -> OfflineOutboxDelivery)?
    #endif

    public func flushOfflineOutbox() async -> OfflineOutboxDrainReport {
        await offlineOutboxDrainer.drain { [weak self] entry in
            guard let self else { return .unreachable }
            #if DEBUG
                if let override = self.offlineOutboxSendOverrideForTesting {
                    return await override(entry)
                }
            #endif
            guard case .connected = self.phase else { return .unreachable }
            guard let card = self.taskCards.first(where: { $0.id == entry.threadId }) else {
                return .rejected("that conversation is no longer available")
            }
            return await self.deliverQueuedPrompt(entry, card: card)
        }
    }

    /// Deliver one queued prompt and WAIT for the Mac's verdict.
    ///
    /// The previous version called fire-and-forget `continueTask` and returned
    /// `.delivered` unconditionally, so the drainer removed the entry BEFORE any
    /// ack existed. Every later failure — a negative ack, a missing thread, a
    /// lost transport — landed after the prompt was already deleted, and
    /// `.rejected`/`.unreachable` were unreachable in production despite being
    /// covered by tests. Delivery is now judged BY THE ACK, which is the same
    /// doctrine `steerSoloLive` already documents.
    ///
    /// The three pre-checks are load-bearing, not defensive noise: they are
    /// exactly the `continueTask` early returns that fire NEITHER callback, and
    /// suspending on a continuation those paths can reach would wedge the drain
    /// permanently. Keep them in sync if that method grows another early exit.
    private func deliverQueuedPrompt(_ entry: QueuedComposerSend, card: RemoteTaskCard)
        async -> OfflineOutboxDelivery
    {
        if isDemo { return .rejected("demo mode does not send to a Mac") }
        guard card.threadId != nil else {
            return .rejected("that conversation is no longer available")
        }
        // Ensemble cards route without a provider — `continueTask` only demands
        // one on the non-ensemble branch, so demanding it here would refuse
        // sends the app would otherwise have made.
        if !card.isEnsemble, card.provider?.isEmpty != false {
            return .rejected("that conversation has no provider selected")
        }

        return await withCheckedContinuation { continuation in
            var settled = false
            let settle: (OfflineOutboxDelivery) -> Void = { value in
                guard !settled else { return }
                settled = true
                continuation.resume(returning: value)
            }
            // ONE callback. The previous version listened to `onActionUnsent`
            // AND `onActionAck` and tried to compose them; that could not work,
            // because one route fired neither on success and the other fired
            // them in an order that hid `.unreachable`. Classification now
            // happens where the outcome is known, not here.
            continueTask(
                card, prompt: entry.text,
                navigateOnAck: false,
                onActionDeliveryVerdict: { verdict in settle(verdict) })
        }
    }

    /// Drain hook for `applySessionEstablished`. Fire-and-forget, but the report
    /// is CONSUMED rather than discarded — a drain nobody hears about would be
    /// the same silent handling this feature exists to remove.
    private func scheduleOfflineOutboxFlush() {
        Task { [weak self] in
            guard let self else { return }
            let report = await self.flushOfflineOutbox()
            guard !report.isEmpty else { return }
            // Every bucket is surfaced, including DEFERRED. Reporting only
            // delivery and rejection left a mixed drain partly silent — the
            // user would be told two prompts sent and never learn three more
            // are still waiting.
            var parts: [String] = []
            if !report.delivered.isEmpty { parts.append("sent \(report.delivered.count)") }
            if let rejection = report.rejected.first {
                parts.append("\(report.rejected.count) refused (\(rejection.reason))")
            }
            if !report.deferred.isEmpty {
                parts.append("\(report.deferred.count) still waiting")
            }
            guard !parts.isEmpty else { return }
            self.lastActionMessage =
                "Prompts saved while your Mac wasn't answering — "
                + parts.joined(separator: ", ") + "."
        }
    }

    /// Surface an offline-outbox outcome through the existing action toast.
    /// A method rather than an exposed stored property, so the composer cannot
    /// accidentally clobber unrelated action copy.
    public func reportOfflineOutboxOutcome(_ message: String) {
        lastActionMessage = message
    }

    private func probeConnectedHealth(peer: Bool) async -> (alive: Bool, peer: Bool) {
        if let existing = socketHealthTask {
            let result = await existing.value
            if peer && !result.peer && result.alive {
                return await startConnectedHealthProbe(peer: true)
            }
            return result
        }
        return await startConnectedHealthProbe(peer: peer)
    }

    private func startConnectedHealthProbe(peer: Bool) async -> (alive: Bool, peer: Bool) {
        #if DEBUG
            if let override = healthProbeOverrideForTesting {
                return await runConnectedHealthProbe(peer: peer) {
                    await override()
                }
            }
        #endif
        guard let client else { return (false, peer) }
        let captured = client
        return await runConnectedHealthProbe(peer: peer) {
            if peer {
                return await captured.checkPeerAlive()
            }
            return await captured.checkSocketAlive()
        }
    }

    private func runConnectedHealthProbe(
        peer: Bool,
        body: @escaping @Sendable () async -> Bool
    ) async -> (alive: Bool, peer: Bool) {
        if let existing = socketHealthTask {
            return await existing.value
        }
        socketHealthProbeGeneration += 1
        let generation = socketHealthProbeGeneration
        #if DEBUG
            socketHealthProbeStartsForTesting += 1
        #endif
        let task = Task<(alive: Bool, peer: Bool), Never> {
            if Task.isCancelled { return (false, peer) }
            let alive = await body()
            return (alive, peer)
        }
        socketHealthTask = task
        let result = await task.value
        if socketHealthProbeGeneration == generation {
            socketHealthTask = nil
        }
        // R1: the ONLY place host-liveness evidence is gathered. Both probe
        // kinds funnel through here, so recording the outcome costs nothing and
        // adds no traffic. Wiring this to a send timeout instead would make
        // `.asleep` a guess again — see the ledger's evidence rule.
        hostLivenessProbeLedger.record(alive: result.alive, peer: result.peer, at: Date())
        return result
    }

    /// Single-flight latch for `requestFullProjection`. Reset via `defer` when the
    /// resync Task ends AND in `clearCachedProjectionState` on host switch — a
    /// stranded `true` would permanently wedge the resync seam (a reconnect bumps
    /// `connectAttempt`, aborting the in-flight retry loop), so both resets are
    /// load-bearing. Published so the RC3 empty-state retry button can show a
    /// spinner / disable while a resync is in flight (single source of truth — no
    /// second flag to latch).
    @Published public private(set) var fullProjectionResyncInFlight = false

    /// Slice 2 (RC1/RC2): pull the WHOLE home projection from the Mac. The client
    /// otherwise has no way to re-request the home list — it depends entirely on an
    /// unsolicited Mac push it may have missed while suspended. Fire-and-forget,
    /// single-flight, `connectAttempt`-guarded, with a small bounded retry so a
    /// dropped ack self-heals. The Mac's re-pushed snapshot frames are ingested by
    /// the existing NON-destructive `bridge.broadcastWorkspaceList` /
    /// `broadcastThreadList` / `broadcastRemoteProjectionSnapshot` handlers, so this
    /// only drives the request + retry, never a decode path of its own. No teardown
    /// is ever forced here (that would expose the RC5 one-shot drop).
    public func requestFullProjection() {
        guard !isDemo, let client, case .connected = phase else { return }
        guard !fullProjectionResyncInFlight else { return }
        fullProjectionResyncInFlight = true
        let attempt = connectAttempt
        Task { [weak self] in
            defer { self?.fullProjectionResyncInFlight = false }
            var backoffNs: UInt64 = 400_000_000
            for _ in 0..<3 {
                guard let self, self.connectAttempt == attempt, case .connected = self.phase
                else { return }
                // FRESH actionId per attempt (the default UUID) so a retry is not
                // dropped by the Mac's per-pair replay guard.
                let ack = try? await client.requestSerialized(
                    "bridge.requestActionAck",
                    paramsData: JSONSerialization.data(
                        withJSONObject: BridgeAction.fullProjectionResync()),
                    timeoutMs: 10_000)
                if Self.fullProjectionResyncSucceeded(ack) { return }
                guard Self.fullProjectionResyncShouldRetry(ack: ack, phase: self.phase) else {
                    return
                }
                await TWRetryDelay.sleep(nanoseconds: backoffNs)
                backoffNs *= 2
            }
        }
    }

    /// Pure: the resync ack succeeded (the Mac accepted + re-pushed).
    nonisolated static func fullProjectionResyncSucceeded(_ ack: AckResult?) -> Bool {
        ack?.ok == true
    }

    /// Pure: retry only while still connected, and only on a transient failure
    /// (nil = the request threw / no ack, or an explicit "timeout"). A hard reject
    /// (the Mac answered `ok:false` for another reason) is NOT retried.
    nonisolated static func fullProjectionResyncShouldRetry(
        ack: AckResult?, phase: SessionPhase
    ) -> Bool {
        guard case .connected = phase else { return false }
        guard let ack else { return true }
        if ack.ok { return false }
        return ack.error == "timeout"
    }

    // ── Slice 3 (RC1): alive-wake targeted rehydration ─────────────────────────
    /// Timestamp (ms since epoch) of the last alive-wake rehydrate; 0 = never.
    /// Debounces back-to-back foregrounds / the error-banner retry so a trivial
    /// app-switch doesn't re-pull the whole projection every time.
    private var lastAliveResyncMs: Double = 0
    private static let aliveResyncMinGapMs: Double = 4_000
    /// Reasons `handleRemoteWake` must NOT rehydrate on. The approval-ack path
    /// runs inside a tight OS background-execution budget (a resync could time out
    /// the ack), and the silent-push path runs OUTSIDE the background assertion (a
    /// resync there is wasted / half-run). Genuine foreground (verifyConnectedSocket,
    /// no reason) and a user tap ("notification-tap") DO rehydrate.
    static let approvalAckWakeReason = "notification-action"
    static let silentPushWakeReason = "remote-notification"
    /// App Group / suite flag so a cold launch with a stored pairing can keep
    /// ConnectedShell mounted (`showShellDuringDrop`) instead of flashing PairingView.
    static let wasEverConnectedDefaultsKey = "tw.wasEverConnected.v1"

    static func shouldRehydrateAfterWake(reason: String) -> Bool {
        reason != approvalAckWakeReason && reason != silentPushWakeReason
    }

    #if DEBUG
        private(set) var aliveRehydrateInvocationsForTesting = 0
        static var aliveResyncMinGapMsForTesting: Double { aliveResyncMinGapMs }
    #endif

    /// Pure: has enough time passed since the last alive-wake resync to fire again?
    nonisolated static func shouldRehydrateOnAliveWake(
        nowMs: Double, lastMs: Double, minGapMs: Double
    ) -> Bool {
        lastMs <= 0 || (nowMs - lastMs) >= minGapMs
    }

    /// Slice 3 (RC1): the alive-ping fast paths (foreground scenePhase.active via
    /// `verifyConnectedSocket`, and a user notification tap via `handleRemoteWake`)
    /// used to bare-return on the pre-background cache, doing ZERO content
    /// rehydration — the dominant reconnect-blank/stale path. This drives a
    /// lightweight, debounced rehydrate instead: a full-projection resync (Slice 2)
    /// for the home list plus a refresh of the visible thread's transcript.
    /// Fire-and-forget (never awaits, never blocks an approval ack) and never forces
    /// a teardown (which would expose the RC5 one-shot drop). The visible-thread pull
    /// bypasses stream-suppression ONLY when that thread is not mid-stream, so a live
    /// turn is never clobbered.
    private func rehydrateAfterAliveWake() {
        guard !isDemo, case .connected = phase else { return }
        let nowMs = Date().timeIntervalSince1970 * 1000
        guard
            Self.shouldRehydrateOnAliveWake(
                nowMs: nowMs, lastMs: lastAliveResyncMs, minGapMs: Self.aliveResyncMinGapMs)
        else { return }
        lastAliveResyncMs = nowMs
        #if DEBUG
            aliveRehydrateInvocationsForTesting += 1
        #endif
        requestFullProjection()
        hostProjection.requestFullSnapshot()
        if let tid = visibleThreadId {
            requestThreadSnapshot(tid, bypassVisibleStreamSuppression: streamingRunIds[tid] == nil)
        }
    }

    // ── Slice 4 (RC3): hydration-signal split + retry ──────────────────────────
    /// Real content arrived — end BOTH the "Syncing…" spinner (`projectionHydrated`,
    /// which also releases the preset-settling window) and the RC3 presumed-empty
    /// state (`projectionGraceExpired`) in the SAME pass so the UI never renders a
    /// frame with only one flag flipped.
    private func markProjectionContentHydrated() {
        if !projectionHydrated { projectionHydrated = true }
        if !projectionGraceExpired { projectionGraceExpired = true }
    }

    /// The empty-state presentations for the home list.
    public enum ProjectionEmptyPresentation: Equatable, Sendable {
        /// Still within the post-establish grace window — may just be loading.
        /// Show a spinner + a "Check now" affordance.
        case presumed
        /// Grace expired with nothing shared — show the setup instructions + a
        /// "Check again" affordance.
        case confirmed
    }

    /// Pure: the empty-state presentation, or nil when content exists.
    nonisolated static func projectionEmptyPresentation(
        hasWorkspaces: Bool, hasTaskCards: Bool, graceExpired: Bool
    ) -> ProjectionEmptyPresentation? {
        if hasWorkspaces || hasTaskCards { return nil }
        return graceExpired ? .confirmed : .presumed
    }

    /// Pure: the 5s grace timer may only confirm-empty if it belongs to the CURRENT
    /// connection and we are still connected — a superseded reconnect's timer must
    /// not latch the flag for a newer, still-loading connection.
    nonisolated static func shouldConfirmProjectionEmpty(
        timerConnectAttempt: Int, currentConnectAttempt: Int, isConnected: Bool
    ) -> Bool {
        timerConnectAttempt == currentConnectAttempt && isConnected
    }

    /// Slice 4 (RC3): user tapped "Check again" / "Check now" from the empty or
    /// loading state. If the session dropped, reconnect; otherwise pull the full
    /// projection + refresh the visible thread. Single-flight is owned by
    /// `requestFullProjection`'s latch, so a double-tap coalesces to one request
    /// and the button's spinner is driven off `fullProjectionResyncInFlight`.
    public func retryProjectionSync() {
        guard case .connected = phase else {
            reconnectIfStale()
            return
        }
        requestFullProjection()
        hostProjection.requestFullSnapshot()
        if let tid = visibleThreadId {
            requestThreadSnapshot(tid, bypassVisibleStreamSuppression: streamingRunIds[tid] == nil)
        }
    }

    public func disconnect() {
        cancelAutoReconnect(resetAttempts: true)
        cancelSocketHealthCheck()
        cancelDelayedSocketClosedReconnect()
        trustedReconnectAttempt = nil
        // Invalidate in-flight `reconnectTrusted` walks (they key off this
        // generation) and drop coordinator bookkeeping so a later genuine wake
        // is `.start`, not `.supersede` against a ghost flight.
        connectAttempt += 1
        reconnectCoordinator.invalidate()
        teardown()
        phase = .idle
        taskCards = []
        approvals = []
        questions = []
        repliedApprovalToolCallIds = []
        repliedQuestionIds = []
    }

    /// Drop the stored pairing entirely (the Mac keeps its pin until the user
    /// revokes it there; re-pairing with the same identity reuses it).
    // ── Demo mode (App Review / first-look) ───────────────────────────────────
    /// Enter an OFFLINE demo session populated with canned data so the app can be
    /// explored — and App Review can exercise it — WITHOUT pairing to a Mac. No
    /// network client is connected (so `send(_:)` is inert) and `isDemo` drives a
    /// banner. `exitDemoMode()` restores the pairing screen.
    public func enterDemoMode() {
        // Sever any live session FIRST so the demo is truly standalone — no real
        // projection can bleed in, and the auto-reconnect lifecycle can't redial
        // the Mac under the demo banner (reconnectTrusted + persistCurrentPairing
        // are also guarded on !isDemo).
        disconnect()
        clearCachedProjectionState()
        let workspacesJSON = """
        [{"workspaceId":"demo-ws","displayName":"Demo Project","path":"~/Developer/taskwraith-demo","chatCount":3,"capabilities":{"diffReview":true,"fileBrowse":true,"fileRead":true,"fileWrite":true,"externalPublish":true}}]
        """
        let cardsJSON = """
        [
          {"id":"demo-1","title":"Refactor the auth module","provider":"claude","workspaceId":"demo-ws","threadId":"demo-1","status":"idle","chatKind":"single","updatedAt":"2026-06-19T10:42:00Z","pendingApprovalCount":1},
          {"id":"demo-2","title":"Plan the v2 public API","provider":"claude","workspaceId":"demo-ws","threadId":"demo-2","status":"idle","chatKind":"ensemble","updatedAt":"2026-06-19T09:30:00Z"},
          {"id":"demo-3","title":"Fix the flaky upload test","provider":"codex","workspaceId":"demo-ws","threadId":"demo-3","status":"idle","chatKind":"single","updatedAt":"2026-06-18T17:05:00Z"},
          {"id":"demo-1-sub1","title":"Map the auth call sites","provider":"claude","workspaceId":"demo-ws","threadId":"demo-1-sub1","parentChatId":"demo-1","parentChatRelation":"subThread","agentName":"Dexterman","agentSlug":"dexterman","agentAccent":"#C8DD2C","status":"done","chatKind":"single","updatedAt":"2026-06-19T10:38:00Z"},
          {"id":"demo-1-sub2","title":"Write refresh + expiry tests","provider":"codex","workspaceId":"demo-ws","threadId":"demo-1-sub2","parentChatId":"demo-1","parentChatRelation":"subThread","agentName":"Roboteknik","agentSlug":"roboteknik","agentAccent":"#2C9CDD","status":"done","chatKind":"single","updatedAt":"2026-06-19T10:41:00Z"},
          {"id":"demo-2-sub1","title":"Survey REST pagination patterns","provider":"claude","workspaceId":"demo-ws","threadId":"demo-2-sub1","parentChatId":"demo-2","parentChatRelation":"subThread","agentName":"Imhotep","agentSlug":"imhotep","agentAccent":"#2C5EDD","status":"done","chatKind":"single","updatedAt":"2026-06-19T09:24:00Z"},
          {"id":"demo-3-sub1","title":"Bisect the flaky run","provider":"codex","workspaceId":"demo-ws","threadId":"demo-3-sub1","parentChatId":"demo-3","parentChatRelation":"subThread","agentName":"Jim The Mage","agentSlug":"jim-the-mage","agentAccent":"#2C8DDD","status":"done","chatKind":"single","updatedAt":"2026-06-18T16:58:00Z"},
          {"id":"demo-1-sc1","title":"jose vs jsonwebtoken?","provider":"codex","workspaceId":"demo-ws","threadId":"demo-1-sc1","parentChatId":"demo-1","parentChatRelation":"sideChat","status":"idle","chatKind":"single","updatedAt":"2026-06-19T10:39:00Z"},
          {"id":"demo-2-sc1","title":"Cursor vs offset pagination?","provider":"claude","workspaceId":"demo-ws","threadId":"demo-2-sc1","parentChatId":"demo-2","parentChatRelation":"sideChat","status":"idle","chatKind":"single","updatedAt":"2026-06-19T09:26:00Z"},
          {"id":"demo-3-sc1","title":"Is the flush race in the S3 client?","provider":"claude","workspaceId":"demo-ws","threadId":"demo-3-sc1","parentChatId":"demo-3","parentChatRelation":"sideChat","status":"idle","chatKind":"single","updatedAt":"2026-06-18T17:02:00Z"}
        ]
        """
        let snap1JSON = """
        {"threadId":"demo-1","workspaceId":"demo-ws","provider":"claude","totalRows":4,
         "notes":"## Auth refactor\\n- Migrate call sites to `TokenService`\\n- Cover refresh + expiry with unit tests\\n- Keep the public `login()` signature stable",
         "runSummary":{"runId":"demo-run-1","provider":"claude","model":"claude-sonnet-5","status":"done","durationMs":84000,"totalTokens":18420,"tokensIn":12010,"tokensOut":6410,"costText":"$0.21","fileChanges":{"filesChanged":3,"additions":178,"deletions":42,"createdFiles":1,"modifiedFiles":2,"deletedFiles":0,"files":[{"path":"auth/TokenService.ts","status":"modified","additions":96,"deletions":12},{"path":"auth/index.ts","status":"modified","additions":18,"deletions":30},{"path":"auth/TokenService.test.ts","status":"added","additions":64,"deletions":0}]}},
         "blackboardEntries":[
           {"id":"bb-1-1","key":"Token strategy","value":"Use the new TokenService for all auth refresh paths.","category":"decision","scope":"thread","createdAt":"2026-06-19T10:41:30Z"},
           {"id":"bb-1-2","key":"Refresh window","value":"Access tokens expire in 15m; refresh tokens in 30d.","category":"fact","scope":"thread","createdAt":"2026-06-19T10:41:40Z"},
           {"id":"bb-1-3","key":"Clock skew","value":"Allow 60s skew when validating exp to avoid false expiries.","category":"risk","scope":"thread","createdAt":"2026-06-19T10:41:50Z"}
         ],
         "pinnedRows":[
           {"id":"r2","role":"assistant","kind":"message","speaker":"Claude","preview":"I'll split auth into a TokenService, migrate the call sites, and add unit tests for refresh + expiry. Starting with the service.","timestamp":"2026-06-19T10:41:00Z"}
         ],
         "rows":[
          {"id":"r1","role":"user","kind":"message","preview":"Refactor the auth module to use the new TokenService and add tests.","timestamp":"2026-06-19T10:40:00Z"},
          {"id":"r2","role":"assistant","kind":"message","speaker":"Claude","preview":"I'll split auth into a TokenService, migrate the call sites, and add unit tests for refresh + expiry. Starting with the service.","timestamp":"2026-06-19T10:41:00Z"},
          {"id":"r2b","role":"assistant","kind":"message","speaker":"Claude","preview":"Added to blackboard — Decision: Use the new TokenService for all auth refresh paths.","timestamp":"2026-06-19T10:41:35Z"},
          {"id":"r3","role":"assistant","kind":"tool","preview":"Edited 2 files (+114 −42)","timestamp":"2026-06-19T10:42:00Z","toolSummary":{"activityCount":2,"status":"done","tools":[{"name":"Edit auth/TokenService.ts","category":"file","status":"done","file":"auth/TokenService.ts","additions":96,"deletions":12},{"name":"Edit auth/index.ts","category":"file","status":"done","file":"auth/index.ts","additions":18,"deletions":30}]}}
        ]}
        """
        let snap2JSON = """
        {"threadId":"demo-2","workspaceId":"demo-ws","provider":"claude","totalRows":4,
         "notes":"## v2 API plan\\n- Resource-oriented endpoints\\n- Cursor pagination across list endpoints\\n- Typed error envelope\\n- Idempotency keys on POST",
         "runSummary":{"runId":"demo-run-2","provider":"claude","model":"claude-sonnet-5","status":"done","durationMs":146000,"totalTokens":31200,"tokensIn":19800,"tokensOut":11400,"costText":"$0.38","fileChanges":{"filesChanged":2,"additions":286,"deletions":4,"createdFiles":2,"modifiedFiles":0,"deletedFiles":0,"files":[{"path":"docs/api-v2.md","status":"added","additions":132,"deletions":0},{"path":"openapi/v2.yaml","status":"added","additions":154,"deletions":4}]}},
         "blackboardEntries":[
           {"id":"bb-2-1","key":"Versioning","value":"Version in the path: /v2/…","category":"decision","scope":"ensemble","createdAt":"2026-06-19T09:27:10Z"},
           {"id":"bb-2-2","key":"Pagination","value":"Cursor-based pagination across all list endpoints.","category":"decision","scope":"ensemble","createdAt":"2026-06-19T09:27:20Z"},
           {"id":"bb-2-3","key":"Idempotency","value":"Require an Idempotency-Key header on every POST.","category":"decision","scope":"ensemble","participantId":"p-codex","createdAt":"2026-06-19T09:29:10Z"},
           {"id":"bb-2-4","key":"v1 envelope","value":"v1 error shape differs — do not reuse the v1 envelope in v2.","category":"do-not-repeat","scope":"ensemble","createdAt":"2026-06-19T09:29:20Z"}
         ],
         "pinnedRows":[
           {"id":"e2","role":"assistant","kind":"message","speaker":"Claude / Architect","preview":"Resource-oriented endpoints, cursor pagination, and explicit versioning in the path.","timestamp":"2026-06-19T09:27:00Z"}
         ],
         "rows":[
          {"id":"e1","role":"user","kind":"message","preview":"Draft the v2 public API surface — two perspectives, please.","timestamp":"2026-06-19T09:25:00Z"},
          {"id":"e2","role":"assistant","kind":"message","speaker":"Claude / Architect","preview":"Resource-oriented endpoints, cursor pagination, and explicit versioning in the path.","timestamp":"2026-06-19T09:27:00Z"},
          {"id":"e3","role":"assistant","kind":"message","speaker":"Codex / Implementer","preview":"Agreed — add idempotency keys on POST and a typed error envelope so clients can branch safely.","timestamp":"2026-06-19T09:29:00Z"},
          {"id":"e3b","role":"assistant","kind":"message","speaker":"Codex / Implementer","preview":"Added to blackboard — Decision: Require an Idempotency-Key header on every POST.","timestamp":"2026-06-19T09:29:30Z"}
        ]}
        """
        let snap3JSON = """
        {"threadId":"demo-3","workspaceId":"demo-ws","provider":"codex","totalRows":3,
         "notes":"## Flaky upload test\\n- Race between assert and buffer flush\\n- Fix: await flush + deterministic clock\\n- Verified green across 200 runs",
         "runSummary":{"runId":"demo-run-3","provider":"codex","model":"gpt-5.5","status":"done","durationMs":52000,"totalTokens":9600,"tokensIn":6400,"tokensOut":3200,"costText":"$0.09","fileChanges":{"filesChanged":2,"additions":40,"deletions":10,"createdFiles":0,"modifiedFiles":2,"deletedFiles":0,"files":[{"path":"src/upload/uploader.ts","status":"modified","additions":12,"deletions":4},{"path":"test/upload.test.ts","status":"modified","additions":28,"deletions":6}]}},
         "blackboardEntries":[
           {"id":"bb-3-1","key":"Root cause","value":"Test asserted before the upload buffer drained.","category":"fact","scope":"thread","createdAt":"2026-06-18T17:04:30Z"},
           {"id":"bb-3-2","key":"Fix","value":"Await the flush promise; inject a deterministic clock.","category":"decision","scope":"thread","createdAt":"2026-06-18T17:04:40Z"},
           {"id":"bb-3-3","key":"Flake guard","value":"Never assert on wall-clock timing in CI.","category":"do-not-repeat","scope":"thread","createdAt":"2026-06-18T17:04:50Z"}
         ],
         "pinnedRows":[
           {"id":"s2","role":"assistant","kind":"message","speaker":"Codex","preview":"The test asserted before the buffer drained. I awaited the flush promise and used a deterministic clock — green across 200 runs.","timestamp":"2026-06-18T17:05:00Z"}
         ],
         "rows":[
          {"id":"s1","role":"user","kind":"message","preview":"The upload test fails intermittently in CI. Find and fix the race.","timestamp":"2026-06-18T17:00:00Z"},
          {"id":"s2","role":"assistant","kind":"message","speaker":"Codex","preview":"The test asserted before the buffer drained. I awaited the flush promise and used a deterministic clock — green across 200 runs.","timestamp":"2026-06-18T17:05:00Z"},
          {"id":"s2b","role":"assistant","kind":"message","speaker":"Codex","preview":"Added to blackboard — Fact: Test asserted before the upload buffer drained.","timestamp":"2026-06-18T17:05:10Z"}
        ]}
        """
        // Demo catalog must cover every provider the demo notice advertises.
        // AntiGravity is NOT in the static live set — dynamic admission needs a
        // nonempty catalog (TWTheme.isProviderOfferedByModelCatalog). Kimi is
        // live-selectable but still needs models so the demo picker is usable.
        // AGY IDs/labels mirror AntigravityGeminiApiStaticModels (`gemini-api:`
        // prefix). Kimi IDs/labels mirror StaticProviderModels KIMI_STATIC_MODELS
        // (kimi-k3 / kimi-k3-256k / kimi-k2.7-code label "K2.7 Coding"; Highspeed is a speed
        // tier, not the model label).
        // Reasoning tiers + Fast-capable ids mirror the real catalogs so the
        // combined picker's ladder / Fast pill / bolt markers all light up in
        // the demo (they'd otherwise be invisible until a Mac pairs).
        let providerModelsJSON = """
        {"claude":[{"id":"claude-opus-5","label":"Opus 5","supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"medium"},{"reasoningEffort":"high"},{"reasoningEffort":"xhigh"},{"reasoningEffort":"max"}],"defaultReasoningEffort":"medium"},{"id":"claude-fable-5","label":"Fable 5","supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"medium"},{"reasoningEffort":"high"},{"reasoningEffort":"xhigh"},{"reasoningEffort":"max"},{"reasoningEffort":"ultracode"}],"defaultReasoningEffort":"high"},{"id":"claude-sonnet-5","label":"Sonnet 5","isDefault":true,"supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"medium"},{"reasoningEffort":"high"},{"reasoningEffort":"xhigh"},{"reasoningEffort":"max"}],"defaultReasoningEffort":"medium"}],"codex":[{"id":"gpt-5.5","label":"GPT-5.5","isDefault":true,"supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"medium"},{"reasoningEffort":"high"},{"reasoningEffort":"xhigh"}],"defaultReasoningEffort":"medium"},{"id":"gpt-5.6-sol","label":"GPT-5.6-Sol","supportedReasoningEfforts":[{"reasoningEffort":"medium"},{"reasoningEffort":"high"},{"reasoningEffort":"xhigh"},{"reasoningEffort":"ultracode"}],"defaultReasoningEffort":"high"}],"kimi":[{"id":"kimi-k2.7-code","label":"K2.7 Coding","isDefault":true,"supportedReasoningEfforts":[{"reasoningEffort":"on"}],"defaultReasoningEffort":"on"},{"id":"kimi-k3","label":"K3 (1M)","supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"high"},{"reasoningEffort":"max"}],"defaultReasoningEffort":"max"},{"id":"kimi-k3-256k","label":"K3 (256K)","supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"high"},{"reasoningEffort":"max"}],"defaultReasoningEffort":"max"}],"antigravity":[{"id":"gemini-api:gemini-3.1-pro","label":"Gemini 3.1 Pro","isDefault":true},{"id":"gemini-api:gemini-3.1-flash-lite","label":"Gemini 3.1 Flash-Lite"},{"id":"gemini-api:gemini-2.5-pro","label":"Gemini 2.5 Pro"},{"id":"gemini-api:gemini-2.5-flash","label":"Gemini 2.5 Flash"}],"cursor":[{"id":"composer-2.5","label":"Composer 2.5","isDefault":true},{"id":"composer-2.5-fast","label":"Composer 2.5 Fast"},{"id":"grok-4.6","label":"Cursor Grok 4.6","supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"medium"},{"reasoningEffort":"high"},{"reasoningEffort":"xhigh"}],"defaultReasoningEffort":"high"},{"id":"cursor-grok-4.5","label":"Grok 4.5"}],"grok":[{"id":"grok-4.6","label":"Grok 4.6 Fast","isDefault":true,"supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"medium"},{"reasoningEffort":"high"},{"reasoningEffort":"xhigh"}],"defaultReasoningEffort":"high"},{"id":"grok-4.5","label":"Grok 4.5"},{"id":"grok-4.5-mini","label":"Grok 4.5 Mini"}],"ollama":[{"id":"qwen3:4b-instruct","label":"Qwen 3 (4B Param)","isDefault":true}]}
        """
        let workflowsJSON = """
        [
          {"id":"demo-wf-1","name":"Nightly test sweep","workspaceId":"demo-ws","threadId":"demo-3","provider":"codex","enabled":true,"schedule":"Daily 02:00","status":"completed","nextRunAt":"2026-06-20T02:00:00Z","lastRunAt":"2026-06-19T02:00:00Z"},
          {"id":"demo-wf-2","name":"Auth audit on demand","workspaceId":"demo-ws","threadId":"demo-1","provider":"claude","enabled":false,"schedule":"Manual","status":"idle"}
        ]
        """
        if let ws = Self.decodeDemo([WorkspaceSummary].self, workspacesJSON) { workspaces = ws }
        if let cards = Self.decodeDemo([RemoteTaskCard].self, cardsJSON) { taskCards = cards }
        if let wf = Self.decodeDemo([RemoteWorkflow].self, workflowsJSON) { workflows = wf }
        if let s1 = Self.decodeDemo(RemoteThreadSnapshot.self, snap1JSON) { threadSnapshots["demo-1"] = s1 }
        if let s2 = Self.decodeDemo(RemoteThreadSnapshot.self, snap2JSON) { threadSnapshots["demo-2"] = s2 }
        if let s3 = Self.decodeDemo(RemoteThreadSnapshot.self, snap3JSON) { threadSnapshots["demo-3"] = s3 }
        if var pm = Self.decodeDemo([String: [ModelOption]].self, providerModelsJSON) {
            // Keep the offline demo on the same provider-facing ids as the Mac
            // fallback catalogue. The canned JSON predates Cursor's base-id
            // normalization and the current direct Grok catalogue, so replace
            // only those two groups after decoding.
            pm["cursor"] = [
                ModelOption(id: "composer-2.5-fast", label: "Composer 2.5 Fast", isDefault: true),
                ModelOption(id: "composer-2.5", label: "Composer 2.5"),
                ModelOption(
                    id: "grok-4.6",
                    label: "Cursor Grok 4.6",
                    supportedReasoningEfforts: [
                        ReasoningEffortOption(reasoningEffort: "low"),
                        ReasoningEffortOption(reasoningEffort: "medium"),
                        ReasoningEffortOption(reasoningEffort: "high"),
                        ReasoningEffortOption(reasoningEffort: "xhigh"),
                    ],
                    defaultReasoningEffort: "high"),
                ModelOption(
                    id: "grok-4.5",
                    label: "Cursor Grok 4.5",
                    supportedReasoningEfforts: [
                        ReasoningEffortOption(reasoningEffort: "low"),
                        ReasoningEffortOption(reasoningEffort: "medium"),
                        ReasoningEffortOption(reasoningEffort: "high"),
                    ],
                    defaultReasoningEffort: "high"),
            ]
            pm["grok"] = [
                ModelOption(
                    id: "grok-4.6",
                    label: "Grok 4.6 Fast",
                    isDefault: true,
                    supportedReasoningEfforts: [
                        ReasoningEffortOption(reasoningEffort: "low"),
                        ReasoningEffortOption(reasoningEffort: "medium"),
                        ReasoningEffortOption(reasoningEffort: "high"),
                        ReasoningEffortOption(reasoningEffort: "xhigh"),
                    ],
                    defaultReasoningEffort: "high"),
                ModelOption(
                    id: "grok-4.5",
                    label: "Grok 4.5 Fast",
                    supportedReasoningEfforts: [
                        ReasoningEffortOption(reasoningEffort: "low"),
                        ReasoningEffortOption(reasoningEffort: "medium"),
                        ReasoningEffortOption(reasoningEffort: "high"),
                    ],
                    defaultReasoningEffort: "high"),
                ModelOption(id: "grok-composer-2.5-fast", label: "Grok Composer 2.5 Fast"),
            ]
            providerModels = pm
        }
        let approvalsJSON = """
        [{"toolCallId":"demo-appr-1","title":"Run the auth test suite","body":"npm test -- auth/TokenService","provider":"claude","actions":["accept","decline"],"workspaceId":"demo-ws","threadId":"demo-1","runId":"demo-run-1","requestedAt":"2026-06-19T10:43:00Z"}]
        """
        let ensembleJSON = """
        {"threadId":"demo-2","status":"idle","activeParticipantId":"p-claude","bossmanParticipantId":"p-claude","participants":[{"participantId":"p-claude","provider":"claude","role":"Architect","order":1,"status":"done"},{"participantId":"p-codex","provider":"codex","role":"Implementer","order":2,"status":"done"},{"participantId":"p-kimi","provider":"kimi","role":"Reviewer","order":3,"status":"idle"}],"roster":[{"id":"p-claude","provider":"claude","role":"Architect","enabled":true,"order":1,"model":"claude-sonnet-5","reasoningEffort":"medium","isBossman":true},{"id":"p-codex","provider":"codex","role":"Implementer","enabled":true,"order":2,"model":"gpt-5.5","reasoningEffort":"high"},{"id":"p-kimi","provider":"kimi","role":"Reviewer","enabled":true,"order":3,"model":"kimi-k3","reasoningEffort":"low","thinkingEnabled":true}]}
        """
        if let appr = Self.decodeDemo([MobileApprovalCard].self, approvalsJSON) { approvals = appr }
        if let ens = Self.decodeDemo(RemoteEnsembleState.self, ensembleJSON) { ensembleStates["demo-2"] = ens }

        // — Inspector · Changes tab — per-thread diff summaries —
        let diffsJSON = """
        {
         "demo-1":{"threadId":"demo-1","runId":"demo-run-1","filesChanged":3,"additions":178,"deletions":42,"createdFiles":1,"modifiedFiles":2,"deletedFiles":0,"files":[{"path":"auth/TokenService.ts","status":"modified","additions":96,"deletions":12},{"path":"auth/index.ts","status":"modified","additions":18,"deletions":30},{"path":"auth/TokenService.test.ts","status":"added","additions":64,"deletions":0}]},
         "demo-2":{"threadId":"demo-2","runId":"demo-run-2","filesChanged":2,"additions":286,"deletions":4,"createdFiles":2,"modifiedFiles":0,"deletedFiles":0,"files":[{"path":"docs/api-v2.md","status":"added","additions":132,"deletions":0},{"path":"openapi/v2.yaml","status":"added","additions":154,"deletions":4}]},
         "demo-3":{"threadId":"demo-3","runId":"demo-run-3","filesChanged":2,"additions":40,"deletions":10,"createdFiles":0,"modifiedFiles":2,"deletedFiles":0,"files":[{"path":"src/upload/uploader.ts","status":"modified","additions":12,"deletions":4},{"path":"test/upload.test.ts","status":"modified","additions":28,"deletions":6}]}
        }
        """
        if let diffs = Self.decodeDemo([String: MobileDiffSummary].self, diffsJSON) { diffSummaries = diffs }

        // — Inspector · Agents + Side-chats — child thread snapshots so any
        //   sub-agent / side chat opens inline with real content. —
        let childSnapsJSON: [String: String] = [
          "demo-1-sub1": #"{"threadId":"demo-1-sub1","workspaceId":"demo-ws","provider":"claude","totalRows":2,"rows":[{"id":"a11","role":"user","kind":"message","preview":"Map every call site that builds or verifies a JWT."},{"id":"a12","role":"assistant","kind":"message","speaker":"Dexterman","preview":"Found 7 call sites across auth/, api/middleware/ and jobs/ — each listed with a line reference."}]}"#,
          "demo-1-sub2": #"{"threadId":"demo-1-sub2","workspaceId":"demo-ws","provider":"codex","totalRows":2,"rows":[{"id":"a21","role":"user","kind":"message","preview":"Write unit tests for token refresh and expiry."},{"id":"a22","role":"assistant","kind":"message","speaker":"Roboteknik","preview":"Added 9 tests covering refresh rotation, expiry and 60s clock skew. All green locally."}]}"#,
          "demo-2-sub1": #"{"threadId":"demo-2-sub1","workspaceId":"demo-ws","provider":"claude","totalRows":2,"rows":[{"id":"a31","role":"user","kind":"message","preview":"Survey how Stripe, GitHub and Linear paginate their list APIs."},{"id":"a32","role":"assistant","kind":"message","speaker":"Imhotep","preview":"All three use cursor pagination with opaque tokens; GitHub also exposes RFC-5988 Link headers."}]}"#,
          "demo-3-sub1": #"{"threadId":"demo-3-sub1","workspaceId":"demo-ws","provider":"codex","totalRows":2,"rows":[{"id":"a41","role":"user","kind":"message","preview":"Bisect to the commit that introduced the flake."},{"id":"a42","role":"assistant","kind":"message","speaker":"Jim The Mage","preview":"First flaky at a3f9c1 — the change that moved the assert ahead of the awaited flush."}]}"#,
          "demo-1-sc1": #"{"threadId":"demo-1-sc1","workspaceId":"demo-ws","provider":"codex","totalRows":2,"rows":[{"id":"c11","role":"user","kind":"message","preview":"jose vs jsonwebtoken for ES256 — which should we standardize on?"},{"id":"c12","role":"assistant","kind":"message","speaker":"Codex","preview":"Prefer jose: native ES256, actively maintained and tree-shakeable. jsonwebtoken needs extra deps for ECDSA."}]}"#,
          "demo-2-sc1": #"{"threadId":"demo-2-sc1","workspaceId":"demo-ws","provider":"claude","totalRows":2,"rows":[{"id":"c21","role":"user","kind":"message","preview":"Cursor vs offset pagination for the list endpoints?"},{"id":"c22","role":"assistant","kind":"message","speaker":"Claude","preview":"Cursor pagination — stable under inserts and cheap at depth. Encode the cursor as an opaque base64 token."}]}"#,
          "demo-3-sc1": #"{"threadId":"demo-3-sc1","workspaceId":"demo-ws","provider":"claude","totalRows":2,"rows":[{"id":"c31","role":"user","kind":"message","preview":"Could the flush race actually be inside the S3 client, not our code?"},{"id":"c32","role":"assistant","kind":"message","speaker":"Claude","preview":"Unlikely — the SDK resolves upload() only after the body stream ends. The race is the test asserting before awaiting it."}]}"#,
        ]
        for (key, json) in childSnapsJSON {
            if let snap = Self.decodeDemo(RemoteThreadSnapshot.self, json) { threadSnapshots[key] = snap }
        }

        // — Inspector · Usage tab — per-provider quota windows (no gemini) —
        let modelUsageJSON = """
        {"generatedAt":"2026-06-19T10:45:00Z","providers":[
          {"provider":"claude","windows":[
            {"id":"claude-5h","label":"Current session (5h)","usedPercent":42,"limitLabel":"resets 1 PM","resetAt":"2026-06-19T13:00:00Z"},
            {"id":"claude-week","label":"Weekly quota","usedPercent":61,"limitLabel":"of weekly limit","resetAt":"2026-06-23T00:00:00Z"}]},
          {"provider":"codex","windows":[
            {"id":"codex-5h","label":"Current session (5h)","usedPercent":28,"limitLabel":"resets 2 PM","resetAt":"2026-06-19T14:00:00Z"},
            {"id":"codex-week","label":"Weekly quota","usedPercent":47,"limitLabel":"of weekly limit","resetAt":"2026-06-24T00:00:00Z"}]},
          {"provider":"kimi","windows":[{"id":"kimi-day","label":"Daily quota","usedPercent":12,"limitLabel":"of daily limit","resetAt":"2026-06-20T00:00:00Z"}]},
          {"provider":"grok","windows":[{"id":"grok-day","label":"Daily quota","usedPercent":7,"limitLabel":"of daily limit","resetAt":"2026-06-20T00:00:00Z"}]},
          {"provider":"cursor","windows":[{"id":"cursor-month","label":"Monthly requests","usedPercent":34,"limitLabel":"500 / month","resetAt":"2026-07-01T00:00:00Z"}]}
        ]}
        """
        let rollupJSON = """
        {"providers":[
          {"provider":"claude","h24":182000,"d7":1240000,"d90":9800000},
          {"provider":"codex","h24":96000,"d7":610000,"d90":4100000},
          {"provider":"kimi","h24":14000,"d7":120000,"d90":880000},
          {"provider":"grok","h24":8000,"d7":54000,"d90":420000},
          {"provider":"cursor","h24":4000,"d7":31000,"d90":260000}
        ],"totals":{"h24":304000,"d7":2055000,"d90":15460000}}
        """
        if let usage = Self.decodeDemo(ModelUsageMessage.Usage.self, modelUsageJSON) { modelUsage = usage }
        if let rollup = Self.decodeDemo(UsageRollupMessage.Rollup.self, rollupJSON) { usageRollup = rollup }
        let firstLaunchJSON = """
        {"schemaVersion":1,"generatedAt":"2026-06-19T10:45:00Z",
         "notifications":[
          {"id":"new-additions-2026-08-30","kind":"addition","title":"New Additions","body":"OpenRouter Pi additions from Cohere, MiniMax, and Thinking Machines' Inkling family, plus AntiGravity Gemini 3.7 Flash, Grok 4.6 in Grok and Cursor, Muse Spark 1.2, the full Mistral lineup, Ollama Cloud GLM 5.2 and MiniMax M3, curated local Ollama models, and Pi BYOK models via DeepSeek, Z.ai, Qwen, Xiaomi's MiMo, Mistral, Poolside, and NVIDIA.","tone":"default","accent":"default","dismissible":true,"groups":[
            {"provider":"antigravity","label":"AntiGravity","models":[
              {"name":"Gemini 3.7 Flash","blurb":"The newest Flash family, with Low, Medium, and High reasoning in the official agy CLI."}
            ]},
            {"provider":"grok","label":"Grok","models":[
              {"name":"Grok 4.6 Fast","blurb":"The new 500K default with Low through Extra High reasoning in Grok Build."}
            ]},
            {"provider":"cursor","label":"Cursor","models":[
              {"name":"Grok 4.6","blurb":"A 256K Cursor model with Low through Extra High reasoning and Standard/Fast modes."}
            ]},
            {"provider":"muse","label":"Muse","models":[
              {"name":"Muse Spark 1.2","blurb":"Muse Code CLI over Meta Model API — 1M context at $1.25/$4.25 per Mtok."}
            ]},
            {"provider":"mistral","label":"Mistral","models":[
              {"name":"Devstral Small","blurb":"New configurable Effort options for a faster, lower-cost default or deeper reasoning."},
              {"name":"Mistral 3.5 Medium","blurb":"Configurable Effort tuning now available, balancing latency and reasoning depth."},
              {"name":"Mistral Large 3","blurb":"A flagship-sized 262K context model tuned for deeper planning and coding tasks."},
              {"name":"Mistral Medium (Latest)","blurb":"Current Mistral Medium flagship with stronger context and balanced latency."},
              {"name":"Mistral Medium 3.1","blurb":"Mistral Medium 3.1 extends the medium family with a refreshed default profile."},
              {"name":"Mistral Medium 3","blurb":"Legacy Mistral Medium 3 keeps strong performance in a lighter-cost package."},
              {"name":"Mistral Small 4","blurb":"Mistral Small 4 expands tool and reasoning coverage while staying cost-efficient."},
              {"name":"Devstral 2","blurb":"A faster default path with broader instruction coverage and lower per-token cost."},
              {"name":"Leanstral 1.5 (Labs)","blurb":"Leanstral 1.5 (Labs) is a research-focused experimental reasoning update."},
              {"name":"GLM-5.2 (via Mistral)","blurb":"GLM-5.2 (via Mistral) introduces a 1M context lane for heavier prompts."},
              {"name":"Codestral (Aug 2025)","blurb":"Codestral (Aug 2025) is a Mistral codespace model with updated quality and tuning."},
              {"name":"Ministral 3 (14B)","blurb":"Ministral 3 (14B) balances throughput and coding depth on the same family stack."},
              {"name":"Ministral 3 (8B)","blurb":"Ministral 3 (8B) keeps the same family strengths in a smaller profile."},
              {"name":"Ministral 3 (3B)","blurb":"Ministral 3 (3B) is the compact variant for lighter tasks and lower cost."}
            ]},
            {"provider":"ollama","label":"Ollama","models":[
              {"name":"GLM 5.2 (Cloud)","blurb":"Z.ai's 1M-context flagship on Ollama Cloud — signed in, no local VRAM required.","accentProvider":"zai"},
              {"name":"MiniMax M3 (Cloud)","blurb":"MiniMax M3 on Ollama Cloud — a 1M context window for long-horizon agentic work.","accentProvider":"minimax"},
              {"name":"Ornith 1.5 (9B & 35B)","blurb":"Deep Reinforce's 262K agentic coder, local in both a 9B and a 35B size.","accentProvider":"deep-reinforce"},
              {"name":"Gemma 4 (31B-MLX)","blurb":"Google Gemma 4 31B-MLX through Ollama, with 262K context and tooling support.","accentProvider":"google"},
              {"name":"Qwen 3.8 (27B-MLX)","blurb":"Alibaba's 27B MLX multimodal agent with tools, thinking, and 262K context (Ollama 0.32.12+).","accentProvider":"qwen"},
              {"name":"Muse Glimmer (30B-MLX)","blurb":"Meta's 30B multimodal agent model with vision, tools, thinking, and failure recovery (131K).","accentProvider":"meta"},
              {"name":"Nemotron 3.5 Lightning (30B-MLX)","blurb":"NVIDIA's 30B-A3B always-on agent model with tools, thinking, and a 262K context window.","accentProvider":"nvidia"},
              {"name":"North Mini Code 1.0","blurb":"Cohere's 500K agentic coder with tools and thinking — local, no cloud account.","accentProvider":"cohere"},
              {"name":"GLM-4.7-Flash","blurb":"Z.ai 30B-A3B local reasoner with tools and thinking (~203K).","accentProvider":"zai"},
              {"name":"Rnj-1","blurb":"Essential AI's 8B agentic coding model with native tools.","accentProvider":"essential"}
            ]},
            {"provider":"pi","label":"Pi","models":[
              {"name":"North Mini Code (OpenRouter Free)","blurb":"Cohere's 256K agentic coder via OpenRouter, with interleaved reasoning and tool use.","accentProvider":"cohere"},
              {"name":"MiniMax M3 (OpenRouter Free)","blurb":"MiniMax's free 1M multimodal agent model via OpenRouter, with reasoning and tools.","accentProvider":"minimax"},
              {"name":"Inkling (OpenRouter Free)","blurb":"Thinking Machines' 1M multimodal model with Off-to-Max effort; free research traffic is logged.","accentProvider":"thinkingmachines"},
              {"name":"Inkling Small (OpenRouter Free)","blurb":"A faster 1M Inkling with Off-to-Max effort; avoid sensitive data on the logged free endpoint.","accentProvider":"thinkingmachines"},
              {"name":"DeepSeek V4 Flash","blurb":"DeepSeek V4 Flash via Pi — with reasoning tiers and strong coding performance.","accentProvider":"deepseek"},
              {"name":"GLM-5.2","blurb":"Z.ai GLM-5.2 via Pi — 1M context with broad capability and strong reasoning.","accentProvider":"zai"},
              {"name":"Qwen3.8 Max","blurb":"Qwen3.8 Max via Pi — cutting-edge multimodal reasoning from Alibaba.","accentProvider":"qwen"},
              {"name":"Xiaomi MiMo","blurb":"MiMo V2.5 and V2.5 Pro on a Xiaomi Token Plan key — CN, SGP, or AMS region.","accentProvider":"xiaomi"},
              {"name":"Mistral Large 3","blurb":"Mistral Large 3 via Pi — 262K context for deep planning and complex tasks.","accentProvider":"mistral"},
              {"name":"Laguna S 2.1","blurb":"Poolside Laguna S 2.1 via Pi — a high-performance reasoning model from Poolside.","accentProvider":"poolside"},
              {"name":"Nemotron 3 Ultra","blurb":"NVIDIA Nemotron 3 Ultra via Pi — a massive 550B parameter model for enterprise tasks.","accentProvider":"nvidia"}
            ]}
          ]}
         ],
         "workspace":{"visibleCount":1,"totalCount":1,"runningCount":0,"hasVisibleWorkspaces":true,"capabilities":{"monitor":true,"approve":true,"answer":true,"startTurn":true,"steer":true,"fileRead":true,"fileWrite":false,"externalPublish":false}},
         "providerCards":[
          {"id":"codex","label":"Codex","optional":false,"statusKind":"ready","statusText":"Ready on Mac","detail":"OpenAI Codex CLI is available for fast agentic coding runs from the Mac.","setupHint":"Sign-in happens on the Mac through the Codex CLI.","setupCommands":[{"id":"codex","label":"Codex","command":"npm i -g @openai/codex","source":"OpenAI"}],"usageWindows":[{"id":"codex-5h","label":"Current session (5h)","usedPercent":28,"resetAt":"2026-06-19T14:00:00Z"}],"usageGeneratedAt":"2026-06-19T10:45:00Z"},
          {"id":"claude","label":"Claude","optional":false,"statusKind":"ready","statusText":"Ready on Mac","detail":"Claude Code is signed in on the paired Mac for careful reasoning and edits.","setupHint":"Manage Claude sign-in on the Mac.","setupCommands":[{"id":"claude","label":"Claude","command":"curl -fsSL https://claude.ai/install.sh | bash","source":"Anthropic"}],"usageWindows":[{"id":"claude-5h","label":"Current session (5h)","usedPercent":42,"resetAt":"2026-06-19T13:00:00Z"}],"usageGeneratedAt":"2026-06-19T10:45:00Z"},
          {"id":"kimi","label":"Kimi","optional":true,"statusKind":"notObservable","statusText":"Managed runtime unavailable","detail":"Kimi Code is installed, but this runtime has not passed TaskWraith's admission checks: a stable binary identity, successful bounded startup probes, and the ACP-only transport posture are required before managed ACP runs can start.","setupHint":"Authenticate the current Kimi Code home with `kimi login` or a provider key in ~/.kimi-code/config.toml. The TaskWraith Settings key is usage-only and does not bypass runtime admission.","setupCommands":[{"id":"kimi","label":"Kimi","command":"curl -LsSf https://code.kimi.com/install.sh | bash","source":"Moonshot"}],"usageWindows":[{"id":"kimi-day","label":"Daily quota","usedPercent":12,"resetAt":"2026-06-20T00:00:00Z"}]},
          {"id":"cursor","label":"Cursor","optional":true,"statusKind":"notObservable","statusText":"Not observable","detail":"Cursor CLI is available on the Mac; the CLI may still ask for sign-in when a run starts.","setupHint":"On your Mac, install cursor-agent if needed, then run cursor-agent login in Terminal.","setupCommands":[{"id":"cursor","label":"Cursor","command":"curl https://cursor.com/install -fsS | bash","source":"Cursor"}],"usageWindows":[{"id":"cursor-month","label":"Monthly requests","usedPercent":34,"resetAt":"2026-07-01T00:00:00Z"}],"usageGeneratedAt":"2026-06-19T10:45:00Z"},
          {"id":"grok","label":"Grok","optional":true,"statusKind":"notObservable","statusText":"Not observable","detail":"Grok usage is not observable from this demo snapshot.","setupHint":"Finish Grok CLI sign-in on the Mac.","setupCommands":[{"id":"grok","label":"Grok","command":"curl -fsSL https://x.ai/cli/install.sh | bash","source":"xAI"}],"usageWindows":[]},
          {"id":"ollama","label":"Ollama","optional":true,"statusKind":"localReady","statusText":"Local Ollama ready","detail":"Local models are served by the paired Mac; no cloud account is required.","setupHint":"Pull a supported model on the Mac before selecting it.","setupCommands":[{"id":"ollama","label":"Ollama","command":"curl -fsSL https://ollama.com/install.sh | sh","source":"Ollama","platform":"macOS / Linux"}],"usageWindows":[]}
         ],
         "setupCommands":[{"id":"codex","label":"Codex","command":"npm i -g @openai/codex","source":"OpenAI"},{"id":"claude","label":"Claude","command":"curl -fsSL https://claude.ai/install.sh | bash","source":"Anthropic"}],
         "ollamaModelCommands":[{"id":"qwen3:4b-instruct","label":"Qwen 3 (4B Param)","command":"ollama run qwen3:4b-instruct"},{"id":"gpt-oss:20b","label":"GPT OSS (20B Param)","command":"ollama run gpt-oss:20b"}]}
        """
        if let state = Self.decodeDemo(FirstLaunchState.self, firstLaunchJSON) { firstLaunchState = state }

        // 30-day token bar charts — deterministic synthetic series (no gemini).
        let twProviders = ["claude", "codex", "kimi"]
        let twValues = (0..<30).map { i in 26_000 + ((i * 17) % 11) * 5_500 + (i % 4) * 3_200 }
        let twBars = twValues.enumerated().map { (i, v) in
            #"{"tokens":\#(v),"provider":"\#(twProviders[i % twProviders.count])"}"#
        }.joined(separator: ",")
        let twDailyJSON = #"{"totalTokens":\#(twValues.reduce(0, +)),"startLabel":"21 May","endLabel":"19 Jun","buckets":[\#(twBars)]}"#
        if let series = Self.decodeDemo(DailyTokenSeries.self, twDailyJSON) { taskwraithTokenDaily = series }
        let extProviders = ["cursor", "grok"]
        let extValues = (0..<30).map { i in 8_000 + ((i * 13) % 9) * 2_400 + (i % 3) * 1_500 }
        let extBars = extValues.enumerated().map { (i, v) in
            #"{"tokens":\#(v),"provider":"\#(extProviders[i % extProviders.count])"}"#
        }.joined(separator: ",")
        let extDailyJSON = #"{"totalTokens":\#(extValues.reduce(0, +)),"startLabel":"21 May","endLabel":"19 Jun","buckets":[\#(extBars)]}"#
        if let series = Self.decodeDemo(DailyTokenSeries.self, extDailyJSON) { externalTokenDaily = series }

        macDisplayName = "Demo Mac"
        selectedTaskId = "demo-1"
        markProjectionContentHydrated()
        isDemo = true
        phase = .connected
    }

    /// Leave the demo and clear its canned data. Reconnects the trusted Mac if
    /// one is paired; otherwise returns to the pairing screen.
    public func exitDemoMode() {
        isDemo = false  // re-open the reconnect guards before reconnecting
        disconnect()    // clears live lists + cancels timers; phase → .idle
        clearCachedProjectionState()
        selectedTaskId = nil
        macDisplayName = ""
        if hasStoredPairing { reconnectTrusted() }
    }

    private static func decodeDemo<T: Decodable>(_ type: T.Type, _ json: String) -> T? {
        guard let data = json.data(using: .utf8) else { return nil }
        return try? TWCoders.decoder.decode(type, from: data)
    }

    /// Clears cached projection/render state (snapshots, streaming buffers, usage
    /// panels, git/diff caches) so real and demo data never bleed together.
    /// Mirrors forgetPairing's cache wipe; used by demo enter/exit.
    // CANONICAL per-host projection reset. This + wipeProjectionCaches() are
    // the ONLY places host-specific render state is cleared on a host switch /
    // forget / demo toggle. When a future slice adds a per-host @Published
    // (transcripts, streaming, usage, nav targets, suppression sets), reset it
    // HERE or it will silently bleed across hosts.
    private func clearCachedProjectionState() {
        // Host v2 keeps a per-Mac offline replica on disk, but its currently
        // visible object graph must never bleed into demo mode or another Mac.
        hostProjection.clear(removePersistedSnapshot: false)
        // A Live Activity that outlived its Mac would leave one host's run on
        // the lock screen after the user switched to another — the same "leave
        // nothing readable" rule the caches below follow. The flag holds off the
        // per-field didSet re-syncs until the teardown has finished.
        isTearingDownProjection = true
        defer { isTearingDownProjection = false }
        #if os(iOS)
            TWRunActivityController.shared.endAll()
        #endif
        threadSnapshots = [:]
        streamingTexts = [:]
        streamingSegments = [:]
        streamingRunIds = [:]
        streamingProviders = [:]
        streamingItemIds = [:]
        streamingTerminalThreads = []
        streamingPublishGate.resetAll()
        providerModels = [:]
        projectionHydrated = false
        projectionGraceExpired = false
        wakeRefreshGeneration = [:]
        // A host switch bumps connectAttempt and aborts any in-flight resync retry
        // loop; clear the latch here too so the new host's resync can start.
        fullProjectionResyncInFlight = false
        usageRollup = nil
        taskwraithTokenDaily = nil
        externalTokenDaily = nil
        modelUsage = nil
        welcomeDashboard = nil
        firstLaunchState = nil
        gitSnapshots = [:]
        ensembleStates = [:]
        diffSummaries = [:]
        // Per-thread inspector-segment memory is host-scoped like the caches it
        // sits beside — drop it so one host's thread ids can't carry a segment
        // choice into another host, and so it never grows unbounded.
        inspectorTabByThread = [:]
        workflows = []
        workspaceBoards = []
        ensemblePresets = []
        threadWorkspaceHints = [:]
        deniedRemoteWorkspaceIds = []
        revokedThreadWorkspaceHints = [:]
        demoFileEdits = [:]
        // Expanded transcript row bodies hold verbatim message/tool content —
        // wiping snapshots without these would leave a host's transcript text
        // readable after switch/forget ("leave NOTHING readable").
        rowExpansions = [:]
        expandingRows = []
        // Per-thread run-summary suppression state is part of the snapshot cache
        // it sits beside — keeping it would let one host's hidden summaries
        // filter another's.
        hiddenRunSummaryFingerprintsByThread = [:]
        navigationTarget = nil
        // QR-optional discovery results belong to the (outgoing) oracle host — a
        // stale list must not linger under the next host (and could offer to
        // re-pair a host the new context already knows).
        discoveredHosts = []
        discoveryError = nil
        visibleThreadId = nil
        // Side-chat inspector target is a host-scoped navigation pointer, same
        // as navigationTarget/visibleThreadId above.
        inspectorSideChatTarget = nil
        lastActionMessage = nil
    }

    /// One-time self-heal: a build-30 bug could persist the synthetic "Demo Mac"
    /// name into the stored pairing. Never surface it for a real Mac.
    private static func sanitizedMacName(_ name: String) -> String {
        name == "Demo Mac" ? "" : name
    }

    /// Demo-only: a mutable mirror of the immutable `RemoteThreadSnapshot` so
    /// local edits (appended turns, saved notes, pinned rows) can rebuild it
    /// while preserving every other field.
    private struct DemoSnapshotDraft {
        var threadId: String?
        var taskId: String?
        var workspaceId: String?
        var provider: String?
        var rows: [RemoteThreadSnapshot.Row]?
        var totalRows: Int?
        var runSummary: RemoteThreadSnapshot.RunSummary?
        var conversationCostUsd: Double?
        var conversationCostText: String?
        var showRunCompleteSummary: Bool?
        var notes: String?
        var pinnedRows: [RemoteThreadSnapshot.Row]?
        var blackboardEntries: [RemoteThreadSnapshot.BlackboardEntry]?
        var runSummaries: [RemoteThreadSnapshot.RunSummary]?
        var windowStartIndex: Int?
        var hasMoreAbove: Bool?
        var hasMoreBelow: Bool?
        var threadMessageInbox: RemoteThreadSnapshot.ThreadMessageInbox?
        init(_ s: RemoteThreadSnapshot) {
            threadId = s.threadId
            taskId = s.taskId
            workspaceId = s.workspaceId
            provider = s.provider
            rows = s.rows
            totalRows = s.totalRows
            runSummary = s.runSummary
            conversationCostUsd = s.conversationCostUsd
            conversationCostText = s.conversationCostText
            showRunCompleteSummary = s.showRunCompleteSummary
            notes = s.notes
            pinnedRows = s.pinnedRows
            blackboardEntries = s.blackboardEntries
            runSummaries = s.runSummaries
            windowStartIndex = s.windowStartIndex
            hasMoreAbove = s.hasMoreAbove
            hasMoreBelow = s.hasMoreBelow
            threadMessageInbox = s.threadMessageInbox
        }
        func build() -> RemoteThreadSnapshot {
            RemoteThreadSnapshot(
                threadId: threadId, taskId: taskId, workspaceId: workspaceId,
                provider: provider, rows: rows, totalRows: totalRows,
                runSummary: runSummary, conversationCostUsd: conversationCostUsd,
                conversationCostText: conversationCostText,
                showRunCompleteSummary: showRunCompleteSummary, notes: notes, pinnedRows: pinnedRows,
                blackboardEntries: blackboardEntries, runSummaries: runSummaries,
                windowStartIndex: windowStartIndex, hasMoreAbove: hasMoreAbove,
                hasMoreBelow: hasMoreBelow, threadMessageInbox: threadMessageInbox)
        }
    }

    /// Demo-only: apply an in-place edit to a thread snapshot (no-op if absent).
    private func editDemoSnapshot(
        _ thread: String, _ edit: (inout DemoSnapshotDraft) -> Void
    ) {
        guard let existing = threadSnapshots[thread] else { return }
        var draft = DemoSnapshotDraft(existing)
        edit(&draft)
        threadSnapshots[thread] = draft.build()
    }

    private static func retitledCard(_ card: RemoteTaskCard, title: String) -> RemoteTaskCard {
        guard
            let data = try? TWCoders.encoder.encode(card),
            var object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return card
        }
        object["title"] = title
        guard
            let nextData = try? JSONSerialization.data(withJSONObject: object),
            let decoded = try? TWCoders.decoder.decode(RemoteTaskCard.self, from: nextData)
        else {
            return card
        }
        return decoded
    }

    private static func normalizedThreadTitle(_ title: String, fallback: String = "") -> String {
        let collapsed = title
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let source = collapsed.isEmpty ? fallback : collapsed
        let bounded = String(source.prefix(threadTitleMaxCharacters))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return bounded
    }

    private static func titleKey(for card: RemoteTaskCard) -> String {
        card.threadId ?? card.id
    }

    private func cardResolvingPendingThreadTitle(_ card: RemoteTaskCard) -> RemoteTaskCard {
        let key = Self.titleKey(for: card)
        guard let pending = pendingThreadTitleRenames[key] else { return card }
        let incoming = Self.normalizedThreadTitle(card.title ?? "")
        if incoming == pending.title {
            pendingThreadTitleRenames.removeValue(forKey: key)
            return card
        }
        if Date().timeIntervalSince(pending.startedAt) > Self.pendingThreadTitleRenameTTL {
            pendingThreadTitleRenames.removeValue(forKey: key)
            return card
        }
        return Self.retitledCard(card, title: pending.title)
    }

    private func applyLocalThreadTitle(_ card: RemoteTaskCard, title: String) {
        guard let thread = card.threadId else { return }
        taskCards = taskCards.map { current in
            if current.id == card.id || current.threadId == thread {
                return Self.retitledCard(current, title: title)
            }
            return current
        }
    }

    /// Demo-only: append the user's prompt + a canned assistant reply to a thread
    /// so the composer feels interactive with no network. Rows are built via JSON
    /// so they decode through the same Codable path as real rows.
    private func appendDemoTurn(card: RemoteTaskCard, prompt: String) {
        guard let thread = card.threadId else { return }
        let n = threadSnapshots[thread]?.rows?.count ?? 0
        let speaker = card.provider.map { $0.prefix(1).uppercased() + $0.dropFirst() } ?? "Assistant"
        let reply =
            "Demo reply — connect TaskWraith on your Mac to run this for real. Live, I'd plan the change, edit files behind your approval, and stream the results back here."
        guard
            let userRow = Self.demoRow(id: "demo-u-\(n)", role: "user", speaker: nil, preview: prompt),
            let replyRow = Self.demoRow(
                id: "demo-a-\(n)", role: "assistant", speaker: speaker, preview: reply)
        else { return }
        if threadSnapshots[thread] != nil {
            editDemoSnapshot(thread) { draft in
                let rows = (draft.rows ?? []) + [userRow, replyRow]
                draft.rows = rows
                draft.totalRows = rows.count
            }
        } else {
            let rows = [userRow, replyRow]
            threadSnapshots[thread] = RemoteThreadSnapshot(
                threadId: thread, workspaceId: card.workspaceId, provider: card.provider,
                rows: rows, totalRows: rows.count)
        }
    }

    /// Demo-only: fabricate a brand-new empty chat locally (workspace / ensemble
    /// / global) so the New-Chat canvas resolves to a usable welcome screen
    /// instead of spinning on "Creating…" forever (send() is inert in demo).
    /// Built via JSONSerialization → Codable, the same path as the live wire.
    private func createDemoThread(
        workspaceId: String, variant: String, provider: String?, title: String,
        onCreated: ((String?) -> Void)?
    ) {
        let newId = "demo-new-" + UUID().uuidString.prefix(8).lowercased()
        let effectiveVariant = variant == "ensemble" ? "workspace" : variant
        let isGlobal = effectiveVariant == "global"
        let isWorkflow = effectiveVariant == "workflow"
        let prov = provider ?? "claude"
        let ws = isGlobal ? "global" : workspaceId

        var cardDict: [String: Any] = [
            "id": newId, "title": title, "workspaceId": ws, "threadId": newId,
            "status": "idle", "chatKind": "single",
        ]
        if isWorkflow {
            cardDict["isDraft"] = true
            cardDict["draftVariant"] = "workflow"
        }
        cardDict["provider"] = prov
        let snapDict: [String: Any] = [
            "threadId": newId, "workspaceId": ws, "provider": prov,
            "totalRows": 0, "rows": [],
        ]
        guard
            let cardData = try? JSONSerialization.data(withJSONObject: cardDict),
            let card = try? TWCoders.decoder.decode(RemoteTaskCard.self, from: cardData),
            let snapData = try? JSONSerialization.data(withJSONObject: snapDict),
            let snap = try? TWCoders.decoder.decode(RemoteThreadSnapshot.self, from: snapData)
        else {
            onCreated?(nil)
            return
        }
        taskCards.append(card)
        threadSnapshots[newId] = snap
        rememberThreadWorkspace(newId, workspaceId: ws)
        lastActionMessage = "Chat created."
        onCreated?(newId)
    }

    private static func demoRow(id: String, role: String, speaker: String?, preview: String)
        -> RemoteThreadSnapshot.Row?
    {
        var dict: [String: Any] = ["id": id, "role": role, "kind": "message", "preview": preview]
        if let speaker { dict["speaker"] = speaker }
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
            let row = try? TWCoders.decoder.decode(RemoteThreadSnapshot.Row.self, from: data)
        else { return nil }
        return row
    }

    // ── Demo file editor + diff studio ────────────────────────────────────────
    // Offline canned filesystem so the Files browser, editor save, and Diff
    // Studio all work without a Mac. Edits live in `demoFileEdits` (in-memory,
    // wiped on demo exit); reads fall back to the static seed content.

    /// In-session demo file edits (path → content). Cleared on demo exit.
    private var demoFileEdits: [String: String] = [:]

    /// Flat workspace tree for `listWorkspaceFiles` — the view's
    /// `immediateChildren`/`searchMatches` filter this by path/query.
    private static let demoFileTreeJSON = """
    [
     {"path":"auth","name":"auth","isDirectory":true,"depth":0,"hasChildren":true},
     {"path":"src","name":"src","isDirectory":true,"depth":0,"hasChildren":true},
     {"path":"test","name":"test","isDirectory":true,"depth":0,"hasChildren":true},
     {"path":"docs","name":"docs","isDirectory":true,"depth":0,"hasChildren":true},
     {"path":"README.md","name":"README.md","isDirectory":false,"depth":0,"sizeBytes":420},
     {"path":"package.json","name":"package.json","isDirectory":false,"depth":0,"sizeBytes":260},
     {"path":"auth/TokenService.ts","name":"TokenService.ts","isDirectory":false,"depth":1,"sizeBytes":980},
     {"path":"auth/index.ts","name":"index.ts","isDirectory":false,"depth":1,"sizeBytes":360},
     {"path":"auth/TokenService.test.ts","name":"TokenService.test.ts","isDirectory":false,"depth":1,"sizeBytes":760},
     {"path":"src/upload","name":"upload","isDirectory":true,"depth":1,"hasChildren":true},
     {"path":"src/upload/uploader.ts","name":"uploader.ts","isDirectory":false,"depth":2,"sizeBytes":340},
     {"path":"test/upload.test.ts","name":"upload.test.ts","isDirectory":false,"depth":1,"sizeBytes":320},
     {"path":"docs/api-v2.md","name":"api-v2.md","isDirectory":false,"depth":1,"sizeBytes":520}
    ]
    """

    /// Seed file contents (real newlines; JSONSerialization escapes them when
    /// building the read result). Edited copies override these via `demoFileEdits`.
    private static let demoFileContents: [String: String] = [
        "auth/TokenService.ts": """
        import { SignJWT, jwtVerify } from 'jose'
        import type { Clock } from './clock'

        const ACCESS_TTL = 15 * 60          // 15 minutes
        const REFRESH_TTL = 30 * 24 * 3600  // 30 days
        const SKEW = 60                     // tolerate 60s clock skew

        export class TokenService {
          constructor(
            private readonly clock: Clock,
            private readonly secret: Uint8Array,
          ) {}

          async issue(userId: string) {
            const now = this.clock.now()
            const access = await new SignJWT({ sub: userId })
              .setProtectedHeader({ alg: 'ES256' })
              .setIssuedAt(now)
              .setExpirationTime(now + ACCESS_TTL)
              .sign(this.secret)
            return { access }
          }

          async verify(token: string) {
            return jwtVerify(token, this.secret, { clockTolerance: SKEW })
          }
        }
        """,
        "auth/index.ts": """
        export { TokenService } from './TokenService'
        export type { Clock } from './clock'

        import { TokenService } from './TokenService'

        // Keep the public login() signature stable across the refactor.
        export async function login(userId: string, deps: { tokens: TokenService }) {
          return deps.tokens.issue(userId)
        }
        """,
        "auth/TokenService.test.ts": """
        import { describe, it, expect } from 'vitest'
        import { TokenService } from './TokenService'
        import { FakeClock } from '../test/FakeClock'

        describe('TokenService', () => {
          it('issues an access token that verifies', async () => {
            const svc = new TokenService(new FakeClock(0), KEY)
            const { access } = await svc.issue('u_1')
            await expect(svc.verify(access)).resolves.toBeTruthy()
          })

          it('rejects a token expired beyond the skew window', async () => {
            const clock = new FakeClock(0)
            const svc = new TokenService(clock, KEY)
            const { access } = await svc.issue('u_1')
            clock.advance(16 * 60)
            await expect(svc.verify(access)).rejects.toThrow()
          })
        })
        """,
        "src/upload/uploader.ts": """
        export async function upload(stream: ReadableStream, sink: Sink) {
          const writer = sink.writable.getWriter()
          await stream.pipeTo(sink.writable)
          // FIX: await the flush before resolving so callers can assert safely.
          await writer.ready
          return sink.result()
        }
        """,
        "test/upload.test.ts": """
        import { it, expect } from 'vitest'
        import { upload } from '../src/upload/uploader'

        it('resolves only after the buffer has drained', async () => {
          const sink = new MemorySink()
          await upload(fixtureStream(), sink)
          // Previously asserted before the flush — the source of the flake.
          expect(sink.bytes).toBe(FIXTURE_BYTES)
        })
        """,
        "docs/api-v2.md": """
        # Public API v2

        ## Principles
        - Resource-oriented endpoints under `/v2/…`
        - Cursor pagination on every list endpoint
        - Typed error envelope (never reuse the v1 shape)
        - `Idempotency-Key` required on all POST requests

        ## Pagination
        List endpoints accept `?cursor=` and return `{ items, nextCursor }`.
        The cursor is an opaque base64 token — clients must not parse it.
        """,
        "README.md": """
        # TaskWraith Demo Project

        A sandbox workspace bundled with the iOS app's demo mode. Connect
        TaskWraith on your Mac to work with your own repositories.

        - `auth/` — token-service refactor
        - `src/upload/` — flaky-test fix
        - `docs/` — v2 API plan
        """,
        "package.json": """
        {
          "name": "taskwraith-demo",
          "version": "2.0.0",
          "private": true,
          "scripts": {
            "test": "vitest run",
            "build": "tsc -p ."
          },
          "dependencies": {
            "jose": "^5.9.0"
          }
        }
        """,
    ]

    /// The canned `git status` for the demo workspace — powers the composer's
    /// active-changes diff pill (the Git panel itself is hidden in demo).
    private static let demoGitSnapshotJSON = """
    {"repoRoot":"~/Developer/taskwraith-demo","branch":"feat/auth-refactor","commit":"a3f9c1d","detached":false,"upstream":"origin/feat/auth-refactor","remoteName":"origin","ahead":1,"behind":0,"clean":false,"counts":{"changed":3,"staged":0,"unstaged":3,"untracked":0},"lineStats":{"additions":178,"deletions":42},"files":[{"path":"auth/TokenService.ts","kind":"modified","staged":false,"unstaged":true},{"path":"auth/index.ts","kind":"modified","staged":false,"unstaged":true},{"path":"auth/TokenService.test.ts","kind":"created","staged":false,"unstaged":true}],"filesTruncated":false}
    """

    /// The canned Diff Studio payload for the demo workspace.
    private static let demoWorkspaceDiffJSON = """
    {"totalFiles":3,"truncated":false,"files":[
     {"path":"auth/TokenService.ts","kind":"modified","additions":96,"deletions":12,"truncated":false,"hunks":[
       {"header":"@@ -1,8 +1,12 @@","lines":[
         {"type":"ctx","text":"import { SignJWT, jwtVerify } from 'jose'","oldLine":1,"newLine":1},
         {"type":"del","text":"export function makeToken(userId) {","oldLine":2},
         {"type":"del","text":"  return sign({ sub: userId })","oldLine":3},
         {"type":"add","text":"export class TokenService {","newLine":2},
         {"type":"add","text":"  constructor(private readonly clock: Clock) {}","newLine":3},
         {"type":"add","text":"  async issue(userId: string) {","newLine":4},
         {"type":"add","text":"    const now = this.clock.now()","newLine":5},
         {"type":"ctx","text":"}","oldLine":4,"newLine":6}
       ]}
     ]},
     {"path":"auth/index.ts","kind":"modified","additions":18,"deletions":30,"truncated":false,"hunks":[
       {"header":"@@ -1,5 +1,4 @@","lines":[
         {"type":"del","text":"import { makeToken } from './TokenService'","oldLine":1},
         {"type":"add","text":"import { TokenService } from './TokenService'","newLine":1},
         {"type":"ctx","text":"","oldLine":2,"newLine":2},
         {"type":"ctx","text":"export async function login(userId: string) {","oldLine":3,"newLine":3}
       ]}
     ]},
     {"path":"auth/TokenService.test.ts","kind":"created","additions":64,"deletions":0,"truncated":false,"hunks":[
       {"header":"@@ -0,0 +1,6 @@","lines":[
         {"type":"add","text":"import { describe, it, expect } from 'vitest'","newLine":1},
         {"type":"add","text":"import { TokenService } from './TokenService'","newLine":2},
         {"type":"add","text":"","newLine":3},
         {"type":"add","text":"describe('TokenService', () => {","newLine":4},
         {"type":"add","text":"  it('issues a verifiable token', async () => {})","newLine":5},
         {"type":"add","text":"})","newLine":6}
       ]}
     ]}
    ]}
    """

    /// Build a `WorkspaceFileReadResult` for the demo editor via JSONSerialization
    /// (the type has no cross-module init). Etag changes with content length so a
    /// save round-trips to a fresh, non-empty etag (the editor requires one).
    private static func demoFileReadResult(path: String, content: String)
        -> WorkspaceFileReadResult?
    {
        let dict: [String: Any] = [
            "path": path, "content": content,
            "sizeBytes": content.utf8.count,
            "etag": "demo-etag-\(content.utf8.count)",
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
            let result = try? TWCoders.decoder.decode(WorkspaceFileReadResult.self, from: data)
        else { return nil }
        return result
    }

    /// Forget the ACTIVE host. Kept zero-arg so existing "Forget this host"
    /// affordances (sidebar overflow, pairing screen) keep working; with no
    /// active host it falls back to a full reset so a stuck state can still be
    /// cleared.
    public func forgetPairing() {
        guard let active = selectedHostId else {
            forgetAllHosts()
            return
        }
        forgetHost(macIdentityPubKey: active)
    }

    /// Forget one host by identity. If it's the active host, tear down the live
    /// session and wipe its projection first; OTHER paired hosts are untouched.
    /// (Caches are flat today and only ever hold the active host's data — they
    /// were already cleared when the user switched away from a background host —
    /// so a non-active forget needs no cache wipe.) The host keeps its own pin
    /// until the user revokes this phone there.
    public func forgetHost(macIdentityPubKey id: String) {
        let wasActive = (id == selectedHostId)
        if let forgotten = pairingStore.find(macIdentityPubKey: id) {
            deregisterFromProjectPushGateways([forgotten])
        }
        pairingStore.remove(macIdentityPubKey: id)
        refreshPairedHostsPublished()
        if !hasStoredPairing {
            wasEverConnected = false
            persistWasEverConnectedFlag()
        }
        registerWithProjectPushGatewaysIfReady()
        guard wasActive else { return }
        pinnedMacIdentityB64 = nil
        relayUrl = nil
        lastRelayUrls = nil
        lastHostPlatform = nil
        disconnect()
        hostProjection.clear(removePersistedSnapshot: true)
        // Security review: forgetting the active host must leave NOTHING
        // readable — disconnect() clears the live lists, but cached snapshots,
        // streaming buffers, and usage panels survive it.
        wipeProjectionCaches()
        // The store auto-selects the next remaining host (or none); reflect its
        // name so the reconnect affordance is labeled. Reconnecting to it is
        // left to the user (no surprise auto-jump on a forget).
        macDisplayName = pairingStore.load().selectedHost.map {
            Self.sanitizedMacName($0.macDisplayName)
        } ?? ""
    }

    /// Forget EVERY paired host (full reset). Durable: clearAll() persists an
    /// empty v2 document so the legacy single-host blob can't resurrect a host.
    public func forgetAllHosts() {
        let forgottenHostIds = pairedHosts.map(\.macIdentityPubKey)
        deregisterFromProjectPushGateways(pairedHosts)
        pairingStore.clearAll()
        wasEverConnected = false
        persistWasEverConnectedFlag()
        refreshPairedHostsPublished()
        registerWithProjectPushGatewaysIfReady()
        pinnedMacIdentityB64 = nil
        relayUrl = nil
        lastRelayUrls = nil
        lastHostPlatform = nil
        macDisplayName = ""
        disconnect()
        hostProjection.clear(removePersistedSnapshot: true)
        hostProjection.removePersistedSnapshots(hostIdentities: forgottenHostIds)
        wipeProjectionCaches()
    }

    /// Switch the active host: tear down the current session, wipe the outgoing
    /// host's live + cached projection (no cross-host bleed), select the new
    /// host, and reconnect to it. No-op for the already-active host except to
    /// re-drive a stalled connection.
    public func switchHost(to id: String) {
        guard !isDemo else { return }
        guard pairingStore.find(macIdentityPubKey: id) != nil else { return }
        if id == selectedHostId {
            switch phase {
            case .connected, .connecting, .awaitingMacConfirm: return
            default: reconnectTrusted()
            }
            return
        }
        cancelAutoReconnect(resetAttempts: true)
        cancelSocketHealthCheck()
        pinnedMacIdentityB64 = nil
        relayUrl = nil
        lastRelayUrls = nil
        lastHostPlatform = nil
        disconnect()  // teardown + .idle + clear live lists
        wipeProjectionCaches()  // clear the outgoing host's cached projection
        pairingStore.setSelectedHostId(id)
        refreshPairedHostsPublished()
        reconnectTrusted()
    }

    /// Clear cached + APNs projection state belonging to the (outgoing/forgotten)
    /// active host. `clearCachedProjectionState()` covers snapshots, streaming
    /// buffers, usage/model panels, git/diff/ensemble/workflow caches and
    /// navigation; the APNs fields are wiped here too.
    private func wipeProjectionCaches() {
        clearCachedProjectionState()
        // The allowlist-visible workspace list isn't part of the demo cache
        // reset (clearCachedProjectionState), but it IS per-host material — a
        // forgotten/outgoing host's workspaces must not linger under the next.
        workspaces = []
        // In-flight per-thread snapshot debounce timers belong to the outgoing
        // host's thread ids — cancel them so none fires requestThreadSnapshot()
        // against the next host (same hygiene as apnsTokenRetryTask below).
        pendingThreadRefresh.values.forEach { $0.cancel() }
        pendingThreadRefresh = [:]
        // A queued notification deep-link is a host-specific navigation target;
        // don't let a stale one fire against a different host on establish.
        pendingDeepLinkThreadId = nil
        pendingApnsToken = nil
        apnsTokenRegistrationInFlight = false
        apnsTokenRetryTask?.cancel()
        apnsTokenRetryTask = nil
    }

    /// The transport socket died underneath us (background kill, relay
    /// reap, network change). Without this the phase stayed .connected
    /// forever — a zombie state where every send times out and
    /// reconnectIfStale refuses to act because it looks healthy.
    private func handleSocketClosed() {
        // Intentional teardown nils the client BEFORE closing — ignore.
        guard client != nil else { return }
        hostProjection.markTransportClosed()
        scheduleReconnectAfterUnexpectedClose()
    }

    /// Delay then `reconnectIfStale()`. Stored so `disconnect()` / demo / host-switch
    /// can cancel it; the captured `connectAttempt` is a second guard if cancel
    /// loses a race with the sleep finishing.
    private func scheduleReconnectAfterUnexpectedClose() {
        guard case .connected = phase else { return }
        if hasStoredPairing {
            phase = .error("Connection lost — reconnecting…")
            let attempt = connectAttempt
            cancelDelayedSocketClosedReconnect()
            let delayMs = UInt64(socketClosedRedialDelayMs)
            delayedSocketClosedReconnectTask = Task { [weak self] in
                await TWRetryDelay.sleep(milliseconds: delayMs)
                guard !Task.isCancelled else { return }
                await MainActor.run {
                    guard let self, self.connectAttempt == attempt, !self.isDemo else { return }
                    self.reconnectIfStale()
                }
            }
        } else {
            phase = .error("Connection lost.")
        }
    }

    private func teardown() {
        hostProjection.markTransportClosed()
        eventTask?.cancel()
        eventTask = nil
        projectionSnapshotCoalescer.reset()
        projectionEnvelopeBatchCoalescer.reset()
        projectionBatchAssembler.reset()
        let client = self.client
        self.client = nil
        Task { await client?.close() }
    }

    private func persistCurrentPairing() {
        guard !isDemo else { return }  // never persist the demo's synthetic name
        guard let relayUrl, let macId = pinnedMacIdentityB64 else { return }
        // UPSERT (not overwrite): pairing/reconnecting one host must never drop
        // the others. Preserve the original pairedAt across reconnects so the
        // host list ordering doesn't churn; stamp it on first pairing only.
        let existing = pairingStore.find(macIdentityPubKey: macId)
        let pairedAt = existing?.pairedAt ?? Self.iso8601Now()
        // sanitizedMacName() maps a host literally named "Demo Mac" to "" on
        // every reconnect read; never let that (or any transient empty) clobber
        // a good persisted name — fall back to what we already stored.
        let name = macDisplayName.isEmpty ? (existing?.macDisplayName ?? "") : macDisplayName
        // Prefer the freshly-observed platform; fall back to whatever we stored
        // (reconnect carries none, and an old host may not advertise one).
        let hostPlatform = lastHostPlatform ?? existing?.hostPlatform
        pairingStore.upsert(
            PairedHostRecord(
                relayUrl: relayUrl, macIdentityPubKey: macId, macDisplayName: name,
                // The full candidate set from the bootstrap (LAN + wss) —
                // ONE pairing then reconnects from home Wi-Fi or cellular
                // alike; `relayUrl` holds the door that last worked.
                relayUrls: lastRelayUrls, hostPlatform: hostPlatform, pairedAt: pairedAt,
                macAgreePub: existing?.macAgreePub,
                pushGatewayUrl: existing?.pushGatewayUrl))
        // The host we just connected to is the active one.
        pairingStore.setSelectedHostId(macId)
        refreshPairedHostsPublished()
    }

    private func persistWasEverConnectedFlag() {
        pushGatewayDefaults.set(wasEverConnected, forKey: Self.wasEverConnectedDefaultsKey)
    }

    /// Mirror the persisted multi-host document into the @Published surface the
    /// view layer renders. Call after every store mutation.
    private func refreshPairedHostsPublished() {
        let doc = pairingStore.load()
        pairedHosts = doc.hosts
        selectedHostId = doc.selectedHostId
        hasStoredPairing = doc.selectedHostId != nil
    }

    private static func iso8601Now() -> String {
        TWCoders.iso8601Now()
    }

    /// Shared `.established` body so a test can fire the same mutations without
    /// a live transport client. `client == nil` skips host-projection activate.
    private func applySessionEstablished(from client: RelayTransportClient?) {
        if let client {
            if let hostIdentity = pinnedMacIdentityB64,
                let phoneIdentity = pairedHostProjectionIdentity(
                    identityPublicKeyBase64: client.identityPublicKeyBase64)
            {
                hostProjection.activate(
                    hostIdentity: hostIdentity,
                    phoneIdentity: phoneIdentity,
                    transport: client)
            } else {
                hostProjection.clear(removePersistedSnapshot: false)
            }
        }
        cancelAutoReconnect(resetAttempts: true)
        phase = .connected
        reconnectCoordinator.markAttemptFinished()
        wasEverConnected = true
        persistWasEverConnectedFlag()
        persistCurrentPairing()
        // Item 1: the outbox promised these would send "when your Mac answers".
        // This is that moment. Single-flight inside the drainer, so a reconnect
        // storm cannot double-send.
        scheduleOfflineOutboxFlush()
        // Cold-launch deep link: a notification tap set a target before the
        // session existed — apply it now that ConnectedShell will render.
        if let pending = pendingDeepLinkThreadId {
            navigationTarget = pending
            pendingDeepLinkThreadId = nil
        }
        // Wake-path rehydrate: a notification/APNs/foreground walk that just
        // established should pull the projection instead of waiting for an
        // unsolicited Mac push. No-op until handleRemoteWake arms the flag.
        if pendingWakeRehydrate {
            pendingWakeRehydrate = false
            rehydrateAfterAliveWake()
        }
        // Grace fallback for the hydration gate: a Mac with genuinely nothing
        // shared must eventually show the true empty state rather than ticking
        // forever. Idempotent — content arriving first flips the flag and this
        // no-ops.
        if !projectionHydrated {
            let graceAttempt = connectAttempt
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                await MainActor.run {
                    guard let self else { return }
                    let connected: Bool
                    if case .connected = self.phase {
                        connected = true
                    } else {
                        connected = false
                    }
                    guard
                        Self.shouldConfirmProjectionEmpty(
                            timerConnectAttempt: graceAttempt,
                            currentConnectAttempt: self.connectAttempt,
                            isConnected: connected)
                    else { return }
                    self.projectionHydrated = true
                    self.projectionGraceExpired = true
                }
            }
        }
        if let visible = visibleThreadId {
            requestThreadSnapshot(visible, bypassVisibleStreamSuppression: true)
        }
        reassertWatchedThreadToHost()
        requestPushAuthorizationIfNeeded()
        sendPendingApnsTokenIfReady()
    }

    private func consumeEvents(of client: RelayTransportClient) {
        eventTask = Task { [weak self] in
            for await event in client.events {
                guard let self else { return }
                guard self.client === client else { return }
                let isProjectionEnvelope: Bool
                if case .message(let method, _) = event {
                    isProjectionEnvelope = method == "bridge.broadcastRemoteProjection"
                } else {
                    isProjectionEnvelope = false
                }
                if !isProjectionEnvelope {
                    await self.projectionEnvelopeBatchCoalescer.flushForBarrier()
                    guard self.client === client else { return }
                    self.flushIncompleteProjectionBatches()
                }
                // Each handler re-checks that THIS client is still the live one:
                // teardown() (switch/forget/disconnect/next candidate) nils or
                // replaces self.client, so a late event from a superseded client
                // can't resurrect .connected or re-persist the outgoing host.
                // The check sits INSIDE each MainActor.run so it is atomic with
                // the mutations (no await gap a teardown could slip through).
                switch event {
                case .confirmCode(let code):
                    await MainActor.run {
                        guard self.client === client else { return }
                        self.phase = .awaitingMacConfirm(code: code)
                    }
                case .established:
                    await MainActor.run {
                        guard self.client === client else { return }
                        self.applySessionEstablished(from: client)
                    }
                case .message(let method, let params):
                    await self.handle(method: method, params: params)
                case .error(let message):
                    await MainActor.run {
                        guard self.client === client else { return }
                        if case .connected = self.phase {
                            // A transport-level timeout while the session is still .connected is a
                            // transient network blip, NOT a sleeping Mac. twFriendlyMessage re-maps
                            // any "timed out" string to the alarming "busy or asleep" banner, so
                            // surface accurate copy (no "timeout"/"timed out" wording) that stays a
                            // calm .info notice. Non-timeout transport messages pass through as-is.
                            let lower = message.lowercased()
                            if lower.contains("timed out") || lower.contains("timeout") {
                                self.lastActionMessage =
                                    "Brief network interruption — your Mac is still connected."
                            } else {
                                self.lastActionMessage = message
                            }
                        } else {
                            self.phase = .error(message)
                        }
                    }
                case .closed:
                    await MainActor.run {
                        guard self.client === client else { return }
                        self.handleSocketClosed()
                    }
                }
            }
        }
    }

    // ── Inbound projections ───────────────────────────────────────────────────

    /// IF2+S3 (Track-A/Pass-3) + iOS5 (Pass-5): suppress on-demand snapshot
    /// re-pulls while THIS thread is actively streaming AND on screen. The live
    /// buffer (`appendStreamingDeltas`) plus inbound host thread deltas cover
    /// visible transcript updates; off-screen threads and terminal refreshes
    /// keep their pulls. User-initiated and convergence pulls bypass this gate.
    /// Static + pure so tests exercise the exact policy.
    nonisolated static func shouldSuppressOnDemandSnapshotPull(
        isStreamingThread: Bool, isVisibleThread: Bool,
        bypassVisibleStreamSuppression: Bool = false
    ) -> Bool {
        guard !bypassVisibleStreamSuppression else { return false }
        return isStreamingThread && isVisibleThread
    }

    /// IF2 (Track-A): agent-output runEvent re-pull — narrow wrapper over the
    /// shared on-demand gate so only that channel is dropped mid-stream.
    nonisolated static func shouldSuppressStreamRefreshPull(
        channel: String?, isStreamingThread: Bool, isVisibleThread: Bool
    ) -> Bool {
        channel == "agent-output"
            && shouldSuppressOnDemandSnapshotPull(
                isStreamingThread: isStreamingThread, isVisibleThread: isVisibleThread)
    }

    /// IF1+IF3: coalescer for FULL projection-snapshot broadcasts.
    /// Full snapshots are idempotent whole-state replacements, so while a
    /// drain is pending only the NEWEST envelope matters — a burst of N
    /// queued snapshots decodes and applies exactly once. JSON decode runs
    /// off the MainActor; apply stays on MainActor. Ordered per-thread
    /// deltas and runEvents never route through here.
    @MainActor
    final class ProjectionSnapshotCoalescer {
        private var pending: Data?
        private var drainScheduled = false
        private var decodeInFlight = false
        private var generation = 0
        /// Observability + tests: how many drains actually applied.
        private(set) var applyCount = 0
        private let apply: (DecodedProjectionSnapshot) -> Void
        private let decode: @Sendable (Data) throws -> DecodedProjectionSnapshot
        private var idleWaiters: [CheckedContinuation<Void, Never>] = []

        init(
            decode: @escaping @Sendable (Data) throws -> DecodedProjectionSnapshot = { data in
                try TWCoders.decoder.decode(DecodedProjectionSnapshot.self, from: data)
            },
            apply: @escaping (DecodedProjectionSnapshot) -> Void
        ) {
            self.decode = decode
            self.apply = apply
        }

        /// IF3 teardown seam: discard pending work and invalidate in-flight decodes.
        func reset() {
            pending = nil
            generation += 1
        }

        func enqueue(_ data: Data) {
            pending = data
            guard !decodeInFlight, !drainScheduled else { return }
            scheduleDrain()
        }

        private func scheduleDrain() {
            drainScheduled = true
            // One cooperative yield lets every already-buffered envelope in
            // the event stream overwrite `pending` before the single decode+
            // apply. (Plain Task.yield — landmine ② is specific to the
            // follow-pin scrollTo path, not general task scheduling.)
            Task { @MainActor [weak self] in
                await Task.yield()
                self?.drainIfIdle()
            }
        }

        private func drainIfIdle() {
            drainScheduled = false
            guard !decodeInFlight, let data = pending else {
                signalIdleIfReady()
                return
            }
            pending = nil
            decodeInFlight = true
            let gen = generation
            let decodeFn = decode
            Task.detached(priority: .userInitiated) {
                let result = Result { try decodeFn(data) }
                await MainActor.run { [weak self] in
                    self?.finishDecode(result: result, generation: gen)
                }
            }
        }

        private func finishDecode(
            result: Result<DecodedProjectionSnapshot, Error>, generation gen: Int
        ) {
            decodeInFlight = false
            guard gen == generation else {
                if pending != nil {
                    drainIfIdle()
                } else {
                    signalIdleIfReady()
                }
                return
            }
            if pending != nil {
                drainIfIdle()
                return
            }
            switch result {
            case .success(let snapshot):
                applyCount += 1
                apply(snapshot)
            case .failure:
                print("[tw] DECODE FAILED: projection snapshot — state not rehydrated")
            }
            if pending != nil, !decodeInFlight {
                drainIfIdle()
            } else {
                signalIdleIfReady()
            }
        }

        private func signalIdleIfReady() {
            guard pending == nil, !decodeInFlight, !drainScheduled else { return }
            let waiters = idleWaiters
            idleWaiters = []
            for waiter in waiters {
                waiter.resume()
            }
        }

        /// Test seam: await until no pending decode/apply work remains.
        func drainForTesting() async {
            await withCheckedContinuation { continuation in
                if pending == nil, !decodeInFlight, !drainScheduled {
                    continuation.resume()
                } else {
                    idleWaiters.append(continuation)
                }
            }
        }
    }

    /// Consecutive single-envelope projections are the wire fallback for a
    /// full snapshot above the host's 700 KB frame cap. Older iOS code decoded
    /// and published each one independently on MainActor (hundreds of whole-
    /// shell invalidations on a mature workspace). This gate batches their raw
    /// frames briefly, prepares every typed payload off-main, and preserves all
    /// envelope ordering. A non-projection event calls `flushForBarrier`.
    @MainActor
    final class ProjectionEnvelopeBatchCoalescer {
        static let trailingWindowNs: UInt64 = 12_000_000

        private var pending: [Data] = []
        private var scheduledDrain: Task<Void, Never>?
        private var decodeInFlight = false
        private var generation = 0
        private(set) var applyCount = 0
        private let trailingWindowNs: UInt64
        private let decode: @Sendable ([Data]) throws -> [DecodedProjectionMessage]
        private let apply: ([DecodedProjectionMessage]) -> Void
        private var idleWaiters: [CheckedContinuation<Void, Never>] = []

        init(
            trailingWindowNs: UInt64 = ProjectionEnvelopeBatchCoalescer.trailingWindowNs,
            decode: @escaping @Sendable ([Data]) throws -> [DecodedProjectionMessage] = {
                frames in
                frames.compactMap {
                    try? TWCoders.decoder.decode(DecodedProjectionMessage.self, from: $0)
                }
            },
            apply: @escaping ([DecodedProjectionMessage]) -> Void
        ) {
            self.trailingWindowNs = trailingWindowNs
            self.decode = decode
            self.apply = apply
        }

        func reset() {
            pending.removeAll()
            scheduledDrain?.cancel()
            scheduledDrain = nil
            generation += 1
            if !decodeInFlight { signalIdleIfReady() }
        }

        func enqueue(_ data: Data) {
            pending.append(data)
            guard !decodeInFlight, scheduledDrain == nil else { return }
            scheduledDrain = Task { @MainActor [weak self] in
                guard let self else { return }
                try? await Task.sleep(nanoseconds: self.trailingWindowNs)
                guard !Task.isCancelled else { return }
                self.scheduledDrain = nil
                self.drainIfIdle()
            }
        }

        private func drainIfIdle() {
            guard !decodeInFlight, !pending.isEmpty else {
                signalIdleIfReady()
                return
            }
            let frames = pending
            pending.removeAll(keepingCapacity: true)
            decodeInFlight = true
            let gen = generation
            let decodeFn = decode
            Task.detached(priority: .userInitiated) {
                let result = Result { try decodeFn(frames) }
                await MainActor.run { [weak self] in
                    self?.finishDecode(result: result, generation: gen)
                }
            }
        }

        private func finishDecode(
            result: Result<[DecodedProjectionMessage], Error>, generation gen: Int
        ) {
            decodeInFlight = false
            if gen == generation {
                switch result {
                case .success(let messages):
                    if !messages.isEmpty {
                        applyCount += 1
                        apply(messages)
                    }
                case .failure:
                    print("[tw] DECODE FAILED: projection envelope batch")
                }
            }
            if pending.isEmpty {
                signalIdleIfReady()
            } else {
                drainIfIdle()
            }
        }

        /// Ordering barrier used before every non-projection transport event.
        func flushForBarrier() async {
            scheduledDrain?.cancel()
            scheduledDrain = nil
            drainIfIdle()
            guard !isIdle else { return }
            await withCheckedContinuation { continuation in
                idleWaiters.append(continuation)
            }
        }

        func drainForTesting() async {
            await flushForBarrier()
        }

        private var isIdle: Bool {
            pending.isEmpty && !decodeInFlight && scheduledDrain == nil
        }

        private func signalIdleIfReady() {
            guard isIdle else { return }
            let waiters = idleWaiters
            idleWaiters.removeAll()
            for waiter in waiters { waiter.resume() }
        }
    }

    private lazy var projectionSnapshotCoalescer = ProjectionSnapshotCoalescer {
        [weak self] snapshot in
        guard let self else { return }
        self.applyDecodedSnapshot(snapshot)
    }

    private var projectionBatchAssembler = ProjectionSnapshotBatchAssembler()
    private lazy var projectionEnvelopeBatchCoalescer = ProjectionEnvelopeBatchCoalescer {
        [weak self] messages in
        self?.applyDecodedProjectionMessages(messages)
    }

    private func handle(method: String, params: Data?) async {
        guard let params else { return }
        switch PairedHostBridgeBoundary.lane(forServerMethod: method) {
        case .hostAuthority:
            _ = hostProjection.receive(method: method, params: params)
            return
        case .bridgeExtension:
            break
        case .unsupported:
            return
        }
        switch method {
        case "bridge.broadcastRemoteProjectionSnapshot":
            projectionSnapshotCoalescer.enqueue(params)
        case "bridge.broadcastWorkspaceList":
            guard let message = try? TWCoders.decoder.decode(WorkspaceListMessage.self, from: params)
            else {
                print("[tw] DECODE FAILED: workspace list")
                return
            }
            applyWorkspaceList(message)
        case "bridge.broadcastThreadList":
            guard let message = try? TWCoders.decoder.decode(ThreadListMessage.self, from: params)
            else {
                print("[tw] DECODE FAILED: thread list")
                return
            }
            applyThreadList(message)
        case "bridge.broadcastModelUsage":
            guard let message = try? TWCoders.decoder.decode(ModelUsageMessage.self, from: params)
            else {
                print("[tw] DECODE FAILED: model usage")
                return
            }
            modelUsage = message.usage
        case "bridge.broadcastUsageRollup":
            guard let message = try? TWCoders.decoder.decode(UsageRollupMessage.self, from: params)
            else {
                print("[tw] DECODE FAILED: usage rollup")
                return
            }
            usageRollup = message.rollup
            taskwraithTokenDaily = message.taskwraithDaily
            externalTokenDaily = message.externalDaily
        case "bridge.broadcastWelcomeDashboard":
            guard
                let message = try? TWCoders.decoder.decode(WelcomeDashboardMessage.self, from: params)
            else {
                print("[tw] DECODE FAILED: welcome dashboard")
                return
            }
            welcomeDashboard = message.dashboard
        case "bridge.broadcastFirstLaunchState":
            guard
                let message = try? TWCoders.decoder.decode(FirstLaunchStateMessage.self, from: params)
            else {
                print("[tw] DECODE FAILED: first launch state")
                return
            }
            firstLaunchState = message.state
        case "bridge.broadcastProviderModels":
            guard let message = try? TWCoders.decoder.decode(ProviderModelsMessage.self, from: params)
            else { return }
            providerModels = Dictionary(
                uniqueKeysWithValues: message.providers.map { ($0.provider, $0.models) })
        case "bridge.broadcastBannerTemplate":
            // Persisted to the shared App Group, NOT held in memory: the reader
            // that matters is the Notification Service Extension, a separate
            // process that only runs when a push lands. A decode failure leaves
            // the previously-stored template in place rather than reverting to
            // the default — a malformed broadcast shouldn't silently discard a
            // template the user already configured.
            guard let message = try? TWCoders.decoder.decode(BannerTemplateMessage.self, from: params)
            else {
                print("[tw] DECODE FAILED: banner template")
                return
            }
            TWBannerTemplateStore.save(message.template)
            if let activity = message.activity {
                // Absent ⇒ an older Mac that predates Live Activities. Leaving
                // the stored appearance alone is right: rewriting it to defaults
                // would silently undo the user's choice every time they paired
                // with a Mac that has not been updated yet.
                TWActivityPreferences.apply(activity)
                #if os(iOS)
                    // Existing activities keep the palette they were STARTED
                    // with — ActivityKit attributes are immutable — so a colour
                    // change lands on the next run, not this one.
                    syncRunActivities()
                #endif
            }
        case "bridge.broadcastRemoteProjection":
            // Both low-latency one-offs and the host's oversized full-snapshot
            // fallback use this method. Batch/decode off-main; a following
            // non-projection transport event is an ordering barrier.
            projectionEnvelopeBatchCoalescer.enqueue(params)
        case "bridge.runEvent":
            struct WirePayload: Codable {
                let data: String?
                let appRunId: String?
            }
            struct Wire: Codable {
                let threadId: String?
                let channel: String?
                let provider: String?
                let payload: WirePayload?
            }
            guard let wire = try? TWCoders.decoder.decode(Wire.self, from: params),
                let threadId = wire.threadId
            else { return }
            // Token-level progressive streaming: agent-output lines carry the
            // routed provider events; append content deltas as they arrive so
            // text grows per-token instead of per-snapshot hunk.
            if wire.channel == "agent-output", let data = wire.payload?.data {
                appendStreamingDeltas(
                    threadId: threadId, runId: wire.payload?.appRunId,
                    provider: wire.provider, data: data)
            }
            if wire.channel == "agent-exit" || wire.channel == "gemini-exit" {
                markStreamingTerminal(threadId: threadId, exitRunId: wire.payload?.appRunId)
            }
            // Snapshot re-pull is the consistency backstop. During text
            // streaming the live buffer (appendStreamingDeltas above) already
            // drives the transcript, so a fast full re-pull per token only
            // rebuilds the whole snapshot object ~5x/sec and flickers the
            // settled List rows (every Row becomes a fresh, non-Equatable
            // instance). Keep the agent-exit handoff prompt, but slow
            // agent-output so the re-pull mainly catches tool rows / dedup
            // instead of fighting the stream.
            let isExit = wire.channel == "agent-exit" || wire.channel == "gemini-exit"
            // IF2 (Track-A stall fix): while THIS thread is on-screen and its
            // live stream buffer is driving the transcript, an agent-output
            // re-pull is pure amplification — the phone asks the Mac for a
            // 24-row snapshot it is already rendering live, on top of the
            // host's own pushes. Skip it entirely; the agent-exit refresh
            // (kept below) plus the host's terminal trailing flush restore
            // full consistency when the stream ends. Off-screen threads keep
            // the slow re-pull so their previews stay fresh.
            if Self.shouldSuppressStreamRefreshPull(
                channel: wire.channel,
                isStreamingThread: streamingRunIds[threadId] != nil,
                isVisibleThread: visibleThreadId == threadId)
            {
                return
            }
            let debounceNanos: UInt64 =
                isExit
                ? 200_000_000
                : (wire.channel == "agent-output" ? 700_000_000 : 450_000_000)
            scheduleThreadRefresh(
                threadId, debounceMs: debounceNanos,
                bypassVisibleStreamSuppression: isExit)
        default:
            break
        }
    }

    /// Parse routed provider JSONL line(s) and append content deltas. The
    /// line is `JSON.stringify(routed)` — provider events flat-merged with
    /// routing fields; raw Gemini CLI chunks arrive as multi-line fragments,
    /// so split + tolerate partial lines.
    /// Exit-contract (S3): flush staged stream text before capture so the
    /// 900ms handoff guard compares the final bubble, then mark the thread
    /// terminal so the reveal cursor drains within the handoff window. The
    /// final snapshot supersedes the live bubble; clear shortly after the
    /// refresh lands so the handoff doesn't flash empty.
    ///
    /// `exitRunId` guards against a STALE exit: on cancel-then-resend / steer,
    /// run A's trailing exit can arrive while run B is already streaming on
    /// the same thread — marking terminal then would slam B's live reveal
    /// (and arm a deferred clear against B's bubble). An exit for a run other
    /// than the live one is a no-op; a nil exitRunId keeps legacy behavior.
    private func markStreamingTerminal(threadId: String, exitRunId: String? = nil) {
        guard remoteThreadContentIsAllowed(keys: [threadId]) else { return }
        if let exitRunId, let live = streamingRunIds[threadId], live != exitRunId {
            return
        }
        streamingPublishGate.flushBeforeTerminal(threadId: threadId)
        // AFTER the flush: flushBeforeTerminal publishes synchronously, and
        // applyStreamingStagingPublish clears terminal membership (tokens
        // flowing = live). Insertion must win over that final flush publish.
        if !streamingTerminalThreads.contains(threadId) {
            streamingTerminalThreads.insert(threadId)
        }
        let captured = streamingTexts[threadId]
        let capturedRunId = streamingRunIds[threadId]
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 900_000_000)
            await MainActor.run {
                guard let self,
                    self.streamingTexts[threadId] == captured,
                    self.streamingRunIds[threadId] == capturedRunId
                else { return }
                self.streamingTexts[threadId] = nil
                self.streamingSegments[threadId] = nil
                self.streamingRunIds[threadId] = nil
                self.streamingProviders[threadId] = nil
                self.streamingItemIds[threadId] = nil
                self.streamingTerminalThreads.remove(threadId)
                self.streamingPublishGate.reset(threadId: threadId)
            }
        }
    }

    private func appendStreamingDeltas(
        threadId: String, runId: String?, provider: String?, data: String
    ) {
        guard remoteThreadContentIsAllowed(keys: [threadId]) else { return }
        var staging = streamingPublishGate.staging(
            for: threadId,
            fallbackSegments: streamingSegments[threadId] ?? [streamingTexts[threadId] ?? ""],
            fallbackProvider: streamingProviders[threadId],
            fallbackRunId: streamingRunIds[threadId],
            fallbackItemId: streamingItemIds[threadId])
        if let provider, !provider.isEmpty {
            staging.provider = provider
        }
        // A new run on the same thread starts a fresh bubble — without this
        // a follow-up turn would append to the previous answer's text.
        var publishMode: StreamingPublishGate.PublishMode = .coalescedIfBurst
        if let runId, let current = staging.runId ?? streamingRunIds[threadId], current != runId {
            staging = StreamingPublishGate.Staging(
                segments: [""], provider: provider, runId: runId, itemId: nil)
            streamingPublishGate.reset(threadId: threadId)
            streamingPublishGate.setStaging(staging, for: threadId, mode: .immediate)
            publishMode = .coalescedIfBurst
        }
        var segments = staging.segments
        var appended = false
        var changed = false
        for line in data.split(separator: "\n", omittingEmptySubsequences: true) {
            guard let lineData = line.data(using: .utf8),
                let parsed = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any]
            else { continue }
            let kind = parsed["type"] as? String
            if kind == "tool_use" || kind == "tool_call" {
                // A tool boundary SEALS the current segment — the transcript
                // view slots the run's tool rows between sealed segments, so
                // the live order matches the finished transcript. Empty
                // segments are kept: they hold the position of back-to-back
                // tool calls for the interleave count.
                segments.append("")
                staging.segments = segments
                changed = true
                streamingPublishGate.setStaging(staging, for: threadId, mode: .immediate)
                publishMode = .coalescedIfBurst
                continue
            }
            guard kind == "content" || kind == "token" else { continue }
            // Cumulative restatements REPLACE on the desktop; the live
            // bubble already holds the streamed deltas — skip them.
            if (parsed["cumulative"] as? Bool) == true,
                segments.contains(where: { !$0.isEmpty })
            {
                continue
            }
            let text =
                (parsed["text"] as? String) ?? (parsed["content"] as? String) ?? ""
            guard !text.isEmpty else { continue }
            // Snapshot restatements (Cursor — cursor-agent stream-json, no
            // --stream-partial-output — re-states the WHOLE turn in every
            // `assistant` frame, tagged `runItemCumulative` at emission): a
            // blind append would re-add the pre-tool prose below each tool
            // (text -> tool -> WHOLE-TURN-again). Desktop parity:
            // resolveAssistantDeltaMerge keeps only the post-last-tool TAIL.
            // UNTAGGED deltas on a verified compat line are verbatim
            // increments (trustedIncremental, commit 77cca2171) and must
            // append even when they byte-match the bubble — the fold used to
            // swallow a repeated chunk ("test ", "test ") as a stale
            // snapshot. Lines without compat provenance (legacy raw stdout)
            // keep the fold's shape detection.
            let routing = StreamingDeltaRouting.decide(
                taggedSnapshotRestatement: (parsed["runItemCumulative"] as? Bool) == true
                    || (parsed["snapshot"] as? Bool) == true,
                trustedCompatLine: StreamingDeltaRouting.hasAssistantDeltaSidecar(
                    parsed["runItemEvents"])
            )
            if routing == .fold {
                switch StreamingSnapshotFold.plan(segments: segments, incoming: text) {
                case .skip:
                    // Stale/older snapshot we've already surpassed — drop it,
                    // but the seal above (if any) still changed the segments.
                    continue
                case .replaceLastSegment(let newTail):
                    segments[segments.count - 1] = newTail
                    appended = true
                    changed = true
                    continue
                case .append:
                    break  // genuine increment — fall through to the append path
                }
            }
            // Desktop merge-with-separator parity: a NEW Codex agentMessage
            // item (itemId transition) is a paragraph boundary. Within an
            // item, token deltas append seamlessly as before.
            let itemId = parsed["itemId"] as? String
            if let itemId, !itemId.isEmpty {
                if let last = staging.itemId, last != itemId,
                    let tail = segments.last, !tail.isEmpty, !tail.hasSuffix("\n\n")
                {
                    segments[segments.count - 1] = tail + "\n\n"
                }
                staging.itemId = itemId
            }
            segments[segments.count - 1] += text
            appended = true
            changed = true
        }
        guard changed else { return }
        staging.segments = segments
        if appended, let runId, staging.runId != runId {
            staging.runId = runId
        }
        streamingPublishGate.setStaging(staging, for: threadId, mode: publishMode)
    }

    private func applyStreamingStagingPublish(
        threadId: String, staging: StreamingPublishGate.Staging
    ) {
        // Tokens flowing = the stream is live (again): a publish AFTER the
        // terminal mark means a new run started on this thread inside the
        // handoff window, so the reveal returns to streaming cadence. Guarded
        // (contains before remove) — an unconditional mutating access would
        // fire objectWillChange on every ~80ms publish tick for nothing.
        if streamingTerminalThreads.contains(threadId) {
            streamingTerminalThreads.remove(threadId)
        }
        streamingSegments[threadId] = staging.segments
        streamingTexts[threadId] = Self.joinedStreamText(staging.segments)
        if let provider = staging.provider, !provider.isEmpty {
            streamingProviders[threadId] = provider
        }
        if let runId = staging.runId {
            streamingRunIds[threadId] = runId
        }
        if let itemId = staging.itemId {
            streamingItemIds[threadId] = itemId
        }
    }

    /// B2 phone assertion: tell the host which thread is visible for runEvent
    /// filtering. Fail-open on the host until this arrives; re-sent on establish.
    private func reassertWatchedThreadToHost() {
        #if DEBUG
            lastWatchedThreadAssertionAppChatIdForTesting = visibleThreadId
        #endif
        guard !isDemo, client != nil else { return }
        send(BridgeAction.setWatchedThread(appChatId: visibleThreadId), silent: true)
    }

    private func sendNullWatchedThreadToHost() {
        #if DEBUG
            lastWatchedThreadAssertionAppChatIdForTesting = nil
        #endif
        guard !isDemo, client != nil else { return }
        send(BridgeAction.setWatchedThread(appChatId: nil), silent: true)
    }

    /// Scene-phase hook: background sends null watch; foreground reasserts.
    public func handleScenePhaseWatchAssertion(isActive: Bool) {
        if isActive {
            reassertWatchedThreadToHost()
        } else {
            sendNullWatchedThreadToHost()
        }
    }

    /// The single-bubble mirror of the segment list — what `streamingTexts`
    /// held before tool-boundary segmentation (paragraph break per boundary).
    static func joinedStreamText(_ segments: [String]) -> String {
        segments
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n\n")
    }

    func applyDecodedProjectionMessages(_ messages: [DecodedProjectionMessage]) {
        var incremental: [DecodedProjection] = []
        func flushIncremental() {
            guard !incremental.isEmpty else { return }
            mergeDecodedProjections(incremental)
            incremental.removeAll(keepingCapacity: true)
        }

        for message in messages {
            switch projectionBatchAssembler.ingest(message) {
            case .incremental(let projection):
                incremental.append(projection)
            case .waiting:
                break
            case .complete(let snapshot):
                flushIncremental()
                applyDecodedSnapshot(snapshot)
            }
        }
        flushIncremental()
    }

    func flushIncompleteProjectionBatches() {
        let projections = projectionBatchAssembler.drainIncomplete()
        if !projections.isEmpty {
            mergeDecodedProjections(projections)
        }
    }

    /// Merge pushed projections in arrival order, but publish each collection at
    /// most once. This is the compatibility path for old hosts without explicit
    /// batch metadata and for genuine low-latency one-off deltas.
    private func mergeDecodedProjections(_ projections: [DecodedProjection]) {
        var existingCards = taskCards.filter {
            remoteThreadContentIsAllowed(workspaceId: $0.workspaceId, keys: keys(for: $0))
        }
        var insertedCards: [RemoteTaskCard] = []
        var existingCardIndexByKey: [String: Int] = [:]
        var insertedCardIndexByKey: [String: Int] = [:]
        for (index, card) in existingCards.enumerated() {
            for key in keys(for: card) { existingCardIndexByKey[key] = index }
        }

        var nextApprovals = approvals
        var nextQuestions = questions
        var nextWorkflows = workflows
        var nextBoards = workspaceBoards
        var nextPresets = ensemblePresets
        var nextThreadSnapshots = threadSnapshots
        var nextEnsembleStates = ensembleStates
        var nextDiffSummaries = diffSummaries
        var nextGitSnapshots = gitSnapshots
        var shellAppearances: [TWRemoteShellAppearance] = []

        for projection in projections {
            switch projection {
            case .taskCard(let decodedCard, let embedded, let envelopeThreadId):
                let card = cardResolvingPendingThreadTitle(decodedCard)
                let cardKeys = keys(for: card)
                guard remoteThreadContentIsAllowed(
                    workspaceId: card.workspaceId, keys: cardKeys)
                else { continue }
                markRemoteThreadContentAllowed(for: card)
                if let index = cardKeys.compactMap({ insertedCardIndexByKey[$0] }).max() {
                    let oldCard = insertedCards[index]
                    for key in keys(for: oldCard) where insertedCardIndexByKey[key] == index {
                        insertedCardIndexByKey[key] = nil
                    }
                    insertedCards[index] = card
                    for key in cardKeys { insertedCardIndexByKey[key] = index }
                } else if let index = cardKeys.compactMap({ existingCardIndexByKey[$0] }).min() {
                    let oldCard = existingCards[index]
                    for key in keys(for: oldCard) where existingCardIndexByKey[key] == index {
                        existingCardIndexByKey[key] = nil
                    }
                    existingCards[index] = card
                    for key in cardKeys { existingCardIndexByKey[key] = index }
                } else {
                    let index = insertedCards.count
                    insertedCards.append(card)
                    for key in cardKeys { insertedCardIndexByKey[key] = index }
                }
                rememberWorkspace(for: card)
                if let state = embedded?.ensembleState {
                    for key in keys(
                        for: state, envelopeThreadId: envelopeThreadId, fallbackKey: card.id)
                    {
                        nextEnsembleStates[key] = state
                    }
                }
                if let diff = embedded?.diffSummary {
                    for key in keys(
                        for: diff, envelopeThreadId: envelopeThreadId, fallbackKey: card.id)
                    {
                        nextDiffSummaries[key] = diff
                    }
                }
                if !card.isEnsemble {
                    for key in cardKeys { nextEnsembleStates[key] = nil }
                }
            case .workflow(let workflow):
                guard remoteThreadContentIsAllowed(
                    workspaceId: workflow.workspaceId,
                    keys: projectionKeys(workflow.threadId))
                else { continue }
                if let index = nextWorkflows.firstIndex(where: { $0.id == workflow.id }) {
                    nextWorkflows[index] = workflow
                } else {
                    nextWorkflows.append(workflow)
                }
            case .workspaceBoard(let board):
                guard remoteContentIsAllowed(workspaceId: board.workspaceId) else { continue }
                if let index = nextBoards.firstIndex(where: { $0.id == board.id }) {
                    nextBoards[index] = board
                } else {
                    nextBoards.append(board)
                }
            case .ensemblePreset(let preset):
                if let index = nextPresets.firstIndex(where: { $0.id == preset.id }) {
                    nextPresets[index] = preset
                } else {
                    nextPresets.append(preset)
                }
            case .approval(let card):
                guard remoteThreadContentIsAllowed(
                    workspaceId: card.workspaceId, keys: projectionKeys(card.threadId))
                else { continue }
                mergeApprovalCard(card, into: &nextApprovals)
            case .question(let card):
                guard remoteThreadContentIsAllowed(
                    workspaceId: card.workspaceId, keys: projectionKeys(card.threadId))
                else { continue }
                mergeQuestionCard(card, into: &nextQuestions)
            case .threadSnapshot(let snapshot, let fallbackKey):
                if let fallbackKey {
                    mergeThreadSnapshot(snapshot, key: fallbackKey, into: &nextThreadSnapshots)
                }
            case .ensembleState(let state, let envelopeThreadId):
                let stateKeys = keys(for: state, envelopeThreadId: envelopeThreadId)
                guard remoteThreadContentIsAllowed(keys: stateKeys) else { continue }
                for key in stateKeys {
                    nextEnsembleStates[key] = state
                }
            case .diffSummary(let diff, let envelopeThreadId):
                let diffKeys = keys(for: diff, envelopeThreadId: envelopeThreadId)
                guard remoteThreadContentIsAllowed(keys: diffKeys) else { continue }
                for key in diffKeys {
                    nextDiffSummaries[key] = diff
                }
            case .gitSnapshot(let snapshot, let workspaceId):
                guard remoteContentIsAllowed(workspaceId: workspaceId) else { continue }
                nextGitSnapshots[workspaceId] = snapshot
            case .shellAppearance(let appearance):
                shellAppearances.append(appearance)
            case .ignored:
                break
            }
        }

        let nextTaskCards = Array(insertedCards.reversed()) + existingCards
        if nextApprovals != approvals { approvals = nextApprovals }
        if nextQuestions != questions { questions = nextQuestions }
        if nextWorkflows != workflows { workflows = nextWorkflows }
        if nextBoards != workspaceBoards { workspaceBoards = nextBoards }
        if nextPresets != ensemblePresets { ensemblePresets = nextPresets }
        if nextThreadSnapshots != threadSnapshots { threadSnapshots = nextThreadSnapshots }
        if nextEnsembleStates != ensembleStates { ensembleStates = nextEnsembleStates }
        if nextDiffSummaries != diffSummaries { diffSummaries = nextDiffSummaries }
        // Publish notification metadata first: taskCards.didSet may immediately
        // compose the final banner and must not read the previous run's diff.
        if nextTaskCards != taskCards { taskCards = nextTaskCards }
        if nextGitSnapshots != gitSnapshots { gitSnapshots = nextGitSnapshots }
        for appearance in shellAppearances { applyShellAppearance(appearance) }
    }

    /// Direct-test/local seam. Relay pushes are decoded by the envelope batcher.
    func merge(envelope: RemoteProjectionEnvelope) {
        mergeDecodedProjections([DecodedProjection(envelope)])
    }

    /// Apply a projected composer shellAppearance, ignoring stale re-broadcasts.
    /// The Mac re-sends the same `remote-shell-appearance:global` envelope in
    /// every snapshot; only a strictly-newer generatedAt updates published
    /// state. See ios/COMPOSER-SHELL-PARITY.md (E.1/E.4).
    private func applyShellAppearance(_ appearance: TWRemoteShellAppearance) {
        guard twShouldApplyShellAppearance(
            incoming: appearance.generatedAt, last: lastShellAppearanceGeneratedAt)
        else { return }
        lastShellAppearanceGeneratedAt = appearance.generatedAt
        // The Mac re-stamps generatedAt on every snapshot, so the timestamp gate
        // alone would republish constantly. iOS consumes composerStyle
        // (projectedComposerStyle) AND userName (projectedUserName) — republish
        // when EITHER changes, else a name edit (same composerStyle) never lands.
        guard
            appearance.composerStyle != projectedShellAppearance?.composerStyle
                || appearance.userName != projectedShellAppearance?.userName
        else { return }
        projectedShellAppearance = appearance
    }

    private func mergeThreadSnapshot(_ incoming: RemoteThreadSnapshot, key: String) {
        let aliasKeys = keys(for: incoming, fallbackKey: key)
        guard remoteThreadContentIsAllowed(
            workspaceId: incoming.workspaceId, keys: aliasKeys)
        else { return }
        if threadSnapshotIsExactlyCurrent(incoming, aliasKeys: aliasKeys, in: threadSnapshots) {
            reconcileThreadSnapshotAliases(incoming, aliasKeys: aliasKeys)
            return
        }
        var nextSnapshots = threadSnapshots
        mergeThreadSnapshot(incoming, key: key, into: &nextSnapshots)
        if nextSnapshots != threadSnapshots {
            threadSnapshots = nextSnapshots
        }
    }

    /// A request snapshot normally arrives once as a projection and once in the
    /// action ack. Skip only when every alias is provably the same snapshot.
    /// Non-identical acks (notably older-page windows) still merge, preserving
    /// the ack as convergence fallback when a request broadcast is dropped.
    private func threadSnapshotIsExactlyCurrent(
        _ incoming: RemoteThreadSnapshot, aliasKeys: [String],
        in snapshots: [String: RemoteThreadSnapshot]
    ) -> Bool {
        guard let primaryKey = aliasKeys.first else { return false }
        let filteredIncoming = snapshotFilteringHiddenRunSummaries(incoming, key: primaryKey)
        return aliasKeys.allSatisfy { snapshots[$0] == filteredIncoming }
    }

    private func reconcileThreadSnapshotAliases(
        _ incoming: RemoteThreadSnapshot, aliasKeys: [String]
    ) {
        for alias in aliasKeys {
            if let workspaceId = incoming.workspaceId, !workspaceId.isEmpty {
                rememberThreadWorkspace(alias, workspaceId: workspaceId)
            }
            reconcileStreamingState(against: incoming, key: alias)
        }
    }

    /// Merge into caller-owned storage so a full/fan-out batch can fold every
    /// thread window before publishing the dictionary once.
    private func mergeThreadSnapshot(
        _ incoming: RemoteThreadSnapshot,
        key: String,
        into snapshots: inout [String: RemoteThreadSnapshot]
    ) {
        let aliasKeys = keys(for: incoming, fallbackKey: key)
        guard remoteThreadContentIsAllowed(
            workspaceId: incoming.workspaceId, keys: aliasKeys)
        else { return }
        guard let primaryKey = aliasKeys.first else { return }
        if threadSnapshotIsExactlyCurrent(incoming, aliasKeys: aliasKeys, in: snapshots) {
            reconcileThreadSnapshotAliases(incoming, aliasKeys: aliasKeys)
            return
        }
        #if DEBUG
            threadSnapshotMergeWorkCountForTesting += 1
        #endif
        mergeThreadSnapshotSingle(incoming, key: primaryKey, into: &snapshots)
        guard let merged = snapshots[primaryKey] else { return }
        for alias in aliasKeys.dropFirst() {
            snapshots[alias] = merged
        }
        reconcileThreadSnapshotAliases(incoming, aliasKeys: aliasKeys)
    }

    private func mergeThreadSnapshotSingle(
        _ incoming: RemoteThreadSnapshot,
        key: String,
        into snapshots: inout [String: RemoteThreadSnapshot]
    ) {
        let filteredIncoming = snapshotFilteringHiddenRunSummaries(incoming, key: key)
        let incomingRows = filteredIncoming.rows ?? []
        // Recover a backgrounded-missed completion: if this snapshot shows the
        // run our live buffer is streaming has ENDED, the live `agent-exit` that
        // normally clears the buffers never arrived (the WS was suspended while
        // backgrounded), so clear them here. Otherwise `liveStreamRunId` stays
        // non-nil → the thread is stuck "running" and the partial live bubble
        // masks the finalized message. ONLY when this snapshot carries rows, so
        // the finalized rows replace the bubble in the same pass (no empty
        // flash); and against the UNFILTERED `incoming` so a user-dismissed run
        // summary still counts as ended. Mirrors the agent-exit clear path.
        if !incomingRows.isEmpty {
            reconcileStreamingState(against: incoming, key: key)
        }
        guard let current = snapshots[key] else {
            snapshots[key] = filteredIncoming
            return
        }
        let filteredCurrent = snapshotFilteringHiddenRunSummaries(current, key: key)
        if filteredIncoming == filteredCurrent {
            return
        }

        let currentRows = filteredCurrent.rows ?? []
        if incomingRows.isEmpty {
            snapshots[key] = ThreadSnapshotMerge.applyingMetadata(
                from: filteredIncoming, onto: filteredCurrent)
            reconcileStreamingState(against: filteredIncoming, key: key)
            return
        }
        guard !currentRows.isEmpty else {
            snapshots[key] = mergedSnapshot(
                base: filteredIncoming, fallback: filteredCurrent, rows: incomingRows,
                windowStartIndex: windowStart(for: filteredIncoming),
                totalRows: bestTotalRows(filteredIncoming, filteredCurrent))
            return
        }

        let incomingStart = windowStart(for: filteredIncoming)
        let currentStart = windowStart(for: filteredCurrent)
        var rowsById: [String: (index: Int, row: RemoteThreadSnapshot.Row)] = [:]

        for (offset, row) in currentRows.enumerated() {
            rowsById[row.id] = (currentStart + offset, row)
        }
        for (offset, row) in incomingRows.enumerated() {
            rowsById[row.id] = (incomingStart + offset, row)
        }

        let orderedPairs = rowsById.values.sorted { lhs, rhs in
            if lhs.index == rhs.index { return lhs.row.id < rhs.row.id }
            return lhs.index < rhs.index
        }
        let rows = orderedPairs.map(\.row)
        let start = orderedPairs.map(\.index).min() ?? min(incomingStart, currentStart)
        let totalRows = bestTotalRows(filteredIncoming, filteredCurrent)
        snapshots[key] = mergedSnapshot(
            base: filteredIncoming, fallback: filteredCurrent, rows: rows, windowStartIndex: start,
            totalRows: totalRows)
    }

    /// Clear orphaned live-stream buffers when a freshly-merged snapshot shows
    /// the run they were streaming has terminated. The reconnect/foreground
    /// recovery for a run that finished while the app was backgrounded (its live
    /// `agent-exit` was never delivered, so the buffers were never cleared and
    /// `liveStreamRunId` is stuck non-nil). Matched by the LIVE run id so a NEW
    /// run streaming on the same thread is never cleared by an OLD run's
    /// terminal summary. Clears the same buffer set as the agent-exit path.
    private func reconcileStreamingState(against snapshot: RemoteThreadSnapshot, key: String) {
        guard let liveRunId = streamingRunIds[key] else { return }
        var summaries = snapshot.runSummaries ?? []
        if let latest = snapshot.runSummary { summaries.append(latest) }
        guard let match = summaries.first(where: { $0.runId == liveRunId }),
            twIsTerminalRunSummary(match)
        else { return }
        streamingTexts[key] = nil
        streamingSegments[key] = nil
        streamingRunIds[key] = nil
        streamingProviders[key] = nil
        streamingItemIds[key] = nil
        if streamingTerminalThreads.contains(key) {
            streamingTerminalThreads.remove(key)
        }
        streamingPublishGate.reset(threadId: key)
    }

    private func currentRunSummaryFingerprints(
        threadId: String, fallbackRunId: String? = nil,
        fallbackEnsembleRoundId: String? = nil
    ) -> Set<String> {
        var fingerprints: Set<String> = []
        if let fallback = Self.runSummaryFingerprint(runId: fallbackRunId) {
            fingerprints.insert(fallback)
        }
        if let fallback = Self.runSummaryFingerprint(ensembleRoundId: fallbackEnsembleRoundId) {
            fingerprints.insert(fallback)
        }
        guard let snapshot = threadSnapshots[threadId] else { return fingerprints }
        if let runSummary = snapshot.runSummary {
            fingerprints.formUnion(Self.runSummaryFingerprints(runSummary))
        }
        for summary in snapshot.runSummaries ?? [] {
            fingerprints.formUnion(Self.runSummaryFingerprints(summary))
        }
        return fingerprints
    }

    private func hideRunSummaryFingerprintsForNextTurn(
        _ fingerprints: Set<String>, threadId: String
    ) {
        guard !fingerprints.isEmpty else { return }
        hiddenRunSummaryFingerprintsByThread[threadId, default: []].formUnion(fingerprints)
        guard let snapshot = threadSnapshots[threadId] else { return }
        threadSnapshots[threadId] = snapshotFilteringHiddenRunSummaries(snapshot, key: threadId)
    }

    private func snapshotFilteringHiddenRunSummaries(
        _ snapshot: RemoteThreadSnapshot, key: String
    ) -> RemoteThreadSnapshot {
        guard let hidden = hiddenRunSummaryFingerprintsByThread[key], !hidden.isEmpty else {
            return snapshot
        }
        let runSummary = snapshot.runSummary.flatMap { summary in
            Self.runSummaryIsHidden(summary, hidden: hidden) ? nil : summary
        }
        let runSummaries = snapshot.runSummaries.flatMap { summaries in
            let visible = summaries.filter { !Self.runSummaryIsHidden($0, hidden: hidden) }
            return visible.isEmpty && !summaries.isEmpty ? nil : visible
        }
        return RemoteThreadSnapshot(
            threadId: snapshot.threadId,
            taskId: snapshot.taskId,
            workspaceId: snapshot.workspaceId,
            provider: snapshot.provider,
            rows: snapshot.rows,
            totalRows: snapshot.totalRows,
            runSummary: runSummary,
            conversationCostUsd: snapshot.conversationCostUsd,
            conversationCostText: snapshot.conversationCostText,
            showRunCompleteSummary: snapshot.showRunCompleteSummary,
            notes: snapshot.notes,
            pinnedRows: snapshot.pinnedRows,
            blackboardEntries: snapshot.blackboardEntries,
            runSummaries: runSummaries,
            windowStartIndex: snapshot.windowStartIndex,
            hasMoreAbove: snapshot.hasMoreAbove,
            hasMoreBelow: snapshot.hasMoreBelow,
            threadMessageInbox: snapshot.threadMessageInbox)
    }

    private static func runSummaryIsHidden(
        _ summary: RemoteThreadSnapshot.RunSummary, hidden: Set<String>
    ) -> Bool {
        !hidden.isDisjoint(with: runSummaryFingerprints(summary))
    }

    private static func runSummaryFingerprints(
        _ summary: RemoteThreadSnapshot.RunSummary
    ) -> Set<String> {
        var fingerprints: Set<String> = []
        if let runFingerprint = runSummaryFingerprint(runId: summary.runId) {
            fingerprints.insert(runFingerprint)
        }
        if let roundFingerprint = runSummaryFingerprint(ensembleRoundId: summary.ensembleRoundId) {
            fingerprints.insert(roundFingerprint)
        }
        if !fingerprints.isEmpty {
            return fingerprints
        }
        var parts: [String] = []
        parts.append(summary.ensembleRoundId ?? "")
        parts.append(summary.provider ?? "")
        parts.append(summary.model ?? "")
        parts.append(summary.status ?? "")
        parts.append(summary.startedAt ?? "")
        parts.append(summary.endedAt ?? "")
        parts.append(summary.durationMs.map(String.init) ?? "")
        parts.append(summary.totalTokens.map(String.init) ?? "")
        parts.append(summary.tokensIn.map(String.init) ?? "")
        parts.append(summary.tokensOut.map(String.init) ?? "")
        parts.append(summary.costText ?? "")
        fingerprints.insert("summary:\(parts.joined(separator: "|"))")
        return fingerprints
    }

    private static func runSummaryFingerprint(runId: String?) -> String? {
        guard let runId = runId?.trimmingCharacters(in: .whitespacesAndNewlines),
            !runId.isEmpty
        else { return nil }
        return "run:\(runId)"
    }

    private static func runSummaryFingerprint(ensembleRoundId: String?) -> String? {
        guard let ensembleRoundId = ensembleRoundId?.trimmingCharacters(in: .whitespacesAndNewlines),
            !ensembleRoundId.isEmpty
        else { return nil }
        return "round:\(ensembleRoundId)"
    }

    private func mergedSnapshot(
        base: RemoteThreadSnapshot,
        fallback: RemoteThreadSnapshot,
        rows: [RemoteThreadSnapshot.Row],
        windowStartIndex: Int,
        totalRows: Int?
    ) -> RemoteThreadSnapshot {
        let end = windowStartIndex + rows.count
        let hasMoreBelow: Bool?
        if let totalRows {
            hasMoreBelow = end < totalRows
        } else {
            hasMoreBelow = base.hasMoreBelow ?? fallback.hasMoreBelow
        }
        return RemoteThreadSnapshot(
            threadId: base.threadId ?? fallback.threadId,
            taskId: base.taskId ?? fallback.taskId,
            workspaceId: base.workspaceId ?? fallback.workspaceId,
            provider: base.provider ?? fallback.provider,
            rows: rows,
            totalRows: totalRows ?? base.totalRows ?? fallback.totalRows,
            runSummary: mergedRunSummary(base: base.runSummary, fallback: fallback.runSummary),
            conversationCostUsd: base.conversationCostUsd ?? fallback.conversationCostUsd,
            conversationCostText: base.conversationCostText ?? fallback.conversationCostText,
            showRunCompleteSummary: base.showRunCompleteSummary ?? fallback.showRunCompleteSummary,
            notes: base.notes ?? fallback.notes,
            pinnedRows: base.pinnedRows ?? fallback.pinnedRows,
            blackboardEntries: base.blackboardEntries ?? fallback.blackboardEntries,
            runSummaries: mergedRunSummaries(base: base, fallback: fallback),
            windowStartIndex: windowStartIndex,
            hasMoreAbove: windowStartIndex > 0,
            hasMoreBelow: hasMoreBelow,
            // Same contract as the metadata merge: a present zero from the Mac
            // clears the badge; absence (a row-window projection carries no inbox
            // data) leaves the last known count alone.
            threadMessageInbox: base.threadMessageInbox ?? fallback.threadMessageInbox)
    }

    private func mergedRunSummary(
        base: RemoteThreadSnapshot.RunSummary?,
        fallback: RemoteThreadSnapshot.RunSummary?
    ) -> RemoteThreadSnapshot.RunSummary? {
        guard let base else { return fallback }
        guard let fallback else { return base }
        guard Self.runSummaryMergeKey(base) == Self.runSummaryMergeKey(fallback) else {
            return base
        }
        return Self.preferredRunSummary(base, fallback)
    }

    private func mergedRunSummaries(
        base: RemoteThreadSnapshot,
        fallback: RemoteThreadSnapshot
    ) -> [RemoteThreadSnapshot.RunSummary]? {
        guard base.runSummaries != nil || fallback.runSummaries != nil else { return nil }
        let fallbackSummaries = fallback.runSummaries ?? [fallback.runSummary].compactMap { $0 }
        let baseSummaries = base.runSummaries ?? [base.runSummary].compactMap { $0 }
        var order: [String] = []
        var summariesByKey: [String: RemoteThreadSnapshot.RunSummary] = [:]
        for summary in fallbackSummaries + baseSummaries {
            let key = Self.runSummaryMergeKey(summary)
            if let existing = summariesByKey[key] {
                summariesByKey[key] = Self.preferredRunSummary(summary, existing)
            } else {
                order.append(key)
                summariesByKey[key] = summary
            }
        }
        return order.compactMap { summariesByKey[$0] }
    }

    private static func runSummaryMergeKey(_ summary: RemoteThreadSnapshot.RunSummary) -> String {
        if let runFingerprint = runSummaryFingerprint(runId: summary.runId) {
            return runFingerprint
        }
        if let roundFingerprint = runSummaryFingerprint(ensembleRoundId: summary.ensembleRoundId) {
            return roundFingerprint
        }
        return runSummaryFingerprints(summary).sorted().joined(separator: "\n")
    }

    private static func preferredRunSummary(
        _ candidate: RemoteThreadSnapshot.RunSummary,
        _ existing: RemoteThreadSnapshot.RunSummary
    ) -> RemoteThreadSnapshot.RunSummary {
        let candidateTerminal = isTerminalRunSummary(candidate)
        let existingTerminal = isTerminalRunSummary(existing)
        if candidateTerminal != existingTerminal {
            return candidateTerminal ? candidate : existing
        }
        let candidateScore = runSummaryCompletenessScore(candidate)
        let existingScore = runSummaryCompletenessScore(existing)
        if candidateScore != existingScore {
            return candidateScore > existingScore ? candidate : existing
        }
        return existing
    }

    private static func runSummaryCompletenessScore(
        _ summary: RemoteThreadSnapshot.RunSummary
    ) -> Int {
        var score = 0
        if summary.status != nil { score += 1 }
        if summary.startedAt != nil { score += 1 }
        if summary.endedAt != nil { score += 1 }
        if summary.durationMs != nil { score += 1 }
        if summary.totalTokens != nil { score += 1 }
        if summary.tokensIn != nil { score += 1 }
        if summary.tokensOut != nil { score += 1 }
        if summary.costText != nil { score += 1 }
        if let fileChanges = summary.fileChanges {
            score += 2
            if fileChanges.filesChanged != nil { score += 1 }
            if fileChanges.additions != nil { score += 1 }
            if fileChanges.deletions != nil { score += 1 }
            if fileChanges.createdFiles != nil { score += 1 }
            if fileChanges.modifiedFiles != nil { score += 1 }
            if fileChanges.deletedFiles != nil { score += 1 }
            score += min(fileChanges.files?.count ?? 0, 12)
        }
        return score
    }

    private static func isTerminalRunSummary(_ summary: RemoteThreadSnapshot.RunSummary) -> Bool {
        twIsTerminalRunSummary(summary)
    }

    private func windowStart(for snapshot: RemoteThreadSnapshot) -> Int {
        if let value = snapshot.windowStartIndex { return max(0, value) }
        let total = snapshot.totalRows ?? 0
        let count = snapshot.rows?.count ?? 0
        return max(0, total - count)
    }

    private func bestTotalRows(_ lhs: RemoteThreadSnapshot, _ rhs: RemoteThreadSnapshot) -> Int? {
        switch (lhs.totalRows, rhs.totalRows) {
        case (.some(let a), .some(let b)): return max(a, b)
        case (.some(let a), .none): return a
        case (.none, .some(let b)): return b
        case (.none, .none): return nil
        }
    }

    private func mergeApprovalCard(
        _ card: MobileApprovalCard,
        into approvalCards: inout [MobileApprovalCard]
    ) {
        guard let id = card.toolCallId else { return }
        if let status = card.status, status != "pending" {
            approvalCards.removeAll { $0.toolCallId == id }
            repliedApprovalToolCallIds.remove(id)
            return
        }
        // Honor an optimistic dismissal: a pending delta for an approval the
        // user just answered must not flash it back while the ack is in flight.
        if repliedApprovalToolCallIds.contains(id) { return }
        if let index = approvalCards.firstIndex(where: { $0.toolCallId == id }) {
            approvalCards[index] = card
        } else {
            approvalCards.insert(card, at: 0)
        }
    }

    private func mergeQuestionCard(
        _ card: MobileQuestionCard,
        into questionCards: inout [MobileQuestionCard]
    ) {
        guard let id = card.resolvedId else { return }
        if let status = card.status, status != "pending" {
            questionCards.removeAll { $0.resolvedId == id }
            repliedQuestionIds.remove(id)
            return
        }
        // Honor an optimistic dismissal: a pending delta for a question the user
        // just answered (reply still in flight) must not flash it back.
        if repliedQuestionIds.contains(id) { return }
        if let index = questionCards.firstIndex(where: { $0.resolvedId == id }) {
            questionCards[index] = card
        } else {
            questionCards.insert(card, at: 0)
        }
    }

    private func cardThreadIds(_ card: RemoteTaskCard) -> Set<String> {
        Set([card.id, card.threadId].compactMap { $0 })
    }

    public func pendingApprovalCount(for card: RemoteTaskCard) -> Int {
        let ids = cardThreadIds(card)
        guard !ids.isEmpty else { return 0 }
        return approvals.filter { approval in
            guard let threadId = approval.threadId else { return false }
            return ids.contains(threadId)
        }.count
    }

    public func pendingQuestionCount(for card: RemoteTaskCard) -> Int {
        let ids = cardThreadIds(card)
        guard !ids.isEmpty else { return 0 }
        return questions.filter { question in
            guard let threadId = question.threadId else { return false }
            return ids.contains(threadId)
        }.count
    }

    public func pendingAttentionCount(for card: RemoteTaskCard) -> Int {
        pendingApprovalCount(for: card) + pendingQuestionCount(for: card)
    }

    private var pendingThreadRefresh: [String: Task<Void, Never>] = [:]
    private var pendingThreadSnapshotScopeWait: Set<String> = []
    private var loadingThreadSnapshots: Set<String> = []
    #if DEBUG
        private(set) var threadSnapshotPullAttemptsForTesting = 0
        private(set) var lastWatchedThreadAssertionAppChatIdForTesting: String? = nil
        private(set) var threadSnapshotMergeWorkCountForTesting = 0
    #endif

    private func scheduleThreadRefresh(
        _ threadId: String, debounceMs: UInt64 = 450_000_000,
        bypassVisibleStreamSuppression: Bool = false
    ) {
        if !bypassVisibleStreamSuppression,
            Self.shouldSuppressOnDemandSnapshotPull(
                isStreamingThread: streamingRunIds[threadId] != nil,
                isVisibleThread: visibleThreadId == threadId)
        {
            return
        }
        pendingThreadRefresh[threadId]?.cancel()
        pendingThreadRefresh[threadId] = Task { [weak self, bypassVisibleStreamSuppression] in
            try? await Task.sleep(nanoseconds: debounceMs)
            guard !Task.isCancelled else { return }
            await MainActor.run {
                self?.requestThreadSnapshot(
                    threadId, bypassVisibleStreamSuppression: bypassVisibleStreamSuppression)
            }
        }
    }

    /// iOS5: user explicitly mutated thread state (composer send, approval,
    /// roster edit, etc.) — convergence must reach the wire even while the
    /// visible live stream buffer is driving the transcript.
    /// Pass-5 iOS5: count of `scheduleThreadRefreshAfterUserAction` call sites in
    /// `RemoteSessionModel.swift` (grep-maintained inventory for the pull audit).
    nonisolated static let ios5UserInitiatedThreadRefreshSiteCount = 25

    private func scheduleThreadRefreshAfterUserAction(
        _ threadId: String, debounceMs: UInt64 = 450_000_000
    ) {
        scheduleThreadRefresh(
            threadId, debounceMs: debounceMs, bypassVisibleStreamSuppression: true)
    }

    #if DEBUG
        func scheduleThreadRefreshAfterUserActionForTesting(
            _ threadId: String, debounceMs: UInt64 = 450_000_000
        ) {
            scheduleThreadRefreshAfterUserAction(threadId, debounceMs: debounceMs)
        }

        func scheduleThreadRefreshForTesting(
            _ threadId: String, debounceMs: UInt64 = 450_000_000,
            bypassVisibleStreamSuppression: Bool = false
        ) {
            scheduleThreadRefresh(
                threadId, debounceMs: debounceMs,
                bypassVisibleStreamSuppression: bypassVisibleStreamSuppression)
        }

        var pendingThreadRefreshCountForTesting: Int { pendingThreadRefresh.count }

        func cancelPendingThreadRefreshForTesting() {
            pendingThreadRefresh.values.forEach { $0.cancel() }
            pendingThreadRefresh = [:]
        }

        func isLoadingThreadSnapshotForTesting(_ threadId: String) -> Bool {
            loadingThreadSnapshots.contains(threadId)
        }

        func seedStreamingStateForTesting(threadId: String, runId: String = "run-test") {
            streamingRunIds[threadId] = runId
        }

        func seedThreadSnapshotForTesting(_ snapshot: RemoteThreadSnapshot, key: String) {
            threadSnapshots[key] = snapshot
        }

        func mergeThreadSnapshotProjectionForTesting(
            _ snapshot: RemoteThreadSnapshot, key: String
        ) {
            var nextSnapshots = threadSnapshots
            mergeThreadSnapshot(snapshot, key: key, into: &nextSnapshots)
            if nextSnapshots != threadSnapshots {
                threadSnapshots = nextSnapshots
            }
        }

        func mergeThreadSnapshotAckForTesting(_ snapshot: RemoteThreadSnapshot, key: String) {
            mergeThreadSnapshot(snapshot, key: key)
        }

        func cacheGitSnapshotForTesting(_ snapshot: GitWorkspaceSnapshot, workspaceId: String) {
            cacheGitSnapshot(snapshot, workspaceId: workspaceId)
        }

        func seedEnsembleStateForTesting(_ state: RemoteEnsembleState, key: String) {
            ensembleStates[key] = state
        }

        func appendStreamingDeltasForTesting(
            threadId: String, data: String, runId: String? = "run-test", provider: String = "codex"
        ) {
            appendStreamingDeltas(threadId: threadId, runId: runId, provider: provider, data: data)
        }

        func flushStreamingPublishForTesting(threadId: String) {
            streamingPublishGate.flushBeforeTerminal(threadId: threadId)
        }

        func waitForStreamingPublishForTesting(threadId: String) async {
            await streamingPublishGate.waitForScheduledFlushForTesting(threadId: threadId)
        }

        func markStreamingTerminalForTesting(threadId: String, exitRunId: String? = nil) {
            markStreamingTerminal(threadId: threadId, exitRunId: exitRunId)
        }

        func seedWorkflowsForTesting(_ seeded: [RemoteWorkflow]) {
            workflows = seeded
        }

        func resetStreamingPublishGateForTesting(threadId: String) {
            streamingPublishGate.reset(threadId: threadId)
        }

        var streamingPublishInvocationCountForTesting: Int {
            streamingPublishGate.publishInvocationCount
        }
    #endif

    private func flushPendingThreadSnapshotRequests() {
        guard !pendingThreadSnapshotScopeWait.isEmpty else { return }
        let ready = pendingThreadSnapshotScopeWait.filter { remoteScopeForThread($0) != nil }
        for threadId in ready {
            pendingThreadSnapshotScopeWait.remove(threadId)
            requestThreadSnapshot(threadId)
        }
    }

    private func projectionKeys(_ candidates: String?...) -> [String] {
        var seen: Set<String> = []
        var keys: [String] = []
        for candidate in candidates {
            guard let key = candidate?.trimmingCharacters(in: .whitespacesAndNewlines),
                !key.isEmpty, !seen.contains(key)
            else { continue }
            seen.insert(key)
            keys.append(key)
        }
        return keys
    }

    private func remoteContentIsAllowed(workspaceId: String?) -> Bool {
        guard let workspaceId, !workspaceId.isEmpty, workspaceId != "global" else { return true }
        return !deniedRemoteWorkspaceIds.contains(workspaceId)
    }

    private func remoteThreadContentIsAllowed(keys: [String]) -> Bool {
        !keys.contains { key in
            guard let workspaceId = revokedThreadWorkspaceHints[key] ?? threadWorkspaceHints[key]
            else { return false }
            return deniedRemoteWorkspaceIds.contains(workspaceId)
        }
    }

    private func remoteThreadContentIsAllowed(
        workspaceId: String?, keys: [String]
    ) -> Bool {
        remoteContentIsAllowed(workspaceId: workspaceId)
            && remoteThreadContentIsAllowed(keys: keys)
    }

    private func markRemoteThreadContentAllowed(for card: RemoteTaskCard) {
        let cardKeys = keys(for: card)
        guard remoteThreadContentIsAllowed(workspaceId: card.workspaceId, keys: cardKeys)
        else { return }
        for key in cardKeys { revokedThreadWorkspaceHints[key] = nil }
    }

    private func keys(for card: RemoteTaskCard) -> [String] {
        projectionKeys(card.id, card.threadId)
    }

    private func keys(for snapshot: RemoteThreadSnapshot, fallbackKey: String?) -> [String] {
        projectionKeys(fallbackKey, snapshot.taskId, snapshot.threadId)
    }

    private func keys(
        for state: RemoteEnsembleState, envelopeThreadId: String? = nil, fallbackKey: String? = nil
    ) -> [String] {
        projectionKeys(fallbackKey, state.taskId, state.threadId, envelopeThreadId)
    }

    private func keys(
        for diff: MobileDiffSummary, envelopeThreadId: String? = nil, fallbackKey: String? = nil
    ) -> [String] {
        projectionKeys(fallbackKey, diff.taskId, diff.threadId, envelopeThreadId)
    }

    private func rememberWorkspace(for card: RemoteTaskCard) {
        let cardKeys = keys(for: card)
        guard remoteThreadContentIsAllowed(workspaceId: card.workspaceId, keys: cardKeys)
        else { return }
        markRemoteThreadContentAllowed(for: card)
        let workspaceId = card.workspaceId?.isEmpty == false ? card.workspaceId! : "global"
        for key in cardKeys {
            rememberThreadWorkspace(key, workspaceId: workspaceId)
        }
    }

    /// The workspace scope an action presents for this thread: the chat's
    /// workspace id, or the reserved "global" sentinel for scope-global
    /// chats (no bound workspace). Global chats keep the full composer on
    /// the phone (T72) — they are NOT view-only; the Mac clamps phone-origin
    /// turns to plan mode (no file mutation) since there's no workspace bound.
    public func remoteScopeForThread(_ threadId: String) -> String? {
        if let card = taskCards.first(where: { $0.id == threadId || $0.threadId == threadId }) {
            if let workspaceId = card.workspaceId, !workspaceId.isEmpty { return workspaceId }
            return "global"
        }
        if let snapshot = threadSnapshots[threadId], let workspaceId = snapshot.workspaceId {
            return workspaceId.isEmpty ? "global" : workspaceId
        }
        return threadWorkspaceHints[threadId]
    }

    /// Pull the full body for a clipped row from the Mac.
    public func expandRow(threadId: String, rowId: String) {
        // Don't no-op silently on a guard-fail: expandingRows is NOT set here,
        // so the button never disables and a silent return is indistinguishable
        // from a dropped tap ("took a couple of goes"). Surface a transient
        // banner so the tap visibly does something.
        guard let workspaceId = remoteScopeForThread(threadId) else {
            lastActionMessage = "Reconnecting — try Show more again in a moment."
            return
        }
        expandingRows.insert(rowId)
        let params = BridgeAction.threadRowExpand(
            workspaceId: workspaceId, threadId: threadId, rowId: rowId)
        Task {
            do {
                let actionAck = try await self.requestFileAction(params)
                guard let row = actionAck.data?.row else {
                    await MainActor.run { _ = self.expandingRows.remove(rowId) }
                    return
                }
                await MainActor.run {
                    var perThread = self.rowExpansions[threadId] ?? [:]
                    perThread[rowId] = row
                    self.rowExpansions[threadId] = perThread
                    self.expandingRows.remove(rowId)
                }
            } catch {
                await MainActor.run {
                    self.lastActionMessage = Self.actionFailureMessage(error, phase: self.phase)
                    self.expandingRows.remove(rowId)
                }
            }
        }
    }

    public func resolvedRow(_ row: RemoteThreadSnapshot.Row, threadId: String)
        -> RemoteThreadSnapshot.Row
    {
        rowExpansions[threadId]?[row.id] ?? row
    }

    public func fetchThreadMedia(
        threadId: String, rowId: String, mediaId: String, variant: String = "full",
        maxBytes: Int = 8 * 1024 * 1024
    ) async throws -> TranscriptMediaFetchResult {
        guard !isDemo else { throw RemoteFileActionError.denied("Demo mode has no Mac media store.") }
        guard let workspaceId = remoteScopeForThread(threadId)
        else { throw RemoteFileActionError.denied("Thread is not in an allowlisted workspace.") }
        let params = BridgeAction.threadMediaFetch(
            workspaceId: workspaceId, threadId: threadId, rowId: rowId, mediaId: mediaId,
            variant: variant, maxBytes: maxBytes)
        do {
            let ack = try await requestFileAction(params, timeoutMs: 30_000)
            guard let media = ack.data?.media else { throw RemoteFileActionError.malformedAck }
            return media
        } catch {
            await MainActor.run {
                // Same phase guard as send() and requestThreadSnapshot: a media-fetch ack can
                // time out on a slow Mac while the socket is healthy. Calm copy when connected;
                // alarming banner preserved for genuinely disconnected/asleep Mac.
                // Re-throw is unconditional so the caller (media loading UI) still receives the error.
                self.lastActionMessage = Self.actionFailureMessage(error, phase: self.phase)
            }
            throw error
        }
    }

    /// Fetch ONE byte slice of a transcript media asset in range mode, for the
    /// AVAssetResourceLoaderDelegate that streams large AV to AVPlayer. Mirrors
    /// `fetchThreadMedia` exactly (same gating + connected-phase timeout remap),
    /// but requests `variant: "full"` with `offset`/`length` and returns the raw
    /// bytes plus the asset's total size. The Mac hard-clamps each slice to
    /// 448 KiB, so the returned data may be shorter than `length` — the caller
    /// advances by `data.count`, never by the requested length.
    public func fetchThreadMediaChunk(
        threadId: String, rowId: String, mediaId: String,
        offset: Int, length: Int
    ) async throws -> (data: Data, totalBytes: Int) {
        guard !isDemo else { throw RemoteFileActionError.denied("Demo mode has no Mac media store.") }
        guard let workspaceId = remoteScopeForThread(threadId)
        else { throw RemoteFileActionError.denied("Thread is not in an allowlisted workspace.") }
        let params = BridgeAction.threadMediaFetch(
            workspaceId: workspaceId, threadId: threadId, rowId: rowId, mediaId: mediaId,
            variant: "full", maxBytes: max(length, 1), offset: offset, length: length)
        do {
            let ack = try await requestFileAction(params, timeoutMs: 30_000)
            guard let media = ack.data?.media else { throw RemoteFileActionError.malformedAck }
            guard let data = Data(base64Encoded: media.dataBase64) else {
                throw RemoteFileActionError.malformedAck
            }
            return (data, media.totalBytes ?? media.byteLength ?? data.count)
        } catch {
            await MainActor.run {
                // Same phase guard as fetchThreadMedia: a slice ack can time out
                // on a slow Mac while the socket is healthy. Calm copy when
                // connected; alarming banner preserved for a genuinely
                // disconnected/asleep Mac. Re-throw is unconditional so the
                // resource loader still surfaces the error to AVFoundation.
                self.lastActionMessage = Self.actionFailureMessage(error, phase: self.phase)
            }
            throw error
        }
    }

    /// Display name for a workspace id (telemetry rail / headers).
    ///
    /// Raw projected `displayName` — the folder root name for most workspaces.
    /// Prefer ``workspaceRepoName(for:)`` for anything the user reads alongside
    /// a branch; this stays for surfaces that genuinely mean "the workspace
    /// entry" rather than "the repository".
    public func workspaceName(for workspaceId: String?) -> String? {
        guard let workspaceId else { return nil }
        return workspaces.first(where: { $0.id == workspaceId })?.displayName
    }

    /// The workspace's OFFICIAL repo name, resolved the way the desktop
    /// composer's above-row resolves it (`resolveWorkspaceDisplayName`): git
    /// remote → repo root → folder path, with the legacy AGBench → TaskWraith
    /// rewrite. Without this the same checkout reads "TaskWraith" on desktop
    /// and "AGBench" on the phone.
    ///
    /// Falls back to the plain display name whenever no git snapshot has landed
    /// yet, so the pill never blanks while the snapshot is in flight.
    public func workspaceRepoName(for workspaceId: String?) -> String? {
        guard let workspaceId else { return nil }
        guard let workspace = workspaces.first(where: { $0.id == workspaceId }) else { return nil }
        let snapshot = gitSnapshots[workspaceId]
        let resolved = TWWorkspaceDisplayName.resolve(
            displayName: workspace.displayName,
            path: workspace.path,
            repoRoot: snapshot?.repoRoot,
            remoteUrl: snapshot?.remoteUrl)
        return resolved.isEmpty ? workspace.displayName : resolved
    }

    public func workspaceId(forPath path: String?) -> String? {
        guard let path, !path.isEmpty else { return nil }
        return workspaces.first(where: { $0.path == path })?.id
    }

    public var fileEditableWorkspaces: [WorkspaceSummary] {
        workspaces.filter { workspaceCanEditFiles($0.id) }
    }

    public func workspaceCanEditFiles(_ workspaceId: String?) -> Bool {
        guard let workspaceId,
            let capabilities = workspaces.first(where: { $0.id == workspaceId })?.capabilities
        else { return false }
        return capabilities.fileBrowse == true
            && capabilities.fileRead == true
            && capabilities.fileWrite == true
    }

    public func requestFilesMode(workspaceId: String? = nil, targetPath: String? = nil) {
        fileModeRequest = FileModeRequest(workspaceId: workspaceId, targetPath: targetPath)
    }

    public var diffReviewableWorkspaces: [WorkspaceSummary] {
        workspaces.filter { workspaceCanReviewDiffs($0.id) }
    }

    public func workspaceCanReviewDiffs(_ workspaceId: String?) -> Bool {
        guard let workspaceId,
            let capabilities = workspaces.first(where: { $0.id == workspaceId })?.capabilities
        else { return false }
        return capabilities.diffReview == true
    }

    /// Local Git mutations (stage/commit) ride the fileWrite capability.
    /// External publication (push/create-PR) is deliberately separate.
    public func workspaceCanRunGitMutations(_ workspaceId: String?) -> Bool {
        guard let workspaceId,
            let capabilities = workspaces.first(where: { $0.id == workspaceId })?.capabilities
        else { return false }
        return capabilities.fileWrite == true
    }

    public func workspaceCanPublishExternally(_ workspaceId: String?) -> Bool {
        guard let workspaceId,
            let capabilities = workspaces.first(where: { $0.id == workspaceId })?.capabilities
        else { return false }
        return capabilities.externalPublish == true
    }

    public func requestDiffMode(workspaceId: String? = nil, targetPath: String? = nil) {
        diffModeRequest = DiffModeRequest(workspaceId: workspaceId, targetPath: targetPath)
    }

    public func refreshGitSnapshotCache(workspaceId: String?) async {
        guard let workspaceId, !workspaceId.isEmpty, workspaceCanReviewDiffs(workspaceId)
        else { return }
        do {
            _ = try await fetchGitSnapshot(workspaceId: workspaceId)
        } catch {
            removeCachedGitSnapshot(workspaceId: workspaceId)
        }
    }

    /// Event-driven refresh shared by the composer diff surfaces (compact
    /// pill + focused changes rows): fetch quietly — no Mac-side rebroadcast
    /// — but store into the published `gitSnapshots` cache so every surface
    /// renders the same numbers. Unlike `refreshGitSnapshotCache`, a failed
    /// fetch keeps the last good snapshot instead of wiping it: these fire
    /// opportunistically (run-finish, foregrounding, diff-sheet open) and a
    /// dropped ack must not blank rows that were showing valid counts.
    public func refreshGitSnapshotCacheQuietly(workspaceId: String?) async {
        guard let workspaceId, !workspaceId.isEmpty else { return }
        guard let git = try? await fetchGitSnapshotWithoutPublishing(workspaceId: workspaceId)
        else { return }
        cacheGitSnapshot(git, workspaceId: workspaceId)
    }

    public enum RemoteFileActionError: LocalizedError {
        case notConnected
        case denied(String)
        case malformedAck

        public var errorDescription: String? {
            switch self {
            case .notConnected:
                return "Not connected to your Mac."
            case .denied(let message):
                return message
            case .malformedAck:
                return "The Mac returned an unreadable file response."
            }
        }
    }

    public func listWorkspaceFiles(
        workspaceId: String, path: String? = nil, query: String? = nil, limit: Int? = nil
    ) async throws -> (
        entries: [WorkspaceFileEntry], truncated: Bool
    ) {
        if isDemo {
            // Return the whole flat tree; the view's immediateChildren/searchMatches
            // filter by path/query.
            return (Self.decodeDemo([WorkspaceFileEntry].self, Self.demoFileTreeJSON) ?? [], false)
        }
        let ack = try await requestFileAction(
            BridgeAction.workspaceFileList(
                workspaceId: workspaceId, path: path, query: query, limit: limit))
        return (ack.data?.entries ?? [], ack.data?.truncated ?? false)
    }

    public func readWorkspaceFile(
        workspaceId: String, path: String
    ) async throws -> WorkspaceFileReadResult {
        if isDemo {
            let content =
                demoFileEdits[path] ?? Self.demoFileContents[path]
                ?? "// \(path)\n// Demo file — connect TaskWraith on your Mac to read the real contents.\n"
            guard let result = Self.demoFileReadResult(path: path, content: content) else {
                throw RemoteFileActionError.malformedAck
            }
            return result
        }
        let ack = try await requestFileAction(
            BridgeAction.workspaceFileRead(workspaceId: workspaceId, path: path))
        guard let file = ack.data?.file else { throw RemoteFileActionError.malformedAck }
        return file
    }

    public func writeWorkspaceFile(
        workspaceId: String, path: String, content: String, baseEtag: String
    ) async throws -> WorkspaceFileReadResult {
        if isDemo {
            demoFileEdits[path] = content  // local, in-memory; wiped on demo exit
            guard let result = Self.demoFileReadResult(path: path, content: content) else {
                throw RemoteFileActionError.malformedAck
            }
            lastActionMessage = "Saved (demo)."
            return result
        }
        let ack = try await requestFileAction(
            BridgeAction.workspaceFileWrite(
                workspaceId: workspaceId, path: path, content: content, baseEtag: baseEtag),
            timeoutMs: 16_000)
        guard let file = ack.data?.file else { throw RemoteFileActionError.malformedAck }
        return file
    }

    public func deleteWorkspaceFile(workspaceId: String, path: String, baseEtag: String) async throws -> String {
        if isDemo {
            demoFileEdits.removeValue(forKey: path)
            lastActionMessage = "Deleted (demo)."
            return path
        }
        let ack = try await requestFileAction(
            BridgeAction.workspaceFileDelete(workspaceId: workspaceId, path: path, baseEtag: baseEtag),
            timeoutMs: 16_000)
        return ack.data?.path ?? path
    }

    /// Bounded workspace diff for the Diff Studio — the Mac runs the same
    /// git surface the desktop Diff Studio uses and returns it in the ack.
    public func fetchWorkspaceDiff(workspaceId: String) async throws -> WorkspaceDiffResult {
        if isDemo {
            guard let result = Self.decodeDemo(WorkspaceDiffResult.self, Self.demoWorkspaceDiffJSON)
            else { throw RemoteFileActionError.malformedAck }
            return result
        }
        let ack = try await requestFileAction(
            BridgeAction.workspaceDiff(workspaceId: workspaceId), timeoutMs: 16_000)
        guard let diff = ack.data?.diff else { throw RemoteFileActionError.malformedAck }
        return diff
    }

    // ── Git workflows — the Mac's GitService is the single authority; every
    //    mutation is an explicit phone UI action, never agent-initiated. ────

    private func fetchGitSnapshotPayload(workspaceId: String, publish: Bool) async throws
        -> GitWorkspaceSnapshot
    {
        if isDemo {
            guard let snap = Self.decodeDemo(GitWorkspaceSnapshot.self, Self.demoGitSnapshotJSON)
            else { throw RemoteFileActionError.malformedAck }
            return snap
        }
        let ack = try await requestFileAction(
            BridgeAction.gitSnapshot(workspaceId: workspaceId, publish: publish), timeoutMs: 16_000)
        guard let git = ack.data?.git else { throw RemoteFileActionError.malformedAck }
        return git
    }

    public func fetchGitSnapshotWithoutPublishing(workspaceId: String) async throws
        -> GitWorkspaceSnapshot
    {
        try await fetchGitSnapshotPayload(workspaceId: workspaceId, publish: false)
    }

    public func fetchGitSnapshot(workspaceId: String) async throws -> GitWorkspaceSnapshot {
        let git = try await fetchGitSnapshotPayload(workspaceId: workspaceId, publish: true)
        cacheGitSnapshot(git, workspaceId: workspaceId)
        return git
    }

    /// A git action can arrive as a projection broadcast before or after its
    /// ack. `@Published` emits even for an equal dictionary subscript write, so
    /// every ack-side cache update must pass through this equality gate.
    private func cacheGitSnapshot(_ snapshot: GitWorkspaceSnapshot, workspaceId: String) {
        guard remoteContentIsAllowed(workspaceId: workspaceId) else { return }
        guard gitSnapshots[workspaceId] != snapshot else { return }
        gitSnapshots[workspaceId] = snapshot
    }

    private func removeCachedGitSnapshot(workspaceId: String) {
        guard gitSnapshots[workspaceId] != nil else { return }
        gitSnapshots.removeValue(forKey: workspaceId)
    }

    public func stageAllChanges(workspaceId: String) async throws -> GitWorkspaceSnapshot {
        let ack = try await requestFileAction(
            BridgeAction.gitStageAll(workspaceId: workspaceId), timeoutMs: 20_000)
        guard let git = ack.data?.git else { throw RemoteFileActionError.malformedAck }
        cacheGitSnapshot(git, workspaceId: workspaceId)
        return git
    }

    public func stagePaths(workspaceId: String, paths: [String]) async throws -> GitWorkspaceSnapshot {
        let ack = try await requestFileAction(
            BridgeAction.gitStagePaths(workspaceId: workspaceId, paths: paths), timeoutMs: 20_000)
        guard let git = ack.data?.git else { throw RemoteFileActionError.malformedAck }
        cacheGitSnapshot(git, workspaceId: workspaceId)
        return git
    }

    public func unstagePaths(workspaceId: String, paths: [String]) async throws -> GitWorkspaceSnapshot {
        let ack = try await requestFileAction(
            BridgeAction.gitUnstagePaths(workspaceId: workspaceId, paths: paths), timeoutMs: 20_000)
        guard let git = ack.data?.git else { throw RemoteFileActionError.malformedAck }
        cacheGitSnapshot(git, workspaceId: workspaceId)
        return git
    }

    /// Commit with a user-entered message; `stageAll` runs `git add -A`
    /// first (the panel's single "Stage all & Commit" button).
    public func commitChanges(
        workspaceId: String, message: String, stageAll: Bool
    ) async throws -> GitWorkspaceSnapshot {
        let ack = try await requestFileAction(
            BridgeAction.gitCommit(workspaceId: workspaceId, message: message, stageAll: stageAll),
            timeoutMs: 30_000)
        guard let git = ack.data?.git else { throw RemoteFileActionError.malformedAck }
        cacheGitSnapshot(git, workspaceId: workspaceId)
        return git
    }

    /// Push the current branch; `setUpstream` publishes a branch that has
    /// no upstream yet (the Mac runs `git push -u <remote> <branch>`).
    public func pushBranch(
        workspaceId: String, setUpstream: Bool
    ) async throws -> GitWorkspaceSnapshot {
        let ack = try await requestFileAction(
            BridgeAction.gitPush(workspaceId: workspaceId, setUpstream: setUpstream),
            timeoutMs: 60_000)
        guard let git = ack.data?.git else { throw RemoteFileActionError.malformedAck }
        cacheGitSnapshot(git, workspaceId: workspaceId)
        return git
    }

    /// Whether a chat currently watches a pull request, from the Mac's
    /// projection. The Mac is the authority — the phone never infers this from
    /// its own toggle history, which would drift the moment a watch was added
    /// or dropped on the desktop.
    public func isWatchingPr(chatId: String) -> Bool {
        taskCards.first(where: { $0.id == chatId || $0.threadId == chatId })?.watchingPr == true
    }

    /// Local branches + linked worktrees for the branch picker.
    // MARK: Remote workspace terminal

    /// Open a workspace terminal. The Mac gates on the workspace's remote
    /// write capability AND its standard shellCommands approval — expect this
    /// to suspend until the approval is answered (possibly on this device).
    public func openTerminal(
        workspaceId: String, cols: Int, rows: Int
    ) async throws -> String {
        let ack = try await requestFileAction(
            BridgeAction.terminalOpen(workspaceId: workspaceId, cols: cols, rows: rows),
            timeoutMs: 120_000)
        guard let terminalId = ack.data?.terminalId, !terminalId.isEmpty else {
            throw RemoteFileActionError.denied(ack.message ?? "Terminal did not open.")
        }
        return terminalId
    }

    public func sendTerminalInput(
        workspaceId: String, terminalId: String, data: Data
    ) async throws {
        _ = try await requestFileAction(
            BridgeAction.terminalInput(
                workspaceId: workspaceId, terminalId: terminalId,
                dataBase64: data.base64EncodedString()),
            timeoutMs: 15_000)
    }

    public func readTerminal(
        workspaceId: String, terminalId: String, afterSeq: Int
    ) async throws -> (chunks: [TerminalChunk], latestSeq: Int, exited: Bool) {
        let ack = try await requestFileAction(
            BridgeAction.terminalRead(
                workspaceId: workspaceId, terminalId: terminalId, afterSeq: afterSeq),
            timeoutMs: 15_000)
        return (
            ack.data?.terminalChunks ?? [],
            ack.data?.terminalLatestSeq ?? afterSeq,
            ack.data?.terminalExited ?? false
        )
    }

    public func resizeTerminal(
        workspaceId: String, terminalId: String, cols: Int, rows: Int
    ) async {
        _ = try? await requestFileAction(
            BridgeAction.terminalResize(
                workspaceId: workspaceId, terminalId: terminalId, cols: cols, rows: rows),
            timeoutMs: 10_000)
    }

    public func closeTerminal(workspaceId: String, terminalId: String) async {
        _ = try? await requestFileAction(
            BridgeAction.terminalClose(workspaceId: workspaceId, terminalId: terminalId),
            timeoutMs: 10_000)
    }

    /// Read the Mac's durable approval ledger (bounded rows). The phone user
    /// is exactly the one who wasn't watching when something auto-denied at
    /// 02:14 — this is the audit read for that question.
    public func fetchApprovalLedger(
        workspaceId: String, threadId: String? = nil, limit: Int? = nil
    ) async throws -> [ApprovalLedgerEntry] {
        let ack = try await requestFileAction(
            BridgeAction.approvalLedgerList(
                workspaceId: workspaceId, threadId: threadId, limit: limit),
            timeoutMs: 20_000)
        return ack.data?.approvalLedgerEntries ?? []
    }

    public func fetchGitBranches(
        workspaceId: String
    ) async throws -> (branches: [GitBranchEntry], worktrees: [GitWorktreeEntry]) {
        let ack = try await requestFileAction(
            BridgeAction.gitBranches(workspaceId: workspaceId), timeoutMs: 20_000)
        return (ack.data?.branches ?? [], ack.data?.worktrees ?? [])
    }

    /// Check out a local branch.
    ///
    /// The dirty-worktree refusal is the MAC's to make, against a fresh
    /// snapshot at execution time — the phone deliberately does not pre-check
    /// its cached snapshot, because the tree can go dirty between that snapshot
    /// and the checkout landing, and a stale "looks clean" would be a worse
    /// failure than a clear refusal. A refused checkout surfaces as a thrown
    /// error carrying the Mac's own wording.
    public func checkoutBranch(
        workspaceId: String, branch: String
    ) async throws -> GitWorkspaceSnapshot? {
        let ack = try await requestFileAction(
            BridgeAction.gitCheckout(workspaceId: workspaceId, branch: branch),
            timeoutMs: 60_000)
        if let git = ack.data?.git {
            cacheGitSnapshot(git, workspaceId: workspaceId)
            return git
        }
        // Checkout succeeded but the ack carried no snapshot (older Mac): ask
        // for one rather than leaving every surface on the pre-checkout branch.
        return try? await fetchGitSnapshot(workspaceId: workspaceId)
    }

    /// Create a local branch (not checked out). The Mac refuses the
    /// `taskwraith/` namespace; that refusal arrives as a thrown error whose
    /// message is the Mac's own wording.
    @discardableResult
    public func createBranch(
        workspaceId: String, branch: String, from: String? = nil
    ) async throws -> GitWorkspaceSnapshot? {
        let ack = try await requestFileAction(
            BridgeAction.gitCreateBranch(workspaceId: workspaceId, branch: branch, from: from),
            timeoutMs: 30_000)
        if let git = ack.data?.git {
            cacheGitSnapshot(git, workspaceId: workspaceId)
            return git
        }
        return nil
    }

    /// Create a linked worktree by NAME.
    ///
    /// The phone never picks the destination — see
    /// ``BridgeAction/gitCreateWorktree(workspaceId:name:branch:actionId:)``.
    /// Returns where the Mac put it, so the surface can say; the device has no
    /// other way to know, and an unexplained new checkout is worse than a long
    /// confirmation.
    @discardableResult
    public func createWorktree(
        workspaceId: String, name: String, branch: String? = nil
    ) async throws -> String? {
        let ack = try await requestFileAction(
            BridgeAction.gitCreateWorktree(
                workspaceId: workspaceId, name: name, branch: branch),
            timeoutMs: 60_000)
        return ack.data?.path
    }

    /// Start/stop watching this chat's pull request. Returns the MAC's final
    /// state, which may differ from what was asked (it refuses when the branch
    /// has no open PR).
    @discardableResult
    public func setPrWatch(
        workspaceId: String, chatId: String, watch: Bool
    ) async throws -> Bool {
        let ack = try await requestFileAction(
            BridgeAction.githubWatchPr(workspaceId: workspaceId, chatId: chatId, watch: watch),
            timeoutMs: 30_000)
        return ack.data?.watching ?? watch
    }

    /// PR summary for the current branch — nil when no PR exists yet
    /// (a successful read, not an error).
    public func fetchPrStatus(workspaceId: String) async throws -> GitPullRequestSummary? {
        let ack = try await requestFileAction(
            BridgeAction.githubPrStatus(workspaceId: workspaceId), timeoutMs: 30_000)
        return ack.data?.pr
    }

    public func fetchPrReadiness(workspaceId: String) async throws -> GitPrReadinessResult {
        let ack = try await requestFileAction(
            BridgeAction.githubPrReadiness(workspaceId: workspaceId), timeoutMs: 30_000)
        guard let readiness = ack.data?.readiness else { throw RemoteFileActionError.malformedAck }
        return readiness
    }

    public func createGithubPr(
        workspaceId: String, title: String?, body: String?, draft: Bool
    ) async throws -> GitPullRequestSummary {
        let ack = try await requestFileAction(
            BridgeAction.githubCreatePr(
                workspaceId: workspaceId, title: title, body: body, draft: draft),
            timeoutMs: 60_000)
        guard let pr = ack.data?.pr else { throw RemoteFileActionError.malformedAck }
        return pr
    }

    /// Whether the Mac projects real merge support for this workspace. True only
    /// when `capabilities.githubMergePr == true` (host-derived: both merge
    /// callbacks injected) AND the workspace grants `externalPublish`, the
    /// router's `githubMergePr` requirement. Absent/false is fail-closed: the
    /// phone never offers a control that would call a `notWired` executor or be
    /// refused by the router.
    public func isGithubMergePrHostWired(forWorkspaceId workspaceId: String?) -> Bool {
        guard let workspaceId,
            let capabilities = workspaces.first(where: { $0.id == workspaceId })?.capabilities
        else { return false }
        return GithubMergePrGate.isAvailable(
            hostProjected: capabilities.githubMergePr,
            externalPublish: capabilities.externalPublish)
    }

    /// Merge the current branch's GitHub PR. DESTRUCTIVE and irreversible from
    /// the phone.
    ///
    /// Fail-closed twice before anything is sent: the caller must pass the
    /// elevation acknowledgement collected from its confirmation UI, and the
    /// workspace must project merge support — so a capability that flips to
    /// false between render and tap still cannot reach the wire. The Mac then
    /// runs its own host-verified approval (`requestAgenticServiceApproval`)
    /// before any merge: the phone's receipt is necessary, never sufficient.
    public func mergeGithubPr(
        workspaceId: String, elevationAcknowledged: Bool
    ) async throws -> GitPullRequestSummary {
        guard elevationAcknowledged,
            isGithubMergePrHostWired(forWorkspaceId: workspaceId)
        else {
            throw RemoteFileActionError.denied(
                "Merge isn't available — the Mac hasn't enabled pull request merge for this workspace.")
        }
        let ack = try await requestFileAction(
            BridgeAction.githubMergePr(
                workspaceId: workspaceId, elevationAcknowledged: elevationAcknowledged),
            timeoutMs: 60_000)
        guard let pr = ack.data?.pr else { throw RemoteFileActionError.malformedAck }
        return pr
    }

    /// Queue a peer thread message for another thread on the Mac.
    ///
    /// QUEUE-ONLY by construction: the Mac's gate denies a remote wake outright, so
    /// there is no wake parameter here and none on the wire. The message lands in
    /// the target thread's inbox and reaches its model on that thread's next turn.
    ///
    /// `idempotencyKey` should be minted ONCE per composed message and reused across
    /// retries, so a retap after a timeout is recognised rather than queued twice.
    /// Returns the Mac's own outcome text; a refusal arrives as
    /// `RemoteFileActionError.denied` carrying the store's reason (queue full,
    /// unknown target, policy deny) rather than a generic failure.
    @discardableResult
    public func sendThreadMessage(
        workspaceId: String, fromThreadId: String, toThreadId: String, message: String,
        idempotencyKey: String
    ) async throws -> String {
        let ack = try await requestFileAction(
            BridgeAction.threadMessage(
                workspaceId: workspaceId, threadId: fromThreadId, toThreadId: toThreadId,
                message: message, idempotencyKey: idempotencyKey),
            timeoutMs: 20_000)
        return ack.message ?? "Message queued."
    }

    /// Threads this device may address from `fromThreadId`. Display convenience
    /// only — the Mac re-checks scope, policy and the gate on every send.
    public func threadMessageTargets(fromThreadId: String) -> [ThreadMessageTarget] {
        let sender = taskCards.first { $0.id == fromThreadId || $0.threadId == fromThreadId }
        return ThreadMessageTargets.candidates(
            cards: taskCards, fromThreadId: fromThreadId, fromWorkspaceId: sender?.workspaceId)
    }

    private func requestFileAction(
        _ params: [String: Any], timeoutMs: Int = 12_000
    ) async throws -> BridgeActionAck {
        let ack = try await requestActionAckWithWake(params, timeoutMs: timeoutMs)
        guard ack.ok else {
            throw RemoteFileActionError.denied(ack.error ?? "Action denied.")
        }
        guard let data = ack.result,
            let actionAck = try? TWCoders.decoder.decode(BridgeActionAck.self, from: data)
        else { throw RemoteFileActionError.malformedAck }
        if actionAck.accepted == false {
            throw RemoteFileActionError.denied(actionAck.message ?? "Denied by Mac policy.")
        }
        if actionAck.executed == false {
            throw RemoteFileActionError.denied(
                actionAck.message ?? "Accepted, but the Mac did not run the file action.")
        }
        return actionAck
    }

    // ── Workflow write-actions (pause / resume / run-now) ────────────────────
    // Authority is Mac-derived from the workflow record (the phone sends only
    // the id); the Mac gates on the remote allowlist + unattended posture and
    // re-broadcasts the projection after every mutation. The optimistic flip
    // here only bridges the gap until that re-broadcast lands.

    /// Pause (`enabled: false`) or resume (`enabled: true`) a saved workflow.
    public func setWorkflowEnabled(workflowId: String, enabled: Bool) async {
        let verb = enabled ? "resumed" : "paused"
        if isDemo {
            applyWorkflowEnabledLocally(workflowId: workflowId, enabled: enabled)
            lastActionMessage = "Workflow \(verb) (demo)."
            return
        }
        let previous = workflows.first(where: { $0.id == workflowId })?.enabled
        applyWorkflowEnabledLocally(workflowId: workflowId, enabled: enabled)
        do {
            let ack = try await requestFileAction(
                BridgeAction.workflowSetEnabled(workflowId: workflowId, enabled: enabled),
                timeoutMs: 12_000)
            // Reconcile to the Mac-final state (idempotent same-state acks
            // return it too); the projection re-broadcast follows anyway.
            if let confirmed = ack.data?.enabled {
                applyWorkflowEnabledLocally(workflowId: workflowId, enabled: confirmed)
            }
            lastActionMessage = "Workflow \(verb)."
        } catch {
            if let previous {
                applyWorkflowEnabledLocally(workflowId: workflowId, enabled: previous)
            }
            lastActionMessage = Self.workflowActionFailureMessage(error, phase: phase)
        }
    }

    /// Queue one immediate occurrence of a saved workflow. No optimistic state:
    /// `isRunning` flips when the Mac's projection re-broadcast lands. Mac-side
    /// gates (active execution, cooldown, posture) surface as the ack reason.
    public func runWorkflowNow(workflowId: String) async {
        if isDemo {
            lastActionMessage = "Workflow queued (demo)."
            return
        }
        do {
            _ = try await requestFileAction(
                BridgeAction.workflowRunNow(workflowId: workflowId), timeoutMs: 20_000)
            lastActionMessage = "Workflow queued to run now."
        } catch {
            lastActionMessage = Self.workflowActionFailureMessage(error, phase: phase)
        }
    }

    /// The Mac's denial reasons ("already has an active execution", rate
    /// limited, allowlist) are user-actionable — surface them verbatim;
    /// transport failures fall back to the shared connection messaging.
    nonisolated static func workflowActionFailureMessage(_ error: Error, phase: SessionPhase) -> String {
        if case RemoteFileActionError.denied(let reason) = error, !reason.isEmpty {
            return reason
        }
        return actionFailureMessage(error, phase: phase)
    }

    private func applyWorkflowEnabledLocally(workflowId: String, enabled: Bool) {
        guard let index = workflows.firstIndex(where: { $0.id == workflowId }) else { return }
        let current = workflows[index]
        guard current.enabled != enabled else { return }
        workflows[index] = RemoteWorkflow(
            id: current.id, name: current.name, workspaceId: current.workspaceId,
            threadId: current.threadId, provider: current.provider, enabled: enabled,
            schedule: current.schedule, status: current.status,
            nextRunAt: current.nextRunAt, lastRunAt: current.lastRunAt,
            loopIterationCount: current.loopIterationCount,
            loopStopReason: current.loopStopReason, loopTokens: current.loopTokens)
    }

    /// One staged roster entry from the in-thread editor.
    public struct RosterDraftEntry: Identifiable, Equatable, Sendable {
        public var id: String
        public var provider: String
        public var model: String?
        public var role: String
        public var brief: String
        public var enabled: Bool
        /// Per-participant desktop permission preset.
        public var permissionPresetId: String?
        public var runtimeProfileId: String?
        public var trustedSessionEnabled: Bool
        /// Per-participant reasoning effort. Kimi uses `on` for K2.7 Coding and
        /// Low/High/Max for K3; `thinkingEnabled` remains a compatibility field.
        public var reasoningEffort: String?
        public var fastModeEnabled: Bool
        public var thinkingEnabled: Bool
        /// Staged fan-out stage ("scout" | "worker" | "reviewer" | "background"); nil = no
        /// stage (permission-inferred scheduling) — sent as "" so the Mac
        /// clears an existing stage explicitly.
        public var stageRole: String?
        public var isBossman: Bool
        public var isSecondInCommand: Bool
        public init(
            id: String, provider: String, model: String?, role: String,
            brief: String, enabled: Bool,
            permissionPresetId: String? = nil, reasoningEffort: String? = nil,
            fastModeEnabled: Bool = false, thinkingEnabled: Bool = false,
            stageRole: String? = nil,
            isBossman: Bool = false, isSecondInCommand: Bool = false,
            runtimeProfileId: String? = nil, trustedSessionEnabled: Bool = false
        ) {
            self.id = id
            self.provider = provider
            self.model = model
            self.role = role
            self.brief = brief
            self.enabled = enabled
            self.permissionPresetId = permissionPresetId
            self.runtimeProfileId = runtimeProfileId
            self.trustedSessionEnabled = trustedSessionEnabled
            self.reasoningEffort = reasoningEffort
            self.fastModeEnabled = fastModeEnabled
            self.thinkingEnabled = thinkingEnabled
            self.stageRole = stageRole
            self.isBossman = isBossman
            self.isSecondInCommand = isSecondInCommand
        }
    }

    /// Apply an edited roster to an existing ensemble (order = array order).
    public func updateEnsembleRoster(
        workspaceId: String, threadId: String, entries: [RosterDraftEntry]
    ) {
        let participants: [[String: Any]] = entries.map { entry in
            var dict: [String: Any] = ["provider": entry.provider, "enabled": entry.enabled]
            if !entry.id.hasPrefix("draft-") { dict["id"] = entry.id }
            if let model = entry.model, !model.isEmpty { dict["model"] = model }
            if !entry.role.isEmpty { dict["role"] = entry.role }
            dict["brief"] = entry.brief
            if let preset = entry.permissionPresetId, !preset.isEmpty {
                dict["permissionPresetId"] = preset
            }
            if let reasoning = entry.reasoningEffort, !reasoning.isEmpty {
                dict["reasoningEffort"] = reasoning
            }
            // Booleans sent explicitly so the user can toggle them OFF (the Mac
            // applies them when present; omitting would preserve the old value).
            dict["fastModeEnabled"] = entry.fastModeEnabled
            dict["thinkingEnabled"] = entry.thinkingEnabled
            // Sent explicitly too: "" clears an existing stage on the Mac,
            // omitting would preserve it.
            dict["stageRole"] = entry.stageRole ?? ""
            dict["isBossman"] = entry.isBossman
            dict["isSecondInCommand"] = entry.isSecondInCommand
            return dict
        }
        send(
            BridgeAction.ensembleRosterUpdate(
                workspaceId: workspaceId, threadId: threadId, participants: participants),
            successLabel: "Roster updated.")
        scheduleThreadRefreshAfterUserAction(threadId)
    }

    public func updateEnsembleSettings(
        workspaceId: String, threadId: String,
        orchestrationMode: String? = nil,
        maxContinuationHops: Int? = nil,
        fanoutPolicy: String? = nil,
        ensembleContextChars: Int? = nil,
        bossmanAutoApprovals: Bool? = nil
    ) {
        let mode =
            orchestrationMode == "continuous"
            ? "continuous"
            : orchestrationMode == "turn_bound" ? "turn_bound" : nil
        let hops = maxContinuationHops.map { max(1, min(500, $0)) }
        let fanout =
            fanoutPolicy == "off" || fanoutPolicy == "read_only"
            || fanoutPolicy == "locked_writers_with_boss"
            || fanoutPolicy == "locked_writers_user_preflight"
            ? fanoutPolicy : nil
        let chars = ensembleContextChars.map { max(5_000, min(500_000, $0)) }
        guard
            mode != nil || hops != nil || fanout != nil || chars != nil
                || bossmanAutoApprovals != nil
        else { return }
        send(
            BridgeAction.ensembleSettingsUpdate(
                workspaceId: workspaceId,
                threadId: threadId,
                orchestrationMode: mode,
                maxContinuationHops: hops,
                fanoutPolicy: fanout,
                ensembleContextChars: chars,
                bossmanAutoApprovals: bossmanAutoApprovals),
            successLabel: "Ensemble settings updated.")
        scheduleThreadRefreshAfterUserAction(threadId)
    }

    /// Providers the user can pick when converting ensemble → solo.
    public func ensembleToSoloProviders(for card: RemoteTaskCard) -> [String] {
        let threadId = card.threadId ?? card.id
        if let roster = ensembleStates[threadId]?.roster {
            let fromRoster = roster.compactMap { entry -> String? in
                guard entry.enabled != false else { return nil }
                let provider = (entry.provider ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                return provider.isEmpty ? nil : provider.lowercased()
            }
            if !fromRoster.isEmpty {
                return Array(Set(fromRoster)).sorted {
                    TWTheme.providerLabel($0) < TWTheme.providerLabel($1)
                }
            }
        }
        if let provider = card.provider?.lowercased(), !provider.isEmpty {
            return [provider]
        }
        return ["claude"]
    }

    /// In-place solo ↔ ensemble toggle — mirrors desktop Slice C.
    public func setChatKind(
        _ card: RemoteTaskCard,
        targetKind: String,
        seedParticipant: [String: Any]? = nil,
        canonicalProvider: String? = nil
    ) {
        guard let thread = card.threadId else { return }
        if ChatKindBridge.isLinkedChild(card) {
            lastActionMessage = "Cannot change chat mode on a linked child thread."
            return
        }
        if card.status == "running" || snapshotIsRunning(thread) {
            lastActionMessage = "Finish the current turn first to change chat mode."
            return
        }
        let ws = card.isGlobalScope ? "global" : (card.workspaceId ?? "global")
        let label = targetKind == "ensemble" ? "Ensemble enabled." : "Ensemble disabled."
        send(
            BridgeAction.setChatKind(
                workspaceId: ws, threadId: thread, targetKind: targetKind,
                seedParticipant: seedParticipant, canonicalProvider: canonicalProvider),
            successLabel: label,
            onAck: { [weak self] accepted in
                if accepted { self?.scheduleThreadRefreshAfterUserAction(thread) }
            })
    }

    public func toggleChatKind(
        _ card: RemoteTaskCard, enabled: Bool,
        composerProvider: String?, composerModel: String? = nil
    ) {
        if enabled {
            let provider = (composerProvider ?? card.provider ?? "claude").lowercased()
            let seed = ChatKindBridge.buildSeedParticipant(
                from: card, provider: provider, model: composerModel)
            setChatKind(card, targetKind: "ensemble", seedParticipant: seed)
        } else {
            setChatKind(card, targetKind: "single", canonicalProvider: composerProvider)
        }
    }

    private func snapshotIsRunning(_ threadId: String) -> Bool {
        threadSnapshots[threadId]?.runSummary?.status == "running"
    }

    /// Save a roster (draft entries) as a named preset. GLOBAL — the host
    /// forwards it to the renderer's preset store, which re-syncs to all
    /// devices (the new preset shows up in `ensemblePresets`).
    public func saveEnsembleRosterPreset(name: String, entries: [RosterDraftEntry]) {
        let participants: [[String: Any]] = entries.map { entry in
            var dict: [String: Any] = ["provider": entry.provider, "enabled": entry.enabled]
            if let model = entry.model, !model.isEmpty { dict["model"] = model }
            if !entry.role.isEmpty { dict["role"] = entry.role }
            dict["brief"] = entry.brief
            if let preset = entry.permissionPresetId, !preset.isEmpty {
                dict["permissionPresetId"] = preset
            }
            if let reasoning = entry.reasoningEffort, !reasoning.isEmpty {
                dict["reasoningEffort"] = reasoning
            }
            if let stage = entry.stageRole, !stage.isEmpty {
                dict["stageRole"] = stage
            }
            dict["fastModeEnabled"] = entry.fastModeEnabled
            dict["thinkingEnabled"] = entry.thinkingEnabled
            dict["isBossman"] = entry.isBossman
            dict["isSecondInCommand"] = entry.isSecondInCommand
            return dict
        }
        send(
            BridgeAction.ensemblePresetSave(name: name, participants: participants),
            successLabel: "Preset saved.")
    }

    /// Delete a roster preset by id. GLOBAL — re-syncs to all devices.
    public func deleteEnsembleRosterPreset(presetId: String) {
        send(
            BridgeAction.ensemblePresetDelete(presetId: presetId),
            successLabel: "Preset deleted.")
    }

    /// Create an isolated side chat off a parent thread. Inspector callers keep
    /// the child inline; compact callers can still navigate on ack.
    public func createSideChat(
        _ card: RemoteTaskCard, provider: String?, model: String? = nil,
        reasoningEffort: String? = nil, navigateOnAck: Bool = true,
        onCreated: ((String?) -> Void)? = nil
    ) {
        if isDemo {
            guard let thread = card.threadId else { return }
            let prov = provider ?? card.provider ?? "claude"
            let ws = card.workspaceId ?? "demo-ws"
            let newId = "demo-sc-" + UUID().uuidString.prefix(8).lowercased()
            let label = TWTheme.providerLabel(prov)
            let cardJSON =
                #"{"id":"\#(newId)","title":"Side chat — \#(label) exploration","provider":"\#(prov)","workspaceId":"\#(ws)","threadId":"\#(newId)","parentChatId":"\#(thread)","parentChatRelation":"sideChat","status":"idle","chatKind":"single"}"#
            let snapJSON =
                #"{"threadId":"\#(newId)","workspaceId":"\#(ws)","provider":"\#(prov)","totalRows":1,"rows":[{"id":"\#(newId)-1","role":"assistant","kind":"message","speaker":"\#(label)","preview":"New side chat ready. In a live session this isolated thread runs independently of its parent — ask it anything."}]}"#
            if let newCard = Self.decodeDemo(RemoteTaskCard.self, cardJSON) { taskCards.append(newCard) }
            if let snap = Self.decodeDemo(RemoteThreadSnapshot.self, snapJSON) {
                threadSnapshots[newId] = snap
            }
            rememberThreadWorkspace(newId, workspaceId: ws)
            lastActionMessage = "Side chat created."
            onCreated?(newId)
            return
        }
        guard let ws = card.workspaceId, let thread = card.threadId else { return }
        send(
            BridgeAction.createSideChat(
                workspaceId: ws, threadId: thread, provider: provider, model: model,
                reasoningEffort: reasoningEffort),
            successLabel: "Side chat created.",
            navigateToThreadId: nil,
            navigateOnAck: navigateOnAck,
            onThreadCreated: onCreated)
        scheduleThreadRefreshAfterUserAction(thread)
    }

    /// Steer-now, remove, or blackboard one queued ensemble prompt.
    /// `op: "blackboard"` consumes the queued item into a user-authored
    /// blackboard note on the Mac without interrupting the live round.
    public func ensembleQueueItem(
        _ card: RemoteTaskCard, index: Int, text: String, op: String
    ) {
        guard let ws = card.workspaceId, let thread = card.threadId else { return }
        let successLabel: String
        switch op {
        case "steerNow": successLabel = "Steering…"
        case "blackboard": successLabel = "Added to blackboard."
        default: successLabel = "Removed from queue."
        }
        send(
            BridgeAction.ensembleQueueItem(
                workspaceId: ws, threadId: thread, index: index,
                textPrefix: String(text.prefix(60)), op: op),
            successLabel: successLabel)
        scheduleThreadRefreshAfterUserAction(thread)
    }

    /// Queue a prompt behind the active ensemble round. Solo chat queueing is
    /// handled by `queueComposerPrompt`; this path uses the bridge-backed
    /// ensemble FIFO that is already projected to paired devices.
    public func queueEnsemblePrompt(_ card: RemoteTaskCard, prompt: String) {
        guard card.isEnsemble, let ws = card.workspaceId, let thread = card.threadId else { return }
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        send(
            BridgeAction.ensembleQueuePrompt(
                workspaceId: ws, threadId: thread, text: trimmed,
                roundId: ensembleStates[card.id]?.roundId),
            successLabel: "Queued.")
        scheduleThreadRefreshAfterUserAction(thread)
    }

    /// Queue a solo-chat prompt behind the active run. The Mac owns the
    /// durable FIFO as RunQueueJob records so every paired client sees the
    /// same pending stack. Image attachments ride the same wire dicts the
    /// live send uses; the Mac materializes them at enqueue time.
    public func queueComposerPrompt(
        _ card: RemoteTaskCard, prompt: String, approvalMode: String? = nil,
        workflowMode: String? = nil, permissionPresetId: String? = nil,
        model: String? = nil, providerOverride: String? = nil,
        reasoningEffort: String? = nil, imageAttachments: [[String: Any]]? = nil,
        extraWorkspaceIds: [String]? = nil,
        fastModeEnabled: Bool? = nil, kimiThinkingEnabled: Bool? = nil,
        scheduledRunAt: String? = nil
    ) {
        guard !card.isEnsemble, let thread = card.threadId else { return }
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasAttachments = !(imageAttachments ?? []).isEmpty
        guard !trimmed.isEmpty || hasAttachments else { return }
        let ws = (card.workspaceId ?? "").isEmpty ? "global" : card.workspaceId!
        guard let provider = providerOverride ?? card.provider else { return }
        let action =
            scheduledRunAt == nil
            ? BridgeAction.composerQueuePrompt(
                workspaceId: ws, threadId: thread, provider: provider, text: trimmed,
                approvalMode: approvalMode, workflowMode: workflowMode,
                permissionPresetId: permissionPresetId, model: model,
                extraWorkspaceIds: extraWorkspaceIds,
                reasoningEffort: reasoningEffort, imageAttachments: imageAttachments,
                fastModeEnabled: fastModeEnabled, kimiThinkingEnabled: kimiThinkingEnabled)
            : BridgeAction.composerSchedulePrompt(
                workspaceId: ws, threadId: thread, provider: provider, text: trimmed,
                scheduledRunAt: scheduledRunAt!,
                approvalMode: approvalMode, workflowMode: workflowMode,
                permissionPresetId: permissionPresetId, model: model,
                extraWorkspaceIds: extraWorkspaceIds,
                reasoningEffort: reasoningEffort, imageAttachments: imageAttachments,
                fastModeEnabled: fastModeEnabled, kimiThinkingEnabled: kimiThinkingEnabled)
        send(
            action,
            successLabel: scheduledRunAt == nil ? "Queued." : "Scheduled.")
        scheduleThreadRefreshAfterUserAction(thread)
    }

    /// Steer-now or remove one queued solo composer prompt.
    public func composerQueueItem(
        _ card: RemoteTaskCard, item: RemoteTaskCard.QueuedComposerPrompt, op: String
    ) {
        guard let thread = card.threadId else { return }
        let ws = (card.workspaceId ?? "").isEmpty ? "global" : card.workspaceId!
        send(
            BridgeAction.composerQueueItem(
                workspaceId: ws, threadId: thread, queueId: item.id,
                textPrefix: String(item.text.prefix(60)), op: op),
            successLabel: op == "steerNow" ? "Steering…" : "Removed from queue.")
        scheduleThreadRefreshAfterUserAction(thread)
    }

    /// Save thread notes (markdown; empty clears).
    public func setThreadNotes(_ card: RemoteTaskCard, notes: String) {
        if isDemo {
            guard let thread = card.threadId else { return }
            let trimmed = notes.trimmingCharacters(in: .whitespacesAndNewlines)
            editDemoSnapshot(thread) { $0.notes = trimmed.isEmpty ? nil : notes }
            lastActionMessage = "Notes saved."
            return
        }
        guard let ws = card.workspaceId, let thread = card.threadId else { return }
        send(
            BridgeAction.setThreadNotes(workspaceId: ws, threadId: thread, notes: notes),
            successLabel: "Notes saved.")
        scheduleThreadRefreshAfterUserAction(thread)
    }

    /// Rename a chat on the Mac; the phone updates optimistically and rolls back
    /// if policy or ownership checks reject the action.
    public func renameThread(_ card: RemoteTaskCard, title: String) {
        let trimmed = Self.normalizedThreadTitle(title)
        guard !trimmed.isEmpty else {
            lastActionMessage = "Name can't be empty."
            return
        }
        guard let thread = card.threadId else { return }
        if Self.normalizedThreadTitle(card.title ?? "") == trimmed {
            return
        }
        if isDemo {
            applyLocalThreadTitle(card, title: trimmed)
            lastActionMessage = "Renamed."
            return
        }
        let ws = (card.workspaceId ?? "").isEmpty ? "global" : card.workspaceId!
        let previousTitle = card.title ?? ""
        pendingThreadTitleRenames[thread] = PendingThreadTitleRename(title: trimmed, startedAt: Date())
        applyLocalThreadTitle(card, title: trimmed)
        send(
            BridgeAction.setThreadTitle(workspaceId: ws, threadId: thread, title: trimmed),
            successLabel: "Renamed.",
            onAck: { [weak self] accepted in
                guard let self else { return }
                if accepted {
                    self.scheduleThreadRefreshAfterUserAction(thread)
                } else {
                    self.pendingThreadTitleRenames.removeValue(forKey: thread)
                    self.applyLocalThreadTitle(card, title: previousTitle)
                }
            })
    }

    /// Set, edit, pause, resume, complete, block, or clear the thread goal.
    public func updateGoal(
        _ card: RemoteTaskCard, op: String, objective: String? = nil, reason: String? = nil
    ) {
        guard let thread = card.threadId else { return }
        let ws = (card.workspaceId ?? "").isEmpty ? "global" : card.workspaceId!
        send(
            BridgeAction.goalUpdate(
                workspaceId: ws, threadId: thread, op: op,
                objective: objective, reason: reason),
            successLabel: "Goal updated.")
        scheduleThreadRefreshAfterUserAction(thread)
    }

    /// Post a user-authored Ensemble blackboard note (composer Blackboard parity).
    /// Cast (or move) the human vote on a durable blackboard poll. One
    /// standing vote per poll — the Mac's validator enforces it, the panel
    /// pre-selects from the projected userChoice.
    public func voteBlackboardPoll(_ card: RemoteTaskCard, pollId: String, choice: String) {
        guard card.isEnsemble, let thread = card.threadId else { return }
        let ws = (card.workspaceId ?? "").isEmpty ? "global" : card.workspaceId!
        send(
            BridgeAction.blackboardPollVote(
                workspaceId: ws, threadId: thread, pollId: pollId, choice: choice),
            successLabel: "Vote recorded.")
        scheduleThreadRefreshAfterUserAction(thread)
    }

    public func postBlackboardEntry(
        _ card: RemoteTaskCard, value: String,
        category: String = "note", scope: String = "session", key: String? = nil,
        imageAttachments: [[String: Any]] = []
    ) {
        guard card.isEnsemble, let thread = card.threadId else { return }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let ws = (card.workspaceId ?? "").isEmpty ? "global" : card.workspaceId!
        if isDemo {
            editDemoSnapshot(thread) { draft in
                var entries = draft.blackboardEntries ?? []
                let createdAt = TWCoders.iso8601Now()
                let entry = RemoteThreadSnapshot.BlackboardEntry(
                    id: "bb-demo-\(UUID().uuidString)",
                    key: key ?? "user-note-\(Int(Date().timeIntervalSince1970))",
                    value: trimmed,
                    category: category,
                    scope: scope,
                    participantId: "user",
                    roundId: nil,
                    createdAt: createdAt)
                entries.insert(entry, at: 0)
                draft.blackboardEntries = entries
            }
            lastActionMessage = "Posted to blackboard."
            return
        }
        send(
            BridgeAction.blackboardPost(
                workspaceId: ws, threadId: thread, value: trimmed,
                category: category, scope: scope, key: key,
                imageAttachments: imageAttachments.isEmpty ? nil : imageAttachments),
            successLabel: "Posted to blackboard.")
        scheduleThreadRefreshAfterUserAction(thread)
    }

    /// Pin or unpin a transcript message.
    public func toggleMessagePin(_ card: RemoteTaskCard, messageId: String, pinned: Bool) {
        if isDemo {
            guard let thread = card.threadId else { return }
            editDemoSnapshot(thread) { draft in
                var pins = draft.pinnedRows ?? []
                if pinned {
                    if !pins.contains(where: { $0.id == messageId }),
                        let row = (draft.rows ?? []).first(where: { $0.id == messageId })
                    {
                        pins.append(row)
                    }
                } else {
                    pins.removeAll { $0.id == messageId }
                }
                draft.pinnedRows = pins.isEmpty ? nil : pins
            }
            lastActionMessage = pinned ? "Pinned." : "Unpinned."
            return
        }
        guard let ws = card.workspaceId, let thread = card.threadId else { return }
        send(
            BridgeAction.toggleMessagePin(
                workspaceId: ws, threadId: thread, messageId: messageId, pinned: pinned),
            successLabel: pinned ? "Pinned." : "Unpinned.")
        scheduleThreadRefreshAfterUserAction(thread)
    }

    /// Toggle thumbs feedback on an assistant transcript row. The Mac applies
    /// canonical toggle semantics, saves the chat, and writes the existing
    /// attributed feedback receipt through AppStore.saveChat.
    public func toggleMessageFeedback(
        _ card: RemoteTaskCard,
        request: AssistantMessageFeedbackRequest
    ) {
        guard !isDemo else {
            lastActionMessage = "Message feedback needs a connected Mac."
            return
        }
        guard let ws = card.workspaceId, let thread = card.threadId else { return }
        send(
            BridgeAction.toggleMessageFeedback(
                workspaceId: ws,
                threadId: thread,
                messageId: request.messageId,
                vote: request.vote.rawValue,
                reason: request.details?.reason,
                note: request.details?.note
            ),
            successLabel: "Feedback saved."
        )
        scheduleThreadRefreshAfterUserAction(thread)
    }

    /// Permanently delete one transcript message after explicit phone-side
    /// confirmation. The Mac re-validates prompt anchors and capability scope.
    public func deleteTranscriptMessage(_ card: RemoteTaskCard, messageId: String) {
        guard !isDemo else {
            lastActionMessage = "Message deletion needs a connected Mac."
            return
        }
        guard let ws = card.workspaceId, let thread = card.threadId else { return }
        send(
            BridgeAction.deleteTranscriptMessage(
                workspaceId: ws,
                threadId: thread,
                messageId: messageId
            ),
            successLabel: "Message deleted."
        )
        scheduleThreadRefreshAfterUserAction(thread)
    }

    /// Promote a queued Human People contribution through the Mac canonical trust boundary.
    /// The host re-reads the message and returns framed text; the phone only appends
    /// that returned draft to the composer and never sends it.
    public func promoteCollaboratorComment(threadId: String, messageId: String) {
        guard !isDemo else {
            lastActionMessage = "Insert as draft needs a connected Mac."
            return
        }
        guard
            let card = taskCards.first(where: { item in
                item.id == threadId || item.threadId == threadId
            })
        else { return }
        let workspaceId = (card.workspaceId ?? "").isEmpty ? "global" : card.workspaceId!
        send(
            BridgeAction.promoteCollaboratorComment(
                workspaceId: workspaceId, threadId: threadId, messageId: messageId),
            successLabel: "Inserted as draft.",
            navigateOnAck: false,
            onAckResult: { [weak self] accepted, ack in
                guard accepted,
                    let raw = ack?.result,
                    let object = try? JSONSerialization.jsonObject(with: raw) as? [String: Any]
                else { return }
                let data = (object["data"] as? [String: Any]) ?? object
                guard let draft = data["draft"] as? String, !draft.isEmpty else { return }
                self?.requestComposerAppend(draft, threadId: threadId)
                self?.scheduleThreadRefreshAfterUserAction(threadId)
            })
    }

    /// Rebuild a card with one boolean lifecycle flag flipped (pinned/archived)
    /// through the same Codable round-trip retitledCard uses, so unknown wire
    /// fields survive the local mutation.
    private static func cardSettingFlag(
        _ card: RemoteTaskCard, key: String, value: Bool
    ) -> RemoteTaskCard {
        guard
            let data = try? TWCoders.encoder.encode(card),
            var object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return card }
        object[key] = value
        guard
            let nextData = try? JSONSerialization.data(withJSONObject: object),
            let decoded = try? TWCoders.decoder.decode(RemoteTaskCard.self, from: nextData)
        else { return card }
        return decoded
    }

    private func applyLocalCardFlag(_ card: RemoteTaskCard, key: String, value: Bool) {
        taskCards = taskCards.map { current in
            current.id == card.id ? Self.cardSettingFlag(current, key: key, value: value) : current
        }
    }

    /// Pin or unpin a whole chat (home-list lifecycle). Optimistic with
    /// rollback on a rejected ack — mirrors renameThread's shape.
    public func togglePinChat(_ card: RemoteTaskCard, pinned: Bool) {
        if isDemo {
            applyLocalCardFlag(card, key: "pinned", value: pinned)
            lastActionMessage = pinned ? "Chat pinned." : "Chat unpinned."
            return
        }
        let ws = (card.workspaceId ?? "").isEmpty ? "global" : card.workspaceId!
        let previous = card.pinned ?? false
        applyLocalCardFlag(card, key: "pinned", value: pinned)
        send(
            BridgeAction.togglePinChat(workspaceId: ws, appChatId: card.id, pinned: pinned),
            successLabel: pinned ? "Chat pinned." : "Chat unpinned.",
            navigateOnAck: false,
            onAck: { [weak self] accepted in
                if !accepted { self?.applyLocalCardFlag(card, key: "pinned", value: previous) }
            })
    }

    /// Archive or unarchive a chat — reversible, so no confirmation UI.
    /// Optimistic with rollback; archived cards leave the normal home
    /// sections immediately (listedCards filters on the flag).
    public func setChatArchived(_ card: RemoteTaskCard, archived: Bool) {
        if isDemo {
            applyLocalCardFlag(card, key: "archived", value: archived)
            lastActionMessage = archived ? "Archived." : "Unarchived."
            return
        }
        let ws = (card.workspaceId ?? "").isEmpty ? "global" : card.workspaceId!
        let previous = card.archived ?? false
        applyLocalCardFlag(card, key: "archived", value: archived)
        send(
            BridgeAction.setChatArchived(workspaceId: ws, appChatId: card.id, archived: archived),
            successLabel: archived ? "Archived." : "Unarchived.",
            navigateOnAck: false,
            onAck: { [weak self] accepted in
                if !accepted { self?.applyLocalCardFlag(card, key: "archived", value: previous) }
            })
    }

    /// Decoded success payload of `chatMarkdownTranscript`.
    public struct ChatMarkdownTranscript {
        public let markdown: String
        public let messageCount: Int?
        public let charCount: Int?
        public let omissions: [String]
    }

    /// Decoded success payload of desktop Copy Messages.
    public struct ChatMessageTranscript {
        public let text: String
        public let messageCount: Int?
        public let charCount: Int?
    }

    public func fetchChatMessageTranscript(
        _ card: RemoteTaskCard, completion: @escaping (ChatMessageTranscript?) -> Void
    ) {
        guard !isDemo else {
            lastActionMessage = "Message export needs a connected Mac."
            completion(nil)
            return
        }
        let ws = (card.workspaceId ?? "").isEmpty ? "global" : card.workspaceId!
        send(
            BridgeAction.chatMessageTranscript(workspaceId: ws, appChatId: card.id),
            successLabel: "Messages copied.",
            navigateOnAck: false,
            onAckResult: { accepted, ack in
                guard accepted,
                    let raw = ack?.result,
                    let object = try? JSONSerialization.jsonObject(with: raw) as? [String: Any]
                else {
                    completion(nil)
                    return
                }
                let data = (object["data"] as? [String: Any]) ?? object
                guard let text = data["text"] as? String, !text.isEmpty else {
                    completion(nil)
                    return
                }
                completion(
                    ChatMessageTranscript(
                        text: text,
                        messageCount: data["messageCount"] as? Int,
                        charCount: data["charCount"] as? Int))
            })
    }

    /// Fetch the FULL chat transcript as desktop-identical markdown from the
    /// Mac (the phone's 24-row snapshot window would silently truncate a
    /// local build — ios-t2-transcript-wire-ruling). Failure copy is surfaced
    /// via lastActionMessage using the ack's own message (desktop reasons
    /// verbatim); completion receives nil on any failure.
    public func fetchChatMarkdownTranscript(
        _ card: RemoteTaskCard, completion: @escaping (ChatMarkdownTranscript?) -> Void
    ) {
        guard !isDemo else {
            lastActionMessage = "Transcript export needs a connected Mac."
            completion(nil)
            return
        }
        let ws = (card.workspaceId ?? "").isEmpty ? "global" : card.workspaceId!
        send(
            BridgeAction.chatMarkdownTranscript(workspaceId: ws, appChatId: card.id),
            successLabel: "Transcript copied.",
            navigateOnAck: false,
            onAckResult: { accepted, ack in
                guard accepted,
                    let raw = ack?.result,
                    let object = try? JSONSerialization.jsonObject(with: raw) as? [String: Any]
                else {
                    completion(nil)
                    return
                }
                // The ack envelope nests the action payload under `data` on
                // some hosts and flat on others — accept both.
                let data = (object["data"] as? [String: Any]) ?? object
                guard let markdown = data["markdown"] as? String, !markdown.isEmpty else {
                    completion(nil)
                    return
                }
                completion(
                    ChatMarkdownTranscript(
                        markdown: markdown,
                        messageCount: data["messageCount"] as? Int,
                        charCount: data["charCount"] as? Int,
                        omissions: data["omissions"] as? [String] ?? []))
            })
    }

    /// A Notes-panel pin jump routed to the active transcript's ScrollViewReader.
    /// The source row is the canonical Mac-projected pinned row, so an off-window
    /// target can be rendered without synthesizing message identity or content.
    public struct PinnedTranscriptJumpRequest: Equatable {
        public let id: UUID
        public let threadId: String
        public let rowId: String
        public let sourceRow: RemoteThreadSnapshot.Row
    }

    @Published public var pinnedTranscriptJumpRequest: PinnedTranscriptJumpRequest?

    public func requestPinnedTranscriptJump(threadId: String, sourceRow: RemoteThreadSnapshot.Row) {
        pinnedTranscriptJumpRequest = PinnedTranscriptJumpRequest(
            id: UUID(), threadId: threadId, rowId: sourceRow.id, sourceRow: sourceRow)
    }

    /// Copy a pin's actual row body. Clipped pin previews are expanded through
    /// the existing read-only row endpoint before the pasteboard is updated.
    public func copyPinnedTranscriptRow(threadId: String, sourceRow: RemoteThreadSnapshot.Row) {
        let fallback = sourceRow.preview ?? ""
        guard sourceRow.truncated == true, let workspaceId = remoteScopeForThread(threadId) else {
            writePinnedTranscriptText(fallback)
            return
        }
        let params = BridgeAction.threadRowExpand(
            workspaceId: workspaceId, threadId: threadId, rowId: sourceRow.id)
        Task {
            do {
                let actionAck = try await self.requestFileAction(params)
                writePinnedTranscriptText(actionAck.data?.row?.preview ?? fallback)
            } catch {
                writePinnedTranscriptText(fallback)
                lastActionMessage = Self.actionFailureMessage(error, phase: phase)
            }
        }
    }

    private func writePinnedTranscriptText(_ text: String) {
        guard !text.isEmpty else { return }
        #if canImport(UIKit)
            UIPasteboard.general.string = text
        #endif
        lastActionMessage = "Copied pinned message."
    }

    /// One transcript-message → composer append request (T1 "Add to prompt").
    /// Routed through the model because the transcript row views are Equatable-
    /// gated value types; ThreadDetailView observes this and appends to the
    /// LIVE `followUp` @State (the only channel the visible composer reads —
    /// see ios-t1-draft-append-seam), whose onChange persists it for free.
    public struct ComposerAppendRequest: Equatable {
        public let id: UUID
        public let threadId: String
        public let text: String
    }

    @Published public var composerAppendRequest: ComposerAppendRequest?

    public func requestComposerAppend(_ text: String, threadId: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        composerAppendRequest = ComposerAppendRequest(
            id: UUID(), threadId: threadId, text: trimmed)
        lastActionMessage = "Added to prompt."
    }

    /// Manual refresh: tear down whatever half-state exists and redial the
    /// trusted reconnect. Covers "phone launched before the Mac app" —
    /// resolve initially failed, and waiting on backoff feels broken.
    public func refreshConnection() {
        disconnect()
        reconnectTrusted()
    }

    /// Clear the transient ack banner — called when switching threads so a
    /// denial from thread A doesn't render above thread B's composer.
    public func clearActionMessage() {
        lastActionMessage = nil
    }

    /// Ask the Mac for a fresh bounded transcript window for one thread.
    /// For initial hydration, `limit` counts rendered transcript viewports,
    /// not every tool/thinking row inside one viewport.
    /// Fire-and-forget — the snapshot arrives on the broadcast channel.
    /// Workspace hints for threads we initiated before their taskCard
    /// arrives — without this, opening a just-created thread raced the
    /// projection broadcast and the snapshot request silently no-opped.
    private var threadWorkspaceHints: [String: String] = [:]

    public func rememberThreadWorkspace(_ threadId: String, workspaceId: String) {
        guard remoteContentIsAllowed(workspaceId: workspaceId) else { return }
        revokedThreadWorkspaceHints[threadId] = nil
        threadWorkspaceHints[threadId] = workspaceId
    }

    public func requestThreadSnapshot(
        _ threadId: String, limit: Int = 40, beforeRowId: String? = nil,
        bypassVisibleStreamSuppression: Bool = false
    ) {
        guard !isDemo else { return }  // demo snapshots are pre-seeded; never hit the wire
        if beforeRowId == nil,
            !bypassVisibleStreamSuppression,
            Self.shouldSuppressOnDemandSnapshotPull(
                isStreamingThread: streamingRunIds[threadId] != nil,
                isVisibleThread: visibleThreadId == threadId)
        {
            return
        }
        guard let workspaceId = remoteScopeForThread(threadId) else {
            if beforeRowId == nil {
                pendingThreadSnapshotScopeWait.insert(threadId)
            }
            return
        }
        pendingThreadSnapshotScopeWait.remove(threadId)
        if beforeRowId == nil {
            guard !loadingThreadSnapshots.contains(threadId) else { return }
            loadingThreadSnapshots.insert(threadId)
            #if DEBUG
                threadSnapshotPullAttemptsForTesting += 1
            #endif
        }
        let params = BridgeAction.threadSnapshotRequest(
            workspaceId: workspaceId, threadId: threadId, limit: limit, beforeRowId: beforeRowId)
        Task {
            defer {
                if beforeRowId == nil {
                    loadingThreadSnapshots.remove(threadId)
                }
            }
            do {
                let actionAck = try await self.requestFileAction(params)
                if let thread = actionAck.data?.thread {
                    self.mergeThreadSnapshot(thread, key: threadId)
                }
            } catch {
                // Mirror the send() guard (line ~4241): a background snapshot ack can time out
                // even while the socket is healthy (slow Mac, heavy op right after connect).
                // Emit calm copy when connected so the alarming "may be busy or asleep" banner
                // (driven by twFriendlyMessage/"timeout" keyword match) is not shown falsely.
                // When phase is NOT .connected the else branch fires the alarming banner normally.
                self.lastActionMessage = Self.actionFailureMessage(error, phase: self.phase)
            }
        }
    }

    public func requestPreviousThreadRows(_ threadId: String, limit: Int = 40) {
        guard !loadingPreviousThreadRows.contains(threadId),
            let firstRowId = threadSnapshots[threadId]?.rows?.first?.id
        else { return }
        guard let workspaceId = remoteScopeForThread(threadId)
        else { return }
        loadingPreviousThreadRows.insert(threadId)
        let params = BridgeAction.threadSnapshotRequest(
            workspaceId: workspaceId, threadId: threadId, limit: limit, beforeRowId: firstRowId)
        Task {
            do {
                let actionAck = try await self.requestFileAction(params)
                if let thread = actionAck.data?.thread {
                    self.mergeThreadSnapshot(thread, key: threadId)
                }
            } catch {
                // Same phase guard as requestThreadSnapshot and send(): a "load older messages"
                // ack can time out on a slow-but-connected Mac without the Mac being asleep.
                // Calm copy while connected; alarming banner preserved for genuinely disconnected.
                self.lastActionMessage = Self.actionFailureMessage(error, phase: self.phase)
            }
            self.loadingPreviousThreadRows.remove(threadId)
        }
    }

    private func applyThreadList(_ message: ThreadListMessage) {
        let visibleThreads = message.threads.filter {
            remoteThreadContentIsAllowed(
                workspaceId: $0.workspaceId, keys: projectionKeys($0.chatId))
        }
        let visibleExistingCards = taskCards.filter {
            remoteThreadContentIsAllowed(workspaceId: $0.workspaceId, keys: keys(for: $0))
        }
        if visibleThreads.isEmpty, !visibleExistingCards.isEmpty {
            print("[tw] ignoring empty thread list (have \(taskCards.count) cards)")
            return
        }
        let merged = ThreadListFallback.mergeTaskCards(
            existing: visibleExistingCards,
            fallbackCardIds: fallbackThreadListCardIds,
            threads: visibleThreads)
        taskCards = merged.cards
        fallbackThreadListCardIds = merged.fallbackCardIds
        for card in merged.cards {
            rememberWorkspace(for: card)
        }
        if !merged.cards.isEmpty {
            markProjectionContentHydrated()
        }
    }

    /// Apply the Mac's complete workspace registry projection. Registered but
    /// ungranted workspaces remain visible as consent stubs; a transition to an
    /// explicit denied stub is also the authoritative cache-revocation signal.
    /// This keeps the reconnect settling guard below without leaving readable
    /// task content behind after Settings removes a grant.
    private func applyWorkspaceList(_ message: WorkspaceListMessage) {
        // Non-destructive: a completely empty list while we HOLD workspaces is
        // far more likely a settling-Mac snapshot than a real removal. A real
        // grant revocation projects the registered workspace with
        // remoteAccessGranted=false, so it never relies on this ambiguous case.
        if message.workspaces.isEmpty, !workspaces.isEmpty {
            print("[tw] ignoring empty workspace list (have \(workspaces.count))")
            return
        }

        let previousById = Dictionary(uniqueKeysWithValues: workspaces.map { ($0.id, $0) })
        let incomingIds = Set(message.workspaces.map(\.id))
        var revokedWorkspaceIds = Set(previousById.keys.filter { !incomingIds.contains($0) })
        for workspace in message.workspaces where workspace.remoteAccessGranted == false {
            revokedWorkspaceIds.insert(workspace.id)
        }
        let grantedWorkspaceIds = Set(
            message.workspaces
                .filter { $0.remoteAccessGranted != false }
                .map(\.id))

        deniedRemoteWorkspaceIds.formUnion(revokedWorkspaceIds)
        deniedRemoteWorkspaceIds.subtract(grantedWorkspaceIds)
        if !grantedWorkspaceIds.isEmpty {
            revokedThreadWorkspaceHints = revokedThreadWorkspaceHints.filter {
                !grantedWorkspaceIds.contains($0.value)
            }
        }

        if !revokedWorkspaceIds.isEmpty {
            purgeRemoteContent(forWorkspaceIds: revokedWorkspaceIds)
        }
        workspaces = message.workspaces
        if !message.workspaces.isEmpty { markProjectionContentHydrated() }
    }

    private func markRemoteWorkspaceGrantedFromAck(_ workspaceId: String) {
        deniedRemoteWorkspaceIds.remove(workspaceId)
        revokedThreadWorkspaceHints = revokedThreadWorkspaceHints.filter { $0.value != workspaceId }
        workspaces = workspaces.map { current in
            guard current.id == workspaceId else { return current }
            var granted = current
            granted.remoteAccessGranted = true
            granted.remoteAccessMode = "read-write"
            return granted
        }
    }

    /// Remove only content belonging to a workspace whose remote grant was
    /// revoked. Provider catalogs and other still-granted workspaces remain
    /// intact; subsequent authoritative thread/projection broadcasts refill
    /// anything still visible.
    private func purgeRemoteContent(forWorkspaceIds workspaceIds: Set<String>) {
        guard !workspaceIds.isEmpty else { return }

        var revokedThreadKeys = Set(
            taskCards
                .filter { card in
                    guard let workspaceId = card.workspaceId else { return false }
                    return workspaceIds.contains(workspaceId)
                }
                .flatMap { keys(for: $0) })
        for (key, workspaceId) in threadWorkspaceHints where workspaceIds.contains(workspaceId) {
            revokedThreadKeys.insert(key)
        }
        for (key, snapshot) in threadSnapshots
        where snapshot.workspaceId.map(workspaceIds.contains) == true
        {
            revokedThreadKeys.formUnion(keys(for: snapshot, fallbackKey: key))
        }
        for key in revokedThreadKeys {
            if let workspaceId = taskCards.first(where: { keys(for: $0).contains(key) })?.workspaceId,
                workspaceIds.contains(workspaceId)
            {
                revokedThreadWorkspaceHints[key] = workspaceId
            } else if let workspaceId = threadWorkspaceHints[key], workspaceIds.contains(workspaceId)
            {
                revokedThreadWorkspaceHints[key] = workspaceId
            } else if let workspaceId = threadSnapshots[key]?.workspaceId,
                workspaceIds.contains(workspaceId)
            {
                revokedThreadWorkspaceHints[key] = workspaceId
            }
        }

        taskCards.removeAll { card in
            card.workspaceId.map(workspaceIds.contains) == true
                || !Set(keys(for: card)).isDisjoint(with: revokedThreadKeys)
        }
        fallbackThreadListCardIds.subtract(revokedThreadKeys)
        approvals.removeAll { card in
            card.workspaceId.map(workspaceIds.contains) == true
                || card.threadId.map(revokedThreadKeys.contains) == true
        }
        questions.removeAll { card in
            card.workspaceId.map(workspaceIds.contains) == true
                || card.threadId.map(revokedThreadKeys.contains) == true
        }
        workflows.removeAll { workflow in
            workflow.workspaceId.map(workspaceIds.contains) == true
                || workflow.threadId.map(revokedThreadKeys.contains) == true
        }
        workspaceBoards.removeAll { board in
            board.workspaceId.map(workspaceIds.contains) == true
        }
        threadSnapshots = threadSnapshots.filter { key, snapshot in
            !revokedThreadKeys.contains(key)
                && snapshot.workspaceId.map(workspaceIds.contains) != true
        }
        ensembleStates = ensembleStates.filter { key, _ in
            !revokedThreadKeys.contains(key)
        }
        diffSummaries = diffSummaries.filter { key, _ in
            !revokedThreadKeys.contains(key)
        }
        gitSnapshots = gitSnapshots.filter { key, _ in
            !workspaceIds.contains(key)
        }

        for threadKey in revokedThreadKeys {
            streamingTexts[threadKey] = nil
            streamingSegments[threadKey] = nil
            streamingRunIds[threadKey] = nil
            streamingProviders[threadKey] = nil
            streamingItemIds[threadKey] = nil
            streamingTerminalThreads.remove(threadKey)
            streamingPublishGate.reset(threadId: threadKey)
            threadWorkspaceHints[threadKey] = nil
            rowExpansions[threadKey] = nil
            hiddenRunSummaryFingerprintsByThread[threadKey] = nil
            wakeRefreshGeneration[threadKey] = nil
            inspectorTabByThread[threadKey] = nil
            pendingThreadSnapshotScopeWait.remove(threadKey)
            loadingThreadSnapshots.remove(threadKey)
            loadingPreviousThreadRows.remove(threadKey)
            pendingThreadRefresh[threadKey]?.cancel()
            pendingThreadRefresh[threadKey] = nil
        }

        if selectedTaskId.map(revokedThreadKeys.contains) == true { selectedTaskId = nil }
        // Keyed on the PARENT only. A side chat inherits its parent's
        // workspace at creation, so a revoked workspace takes both together
        // and filtering on the selected id as well would be unreachable.
        let survivingSideChatSelections = selectedSideChatByThread.filter {
            !revokedThreadKeys.contains($0.key)
        }
        if survivingSideChatSelections != selectedSideChatByThread {
            selectedSideChatByThread = survivingSideChatSelections
        }
        if navigationTarget.map(revokedThreadKeys.contains) == true { navigationTarget = nil }
        if visibleThreadId.map(revokedThreadKeys.contains) == true { visibleThreadId = nil }
        if pendingDeepLinkThreadId.map(revokedThreadKeys.contains) == true {
            pendingDeepLinkThreadId = nil
        }
    }

    #if DEBUG
        func applyWorkspaceListForTesting(_ message: WorkspaceListMessage) {
            applyWorkspaceList(message)
        }
    #endif

    /// Synchronous compatibility seam for direct model tests and locally built
    /// snapshots. Relay snapshots use `applyDecodedSnapshot` after their entire
    /// typed payload batch has already been prepared off the MainActor.
    func applySnapshot(_ snapshot: RemoteProjectionSnapshot) {
        applyDecodedSnapshot(DecodedProjectionSnapshot(snapshot))
    }

    func applyDecodedSnapshot(_ snapshot: DecodedProjectionSnapshot) {
        var tasks: [RemoteTaskCard] = []
        var approvalCards: [MobileApprovalCard] = []
        var questionCards: [MobileQuestionCard] = []
        var snapshots: [(snapshot: RemoteThreadSnapshot, fallbackKey: String)] = []
        var ensembleSnapshots: [String: RemoteEnsembleState] = [:]
        var diffSnapshots: [String: MobileDiffSummary] = [:]
        var incomingGitSnapshots: [String: GitWorkspaceSnapshot] = [:]
        var workflowCards: [RemoteWorkflow] = []
        var boardCards: [RemoteWorkspaceBoard] = []
        var presetCards: [RemoteEnsemblePreset] = []
        var shellAppearances: [TWRemoteShellAppearance] = []
        for projection in snapshot.projections {
            switch projection {
            case .taskCard(let decodedCard, let embedded, let envelopeThreadId):
                let card = cardResolvingPendingThreadTitle(decodedCard)
                guard remoteThreadContentIsAllowed(
                    workspaceId: card.workspaceId, keys: keys(for: card))
                else { continue }
                markRemoteThreadContentAllowed(for: card)
                tasks.append(card)
                if let state = embedded?.ensembleState {
                    for key in keys(
                        for: state, envelopeThreadId: envelopeThreadId, fallbackKey: card.id)
                    {
                        ensembleSnapshots[key] = state
                    }
                }
                if let diff = embedded?.diffSummary {
                    for key in keys(
                        for: diff, envelopeThreadId: envelopeThreadId, fallbackKey: card.id)
                    {
                        diffSnapshots[key] = diff
                    }
                }
            case .workflow(let workflow):
                guard remoteThreadContentIsAllowed(
                    workspaceId: workflow.workspaceId,
                    keys: projectionKeys(workflow.threadId))
                else { continue }
                workflowCards.append(workflow)
            case .workspaceBoard(let board):
                guard remoteContentIsAllowed(workspaceId: board.workspaceId) else { continue }
                boardCards.append(board)
            case .ensemblePreset(let preset):
                presetCards.append(preset)
            case .approval(let card):
                guard remoteThreadContentIsAllowed(
                    workspaceId: card.workspaceId, keys: projectionKeys(card.threadId))
                else { continue }
                approvalCards.append(card)
            case .question(let card):
                guard remoteThreadContentIsAllowed(
                    workspaceId: card.workspaceId, keys: projectionKeys(card.threadId))
                else { continue }
                questionCards.append(card)
            case .threadSnapshot(let thread, let fallbackKey):
                if let fallbackKey,
                    remoteThreadContentIsAllowed(
                        workspaceId: thread.workspaceId,
                        keys: keys(for: thread, fallbackKey: fallbackKey))
                {
                    snapshots.append((thread, fallbackKey))
                }
            case .ensembleState(let state, let envelopeThreadId):
                let stateKeys = keys(for: state, envelopeThreadId: envelopeThreadId)
                guard remoteThreadContentIsAllowed(keys: stateKeys) else { continue }
                for key in stateKeys {
                    ensembleSnapshots[key] = state
                }
            case .diffSummary(let diff, let envelopeThreadId):
                let diffKeys = keys(for: diff, envelopeThreadId: envelopeThreadId)
                guard remoteThreadContentIsAllowed(keys: diffKeys) else { continue }
                for key in diffKeys {
                    diffSnapshots[key] = diff
                }
            case .gitSnapshot(let git, let workspaceId):
                guard remoteContentIsAllowed(workspaceId: workspaceId) else { continue }
                incomingGitSnapshots[workspaceId] = git
            case .shellAppearance(let appearance):
                shellAppearances.append(appearance)
            case .ignored:
                break
            }
        }
        for appearance in shellAppearances {
            applyShellAppearance(appearance)
        }
        // Non-destructive empty guard for workflows — but only treat an empty
        // workflow set as "settling" when the WHOLE snapshot is empty (no task
        // cards either). A snapshot that carries task cards yet no workflows is
        // authoritative: the user deleted their last workflow, so we must clear
        // rather than keep a ghost row that dead-ends on tap. (Workflows + tasks
        // are projected together in one Mac-side pass, so populated-tasks +
        // empty-workflows never means "workflows still hydrating".)
        if workflowCards.isEmpty, !workflows.isEmpty, tasks.isEmpty {
            // Settling snapshot — keep cached workflows.
        } else {
            if workflows != workflowCards {
                workflows = workflowCards
            }
        }
        if boardCards.isEmpty, !workspaceBoards.isEmpty, tasks.isEmpty {
            // Settling snapshot — keep cached boards.
        } else {
            if workspaceBoards != boardCards {
                workspaceBoards = boardCards
            }
        }
        // Roster presets: keep the cached list only DURING first-connect settling
        // (before the projection has hydrated). Unlike workflows we can't key this
        // on `tasks.isEmpty` — "no presets + no active tasks" is a perfectly normal
        // steady state, and using it would resurrect a just-deleted last preset.
        if presetCards.isEmpty, !ensemblePresets.isEmpty, !projectionHydrated {
            // Pre-hydration settling snapshot — keep cached presets.
        } else {
            if ensemblePresets != presetCards {
                ensemblePresets = presetCards
            }
        }
        // Real content ends the first-connect "Syncing…" state immediately;
        // an empty settling snapshot does NOT (the grace timer or the Mac's
        // delayed re-seed resolves it instead).
        if !tasks.isEmpty || !workflowCards.isEmpty || !boardCards.isEmpty || !presetCards.isEmpty {
            markProjectionContentHydrated()
        }
        // Reconcile the optimistic-dismissal sets: keep suppressing only cards
        // the Mac STILL lists as pending (a reply in flight); once it drops a
        // card (resolution confirmed) the id leaves the set, and a card no
        // longer suppressed re-appears (e.g. a reply the Mac rejected).
        let incomingApprovalIds = Set(approvalCards.compactMap { $0.toolCallId })
        repliedApprovalToolCallIds.formIntersection(incomingApprovalIds)
        let nextApprovals = approvalCards.filter { card in
            guard let tid = card.toolCallId else { return true }
            return !repliedApprovalToolCallIds.contains(tid)
        }
        if approvals != nextApprovals {
            approvals = nextApprovals
        }
        let incomingQuestionIds = Set(questionCards.compactMap { $0.resolvedId })
        repliedQuestionIds.formIntersection(incomingQuestionIds)
        let nextQuestions = questionCards.filter { card in
            guard let qid = card.resolvedId else { return true }
            return !repliedQuestionIds.contains(qid)
        }
        if questions != nextQuestions {
            questions = nextQuestions
        }
        // Merge — don't wipe on-demand snapshots for threads outside the
        // recent-N window when a full periodic snapshot lands.
        var nextThreadSnapshots = threadSnapshots
        for incoming in snapshots {
            mergeThreadSnapshot(
                incoming.snapshot, key: incoming.fallbackKey, into: &nextThreadSnapshots)
        }
        if threadSnapshots != nextThreadSnapshots {
            threadSnapshots = nextThreadSnapshots
        }
        var nextEnsembleStates = ensembleStates
        for (key, state) in ensembleSnapshots {
            nextEnsembleStates[key] = state
        }
        if ensembleStates != nextEnsembleStates {
            ensembleStates = nextEnsembleStates
        }
        var nextDiffSummaries = diffSummaries
        for (key, diff) in diffSnapshots {
            nextDiffSummaries[key] = diff
        }
        if diffSummaries != nextDiffSummaries {
            diffSummaries = nextDiffSummaries
        }
        // Non-destructive empty-snapshot guard (Codex-diagnosed): a Mac
        // mid-restart can emit an establish snapshot BEFORE its state has
        // settled. Accepting empty-over-populated as authoritative produced
        // 'connected, no chats' — keep what we have; the delayed rehydrate
        // snapshot (Mac-side) supplies the real state moments later.
        //
        // Publish task cards only after their embedded ensemble/diff metadata:
        // taskCards.didSet may synchronously compose the completion banner.
        if tasks.isEmpty, !taskCards.isEmpty {
            print("[tw] ignoring empty snapshot (have \(taskCards.count) cards)")
        } else {
            if taskCards != tasks {
                taskCards = tasks
            }
            for card in tasks {
                rememberWorkspace(for: card)
            }
            if !tasks.isEmpty {
                fallbackThreadListCardIds.removeAll()
            }
        }
        var nextGitSnapshots = gitSnapshots
        for (workspaceId, git) in incomingGitSnapshots {
            nextGitSnapshots[workspaceId] = git
        }
        if gitSnapshots != nextGitSnapshots {
            gitSnapshots = nextGitSnapshots
        }
    }

    // ── Actions ────────────────────────────────────────────────────────────────

    /// Reply to an approval. `decision` MUST be one of the Mac validator's
    /// union: accept | acceptForSession | acceptForWorkspace | decline |
    /// cancel ("approve"/"deny" were silently rejected as malformed).
    /// Cards can OMIT workspaceId (kimi approvals carry no workspace path)
    /// and threadId is conditional — but the reply validators require both
    /// as strings. The router only uses workspaceId for the allowlist gate
    /// and the executor never reads threadId, so best-effort fallbacks keep
    /// the buttons live instead of silently dead.
    private func replyContext(workspaceId: String?, threadId: String?, runId: String?)
        -> (workspaceId: String, threadId: String, runId: String?)?
    {
        // Workspace-less (global-scope) chats resolve to the reserved "global"
        // scope — NOT the first workspace, which the Mac would reject or
        // mis-attribute (the cancel-scope bug class). Treat an empty string the
        // same as absent, and route through `remoteScopeForThread` so a loaded
        // global card maps to "global" rather than its empty workspaceId.
        let ws =
            workspaceId.flatMap { $0.isEmpty ? nil : $0 }
            ?? threadId.flatMap { remoteScopeForThread($0) }
            ?? "global"
        return (ws, threadId ?? runId ?? "", runId)
    }

    public func approve(_ card: MobileApprovalCard, decision: String) {
        guard let toolCallId = card.toolCallId,
            let context = replyContext(
                workspaceId: card.workspaceId, threadId: card.threadId, runId: card.runId)
        else { return }
        let ws = context.workspaceId
        let thread = context.threadId
        let label: String
        switch decision {
        case "accept": label = "Allowed once."
        case "acceptForSession": label = "Allowed for this session."
        case "acceptForWorkspace": label = "Allowed in this workspace."
        case "cancel": label = "Run cancelled."
        default: label = "Denied."
        }
        // Optimistically dismiss the modal NOW — don't wait for the round-trip
        // + next projection (which only arrives when the turn advances), which
        // left the modal stuck on screen after Accept.
        repliedApprovalToolCallIds.insert(toolCallId)
        approvals.removeAll { $0.toolCallId == toolCallId }
        let hostRoute = PairedHostActionRouting.approval(
            approvalId: toolCallId,
            decision: decision,
            commandsAvailable: hostProjection.canSubmitCommands)
        if case .host(let command) = hostRoute {
            Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    let receipt = try await self.hostProjection.submitCommand(
                        name: command.name,
                        target: command.target,
                        arguments: command.arguments)
                    self.lastActionMessage = PairedHostActionRouting.message(
                        for: receipt, success: label)
                    if PairedHostActionRouting.alreadyResolvedApproval(receipt) {
                        self.repliedApprovalToolCallIds.remove(toolCallId)
                        self.approvals.removeAll { $0.toolCallId == toolCallId }
                    } else if !PairedHostActionRouting.acceptedForProcessing(receipt) {
                        self.repliedApprovalToolCallIds.remove(toolCallId)
                        if !self.approvals.contains(where: { $0.toolCallId == toolCallId }) {
                            self.approvals.insert(card, at: 0)
                        }
                    }
                } catch {
                    self.lastActionMessage = error.localizedDescription
                    self.repliedApprovalToolCallIds.remove(toolCallId)
                    if !self.approvals.contains(where: { $0.toolCallId == toolCallId }) {
                        self.approvals.insert(card, at: 0)
                    }
                }
            }
            scheduleThreadRefreshAfterUserAction(thread)
            return
        }
        send(
            BridgeAction.approvalReply(
                toolCallId: toolCallId, decision: decision, workspaceId: ws, threadId: thread),
            successLabel: label,
            onAckResult: { [weak self] _, ack in
                guard let self else { return }
                switch Self.approvalAckOutcome(ack) {
                case .succeeded:
                    // Optimistic dismissal stands; the resolved-status delta will
                    // also evict it. Nothing to do.
                    return
                case .alreadyResolved:
                    // The approval resolved out from under us (auto-deny timer,
                    // the desktop, or another surface). EVICT — re-presenting it
                    // would loop forever because it will never be pending again.
                    // (This was the root cause of the unbreakable modal loop.)
                    self.repliedApprovalToolCallIds.remove(toolCallId)
                    self.approvals.removeAll { $0.toolCallId == toolCallId }
                case .rejected:
                    // The Mac rejected the reply on policy/ownership grounds. Keep
                    // it dismissed AND suppressed so a deterministic re-deny can't
                    // trap the user in a tap loop; lastActionMessage explains why,
                    // and the desktop / auto-deny timer finalizes the run.
                    self.approvals.removeAll { $0.toolCallId == toolCallId }
                case .dispatchFailed:
                    // The reply reached the Mac, but the host could not dispatch
                    // the approval decision. The approval may still be pending, so
                    // keep it retryable instead of silently dropping the card.
                    self.repliedApprovalToolCallIds.remove(toolCallId)
                    if !self.approvals.contains(where: { $0.toolCallId == toolCallId }) {
                        self.approvals.insert(card, at: 0)
                    }
                case .transportError:
                    // Couldn't reach the Mac — genuinely retryable. Stop
                    // suppressing + restore the card so the user can try again.
                    self.repliedApprovalToolCallIds.remove(toolCallId)
                    if !self.approvals.contains(where: { $0.toolCallId == toolCallId }) {
                        self.approvals.insert(card, at: 0)
                    }
                }
            })
        scheduleThreadRefreshAfterUserAction(thread)
    }

    /// iOS grants ~30s of background execution for a notification action.
    /// Leave a 2s margin for process overhead around the 28s working budget.
    nonisolated public static let notificationApprovalBackgroundBudgetMs = 28_000
    nonisolated public static let notificationApprovalDefaultAckTimeoutMs = 7_000
    nonisolated public static let notificationApprovalMinAckTimeoutMs = 1_000
    /// `RelayTransportClient.checkPeerAlive` default wait. Stacking this after
    /// a 22s wake plus a 7s ack blows the background window.
    nonisolated public static let notificationApprovalPeerPreflightMs = 6_000

    /// Remaining ack timeout inside the notification-action background budget.
    /// `nil` means abort — there is not enough time to send a bounded ack.
    nonisolated public static func remainingNotificationApprovalAckTimeoutMs(
        elapsedMs: Int,
        budgetMs: Int = notificationApprovalBackgroundBudgetMs,
        peerPreflightMs: Int = 0,
        maxAckMs: Int = notificationApprovalDefaultAckTimeoutMs,
        minAckMs: Int = notificationApprovalMinAckTimeoutMs
    ) -> Int? {
        let remaining = budgetMs - elapsedMs - peerPreflightMs
        guard remaining >= minAckMs else { return nil }
        return min(maxAckMs, remaining)
    }

    /// Lock-screen Approve/Deny: resolve an approval from a notification action
    /// in the background with NO MobileApprovalCard present (a cold-launched
    /// process has no hydrated cards). Reconnects the E2EE bridge first and only
    /// sends if connected — the decision comes SOLELY from which button was
    /// tapped, never from the (untrusted) push payload. Returns true only when
    /// the Mac acked; the caller posts a "couldn't reach Mac" local notification
    /// on false. The Mac's auto-deny timer is the safety net, so a missed reply
    /// degrades to a system decline, never a spurious approve.
    public func sendApprovalDecisionFromNotification(
        toolCallId: String, decision: String, workspaceId: String?, threadId: String?,
        timeoutMs: Int = 22_000
    ) async -> Bool {
        guard hasStoredPairing else { return false }
        // The lock screen only offers Approve/Deny — richer grants
        // (acceptForSession/Workspace, cancel) stay in-app where the command
        // text is visible.
        guard decision == "accept" || decision == "decline" else { return false }
        let started = Date()
        // Cap the wake so wake + default ack cannot exceed the background budget
        // even when the Mac is slow; remaining time after the actual elapsed wake
        // is computed below.
        let wakeCap = max(
            0,
            Self.notificationApprovalBackgroundBudgetMs
                - Self.notificationApprovalDefaultAckTimeoutMs)
        let connected = await handleRemoteWake(
            reason: "notification-action", timeoutMs: min(timeoutMs, wakeCap))
        let elapsedMs = max(0, Int((Date().timeIntervalSince(started) * 1000).rounded(.up)))
        guard let ackTimeout = Self.remainingNotificationApprovalAckTimeoutMs(elapsedMs: elapsedMs)
        else { return false }
        guard connected, case .connected = phase, client != nil else { return false }
        guard let context = replyContext(workspaceId: workspaceId, threadId: threadId, runId: nil)
        else { return false }
        let label = decision == "accept" ? "Allowed once." : "Denied."
        let hostRoute = PairedHostActionRouting.approval(
            approvalId: toolCallId,
            decision: decision,
            commandsAvailable: hostProjection.canSubmitCommands)
        if case .host(let command) = hostRoute {
            do {
                let receipt = try await hostProjection.submitCommand(
                    name: command.name,
                    target: command.target,
                    arguments: command.arguments)
                lastActionMessage = PairedHostActionRouting.message(
                    for: receipt, success: label)
                return PairedHostActionRouting.acceptedForProcessing(receipt)
                    || PairedHostActionRouting.alreadyResolvedApproval(receipt)
            } catch {
                lastActionMessage = error.localizedDescription
                return false
            }
        }
        // Bound the ack to remaining budget. Skip the 6s peer preflight — the wake
        // already joined the shared health probe.
        return await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            send(
                BridgeAction.approvalReply(
                    toolCallId: toolCallId, decision: decision,
                    workspaceId: context.workspaceId, threadId: context.threadId),
                timeoutMs: ackTimeout,
                successLabel: label,
                navigateToThreadId: context.threadId,
                skipPeerPreflight: true,
                onAck: { accepted in continuation.resume(returning: accepted) })
        }
    }

    /// Plain notification tap (no action button): bring the bridge up and
    /// deep-link to the thread's approval card. Survives a cold launch — if the
    /// session isn't established yet, the target is restored on `.established`.
    public func handleNotificationTap(threadId: String) {
        Task { [weak self] in
            guard let self else { return }
            await self.performNotificationTap(threadId: threadId)
        }
    }

    func performNotificationTap(threadId: String, timeoutMs: Int = 22_000) async {
        // Register the deep-link BEFORE the wake walk. `.established` consumes
        // pendingDeepLinkThreadId; if we wait until after handleRemoteWake the
        // target is delayed by the whole reconnect budget (up to 22s).
        await MainActor.run {
            self.routeNotificationTarget(threadId)
        }
        _ = await handleRemoteWake(reason: "notification-tap", timeoutMs: timeoutMs)
    }

    /// Slice 5 (RC4): route a tapped notification to its target thread AND force
    /// that thread's transcript to refresh, so the user lands on the exact
    /// approval/summary the push pointed at — not a stale cached transcript. Bumps
    /// the per-thread wake generation FIRST (covers both the warm and cold paths):
    /// the detail view's needsRefresh gate refetches a cached-but-non-empty thread
    /// once the generation advances. On the warm (.connected) path we also issue an
    /// immediate targeted refresh and set navigationTarget; on the cold path the
    /// target is restored on `.established`. Do NOT reroute the warm path through
    /// pendingDeepLinkThreadId — .established won't re-fire, so it would never navigate.
    func routeNotificationTarget(_ threadId: String) {
        markWakeTarget(threadId)
        if case .connected = phase {
            navigationTarget = threadId
            // Non-bypassing: the internal suppression only drops a pull for the
            // VISIBLE streaming thread, which the just-tapped target is not yet.
            requestThreadSnapshot(threadId)
        } else {
            pendingDeepLinkThreadId = threadId
        }
    }

    private func markWakeTarget(_ id: String) {
        wakeRefreshGeneration[id, default: 0] += 1
    }

    #if DEBUG
        func routeNotificationTargetForTesting(_ threadId: String) {
            routeNotificationTarget(threadId)
        }
        func setPhaseForTesting(_ newPhase: SessionPhase) {
            phase = newPhase
        }
        /// Stamp a just-established `.connected` session so storm tests can
        /// fire the notification-tap + scenePhase.active race against it.
        func markJustEstablishedForTesting(at now: Date = Date()) {
            phase = .connected
            reconnectCoordinator.markAttemptFinished(at: now)
        }
        /// Fire the delayed-redial path without a live transport client.
        func simulateUnexpectedSocketCloseForTesting() {
            scheduleReconnectAfterUnexpectedClose()
        }
        private(set) var socketHealthProbeStartsForTesting = 0
        var healthProbeOverrideForTesting: (@Sendable () async -> Bool)?
        var remoteWakeBeganHookForTesting: (() -> Void)?
        var pendingDeepLinkThreadIdForTesting: String? { pendingDeepLinkThreadId }
        func performNotificationTapForTesting(threadId: String, timeoutMs: Int = 0) async {
            await performNotificationTap(threadId: threadId, timeoutMs: timeoutMs)
        }
        func applySessionEstablishedForTesting() {
            applySessionEstablished(from: nil)
        }
    #endif

    public func answer(_ card: MobileQuestionCard, _ text: String, isCustom: Bool = true) {
        guard let promptId = card.resolvedId,
            let context = replyContext(
                workspaceId: card.workspaceId, threadId: card.threadId, runId: card.runId)
        else { return }
        let ws = context.workspaceId
        let thread = context.threadId
        repliedQuestionIds.insert(promptId)
        questions.removeAll { $0.resolvedId == promptId }
        let hostRoute = PairedHostActionRouting.questionAnswer(
            questionId: promptId,
            answer: text,
            isCustom: isCustom,
            commandsAvailable: hostProjection.canSubmitCommands)
        if case .host(let command) = hostRoute {
            Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    let receipt = try await self.hostProjection.submitCommand(
                        name: command.name,
                        target: command.target,
                        arguments: command.arguments)
                    self.lastActionMessage = PairedHostActionRouting.message(
                        for: receipt, success: "Answer sent.")
                    if !PairedHostActionRouting.acceptedForProcessing(receipt) {
                        self.repliedQuestionIds.remove(promptId)
                        if !self.questions.contains(where: { $0.resolvedId == promptId }) {
                            self.questions.insert(card, at: 0)
                        }
                    }
                } catch {
                    self.lastActionMessage = error.localizedDescription
                    self.repliedQuestionIds.remove(promptId)
                    if !self.questions.contains(where: { $0.resolvedId == promptId }) {
                        self.questions.insert(card, at: 0)
                    }
                }
            }
            scheduleThreadRefreshAfterUserAction(thread)
            return
        }
        send(
            BridgeAction.questionReply(
                questionId: promptId, answer: text, workspaceId: ws, threadId: thread,
                runId: context.runId, isCustom: isCustom),
            successLabel: "Answer sent.",
            onAck: { [weak self] accepted in
                guard let self, !accepted else { return }
                self.repliedQuestionIds.remove(promptId)
                if !self.questions.contains(where: { $0.resolvedId == promptId }) {
                    self.questions.insert(card, at: 0)
                }
            })
        scheduleThreadRefreshAfterUserAction(thread)
    }

    /// Dismiss a question — the Mac resolves the parked tool as cancelled.
    public func rejectQuestion(_ card: MobileQuestionCard) {
        guard let promptId = card.resolvedId,
            let context = replyContext(
                workspaceId: card.workspaceId, threadId: card.threadId, runId: card.runId)
        else { return }
        let ws = context.workspaceId
        let thread = context.threadId
        repliedQuestionIds.insert(promptId)
        questions.removeAll { $0.resolvedId == promptId }
        let hostRoute = PairedHostActionRouting.questionDismiss(
            questionId: promptId,
            commandsAvailable: hostProjection.canSubmitCommands)
        if case .host(let command) = hostRoute {
            Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    let receipt = try await self.hostProjection.submitCommand(
                        name: command.name,
                        target: command.target,
                        arguments: command.arguments)
                    self.lastActionMessage = PairedHostActionRouting.message(
                        for: receipt, success: "Question dismissed.")
                    if !PairedHostActionRouting.acceptedForProcessing(receipt) {
                        self.repliedQuestionIds.remove(promptId)
                        if !self.questions.contains(where: { $0.resolvedId == promptId }) {
                            self.questions.insert(card, at: 0)
                        }
                    }
                } catch {
                    self.lastActionMessage = error.localizedDescription
                    self.repliedQuestionIds.remove(promptId)
                    if !self.questions.contains(where: { $0.resolvedId == promptId }) {
                        self.questions.insert(card, at: 0)
                    }
                }
            }
            scheduleThreadRefreshAfterUserAction(thread)
            return
        }
        send(
            BridgeAction.questionReject(
                promptId: promptId, workspaceId: ws, threadId: thread, runId: context.runId),
            successLabel: "Question dismissed.",
            onAck: { [weak self] accepted in
                guard let self, !accepted else { return }
                self.repliedQuestionIds.remove(promptId)
                if !self.questions.contains(where: { $0.resolvedId == promptId }) {
                    self.questions.insert(card, at: 0)
                }
            })
        scheduleThreadRefreshAfterUserAction(thread)
    }

    /// Provider that owns a thread (for a composerPrompt continuation): the task
    /// card is authoritative; fall back to the loaded snapshot. If neither source
    /// has a provider, do not invent one — a proposed-plan approval must not run
    /// against the wrong provider.
    static func proposedPlanProvider(
        threadId: String,
        taskCards: [RemoteTaskCard],
        threadSnapshots: [String: RemoteThreadSnapshot]
    ) -> String? {
        if let card = taskCards.first(where: { $0.id == threadId || $0.threadId == threadId }),
            let p = card.provider?.trimmingCharacters(in: .whitespacesAndNewlines),
            !p.isEmpty
        {
            return p
        }
        if let p = threadSnapshots[threadId]?.provider?.trimmingCharacters(in: .whitespacesAndNewlines),
            !p.isEmpty
        {
            return p
        }
        return nil
    }

    private func providerForThread(_ threadId: String) -> String? {
        Self.proposedPlanProvider(
            threadId: threadId, taskCards: taskCards, threadSnapshots: threadSnapshots)
    }

    /// The provider controls the thread last used, derived from its projected
    /// card so a plan approve/respond preserves Fast and K3 effort.
    private func cardProviderControls(
        threadId: String, provider: String
    ) -> (fast: Bool?, thinking: Bool?, reasoning: String?) {
        // No cached card (older thread outside the snapshot window, or projection
        // not yet landed) — return nil so the composerPrompt OMITS Fast entirely
        // and the Mac inherits it from chat metadata, rather than forcing it off.
        guard let card = taskCards.first(where: { $0.id == threadId || $0.threadId == threadId })
        else { return (nil, nil, nil) }
        let fast: Bool
        switch provider.lowercased() {
        case "cursor": fast = card.cursorFastMode ?? false
        case "claude": fast = card.claudeFastMode ?? false
        case "codex": fast = card.codexServiceTier == "fast"
        case "kimi": fast = card.kimiFastMode ?? false
        default: fast = false
        }
        let thinking: Bool? =
            provider.lowercased() == "kimi" ? (card.kimiThinkingEnabled ?? true) : nil
        let reasoning = provider.lowercased() == "kimi" ? card.kimiReasoningEffort : nil
        return (fast, thinking, reasoning)
    }

    private func failMissingProposedPlanProvider(_ threadId: String) {
        lastActionMessage =
            "Can't act on this plan yet because the Mac has not projected the thread's provider. Refresh the thread, then try again."
        scheduleThreadRefreshAfterUserAction(threadId)
    }

    /// True once the user has acted on this plan locally (optimistic) — drives the
    /// action row's disabled state until the Mac's status re-projection confirms.
    public func proposedPlanIsReplied(_ messageId: String) -> Bool {
        repliedProposedPlanIds.contains(messageId)
    }

    /// Approve a proposed plan: dispatch the implement run in DEFAULT (file-write)
    /// mode, and mark the plan `approved` ONLY once that run is accepted. Gating
    /// the status flip on the run's ack means a plan-only / global workspace that
    /// DENIES the elevated 'default' run restores the card instead of lying that
    /// it was approved when nothing ran. The Mac re-signs the elevated posture
    /// trust-side (composerPromptFn → signRunPosture); the phone sends no HMAC.
    /// The prompt references "the plan above", so the agent reads the canonical
    /// plan from its own transcript — the phone never round-trips the (possibly
    /// truncated) preview body.
    /// Approve a proposed plan: dispatch the write-capable implement run, naming
    /// the plan it implements (`proposedPlanImplementOf`). A SINGLE leg — the Mac
    /// flips the plan status to 'approved' ATOMICALLY with the dispatch and
    /// rejects the run if the plan is no longer pending. So a second device
    /// tapping Approve in the projection-latency window can't fire a duplicate
    /// write-capable run, and a lost ack can't strand the card 'pending' (the
    /// flip and the run are one Mac op, re-projected back). A read-only /
    /// plan-only / global workspace denies the elevated run upstream
    /// (accepted == false), so we re-enable the card rather than lie it ran.
    public func proposedPlanApprove(threadId: String, messageId: String) {
        guard let ws = remoteScopeForThread(threadId) else { return }
        // Self-defending against a double-fire even though `.disabled(decided)`
        // also gates the button (the Set insert below is synchronous on
        // @MainActor, so the View binding usually flips first).
        guard !repliedProposedPlanIds.contains(messageId) else { return }
        guard let provider = providerForThread(threadId) else {
            failMissingProposedPlanProvider(threadId)
            return
        }
        repliedProposedPlanIds.insert(messageId)
        let controls = cardProviderControls(threadId: threadId, provider: provider)
        send(
            BridgeAction.composerPrompt(
                workspaceId: ws, threadId: threadId, provider: provider,
                text: "The plan above is approved — go ahead and implement it now.",
                approvalMode: "default", reasoningEffort: controls.reasoning,
                proposedPlanImplementOf: messageId,
                fastModeEnabled: controls.fast, kimiThinkingEnabled: controls.thinking),
            successLabel: "Plan approved — implementing.",
            onAck: { [weak self] accepted in
                guard let self, !accepted else { return }
                // Denied (read-only workspace) or rejected (already decided on
                // another device) — re-enable; the Mac's status re-projection
                // collapses the card if it was in fact decided elsewhere.
                self.repliedProposedPlanIds.remove(messageId)
            })
        scheduleThreadRefreshAfterUserAction(threadId)
    }

    /// Respond to a proposed plan with feedback: send it as a normal turn WITHOUT
    /// approvalMode (stays in plan mode so the agent re-plans) and dismiss the
    /// current plan card once the turn is accepted. Mirrors the desktop
    /// handleProposedPlanCustom (revise, no permission elevation).
    public func proposedPlanRespond(threadId: String, messageId: String, feedback: String) {
        let trimmed = feedback.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let ws = remoteScopeForThread(threadId) else { return }
        guard !repliedProposedPlanIds.contains(messageId) else { return }
        guard let provider = providerForThread(threadId) else {
            failMissingProposedPlanProvider(threadId)
            return
        }
        repliedProposedPlanIds.insert(messageId)
        let controls = cardProviderControls(threadId: threadId, provider: provider)
        send(
            BridgeAction.composerPrompt(
                workspaceId: ws, threadId: threadId, provider: provider, text: trimmed,
                reasoningEffort: controls.reasoning,
                fastModeEnabled: controls.fast, kimiThinkingEnabled: controls.thinking),
            successLabel: "Feedback sent.",
            onAck: { [weak self] accepted in
                guard let self else { return }
                if accepted {
                    self.send(
                        BridgeAction.proposedPlanDecision(
                            workspaceId: ws, threadId: threadId, messageId: messageId,
                            decision: "dismissed"))
                } else {
                    self.repliedProposedPlanIds.remove(messageId)
                }
            })
        scheduleThreadRefreshAfterUserAction(threadId)
    }

    /// Dismiss a proposed plan with no run — the executor only flips status.
    public func proposedPlanDismiss(threadId: String, messageId: String) {
        guard let ws = remoteScopeForThread(threadId) else { return }
        guard !repliedProposedPlanIds.contains(messageId) else { return }
        repliedProposedPlanIds.insert(messageId)
        send(
            BridgeAction.proposedPlanDecision(
                workspaceId: ws, threadId: threadId, messageId: messageId, decision: "dismissed"),
            successLabel: "Plan dismissed.",
            onAck: { [weak self] accepted in
                guard let self, !accepted else { return }
                self.repliedProposedPlanIds.remove(messageId)
            })
        scheduleThreadRefreshAfterUserAction(threadId)
    }

    /// P3 phone Canvas write-actions: close or reload an open preview. No local
    /// optimistic state to roll back — the projection re-broadcast updates the card.
    public func canvasClose(threadId: String, canvasId: String) {
        sendCanvasAction(threadId: threadId, canvasId: canvasId, action: "close")
    }
    public func canvasReload(threadId: String, canvasId: String) {
        sendCanvasAction(threadId: threadId, canvasId: canvasId, action: "reload")
    }
    private func sendCanvasAction(threadId: String, canvasId: String, action: String) {
        guard let ws = remoteScopeForThread(threadId) else { return }
        send(
            BridgeAction.canvasAction(
                workspaceId: ws, threadId: threadId, canvasId: canvasId, action: action),
            successLabel: action == "close" ? "Canvas closed." : "Canvas reloaded.")
        scheduleThreadRefreshAfterUserAction(threadId)
    }

    public func cancelRun(_ card: RemoteTaskCard) {
        guard let thread = card.threadId else { return }
        let hostRoute = PairedHostActionRouting.runCancel(
            threadId: thread,
            commandsAvailable: hostProjection.canSubmitCommands)
        if case .host(let command) = hostRoute {
            Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    let receipt = try await self.hostProjection.submitCommand(
                        name: command.name,
                        target: command.target,
                        arguments: command.arguments)
                    self.lastActionMessage = PairedHostActionRouting.message(
                        for: receipt,
                        success: card.isEnsemble ? "Round cancelled." : "Run cancelled.")
                } catch {
                    self.lastActionMessage = error.localizedDescription
                }
            }
            return
        }
        // Global chats carry no workspaceId; present the reserved "global" scope
        // (NOT an empty string) so the Mac's allowlist gate ACCEPTS the cancel.
        let ws = (card.workspaceId ?? "").isEmpty ? "global" : card.workspaceId!
        // Ensemble Stop must cancel the whole ROUND, not just the current
        // participant. A per-run cancel kills one participant's process but never
        // sets runtime.cancelled, so the orchestrator just advances to the next
        // participant (and the continuation loop keeps going) — which is why a
        // single Stop didn't halt the round. cancelRound sets runtime.cancelled
        // AND cancels each participant by its true provider. Desktop parity:
        // handleCancel → cancelEnsembleRound for ensemble chats.
        if card.isEnsemble {
            send(
                BridgeAction.ensembleCancelRound(workspaceId: ws, threadId: thread),
                successLabel: "Round cancelled.")
            return
        }
        // Solo: fall back to the live stream's run id — the throttled `card.runId`
        // lags the un-throttled stream, so an early Stop tap must still target
        // the in-flight run.
        let runId = card.runId ?? streamingRunIds[card.id]
        guard let provider = card.provider, let runId else { return }
        send(
            BridgeAction.cancelRun(
                provider: provider, runId: runId,
                workspaceId: ws, threadId: thread))
    }

    /// Start a NEW task: create the Mac chat first, then send the initial
    /// prompt into the returned thread. The ownership validator rejects prompts
    /// for unknown thread ids, so the old direct `composerPrompt(ios-*)` path
    /// now fails correctly.
    public func startTask(
        workspaceId: String, provider: String, prompt: String, model: String? = nil,
        approvalMode: String? = nil,
        workflowMode: String? = nil,
        permissionPresetId: String? = nil,
        reasoningEffort: String? = nil,
        imageAttachments: [[String: Any]]? = nil,
        fastModeEnabled: Bool? = nil, kimiThinkingEnabled: Bool? = nil,
        scheduledRunAt: String? = nil
    ) {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasAttachments = imageAttachments?.isEmpty == false
        guard !trimmed.isEmpty || hasAttachments else { return }
        let title = Self.normalizedThreadTitle(trimmed, fallback: "New Chat")
        send(
            BridgeAction.createThread(
                workspaceId: workspaceId, variant: "workspace", provider: provider,
                title: title),
            timeoutMs: 12_000,
            successLabel: "Chat created.",
            navigateOnAck: false
        ) { [weak self] threadId in
            guard let self, let threadId else { return }
            self.navigationTarget = threadId
            self.rememberThreadWorkspace(threadId, workspaceId: workspaceId)
            let action =
                scheduledRunAt == nil
                ? BridgeAction.composerPrompt(
                    workspaceId: workspaceId, threadId: threadId, provider: provider,
                    text: trimmed, approvalMode: approvalMode, workflowMode: workflowMode,
                    permissionPresetId: permissionPresetId,
                    model: model, reasoningEffort: reasoningEffort,
                    imageAttachments: imageAttachments,
                    fastModeEnabled: fastModeEnabled, kimiThinkingEnabled: kimiThinkingEnabled)
                : BridgeAction.composerSchedulePrompt(
                    workspaceId: workspaceId, threadId: threadId, provider: provider,
                    text: trimmed, scheduledRunAt: scheduledRunAt!,
                    approvalMode: approvalMode, workflowMode: workflowMode,
                    permissionPresetId: permissionPresetId,
                    model: model, reasoningEffort: reasoningEffort,
                    fastModeEnabled: fastModeEnabled, kimiThinkingEnabled: kimiThinkingEnabled)
            self.send(
                action,
                timeoutMs: 12_000,
                successLabel: scheduledRunAt == nil ? "Sent." : "Scheduled.",
                navigateToThreadId: threadId)
            self.scheduleThreadRefreshAfterUserAction(threadId)
        }
    }

    /// Create an empty chat and navigate to its transcript welcome surface.
    /// The first prompt is sent from `ThreadDetailView`, so the phone gets the
    /// same welcome card and full composer as a reopened empty chat.
    public func createEmptyThread(
        workspaceId: String, variant: String = "workspace", provider: String? = nil,
        threadId: String? = nil, title: String = "New Chat", onCreated: ((String?) -> Void)? = nil
    ) {
        let normalizedTitle = Self.normalizedThreadTitle(title, fallback: "New Chat")
        // Desktop parity: ensemble is toggled in-place after a solo workspace chat
        // exists — never created exclusively via `variant: ensemble`.
        let normalizedVariant = variant == "ensemble" ? "workspace" : variant
        if isDemo {
            createDemoThread(
                workspaceId: workspaceId, variant: normalizedVariant, provider: provider,
                title: normalizedTitle,
                onCreated: onCreated)
            return
        }
        send(
            BridgeAction.createThread(
                workspaceId: workspaceId, variant: normalizedVariant, threadId: threadId,
                provider: provider,
                title: normalizedTitle),
            timeoutMs: 12_000,
            successLabel: "Chat created.",
            navigateOnAck: true,
            onThreadCreated: { [weak self] threadId in
                guard let self, let threadId else {
                    onCreated?(nil)
                    return
                }
                self.rememberThreadWorkspace(threadId, workspaceId: workspaceId)
                self.scheduleThreadRefreshAfterUserAction(threadId)
                onCreated?(threadId)
            },
            // A denied/failed create never reaches onThreadCreated (send only
            // fires that when accepted), which left the new-chat canvas spinning
            // on "Creating…" forever — exactly what "can't start a global /
            // ensemble chat" looks like. Surface the failure so the canvas can
            // show the Mac's reason (e.g. ensemble mode disabled, global not
            // shared while the workspace allowlist is empty) and offer Retry.
            onAck: { accepted in
                if !accepted { onCreated?(nil) }
            }
        )
    }

    /// Record the first-thread workspace decision on the Mac. Granting creates
    /// a persistent universal workspace entry; declining leaves any existing
    /// entry untouched and returns `false`.
    public func setRemoteWorkspaceAccess(
        workspaceId: String, enabled: Bool, completion: @escaping (Bool) -> Void
    ) {
        if isDemo {
            completion(enabled)
            return
        }
        send(
            BridgeAction.setRemoteWorkspaceAccess(
                workspaceId: workspaceId, enabled: enabled),
            timeoutMs: 12_000,
            successLabel: enabled ? "Workspace access allowed." : "Workspace access not allowed.",
            navigateOnAck: false,
            onAckResult: { [weak self] accepted, ack in
                guard accepted, let data = ack?.result,
                    let result = try? TWCoders.decoder.decode(BridgeActionAck.self, from: data)
                else {
                    completion(false)
                    return
                }
                let granted = result.data?.granted == true
                if granted { self?.markRemoteWorkspaceGrantedFromAck(workspaceId) }
                completion(granted)
            })
    }

    /// Grant/revoke the exact Mac-side Full Access lane. The completion is
    /// host-authoritative; callers must not switch their UI to full_access until
    /// it returns true.
    public func setTrustedSession(
        _ card: RemoteTaskCard, enabled: Bool,
        ensembleParticipantId: String? = nil, provider: String? = nil,
        runtimeProfileId: String? = nil,
        completion: @escaping (Bool) -> Void
    ) {
        guard let workspaceId = card.workspaceId, let threadId = card.threadId,
            let resolvedProvider = provider ?? card.provider
        else {
            completion(false)
            return
        }
        if isDemo {
            completion(true)
            return
        }
        let resolvedRuntimeProfileId: String?
        if ensembleParticipantId != nil {
            resolvedRuntimeProfileId = runtimeProfileId
        } else if resolvedProvider.caseInsensitiveCompare(card.provider ?? "") == .orderedSame {
            resolvedRuntimeProfileId = runtimeProfileId ?? card.runtimeProfileId
        } else {
            // A changed solo provider must let the Mac resolve that provider's
            // own profile; the projected card profile belongs to the old lane.
            resolvedRuntimeProfileId = nil
        }
        send(
            BridgeAction.setTrustedSession(
                workspaceId: workspaceId, threadId: threadId,
                provider: resolvedProvider, enabled: enabled,
                ensembleParticipantId: ensembleParticipantId,
                runtimeProfileId: resolvedRuntimeProfileId),
            timeoutMs: 12_000,
            successLabel: enabled ? "Full Access enabled." : "Full Access disabled.",
            navigateOnAck: false,
            onAckResult: { accepted, ack in
                guard accepted, let data = ack?.result,
                    let result = try? TWCoders.decoder.decode(BridgeActionAck.self, from: data)
                else {
                    completion(false)
                    return
                }
                completion(result.data?.enabled == enabled)
            })
    }

    /// Create an empty ensemble chat, optionally queue the first prompt.
    /// One draft roster entry from the phone's ensemble editor.
    public struct EnsembleDraftParticipant: Sendable {
        public let provider: String
        public let model: String?
        public init(provider: String, model: String?) {
            self.provider = provider
            self.model = model
        }
    }

    /// Create a workspace chat, toggle ensemble in-place, then steer the first round.
    /// Desktop parity: solo-first creation + composer-rail toggle semantics.
    public func startEnsemble(
        workspaceId: String, prompt: String,
        participants: [EnsembleDraftParticipant]? = nil
    ) {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let primary = participants?.first
        let provider = (primary?.provider ?? "claude").lowercased()
        let title = Self.normalizedThreadTitle(trimmed, fallback: "New Chat")
        let seed = ChatKindBridge.buildSeedParticipant(
            provider: provider, model: primary?.model)
        send(
            BridgeAction.createThread(
                workspaceId: workspaceId, variant: "workspace", provider: provider,
                title: title),
            timeoutMs: 12_000,
            successLabel: "Chat created.",
            navigateOnAck: false
        ) { [weak self] threadId in
            guard let self, let threadId else { return }
            self.navigationTarget = threadId
            self.rememberThreadWorkspace(threadId, workspaceId: workspaceId)
            self.send(
                BridgeAction.setChatKind(
                    workspaceId: workspaceId, threadId: threadId, targetKind: "ensemble",
                    seedParticipant: seed),
                successLabel: "Ensemble enabled.",
                navigateOnAck: false,
                onAck: { [weak self] accepted in
                    guard let self, accepted else { return }
                    self.send(
                        BridgeAction.ensembleSteer(
                            workspaceId: workspaceId, threadId: threadId, text: trimmed),
                        successLabel: "Round started.")
                    self.scheduleThreadRefreshAfterUserAction(threadId)
                })
        }
    }

    /// Create an empty global chat via the reserved 'global' scope (the Mac
    /// grants it startTurn once any workspace is allowlisted; phone-origin
    /// turns in it always run plan-mode).
    public func startGlobalChat() {
        send(
            BridgeAction.createThread(workspaceId: "global", variant: "global"),
            timeoutMs: 12_000,
            successLabel: "General chat created.",
            navigateOnAck: true
        ) { [weak self] threadId in
            guard let self, let threadId else { return }
            self.rememberThreadWorkspace(threadId, workspaceId: "global")
            self.scheduleThreadRefreshAfterUserAction(threadId)
        }
    }

    /// Send a follow-up prompt into an existing thread.
    /// `navigateOnAck: false` keeps the shell's selection where it is —
    /// the side-chat mini pane sends must NOT steal the main transcript
    /// (the ack carries the side chat's threadId, which would otherwise
    /// claim navigationTarget and reload the detail pane).
    /// Live-steer the ACTIVE solo turn (composerSteerLive) — redirect the
    /// agent NOW instead of queueing behind the turn. Delivery is judged by
    /// the Mac's ack (the run-queue verdict travels back in the action
    /// result), never by watching the transcript. A Mac that refuses the live
    /// attempt has already released the same durable row to the boundary
    /// queue, so the words are never lost either way.
    public func steerSoloLive(
        _ card: RemoteTaskCard, prompt: String,
        onActionUnsent: (() -> Void)? = nil
    ) {
        guard !isDemo else {
            appendDemoTurn(card: card, prompt: prompt)
            return
        }
        guard let thread = card.threadId else { return }
        let cardWorkspace = (card.workspaceId ?? "").isEmpty ? nil : card.workspaceId
        let ws = cardWorkspace ?? "global"
        send(
            BridgeAction.composerSteerLive(workspaceId: ws, threadId: thread, text: prompt),
            successLabel: "Steering the live turn.",
            navigateOnAck: false,
            onUnsent: onActionUnsent)
    }

    public func continueTask(
        _ card: RemoteTaskCard, prompt: String, approvalMode: String? = nil,
        workflowMode: String? = nil, permissionPresetId: String? = nil,
        model: String? = nil, providerOverride: String? = nil,
        reasoningEffort: String? = nil,
        imageAttachments: [[String: Any]]? = nil,
        extraWorkspaceIds: [String]? = nil,
        fastModeEnabled: Bool? = nil, kimiThinkingEnabled: Bool? = nil,
        navigateOnAck: Bool = true,
        onActionUnsent: (() -> Void)? = nil,
        /// ONE typed terminal verdict, fired EXACTLY ONCE on EVERY route —
        /// including the hostProjection accepted-success path.
        ///
        /// This replaces an earlier `onActionAck: ((Bool) -> Void)` that was
        /// wrong twice over. The hostProjection route fired NOTHING on accepted
        /// success, so an awaiting caller hung forever; and on the bridge route
        /// `send` emits its failure callbacks in a fixed order that hides
        /// `.unreachable` behind `.rejected`. A Bool could not carry the
        /// distinction and a pair of callbacks could not be ordered safely, so
        /// there is now exactly one callback carrying a classified outcome.
        ///
        /// STILL callback-free — pre-check before suspending on this:
        /// `isDemo`, a missing `threadId`, and (non-ensemble cards only) a
        /// missing `provider`. See `deliverQueuedPrompt`.
        onActionDeliveryVerdict: ((OfflineOutboxDelivery) -> Void)? = nil
    ) {
        if isDemo {
            appendDemoTurn(card: card, prompt: prompt)
            return
        }
        guard let thread = card.threadId else { return }
        // Scope-global chats present the reserved 'global' scope; the Mac
        // clamps their turns to plan mode (no file mutation).
        let cardWorkspace = (card.workspaceId ?? "").isEmpty ? nil : card.workspaceId
        let ws = cardWorkspace ?? "global"
        let ensembleRoundId =
            card.isEnsemble ? (ensembleStates[card.id]?.roundId ?? ensembleStates[thread]?.roundId) : nil
        let threadSummaryFingerprints: Set<String> = currentRunSummaryFingerprints(
            threadId: thread, fallbackRunId: card.runId, fallbackEnsembleRoundId: ensembleRoundId)
        let cardSummaryFingerprints: Set<String> =
            card.id != thread
            ? currentRunSummaryFingerprints(
                threadId: card.id, fallbackRunId: card.runId,
                fallbackEnsembleRoundId: ensembleRoundId) : []
        let hostRoute = PairedHostActionRouting.composerSend(
            threadId: thread,
            text: prompt,
            model: model,
            reasoningEffort: reasoningEffort,
            hasUnsupportedArguments: approvalMode != nil || workflowMode != nil
                || permissionPresetId != nil || providerOverride != nil
                || imageAttachments?.isEmpty == false || extraWorkspaceIds?.isEmpty == false
                || fastModeEnabled != nil || kimiThinkingEnabled != nil,
            commandsAvailable: hostProjection.canSubmitCommands)
        if case .host(let command) = hostRoute {
            Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    let receipt = try await self.hostProjection.submitCommand(
                        name: command.name,
                        target: command.target,
                        arguments: command.arguments)
                    self.lastActionMessage = PairedHostActionRouting.message(
                        for: receipt,
                        success: card.isEnsemble ? "Sent to ensemble." : "Sent.")
                    guard PairedHostActionRouting.acceptedForProcessing(receipt) else {
                        onActionDeliveryVerdict?(.rejected("your Mac did not accept it"))
                        onActionUnsent?()
                        return
                    }
                    // Accepted for processing IS delivery on this route. Fired
                    // here, before any further work, because this success path
                    // previously emitted NO callback at all — an awaiting
                    // caller suspended on it hung forever on a SUCCESSFUL send.
                    onActionDeliveryVerdict?(.delivered)
                    if navigateOnAck { self.navigationTarget = thread }
                    if receipt.status == .succeeded {
                        self.hideRunSummaryFingerprintsForNextTurn(
                            threadSummaryFingerprints, threadId: thread)
                        if card.id != thread {
                            self.hideRunSummaryFingerprintsForNextTurn(
                                cardSummaryFingerprints, threadId: card.id)
                        }
                    }
                } catch {
                    self.lastActionMessage = error.localizedDescription
                    // We never obtained a verdict from the Mac, so this is
                    // "could not ask", not "was refused".
                    onActionDeliveryVerdict?(.unreachable)
                    onActionUnsent?()
                }
            }
            scheduleThreadRefreshAfterUserAction(thread)
            return
        }
        if card.isEnsemble {
            send(
                BridgeAction.ensembleSteer(
                    workspaceId: ws, threadId: thread, text: prompt,
                    imageAttachments: imageAttachments),
                successLabel: "Sent to ensemble.",
                navigateOnAck: navigateOnAck,
                onUnsent: onActionUnsent,
                onDeliveryVerdict: onActionDeliveryVerdict,
                onAck: { [weak self] accepted in
                    guard accepted else { return }
                    self?.hideRunSummaryFingerprintsForNextTurn(
                        threadSummaryFingerprints, threadId: thread)
                    if card.id != thread {
                        self?.hideRunSummaryFingerprintsForNextTurn(
                            cardSummaryFingerprints, threadId: card.id)
                    }
                })
        } else {
            guard let provider = providerOverride ?? card.provider else { return }
            send(
                BridgeAction.composerPrompt(
                    workspaceId: ws, threadId: thread, provider: provider, text: prompt,
                    approvalMode: approvalMode, workflowMode: workflowMode,
                    permissionPresetId: permissionPresetId, model: model,
                    extraWorkspaceIds: extraWorkspaceIds,
                    reasoningEffort: reasoningEffort,
                    imageAttachments: imageAttachments,
                    fastModeEnabled: fastModeEnabled, kimiThinkingEnabled: kimiThinkingEnabled),
                timeoutMs: 12_000,
                successLabel: "Sent.",
                navigateOnAck: navigateOnAck,
                onUnsent: onActionUnsent,
                onDeliveryVerdict: onActionDeliveryVerdict,
                onAck: { [weak self] accepted in
                    guard accepted else { return }
                    self?.hideRunSummaryFingerprintsForNextTurn(
                        threadSummaryFingerprints, threadId: thread)
                    if card.id != thread {
                        self?.hideRunSummaryFingerprintsForNextTurn(
                            cardSummaryFingerprints, threadId: card.id)
                    }
                })
        }
        scheduleThreadRefreshAfterUserAction(thread)
    }

    /// Run one action against a computer we have proved alive. A relay socket
    /// can remain healthy while the Mac sleeps, so the transport first asks for
    /// an encrypted pong. If that proof fails, re-resolve the trusted pairing
    /// once and give network-wake / a just-opened lid a bounded chance to bring
    /// the Mac back before returning a user-safe error. The action itself has
    /// not been sent when `hostUnavailable` is thrown, so this one retry cannot
    /// duplicate a mutation.
    private func requestActionAckWithWake(
        _ params: [String: Any], timeoutMs: Int, announceWake: Bool = true,
        skipPeerPreflight: Bool = false
    ) async throws -> AckResult {
        // `[String: Any]` is not Sendable. Freeze it to immutable bytes before
        // crossing from MainActor to the transport actor; the same bytes are
        // safe to reuse only because a host-unavailable preflight sends no
        // application action.
        let paramsData = try JSONSerialization.data(withJSONObject: params)
        if skipPeerPreflight {
            // Already proved alive on the notification-approval wake path.
            // Do not spend another 6s peer ping or a 12s recover wait — that is
            // what blew the ~30s background window.
            guard case .connected = phase, let activeClient = client else {
                throw TransportError.hostUnavailable
            }
            return try await activeClient.requestSerialized(
                "bridge.requestActionAck",
                paramsData: paramsData,
                timeoutMs: timeoutMs,
                skipPeerPreflight: true)
        }
        if case .connected = phase, let activeClient = client {
            // Join any in-flight wake/foreground probe so a 6s encrypted peer
            // ping does not stack on a 2.5s relay ping. A dead shared probe
            // skips checkPeerAlive entirely and recovers.
            let probe = await probeConnectedHealth(peer: true)
            if probe.alive {
                do {
                    return try await activeClient.requestSerialized(
                        "bridge.requestActionAck",
                        paramsData: paramsData,
                        timeoutMs: timeoutMs,
                        skipPeerPreflight: probe.peer)
                } catch TransportError.hostUnavailable {
                    // Fall through to a fresh trusted reconnect. No app action was
                    // transmitted; RelayTransportClient fails before enqueueing it.
                } catch {
                    throw error
                }
            }
        }

        guard hasStoredPairing else { throw TransportError.hostUnavailable }
        // Only the action that actually STARTS a wake dial announces one. A
        // burst arriving while a dial is already in flight coalesces in the
        // coordinator (below) and just waits — re-announcing per action made
        // "Trying to wake your Mac…" strobe once per queued action and read
        // as a storm even when exactly one dial was running.
        if announceWake, !reconnectDialInFlight {
            lastActionMessage = "Trying to wake your Mac…"
        }
        recoverFromUnavailableHostForAction()
        guard await waitForRemoteWakeConnection(timeoutMs: 12_000), let retryClient = client
        else { throw TransportError.hostUnavailable }
        return try await retryClient.requestSerialized(
            "bridge.requestActionAck", paramsData: paramsData, timeoutMs: timeoutMs)
    }

    /// Recovery for an action whose peer-liveness preflight failed. It MUST go
    /// through the single-flight coordinator.
    ///
    /// A bare `reconnectTrusted()` here was the reconnect-storm amplifier: EVERY
    /// phone→host action funnels through `requestActionAckWithWake`, so a burst
    /// of them (an establish fires setWatchedThread + threadSnapshotRequest +
    /// gitSnapshot + the APNs registration at once) each started its OWN dial.
    /// `reconnectTrusted()` opens with `teardown()`, which nils the client its
    /// siblings are mid-`request()` on — their `checkPeerAlive()` then fails
    /// instantly (`guard established`), reports `hostUnavailable`, and dials
    /// again. Self-sustaining: after a host restart on 2026-07-28 the phone
    /// re-established the E2EE session 152 times over ONE live transport
    /// (host log: 152 "post-establish rehydrate snapshot sent", a single
    /// "transport established", and 38 "[e2ee] clientAuth signature invalid"
    /// from overlapping handshakes) until iOS killed the app.
    ///
    /// The coordinator collapses the burst: the first failure starts/supersedes
    /// one dial and flips `phase` to `.connecting` synchronously, so every
    /// sibling coalesces into it (`.ignore`) and simply waits for that dial via
    /// `waitForRemoteWakeConnection`. A genuinely asleep Mac still gets its
    /// wake dial — only the duplicates are dropped.
    private func recoverFromUnavailableHostForAction() {
        requestReconnect(.health, socketAlive: false)
    }

    #if DEBUG
        /// Test seam for the storm guarantee: N concurrent action recoveries
        /// must produce exactly ONE trusted dial.
        func recoverFromUnavailableHostForActionForTesting() {
            recoverFromUnavailableHostForAction()
        }
    #endif

    nonisolated static func actionFailureMessage(
        _ error: Error, phase: SessionPhase
    ) -> String {
        if case TransportError.hostUnavailable = error {
            return hostUnavailableActionMessage
        }
        let text = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        if case .connected = phase, text == "timeout" {
            return "Your Mac is taking longer than usual to respond — it's still connected."
        }
        return text
    }

    private func send(
        _ params: [String: Any], timeoutMs: Int = 16_000, successLabel: String = "Sent.",
        navigateToThreadId: String? = nil,
        navigateOnAck: Bool = true,
        silent: Bool = false,
        skipPeerPreflight: Bool = false,
        onThreadCreated: ((String?) -> Void)? = nil,
        onUnsent: (() -> Void)? = nil,
        /// ONE typed terminal verdict, fired EXACTLY ONCE per send, classified
        /// here where the outcome is actually known.
        ///
        /// The legacy trio below cannot be composed into a verdict by a caller:
        /// on `hostUnavailable` this method fires `onAck(false)` BEFORE
        /// `onUnsent`, so a one-shot listener records "declined" and never sees
        /// "unreachable" — and some routes fire NO callback at all on success.
        /// Anything that must distinguish refused-by-the-Mac from
        /// could-not-reach-the-Mac uses this, never the trio.
        ///
        /// Declared ahead of the trio deliberately: Swift enforces call-site
        /// argument order, so this keeps the verdict visible at the top of a
        /// call rather than buried after a multi-line `onAck` closure.
        onDeliveryVerdict: ((OfflineOutboxDelivery) -> Void)? = nil,
        onAck: ((Bool) -> Void)? = nil,
        onAckResult: ((Bool, AckResult?) -> Void)? = nil
    ) {
        guard !isDemo else { return }
        Task {
            do {
                let ack = try await self.requestActionAckWithWake(
                    params, timeoutMs: timeoutMs, announceWake: !silent,
                    skipPeerPreflight: skipPeerPreflight)
                await MainActor.run {
                    let accepted = Self.actionAckSucceeded(ack)
                    let threadId = accepted ? (Self.threadId(from: ack) ?? navigateToThreadId) : nil
                    if accepted, navigateOnAck, let threadId {
                        self.navigationTarget = threadId
                    }
                    if accepted {
                        onThreadCreated?(threadId)
                    }
                    onAck?(accepted)
                    onAckResult?(accepted, ack)
                    onDeliveryVerdict?(Self.actionDeliveryVerdict(ack))
                    // Connection-aware copy. A request ack can time out even while the
                    // session is fully ESTABLISHED — a momentarily slow Mac, a heavy op
                    // right after connect, or a dropped ack on a live socket. The Mac is
                    // NOT "busy or asleep" then, so the alarming interpretAck/twFriendlyMessage
                    // copy (which re-maps ANY "timed out" string to that banner) is wrong.
                    // While still .connected, surface calm, accurate text with no
                    // "timeout"/"timed out" wording so it isn't re-mapped and the banner
                    // stays a neutral .info instead of a red "asleep" warning.
                    // `silent` actions (e.g. the automatic registerApnsToken) must
                    // never raise a user-facing banner — only navigation / data
                    // callbacks above run for them.
                    if !silent {
                        if !ack.ok, ack.error == "timeout", case .connected = self.phase {
                            self.lastActionMessage =
                                "Your Mac is taking longer than usual to respond — it's still connected."
                        } else {
                            self.lastActionMessage = Self.interpretAck(
                                ack, successLabel: successLabel)
                        }
                    }
                }
            } catch {
                await MainActor.run {
                    onAck?(false)
                    onAckResult?(false, nil)
                    // Classified HERE, where the error is in scope. This is the
                    // ordering bug's fix: the two lines above and the
                    // `onUnsent` below fire in a fixed sequence that made
                    // `.unreachable` unobservable to a one-shot listener.
                    var verdictIsUnreachable = false
                    if case TransportError.hostUnavailable = error { verdictIsUnreachable = true }
                    onDeliveryVerdict?(
                        verdictIsUnreachable
                            ? .unreachable
                            : .rejected(Self.actionFailureMessage(error, phase: self.phase)))
                    // Only restore composer content when peer preflight proves
                    // the app action was never transmitted. An ack timeout is
                    // ambiguous (the run may have started), so never invite a
                    // duplicate by restoring on every generic failure.
                    if case TransportError.hostUnavailable = error { onUnsent?() }
                    if !silent {
                        self.lastActionMessage = Self.actionFailureMessage(error, phase: self.phase)
                    }
                }
            }
        }
    }

    /// Outcome of an approval-reply ack, fine-grained enough to avoid the
    /// unbreakable approval-modal loop. The Mac returns `accepted:true,
    /// executed:false` when the approval is no longer pending (auto-deny timer,
    /// the desktop, or another paired surface resolved it). Treating that as a
    /// plain failure and RESTORING the card re-presents a modal that can never
    /// succeed — every re-tap hits the same already-resolved approval. So we
    /// distinguish "already resolved" (evict) from "policy rejected" (keep
    /// dismissed) from a "transport error" (genuinely retryable → restore).
    enum ApprovalAckOutcome {
        case succeeded
        case alreadyResolved
        case rejected
        case dispatchFailed
        case transportError
    }

    private static func approvalAckOutcome(_ ack: AckResult?) -> ApprovalAckOutcome {
        guard let ack, ack.ok else { return .transportError }
        guard let data = ack.result,
            let actionAck = try? TWCoders.decoder.decode(BridgeActionAck.self, from: data)
        else { return .succeeded }
        if actionAck.accepted == false { return .rejected }
        if actionAck.executed == false {
            if actionAck.reasonCode == "approvalDispatchFailed"
                || actionAck.message?.localizedCaseInsensitiveContains("Approval dispatch failed")
                    == true
            {
                return .dispatchFailed
            }
            return .alreadyResolved
        }
        return .succeeded
    }

    nonisolated private static func actionAckSucceeded(_ ack: AckResult) -> Bool {
        guard ack.ok else { return false }
        guard let data = ack.result,
            let actionAck = try? TWCoders.decoder.decode(BridgeActionAck.self, from: data)
        else { return true }
        if actionAck.accepted == false { return false }
        if actionAck.executed == false { return false }
        return true
    }

    /// One delivery classification for the bridge's outer ack. An outer
    /// `ok:false` is not a Mac-authored refusal: no action verdict arrived, so
    /// the outbox must keep the prompt as unreachable rather than label it
    /// declined.
    nonisolated static func actionDeliveryVerdict(_ ack: AckResult) -> OfflineOutboxDelivery {
        if actionAckSucceeded(ack) { return .delivered }
        if !ack.ok { return .unreachable }
        return .rejected("your Mac declined it")
    }

    private static func threadId(from ack: AckResult) -> String? {
        guard let data = ack.result else { return nil }
        if let threadId = nestedThreadId(from: data) { return threadId }
        if let actionAck = try? TWCoders.decoder.decode(BridgeActionAck.self, from: data) {
            if let threadId = actionAck.data?.threadId { return threadId }
            if let threadId = actionAck.threadId { return threadId }
        }
        struct Loose: Codable { let threadId: String? }
        if let loose = try? TWCoders.decoder.decode(Loose.self, from: data) {
            return loose.threadId
        }
        return nil
    }

    private static func nestedThreadId(from data: Data) -> String? {
        guard
            let object = try? JSONSerialization.jsonObject(
                with: data, options: [.fragmentsAllowed]) as? [String: Any],
            let dataObject = object["data"] as? [String: Any]
        else { return nil }
        if let actionKind = dataObject["actionKind"] as? String,
            actionKind == "createSideChat" || actionKind == "createSubThread",
            let result = dataObject["result"] as? [String: Any],
            let threadId = result["threadId"] as? String,
            !threadId.isEmpty
        {
            return threadId
        }
        if let threadId = dataObject["threadId"] as? String, !threadId.isEmpty {
            return threadId
        }
        return nil
    }

    private static func interpretAck(_ ack: AckResult, successLabel: String) -> String {
        if !ack.ok {
            if ack.error == "timeout" {
                return
                    "Timed out waiting for your Mac — is TaskWraith running and paired?"
            }
            return ack.error ?? "Action denied."
        }
        if let data = ack.result,
            let actionAck = try? TWCoders.decoder.decode(BridgeActionAck.self, from: data)
        {
            if actionAck.accepted == false {
                return actionAck.message ?? "Denied by Mac policy."
            }
            if actionAck.executed == false {
                return actionAck.message ?? "Accepted — wiring not complete on Mac."
            }
            if let message = actionAck.message,
                !message.isEmpty,
                message != "Dispatching on your Mac.",
                message != "Chat created on your Mac."
            {
                return message
            }
        }
        return successLabel
    }
}
