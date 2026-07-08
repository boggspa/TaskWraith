// Domain models — Codable mirrors of the projection/action shapes the Mac
// produces (src/main/RemoteTaskProjection.ts) and consumes
// (src/main/BridgeActionPayload.ts). Decoded from the `params` of inbound app
// messages; encoded into the `params` of outbound `bridge.requestActionAck`.
//
// Forward-compatible by design: the Mac adds fields additively, so these decode
// the subset the UI needs and ignore the rest. `payload` on the envelope stays
// raw JSON so a card kind the app doesn't model yet still round-trips for
// display/debugging.

import Foundation

// ── Projections (Mac → iPhone) ────────────────────────────────────────────────

/// `bridge.broadcastRemoteProjectionSnapshot` params.
public struct RemoteProjectionSnapshot: Codable, Sendable {
    public let projections: [RemoteProjectionEnvelope]
}

/// `bridge.broadcastWorkspaceList` params — the allowlist-visible workspaces.
/// This is the compose surface: a paired phone may start tasks ONLY against
/// workspaces the Mac's iOS Remote Workspace Allowlist exposes.
public struct WorkspaceListMessage: Codable, Sendable {
    public let workspaces: [WorkspaceSummary]
}

/// `bridge.broadcastProviderModels` params — per-provider model catalogs
/// (same source as the desktop picker: live CLI/daemon lists + static
/// fallbacks). Drives the hierarchical provider -> model pickers.
/// Per-provider quota windows (desktop MODEL USAGE sidebar parity).
public struct ModelUsageMessage: Codable, Sendable {
    public let usage: Usage

    public struct Usage: Codable, Sendable {
        public let providers: [ProviderUsage]
        public let generatedAt: String?
    }

    public struct ProviderUsage: Codable, Sendable, Identifiable {
        public let provider: String
        public let windows: [Window]
        public var id: String { provider }
    }

    public struct Window: Codable, Sendable, Identifiable {
        public let id: String
        public let label: String
        public let usedPercent: Int
        public let limitLabel: String
        public let resetAt: String?
    }
}

/// Token totals for the heatmap chips (desktop External Activity parity).
public struct UsageRollupMessage: Codable, Sendable {
    public let rollup: Rollup
    /// 90-day daily token series for the Inspector "TaskWraith Tokens" /
    /// "External Tokens" bar charts. Optional so older Mac builds (which only
    /// sent `rollup`) still decode.
    public let taskwraithDaily: DailyTokenSeries?
    public let externalDaily: DailyTokenSeries?

    public struct Rollup: Codable, Sendable {
        public let providers: [ProviderBuckets]
        public let totals: Buckets
    }

    public struct ProviderBuckets: Codable, Sendable, Identifiable {
        public let provider: String
        public let h24: Int
        public let d7: Int
        public let d90: Int
        public var id: String { provider }
    }

    public struct Buckets: Codable, Sendable {
        public let h24: Int
        public let d7: Int
        public let d90: Int
        public init(h24: Int, d7: Int, d90: Int) {
            self.h24 = h24
            self.d7 = d7
            self.d90 = d90
        }
    }
}

/// 90-day daily token totals (oldest → newest) with a per-day dominant provider
/// for bar coloring; `startLabel`/`endLabel` are short axis labels ("18 Mar").
public struct DailyTokenSeries: Codable, Sendable {
    public let totalTokens: Int
    public let startLabel: String
    public let endLabel: String
    public let buckets: [Bucket]

    public struct Bucket: Codable, Sendable {
        public let tokens: Int
        public let provider: String?
    }
}

/// The Electron "New Chat welcome" stats dashboard (4 tabs: Statistics / Model
/// Comparisons / Workspaces / Providers, LAST 30 DAYS), projected from the Mac's
/// `buildWelcomeUsageDashboardData` aggregator into a flat, iOS-friendly shape
/// (the aggregator's per-model `dailyTotals` Map and other renderer-only fields
/// are dropped). Broadcast over `bridge.broadcastWelcomeDashboard`, decoded into
/// `RemoteSessionModel.welcomeDashboard`, rendered by `WelcomeUsageDashboardCard`.
public struct WelcomeDashboardMessage: Codable, Sendable {
    public let dashboard: WelcomeDashboard
    public init(dashboard: WelcomeDashboard) { self.dashboard = dashboard }
}

/// `bridge.broadcastFirstLaunchState` params. The Mac owns this redacted,
/// orientation-only snapshot: provider readiness, workspace access counts,
/// usage windows, notices, and copyable Mac-side setup hints.
public struct FirstLaunchStateMessage: Codable, Sendable {
    public let state: FirstLaunchState
}

public struct FirstLaunchState: Codable, Sendable {
    public let schemaVersion: Int
    public let generatedAt: String?
    public let notifications: [FirstLaunchNotice]
    public let workspace: FirstLaunchWorkspaceSummary?
    public let providerCards: [FirstLaunchProviderCard]
    public let setupCommands: [FirstLaunchSetupCommand]
    public let ollamaModelCommands: [FirstLaunchOllamaModelCommand]
}

public struct FirstLaunchNotice: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let kind: String
    public let title: String
    public let body: String
    public let tone: String
    public let accent: String?
    public let icon: String?
    public let dismissible: Bool?
}

public struct FirstLaunchWorkspaceSummary: Codable, Sendable, Hashable {
    public let visibleCount: Int
    public let totalCount: Int
    public let runningCount: Int
    public let hasVisibleWorkspaces: Bool
    public let capabilities: Capabilities

    public struct Capabilities: Codable, Sendable, Hashable {
        public let monitor: Bool
        public let approve: Bool
        public let answer: Bool
        public let startTurn: Bool
        public let steer: Bool
        public let fileRead: Bool
        public let fileWrite: Bool
        public let externalPublish: Bool?
    }
}

public struct FirstLaunchProviderCard: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let label: String
    public let optional: Bool
    public let statusKind: String
    public let statusText: String
    public let detail: String
    public let setupHint: String
    public let setupCommands: [FirstLaunchSetupCommand]
    public let usageWindows: [FirstLaunchUsageWindow]
    public let usageGeneratedAt: String?
}

public struct FirstLaunchUsageWindow: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let label: String
    public let usedPercent: Int?
    public let resetAt: String?
}

public struct FirstLaunchSetupCommand: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let label: String
    public let command: String
    public let source: String
    public let platform: String?
}

public struct FirstLaunchOllamaModelCommand: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let label: String
    public let command: String
}

public struct WelcomeDashboard: Codable, Sendable {
    // — Statistics tab scalars —
    public let favoriteModel: String
    public let favoriteProject: String
    public let tokens24h: Int
    public let currentStreak: Int
    public let longestStreak: Int
    public let activeDays: Int
    public let longestThreadMs: Int
    public let totalWallTimeMs: Int
    /// Pre-formatted by the Mac aggregator ("2 PM" / "n/a").
    public let peakHour: String
    public let sessions: Int
    public let messages: Int
    public let totalTokens: Int
    public let totalCostUsd: Double
    public let avgSessionMs: Int
    public let tokensPerSession: Int
    /// Providers tab — rolling 24h cumulative wall-clock across runs.
    public let wallTime24hMs: Int
    /// Statistics footer ("You've tracked 19M tokens across 7 providers.").
    public let comparisonText: String
    /// True when the 30-day window has activity (drives the empty state).
    public let hasActivity: Bool
    /// True when there is ANY lifetime activity (drives whether to show the card).
    public let lifetimeHasActivity: Bool

    // — Provider-mix gradient ribbon under the tabs —
    public let providerTokenTotals: [ProviderTokenTotal]
    // — Model Comparisons tab —
    public let modelBreakdown: [ModelDatum]
    // — Workspaces tab (ranked cards + 30-day daily chart) —
    public let workspaceBreakdown: [WorkspaceDatum]
    public let dailyBreakdown: [DailyBucket]
    // — Providers tab (ranked cards + 24h wall time) —
    public let providerBreakdown: [ProviderDatum]

    public struct ProviderTokenTotal: Codable, Sendable, Identifiable {
        public let provider: String
        public let tokens: Int
        public var id: String { provider }
        public init(provider: String, tokens: Int) {
            self.provider = provider; self.tokens = tokens
        }
    }

    public struct ModelDatum: Codable, Sendable, Identifiable {
        public let id: String
        public let provider: String
        public let label: String
        /// CSS/theme hue class sent by the Mac — `provider-<id>`, or the
        /// spoofed Ollama brand class (e.g. `provider-alibaba`). Optional so
        /// older Mac builds that don't send it still decode (falls back to the
        /// runtime provider hue). Mirrors desktop WelcomeUsageModelDatum.
        public let colorClass: String?
        public let inputTokens: Int
        public let outputTokens: Int
        /// Share of kept-model tokens, 0–100.
        public let percent: Double

        /// Provider key for `TWTheme.providerAccent` — strips the `provider-`
        /// prefix off `colorClass` (so Ollama brands resolve to their spoofed
        /// hue) and falls back to the runtime provider.
        public var accentProviderKey: String {
            if let cls = colorClass, cls.hasPrefix("provider-") {
                return String(cls.dropFirst("provider-".count))
            }
            return provider
        }

        public init(
            id: String, provider: String, label: String, colorClass: String? = nil,
            inputTokens: Int, outputTokens: Int, percent: Double
        ) {
            self.id = id; self.provider = provider; self.label = label
            self.colorClass = colorClass
            self.inputTokens = inputTokens; self.outputTokens = outputTokens
            self.percent = percent
        }
    }

    public struct WorkspaceDatum: Codable, Sendable, Identifiable {
        public let id: String
        public let displayName: String
        public let tokens: Int
        public let costUsd: Double
        /// Share of total tokens, 0–100 (drives the meter).
        public let shareOfTotalTokens: Double
        public init(
            id: String, displayName: String, tokens: Int,
            costUsd: Double, shareOfTotalTokens: Double
        ) {
            self.id = id; self.displayName = displayName; self.tokens = tokens
            self.costUsd = costUsd; self.shareOfTotalTokens = shareOfTotalTokens
        }
    }

    public struct ProviderDatum: Codable, Sendable, Identifiable {
        public let provider: String
        public let displayName: String
        public let tokens: Int
        public let costUsd: Double
        public let shareOfTotalTokens: Double
        public var id: String { provider }
        public init(
            provider: String, displayName: String, tokens: Int,
            costUsd: Double, shareOfTotalTokens: Double
        ) {
            self.provider = provider; self.displayName = displayName
            self.tokens = tokens; self.costUsd = costUsd
            self.shareOfTotalTokens = shareOfTotalTokens
        }
    }

    public struct DailyBucket: Codable, Sendable, Identifiable {
        /// YYYY-MM-DD local-day key.
        public let id: String
        /// Short axis/tooltip label ("May 15").
        public let dayLabel: String
        public let tokens: Int
        public let costUsd: Double
        public init(id: String, dayLabel: String, tokens: Int, costUsd: Double) {
            self.id = id; self.dayLabel = dayLabel
            self.tokens = tokens; self.costUsd = costUsd
        }
    }

    /// Resilient decode — every field defaults rather than throwing, so one
    /// missing/mistyped value (e.g. a fractional number where an Int is expected)
    /// degrades that field instead of nuking the whole dashboard (a strict decode
    /// failure → nil → hidden card). Arrays default to empty.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func i(_ k: CodingKeys) -> Int { (try? c.decode(Int.self, forKey: k)) ?? 0 }
        func d(_ k: CodingKeys) -> Double { (try? c.decode(Double.self, forKey: k)) ?? 0 }
        func s(_ k: CodingKeys) -> String { (try? c.decode(String.self, forKey: k)) ?? "" }
        func b(_ k: CodingKeys) -> Bool { (try? c.decode(Bool.self, forKey: k)) ?? false }
        favoriteModel = s(.favoriteModel)
        favoriteProject = s(.favoriteProject)
        tokens24h = i(.tokens24h)
        currentStreak = i(.currentStreak)
        longestStreak = i(.longestStreak)
        activeDays = i(.activeDays)
        longestThreadMs = i(.longestThreadMs)
        totalWallTimeMs = i(.totalWallTimeMs)
        peakHour = s(.peakHour)
        sessions = i(.sessions)
        messages = i(.messages)
        totalTokens = i(.totalTokens)
        totalCostUsd = d(.totalCostUsd)
        avgSessionMs = i(.avgSessionMs)
        tokensPerSession = i(.tokensPerSession)
        wallTime24hMs = i(.wallTime24hMs)
        comparisonText = s(.comparisonText)
        hasActivity = b(.hasActivity)
        lifetimeHasActivity = b(.lifetimeHasActivity)
        providerTokenTotals =
            (try? c.decode([ProviderTokenTotal].self, forKey: .providerTokenTotals)) ?? []
        modelBreakdown = (try? c.decode([ModelDatum].self, forKey: .modelBreakdown)) ?? []
        workspaceBreakdown =
            (try? c.decode([WorkspaceDatum].self, forKey: .workspaceBreakdown)) ?? []
        dailyBreakdown = (try? c.decode([DailyBucket].self, forKey: .dailyBreakdown)) ?? []
        providerBreakdown =
            (try? c.decode([ProviderDatum].self, forKey: .providerBreakdown)) ?? []
    }

    public init(
        favoriteModel: String, favoriteProject: String, tokens24h: Int,
        currentStreak: Int, longestStreak: Int, activeDays: Int,
        longestThreadMs: Int, totalWallTimeMs: Int, peakHour: String,
        sessions: Int, messages: Int, totalTokens: Int, totalCostUsd: Double,
        avgSessionMs: Int, tokensPerSession: Int, wallTime24hMs: Int,
        comparisonText: String, hasActivity: Bool, lifetimeHasActivity: Bool,
        providerTokenTotals: [ProviderTokenTotal], modelBreakdown: [ModelDatum],
        workspaceBreakdown: [WorkspaceDatum], dailyBreakdown: [DailyBucket],
        providerBreakdown: [ProviderDatum]
    ) {
        self.favoriteModel = favoriteModel
        self.favoriteProject = favoriteProject
        self.tokens24h = tokens24h
        self.currentStreak = currentStreak
        self.longestStreak = longestStreak
        self.activeDays = activeDays
        self.longestThreadMs = longestThreadMs
        self.totalWallTimeMs = totalWallTimeMs
        self.peakHour = peakHour
        self.sessions = sessions
        self.messages = messages
        self.totalTokens = totalTokens
        self.totalCostUsd = totalCostUsd
        self.avgSessionMs = avgSessionMs
        self.tokensPerSession = tokensPerSession
        self.wallTime24hMs = wallTime24hMs
        self.comparisonText = comparisonText
        self.hasActivity = hasActivity
        self.lifetimeHasActivity = lifetimeHasActivity
        self.providerTokenTotals = providerTokenTotals
        self.modelBreakdown = modelBreakdown
        self.workspaceBreakdown = workspaceBreakdown
        self.dailyBreakdown = dailyBreakdown
        self.providerBreakdown = providerBreakdown
    }
}

public struct ProviderModelsMessage: Codable, Sendable {
    public let providers: [ProviderModelCatalog]
}

public struct ProviderModelCatalog: Codable, Sendable, Identifiable {
    public let provider: String
    public let models: [ModelOption]
    public var id: String { provider }

    public init(provider: String, models: [ModelOption]) {
        self.provider = provider
        self.models = models
    }
}

public struct ModelOption: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let label: String?
    public let isDefault: Bool?
    public let disabled: Bool?
    public let disabledReason: String?
    public let supportedReasoningEfforts: [ReasoningEffortOption]?
    public let defaultReasoningEffort: String?
}

public struct ReasoningEffortOption: Codable, Sendable, Identifiable, Hashable {
    public let reasoningEffort: String
    public let description: String?
    public let disabled: Bool?
    public let disabledReason: String?
    public var id: String { reasoningEffort }
}

public struct WorkspaceSummary: Codable, Sendable, Identifiable, Hashable {
    public let workspaceId: String
    public let displayName: String
    public let path: String
    public let chatCount: Int?
    public let runningChatCount: Int?
    public let capabilities: RemoteTaskCapabilities?
    public var id: String { workspaceId }
}

/// A scheduled / recurring workflow projected from the Mac (sidebar "Workflows"
/// section). Read-only on the phone for now — tapping a row opens the workflow's
/// chat (`threadId`). Every field except `id` is optional per the additive-decode
/// convention so older/newer Mac builds still decode.
/// A saved ensemble roster preset projected from the Mac (iOS Roster page).
/// GLOBAL (not workspace-bound). Participants reuse the roster-entry shape so
/// the phone can apply a preset by replaying them through the existing
/// roster-update action.
public struct RemoteEnsemblePreset: Codable, Sendable, Identifiable {
    public let id: String
    public let name: String?
    public let orchestrationMode: String?
    public let maxParticipants: Int?
    public let updatedAt: Double?
    public let participants: [RemoteEnsembleState.RosterEntry]?
}

public struct RemoteWorkflow: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let name: String?
    public let workspaceId: String?
    /// The workflow's chat id — tapping a row opens this thread.
    public let threadId: String?
    public let provider: String?
    public let enabled: Bool?
    /// Human label, e.g. "Every 60 min" or "Manual".
    public let schedule: String?
    /// lastStatus: "idle" | "running" | "completed" | "failed" | "cancelled" | "skipped".
    public let status: String?
    public let nextRunAt: String?
    public let lastRunAt: String?
    /// Slice 7b — latest LOOP execution summary, for the loop-progress badge.
    /// Absent for a non-loop or never-run workflow (decodes to nil).
    public let loopIterationCount: Int?
    public let loopStopReason: String?
    public let loopTokens: Int?

    public var isRunning: Bool { status == "running" }
    /// A paused workflow is one the Mac has explicitly disabled.
    public var isPaused: Bool { enabled == false }
    /// True when the Mac projected a loop summary (i.e. this is a loop workflow that ran).
    public var hasLoopSummary: Bool { (loopIterationCount ?? 0) > 0 }

    public init(
        id: String, name: String? = nil, workspaceId: String? = nil,
        threadId: String? = nil, provider: String? = nil, enabled: Bool? = nil,
        schedule: String? = nil, status: String? = nil,
        nextRunAt: String? = nil, lastRunAt: String? = nil,
        loopIterationCount: Int? = nil, loopStopReason: String? = nil, loopTokens: Int? = nil
    ) {
        self.id = id
        self.name = name
        self.workspaceId = workspaceId
        self.threadId = threadId
        self.provider = provider
        self.enabled = enabled
        self.schedule = schedule
        self.status = status
        self.nextRunAt = nextRunAt
        self.lastRunAt = lastRunAt
        self.loopIterationCount = loopIterationCount
        self.loopStopReason = loopStopReason
        self.loopTokens = loopTokens
    }
}

/// A read-only Workspace Board projected from the Mac. The Mac remains the
/// mutation authority; iOS keeps this as a live list/detail data source.
public struct RemoteWorkspaceBoard: Codable, Sendable, Identifiable, Hashable {
    public struct Column: Codable, Sendable, Identifiable, Hashable {
        public let id: String
        public let name: String?
        public let sortOrder: Double?
        public let wipLimit: Int?
        public let activeCardCount: Int?
        public let archivedCardCount: Int?
    }

    public struct Card: Codable, Sendable, Identifiable, Hashable {
        public let id: String
        public let boardId: String?
        public let workspaceId: String?
        public let columnId: String?
        public let title: String?
        public let body: String?
        public let labels: [String]?
        public let linkKind: String?
        public let linkId: String?
        public let sourceTitle: String?
        public let runId: String?
        public let archived: Bool?
        public let updatedAt: String?
    }

    public let id: String
    public let workspaceId: String?
    public let workspacePath: String?
    public let name: String?
    public let description: String?
    public let pinned: Bool?
    public let archived: Bool?
    public let activeCardCount: Int?
    public let archivedCardCount: Int?
    public let columns: [Column]?
    public let cards: [Card]?
    public let cardLimit: Int?
    public let cardsTruncated: Bool?
    public let createdAt: String?
    public let updatedAt: String?
    public let latestCardUpdatedAt: String?
}

/// The locked envelope shape: `{schemaVersion:1, source:'mac', kind, payload}`.
/// `payload` is kept as raw JSON and decoded on demand by `kind`.
public struct RemoteProjectionEnvelope: Codable, Sendable {
    public let schemaVersion: Int
    public let source: String
    public let kind: String
    public let envelopeId: String?
    public let workspaceId: String?
    public let threadId: String?
    public let runId: String?
    public let payload: RawJSON

    public func decodePayload<T: Decodable>(_ type: T.Type) -> T? {
        try? JSONDecoder().decode(T.self, from: payload.data)
    }
}

public struct RemoteTaskCard: Codable, Sendable {
    public let id: String
    public let title: String?
    public let status: String?
    public let provider: String?
    public let selectedModelType: String?
    public let customModel: String?
    public let codexReasoningEffort: String?
    public let claudeReasoningEffort: String?
    /// Fast/thinking state the Mac projects for the composer to resync to (the
    /// picker's Fast toggle + Kimi thinking). Provider-specific: cursor/claude use
    /// a Bool, codex uses a service tier ("fast"), kimi uses a thinking Bool.
    /// `var … = nil` so the synthesized memberwise init defaults them (older
    /// construction sites don't pass them) while Codable still decodes them.
    public var cursorFastMode: Bool? = nil
    public var claudeFastMode: Bool? = nil
    public var codexServiceTier: String? = nil
    public var kimiThinkingEnabled: Bool? = nil
    /// Slice B: a provider (and optional model/reasoning) switch queued by the
    /// Mac while a run is active (`readPendingProviderChange`). PRESENT only
    /// while a switch is pending, ABSENT otherwise — the composer reflects it as
    /// a "switching at turn end" pill; the host applies it at the turn boundary.
    public let pendingProviderChange: PendingProviderChange?
    public let workspaceId: String?
    public let threadId: String?
    /// Present for sub-threads / isolated side chats — nested under the
    /// parent thread like the desktop sidebar.
    public let parentChatId: String?
    /// ISO8601 — feed the welcome screen's activity heatmap.
    public let createdAt: String?
    public let updatedAt: String?
    public let parentChatRelation: String?
    /// Sidebar pin (desktop parity — drives the Pinned section).
    public let pinned: Bool?
    /// Sub-agent character identity (desktop parity).
    public let agentName: String?
    public let agentAccent: String?
    public let agentSlug: String?
    public let sideChatMode: String?
    /// Side-chat lifecycle from the Mac (`active` | `closed` | `terminated`).
    /// Absent ⇒ treat as active (older Mac builds didn't project it). A removed
    /// guest's child chat is marked `closed` (not deleted), so the active-guest
    /// detector filters on this to clear the composer chip on removal.
    public let sideChatLifecycleState: String?
    public let chatKind: String?
    /// Unstarted welcome-card draft (0 messages/runs). Kept in the card set so
    /// the in-progress welcome screen resolves, but filtered out of list
    /// sections (HomeListViews) — it isn't a real chat yet.
    public let isDraft: Bool?
    public let draftVariant: String?
    /// Active People/collaboration share. iOS derives its read-only Shared
    /// section from visible task cards with this flag; invite creation remains
    /// Mac-only.
    public let isShared: Bool?
    public let sharedMode: String?
    /// Mirrors ChatRecord.archived. Electron hides archived chats from its
    /// sidebar lists and counts; the phone filters them out too (HomeListViews)
    /// so the iOS thread count matches the desktop sidebar.
    public let archived: Bool?
    public let runId: String?
    /// One-screen text preview of the latest message (Mac-sanitized — the same
    /// field the desktop card shows). Used to enrich the foreground completion
    /// banner body. Older Mac builds omit it ⇒ nil.
    public let preview: String?
    public let pendingApprovalCount: Int?
    public let pendingQuestionCount: Int?
    public let activeGoal: RemoteActiveGoal?
    /// Per-author working plans (PlanRail). Ensemble chats carry one lane per
    /// participant; solo/guest collapse to a single `__solo__` lane. Derived on
    /// the Mac from the activity stream, so it covers every provider whose plan
    /// flows as a tool activity (todo_write / Claude TodoWrite / Codex plan).
    public let todoLanes: [RemoteTodoLane]?
    /// Open Canvas previews in this chat (read-only; P3). Omitted when none open.
    public let canvasPreviews: [RemoteCanvasPreview]?
    public let capabilities: RemoteTaskCapabilities?
    public let additionalWorkspaces: [AdditionalWorkspace]?
    public let queuedComposerPrompts: [QueuedComposerPrompt]?

    public struct AdditionalWorkspace: Codable, Sendable, Identifiable, Hashable {
        public let id: String
        public let path: String
        /// file | directory
        public let kind: String?
        /// read | write
        public let access: String?
        public let providers: [String]?
        public let order: Int?
    }

    public struct QueuedComposerPrompt: Codable, Sendable, Identifiable {
        public let id: String
        public let runId: String
        public let provider: String
        public let text: String
        public let index: Int?
        public let createdAt: String?
        public let enqueuedAt: String?
        public let scheduledRunAt: String?
    }

    /// Mac-projected target of a queued mid-run provider (and optional
    /// model/reasoning) switch. Field names mirror the card's current-provider
    /// fields (`provider` / `selectedModelType` / `customModel`). All optional
    /// for decode resilience across Mac builds.
    public struct PendingProviderChange: Codable, Sendable {
        public let provider: String?
        public let selectedModelType: String?
        public let customModel: String?
    }

    public var isEnsemble: Bool { chatKind == "ensemble" }
    public var isWorkflowDraft: Bool { draftVariant == "workflow" }
    /// Scope-global chats carry no workspace. The Mac strips / null-collapses the
    /// workspaceId for scope:'global' (its canonical signal isn't on the card
    /// wire), so absence ⇒ global. Also treat a literal "global" sentinel as
    /// global, so a future Mac change that stamped it can't silently demote a
    /// global chat into a workspace chat — the welcome card / composer / sidebar
    /// classify off THIS, not off a bare `(workspaceId ?? "").isEmpty`.
    public var isGlobalScope: Bool {
        let id = (workspaceId ?? "").trimmingCharacters(in: .whitespaces)
        return id.isEmpty || id == "global"
    }
    public var isGuestSideChat: Bool {
        parentChatRelation == "sideChat" && sideChatMode == "guestParticipant"
    }
    /// A side chat the Mac still considers live. Absent lifecycle ⇒ active, so
    /// older Mac builds (pre-`sideChatLifecycleState`) keep showing the guest.
    /// A removed guest's child becomes `closed`, so this drops it from the
    /// ACTIVE-guest detector while leaving it visible in the Side-chats history.
    public var sideChatIsActive: Bool {
        (sideChatLifecycleState ?? "active") == "active"
    }
    public var isSubThread: Bool {
        parentChatRelation == "subThread" || (parentChatId != nil && parentChatRelation == nil)
    }
    public var isIsolatedSideChat: Bool {
        parentChatRelation == "sideChat" && sideChatMode != "guestParticipant"
    }
}

public struct RemoteActiveGoal: Codable, Sendable, Hashable {
    public let id: String
    public let objective: String
    public let status: String
    public let mode: String
    public let provider: String
    public let createdAt: String
    public let updatedAt: String
    public let pausedAt: String?
    public let blockedAt: String?
    public let blockedReason: String?
    public let completedAt: String?
    public let completedSummary: String?
    public let lastStatusReason: String?

    public var isActive: Bool { status == "active" }
    public var isPaused: Bool { status == "paused" }
    public var isBlocked: Bool { status == "blocked" }
    public var isCompleted: Bool { status == "completed" }
}

/// One step of an agent's working plan. Mirrors the Mac TodoItem on the wire.
public struct RemoteTodoItem: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let content: String
    /// pending | in_progress | completed | cancelled
    public let status: String

    public var isCompleted: Bool { status == "completed" }
    public var isInProgress: Bool { status == "in_progress" }
    public var isCancelled: Bool { status == "cancelled" }
}

/// One author's plan within a chat (PlanRail lane). `lane` is the ensemble
/// participant/provider id, or `__solo__` for solo/guest chats.
/// A read-only projection of an open TaskWraith Canvas preview (P3). All-optional
/// (forward/back-compat) and never an enum for `status`/`driver` — unknown values
/// degrade gracefully on a read-only seat. Mirrors RemoteCanvasPreview in
/// src/main/RemoteTaskProjection.ts (kept in sync by CanvasPreviewDecodeTests).
public struct RemoteCanvasPreview: Codable, Sendable, Identifiable, Hashable {
    public struct Viewport: Codable, Sendable, Hashable {
        public let width: Double?
        public let height: Double?
    }
    public let canvasId: String?
    public let driver: String?
    public let url: String?
    public let title: String?
    public let status: String?
    public let viewport: Viewport?
    public var id: String { canvasId ?? UUID().uuidString }

    /// A concise label: the page title, else its host, else the driver.
    public var displayLabel: String {
        if let title, !title.isEmpty { return title }
        if let url, let host = URL(string: url)?.host, !host.isEmpty { return host }
        return driver ?? "Canvas"
    }
    public var isActive: Bool { status == "active" }
}

public struct RemoteTodoLane: Codable, Sendable, Identifiable, Hashable {
    public static let soloLane = "__solo__"
    public let lane: String
    public let items: [RemoteTodoItem]
    public var id: String { lane }

    /// True when this lane represents a solo/guest chat (no per-author label).
    public var isSolo: Bool { lane == Self.soloLane }
    /// The in-progress step, else the first pending step — the "current" step.
    public var currentStep: RemoteTodoItem? {
        items.first { $0.isInProgress } ?? items.first { $0.status == "pending" }
    }
    public var completedCount: Int { items.filter { $0.isCompleted }.count }
    public var activeCount: Int { items.filter { !$0.isCancelled }.count }
}

public struct RemoteTaskCapabilities: Codable, Sendable, Hashable {
    public let monitor: Bool?
    public let approve: Bool?
    public let answer: Bool?
    public let cancel: Bool?
    public let startTurn: Bool?
    public let diffReview: Bool?
    public let steer: Bool?
    public let fileBrowse: Bool?
    public let fileRead: Bool?
    public let fileWrite: Bool?
    public let externalPublish: Bool?
}

/// Nested `result` inside a successful `bridge.ack` for action requests.
public struct BridgeActionAck: Codable, Sendable {
    public let accepted: Bool?
    public let message: String?
    public let executed: Bool?
    public let reasonCode: String?
    public let threadId: String?
    public let data: BridgeActionAckData?
}

public struct BridgeActionAckData: Codable, Sendable {
    public let threadId: String?
    public let chatKind: String?
    public let rowId: String?
    public let row: RemoteThreadSnapshot.Row?
    public let mediaId: String?
    public let media: TranscriptMediaFetchResult?
    public let thread: RemoteThreadSnapshot?
    public let entries: [WorkspaceFileEntry]?
    public let truncated: Bool?
    public let file: WorkspaceFileReadResult?
    public let path: String?
    public let changeSet: RawJSON?
    /// Bounded workspace diff (the `workspaceDiff` action's ack payload).
    public let diff: WorkspaceDiffResult?
    /// Compact git status (`gitSnapshot` / `gitStageAll` / `gitCommit` /
    /// `gitPush` acks all return the post-action snapshot).
    public let git: GitWorkspaceSnapshot?
    /// PR summary (`githubPrStatus` / `githubCreatePr` acks).
    public let pr: GitPullRequestSummary?
    /// PR readiness probe (`githubPrReadiness` ack).
    public let readiness: GitPrReadinessResult?
    /// QR-optional discovery (`discoverTailnetHosts` ack) — the OTHER TaskWraith
    /// hosts on the tailnet, with this host (self) already dropped Mac-side. The
    /// phone still dedupes its already-paired hosts on its side. Wire key `hosts`.
    public let hosts: [DiscoveredHostInfo]?
    /// The connected host's base64 raw X25519 push-agreement public key
    /// (`registerApnsToken` ack). Stored onto the connected host's paired record
    /// so the Notification Service Extension can derive the static shared secret
    /// to decrypt that host's rich pushes. Wire key `macAgreePub`.
    public let macAgreePub: String?
}

public struct TranscriptMediaFetchResult: Codable, Sendable, Hashable {
    public let id: String
    public let rowId: String?
    public let threadId: String?
    public let name: String?
    public let source: String?
    public let mimeType: String
    public let dataBase64: String
    public let width: Int?
    public let height: Int?
    public let byteLength: Int?
    public let variant: String?
    /// Range mode only (`threadMediaFetch` with `offset`/`length`): the full
    /// asset size, so the resource loader can fill AVFoundation's content-info
    /// and stop at the end. Absent for thumbnail/whole-asset fetches → nil
    /// (synthesized Codable stays backward-compatible).
    public let totalBytes: Int?
    /// Range mode only: the absolute byte offset of THIS slice within the asset
    /// (echoes the requested `offset`, server-clamped).
    public let offset: Int?
}

/// A discoverable TaskWraith host the phone can offer to pair with — the PUBLIC
/// subset of a pairing bootstrap. The per-session `sessionId` is NOT here: it's
/// minted on demand via the host's POST /v1/beginpair when the user taps to
/// pair (so a discovered host is never "always listening"). Trust is unchanged —
/// the 6-digit transcript SAS still gates the pairing on the target host.
public struct DiscoveredHostInfo: Codable, Sendable, Identifiable, Hashable {
    /// Raw-32B Ed25519 identity pubkey (base64) — the trust anchor the phone
    /// pins; also the stable id + dedupe key against already-paired hosts.
    public let macIdentityPubKey: String
    /// Friendly host label for the picker, when the host advertised one.
    public let macDisplayName: String?
    /// Phone-reachable relay URLs (LAN ws:// first, wss front door second).
    public let relayUrls: [String]
    /// Host OS for the per-OS glyph ("mac" | "windows" | "linux"), best-effort.
    public let hostPlatform: String?
    public var id: String { macIdentityPubKey }

    public init(
        macIdentityPubKey: String, macDisplayName: String?, relayUrls: [String],
        hostPlatform: String?
    ) {
        self.macIdentityPubKey = macIdentityPubKey
        self.macDisplayName = macDisplayName
        self.relayUrls = relayUrls
        self.hostPlatform = hostPlatform
    }
}

public struct WorkspaceFileEntry: Codable, Sendable, Identifiable, Hashable {
    public let path: String
    public let name: String
    public let isDirectory: Bool
    public let sizeBytes: Int?
    public let depth: Int
    public let hasChildren: Bool?
    public var id: String { path }
}

public struct WorkspaceFileReadResult: Codable, Sendable {
    public let path: String
    public let content: String
    public let sizeBytes: Int
    public let mtimeMs: Double?
    public let etag: String?
    public let changeSet: RawJSON?
}

/// Bounded workspace diff — the Mac's `BoundedWorkspaceDiff` projection of
/// the SAME git diff the desktop Diff Studio renders, hard-capped for the
/// relay frame budget (≤40 files, ≤200 hunk lines/file, 400-char lines).
public struct WorkspaceDiffResult: Codable, Sendable {
    public let files: [WorkspaceDiffFile]
    /// Non-noise changed files BEFORE the file cap — "showing 40 of N".
    public let totalFiles: Int?
    public let truncated: Bool?
}

public struct WorkspaceDiffFile: Codable, Sendable, Identifiable, Hashable {
    public let path: String
    /// created | modified | deleted
    public let kind: String
    public let status: String?
    public let additions: Int?
    public let deletions: Int?
    public let hunks: [WorkspaceDiffHunk]?
    public let previewKind: String?
    public let isBinary: Bool?
    public let isSensitive: Bool?
    public let canOpenInEditor: Bool?
    public let staged: Bool?
    public let unstaged: Bool?
    /// Hunk lines were dropped/clipped for this file (per-file cap).
    public let truncated: Bool?
    public var id: String { path }
    public var name: String { path.split(separator: "/").last.map(String.init) ?? path }
}

public struct WorkspaceDiffHunk: Codable, Sendable, Hashable {
    public let header: String
    public let lines: [WorkspaceDiffLine]
}

public struct WorkspaceDiffLine: Codable, Sendable, Hashable {
    /// ctx | add | del
    public let type: String
    public let text: String
    public let oldLine: Int?
    public let newLine: Int?
}

// ── Git workflow models (the `git*` / `github*` actions' ack payloads) ────

/// Compact git status for a workspace repo — the Mac's GitService snapshot
/// with a capped file list (the bridge compacts before the ack rides the
/// relay). All fields optional-decode so older Macs can't break the phone.
public struct GitWorkspaceSnapshot: Codable, Sendable {
    public let repoRoot: String?
    public let branch: String?
    public let commit: String?
    public let detached: Bool?
    public let upstream: String?
    public let remoteName: String?
    public let remoteUrl: String?
    public let ahead: Int?
    public let behind: Int?
    public let counts: GitChangeCounts?
    public let clean: Bool?
    /// merge | rebase | cherry-pick (nil for a normal tree).
    public let mergeState: String?
    public let conflicts: Int?
    public let lineStats: GitLineStats?
    public let files: [GitFileChange]?
    /// The Mac dropped files beyond its cap — "showing N of more".
    public let filesTruncated: Bool?
}

public struct GitChangeCounts: Codable, Sendable, Hashable {
    public let changed: Int?
    public let staged: Int?
    public let unstaged: Int?
    public let untracked: Int?
}

public struct GitLineStats: Codable, Sendable, Hashable {
    public let additions: Int?
    public let deletions: Int?
}

public struct GitFileChange: Codable, Sendable, Identifiable, Hashable {
    public let path: String
    /// created | modified | deleted | renamed | untracked | conflicted | ignored
    public let kind: String?
    public let staged: Bool?
    public let unstaged: Bool?
    public var id: String { path }
    public var name: String { path.split(separator: "/").last.map(String.init) ?? path }
}

/// `gh pr view` summary for the current branch (checks capped by the Mac).
public struct GitPullRequestSummary: Codable, Sendable {
    public let number: Int?
    public let url: String?
    public let state: String?
    public let isDraft: Bool?
    public let headRefName: String?
    public let baseRefName: String?
    public let checks: [GitPullRequestCheck]?
}

public struct GitPullRequestCheck: Codable, Sendable, Hashable {
    public let name: String?
    public let status: String?
    public let conclusion: String?
}

/// PR-readiness probe — whether "Create PR" may be offered and, when it
/// can't, the human-readable reason the UI must show instead.
public struct GitPrReadinessResult: Codable, Sendable {
    public let canCreatePullRequest: Bool
    public let shouldPushFirst: Bool
    public let reason: String?
    public let warnings: [String]?
    public let git: GitWorkspaceSnapshot?
    public let pr: GitPullRequestSummary?
}

public struct MobileApprovalCard: Codable, Sendable {
    public let toolCallId: String?
    public let title: String?
    /// Legacy field — the Mac never sent it (title+body are the text
    /// fields); kept so old snapshots decode.
    public let summary: String?
    /// The approval detail (command text / JSON params, sanitized ≤400).
    public let body: String?
    public let provider: String?
    public let requestedAt: String?
    public let expiresAt: String?
    public let status: String?
    /// Advertised decision actions from the Mac approval card. Render these
    /// dynamically; action sets vary by approval kind and policy surface.
    public let actions: [String]?
    public let workspaceId: String?
    public let workspacePath: String?
    public let threadId: String?
    public let runId: String?
}

public struct MobileQuestionCard: Codable, Sendable {
    /// Canonical id (the Mac projects promptId; questionId is a legacy
    /// alias kept for old snapshots).
    public let promptId: String?
    public let questionId: String?
    /// Canonical text field (prompt = legacy alias).
    public let question: String?
    public let prompt: String?
    public let options: [String]?
    public let context: String?
    public let createdAt: String?
    public let expiresAt: String?
    public let provider: String?
    public let workspaceId: String?
    public let threadId: String?
    public let runId: String?
    public let status: String?

    public var resolvedId: String? { promptId ?? questionId }
    public var stableId: String {
        resolvedId ?? "\(threadId ?? "question")-\(runId ?? "")-\(createdAt ?? "")-\(resolvedQuestion ?? "")"
    }
    public var resolvedQuestion: String? { question ?? prompt }
}

/// `ensembleState` projection payload — the live round/participant state
/// the desktop roster chips render from.
public struct RemoteEnsembleState: Codable, Sendable {
    public struct Participant: Codable, Sendable, Identifiable {
        public let participantId: String
        public let provider: String?
        public let role: String?
        public let order: Int?
        public let status: String?
        /// Optional model id. Older Mac builds omit it; iOS backfills it from
        /// the roster so Ollama transcript mentions can spoof upstream brands.
        public let model: String?
        public var id: String { participantId }
    }
    public let threadId: String?
    public let taskId: String?
    public let roundId: String?
    public let status: String?
    public let activeParticipantId: String?
    public let bossmanParticipantId: String?
    /// The user-designated Captain (second-in-command). Wire key
    /// `secondInCommandParticipantId` — MUST match the Mac projection exactly.
    /// Captain uses Boss-like controls only when the Boss is unavailable.
    public let secondInCommandParticipantId: String?
    /// Ensemble orchestration mode. Wire key `orchestrationMode`; values are
    /// `"turn_bound"` | `"continuous"` (UNDERSCORE — not "turn-bound"). Absent
    /// on older Mac builds ⇒ treat as turn_bound. NOTE: "Work Session" is a
    /// SEPARATE concept (see `workSessionStatus`), NOT a value of this field.
    public let orchestrationMode: String?
    /// Current inter-participant handoff count in the active round (continuous
    /// mode only). Wire key `continuationHops`.
    public let continuationHops: Int?
    /// Max handoff turns (hops) per round; only meaningful in continuous mode.
    /// Wire key `maxContinuationHops`. Mac clamps to [1, 500], default 6.
    public let maxContinuationHops: Int?
    /// Fan-out policy. Wire key `fanoutPolicy`; values are the EXACT four-value
    /// enum `"off"` | `"read_only"` | `"locked_writers_with_boss"` |
    /// `"locked_writers_user_preflight"` (NOT a boolean, NOT a bare "write").
    /// Absent on older Mac builds ⇒ treat as off. The two locked_writers_*
    /// values are WRITER fan-out and stay Boss-gated on the Mac.
    public let fanoutPolicy: String?
    /// Shared-transcript character budget. Wire key `ensembleContextChars`.
    /// Mac clamps to [5000, 500000]; desktop default is 24000.
    public let ensembleContextChars: Int?
    public let participants: [Participant]?
    /// The CONFIGURED (editable) roster — present even when idle.
    public let roster: [RosterEntry]?
    /// Prompts queued for injection between participant turns.
    public let queuedPromptCount: Int?
    /// Queued prompt texts in injection order (index addresses actions).
    public let queuedPrompts: [QueuedPrompt]?
    /// Work-session supervisor status (idle | running | paused | …), projected
    /// by the Mac but previously dropped on decode. Optional for old builds.
    public let workSessionStatus: String?

    /// Roster-order comparator: `order` ascending, then `participantId` tie-break.
    /// Nil `order` sorts last (matches WelcomeViews.sortedParticipants).
    public static func rosterOrder(
        _ lhs: Participant, _ rhs: Participant
    ) -> Bool {
        let leftOrder = lhs.order ?? Int.max
        let rightOrder = rhs.order ?? Int.max
        if leftOrder != rightOrder { return leftOrder < rightOrder }
        return lhs.participantId < rhs.participantId
    }

    /// Roster-entry comparator for configured roster rows (`id` tie-break).
    public static func rosterEntryOrder(
        _ lhs: RosterEntry, _ rhs: RosterEntry
    ) -> Bool {
        let leftOrder = lhs.order ?? Int.max
        let rightOrder = rhs.order ?? Int.max
        if leftOrder != rightOrder { return leftOrder < rightOrder }
        return lhs.id < rhs.id
    }

    /// Live participants enriched with any configured roster model ids so UI
    /// consumers can render brand-aware Ollama accents without rejoining.
    /// Sorted by roster slot (`order`, then `participantId`) so transcript,
    /// side-chat, and mention surfaces match the chip strip even when the wire
    /// round `participants` array arrives in speaking-queue order.
    public var displayParticipants: [Participant] {
        guard let participants else { return [] }
        let rosterModels: [String: String] = Dictionary(
            uniqueKeysWithValues: (roster ?? []).compactMap { entry in
                guard let model = entry.model?.trimmingCharacters(in: .whitespacesAndNewlines),
                    !model.isEmpty
                else { return nil }
                return (entry.id, model)
            })
        return participants.map { participant in
            let resolvedModel =
                participant.model?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
                ? participant.model
                : rosterModels[participant.participantId]
            return Participant(
                participantId: participant.participantId,
                provider: participant.provider,
                role: participant.role,
                order: participant.order,
                status: participant.status,
                model: resolvedModel)
        }
        .sorted(by: Self.rosterOrder)
    }

    public struct QueuedPrompt: Codable, Sendable, Identifiable {
        public let index: Int
        public let text: String
        public var id: Int { index }
    }

    public struct RosterEntry: Codable, Sendable, Identifiable {
        public let id: String
        public let provider: String
        public let role: String?
        public let enabled: Bool?
        public let order: Int?
        public let model: String?
        /// Honest current-context proxy for this participant (latest run's
        /// input+output). Divided by the per-model window on-device to draw the
        /// participant's context meter. Optional — absent ⇒ 0 / no run yet.
        public let contextTokens: Int?
        public let brief: String?
        /// Per-participant approval preset + reasoning (desktop parity). Optional
        /// so older Mac builds (which didn't project them) still decode.
        public let permissionPresetId: String?
        public let reasoningEffort: String?
        public let fastModeEnabled: Bool?
        public let thinkingEnabled: Bool?
        /// Staged fan-out stage ("scout" | "worker" | "reviewer") — spike 4.
        /// Optional so older Mac builds (which didn't project it) still decode.
        public let stageRole: String?
        public let isBossman: Bool?
        /// Per-participant Captain flag. Wire key `isSecondInCommand` — MUST
        /// match the Mac projection exactly (do NOT rename to `isCaptain`).
        public let isSecondInCommand: Bool?
        public init(
            id: String, provider: String, role: String?, enabled: Bool?,
            order: Int?, model: String?, brief: String?,
            permissionPresetId: String? = nil, reasoningEffort: String? = nil,
            fastModeEnabled: Bool? = nil, thinkingEnabled: Bool? = nil,
            stageRole: String? = nil,
            contextTokens: Int? = nil, isBossman: Bool? = nil,
            isSecondInCommand: Bool? = nil
        ) {
            self.id = id
            self.provider = provider
            self.role = role
            self.enabled = enabled
            self.order = order
            self.model = model
            self.brief = brief
            self.permissionPresetId = permissionPresetId
            self.reasoningEffort = reasoningEffort
            self.fastModeEnabled = fastModeEnabled
            self.thinkingEnabled = thinkingEnabled
            self.stageRole = stageRole
            self.contextTokens = contextTokens
            self.isBossman = isBossman
            self.isSecondInCommand = isSecondInCommand
        }
    }
}

/// `diffSummary` projection payload — run file changes for the inspector
/// diff tab + the above-composer changes row.
public struct MobileDiffSummary: Codable, Sendable {
    public struct File: Codable, Sendable, Identifiable {
        public let path: String
        public let status: String?
        public let additions: Int?
        public let deletions: Int?
        public let isBinary: Bool?
        public var id: String { path }
    }
    public let taskId: String?
    public let threadId: String?
    public let runId: String?
    public let filesChanged: Int?
    public let additions: Int?
    public let deletions: Int?
    public let createdFiles: Int?
    public let modifiedFiles: Int?
    public let deletedFiles: Int?
    public let files: [File]?
    public let truncated: Bool?
    /** Per-workspace breakdown (stats-only on the wire). */
    public let workspaces: [WorkspaceBreakdown]?

    public struct WorkspaceBreakdown: Codable, Sendable, Identifiable {
        public let workspaceId: String?
        public let workspacePath: String
        public let filesChanged: Int?
        public let additions: Int?
        public let deletions: Int?
        public var id: String { workspacePath }
    }
}

public struct RemoteThreadSnapshot: Codable, Sendable {
    public struct Row: Codable, Sendable, Equatable, Identifiable {
        public let id: String
        /// Run that produced this row — lets the live streaming bubble
        /// supersede the in-flight snapshot row without duplication.
        public let runId: String?
        /// Ensemble round this row belongs to, when present.
        public let ensembleRoundId: String?
        public let role: String?
        public let kind: String?
        /// Ensemble participant identity, mirroring the desktop transcript
        /// tag minus the #pN handle: "Provider / Role (Model)". Absent for
        /// solo chats and user rows.
        public let speaker: String?
        /// Frozen pooled-Agent display identity for this row, when present.
        public let pooledAgentIdentity: PooledAgentIdentity?
        public struct PooledAgentIdentity: Codable, Sendable, Equatable {
            public let schemaVersion: Int?
            public let agentId: String?
            public let nickname: String?
            public let iconKind: String?
            public let hue: Int?
            public let accent: String?
            public let slug: String?
            public let assetKey: String?
            public let seed: String?
            /// When false, render the identity icon monochrome (ignore accent).
            /// Absent (nil) ⇒ tinted, preserving pre-toggle behaviour.
            public let hueEnabled: Bool?
        }
        /// Images attached to this message (desktop or phone) — chip count.
        public let imageAttachmentCount: Int?
        /// Downscaled base64 JPEG previews of the attached images, shipped by
        /// the Mac so the phone can render the actual image inline (it can't
        /// read the Mac-local file paths behind `imageAttachmentCount`). Absent
        /// for historical rows persisted before this existed.
        public let imageThumbnails: [ImageThumbnail]?
        public struct ImageThumbnail: Codable, Sendable, Hashable, Identifiable {
            public let dataBase64: String
            public let mimeType: String?
            public let width: Int?
            public let height: Int?
            /// Stable-enough identity for ForEach within one row (base64 prefix).
            public var id: String { String(dataBase64.prefix(32)) }
        }
        /// First-class transcript media. Additive to legacy image thumbnails so
        /// older Mac/iOS pairs keep working while agent/tool media gains a
        /// structured surface.
        public let media: [Media]?
        public struct Media: Codable, Sendable, Hashable, Identifiable {
            public let id: String
            public let kind: String
            public let format: String?
            public let source: String?
            public let name: String
            public let alt: String?
            public let caption: String?
            public let mimeType: String?
            public let width: Int?
            public let height: Int?
            public let byteLength: Int?
            /// Duration in ms for audio/video refs — drives the mm:ss tile label.
            public let durationMs: Int?
            /// Codec descriptor for AV refs (informational).
            public let codecs: String?
            public let status: String?
            public let thumbnail: ImageThumbnail?
        }
        /// Bounded one-screen preview of the row body (Mac-side sanitized).
        public let preview: String?
        public let truncated: Bool?
        /// ISO delivery moment of the underlying message (Mac transcript
        /// timestamp) — surfaced in the long-press context menu.
        public let timestamp: String?
        public struct ToolSummary: Codable, Sendable, Equatable {
            public let activityCount: Int?
            public let status: String?
            /// Per-tool detail (desktop activity-card parity).
            public let tools: [ToolEntry]?
        }
        public struct ToolEntry: Codable, Sendable, Equatable, Identifiable {
            public let name: String
            public let toolName: String?
            public let category: String?
            public let status: String?
            public let file: String?
            public let additions: Int?
            public let deletions: Int?
            public let detail: String?
            public var id: String { name + (file ?? "") + (detail ?? "") }
            public init(
                name: String, category: String?, status: String?, file: String?,
                additions: Int?, deletions: Int?, detail: String?,
                toolName: String? = nil
            ) {
                self.name = name
                self.toolName = toolName
                self.category = category
                self.status = status
                self.file = file
                self.additions = additions
                self.deletions = deletions
                self.detail = detail
            }
        }
        public let toolSummary: ToolSummary?
        /// Bounded thinking/reasoning trace (dedicated wire field, capped
        /// host-side at REMOTE_IOS_THINKING_MAX≈4000; full text rides the
        /// existing expandRow path when `truncated`). Absent on older Macs
        /// and rows without thinking — renderers must treat as optional.
        public struct Thinking: Codable, Sendable, Equatable {
            public let title: String?
            public let preview: String?
            public let truncated: Bool?
            public let toolName: String?
            public let status: String?
        }
        public let thinking: Thinking?
        /// Structured ensemble participant reachability summary. Older Mac
        /// builds only send `preview`, so renderers must treat this as
        /// optional.
        public struct ParticipantHealth: Codable, Sendable, Equatable {
            public let okCount: Int?
            public let totalCount: Int?
            public let entries: [Entry]?

            public struct Entry: Codable, Sendable, Equatable, Identifiable {
                public let participantId: String?
                public let provider: String?
                /// Model id — lets the chip spoof the Ollama display brand
                /// (Qwen → Alibaba). Optional so older Mac builds still decode.
                public let model: String?
                /// Frozen provider/brand label stamped when the round health card
                /// was written — must not be recomputed from the live roster.
                public let displayProviderLabel: String?
                /// Frozen hue class stamped when the round health card was written.
                public let displayHueClass: String?
                public let role: String?
                public let status: String?
                public let reason: String?
                public let underlyingCode: String?
                public var id: String {
                    participantId ?? "\(provider ?? "provider")-\(role ?? "role")"
                }

                /// Provider key for `TWTheme.providerAccent`/`providerLabel` —
                /// prefers the frozen stamp; falls back to model-based brand match.
                public var brandProviderKey: String {
                    if let displayHueClass = displayHueClass?.trimmingCharacters(
                        in: .whitespacesAndNewlines),
                        !displayHueClass.isEmpty
                    {
                        return displayHueClass
                    }
                    return OllamaDisplayBrands.providerHueClass(provider: provider, modelId: model)
                }
            }
        }
        public let participantHealth: ParticipantHealth?
        /// Structured metadata for returned TaskWraith sub-thread output. The
        /// row `preview` carries the extracted child-agent body.
        public struct SubThreadReturn: Codable, Sendable, Equatable {
            public let subThreadId: String?
            public let provider: String?
            public let title: String?
        }
        public let subThreadReturn: SubThreadReturn?
        /// Structured Codex-style proposed-plan card — the desktop
        /// ProposedPlanCard's persisted state, projected so the phone renders
        /// the same inline collapsible plan card and can round-trip the
        /// decision. Field names match the Mac projection 1:1 (title /
        /// bodyPreview / status / bodyTruncated); `status` is an optional
        /// String (never a non-optional enum) so an unexpected value from a
        /// newer Mac degrades to read-only rather than failing decode.
        public struct ProposedPlan: Codable, Sendable, Equatable {
            public let title: String?
            public let bodyPreview: String?
            public let status: String?
            public let artifactPath: String?
            public let bodyTruncated: Bool?
        }
        public let proposedPlan: ProposedPlan?
        /// ask_user_question prompt anchored to this (asking) row — drives the
        /// inline question card. `promptId` === the registry questionId, so the
        /// inline card resolves the same parked tool the top banner does.
        /// Additive optional + synthesized Codable ⇒ forward/back-compatible.
        public struct AgentQuestion: Codable, Sendable, Equatable {
            public let promptId: String?
            public let question: String?
            public let options: [String]?
            public let context: String?
        }
        public let agentQuestion: AgentQuestion?
    }
    public struct RunSummary: Codable, Sendable {
        public let runId: String?
        /// Ensemble round this participant run belongs to, when present.
        public let ensembleRoundId: String?
        public let ensembleParticipantId: String?
        public let ensembleRole: String?
        public let ensembleOrder: Int?
        public let provider: String?
        public let model: String?
        public let status: String?
        public let startedAt: String?
        public let endedAt: String?
        public let durationMs: Int?
        public let totalTokens: Int?
        public let tokensIn: Int?
        public let tokensOut: Int?
        public let costText: String?
        /// Per-run file-change detail (run.runDiff projection) — powers the
        /// File-changes block on every Task-complete card, not just the
        /// latest run's diffSummary envelope.
        public let fileChanges: FileChanges?

        public struct FileChanges: Codable, Sendable {
            public let filesChanged: Int?
            public let additions: Int?
            public let deletions: Int?
            public let createdFiles: Int?
            public let modifiedFiles: Int?
            public let deletedFiles: Int?
            /// Bounded (≤12) per-file rows; overflow = filesChanged - files.count.
            public let files: [ChangedFile]?

            public struct ChangedFile: Codable, Sendable, Identifiable {
                public let path: String
                public let status: String?
                public let additions: Int?
                public let deletions: Int?
                public var id: String { path }
            }
        }
    }
    public struct BlackboardEntry: Codable, Sendable, Identifiable {
        public let id: String
        public let key: String
        public let value: String
        public let category: String
        public let scope: String
        public let participantId: String?
        public let roundId: String?
        public let createdAt: String?
    }
    public let threadId: String?
    public let taskId: String?
    public let workspaceId: String?
    public let provider: String?
    public let rows: [Row]?
    public let totalRows: Int?
    public let runSummary: RunSummary?
    public let conversationCostUsd: Double?
    public let conversationCostText: String?
    public let showRunCompleteSummary: Bool?
    /// Thread notes (markdown, clipped Mac-side).
    public let notes: String?
    /// Pinned messages — may fall outside the latestN row window.
    public let pinnedRows: [Row]?
    /// Structured shared notes (currently Ensemble blackboard entries).
    public let blackboardEntries: [BlackboardEntry]?
    /// Per-run summaries (oldest→newest) — Task-complete card data.
    public let runSummaries: [RunSummary]?
    public let windowStartIndex: Int?
    public let hasMoreAbove: Bool?
    public let hasMoreBelow: Bool?

    public init(
        threadId: String? = nil,
        taskId: String? = nil,
        workspaceId: String? = nil,
        provider: String? = nil,
        rows: [Row]? = nil,
        totalRows: Int? = nil,
        runSummary: RunSummary? = nil,
        conversationCostUsd: Double? = nil,
        conversationCostText: String? = nil,
        showRunCompleteSummary: Bool? = nil,
        notes: String? = nil,
        pinnedRows: [Row]? = nil,
        blackboardEntries: [BlackboardEntry]? = nil,
        runSummaries: [RunSummary]? = nil,
        windowStartIndex: Int? = nil,
        hasMoreAbove: Bool? = nil,
        hasMoreBelow: Bool? = nil
    ) {
        self.threadId = threadId
        self.taskId = taskId
        self.workspaceId = workspaceId
        self.provider = provider
        self.rows = rows
        self.totalRows = totalRows
        self.runSummary = runSummary
        self.conversationCostUsd = conversationCostUsd
        self.conversationCostText = conversationCostText
        self.showRunCompleteSummary = showRunCompleteSummary
        self.notes = notes
        self.pinnedRows = pinnedRows
        self.blackboardEntries = blackboardEntries
        self.runSummaries = runSummaries
        self.windowStartIndex = windowStartIndex
        self.hasMoreAbove = hasMoreAbove
        self.hasMoreBelow = hasMoreBelow
    }
}

// ── Actions (iPhone → Mac) ────────────────────────────────────────────────────
//
// Encoded as the base64 payload inside `bridge.requestActionAck`. Helpers build
// the routable params dict the runtime/BridgeActionRouter expect:
//   { pairID?, payloadBytes, payloadBase64 }  (pairID is overwritten Mac-side).

public enum BridgeAction {
    /// Approve/deny an approval card.
    public static func approvalReply(
        toolCallId: String, decision: String, workspaceId: String, threadId: String,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        encode([
            "kind": "approvalReply", "actionId": actionId, "toolCallId": toolCallId,
            "decision": decision, "workspaceId": workspaceId, "threadId": threadId,
        ])
    }

    /// Answer an agent question.
    public static func questionReply(
        questionId: String, answer: String, workspaceId: String, threadId: String,
        runId: String? = nil,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        var payload: [String: Any] = [
            // The Mac validator requires `promptId` (questionId was never
            // accepted — replies were silently rejected). Send both keys;
            // extra keys are ignored by the validator.
            "kind": "questionReply", "actionId": actionId, "promptId": questionId,
            "questionId": questionId,
            "answer": answer, "workspaceId": workspaceId, "threadId": threadId,
        ]
        if let runId, !runId.isEmpty {
            payload["runId"] = runId
        }
        return encode(payload)
    }

    /// Ship the APNs device token to the Mac (pairID is overwritten
    /// Mac-side with the authenticated transport identity). `agreePub` is this
    /// device's base64 raw X25519 push-agreement public key — the Mac stores it
    /// to seal per-device rich-push blobs; the ack returns the Mac's own
    /// `macAgreePub` for the reverse direction.
    public static func registerApnsToken(
        deviceToken: String, env: String,
        agreePub: String? = nil,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        var payload: [String: Any] = [
            "kind": "registerApnsToken", "actionId": actionId,
            "pairID": "transport", "deviceToken": deviceToken, "env": env,
        ]
        if let agreePub, !agreePub.isEmpty {
            payload["agreePub"] = agreePub
        }
        return encode(payload)
    }

    /// Ask the connected host (the "oracle") to enumerate the tailnet and report
    /// its OTHER TaskWraith machines. Read-only and param-less — the host derives
    /// everything (own identity, paired devices, stored OAuth credential). The
    /// discovered hosts come back in the action ack's `hosts` field.
    public static func discoverTailnetHosts(
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        encode([
            "kind": "discoverTailnetHosts", "actionId": actionId,
        ])
    }

    /// Slice 1/2 (RC1/RC2): client-initiated targeted full-projection resync. The
    /// phone fires this on foreground / notification alive-wake so it can pull the
    /// current home projection itself, rather than depending on a Mac push it may
    /// have missed while suspended. Read-only + pair-scoped; the host re-pushes the
    /// snapshot UNICAST to this device. A FRESH `actionId` per call keeps a bounded
    /// retry from being replay-dropped by the Mac.
    public static func fullProjectionResync(
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        encode([
            "kind": "fullProjectionResync", "actionId": actionId,
        ])
    }

    /// Tell the connected host which thread the phone is watching for
    /// `bridge.runEvent` interest filtering (B2). Pair-scoped, read-only.
    /// `nil` appChatId means home/background/non-thread surface.
    public static func setWatchedThread(
        appChatId: String?, actionId: String = UUID().uuidString
    ) -> [String: Any] {
        var payload: [String: Any] = [
            "kind": "setWatchedThread", "actionId": actionId,
        ]
        if let appChatId {
            payload["appChatId"] = appChatId
        } else {
            payload["appChatId"] = NSNull()
        }
        return encode(payload)
    }

    /// Dismiss an agent question (resolves the parked tool as cancelled).
    public static func questionReject(
        promptId: String, workspaceId: String, threadId: String,
        runId: String? = nil,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        var payload: [String: Any] = [
            "kind": "questionReject", "actionId": actionId, "promptId": promptId,
            "workspaceId": workspaceId, "threadId": threadId,
        ]
        if let runId, !runId.isEmpty {
            payload["runId"] = runId
        }
        return encode(payload)
    }

    /// Mark a Codex-style proposed plan 'dismissed' (metadata.proposedPlan.status)
    /// — the Respond/Dismiss path. APPROVE does NOT use this action: it flips
    /// status to 'approved' ATOMICALLY with the implement run inside the Mac's
    /// composerPromptFn (via composerPrompt's proposedPlanImplementOf marker), so
    /// there is no 'status flips with no run' channel. `decision` is therefore
    /// only ever "dismissed"; `messageId` is the transcript row id (row.id) the
    /// Mac executor uses to locate the plan (it re-reads its OWN canonical plan,
    /// never a phone-sent body). The Mac validator rejects any other decision.
    public static func proposedPlanDecision(
        workspaceId: String, threadId: String, messageId: String, decision: String,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        encode([
            "kind": "proposedPlanDecision", "actionId": actionId,
            "workspaceId": workspaceId, "threadId": threadId,
            "messageId": messageId, "decision": decision,
        ])
    }

    /// Phone close/reload of an open Canvas preview (P3). `action` is "close" or
    /// "reload"; the Mac owns the canvas by chatId (== threadId).
    public static func canvasAction(
        workspaceId: String, threadId: String, canvasId: String, action: String,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        encode([
            "kind": "canvasAction", "actionId": actionId,
            "workspaceId": workspaceId, "threadId": threadId,
            "canvasId": canvasId, "action": action,
        ])
    }

    /// Cancel a running agent.
    public static func cancelRun(
        provider: String, runId: String, workspaceId: String, threadId: String,
        message: String? = nil, actionId: String = UUID().uuidString
    ) -> [String: Any] {
        var payload: [String: Any] = [
            "kind": "cancelRun", "actionId": actionId, "provider": provider, "runId": runId,
            "workspaceId": workspaceId, "threadId": threadId,
        ]
        if let message { payload["message"] = message }
        return encode(payload)
    }

    /// Cancel an Ensemble ROUND (not just one participant run): the Mac sets
    /// `runtime.cancelled` so the continuation loop halts and every active
    /// participant is cancelled by its true provider. `roundId` is optional —
    /// omit it to cancel whatever round is active.
    public static func ensembleCancelRound(
        workspaceId: String, threadId: String,
        roundId: String? = nil, message: String? = nil, actionId: String = UUID().uuidString
    ) -> [String: Any] {
        var payload: [String: Any] = [
            "kind": "ensembleCancelRound", "actionId": actionId,
            "workspaceId": workspaceId, "threadId": threadId,
        ]
        if let roundId { payload["roundId"] = roundId }
        if let message { payload["message"] = message }
        return encode(payload)
    }

    /// Start a new agent run in an allowlisted workspace. A FRESH `threadId`
    /// (e.g. "ios-<uuid>") starts a new chat; an existing one continues it.
    /// The Mac enforces the allowlist (workspace, provider, approval mode)
    /// and the run appears live in the desktop transcript too.
    /// Map the composer's single `fastModeEnabled` toggle + `kimiThinkingEnabled`
    /// onto the provider-specific wire keys the Mac reads (cursorFastMode /
    /// claudeFastMode / codexServiceTier='fast' / kimiThinkingEnabled). Grok is
    /// permanently Fast (implicit Mac-side) so it sends nothing.
    private static func applyFastAndThinking(
        _ payload: inout [String: Any], provider: String,
        fastModeEnabled: Bool, kimiThinkingEnabled: Bool?
    ) {
        switch provider.lowercased() {
        case "cursor": payload["cursorFastMode"] = fastModeEnabled
        case "claude": payload["claudeFastMode"] = fastModeEnabled
        case "codex": if fastModeEnabled { payload["codexServiceTier"] = "fast" }
        default: break
        }
        if provider.lowercased() == "kimi", let kimiThinkingEnabled {
            payload["kimiThinkingEnabled"] = kimiThinkingEnabled
        }
    }

    public static func composerPrompt(
        workspaceId: String, threadId: String, provider: String, text: String,
        approvalMode: String? = nil, workflowMode: String? = nil,
        permissionPresetId: String? = nil,
        model: String? = nil, extraWorkspaceIds: [String]? = nil,
        reasoningEffort: String? = nil, imageAttachments: [[String: Any]]? = nil,
        proposedPlanImplementOf: String? = nil,
        fastModeEnabled: Bool = false, kimiThinkingEnabled: Bool? = nil,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        var payload: [String: Any] = [
            "kind": "composerPrompt", "actionId": actionId, "workspaceId": workspaceId,
            "threadId": threadId, "provider": provider, "text": text,
        ]
        if let approvalMode { payload["approvalMode"] = approvalMode }
        if let workflowMode { payload["workflowMode"] = workflowMode }
        if let permissionPresetId { payload["permissionPresetId"] = permissionPresetId }
        if let model { payload["model"] = model }
        if let reasoningEffort, !reasoningEffort.isEmpty {
            if provider.lowercased() == "claude" {
                payload["claudeReasoningEffort"] = reasoningEffort
            } else {
                payload["reasoningEffort"] = reasoningEffort
            }
        }
        if let extraWorkspaceIds, !extraWorkspaceIds.isEmpty {
            payload["extraWorkspaceIds"] = extraWorkspaceIds
        }
        if let imageAttachments, !imageAttachments.isEmpty {
            payload["imageAttachments"] = imageAttachments
        }
        if let proposedPlanImplementOf {
            payload["proposedPlanImplementOf"] = proposedPlanImplementOf
        }
        applyFastAndThinking(
            &payload, provider: provider,
            fastModeEnabled: fastModeEnabled, kimiThinkingEnabled: kimiThinkingEnabled)
        return encode(payload)
    }

    public static func composerQueuePrompt(
        workspaceId: String, threadId: String, provider: String, text: String,
        approvalMode: String? = nil, workflowMode: String? = nil,
        permissionPresetId: String? = nil,
        model: String? = nil, extraWorkspaceIds: [String]? = nil,
        reasoningEffort: String? = nil,
        fastModeEnabled: Bool = false, kimiThinkingEnabled: Bool? = nil,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        var payload: [String: Any] = [
            "kind": "composerQueuePrompt", "actionId": actionId, "workspaceId": workspaceId,
            "threadId": threadId, "provider": provider, "text": text,
        ]
        if let approvalMode { payload["approvalMode"] = approvalMode }
        if let workflowMode { payload["workflowMode"] = workflowMode }
        if let permissionPresetId { payload["permissionPresetId"] = permissionPresetId }
        if let model { payload["model"] = model }
        if let reasoningEffort, !reasoningEffort.isEmpty {
            if provider.lowercased() == "claude" {
                payload["claudeReasoningEffort"] = reasoningEffort
            } else {
                payload["reasoningEffort"] = reasoningEffort
            }
        }
        if let extraWorkspaceIds, !extraWorkspaceIds.isEmpty {
            payload["extraWorkspaceIds"] = extraWorkspaceIds
        }
        applyFastAndThinking(
            &payload, provider: provider,
            fastModeEnabled: fastModeEnabled, kimiThinkingEnabled: kimiThinkingEnabled)
        return encode(payload)
    }

    public static func composerSchedulePrompt(
        workspaceId: String, threadId: String, provider: String, text: String,
        scheduledRunAt: String,
        approvalMode: String? = nil, workflowMode: String? = nil,
        permissionPresetId: String? = nil,
        model: String? = nil, extraWorkspaceIds: [String]? = nil,
        reasoningEffort: String? = nil,
        fastModeEnabled: Bool = false, kimiThinkingEnabled: Bool? = nil,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        var payload: [String: Any] = [
            "kind": "composerSchedulePrompt", "actionId": actionId, "workspaceId": workspaceId,
            "threadId": threadId, "provider": provider, "text": text,
            "scheduledRunAt": scheduledRunAt,
        ]
        if let approvalMode { payload["approvalMode"] = approvalMode }
        if let workflowMode { payload["workflowMode"] = workflowMode }
        if let permissionPresetId { payload["permissionPresetId"] = permissionPresetId }
        if let model { payload["model"] = model }
        if let reasoningEffort, !reasoningEffort.isEmpty {
            if provider.lowercased() == "claude" {
                payload["claudeReasoningEffort"] = reasoningEffort
            } else {
                payload["reasoningEffort"] = reasoningEffort
            }
        }
        if let extraWorkspaceIds, !extraWorkspaceIds.isEmpty {
            payload["extraWorkspaceIds"] = extraWorkspaceIds
        }
        applyFastAndThinking(
            &payload, provider: provider,
            fastModeEnabled: fastModeEnabled, kimiThinkingEnabled: kimiThinkingEnabled)
        return encode(payload)
    }

    public static func composerQueueItem(
        workspaceId: String, threadId: String, queueId: String, textPrefix: String?,
        op: String, actionId: String = UUID().uuidString
    ) -> [String: Any] {
        var payload: [String: Any] = [
            "kind": "composerQueueItem", "actionId": actionId, "workspaceId": workspaceId,
            "threadId": threadId, "queueId": queueId, "op": op,
        ]
        if let textPrefix, !textPrefix.isEmpty {
            payload["textPrefix"] = String(textPrefix.prefix(120))
        }
        return encode(payload)
    }

    /// Queue a user turn on an ensemble chat (requires `steer` capability).
    /// Steer the ensemble: starts a round when idle, injects steering when
    /// one is active. This is the correct send primitive for phone prompts —
    /// ensembleQueuePrompt only queues WORK-SESSION continuations and
    /// silently no-ops on an idle panel.
    /// Replace the ensemble's configured roster. Array order is the
    /// speaking order; entries with a known id update in place (the Mac
    /// preserves runtime/permission fields), new entries are minted from
    /// same-provider seeds, omission removes.
    public static func setThreadNotes(
        workspaceId: String, threadId: String, notes: String,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        encode([
            "kind": "setThreadNotes", "actionId": actionId,
            "workspaceId": workspaceId, "threadId": threadId, "notes": notes,
        ])
    }

    public static func setThreadTitle(
        workspaceId: String, threadId: String, title: String,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        encode([
            "kind": "setThreadTitle", "actionId": actionId,
            "workspaceId": workspaceId, "threadId": threadId, "title": title,
        ])
    }

    public static func goalUpdate(
        workspaceId: String, threadId: String, op: String,
        objective: String? = nil, reason: String? = nil,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        var payload: [String: Any] = [
            "kind": "goalUpdate", "actionId": actionId,
            "workspaceId": workspaceId, "threadId": threadId, "op": op,
        ]
        if let objective, !objective.isEmpty { payload["objective"] = objective }
        if let reason, !reason.isEmpty { payload["reason"] = reason }
        return encode(payload)
    }

    public static func toggleMessagePin(
        workspaceId: String, threadId: String, messageId: String, pinned: Bool,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        encode([
            "kind": "toggleMessagePin", "actionId": actionId,
            "workspaceId": workspaceId, "threadId": threadId,
            "messageId": messageId, "pinned": pinned,
        ])
    }

    /// Pin or unpin a whole chat (home-list lifecycle; host action key is
    /// `appChatId`, NOT `threadId` — matches BridgeActionPayload.togglePinChat).
    public static func togglePinChat(
        workspaceId: String, appChatId: String, pinned: Bool,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        encode([
            "kind": "togglePinChat", "actionId": actionId,
            "workspaceId": workspaceId, "appChatId": appChatId, "pinned": pinned,
        ])
    }

    /// Archive or unarchive a chat. Reversible + non-destructive — gates on the
    /// existing `pin` capability host-side (ios-lifecycle-capability-ruling).
    public static func setChatArchived(
        workspaceId: String, appChatId: String, archived: Bool,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        encode([
            "kind": "setChatArchived", "actionId": actionId,
            "workspaceId": workspaceId, "appChatId": appChatId, "archived": archived,
        ])
    }

    /// Read-only full-transcript fetch — thin adapter over the Mac's existing
    /// markdown-transcript builder (byte-identical desktop format, paths
    /// scrubbed). Success ack data: { appChatId, markdown, messageCount,
    /// charCount, omissions }. Gates on `monitor` capability.
    public static func chatMarkdownTranscript(
        workspaceId: String, appChatId: String,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        encode([
            "kind": "chatMarkdownTranscript", "actionId": actionId,
            "workspaceId": workspaceId, "appChatId": appChatId,
        ])
    }

    public static func createSideChat(
        workspaceId: String, threadId: String, provider: String?, model: String? = nil,
        reasoningEffort: String? = nil,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        var payload: [String: Any] = [
            "kind": "createSideChat", "actionId": actionId,
            "workspaceId": workspaceId, "threadId": threadId,
        ]
        if let provider, !provider.isEmpty { payload["provider"] = provider }
        if let model, !model.isEmpty { payload["model"] = model }
        if let reasoningEffort, !reasoningEffort.isEmpty {
            if provider?.lowercased() == "claude" {
                payload["claudeReasoningEffort"] = reasoningEffort
            } else {
                payload["codexReasoningEffort"] = reasoningEffort
            }
        }
        return encode(payload)
    }

    /// Steer-now or remove one queued prompt (combined-order index).
    public static func ensembleQueueItem(
        workspaceId: String, threadId: String, index: Int, textPrefix: String?,
        op: String, actionId: String = UUID().uuidString
    ) -> [String: Any] {
        var payload: [String: Any] = [
            "kind": "ensembleQueueItem", "actionId": actionId,
            "workspaceId": workspaceId, "threadId": threadId,
            "index": index, "op": op,
        ]
        if let textPrefix, !textPrefix.isEmpty {
            payload["textPrefix"] = String(textPrefix.prefix(120))
        }
        return encode(payload)
    }

    public static func ensembleRosterUpdate(
        workspaceId: String, threadId: String, participants: [[String: Any]],
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        encode([
            "kind": "ensembleRosterUpdate", "actionId": actionId,
            "workspaceId": workspaceId, "threadId": threadId,
            "participants": participants,
        ])
    }

    public static func ensembleSettingsUpdate(
        workspaceId: String, threadId: String,
        orchestrationMode: String? = nil,
        maxContinuationHops: Int? = nil,
        fanoutPolicy: String? = nil,
        ensembleContextChars: Int? = nil,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        var payload: [String: Any] = [
            "kind": "ensembleSettingsUpdate", "actionId": actionId,
            "workspaceId": workspaceId, "threadId": threadId,
        ]
        if orchestrationMode == "turn_bound" || orchestrationMode == "continuous" {
            payload["orchestrationMode"] = orchestrationMode
        }
        if let maxContinuationHops {
            payload["maxContinuationHops"] = max(1, min(500, maxContinuationHops))
        }
        if fanoutPolicy == "off" || fanoutPolicy == "read_only"
            || fanoutPolicy == "locked_writers_with_boss"
            || fanoutPolicy == "locked_writers_user_preflight"
        {
            payload["fanoutPolicy"] = fanoutPolicy
        }
        if let ensembleContextChars {
            payload["ensembleContextChars"] = max(5_000, min(500_000, ensembleContextChars))
        }
        return encode(payload)
    }

    /// In-place mid-thread ensemble toggle — mirrors desktop `setChatKind` IPC.
    public static func setChatKind(
        workspaceId: String, threadId: String, targetKind: String,
        seedParticipant: [String: Any]? = nil,
        canonicalProvider: String? = nil,
        canonicalProviderMetadata: [String: Any]? = nil,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        var payload: [String: Any] = [
            "kind": "setChatKind", "actionId": actionId,
            "workspaceId": workspaceId, "threadId": threadId,
            "targetKind": targetKind,
        ]
        if let seedParticipant { payload["seedParticipant"] = seedParticipant }
        if let canonicalProvider { payload["canonicalProvider"] = canonicalProvider }
        if let canonicalProviderMetadata {
            payload["canonicalProviderMetadata"] = canonicalProviderMetadata
        }
        return encode(payload)
    }

    /// Save the current roster as a named preset (GLOBAL; the host forwards it
    /// to the renderer's localStorage store, which re-syncs to all devices).
    public static func ensemblePresetSave(
        name: String, participants: [[String: Any]], actionId: String = UUID().uuidString
    ) -> [String: Any] {
        encode([
            "kind": "ensemblePresetMutate", "actionId": actionId,
            "op": "save", "name": name, "participants": participants,
        ])
    }

    /// Delete a roster preset by id (GLOBAL).
    public static func ensemblePresetDelete(
        presetId: String, actionId: String = UUID().uuidString
    ) -> [String: Any] {
        encode([
            "kind": "ensemblePresetMutate", "actionId": actionId,
            "op": "delete", "presetId": presetId,
        ])
    }

    public static func ensembleSteer(
        workspaceId: String, threadId: String, text: String,
        imageAttachments: [[String: Any]]? = nil,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        var payload: [String: Any] = [
            "kind": "ensembleSteer", "actionId": actionId,
            "workspaceId": workspaceId, "threadId": threadId, "text": text,
        ]
        if let imageAttachments, !imageAttachments.isEmpty {
            payload["imageAttachments"] = imageAttachments
        }
        return encode(payload)
    }

    public static func ensembleQueuePrompt(
        workspaceId: String, threadId: String, text: String, roundId: String? = nil,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        var payload: [String: Any] = [
            "kind": "ensembleQueuePrompt", "actionId": actionId,
            "workspaceId": workspaceId, "threadId": threadId, "text": text,
        ]
        if let roundId { payload["roundId"] = roundId }
        return encode(payload)
    }

    /// Create an empty chat (workspace solo, ensemble, or global) without
    /// starting a run.
    public static func createThread(
        workspaceId: String, variant: String, threadId: String? = nil,
        provider: String? = nil, title: String? = nil,
        participants: [[String: Any]]? = nil,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        var payload: [String: Any] = [
            "kind": "createThread", "actionId": actionId,
            "workspaceId": workspaceId, "variant": variant,
        ]
        if let threadId { payload["threadId"] = threadId }
        if let provider { payload["provider"] = provider }
        if let title { payload["title"] = title }
        if let participants, !participants.isEmpty {
            payload["participants"] = participants
        }
        return encode(payload)
    }

    /// Fetch a longer preview for one clipped transcript row.
    public static func threadRowExpand(
        workspaceId: String, threadId: String, rowId: String, maxChars: Int = 32000,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        encode([
            "kind": "threadRowExpand", "actionId": actionId,
            "workspaceId": workspaceId, "threadId": threadId, "rowId": rowId,
            "maxChars": maxChars,
        ])
    }

    /// Fetch bounded bytes for one transcript media item. The Mac validates the
    /// media id against the requested thread + row before returning bytes.
    ///
    /// `offset`/`length` opt into range mode: when BOTH are supplied the Mac
    /// returns a byte slice `{ dataBase64, byteLength, offset, totalBytes }`
    /// (each slice hard-clamped to 448 KiB server-side) so AVFoundation can pull
    /// a large asset in chunks via an AVAssetResourceLoaderDelegate. The keys
    /// are emitted only when both are present so an unranged fetch encodes
    /// byte-identically to before.
    public static func threadMediaFetch(
        workspaceId: String, threadId: String, rowId: String, mediaId: String,
        variant: String = "thumbnail", maxBytes: Int = 512000,
        actionId: String = UUID().uuidString,
        offset: Int? = nil, length: Int? = nil
    ) -> [String: Any] {
        var payload: [String: Any] = [
            "kind": "threadMediaFetch", "actionId": actionId,
            "workspaceId": workspaceId, "threadId": threadId, "rowId": rowId,
            "mediaId": mediaId, "variant": variant, "maxBytes": maxBytes,
        ]
        if let offset, let length {
            payload["offset"] = offset
            payload["length"] = length
        }
        return encode(payload)
    }

    /// Request a bounded transcript window for one thread. Read-only
    /// (capability `monitor`); the snapshot is returned in the ACK payload
    /// and may also arrive as a broadcast projection.
    public static func threadSnapshotRequest(
        workspaceId: String, threadId: String, limit: Int = 40, beforeRowId: String? = nil,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        var payload: [String: Any] = [
            "kind": "threadSnapshotRequest", "actionId": actionId,
            "workspaceId": workspaceId, "threadId": threadId, "limit": limit,
        ]
        if let beforeRowId { payload["beforeRowId"] = beforeRowId }
        return encode(payload)
    }

    public static func workspaceFileList(
        workspaceId: String, path: String? = nil, query: String? = nil, limit: Int? = nil,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        var payload: [String: Any] = [
            "kind": "workspaceFileList", "actionId": actionId,
            "workspaceId": workspaceId,
        ]
        if let path { payload["path"] = path }
        if let query { payload["query"] = query }
        if let limit { payload["limit"] = limit }
        return encode(payload)
    }

    public static func workspaceFileRead(
        workspaceId: String, path: String,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        encode([
            "kind": "workspaceFileRead", "actionId": actionId,
            "workspaceId": workspaceId, "path": path,
        ])
    }

    public static func workspaceFileWrite(
        workspaceId: String, path: String, content: String, baseEtag: String,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        encode([
            "kind": "workspaceFileWrite", "actionId": actionId,
            "workspaceId": workspaceId, "path": path,
            "content": content, "baseEtag": baseEtag,
        ])
    }

    public static func workspaceFileDelete(
        workspaceId: String, path: String, baseEtag: String,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        encode([
            "kind": "workspaceFileDelete", "actionId": actionId,
            "workspaceId": workspaceId, "path": path,
            "baseEtag": baseEtag,
        ])
    }

    public static func workspaceDiff(
        workspaceId: String,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        encode([
            "kind": "workspaceDiff", "actionId": actionId,
            "workspaceId": workspaceId,
        ])
    }

    public static func gitSnapshot(
        workspaceId: String,
        actionId: String = UUID().uuidString,
        publish: Bool = true
    ) -> [String: Any] {
        encode([
            "kind": "gitSnapshot", "actionId": actionId,
            "workspaceId": workspaceId, "publish": publish,
        ])
    }

    public static func gitStageAll(
        workspaceId: String,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        encode([
            "kind": "gitStageAll", "actionId": actionId,
            "workspaceId": workspaceId,
        ])
    }

    public static func gitStagePaths(
        workspaceId: String, paths: [String],
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        encode([
            "kind": "gitStagePaths", "actionId": actionId,
            "workspaceId": workspaceId, "paths": paths,
        ])
    }

    public static func gitUnstagePaths(
        workspaceId: String, paths: [String],
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        encode([
            "kind": "gitUnstagePaths", "actionId": actionId,
            "workspaceId": workspaceId, "paths": paths,
        ])
    }

    /// `message` must be user-entered text from an explicit commit field —
    /// never synthesized from agent output. `stageAll` folds "Stage all &
    /// Commit" into one round-trip.
    public static func gitCommit(
        workspaceId: String, message: String, stageAll: Bool = false,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        encode([
            "kind": "gitCommit", "actionId": actionId,
            "workspaceId": workspaceId, "message": message,
            "stageAll": stageAll,
        ])
    }

    public static func gitPush(
        workspaceId: String, setUpstream: Bool = false,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        encode([
            "kind": "gitPush", "actionId": actionId,
            "workspaceId": workspaceId, "setUpstream": setUpstream,
        ])
    }

    public static func githubPrStatus(
        workspaceId: String,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        encode([
            "kind": "githubPrStatus", "actionId": actionId,
            "workspaceId": workspaceId,
        ])
    }

    public static func githubPrReadiness(
        workspaceId: String,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        encode([
            "kind": "githubPrReadiness", "actionId": actionId,
            "workspaceId": workspaceId,
        ])
    }

    public static func githubCreatePr(
        workspaceId: String, title: String? = nil, body: String? = nil, draft: Bool = false,
        actionId: String = UUID().uuidString
    ) -> [String: Any] {
        var payload: [String: Any] = [
            "kind": "githubCreatePr", "actionId": actionId,
            "workspaceId": workspaceId, "draft": draft,
        ]
        if let title, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            payload["title"] = title
        }
        if let body, !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            payload["body"] = body
        }
        return encode(payload)
    }

    /// Wrap a typed action payload as the `bridge.requestActionAck` params.
    private static func encode(_ payload: [String: Any]) -> [String: Any] {
        // Replay/expiry stamps (security review: the Mac REQUIRES actionId +
        // expiresAt on mutating actions). One place for every action: each
        // helper already mints an actionId; issuedAt/expiresAt land here so
        // a forgotten helper can't ship an unguarded mutation. 120s expiry —
        // generous for relay latency, short enough to bound replay windows.
        var stamped = payload
        let nowMs = Int(Date().timeIntervalSince1970 * 1000)
        if stamped["issuedAt"] == nil { stamped["issuedAt"] = nowMs }
        if stamped["expiresAt"] == nil { stamped["expiresAt"] = nowMs + 120_000 }
        let data = (try? JSONSerialization.data(withJSONObject: stamped)) ?? Data()
        return ["payloadBase64": data.base64EncodedString(), "payloadBytes": data.count]
    }
}

// ── Transport error copy — NSURLError walls → actionable guidance ──────────

/// Maps relay connection failures to copy a human can act on. The raw
/// `String(describing:)` of an NSURLError is a wall of UserInfo keys (the
/// exact screenshot users send when pairing fails); this keeps the precise
/// failure but leads with what to DO about it. Pure + unit-tested.
public enum TransportErrorCopy {
    /// `relayUrl` gives host-aware guidance (Tailscale vs LAN front doors).
    public static func friendlyMessage(for error: Error, relayUrl: String?) -> String {
        let ns = error as NSError
        guard ns.domain == NSURLErrorDomain else {
            return (error as? LocalizedError)?.errorDescription ?? ns.localizedDescription
        }
        let host = relayUrl.flatMap { URL(string: $0)?.host } ?? "your Mac"
        let isTailnet = host.hasSuffix(".ts.net")
        switch ns.code {
        case NSURLErrorCannotConnectToHost:
            if isTailnet {
                return "Couldn't connect to your Mac's Tailscale address (\(host)). "
                    + "Check Tailscale is ON and connected on THIS device, and that the Mac shows "
                    + "Settings → Devices → Remote access via Tailscale as enabled with TaskWraith running. "
                    + "Then refresh the QR and try again."
            }
            return "Couldn't connect to \(host) — TaskWraith isn't reachable there. "
                + "Check TaskWraith is running on your Mac and this device is on the same network."
        case NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed:
            if isTailnet {
                return "Couldn't find \(host) — this device can't resolve your tailnet name. "
                    + "Turn Tailscale ON on this device (it provides the DNS for *.ts.net), then retry."
            }
            return "Couldn't find \(host) on this network — check Wi-Fi and that the pairing code is current."
        case NSURLErrorTimedOut:
            return "Connection to \(host) timed out. "
                + (isTailnet
                    ? "Check Tailscale is connected on both this device and the Mac, and that the Mac is awake."
                    : "Check the Mac is awake, TaskWraith is running, and both devices share a network.")
        case NSURLErrorSecureConnectionFailed, NSURLErrorServerCertificateUntrusted,
            NSURLErrorServerCertificateHasBadDate:
            return "Secure connection to \(host) failed (\(ns.code)). "
                + "The Mac's Tailscale HTTPS certificate may need refreshing — toggle "
                + "Remote access via Tailscale off and on in the Mac's Settings → Devices."
        case NSURLErrorNotConnectedToInternet, NSURLErrorNetworkConnectionLost:
            return "No network connection — check Wi-Fi or cellular on this device, then retry."
        case NSURLErrorBadServerResponse:
            // -1011: the WebSocket upgrade got a non-101 reply — classically a 502
            // from `tailscale serve` when the relay behind its front door is dead
            // (or the relay refused the upgrade). The door is up; the relay is not.
            if isTailnet {
                return "\(host) answered, but TaskWraith's relay behind it didn't (a 502 error). "
                    + "Open TaskWraith on the Mac and make sure it's running with "
                    + "Settings → Devices → Remote access via Tailscale enabled, then refresh the QR and retry."
            }
            return "\(host) answered, but TaskWraith's relay there didn't complete the connection. "
                + "Make sure TaskWraith is running on the Mac, then refresh the pairing code and retry."
        default:
            return ns.localizedDescription
        }
    }
}

// ── RawJSON — hold an arbitrary JSON value losslessly inside a Codable type ────

public struct RawJSON: Codable, Sendable {
    /// Canonical JSON bytes of the held value.
    public let data: Data

    public init(data: Data) { self.data = data }

    public init(from decoder: Decoder) throws {
        // Decode into a Foundation JSON value, then re-serialize to bytes. Goes
        // through AnyCodableValue so JSONDecoder (which has no "any JSON" type)
        // can walk arbitrary structure; the bytes are what decodePayload reads.
        let value = try AnyCodableValue(from: decoder)
        data =
            (try? JSONSerialization.data(
                withJSONObject: value.foundationObject, options: [.fragmentsAllowed]))
            ?? Data("null".utf8)
    }

    public func encode(to encoder: Encoder) throws {
        let object = (try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]))
        try AnyCodableValue(foundationObject: object as Any).encode(to: encoder)
    }
}

/// Minimal any-JSON Codable bridge used only to ferry RawJSON through
/// JSONDecoder/Encoder (which have no native "arbitrary JSON" type).
enum AnyCodableValue: Codable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([AnyCodableValue])
    case object([String: AnyCodableValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Int.self) { self = .int(v) }
        else if let v = try? c.decode(Double.self) { self = .double(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([AnyCodableValue].self) { self = .array(v) }
        else if let v = try? c.decode([String: AnyCodableValue].self) { self = .object(v) }
        else { self = .null }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .int(let v): try c.encode(v)
        case .double(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }

    var foundationObject: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let v): return v
        case .int(let v): return v
        case .double(let v): return v
        case .string(let v): return v
        case .array(let v): return v.map { $0.foundationObject }
        case .object(let v): return v.mapValues { $0.foundationObject }
        }
    }

    init(foundationObject: Any) {
        switch foundationObject {
        case is NSNull: self = .null
        case let v as Bool where type(of: foundationObject) == type(of: NSNumber(value: true)):
            self = .bool(v)
        case let v as Int: self = .int(v)
        case let v as Double: self = .double(v)
        case let v as String: self = .string(v)
        case let v as [Any]: self = .array(v.map { AnyCodableValue(foundationObject: $0) })
        case let v as [String: Any]:
            self = .object(v.mapValues { AnyCodableValue(foundationObject: $0) })
        default: self = .null
        }
    }
}
