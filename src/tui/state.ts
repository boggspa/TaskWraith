import {
  createEmptyHostSnapshot,
  type HostCommandName,
  type HostParticipantProjection,
  type HostSnapshot
} from '../shared/hostProtocol'
import type { HostHistoryCursor } from '../shared/hostHistoryProtocol'
import type { HostWorkspaceGitReadOutcome } from '../host-client/HostProjectionClient'
import type {
  HostProviderAuthFlowProjection,
  HostProviderAuthStatusProjection,
  HostProviderOffersProjection,
  HostProviderStatusProjection
} from '../shared/hostSetupProtocol'
import type {
  TaskWraithControlProviderPresentation,
  TaskWraithControlSnapshot,
  TaskWraithControlThread,
  TaskWraithControlThreadOffers,
  TaskWraithControlThreadSnapshot,
  TaskWraithControlTranscriptRow
} from '../shared/taskWraithControlProtocol'
import { resolveTaskWraithProviderPresentation } from '../shared/taskWraithProviderPresentation'
import type { ColdStartFlowState, ColdStartPendingCommand } from './coldStartFlow'

export type TuiConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'offline'
  | 'incompatible-protocol'
  | 'demo'
  | 'replay'
export type TuiOverlay =
  | 'none'
  | 'context'
  | 'threads'
  | 'missions'
  | 'help'
  | 'tune'
  | 'setup'
  | 'git'
  | 'seats'
  | 'workspaces'
  | 'goal'
  | 'theme'
  | 'login'
export type TuiMissionFilter = 'active' | 'history' | 'all'
/** The three workspace-git read scopes the Host serves (no show, no blame). */
export type TuiGitScope = 'status' | 'diff' | 'log'
/** First-run Host setup traps until ready; `/new`/`/provider` can be cancelled. */
export type TuiColdStartIntent = 'required' | 'new-thread'

export interface TuiNotice {
  text: string
  tone: 'neutral' | 'good' | 'warning' | 'error'
  expiresAt?: number
}

/** A staged model/reasoning choice. Rides the NEXT composer.send; the host
 * validates it against its own offers and remains the authority. */
export interface TuiPendingSelection {
  model: string
  label?: string
  reasoningEffort?: string
}

export type TuiQueuedDraftPhase = 'queued' | 'dispatching' | 'blocked'

/** One immutable user draft, bound to the thread and tuning choice it was authored for. */
export interface TuiQueuedDraft {
  id: string
  threadId: string
  text: string
  enqueuedAt: number
  phase: TuiQueuedDraftPhase
  selection?: TuiPendingSelection
  /** Exact live run observed when the draft joined the queue. */
  blockedByRunId?: string
  error?: string
}

export interface TuiHomeTuneProvider {
  status: HostProviderStatusProjection
  offers: HostProviderOffersProjection
}

/** Home-frame model defaults. These are preferences, never configure authority. */
export interface TuiHomeTuneState {
  loading?: boolean
  error?: string
  providers: TuiHomeTuneProvider[]
  /** Provider owning the selected flattened model row (derived, not a second menu). */
  providerIndex: number
  /** Index into the one combined cross-provider model list. */
  modelIndex: number
  /** -1 means the provider's own default; non-negative indexes an offered row. */
  reasoningIndex: number
}

/**
 * Explicit in-session permission choice for the next thread created from Home.
 * It is intentionally not persisted: selecting an elevated tier is live human
 * consent for this TUI session, not a reusable authorization claim.
 */
export interface TuiHomePermissionSelection {
  providerId: string
  postureId: string
}

/** Dismissible provider setup hub. It never advances into thread creation. */
export interface TuiProviderLoginState {
  providers: HostProviderStatusProjection[]
  selectedProviderId?: string
  authStatus?: HostProviderAuthStatusProjection
  flows: HostProviderAuthFlowProjection[]
  flowIndex: number
  loading?: boolean
  error?: string
  operationId?: string
  pending?: ColdStartPendingCommand
}

/**
 * In-flight Host mutation (Wave 4.2b). Pending means Host is waiting on an
 * approval ask — never treat as completed.
 */
export interface TuiPendingHostMutation {
  commandId: string
  name: HostCommandName
  /** HostApprovalProjection.approvalId when a matching pending ask is known. */
  approvalId?: string
  /** Composer text to restore if the Host denies/fails the send. */
  composerRestore?: string
}

/** Bounded transcript history fetched from the Host, separate from preview rows. */
export interface TuiHistoryState {
  readonly threadId: string
  readonly generation: number
  readonly cursor: number
  readonly nextBefore?: HostHistoryCursor
  readonly previewOnly: boolean
  readonly loadingOlder?: boolean
}

/**
 * The /git overlay's current read. `outcome` is the client's first-class
 * union: `available: false` is a calm configuration state, never an error.
 * `error` is set only when the request genuinely failed (disconnect, Host
 * error) — a distinct render path from capability-unavailable.
 */
export interface TuiGitState {
  scope: TuiGitScope
  path?: string
  loading?: boolean
  outcome?: HostWorkspaceGitReadOutcome
  error?: string
}

/**
 * The /seats lens state. The roster itself is NEVER stored here — it always
 * renders from the coherent Host projection (`hostProjection.participants`),
 * so a live delta or the post-toggle refresh is the single source of truth
 * and an optimistic flip is impossible. This state only keys the lens to the
 * thread it was opened for and carries the async-read and toggle outcomes:
 * `unavailable` is a calm capability state (the Host does not advertise
 * 'ensemble'), `error` a genuine read failure, `actionError` the Host's
 * typed toggle refusal in plain language — three distinct render paths.
 */
export interface TuiSeatsState {
  /** The thread the lens was opened for; toggles target this thread only. */
  threadId: string
  loading?: boolean
  unavailable?: string
  error?: string
  actionError?: string
}

/**
 * The lens roster: the thread's participants from the coherent projection,
 * in roster order. Shared by the renderer and the key handler so both act on
 * the same rows.
 */
export function tuiSeatsRoster(state: TaskWraithTuiState): HostParticipantProjection[] {
  const seats = state.seats
  if (!seats) return []
  return (state.hostProjection?.participants ?? [])
    .filter((participant) => participant.threadId === seats.threadId)
    .sort((left, right) => left.order - right.order)
}

export interface TaskWraithTuiState {
  connection: TuiConnectionState
  hostVersion?: string
  snapshot?: TaskWraithControlSnapshot
  /** Coherent Host projection cache used by mission/history presentation. */
  hostProjection?: HostSnapshot
  thread?: TaskWraithControlThreadSnapshot
  selectedThreadId?: string
  /** A thread born from this Home canvas keeps the landed hero above its transcript. */
  homeContinuationThreadId?: string
  input: string
  inputCursor: number
  overlay: TuiOverlay
  overlayIndex: number
  /** Palette-only filter text. Manual Ctrl+P keeps the composer draft separate. */
  commandPaletteQuery?: string
  /**
   * The committed theme name, which may be `auto`. Distinct from the theme the
   * frame is currently painted in: the `/theme` picker previews by repainting,
   * so during a preview those two deliberately disagree, and this is the one
   * the picker marks as current and the one that gets persisted.
   */
  themeName?: string
  /** Mission lens filter. Missing on older injected fixtures means active. */
  missionFilter?: TuiMissionFilter
  /** First participant row shown in the selected mission cast. */
  missionParticipantOffset?: number
  scrollOffset: number
  animationFrame: number
  notice?: TuiNotice
  /** Host-projected model/reasoning offers for the tune lens (solo threads). */
  offers?: TaskWraithControlThreadOffers
  offersLoading?: boolean
  /** Reasoning column index for the highlighted tune-lens model row. */
  tuneEffortIndex: number
  pendingSelection?: TuiPendingSelection
  /** In-session per-thread FIFO. The Host remains authoritative for run state. */
  queuedDrafts?: TuiQueuedDraft[]
  /** Home-frame provider/model/reasoning preference picker. */
  homeTune?: TuiHomeTuneState
  /** Shift+Tab choice applied to the next lazy-created Home thread. */
  homePermission?: TuiHomePermissionSelection
  /** Provider authentication/setup hub. */
  providerLogin?: TuiProviderLoginState
  /** Active deferred Host mutation, if any. */
  pendingHostMutation?: TuiPendingHostMutation
  /** Guided setup state shown before the Host has a configured conversation. */
  coldStart?: ColdStartFlowState
  /** First-run setup traps until ready; `/new` is Esc-cancellable. */
  coldStartIntent?: TuiColdStartIntent
  /** Available setup providers; an explicit index is always user-controlled. */
  coldStartProviderChoices?: readonly HostProviderStatusProjection[]
  coldStartProviderIndex?: number
  coldStartAuthFlowIndex?: number
  coldStartModelIndex?: number
  coldStartReasoningIndex?: number
  coldStartPostureIndex?: number
  /** Full Host history, when the negotiated capability is available. */
  history?: TuiHistoryState
  /** The /git overlay's current workspace-git read. */
  git?: TuiGitState
  /** The /seats lens state (ensemble seat control on the selected thread). */
  seats?: TuiSeatsState
  /**
   * Whether the /threads picker reveals archived chats. Off by default: the
   * picker is for switching, and an archived chat cannot be selected.
   */
  showArchivedThreads?: boolean
  /**
   * Last successful workspace target. Explicit /workspace choices, registration,
   * and opening an existing thread all update where the next fresh thread lands.
   */
  activeWorkspaceId?: string
}

/**
 * Rows the /threads picker shows. Archived chats appear only when explicitly
 * revealed, and the picker, its key handling and its renderer all read this one
 * rule so a revealed row can never be at a different index in two of them.
 */
export function visibleThreadRows(state: TaskWraithTuiState): readonly TaskWraithControlThread[] {
  const threads = state.snapshot?.threads ?? []
  return state.showArchivedThreads ? threads : threads.filter((thread) => !thread.archived)
}

function row(
  id: string,
  role: TaskWraithControlTranscriptRow['role'],
  speaker: string,
  text: string,
  provider?: TaskWraithControlProviderPresentation
): TaskWraithControlTranscriptRow {
  return {
    id,
    role,
    kind: role,
    speaker,
    ...(provider ? { provider } : {}),
    text,
    timestamp: new Date(0).toISOString(),
    truncated: false
  }
}

export function createTaskWraithTuiDemoState(now = Date.now()): TaskWraithTuiState {
  const claude = resolveTaskWraithProviderPresentation('claude', 'claude-opus-4-8-1m')
  const codex = resolveTaskWraithProviderPresentation('codex', 'gpt-5.6')
  const grok = resolveTaskWraithProviderPresentation('grok', 'grok-4.6')
  const kimi = resolveTaskWraithProviderPresentation('kimi', 'kimi-k3')
  const startedAt = now - 2_000
  const thread = {
    id: 'demo-thread',
    workspaceId: 'demo-workspace',
    title: 'TaskWraith TUI',
    provider: {
      ...claude,
      modelLabel: 'Opus 4.8 1M'
    },
    reasoning: 'Ultracode',
    status: 'working' as const,
    chatKind: 'single' as const,
    archived: false,
    pinned: false,
    updatedAt: now,
    messageCount: 2,
    wallTimeMs: now - startedAt,
    tokenEstimate: 386,
    costText: '£0.19'
  }
  const rows = [
    row(
      'demo-user',
      'user',
      'You',
      'Keep the composer compact and let provider identity carry the chroma.'
    ),
    {
      ...row(
        'demo-claude',
        'assistant',
        'Claude',
        'I’ll keep the transcript plain and stage the next model from the tune lens.',
        claude
      ),
      tools: [
        {
          name: 'Read TaskWraithControlProtocol.ts',
          category: 'read' as const,
          status: 'success' as const
        },
        {
          name: 'Build the compact tune lens',
          category: 'task' as const,
          status: 'running' as const
        }
      ]
    }
  ]
  const snapshot: TaskWraithControlSnapshot = {
    generatedAt: new Date(now).toISOString(),
    sequence: 1,
    workspaces: [
      {
        id: 'demo-workspace',
        name: 'AGBench',
        path: '/Users/chrisizatt/Documents/AGBench-tw-tui',
        pinned: true,
        updatedAt: now
      },
      {
        id: 'demo-secondary',
        name: 'design-system',
        path: '/Users/chrisizatt/Documents/design-system',
        pinned: false,
        updatedAt: now - 60_000
      }
    ],
    threads: [thread]
  }
  const threadSnapshot: TaskWraithControlThreadSnapshot = {
    generatedAt: new Date(now).toISOString(),
    sequence: 1,
    thread,
    rows,
    totalRows: rows.length,
    hasMoreAbove: false,
    context: {
      workspaces: [
        {
          id: 'demo-workspace',
          name: 'AGBench',
          path: '/Users/chrisizatt/Documents/AGBench-tw-tui',
          access: 'write',
          primary: true
        },
        {
          id: 'demo-secondary',
          name: 'design-system',
          path: '/Users/chrisizatt/Documents/design-system',
          access: 'write',
          primary: false
        }
      ],
      provider: {
        ...claude,
        modelLabel: 'Opus 4.8 1M'
      },
      reasoning: 'Ultracode',
      permission: 'workspace_write',
      wallTimeMs: now - startedAt,
      tokenEstimate: 386,
      costText: '£0.19'
    }
  }
  const hostProjection = createEmptyHostSnapshot({
    generation: 1,
    cursor: 7,
    freshness: 'live',
    generatedAt: new Date(now).toISOString()
  })
  hostProjection.workspaces = snapshot.workspaces.map((workspace) => ({ ...workspace }))
  hostProjection.providers = [claude, codex, grok, kimi].map((provider) => ({
    providerId: provider.runtimeProvider,
    displayProvider: provider.displayProvider,
    shortCode: provider.shortCode,
    hueKey: provider.hueKey,
    available: true
  }))
  hostProjection.threads = [
    {
      id: thread.id,
      workspaceId: thread.workspaceId,
      title: thread.title,
      chatKind: thread.chatKind,
      archived: thread.archived,
      pinned: thread.pinned,
      updatedAt: thread.updatedAt,
      messageCount: thread.messageCount,
      latestPreview: rows.at(-1)?.text,
      providerId: 'claude',
      missionOutcome: 'active',
      activeRoundId: 'demo-round'
    }
  ]
  hostProjection.missions = [
    {
      missionId: 'demo-mission',
      threadId: thread.id,
      title: 'Complete the TaskWraith TUI',
      status: 'active',
      goalId: 'demo-goal',
      updatedAt: now,
      activeRoundId: 'demo-round'
    },
    {
      missionId: 'demo-history',
      threadId: thread.id,
      title: 'Prove Host protocol foundations',
      status: 'completed',
      updatedAt: now - 86_400_000
    }
  ]
  hostProjection.rounds = [
    {
      roundId: 'demo-round',
      threadId: thread.id,
      status: 'running',
      startedAt,
      participantIds: [],
      providerRunIds: []
    }
  ]
  hostProjection.questions = [
    {
      questionId: 'demo-question',
      threadId: thread.id,
      status: 'answered',
      promptPreview: 'Keep the compact mission layout?',
      askedAt: startedAt,
      answeredAt: now,
      receiptId: '11111111-1111-4111-8111-111111111111'
    }
  ]
  return {
    connection: 'demo',
    hostVersion: '1.8.9',
    snapshot,
    hostProjection,
    thread: threadSnapshot,
    selectedThreadId: thread.id,
    input: '',
    inputCursor: 0,
    overlay: 'none',
    overlayIndex: 0,
    missionFilter: 'active',
    missionParticipantOffset: 0,
    scrollOffset: 0,
    animationFrame: 0,
    tuneEffortIndex: 0,
    queuedDrafts: []
  }
}
