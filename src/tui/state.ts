import {
  createEmptyHostSnapshot,
  type HostCommandName,
  type HostSnapshot
} from '../shared/hostProtocol'
import type { HostHistoryCursor } from '../shared/hostHistoryProtocol'
import type { HostProviderStatusProjection } from '../shared/hostSetupProtocol'
import type {
  TaskWraithControlProviderPresentation,
  TaskWraithControlSnapshot,
  TaskWraithControlThreadOffers,
  TaskWraithControlThreadSnapshot,
  TaskWraithControlTranscriptRow
} from '../shared/taskWraithControlProtocol'
import { resolveTaskWraithProviderPresentation } from '../shared/taskWraithProviderPresentation'
import type { ColdStartFlowState } from './coldStartFlow'

export type TuiConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'offline'
  | 'incompatible-protocol'
  | 'demo'
  | 'replay'
export type TuiOverlay = 'none' | 'context' | 'threads' | 'missions' | 'help' | 'tune' | 'setup'
export type TuiMissionFilter = 'active' | 'history' | 'all'
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

export interface TaskWraithTuiState {
  connection: TuiConnectionState
  hostVersion?: string
  snapshot?: TaskWraithControlSnapshot
  /** Coherent Host projection cache used by mission/history presentation. */
  hostProjection?: HostSnapshot
  thread?: TaskWraithControlThreadSnapshot
  selectedThreadId?: string
  input: string
  inputCursor: number
  overlay: TuiOverlay
  overlayIndex: number
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
    tuneEffortIndex: 0
  }
}
