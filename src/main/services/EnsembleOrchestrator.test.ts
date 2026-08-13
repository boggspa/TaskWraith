import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EnsembleOrchestrator,
  parseSelfReflectivePrefix,
  resolveYieldTargetIndex,
  type EnsembleOrchestratorDeps,
  type ParticipantProbeResult,
  clampAwaitTimeoutSeconds
} from './EnsembleOrchestrator'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { DiscordContextSnapshot } from '../channels/DiscordContextService'
import type {
  ActiveGoal,
  AppSettings,
  ChatMessage,
  ChatRecord,
  ChatRun,
  EnsembleConfig,
  EnsembleParticipant,
  EnsembleParticipantStatus,
  EnsembleWakeupRecord,
  EffectiveRunPermissions,
  ExternalPathGrant,
  ProviderId,
  RunQueueJobStatus,
  TranscriptMediaRef,
  UsageRecord
} from '../store/types'
import type { RunPermissionPostureContext } from '../RunPermissionPosture'
import { MAX_ENSEMBLE_PARTICIPANTS } from '../EnsembleRosterMutation'
import { isSeatRosterPayload } from '../../shared/seatChange'
import {
  buildEnsembleDynamicStateSnapshot,
  computeEnsemblePromptShellStamp
} from '../EnsemblePrompt'
import {
  CONTEXT_AUTO_COMPACT_COOLDOWN_MS,
  type ContextCompactionProgressEvent
} from '../../shared/contextCompaction'
import type { ParticipantWorkingTelemetryEvent } from '../../shared/participantWorkingTelemetry'
import { TASKWRAITH_CONTEXT_USAGE_KEY, withContextUsageSnapshot } from '../../shared/contextUsage'
import type { EnsembleRosterPreset } from '../../shared/EnsembleRosterPresetContract'
import { KIMI_ACP_PRODUCTION_POSTURE_VERSION } from '../../shared/kimiAcpPosture'
import type { EnsembleYieldOutcome } from '../EnsembleYieldRouting'

function expectYielded(outcome: EnsembleYieldOutcome): void {
  expect(outcome.kind).toBe('yielded')
}

const ensemble: EnsembleConfig = {
  enabled: true,
  maxParticipants: 4,
  participants: [
    {
      id: 'claude',
      provider: 'claude',
      enabled: true,
      role: 'Reviewer',
      instructions: 'Review.',
      order: 1,
      model: 'claude-model',
      permissionPresetId: 'read_only'
    },
    {
      id: 'codex',
      provider: 'codex',
      enabled: true,
      role: 'Worker',
      instructions: 'Work.',
      order: 2,
      model: 'codex-model',
      permissionPresetId: 'workspace_write'
    }
  ]
}

function makeChat(): ChatRecord {
  // Deep-clone the ensemble fixture per call. The previous shape
  // returned the module-level `ensemble` reference, so tests that
  // mutated `harness.chat.ensemble!.participants` leaked state into
  // subsequent tests' default fixture. Slice C's 3-participant
  // yield-target test surfaces this; the clone keeps every test
  // independent.
  return {
    appChatId: 'ensemble-chat',
    chatKind: 'ensemble',
    scope: 'workspace',
    provider: 'claude',
    title: 'New Ensemble',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ensemble: { ...ensemble, participants: ensemble.participants.map((p) => ({ ...p })) }
  }
}

function buildActiveGoal(id: string): ActiveGoal {
  return {
    id,
    objective: `Objective ${id}`,
    status: 'active',
    mode: 'taskwraith_steered',
    provider: 'claude',
    createdAt: '2026-05-24T00:00:00.000Z',
    updatedAt: '2026-05-24T00:00:00.000Z'
  }
}

function externalGrant(
  provider: ExternalPathGrant['provider'],
  path: string,
  overrides: Partial<ExternalPathGrant> = {}
): ExternalPathGrant {
  return {
    id: `${provider}-${path}`,
    provider,
    path,
    kind: 'file',
    access: 'read',
    duration: 'thisRun',
    issuedBy: 'main',
    signature: 'signed',
    createdAt: '2026-05-24T00:00:00.000Z',
    ...overrides
  }
}

function makeSettings(): AppSettings {
  return {
    storeLocalChatHistory: true,
    storeRawEvents: true,
    storePromptResponseInUsage: false,
    ensembleModeEnabled: true,
    geminiCheckpointingEnabled: false,
    chatContextTurns: 8,
    currency: 'USD',
    kimiSanitiserEnabled: false,
    kimiSanitiserCustomKeywords: '',
    appearanceMode: 'solid',
    visualEffectStyle: 'classic',
    themeAppearance: 'system',
    themeCornerStyle: 'rounded',
    themeAccentStyle: 'system',
    toolIconAccent: 'system',
    userBubbleColor: 'system',
    appIconVariant: 'regular',
    promptSurfaceStyle: 'theme',
    composerStyle: 'default',
    funFxEnabled: false,
    funFxMode: 'off',
    advancedFx: {
      agentAura: false,
      livingWorkspace: false,
      dataViz: false,
      refraction: false,
      intensity: 'subtle'
    },
    reduceTransparency: false,
    reduceMotion: false,
    compactDensity: false,
    liveActivityViewport: true,
    showInspector: true,
    inspectorWidth: 320,
    sidebarWidth: 300,
    sidebarOpacity: 100,
    mainPaneOpacity: 100,
    agenticServices: {
      shellCommands: 'ask',
      fileChanges: 'ask',
      mcpTools: 'ask',
      subThreadDelegation: 'ask',
      canvasInteraction: 'ask',
      canvasEval: 'ask',
      networkAccess: 'allow'
    },
    agenticWorkspaceGrants: [],
    autoResumeParentOnSubThreadCompletion: true,
    geminiMcpBridgeEnabled: true,
    bridgeDaemonEnabled: false,
    codexSandboxFallback: 'ask_rerun',
    updateChannel: 'stable',
    approvalTimeouts: {
      enabled: true,
      perProviderMs: {
        gemini: 120000,
        codex: 30000,
        claude: 120000,
        kimi: 60000,
        grok: 120000,
        cursor: 120000,
        ollama: 120000,
        antigravity: 120000,
        pi: 120000,
        mistral: 120000,
        muse: 120000
      },
      mainAuthorityMs: 120000
    }
  }
}

function makeDiscordSnapshot(content = 'CI failed on linux.'): DiscordContextSnapshot {
  return {
    metadata: {
      kind: 'discordContextRead',
      guildId: '100000000000000001',
      guildName: 'Workspace Guild',
      channelId: '200000000000000002',
      channelName: 'build-help',
      limit: 25,
      messageCount: 1,
      fetchedAt: '2026-06-16T13:00:00.000Z',
      firstTimestamp: '2026-06-16T12:59:00.000Z',
      lastTimestamp: '2026-06-16T12:59:00.000Z',
      retention: 'run',
      truncated: false,
      previewMessages: [
        {
          authorName: 'alice',
          contentPreview: content,
          timestamp: '2026-06-16T12:59:00.000Z'
        }
      ]
    },
    messages: [
      {
        id: '300000000000000003',
        authorName: 'alice',
        content,
        timestamp: '2026-06-16T12:59:00.000Z',
        attachmentCount: 0,
        attachments: []
      }
    ]
  }
}

function makeHarness(
  options: {
    initialChat?: ChatRecord
    dispatch?: EnsembleOrchestratorDeps['dispatch']
    beforeSaveChat?: (chat: ChatRecord) => void
    allocateFanoutLaneWorktree?: EnsembleOrchestratorDeps['allocateFanoutLaneWorktree']
    settleFanoutLaneWorktree?: EnsembleOrchestratorDeps['settleFanoutLaneWorktree']
    getProviderRunTransportLiveness?: EnsembleOrchestratorDeps['getProviderRunTransportLiveness']
    hasPendingProviderRunApprovals?: EnsembleOrchestratorDeps['hasPendingProviderRunApprovals']
    cancelRun?: (provider: EnsembleParticipant['provider'], runId?: string) => Promise<boolean>
    terminateRunForHistory?: EnsembleOrchestratorDeps['terminateRunForHistory']
    resolveExternalSeats?: EnsembleOrchestratorDeps['resolveExternalSeats']
    externalContributionQueue?: EnsembleOrchestratorDeps['externalContributionQueue']
    /**
     * 1.0.4-AD — optional probe injection. When set, the orchestrator
     * calls it BEFORE each participant's dispatch. Returning
     * `reachable: false` simulates a pre-flight health-check failure
     * (dead Codex socket, missing CLI binary, etc.) and the
     * orchestrator should skip dispatch + route to the next
     * participant. Default (undefined) preserves the pre-1.0.4-AD code
     * path so the existing dispatch-failure / yield / @-mention tests
     * stay byte-identical.
     */
    probeParticipant?: (participant: EnsembleParticipant) => Promise<ParticipantProbeResult>
    awaitPendingSeatCompaction?: (
      chatId: string,
      participantId: string
    ) => Promise<unknown> | undefined
    compactSeatContext?: (input: {
      chatId: string
      participantId: string
      provider: 'cursor' | 'kimi' | 'grok'
      trigger: 'auto'
    }) => Promise<{ ok: boolean; error?: string }>
    onContextCompactionProgress?: (event: ContextCompactionProgressEvent) => void
    onParticipantWorkingTelemetry?: (event: ParticipantWorkingTelemetryEvent) => void
    scheduleWakeupTimer?: (wakeup: EnsembleWakeupRecord) => void
    cancelWakeupTimer?: (wakeupId: string) => void
    signRunPermissionPosture?: (
      approvalMode: string | null | undefined,
      effectivePermissions: EffectiveRunPermissions | null | undefined,
      context?: RunPermissionPostureContext | null
    ) => string
    isTrustedSessionGranted?: (scope: {
      chatId: string
      provider: ProviderId
      workspacePath?: string | null
      ensembleParticipantId?: string | null
      ensembleLaneId?: string | null
      runtimeProfileId?: string | null
    }) => boolean
    issueRunScopedExternalGrants?: EnsembleOrchestratorDeps['issueRunScopedExternalGrants']
    persistSessionCheckpoint?: (chat: ChatRecord, reason: string) => void
    completeSessionCheckpoint?: (chatId: string, roundId: string, status: string) => void
    transitionRunQueueJob?: (
      runIdOrId: string,
      status: RunQueueJobStatus,
      partial?: { statusReason?: string; lastError?: string }
    ) => unknown
    nowIso?: () => string
    now?: () => number
    getSettings?: () => AppSettings
    getProviderUsageSnapshot?: (provider: EnsembleParticipant['provider']) => any
    recordUsage?: (entry: Omit<UsageRecord, 'id' | 'timestamp'>) => void
    recordBossmanControlRejection?: (rejection: {
      provider: string
      workspacePath: string | undefined
      chatId: string
      runId: string | undefined
      metadata: Record<string, unknown>
    }) => void
    recordFanoutAuthorizationRejection?: (rejection: {
      provider: string
      workspacePath: string | undefined
      chatId: string
      runId: string | undefined
      metadata: Record<string, unknown>
    }) => void
    shouldPersistProviderSessionForRun?: (runId: string) => boolean
    releaseProviderSessionPersistenceDecision?: (runId: string) => void
    appendMidRunSteering?: EnsembleOrchestratorDeps['appendMidRunSteering']
    getPendingMidRunSteeringEntryIds?: EnsembleOrchestratorDeps['getPendingMidRunSteeringEntryIds']
    listProjects?: EnsembleOrchestratorDeps['listProjects']
    listProjectReferences?: EnsembleOrchestratorDeps['listProjectReferences']
    projectReferenceExtractLoader?: EnsembleOrchestratorDeps['projectReferenceExtractLoader']
  } = {}
) {
  let chat = options.initialChat
    ? (JSON.parse(JSON.stringify(options.initialChat)) as ChatRecord)
    : makeChat()
  let counter = 0
  let steeringCounter = 0
  let pendingMidRunSteeringEntryIds: string[] = []
  const dispatched: AgentRunPayload[] = []
  const dispatch = vi.fn(
    async (
      payload: AgentRunPayload,
      event: Parameters<EnsembleOrchestratorDeps['dispatch']>[1],
      observer?: Parameters<EnsembleOrchestratorDeps['dispatch']>[2]
    ) => {
      dispatched.push(payload)
      const result = options.dispatch
        ? await options.dispatch(payload, event, observer)
        : { dispatched: true, appRunId: payload.appRunId || '' }
      // Mirror production: a successful seat dispatch delivers pending mid-run
      // steering entries (clears the drain-boundary pending set).
      if (result.dispatched !== false && pendingMidRunSteeringEntryIds.length > 0) {
        pendingMidRunSteeringEntryIds = []
      }
      return result
    }
  )
  const cancelRun = vi.fn(options.cancelRun ?? (async () => true))
  const terminateRunForHistory = options.terminateRunForHistory
    ? vi.fn(options.terminateRunForHistory)
    : undefined
  const transitionRunQueueJob = vi.fn(options.transitionRunQueueJob ?? (() => null))
  const probeParticipant = options.probeParticipant ? vi.fn(options.probeParticipant) : undefined
  const saveChat = vi.fn((next: ChatRecord) => {
    options.beforeSaveChat?.(next)
    chat = next
  })
  const appendMidRunSteering =
    options.appendMidRunSteering ??
    ((input: {
      chatId: string
      roundId: string
      text: string
      imageAttachments?: Array<{ id?: string; path: string; name?: string }>
      imageThumbnails?: Array<{
        dataBase64: string
        mimeType: string
        width?: number
        height?: number
      }>
    }) => {
      steeringCounter += 1
      const messageId = `steer-message-${steeringCounter}`
      const entryId = `steer-entry-${steeringCounter}`
      pendingMidRunSteeringEntryIds = [...pendingMidRunSteeringEntryIds, entryId]
      const imageAttachments = input.imageAttachments || []
      const imageThumbnails = input.imageThumbnails || []
      chat = {
        ...chat,
        messages: [
          ...chat.messages,
          {
            id: messageId,
            role: 'user',
            content: input.text,
            timestamp: `2026-05-24T00:00:0${steeringCounter}.000Z`,
            metadata: {
              kind: 'midRunSteering',
              ...(imageAttachments.length > 0 ? { imageAttachments } : {}),
              ...(imageThumbnails.length > 0 ? { imageThumbnails } : {})
            }
          }
        ],
        updatedAt: Date.now()
      }
      return { messageId, entryId }
    })
  const getPendingMidRunSteeringEntryIds =
    options.getPendingMidRunSteeringEntryIds ?? (() => [...pendingMidRunSteeringEntryIds])
  const orchestrator = new EnsembleOrchestrator({
    getChat: () => chat,
    saveChat,
    getSettings: options.getSettings ?? makeSettings,
    dispatch,
    cancelRun,
    appendMidRunSteering,
    getPendingMidRunSteeringEntryIds,
    ...(options.getProviderRunTransportLiveness
      ? { getProviderRunTransportLiveness: options.getProviderRunTransportLiveness }
      : {}),
    ...(options.hasPendingProviderRunApprovals
      ? { hasPendingProviderRunApprovals: options.hasPendingProviderRunApprovals }
      : {}),
    ...(terminateRunForHistory ? { terminateRunForHistory } : {}),
    ...(options.resolveExternalSeats ? { resolveExternalSeats: options.resolveExternalSeats } : {}),
    ...(options.externalContributionQueue
      ? { externalContributionQueue: options.externalContributionQueue }
      : {}),
    ...(options.awaitPendingSeatCompaction
      ? { awaitPendingSeatCompaction: options.awaitPendingSeatCompaction }
      : {}),
    ...(options.compactSeatContext ? { compactSeatContext: options.compactSeatContext } : {}),
    ...(options.onContextCompactionProgress
      ? { onContextCompactionProgress: options.onContextCompactionProgress }
      : {}),
    ...(options.onParticipantWorkingTelemetry
      ? { onParticipantWorkingTelemetry: options.onParticipantWorkingTelemetry }
      : {}),
    createRunId: (provider) => `${provider}-run-${++counter}`,
    now: options.now ?? (() => counter),
    nowIso: options.nowIso ?? (() => `2026-05-24T00:00:0${counter}.000Z`),
    ...(options.signRunPermissionPosture
      ? { signRunPermissionPosture: options.signRunPermissionPosture }
      : {}),
    ...(options.isTrustedSessionGranted
      ? { isTrustedSessionGranted: options.isTrustedSessionGranted }
      : {}),
    ...(options.issueRunScopedExternalGrants
      ? { issueRunScopedExternalGrants: options.issueRunScopedExternalGrants }
      : {}),
    ...(options.allocateFanoutLaneWorktree
      ? { allocateFanoutLaneWorktree: options.allocateFanoutLaneWorktree }
      : {}),
    ...(options.settleFanoutLaneWorktree
      ? { settleFanoutLaneWorktree: options.settleFanoutLaneWorktree }
      : {}),
    ...(options.getProviderUsageSnapshot
      ? { getProviderUsageSnapshot: options.getProviderUsageSnapshot }
      : {}),
    ...(probeParticipant ? { probeParticipant } : {}),
    ...(options.scheduleWakeupTimer ? { scheduleWakeupTimer: options.scheduleWakeupTimer } : {}),
    ...(options.cancelWakeupTimer ? { cancelWakeupTimer: options.cancelWakeupTimer } : {}),
    ...(options.persistSessionCheckpoint
      ? { persistSessionCheckpoint: options.persistSessionCheckpoint }
      : {}),
    ...(options.completeSessionCheckpoint
      ? { completeSessionCheckpoint: options.completeSessionCheckpoint }
      : {}),
    transitionRunQueueJob,
    ...(options.recordUsage ? { recordUsage: options.recordUsage } : {}),
    ...(options.recordBossmanControlRejection
      ? { recordBossmanControlRejection: options.recordBossmanControlRejection }
      : {}),
    ...(options.recordFanoutAuthorizationRejection
      ? { recordFanoutAuthorizationRejection: options.recordFanoutAuthorizationRejection }
      : {}),
    ...(options.shouldPersistProviderSessionForRun
      ? { shouldPersistProviderSessionForRun: options.shouldPersistProviderSessionForRun }
      : {}),
    ...(options.releaseProviderSessionPersistenceDecision
      ? {
          releaseProviderSessionPersistenceDecision:
            options.releaseProviderSessionPersistenceDecision
        }
      : {}),
    ...(options.listProjects ? { listProjects: options.listProjects } : {}),
    ...(options.listProjectReferences
      ? { listProjectReferences: options.listProjectReferences }
      : {}),
    ...(options.projectReferenceExtractLoader
      ? { projectReferenceExtractLoader: options.projectReferenceExtractLoader }
      : {})
  })
  return {
    get chat() {
      return chat
    },
    cancelRun,
    terminateRunForHistory,
    transitionRunQueueJob,
    saveChat,
    dispatched,
    dispatch,
    probeParticipant,
    orchestrator
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

type TestQueuedPromptRuntime = {
  id: string
  prompt: string
  dmTargetParticipantId?: string
}

function getRuntimeQueuedPrompts(
  orchestrator: EnsembleOrchestrator,
  chatId: string
): TestQueuedPromptRuntime[] {
  const internal = (
    orchestrator as unknown as {
      roundsByChatId: Map<string, { queuedPrompts: TestQueuedPromptRuntime[] }>
    }
  ).roundsByChatId.get(chatId)
  return internal?.queuedPrompts ? [...internal.queuedPrompts] : []
}

function makeFanoutRaceHarness(options: Parameters<typeof makeHarness>[0] = {}) {
  const harness = makeHarness(options)
  harness.chat.ensemble!.fanoutPolicy = 'read_only'
  harness.chat.ensemble!.participants = [
    {
      id: 'codex',
      provider: 'codex',
      enabled: true,
      role: 'Lead',
      instructions: 'Lead.',
      order: 1,
      permissionPresetId: 'workspace_write'
    },
    {
      id: 'claude',
      provider: 'claude',
      enabled: true,
      role: 'Reviewer',
      instructions: 'Review.',
      order: 2,
      permissionPresetId: 'read_only'
    },
    {
      id: 'gemini',
      provider: 'gemini',
      enabled: true,
      role: 'Researcher',
      instructions: 'Research.',
      order: 3,
      permissionPresetId: 'workspace_write'
    }
  ]
  return harness
}

async function startUnresolvedReviewerFanout(harness: ReturnType<typeof makeHarness>) {
  harness.orchestrator.startRound({
    chatId: 'ensemble-chat',
    prompt: 'Lead starts, reviewer fans out.',
    event: { sender: {} as Electron.WebContents }
  })
  await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1), { timeout: 1000 })
  const fanout = harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
    targets: ['Reviewer'],
    prompt: 'Inspect this while the lead continues.'
  })
  await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2), { timeout: 1000 })
  expect(harness.dispatched[1].ensembleRun?.participantId).toBe('claude')
  expect(harness.dispatched[1].ensembleRun?.laneId).toBeTruthy()
  return { fanout }
}

function completeDispatchedRun(
  harness: ReturnType<typeof makeHarness>,
  index: number,
  status: 'success' | 'failed' = 'success'
) {
  const payload = harness.dispatched[index]
  harness.orchestrator.handleProviderOutput(
    payload.provider,
    { appRunId: payload.appRunId, appChatId: 'ensemble-chat' },
    { type: 'result', status }
  )
}

describe('EnsembleOrchestrator', () => {
  it('recovers a Cursor turn after a rejected yield and missing terminal so rotation advances', async () => {
    vi.useFakeTimers()
    try {
      const harness = makeHarness({
        now: () => Date.now(),
        getProviderRunTransportLiveness: () => 'exited'
      })
      harness.chat.ensemble!.bossmanParticipantId = 'boss'
      harness.chat.ensemble!.orchestrationMode = 'continuous'
      harness.chat.ensemble!.maxContinuationHops = 0
      harness.chat.ensemble!.participants = [
        {
          id: 'cursor',
          provider: 'cursor',
          enabled: true,
          role: 'Worker',
          instructions: 'Work.',
          order: 1,
          permissionPresetId: 'workspace_write'
        },
        {
          id: 'boss',
          provider: 'claude',
          enabled: true,
          role: 'Boss',
          instructions: 'Coordinate.',
          order: 2,
          permissionPresetId: 'read_only'
        },
        {
          id: 'later',
          provider: 'codex',
          enabled: true,
          role: 'Worker',
          instructions: 'Continue.',
          order: 3,
          permissionPresetId: 'workspace_write'
        }
      ]
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Reproduce the Cursor yield stop.',
        event: { sender: {} as Electron.WebContents }
      })
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
      expect(harness.dispatched).toHaveLength(1)
      expect(
        (
          harness.orchestrator as unknown as {
            cursorCompletionWatchdog: { has(runId: string): boolean }
          }
        ).cursorCompletionWatchdog.has(harness.dispatched[0].appRunId || '')
      ).toBe(true)
      expect(vi.getTimerCount()).toBeGreaterThan(0)

      // This is the observed routing boundary: the Cursor request can carry a
      // stale/mismatched run id, so the yield tool gets a typed rejection while
      // the real orchestrator-owned run remains live and awaiting completion.
      expect(
        harness.orchestrator.markYielded('stale-cursor-run', 'Please continue later.', 'later')
      ).toEqual({ kind: 'no_active_run' })

      // Model output and a non-yield tool result are both non-terminal. The
      // missing provider `result` must still be bounded independently.
      harness.orchestrator.handleProviderOutput(
        'cursor',
        { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
        { type: 'content', text: 'The work is complete.' }
      )
      harness.orchestrator.handleProviderOutput(
        'cursor',
        { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
        {
          type: 'tool_use',
          tool_id: 'yield-1',
          tool_name: 'cursor_thinking',
          parameters: { summary: 'The work is complete.' }
        }
      )
      harness.orchestrator.handleProviderOutput(
        'cursor',
        { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
        {
          type: 'tool_result',
          tool_id: 'yield-1',
          output: 'The work is complete.'
        }
      )

      vi.advanceTimersByTime(30_000)
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
      expect(harness.dispatched).toHaveLength(2)
      expect(harness.dispatched[1].provider).toBe('claude')
      expect(harness.cancelRun).toHaveBeenCalledWith('cursor', harness.dispatched[0].appRunId)
      expect(
        harness.orchestrator.handleProviderOutput(
          'cursor',
          { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
          { type: 'result', status: 'success' }
        )
      ).toBe(false)

      // Continuous Boss must explicitly keep the remaining Worker before a
      // quiet answer advances past the authority-routing checkpoint. Prefer the
      // exact id — two seats share the Worker role in this fixture.
      const bossSelection = await harness.orchestrator.bossmanControlForRun(
        harness.dispatched[1].appRunId,
        {
          action: 'select_participants',
          participantIds: ['later'],
          reason: 'Keep the later Worker after Cursor recovery.'
        }
      )
      expect(bossSelection).toMatchObject({ ok: true, action: 'select_participants' })
      completeDispatchedRun(harness, 1)
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
      expect(harness.dispatched).toHaveLength(3)
      expect(harness.dispatched[2].provider).toBe('codex')
      completeDispatchedRun(harness, 2)
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
      expect(
        harness.chat.messages.some((message) =>
          (message.content || '').includes('missing terminal result')
        )
      ).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers a critically full Cursor seat with a discreet compaction card and same-seat Path-B retry', async () => {
    vi.useFakeTimers()
    try {
      const progress: Array<{ status: string; provider?: string }> = []
      const harness = makeHarness({
        now: () => Date.now(),
        getProviderRunTransportLiveness: () => 'alive',
        onContextCompactionProgress: (event) => {
          progress.push({ status: event.status, provider: event.provider })
        }
      })
      harness.chat.ensemble!.participants = [
        {
          id: 'cursor',
          provider: 'cursor',
          enabled: true,
          role: 'GrokCapt',
          instructions: 'Work.',
          order: 1,
          permissionPresetId: 'workspace_write',
          model: 'grok-4.5'
        },
        {
          id: 'codex',
          provider: 'codex',
          enabled: true,
          role: 'Worker',
          instructions: 'Continue.',
          order: 2,
          permissionPresetId: 'workspace_write'
        }
      ]
      // Seed a long prefix so host recovery can prune a contiguous range.
      harness.chat.messages = Array.from({ length: 20 }, (_, index) => ({
        id: `hist-${index}`,
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `history ${index}`,
        timestamp: `2026-08-06T20:00:${String(index).padStart(2, '0')}.000Z`
      }))

      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Keep working through the stuck Cursor seat.',
        event: { sender: {} as Electron.WebContents }
      })
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
      expect(harness.dispatched).toHaveLength(1)
      expect(harness.dispatched[0].provider).toBe('cursor')
      const firstRunId = harness.dispatched[0].appRunId

      // grok-4.5 window is 500k — fill it to critical occupancy.
      expect(
        harness.orchestrator.reportParticipantTokenUsage(firstRunId, {
          total_tokens: 500_000,
          input_tokens: 499_000,
          output_tokens: 1_000
        })
      ).toBe(true)

      // Quiet window is 45s; drain chained 1s poll timers past that mark.
      for (let step = 0; step < 50; step += 1) {
        vi.advanceTimersByTime(1_000)
        for (let i = 0; i < 20; i += 1) await Promise.resolve()
        if (harness.dispatched.length >= 2) break
      }
      expect(harness.dispatched).toHaveLength(2)
      expect(harness.dispatched[1].provider).toBe('cursor')
      expect(harness.dispatched[1].appRunId).not.toBe(firstRunId)
      expect(harness.cancelRun).toHaveBeenCalledWith('cursor', firstRunId)
      expect(progress.some((event) => event.status === 'started')).toBe(true)
      expect(progress.some((event) => event.status === 'completed')).toBe(true)
      expect(
        harness.chat.messages.some((message) => message.metadata?.kind === 'contextCompaction')
      ).toBe(true)
      expect(
        harness.chat.messages.some((message) =>
          /Cursor (failed|skipped)\./i.test(message.content || '')
        )
      ).toBe(false)
      expect(
        harness.chat.messages.some((message) =>
          (message.content || '').includes('missing terminal result')
        )
      ).toBe(false)
      expect(
        harness.chat.ensemble?.activeRound?.participants.find(
          (participant) => participant.participantId === 'cursor'
        )?.status
      ).toBe('running')
      expect(
        harness.chat.ensemble?.participants.find((participant) => participant.id === 'cursor')
          ?.contextCompactionSummary?.text
      ).toContain('Host recovered a Cursor Path-B seat')
    } finally {
      vi.useRealTimers()
    }
  })

  it('finalizes a streamed Cursor yield and cancels its exact child after an explicit handoff', async () => {
    vi.useFakeTimers()
    try {
      const harness = makeHarness({
        now: () => Date.now(),
        getProviderRunTransportLiveness: () => 'alive'
      })
      harness.chat.ensemble!.bossmanParticipantId = 'boss'
      harness.chat.ensemble!.orchestrationMode = 'continuous'
      harness.chat.ensemble!.maxContinuationHops = 0
      harness.chat.ensemble!.participants = [
        {
          id: 'cursor',
          provider: 'cursor',
          enabled: true,
          role: 'Worker',
          instructions: 'Work.',
          order: 1,
          permissionPresetId: 'workspace_write'
        },
        {
          id: 'boss',
          provider: 'claude',
          enabled: true,
          role: 'Boss',
          instructions: 'Coordinate.',
          order: 2,
          permissionPresetId: 'read_only'
        },
        {
          id: 'later',
          provider: 'codex',
          enabled: true,
          role: 'Worker',
          instructions: 'Continue.',
          order: 3,
          permissionPresetId: 'workspace_write'
        }
      ]
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Reproduce a streamed Cursor yield.',
        event: { sender: {} as Electron.WebContents }
      })
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
      expect(harness.dispatched).toHaveLength(1)

      const route = {
        appRunId: harness.dispatched[0].appRunId,
        appChatId: 'ensemble-chat'
      }
      harness.orchestrator.handleProviderOutput('cursor', route, {
        type: 'tool_use',
        tool_id: 'yield-stream-1',
        tool_name: 'mcp_TaskWraith_ensemble_yield',
        parameters: { target: 'later', reason: 'Please continue later.' }
      })
      harness.orchestrator.handleProviderOutput('cursor', route, {
        type: 'tool_result',
        tool_id: 'yield-stream-1',
        output: '{"ok":true,"target":"later"}'
      })

      // The targeted handoff is terminal for the current seat. It must release
      // serial completion without waiting for the watchdog, cancel the exact
      // Cursor run, and put the named participant ahead of the pending Boss.
      for (let i = 0; i < 30; i += 1) await Promise.resolve()
      expect(harness.cancelRun).toHaveBeenCalledWith('cursor', harness.dispatched[0].appRunId)
      expect(harness.dispatched).toHaveLength(2)
      expect(harness.dispatched[1].provider).toBe('codex')
      expect(
        (
          harness.orchestrator as unknown as {
            cursorCompletionWatchdog: { has(runId: string): boolean }
          }
        ).cursorCompletionWatchdog.has(harness.dispatched[0].appRunId || '')
      ).toBe(false)

      completeDispatchedRun(harness, 1)
      for (let i = 0; i < 30; i += 1) await Promise.resolve()
      expect(harness.dispatched).toHaveLength(3)
      expect(harness.dispatched[2].provider).toBe('claude')
      completeDispatchedRun(harness, 2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces an AntiGravity headless read denial as a failed participant, not an ordinary skip', async () => {
    const initialChat = makeChat()
    initialChat.ensemble = {
      ...initialChat.ensemble!,
      participants: [
        {
          id: 'antigravity',
          provider: 'antigravity',
          enabled: true,
          role: 'GemProWork',
          instructions: 'Review the workspace.',
          order: 1,
          model: 'gemini-3.1-pro-high',
          permissionPresetId: 'default'
        }
      ]
    }
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Review the current workspace.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1), { timeout: 1000 })

    const payload = harness.dispatched[0]
    const route = { appRunId: payload.appRunId, appChatId: 'ensemble-chat' }
    expect(
      harness.orchestrator.noteProviderFailureText(
        'antigravity',
        route,
        'jetski: no output produced — a tool required the "read_file" permission that headless mode cannot prompt for, so it was auto-denied.'
      )
    ).toBe(true)
    harness.orchestrator.handleProviderOutput('antigravity', route, {
      type: 'result',
      status: 'success'
    })

    const state = harness.chat.ensemble?.activeRound?.participants.find(
      (participant) => participant.participantId === 'antigravity'
    )
    expect(state?.status).toBe('failed')
    expect(state?.reason).toContain('headless mode auto-denied')
    expect(state?.reason).toContain('read_file')
  })

  it('retries one unsupported AntiGravity permission refusal after process exit, then bounds recovery', async () => {
    const initialChat = makeChat()
    initialChat.workspacePath = '/Users/test/AGBench'
    initialChat.ensemble = {
      ...initialChat.ensemble!,
      participants: [
        {
          id: 'antigravity',
          provider: 'antigravity',
          enabled: true,
          role: 'Boardmaster',
          instructions: 'Read the briefing and maintain BOARD.md.',
          order: 1,
          model: 'gemini-3.1-pro-high',
          permissionPresetId: 'workspace_write'
        }
      ]
    }
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Read /Users/test/AGBench/.local-only/docs/00-BRIEFING.md before updating BOARD.md.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1), { timeout: 1000 })

    const first = harness.dispatched[0]
    const firstRoute = { appRunId: first.appRunId, appChatId: 'ensemble-chat' }
    harness.orchestrator.handleProviderOutput('antigravity', firstRoute, {
      type: 'tool_use',
      tool_id: 'df-1',
      tool_name: 'run_command',
      parameters: { command: 'df -h ~' }
    })
    harness.orchestrator.handleProviderOutput('antigravity', firstRoute, {
      type: 'tool_result',
      tool_id: 'df-1',
      status: 'success',
      output: 'TaskWraith allowed this command.'
    })
    const falseRefusal =
      'I cannot complete BOARD.md because my read access was denied. I require explicit host approval.'
    harness.orchestrator.handleProviderOutput('antigravity', firstRoute, {
      type: 'content',
      text: falseRefusal
    })
    harness.orchestrator.handleProviderOutput('antigravity', firstRoute, {
      type: 'result',
      status: 'success'
    })

    // The result alone cannot dispatch the retry: the first process still owns
    // agy's temporary permission lease until its exact exit is observed.
    expect(harness.dispatched).toHaveLength(1)
    expect(harness.orchestrator.markRunExited(first.appRunId, 0)).toBe(true)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2), { timeout: 1000 })

    const retry = harness.dispatched[1]
    expect(retry.prompt).toContain('received an explicit denied/error tool result')
    expect(retry.prompt).toContain('dot-prefixed children such as `.local-only`')
    expect(retry.prompt).toContain('Host evidence correction: no permission-denied tool result')
    expect(
      harness.chat.messages.some((message) =>
        message.content.includes('Host evidence correction: no permission-denied tool result')
      )
    ).toBe(true)

    // A second unsupported refusal is retained as the provider's answer rather
    // than entering an infinite same-seat loop.
    const retryRoute = { appRunId: retry.appRunId, appChatId: 'ensemble-chat' }
    harness.orchestrator.handleProviderOutput('antigravity', retryRoute, {
      type: 'content',
      text: falseRefusal
    })
    harness.orchestrator.handleProviderOutput('antigravity', retryRoute, {
      type: 'result',
      status: 'success'
    })
    await Promise.resolve()
    expect(harness.dispatched).toHaveLength(2)
    const finalState = harness.chat.ensemble?.activeRound?.participants.find(
      (participant) => participant.participantId === 'antigravity'
    )
    expect(finalState?.status).toBe('answered')
  })

  it('does not retry an AntiGravity refusal backed by an explicit denied tool result', async () => {
    const initialChat = makeChat()
    initialChat.ensemble = {
      ...initialChat.ensemble!,
      participants: [
        {
          id: 'antigravity',
          provider: 'antigravity',
          enabled: true,
          role: 'Boardmaster',
          instructions: 'Read the briefing.',
          order: 1,
          model: 'gemini-3.1-pro-high',
          permissionPresetId: 'workspace_write'
        }
      ]
    }
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Read the briefing.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1), { timeout: 1000 })

    const dispatched = harness.dispatched[0]
    const route = { appRunId: dispatched.appRunId, appChatId: 'ensemble-chat' }
    harness.orchestrator.handleProviderOutput('antigravity', route, {
      type: 'tool_use',
      tool_id: 'read-denied',
      tool_name: 'read_file',
      parameters: { path: '/outside/briefing.md' }
    })
    harness.orchestrator.handleProviderOutput('antigravity', route, {
      type: 'tool_result',
      tool_id: 'read-denied',
      status: 'error',
      output: 'TaskWraith declined this read under the current permission tier.'
    })
    harness.orchestrator.handleProviderOutput('antigravity', route, {
      type: 'content',
      text: 'I cannot continue because read access was denied by the host.'
    })
    harness.orchestrator.handleProviderOutput('antigravity', route, {
      type: 'result',
      status: 'success'
    })
    await Promise.resolve()

    expect(harness.dispatched).toHaveLength(1)
    const state = harness.chat.ensemble?.activeRound?.participants.find(
      (participant) => participant.participantId === 'antigravity'
    )
    expect(state?.status).toBe('answered')
    expect(
      harness.chat.messages.some((message) =>
        message.content.includes('Host evidence correction: no permission-denied tool result')
      )
    ).toBe(false)
  })

  it('rejects a fresh-only start while an interactive round owns the chat without queueing or mutation', () => {
    const harness = makeHarness()
    const prepareFreshChat = vi.fn((chat: ChatRecord) => chat)
    const active = harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Interactive owner.',
      event: { sender: {} as Electron.WebContents }
    })
    expect(active.status).toBe('started')
    const before = JSON.parse(JSON.stringify(harness.chat)) as ChatRecord

    const scheduled = harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Scheduled contender.',
      event: { sender: {} as Electron.WebContents },
      requireFreshRound: true,
      prepareFreshChat
    })

    expect(scheduled).toEqual({ status: 'busy' })
    expect(scheduled.roundId).toBeUndefined()
    expect(prepareFreshChat).not.toHaveBeenCalled()
    expect(harness.chat).toEqual(before)
    expect(getRuntimeQueuedPrompts(harness.orchestrator, 'ensemble-chat')).toEqual([])
    expect(
      harness.chat.messages.some((message) => message.content === 'Scheduled contender.')
    ).toBe(false)
  })

  it('reserves a fresh round before a re-entrant fresh contender can start', () => {
    const harness = makeHarness()
    let contender: ReturnType<typeof harness.orchestrator.startRound> | undefined

    const owner = harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Scheduled owner.',
      event: { sender: {} as Electron.WebContents },
      requireFreshRound: true,
      onRoundReserved: () => {
        contender = harness.orchestrator.startRound({
          chatId: 'ensemble-chat',
          prompt: 'Near-concurrent scheduled contender.',
          event: { sender: {} as Electron.WebContents },
          requireFreshRound: true
        })
      }
    })

    expect(owner.status).toBe('started')
    expect(contender).toEqual({ status: 'busy' })
    expect(
      harness.chat.messages.filter((message) => message.metadata?.kind === 'ensembleRoundPrompt')
    ).toHaveLength(1)
    expect(getRuntimeQueuedPrompts(harness.orchestrator, 'ensemble-chat')).toEqual([])
  })

  it('fails an exactly reserved round when its ownership callback throws', () => {
    const completed: Array<{ roundId: string; status: string }> = []
    const reservationError = new Error('scheduled ownership bind failed')
    const harness = makeHarness({
      completeSessionCheckpoint: (_chatId, roundId, status) => {
        completed.push({ roundId, status })
      }
    })

    let thrown: unknown
    try {
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Reserve before dispatch.',
        event: { sender: {} as Electron.WebContents },
        requireFreshRound: true,
        onRoundReserved: () => {
          throw reservationError
        }
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBe(reservationError)
    expect(harness.dispatched).toHaveLength(0)
    expect(harness.chat.ensemble?.activeRound?.status).toBe('failed')
    expect(completed).toEqual([
      {
        roundId: harness.chat.ensemble!.activeRound!.roundId,
        status: 'failed'
      }
    ])
    expect(
      (
        harness.orchestrator as unknown as {
          roundsByChatId: Map<string, unknown>
        }
      ).roundsByChatId.has('ensemble-chat')
    ).toBe(false)
  })

  it('fails a bound round when post-reservation projection setup throws', () => {
    let saveCount = 0
    const completed: Array<{ roundId: string; status: string }> = []
    const projectionError = new Error('post-reservation status write failed')
    const harness = makeHarness({
      beforeSaveChat: () => {
        saveCount += 1
        if (saveCount === 2) throw projectionError
      },
      completeSessionCheckpoint: (_chatId, roundId, status) => {
        completed.push({ roundId, status })
      }
    })
    harness.chat.ensemble!.participants = []

    let reservedRoundId: string | undefined
    let thrown: unknown
    try {
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Reserve an empty scheduled round.',
        event: { sender: {} as Electron.WebContents },
        requireFreshRound: true,
        onRoundReserved: (roundId) => {
          reservedRoundId = roundId
        }
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBe(projectionError)
    expect(harness.dispatched).toHaveLength(0)
    expect(harness.chat.ensemble?.activeRound?.status).toBe('failed')
    expect(completed).toEqual([{ roundId: reservedRoundId!, status: 'failed' }])
    expect(
      (
        harness.orchestrator as unknown as {
          roundsByChatId: Map<string, unknown>
        }
      ).roundsByChatId.has('ensemble-chat')
    ).toBe(false)
  })

  it('binds round ownership before an empty roster can complete synchronously', () => {
    const completionOrder: string[] = []
    const harness = makeHarness({
      beforeSaveChat: (chat) => {
        if (chat.ensemble?.activeRound?.status === 'completed') {
          completionOrder.push('completed')
        }
      }
    })
    harness.chat.ensemble!.participants = []

    const result = harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Scheduled empty roster.',
      event: { sender: {} as Electron.WebContents },
      requireFreshRound: true,
      onRoundReserved: (roundId) => {
        expect(roundId).toBe(harness.chat.ensemble?.activeRound?.roundId)
        expect(harness.chat.ensemble?.activeRound?.status).toBe('running')
        completionOrder.push('reserved')
      }
    })

    expect(result.status).toBe('started')
    expect(completionOrder).toEqual(['reserved', 'completed'])
    expect(harness.chat.ensemble?.activeRound?.status).toBe('completed')
  })

  it('applies a scheduled chat snapshot atomically with the newly reserved round', async () => {
    const harness = makeHarness()
    const scheduledParticipant = {
      ...harness.chat.ensemble!.participants[1],
      id: 'scheduled-codex',
      role: 'Scheduled Worker',
      order: 1
    }

    const result = harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Scheduled snapshot.',
      event: { sender: {} as Electron.WebContents },
      requireFreshRound: true,
      prepareFreshChat: (chat) => ({
        ...chat,
        ensemble: {
          ...chat.ensemble!,
          participants: [scheduledParticipant]
        }
      }),
      onRoundReserved: (roundId) => {
        expect(harness.chat.ensemble?.activeRound?.roundId).toBe(roundId)
        expect(harness.chat.ensemble?.activeRound?.participants).toHaveLength(1)
        expect(harness.chat.ensemble?.activeRound?.participants[0].participantId).toBe(
          'scheduled-codex'
        )
      }
    })

    expect(result.status).toBe('started')
    expect(harness.chat.ensemble?.participants).toEqual([scheduledParticipant])
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('scheduled-codex')
  })

  it('dispatches the lexical grant identity for a scheduled fresh round', async () => {
    const harness = makeHarness()

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Run from the pinned target.',
      event: { sender: {} as Electron.WebContents },
      requireFreshRound: true
    })

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].workspace).toBe('/repo')
    expect(harness.chat.workspacePath).toBe('/repo')
  })

  it('keeps the lexical grant identity on fan-out children', async () => {
    const harness = makeFanoutRaceHarness()

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Lead starts and fans out.',
      event: { sender: {} as Electron.WebContents },
      requireFreshRound: true
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
      targets: ['Reviewer'],
      prompt: 'Review from the same pinned target.'
    })

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched.map((payload) => payload.workspace)).toEqual(['/repo', '/repo'])
    expect(harness.chat.workspacePath).toBe('/repo')
  })

  it('resolves a directed target from the prepared scheduled roster', async () => {
    const harness = makeHarness()
    const scheduledTarget = {
      ...harness.chat.ensemble!.participants[1],
      id: 'frozen-directed-seat',
      role: 'Frozen Target',
      order: 1
    }
    harness.chat.ensemble!.participants = [harness.chat.ensemble!.participants[0]]

    const result = harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Run only the frozen target.',
      event: { sender: {} as Electron.WebContents },
      dmTargetParticipantId: scheduledTarget.id,
      requireFreshRound: true,
      prepareFreshChat: (chat) => ({
        ...chat,
        ensemble: { ...chat.ensemble!, participants: [scheduledTarget] }
      })
    })

    expect(result.status).toBe('started')
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe(scheduledTarget.id)
    expect(harness.chat.ensemble?.activeRound?.dmTargetParticipantId).toBe(scheduledTarget.id)
  })

  it('rejects prepared chat transforms without fresh ownership or immutable authority', () => {
    const harness = makeHarness()
    expect(() =>
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Invalid prepared ordinary round.',
        event: { sender: {} as Electron.WebContents },
        prepareFreshChat: (chat) => chat
      })
    ).toThrow('requires fresh-round ownership')

    expect(() =>
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Invalid prepared scope.',
        event: { sender: {} as Electron.WebContents },
        requireFreshRound: true,
        prepareFreshChat: (chat) => ({ ...chat, scope: 'global' })
      })
    ).toThrow('changed immutable round authority')
  })

  it('rejects a directed target absent from the prepared scheduled roster', () => {
    const harness = makeHarness()
    expect(() =>
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Missing frozen target.',
        event: { sender: {} as Electron.WebContents },
        dmTargetParticipantId: 'missing-target',
        requireFreshRound: true,
        prepareFreshChat: (chat) => chat
      })
    ).toThrow('no longer in the roster')
  })

  it('fails and clears a reserved round when unexpected orchestration work rejects', async () => {
    let saveCount = 0
    const completed: Array<{ roundId: string; status: string }> = []
    const harness = makeHarness({
      probeParticipant: async () => ({ reachable: true }),
      beforeSaveChat: () => {
        saveCount += 1
        if (saveCount === 2) throw new Error('projection write failed')
      },
      completeSessionCheckpoint: (_chatId, roundId, status) => {
        completed.push({ roundId, status })
      }
    })

    const result = harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Exercise unexpected rejection.',
      event: { sender: {} as Electron.WebContents },
      requireFreshRound: true
    })

    expect(result.status).toBe('started')
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('failed'))
    expect(completed).toContainEqual({ roundId: result.roundId!, status: 'failed' })
    expect(getRuntimeQueuedPrompts(harness.orchestrator, 'ensemble-chat')).toEqual([])
  })

  it('finalizes and cancels a seeded participant when pre-dispatch construction throws', async () => {
    const completed: Array<{ roundId: string; status: string }> = []
    const harness = makeHarness({
      cancelRun: () => {
        throw new Error('synchronous cancel failure')
      },
      issueRunScopedExternalGrants: () => {
        throw new Error('grant construction failed')
      },
      completeSessionCheckpoint: (_chatId, roundId, status) => {
        completed.push({ roundId, status })
      }
    })

    const result = harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Exercise seeded cleanup.',
      event: { sender: {} as Electron.WebContents },
      requireFreshRound: true
    })

    expect(result.status).toBe('started')
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('failed'))
    expect(harness.cancelRun).toHaveBeenCalledTimes(1)
    expect(completed).toContainEqual({ roundId: result.roundId!, status: 'failed' })
    expect(
      (
        harness.orchestrator as unknown as {
          runsByRunId: Map<string, unknown>
        }
      ).runsByRunId.size
    ).toBe(0)
  })

  it('dispatches participants serially in configured order', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Please review and implement.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].provider).toBe('claude')
    expect(harness.dispatched[0].ensembleRun).toMatchObject({
      roundId: harness.chat.ensemble?.activeRound?.roundId,
      participantId: 'claude',
      provider: 'claude',
      role: 'Reviewer',
      order: 1
    })
    harness.orchestrator.handleProviderOutput(
      'claude',
      {
        appRunId: harness.dispatched[0].appRunId,
        appChatId: 'ensemble-chat'
      },
      {
        type: 'message',
        role: 'assistant',
        delta: true,
        content: 'Reviewed.'
      }
    )
    harness.orchestrator.handleProviderOutput(
      'claude',
      {
        appRunId: harness.dispatched[0].appRunId,
        appChatId: 'ensemble-chat'
      },
      {
        type: 'result',
        status: 'success',
        stats: { total_tokens: 10 }
      }
    )
    expect(harness.transitionRunQueueJob).toHaveBeenCalledWith(
      harness.dispatched[0].appRunId,
      'completed',
      {}
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('codex')
  })

  it.each([
    {
      label: 'workspace default',
      scope: 'workspace' as const,
      requested: undefined,
      expected: 'builtin:codex:local'
    },
    {
      label: 'global default',
      scope: 'global' as const,
      requested: undefined,
      expected: 'builtin:codex:global'
    },
    {
      label: 'explicit custom profile',
      scope: 'workspace' as const,
      requested: 'custom-codex-runtime',
      expected: 'custom-codex-runtime'
    }
  ])('dispatches a concrete runtime profile for $label', async ({ scope, requested, expected }) => {
    const initialChat = makeChat()
    initialChat.scope = scope
    initialChat.provider = 'codex'
    if (scope === 'global') {
      delete initialChat.workspaceId
      delete initialChat.workspacePath
    }
    initialChat.ensemble!.participants = [
      {
        id: 'codex',
        provider: 'codex',
        enabled: true,
        role: 'Worker',
        instructions: 'Work.',
        order: 1,
        permissionPresetId: 'workspace_write',
        ...(requested ? { runtimeProfileId: requested } : {})
      }
    ]
    const signRunPermissionPosture = vi.fn(() => 'f'.repeat(64))
    const harness = makeHarness({ initialChat, signRunPermissionPosture })

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Use the canonical runtime identity.',
      event: { sender: {} as Electron.WebContents }
    })

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].runtimeProfileId).toBe(expected)
    expect(harness.chat.runs?.[0]?.runtimeProfileId).toBe(expected)
    expect(signRunPermissionPosture).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ runtimeProfileId: expected })
    )
  })

  it('freezes participant model, reasoning, and permissions in the round snapshot', async () => {
    const initialChat = makeChat()
    Object.assign(initialChat.ensemble!.participants[0], {
      model: 'claude-fable-5',
      reasoningEffort: 'max',
      fastModeEnabled: true,
      permissionPresetId: 'read_only'
    })
    const harness = makeHarness({ initialChat })

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Preserve the participant setup.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    expect(
      harness.chat.ensemble?.activeRound?.participants.find(
        (participant) => participant.participantId === 'claude'
      )
    ).toMatchObject({
      provider: 'claude',
      role: 'Reviewer',
      model: 'claude-fable-5',
      reasoningEffort: 'max',
      fastModeEnabled: true,
      permissionPresetId: 'read_only',
      status: 'running'
    })
    expect(harness.chat.runs[0]?.ensembleSeatSnapshot).toEqual({
      schemaVersion: 1,
      provider: 'claude',
      model: 'claude-fable-5',
      reasoningEffort: 'max',
      fastModeEnabled: true,
      configuredPermissionPresetId: 'read_only'
    })
  })

  it('emits participant progress for native provider context compaction events', async () => {
    const progressEvents: ContextCompactionProgressEvent[] = []
    const harness = makeHarness({
      onContextCompactionProgress: (event) => progressEvents.push(event)
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Please review and implement.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const route = {
      appRunId: harness.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }

    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'compaction_event',
      compaction: {
        kind: 'started',
        telemetry: { provider: 'claude', trigger: 'auto' }
      }
    })
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'compaction_event',
      compaction: {
        kind: 'completed',
        telemetry: {
          provider: 'claude',
          trigger: 'auto',
          eventUuid: 'compact-1',
          preTokens: 240_000,
          postTokens: 80_000
        }
      }
    })

    expect(progressEvents).toMatchObject([
      {
        chatId: 'ensemble-chat',
        participantId: 'claude',
        provider: 'claude',
        status: 'started',
        trigger: 'auto'
      },
      {
        chatId: 'ensemble-chat',
        participantId: 'claude',
        provider: 'claude',
        status: 'completed',
        trigger: 'auto'
      }
    ])
    expect(harness.chat.messages.at(-1)?.metadata).toMatchObject({
      kind: 'contextCompaction',
      ensembleParticipantId: 'claude'
    })
  })

  it('emits coalesced ephemeral usage snapshots for the active participant turn', async () => {
    let now = 1_000
    const telemetryEvents: ParticipantWorkingTelemetryEvent[] = []
    const harness = makeHarness({
      now: () => now,
      onParticipantWorkingTelemetry: (event) => telemetryEvents.push(event)
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Track this participant turn.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runId = harness.dispatched[0].appRunId!

    expect(
      harness.orchestrator.reportParticipantTokenUsage(
        runId,
        { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
        { provider: 'claude', chatId: 'ensemble-chat' }
      )
    ).toBe(true)
    now += 200
    expect(
      harness.orchestrator.reportParticipantTokenUsage(
        runId,
        { input_tokens: 30, output_tokens: 10, total_tokens: 40 },
        { provider: 'claude', chatId: 'ensemble-chat' }
      )
    ).toBe(true)
    now += 200
    expect(
      harness.orchestrator.reportParticipantTokenUsage(
        runId,
        { input_tokens: 40, output_tokens: 12, total_tokens: 52 },
        { provider: 'claude', chatId: 'ensemble-chat' }
      )
    ).toBe(true)
    now += 200
    expect(
      harness.orchestrator.reportParticipantTokenUsage(
        runId,
        { input_tokens: 50, output_tokens: 15, total_tokens: 65 },
        { provider: 'claude', chatId: 'ensemble-chat' }
      )
    ).toBe(true)

    expect(telemetryEvents).toEqual([
      expect.objectContaining({
        type: 'snapshot',
        chatId: 'ensemble-chat',
        participantId: 'claude',
        runId,
        inputTokens: 20,
        outputTokens: 5,
        totalTokens: 25,
        estimated: false
      }),
      expect.objectContaining({
        type: 'snapshot',
        chatId: 'ensemble-chat',
        participantId: 'claude',
        runId,
        inputTokens: 50,
        outputTokens: 15,
        totalTokens: 65,
        estimated: false
      })
    ])
    expect(
      harness.orchestrator.reportParticipantTokenUsage(
        runId,
        { total_tokens: 999 },
        { provider: 'codex', chatId: 'ensemble-chat' }
      )
    ).toBe(false)
    expect(
      harness.orchestrator.reportParticipantTokenUsage(
        runId,
        { total_tokens: 999 },
        { provider: 'claude', chatId: 'different-chat' }
      )
    ).toBe(false)

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: runId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    expect(telemetryEvents.at(-1)).toEqual({
      type: 'clear',
      chatId: 'ensemble-chat',
      roundId: expect.any(String),
      participantId: 'claude',
      runId
    })
  })

  it('keeps the working odometer monotonic while atomic context can shrink', async () => {
    let now = 1_000
    const telemetryEvents: ParticipantWorkingTelemetryEvent[] = []
    const harness = makeHarness({
      now: () => now,
      onParticipantWorkingTelemetry: (event) => telemetryEvents.push(event)
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Track atomic context.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runId = harness.dispatched[0].appRunId!

    const first = withContextUsageSnapshot(
      { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      { source: 'provider-last-invocation', precision: 'exact' }
    )
    harness.orchestrator.reportParticipantTokenUsage(runId, first, {
      provider: 'claude',
      chatId: 'ensemble-chat'
    })

    now += 500
    const smallerAtomic = withContextUsageSnapshot(
      { input_tokens: 80, output_tokens: 5, total_tokens: 85 },
      { source: 'provider-last-invocation', precision: 'exact' }
    )[TASKWRAITH_CONTEXT_USAGE_KEY]
    harness.orchestrator.reportParticipantTokenUsage(
      runId,
      {
        input_tokens: 60,
        output_tokens: 4,
        total_tokens: 64,
        [TASKWRAITH_CONTEXT_USAGE_KEY]: smallerAtomic
      },
      { provider: 'claude', chatId: 'ensemble-chat' }
    )

    const snapshots = telemetryEvents.filter(
      (event): event is Extract<ParticipantWorkingTelemetryEvent, { type: 'snapshot' }> =>
        event.type === 'snapshot'
    )
    expect(snapshots.at(-1)).toMatchObject({
      totalTokens: 120,
      contextUsage: {
        contextTokens: 85,
        precision: 'exact'
      }
    })
  })

  it('forwards an explicit exact-zero context for an active participant', async () => {
    const telemetryEvents: ParticipantWorkingTelemetryEvent[] = []
    const harness = makeHarness({
      onParticipantWorkingTelemetry: (event) => telemetryEvents.push(event)
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Track zero context.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runId = harness.dispatched[0].appRunId!

    expect(
      harness.orchestrator.reportParticipantTokenUsage(
        runId,
        {
          [TASKWRAITH_CONTEXT_USAGE_KEY]: {
            observedAt: 1,
            contextTokens: 0,
            totalTokens: 0,
            inputTokens: 0,
            freshInputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            outputTokens: 0,
            visibleOutputTokens: 0,
            reasoningTokens: 0,
            toolUsePromptTokens: 0,
            unclassifiedTokens: 0,
            source: 'provider-compaction',
            precision: 'exact'
          }
        },
        { provider: 'claude', chatId: 'ensemble-chat' }
      )
    ).toBe(true)
    expect(telemetryEvents.at(-1)).toMatchObject({
      type: 'snapshot',
      totalTokens: 0,
      contextUsage: {
        contextTokens: 0,
        source: 'provider-compaction',
        precision: 'exact'
      }
    })
  })

  it('markRunExited finalizes a clean exit as answered when content streamed, else skipped', async () => {
    // A seat that streamed its answer and then exited 0 (e.g. after the Ollama
    // retry-ceiling finalize, where the exit can beat the result event) must NOT
    // be mislabeled 'skipped' — the turn would vanish from the panel.
    const withContent = makeHarness()
    withContent.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Do the work.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(withContent.dispatched).toHaveLength(1))
    const runId = withContent.dispatched[0].appRunId!
    withContent.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: runId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'Here is my finished answer.' }
    )
    expect(withContent.orchestrator.markRunExited(runId, 0)).toBe(true)
    const answered = (withContent.chat.ensemble?.activeRound?.participants || []).find(
      (p) => p.participantId === 'claude'
    )
    expect(answered?.status).toBe('answered')

    // A clean exit with NO streamed content still resolves 'skipped' (unchanged).
    const noContent = makeHarness()
    noContent.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Do the work.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(noContent.dispatched).toHaveLength(1))
    expect(noContent.orchestrator.markRunExited(noContent.dispatched[0].appRunId!, 0)).toBe(true)
    const skipped = (noContent.chat.ensemble?.activeRound?.participants || []).find(
      (p) => p.participantId === 'claude'
    )
    expect(skipped?.status).toBe('skipped')
  })

  it('keeps Kimi Wire provisional success active so a late failure wins', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'kimi',
        provider: 'kimi',
        enabled: true,
        role: 'KimiSeat',
        instructions: 'Answer once.',
        order: 1,
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Report status.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runId = harness.dispatched[0].appRunId!
    const route = { appRunId: runId, appChatId: 'ensemble-chat' }

    expect(
      harness.orchestrator.handleProviderOutput('kimi', route, {
        type: 'result',
        subtype: 'success',
        status: 'success',
        provider: 'kimi',
        fallback: false,
        stats: { duration_ms: 100 }
      })
    ).toBe(true)
    expect(harness.chat.ensemble?.activeRound?.status).toBe('running')
    expect(
      harness.chat.messages.some((message) => message.content.includes('KimiSeat skipped.'))
    ).toBe(false)

    harness.orchestrator.handleProviderOutput('kimi', route, {
      type: 'result',
      status: 'failed',
      provider: 'kimi',
      fallback: false,
      stats: { duration_ms: 125 }
    })
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    expect(harness.chat.ensemble?.activeRound?.participants[0].status).toBe('failed')
    expect(
      harness.chat.messages.some((message) => message.content.includes('KimiSeat failed.'))
    ).toBe(true)
  })

  it('freezes participant stage role on dispatch payloads and chat runs', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.participants[0].stageRole = 'worker'
    const harness = makeHarness({ initialChat })

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Please review and implement.',
      event: { sender: {} as Electron.WebContents }
    })

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun).toMatchObject({
      participantId: 'claude',
      role: 'Reviewer',
      stageRole: 'worker'
    })
    expect(harness.chat.runs[0]).toMatchObject({
      ensembleParticipantId: 'claude',
      ensembleRole: 'Reviewer',
      ensembleStageRole: 'worker'
    })

    harness.chat.ensemble!.participants[0].stageRole = 'reviewer'
    expect(harness.chat.runs[0]).toMatchObject({
      ensembleParticipantId: 'claude',
      ensembleStageRole: 'worker'
    })
  })

  it('stamps pooled-agent identity onto ensemble runs and messages', async () => {
    const chat = makeChat()
    const pooledAgentIdentity = {
      schemaVersion: 1 as const,
      agentId: 'pooled-agent-cactus',
      nickname: 'Circuit Cactus',
      iconKind: 'asset' as const,
      assetKey: 'pool:circuit-cactus',
      hue: 139,
      brightness: 64,
      accent: '#41F27A',
      hueEnabled: true
    }
    chat.ensemble!.participants[0] = {
      ...chat.ensemble!.participants[0],
      pooledAgentId: pooledAgentIdentity.agentId,
      pooledAgentIdentity
    }
    const harness = makeHarness({ initialChat: chat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Please review.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.chat.runs[0]).toMatchObject({
      pooledAgentId: 'pooled-agent-cactus',
      pooledAgentIdentity
    })

    harness.orchestrator.handleProviderOutput(
      'claude',
      {
        appRunId: harness.dispatched[0].appRunId,
        appChatId: 'ensemble-chat'
      },
      { type: 'content', text: 'Reviewed.' }
    )

    await vi.waitFor(() =>
      expect(participantContentMessage(harness)?.metadata?.pooledAgentIdentity).toEqual(
        pooledAgentIdentity
      )
    )
    expect(participantContentMessage(harness)?.metadata?.pooledAgentId).toBe('pooled-agent-cactus')
  })

  it('threads shared-history budget metadata into Ollama participant runs', async () => {
    const chat = makeChat()
    chat.ensemble = {
      ...chat.ensemble!,
      ensembleContextChars: 120_000,
      participants: [
        {
          id: 'ollama-worker',
          provider: 'ollama',
          enabled: true,
          role: 'Local Worker',
          instructions: 'Work locally.',
          order: 1,
          model: 'ornith:35b',
          permissionPresetId: 'read_only'
        }
      ]
    }
    const harness = makeHarness({ initialChat: chat })

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Use the local worker.',
      event: { sender: {} as Electron.WebContents }
    })

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun).toMatchObject({
      participantId: 'ollama-worker',
      provider: 'ollama',
      ensembleContextChars: 120_000,
      ensembleContextTurns: 8
    })
  })

  // PR6 — ensemble media parity: agent-produced image (media_refs) is routed by
  // appRunId to the right participant's content message (the renderer path is
  // suppressed for ensemble because it can't route by runId).
  function imageRef(runId: string, sha = 'abc123') {
    return {
      id: `${runId}:tool-image:${sha}`,
      kind: 'image',
      format: 'raster',
      source: 'tool_result',
      name: 'tool image 1',
      mimeType: 'image/png',
      sha256: sha,
      assetId: `run:${runId}:tool-image:${sha}`,
      thumbnail: { dataBase64: 'iVBORw0KGgo=', mimeType: 'image/png' },
      status: 'available'
    }
  }
  function participantContentMessage(harness: ReturnType<typeof makeHarness>) {
    return harness.chat.messages.find(
      (m) => m.role === 'assistant' && m.metadata?.kind === 'ensembleParticipant'
    )
  }

  it('stamps a proposed plan card on the ensemble plan owner message', async () => {
    const chat = makeChat()
    chat.workflowMode = 'plan'
    chat.ensemble!.bossmanParticipantId = 'claude'
    const harness = makeHarness({ initialChat: chat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan this.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runId = harness.dispatched[0].appRunId!

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: runId, appChatId: 'ensemble-chat' },
      {
        type: 'content',
        text: 'Here is the plan.\n<proposed_plan>\n## Build it\n- Add the hook\n</proposed_plan>\nReady.'
      }
    )

    await vi.waitFor(() =>
      expect(participantContentMessage(harness)?.metadata?.proposedPlan).toBeTruthy()
    )
    const message = participantContentMessage(harness)
    expect(message?.content).toBe('Here is the plan.\n\nReady.')
    expect(message?.metadata?.proposedPlan).toEqual({
      title: 'Build it',
      body: '## Build it\n- Add the hook',
      status: 'pending'
    })
  })

  it('does not stamp proposed plan cards from non-owner ensemble participants', async () => {
    const chat = makeChat()
    chat.workflowMode = 'plan'
    chat.ensemble!.bossmanParticipantId = 'codex'
    const harness = makeHarness({ initialChat: chat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan this.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runId = harness.dispatched[0].appRunId!

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: runId, appChatId: 'ensemble-chat' },
      {
        type: 'content',
        text: '<proposed_plan>\n## Wrong owner\n- Should stay plain\n</proposed_plan>'
      }
    )

    await vi.waitFor(() => expect(participantContentMessage(harness)).toBeTruthy())
    const message = participantContentMessage(harness)
    expect(message?.metadata?.proposedPlan).toBeUndefined()
    expect(message?.content).toContain('<proposed_plan>')
  })

  it('does not stamp proposed plan cards outside plan workflow', async () => {
    const chat = makeChat()
    chat.workflowMode = 'normal'
    chat.ensemble!.bossmanParticipantId = 'claude'
    const harness = makeHarness({ initialChat: chat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Summarize this.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runId = harness.dispatched[0].appRunId!

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: runId, appChatId: 'ensemble-chat' },
      {
        type: 'content',
        text: '<proposed_plan>\n## Should stay plain\n- Not a plan workflow\n</proposed_plan>'
      }
    )

    await vi.waitFor(() => expect(participantContentMessage(harness)).toBeTruthy())
    const message = participantContentMessage(harness)
    expect(message?.metadata?.proposedPlan).toBeUndefined()
    expect(message?.content).toContain('<proposed_plan>')
  })

  it('preserves proposed plan decision status across ensemble message re-flushes', async () => {
    const chat = makeChat()
    chat.workflowMode = 'plan'
    chat.ensemble!.bossmanParticipantId = 'claude'
    const harness = makeHarness({ initialChat: chat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan this.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runId = harness.dispatched[0].appRunId!

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: runId, appChatId: 'ensemble-chat' },
      {
        type: 'content',
        text: '<proposed_plan>\n## Keep status\n- Preserve the decision\n</proposed_plan>'
      }
    )
    await vi.waitFor(() =>
      expect(participantContentMessage(harness)?.metadata?.proposedPlan?.status).toBe('pending')
    )
    const plan = participantContentMessage(harness)?.metadata?.proposedPlan
    expect(plan).toBeTruthy()
    plan!.status = 'approved'

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: runId, appChatId: 'ensemble-chat' },
      { type: 'content', text: '\nFollow-up note.' }
    )

    await vi.waitFor(() =>
      expect(participantContentMessage(harness)?.content).toContain('Follow-up note.')
    )
    expect(participantContentMessage(harness)?.metadata?.proposedPlan?.status).toBe('approved')
  })

  it('attaches agent-produced media_refs to the participant content message', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Blur the screenshot.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runId = harness.dispatched[0].appRunId!

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: runId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'Here is the blurred screenshot.' }
    )
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: runId, appChatId: 'ensemble-chat' },
      { type: 'media_refs', mediaRefs: [imageRef(runId)] }
    )

    await vi.waitFor(() =>
      expect(participantContentMessage(harness)?.metadata?.mediaRefs).toBeTruthy()
    )
    const refs = participantContentMessage(harness)?.metadata?.mediaRefs as Array<{ id: string }>
    expect(refs).toHaveLength(1)
    expect(refs[0].id).toBe(`${runId}:tool-image:abc123`)
  })

  it('de-dupes repeated media_refs (re-emit / re-flush safe)', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Blur it.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runId = harness.dispatched[0].appRunId!
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: runId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'Done.' }
    )
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: runId, appChatId: 'ensemble-chat' },
      { type: 'media_refs', mediaRefs: [imageRef(runId)] }
    )
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: runId, appChatId: 'ensemble-chat' },
      { type: 'media_refs', mediaRefs: [imageRef(runId)] }
    )
    await vi.waitFor(() =>
      expect(participantContentMessage(harness)?.metadata?.mediaRefs).toBeTruthy()
    )
    expect(participantContentMessage(harness)?.metadata?.mediaRefs).toHaveLength(1)
  })

  it('survives media_refs arriving before any content (carried immediately, migrates to prose once content exists)', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Generate then describe.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runId = harness.dispatched[0].appRunId!
    // media before any text — must not crash and must not be lost. With no
    // prose yet, it rides a synthesized empty-content carrier so it renders
    // immediately rather than being dropped.
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: runId, appChatId: 'ensemble-chat' },
      { type: 'media_refs', mediaRefs: [imageRef(runId)] }
    )
    await vi.waitFor(() =>
      expect(participantContentMessage(harness)?.metadata?.mediaRefs).toBeTruthy()
    )
    expect(participantContentMessage(harness)?.content).toBe('')
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: runId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'Here is the generated image.' }
    )
    await vi.waitFor(() =>
      expect(participantContentMessage(harness)?.content).toBe('Here is the generated image.')
    )
    // The ref migrated onto the real prose message; the synthetic carrier is
    // gone (no duplicate assistant messages).
    expect(participantContentMessage(harness)?.metadata?.mediaRefs).toHaveLength(1)
    expect(
      harness.chat.messages.filter(
        (m) => m.role === 'assistant' && m.metadata?.kind === 'ensembleParticipant'
      )
    ).toHaveLength(1)
  })

  // Producer-tool media parity: a participant whose terminal action is a
  // producer tool (audio_extract / transcode_audio / transcode_video) with NO
  // surrounding prose has a tool-only timeline, so the stamp loop finds no
  // assistant content message. The trusted refs (appendTrustedMediaRefs) must
  // still render via a synthesized empty-content carrier message rather than
  // being silently dropped.
  function videoRef(runId: string, sha = 'vid123'): TranscriptMediaRef {
    return {
      id: `${runId}:produced-video:${sha}`,
      kind: 'video',
      format: 'container',
      source: 'generated',
      name: 'produced.mp4',
      mimeType: 'video/mp4',
      sha256: sha,
      status: 'available'
    }
  }

  it('renders trusted producer media when the terminal action is a tool with no prose', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Transcode the recording.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runId = harness.dispatched[0].appRunId!

    // Tool-only timeline: a producer tool call, no content fragment at all.
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: runId, appChatId: 'ensemble-chat' },
      { type: 'tool_use', tool_id: 'tool-1', tool_name: 'transcode_video' }
    )
    // No assistant content message exists yet — the stamp loop would have
    // nothing to attach to.
    expect(participantContentMessage(harness)).toBeUndefined()

    // Trusted ref injected in-process (index.ts injectTrustedMediaRefs path),
    // which merges onto run.mediaRefs and flushes.
    harness.orchestrator.appendTrustedMediaRefs(runId, [videoRef(runId)])

    await vi.waitFor(() =>
      expect(participantContentMessage(harness)?.metadata?.mediaRefs).toBeTruthy()
    )
    const carrier = participantContentMessage(harness)!
    expect(carrier.content).toBe('')
    expect(carrier.metadata?.kind).toBe('ensembleParticipant')
    const refs = carrier.metadata?.mediaRefs as Array<{ id: string }>
    expect(refs).toHaveLength(1)
    expect(refs[0].id).toBe(`${runId}:produced-video:vid123`)
    // Exactly one assistant carrier — no duplicate synthetic messages.
    expect(
      harness.chat.messages.filter(
        (m) => m.role === 'assistant' && m.metadata?.kind === 'ensembleParticipant'
      )
    ).toHaveLength(1)
  })

  it('does not synthesize a duplicate carrier when a real assistant message exists', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Transcode and explain.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runId = harness.dispatched[0].appRunId!
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: runId, appChatId: 'ensemble-chat' },
      { type: 'tool_use', tool_id: 'tool-1', tool_name: 'transcode_video' }
    )
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: runId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'Here is the transcoded clip.' }
    )
    harness.orchestrator.appendTrustedMediaRefs(runId, [videoRef(runId)])

    await vi.waitFor(() =>
      expect(participantContentMessage(harness)?.metadata?.mediaRefs).toBeTruthy()
    )
    const assistantMsgs = harness.chat.messages.filter(
      (m) => m.role === 'assistant' && m.metadata?.kind === 'ensembleParticipant'
    )
    // The real prose message carries the ref; no empty synthetic carrier.
    expect(assistantMsgs).toHaveLength(1)
    expect(assistantMsgs[0].content).toBe('Here is the transcoded clip.')
    expect(assistantMsgs[0].metadata?.mediaRefs).toHaveLength(1)
  })

  // Branch-3 ownership predicate behind index.ts injectTrustedMediaRefs's
  // boolean return: getParticipantIdForRun resolves a non-null participant id
  // when this orchestrator OWNS appRunId (⇒ injectTrustedMediaRefs returns true,
  // trusted lane), and null when no run is held (⇒ false, which drives the
  // dedicated foreground-solo-Codex IPC fallback). For non-codex providers the
  // run is always map-owned here, so the fallback never fires — zero change.
  it('getParticipantIdForRun reports ensemble ownership (true) vs miss (false) for the trusted-AV boolean', async () => {
    const harness = makeHarness()
    // No round started yet: an arbitrary id is unowned.
    expect(harness.orchestrator.getParticipantIdForRun('never-started-run')).toBeNull()
    expect(harness.orchestrator.getParticipantIdForRun(undefined)).toBeNull()

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Transcode the recording.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runId = harness.dispatched[0].appRunId!

    // Owned run ⇒ non-null participant id ⇒ injectTrustedMediaRefs branch-3 true.
    expect(harness.orchestrator.getParticipantIdForRun(runId)).not.toBeNull()
    // An unrelated id stays a miss ⇒ false ⇒ solo-Codex IPC fallback.
    expect(harness.orchestrator.getParticipantIdForRun(`${runId}-other`)).toBeNull()
  })

  it('persists an active-round checkpoint and retires it when the round completes', async () => {
    const persisted: Array<{ chat: ChatRecord; reason: string }> = []
    const completed: Array<{ chatId: string; roundId: string; status: string }> = []
    const harness = makeHarness({
      persistSessionCheckpoint: (chat, reason) => {
        persisted.push({ chat, reason })
      },
      completeSessionCheckpoint: (chatId, roundId, status) => {
        completed.push({ chatId, roundId, status })
      }
    })

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Checkpoint this round.',
      event: { sender: {} as Electron.WebContents }
    })

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(persisted.some((entry) => entry.reason === 'round-started')).toBe(true)
    expect(persisted[persisted.length - 1].chat.ensemble?.activeRound?.status).toBe('running')
    const roundId = harness.chat.ensemble!.activeRound!.roundId

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 10 } }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 5 } }
    )

    await vi.waitFor(() =>
      expect(completed).toContainEqual({ chatId: 'ensemble-chat', roundId, status: 'completed' })
    )
    expect(harness.chat.ensemble?.activeRound?.status).toBe('completed')
  })

  it('accumulates Ollama participant tokenTotals from camelCase run stats', async () => {
    const chat = makeChat()
    chat.ensemble!.participants = [
      {
        id: 'ollama-1',
        provider: 'ollama',
        enabled: true,
        role: 'Local',
        instructions: 'Work locally.',
        order: 1,
        model: 'qwen3:4b-instruct',
        permissionPresetId: 'read_only'
      }
    ]
    const harness = makeHarness({ initialChat: chat })

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Summarize the repo.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    harness.orchestrator.handleProviderOutput(
      'ollama',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      {
        type: 'result',
        status: 'success',
        stats: { inputTokens: 2500, outputTokens: 1200, totalTokens: 3700, durationMs: 4100 }
      }
    )
    await vi.waitFor(() =>
      expect(harness.chat.ensemble?.participants[0]?.tokenTotals).toMatchObject({
        input_tokens: 2500,
        output_tokens: 1200,
        total_tokens: 3700,
        duration_ms: 4100
      })
    )
  })

  it('1.0.7 — records participant usage into the shared store on run completion', async () => {
    const recorded: Array<Omit<UsageRecord, 'id' | 'timestamp'>> = []
    const harness = makeHarness({
      recordUsage: (entry) => {
        recorded.push(entry)
      }
    })

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Do the work.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 120, duration_ms: 4200 } }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

    // The first participant's usage was recorded with its provider + tokens +
    // duration so it counts toward the wall-clock / heatmaps / provider totals.
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({
      provider: 'claude',
      chatId: 'ensemble-chat',
      usageKind: 'run',
      totalTokens: 120,
      durationMs: 4200,
      ensemblePromptKind: 'full',
      ensembleDynamicStateSent: true,
      ensembleDynamicStateReceiptState: 'missing'
    })
    expect(recorded[0].ensembleDynamicStateBlockChars).toBeGreaterThan(0)
  })

  it('records a matched dynamic-state receipt as sent when the accepted prompt is full', async () => {
    const recorded: Array<Omit<UsageRecord, 'id' | 'timestamp'>> = []
    const chat = makeChat()
    const snapshot = buildEnsembleDynamicStateSnapshot(chat, chat.ensemble!)
    chat.ensemble!.participants[0].promptDynamicStateVersion = snapshot.version
    const harness = makeHarness({
      initialChat: chat,
      recordUsage: (entry) => recorded.push(entry)
    })

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Send a full briefing.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 12 } }
    )

    await vi.waitFor(() => expect(recorded).toHaveLength(1))
    expect(recorded[0]).toMatchObject({
      ensemblePromptKind: 'full',
      ensembleDynamicStateBlockChars: snapshot.block.length,
      ensembleDynamicStateSent: true,
      ensembleDynamicStateReceiptState: 'matched'
    })
  })

  it('records a matched dynamic-state snapshot as omitted on an accepted slim prompt', async () => {
    const previous = process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME
    process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME = '1'
    try {
      const recorded: Array<Omit<UsageRecord, 'id' | 'timestamp'>> = []
      const chat = makeChat()
      const snapshot = buildEnsembleDynamicStateSnapshot(chat, chat.ensemble!)
      Object.assign(chat.ensemble!.participants[0], {
        linkedProviderSessionId: 'claude-session-1',
        promptShellVersion: computeEnsemblePromptShellStamp(chat.ensemble!),
        promptDynamicStateVersion: snapshot.version
      })
      const harness = makeHarness({
        initialChat: chat,
        recordUsage: (entry) => recorded.push(entry)
      })

      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Continue from the existing session.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
      expect(harness.dispatched[0].ensembleRun?.promptMode).toBe('slim')
      harness.orchestrator.handleProviderOutput(
        'claude',
        { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success', stats: { total_tokens: 12 } }
      )

      await vi.waitFor(() => expect(recorded).toHaveLength(1))
      expect(recorded[0]).toMatchObject({
        ensemblePromptKind: 'slim',
        ensembleDynamicStateBlockChars: snapshot.block.length,
        ensembleDynamicStateSent: false,
        ensembleDynamicStateReceiptState: 'matched'
      })
    } finally {
      if (previous === undefined) delete process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME
      else process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME = previous
    }
  })

  it('records a changed dynamic-state snapshot as sent on an accepted slim prompt', async () => {
    const previous = process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME
    process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME = '1'
    try {
      const recorded: Array<Omit<UsageRecord, 'id' | 'timestamp'>> = []
      const chat = makeChat()
      const snapshot = buildEnsembleDynamicStateSnapshot(chat, chat.ensemble!)
      Object.assign(chat.ensemble!.participants[0], {
        linkedProviderSessionId: 'claude-session-1',
        promptShellVersion: computeEnsemblePromptShellStamp(chat.ensemble!),
        promptDynamicStateVersion: 'ensemble-dynamic-v1:stale'
      })
      const harness = makeHarness({
        initialChat: chat,
        recordUsage: (entry) => recorded.push(entry)
      })

      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Continue with updated state.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
      expect(harness.dispatched[0].ensembleRun?.promptMode).toBe('slim')
      harness.orchestrator.handleProviderOutput(
        'claude',
        { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success', stats: { total_tokens: 12 } }
      )

      await vi.waitFor(() => expect(recorded).toHaveLength(1))
      expect(recorded[0]).toMatchObject({
        ensemblePromptKind: 'slim',
        ensembleDynamicStateBlockChars: snapshot.block.length,
        ensembleDynamicStateSent: true,
        ensembleDynamicStateReceiptState: 'changed'
      })
    } finally {
      if (previous === undefined) delete process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME
      else process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME = previous
    }
  })

  it('records a missing dynamic-state receipt as sent on an accepted slim prompt', async () => {
    const previous = process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME
    process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME = '1'
    try {
      const recorded: Array<Omit<UsageRecord, 'id' | 'timestamp'>> = []
      const chat = makeChat()
      const snapshot = buildEnsembleDynamicStateSnapshot(chat, chat.ensemble!)
      Object.assign(chat.ensemble!.participants[0], {
        linkedProviderSessionId: 'claude-session-1',
        promptShellVersion: computeEnsemblePromptShellStamp(chat.ensemble!)
      })
      const harness = makeHarness({
        initialChat: chat,
        recordUsage: (entry) => recorded.push(entry)
      })

      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Continue without a dynamic-state receipt.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
      expect(harness.dispatched[0].ensembleRun?.promptMode).toBe('slim')
      harness.orchestrator.handleProviderOutput(
        'claude',
        { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success', stats: { total_tokens: 12 } }
      )

      await vi.waitFor(() => expect(recorded).toHaveLength(1))
      expect(recorded[0]).toMatchObject({
        ensemblePromptKind: 'slim',
        ensembleDynamicStateBlockChars: snapshot.block.length,
        ensembleDynamicStateSent: true,
        ensembleDynamicStateReceiptState: 'missing'
      })
    } finally {
      if (previous === undefined) delete process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME
      else process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME = previous
    }
  })

  it('records fan-out lane prompts as full even when their prior dynamic receipt matches', async () => {
    const recorded: Array<Omit<UsageRecord, 'id' | 'timestamp'>> = []
    const chat = makeChat()
    chat.ensemble!.fanoutPolicy = 'read_only'
    chat.ensemble!.participants = [
      {
        id: 'codex',
        provider: 'codex',
        enabled: true,
        role: 'Worker',
        instructions: 'Work.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'claude',
        provider: 'claude',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review.',
        order: 2,
        permissionPresetId: 'read_only'
      }
    ]
    const snapshot = buildEnsembleDynamicStateSnapshot(chat, chat.ensemble!)
    chat.ensemble!.participants[1].promptDynamicStateVersion = snapshot.version
    const harness = makeHarness({
      initialChat: chat,
      recordUsage: (entry) => recorded.push(entry)
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Start work and fan out review.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const fanout = harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
      targets: ['Reviewer'],
      prompt: 'Review in parallel.'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    const lane = harness.dispatched[1]
    expect(lane.ensembleRun?.promptMode).toBe('full')
    harness.orchestrator.handleProviderOutput(
      lane.provider,
      { appRunId: lane.appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 12 } }
    )
    await fanout

    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({
      provider: 'claude',
      ensemblePromptKind: 'full',
      ensembleDynamicStateBlockChars: snapshot.block.length,
      ensembleDynamicStateSent: true,
      ensembleDynamicStateReceiptState: 'matched'
    })
  })

  it('1.0.7 — does NOT double-record usage already recorded upstream', async () => {
    const recorded: Array<Omit<UsageRecord, 'id' | 'timestamp'>> = []
    const harness = makeHarness({
      recordUsage: (entry) => {
        recorded.push(entry)
      }
    })

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Do the work.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      {
        type: 'result',
        status: 'success',
        stats: { total_tokens: 50, duration_ms: 1000, _taskwraith_usage_recorded: true }
      }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

    expect(recorded).toHaveLength(0)
  })

  it('1.0.7 — emits UNIQUE ids for every round-status message in a round', async () => {
    // Regression: pre-1.0.7 every status line in a round shared the id
    // `ensemble-round-status-${roundId}`, so a round that emitted MULTIPLE
    // status lines (each yield/handoff appends one) produced several messages
    // with the SAME id → duplicate React keys + a collision in the transcript's
    // id-keyed measurement Map → scrambled render order (old status lines
    // surfacing above newer messages, exposed once the transcript virtualised).
    // Each appendRoundStatus call must now mint a distinct id.
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Split this work.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    // Emit several round-status lines on the SAME active run+round — the exact
    // shape that pre-1.0.7 collided on `ensemble-round-status-${roundId}`.
    // `appendStatusForRun` is the public route through the private
    // `appendRoundStatus` (the `ensembleRoundStatus`-kind emitter).
    const runId = harness.dispatched[0].appRunId!
    expect(harness.orchestrator.appendStatusForRun(runId, 'Handoff 1/12.')).toBe(true)
    expect(harness.orchestrator.appendStatusForRun(runId, 'Handoff 2/12.')).toBe(true)
    expect(harness.orchestrator.appendStatusForRun(runId, 'Yielded back to gemini (gemini).')).toBe(
      true
    )

    const statusIds = harness.chat.messages
      .filter((m) => m.metadata?.kind === 'ensembleRoundStatus')
      .map((m) => m.id)
    // Three status messages, all with distinct ids (pre-1.0.7 they'd be equal).
    expect(statusIds.length).toBe(3)
    expect(new Set(statusIds).size).toBe(3)
    // And ALL message ids in the chat are unique — the actual invariant the
    // transcript renderer + measurement cache rely on.
    const allIds = harness.chat.messages.map((m) => m.id)
    expect(new Set(allIds).size).toBe(allIds.length)
  })

  it('dispatches duplicate-provider participants by participant id', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.maxParticipants = 6
    harness.chat.ensemble!.participants = [
      {
        id: 'codex-primary',
        provider: 'codex',
        enabled: true,
        role: 'Worker',
        instructions: 'Work with the primary model.',
        order: 1,
        model: 'gpt-5.5',
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'codex-review',
        provider: 'codex',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review with the alternate model.',
        order: 2,
        model: 'gpt-5.4',
        permissionPresetId: 'read_only'
      }
    ]

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Run both Codex participants.',
      event: { sender: {} as Electron.WebContents }
    })

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0]).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.5',
      ensembleRun: { participantId: 'codex-primary', role: 'Worker' }
    })

    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 5 } }
    )

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1]).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.4',
      ensembleRun: { participantId: 'codex-review', role: 'Reviewer' }
    })
  })

  it('lists active ensemble participants for the calling run', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'List the panel.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = harness.orchestrator.listParticipantsForRun(harness.dispatched[0].appRunId)
    expect(result.ok).toBe(true)
    expect(result.activeParticipantId).toBe('claude')
    expect(result.participants?.map((participant) => participant.id)).toEqual(['claude', 'codex'])
    expect(result.participants?.[0]).toMatchObject({
      id: 'claude',
      provider: 'claude',
      role: 'Reviewer',
      status: 'running',
      contextTokens: 0,
      contextWindow: 200_000,
      contextPercent: 0
    })
  })

  it('lists latest per-participant context usage for the calling run', async () => {
    const chat = makeChat()
    chat.ensemble!.participants[0].model = 'claude-opus-4-8-1m'
    chat.ensemble!.participants[1].model = 'gpt-5.5'
    chat.runs = [
      {
        runId: 'claude-old',
        provider: 'claude',
        ensembleParticipantId: 'claude',
        startedAt: '2026-05-24T00:00:00.000Z',
        status: 'success',
        stats: { input_tokens: 40_000, output_tokens: 1_000, total_tokens: 41_000 }
      },
      {
        runId: 'claude-new',
        provider: 'claude',
        ensembleParticipantId: 'claude',
        startedAt: '2026-05-24T00:05:00.000Z',
        status: 'success',
        stats: { input_tokens: 120_000, output_tokens: 3_000, total_tokens: 123_000 }
      },
      {
        runId: 'claude-statless-later',
        provider: 'claude',
        ensembleParticipantId: 'claude',
        startedAt: '2026-05-24T00:09:00.000Z',
        status: 'running'
      },
      {
        runId: 'codex-latest',
        provider: 'codex',
        ensembleParticipantId: 'codex',
        startedAt: '2026-05-24T00:03:00.000Z',
        status: 'success',
        stats: {
          inputTokens: 30_000,
          outputTokens: 1_000,
          totalTokens: 31_000,
          totalTokenLimit: 900_000
        }
      },
      {
        runId: 'codex-total-only-later',
        provider: 'codex',
        ensembleParticipantId: 'codex',
        startedAt: '2026-05-24T00:08:00.000Z',
        status: 'success',
        stats: { totalTokens: 99_000, totalTokenLimit: 700_000 }
      }
    ] as ChatRun[]
    const harness = makeHarness({ initialChat: chat })

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'List context.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = harness.orchestrator.listParticipantsForRun(harness.dispatched[0].appRunId)
    expect(result.ok).toBe(true)
    const byId = new Map(result.participants?.map((participant) => [participant.id, participant]))
    expect(byId.get('claude')).toMatchObject({
      contextTokens: 123_000,
      contextWindow: 1_000_000
    })
    expect(byId.get('claude')?.contextPercent).toBeCloseTo(12.3, 5)
    expect(byId.get('codex')).toMatchObject({
      contextTokens: 99_000,
      contextWindow: 700_000
    })
    expect(byId.get('codex')?.contextPercent).toBeCloseTo(14.142857, 5)
  })

  it('lists provider model catalog and quota bands for Boss roster edits', async () => {
    const chat = makeChat()
    chat.ensemble!.bossmanParticipantId = 'claude'
    chat.ensemble!.bossmanAutoApprovals = {
      enabled: true,
      mode: 'permission_preset_once',
      confirmedAt: '2026-05-24T00:00:00.000Z'
    }
    const harness = makeHarness({
      initialChat: chat,
      getProviderUsageSnapshot: (provider) =>
        provider === 'codex'
          ? {
              provider: 'codex',
              configured: true,
              source: 'codex-account',
              fetchedAt: '2026-05-24T00:00:00.000Z',
              windows: [
                {
                  id: 'weekly',
                  label: 'Weekly',
                  runs: 12,
                  totalTokens: 500_000,
                  limitLabel: '6% remaining',
                  trackingOnly: false,
                  usedPercent: 94
                }
              ]
            }
          : null
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'List choices.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = harness.orchestrator.listParticipantsForRun(harness.dispatched[0].appRunId)

    expect(result.ok).toBe(true)
    expect(result.bossmanParticipantId).toBe('claude')
    expect(result.bossmanAutoApprovalsEnabled).toBe(true)
    expect(result.rosterEditAllowed).toBe(true)
    const codex = result.availableProviders?.find((entry) => entry.provider === 'codex')
    expect(codex?.usage).toMatchObject({
      provider: 'codex',
      configured: true,
      worstBand: 'critical'
    })
    expect(codex?.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'gpt-5.5',
          label: 'GPT-5.5',
          contextWindow: 1_050_000,
          isDefault: true
        })
      ])
    )
    const claude = result.availableProviders?.find((entry) => entry.provider === 'claude')
    expect(claude?.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'claude-fable-5',
          contextWindow: 1_000_000,
          reasoningEfforts: expect.arrayContaining([expect.objectContaining({ id: 'medium' })])
        })
      ])
    )
  })

  function agentRosterPreset(): EnsembleRosterPreset {
    return {
      id: 'agent-roster-preset',
      name: 'Task-specific panel',
      createdAt: 1,
      updatedAt: 1,
      orchestrationMode: 'continuous',
      maxParticipants: 5,
      maxContinuationHops: 18,
      fanoutPolicy: 'all',
      ensembleContextChars: 96_000,
      participants: [
        {
          provider: 'claude',
          enabled: true,
          role: 'Boss',
          instructions: 'Own the result.',
          order: 1,
          isBossman: true,
          model: 'claude-sonnet-4-7',
          permissionPresetId: 'default'
        },
        {
          provider: 'codex',
          enabled: true,
          role: 'Captain',
          instructions: 'Cover the second lane.',
          order: 2,
          isSecondInCommand: true,
          model: 'gpt-5.6-terra',
          permissionPresetId: 'plan'
        },
        {
          provider: 'kimi',
          enabled: true,
          role: 'Scout',
          instructions: 'Map the relevant code.',
          order: 3,
          model: 'kimi-k2.7-code',
          permissionPresetId: 'read_only',
          stageRole: 'scout'
        }
      ]
    }
  }

  it('queues a Boss-imported roster preset and activates it after the round boundary', async () => {
    const chat = makeChat()
    chat.ensemble!.bossmanParticipantId = 'claude'
    chat.ensemble!.secondInCommandParticipantId = 'codex'
    const harness = makeHarness({ initialChat: chat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Set up the panel.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const imported = harness.orchestrator.rosterPresetImportForRun(harness.dispatched[0].appRunId, {
      preset: agentRosterPreset()
    })
    expect(imported).toMatchObject({
      ok: true,
      action: 'import_preset',
      presetName: 'Task-specific panel',
      deferred: true
    })
    expect(harness.chat.ensemble?.participants.map((participant) => participant.role)).toEqual([
      'Reviewer',
      'Worker'
    ])

    completeDispatchedRun(harness, 0)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    completeDispatchedRun(harness, 1)
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))

    expect(harness.chat.ensemble).toMatchObject({
      orchestrationMode: 'continuous',
      fanoutPolicy: 'all',
      maxContinuationHops: 18,
      ensembleContextChars: 96_000,
      bossmanParticipantId: 'claude',
      secondInCommandParticipantId: 'codex'
    })
    expect(harness.chat.ensemble?.participants.map((participant) => participant.role)).toEqual([
      'Boss',
      'Captain',
      'Scout'
    ])
  })

  it('lets the configured Captain import a roster while Boss is healthy but preserves Captain', async () => {
    const chat = makeChat()
    chat.ensemble!.participants = [
      { ...chat.ensemble!.participants[1], order: 1 },
      { ...chat.ensemble!.participants[0], order: 2 }
    ]
    chat.ensemble!.bossmanParticipantId = 'claude'
    chat.ensemble!.secondInCommandParticipantId = 'codex'
    const harness = makeHarness({ initialChat: chat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Refine the panel.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('codex')

    const imported = harness.orchestrator.rosterPresetImportForRun(harness.dispatched[0].appRunId, {
      preset: agentRosterPreset()
    })

    expect(imported.ok).toBe(true)
    expect(imported.message).toContain('Captain imported')
  })

  it('lets any active role-assigned participant link only itself to an Agent Pool entry', async () => {
    const harness = makeHarness({ initialChat: makeChat() })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Review.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runId = harness.dispatched[0].appRunId
    const candidate = harness.orchestrator.agentPoolRegistrationCandidateForRun(runId)
    expect(candidate).toMatchObject({ ok: true, participantId: 'claude' })
    if (!candidate.ok || !candidate.participant) throw new Error('Expected registration candidate')

    const result = harness.orchestrator.registerParticipantInAgentPoolForRun(runId, {
      expectedRole: candidate.participant.role,
      pooledAgentId: 'pooled-agent-reviewer',
      pooledAgentIdentity: {
        schemaVersion: 1,
        agentId: 'pooled-agent-reviewer',
        nickname: 'Reviewer',
        iconKind: 'seed',
        seed: 'pooled-agent-reviewer',
        hue: 120
      },
      mode: 'created'
    })

    expect(result).toMatchObject({ ok: true, participantId: 'claude', mode: 'created' })
    expect(
      harness.chat.ensemble?.participants.find((participant) => participant.id === 'claude')
    ).toMatchObject({
      pooledAgentId: 'pooled-agent-reviewer',
      pooledAgentIdentity: { nickname: 'Reviewer' }
    })
    expect(
      harness.chat.ensemble?.participants.find((participant) => participant.id === 'codex')
        ?.pooledAgentId
    ).toBeUndefined()
  })

  it('rejects Agent Pool registration when the assigned role exceeds 50 characters', async () => {
    const chat = makeChat()
    chat.ensemble!.participants[0].role = 'x'.repeat(51)
    const harness = makeHarness({ initialChat: chat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Review.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    expect(
      harness.orchestrator.agentPoolRegistrationCandidateForRun(harness.dispatched[0].appRunId)
    ).toMatchObject({
      ok: false,
      error: 'role_too_long'
    })
  })

  it('revalidates the participant role after the renderer registration round trip', async () => {
    const harness = makeHarness({ initialChat: makeChat() })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Review.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runId = harness.dispatched[0].appRunId
    const candidate = harness.orchestrator.agentPoolRegistrationCandidateForRun(runId)
    if (!candidate.ok || !candidate.participant) throw new Error('Expected registration candidate')
    const expectedRole = candidate.participant.role
    harness.chat.ensemble!.participants[0].role = 'Changed role'

    expect(
      harness.orchestrator.registerParticipantInAgentPoolForRun(runId, {
        expectedRole,
        pooledAgentId: 'pooled-agent-reviewer',
        pooledAgentIdentity: {
          schemaVersion: 1,
          agentId: 'pooled-agent-reviewer',
          nickname: 'Reviewer',
          iconKind: 'seed',
          seed: 'pooled-agent-reviewer',
          hue: 120
        },
        mode: 'created'
      })
    ).toMatchObject({ ok: false, error: 'stale_participant' })
  })

  it('rejects Captain roster edit while Boss is available', async () => {
    const chat = makeChat()
    chat.ensemble!.participants = [
      { ...chat.ensemble!.participants[0], order: 2 },
      { ...chat.ensemble!.participants[1], order: 1 }
    ]
    chat.ensemble!.bossmanParticipantId = 'claude'
    chat.ensemble!.secondInCommandParticipantId = 'codex'
    chat.ensemble!.bossmanAutoApprovals = {
      enabled: true,
      mode: 'permission_preset_once',
      confirmedAt: '2026-05-24T00:00:00.000Z'
    }
    const harness = makeHarness({ initialChat: chat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Continue.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('codex')

    const result = await harness.orchestrator.rosterEditForRun(harness.dispatched[0].appRunId, {
      action: 'edit_participant',
      targetParticipantId: 'claude',
      participant: { role: 'Primary' }
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('second_in_command_standby')
  })

  // ---- C1 — quota-aware Captain failover -----------------------------------
  // A hard provider quota wall finalizes as an ANSWERED Boss turn whose wall
  // text is content (not lastFailureReason), so the status checks miss it.
  // primaryBossUnavailable must flip the Boss soft-unavailable so Captain can
  // take authority — from the Boss's OWN terminal only (G1c), a template/envelope
  // classifier (G1), and WITHOUT disturbing worker roster order (soft-scope,
  // Captain G1b-v2).
  const startC1Harness = async () => {
    const chat = makeChat()
    chat.ensemble!.participants = [
      { ...chat.ensemble!.participants[0], order: 2 }, // claude = Boss (2nd)
      { ...chat.ensemble!.participants[1], order: 1 } // codex = Captain (1st ⇒ the caller run)
    ]
    chat.ensemble!.bossmanParticipantId = 'claude'
    chat.ensemble!.secondInCommandParticipantId = 'codex'
    chat.ensemble!.bossmanAutoApprovals = {
      enabled: true,
      mode: 'permission_preset_once',
      confirmedAt: '2026-05-24T00:00:00.000Z'
    }
    const harness = makeHarness({ initialChat: chat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Continue.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('codex')
    const roundId = harness.chat.ensemble!.activeRound!.roundId
    // Simulate the Boss having taken a terminal turn this round.
    harness.chat.ensemble!.activeRound!.participants.find(
      (p) => p.participantId === 'claude'
    )!.status = 'answered'
    return { harness, roundId, captainRunId: harness.dispatched[0].appRunId }
  }

  const pushParticipantTerminal = (
    harness: Awaited<ReturnType<typeof startC1Harness>>['harness'],
    roundId: string,
    participantId: string,
    content: string
  ) => {
    harness.chat.messages.push({
      id: `terminal-${participantId}-${harness.chat.messages.length}`,
      role: 'assistant',
      content,
      timestamp: '2026-07-12T00:00:00.000Z',
      metadata: {
        kind: 'ensembleParticipant',
        ensembleRoundId: roundId,
        ensembleParticipantId: participantId
      }
    })
  }

  it('C1: a quota-walled Boss makes Captain the resolved authority', async () => {
    const { harness, roundId, captainRunId } = await startC1Harness()
    pushParticipantTerminal(harness, roundId, 'claude', "You've hit your limit · resets Jul 14")
    const listed = harness.orchestrator.listParticipantsForRun(captainRunId)
    expect(listed.bossmanAuthorityRole).toBe('second_in_command')
    expect(listed.bossmanPrimaryUnavailableReason).toContain('quota wall')
  })

  it('C1 (pin): a healthy answered Boss keeps Captain in standby (unchanged)', async () => {
    const { harness, roundId, captainRunId } = await startC1Harness()
    pushParticipantTerminal(harness, roundId, 'claude', 'On it — WriteMain owns C1.')
    const listed = harness.orchestrator.listParticipantsForRun(captainRunId)
    expect(listed.bossmanAuthorityRole).toBeUndefined()
    // The exact standby error is unchanged on the authority-gated path.
    const edit = await harness.orchestrator.rosterEditForRun(captainRunId, {
      action: 'edit_participant',
      targetParticipantId: 'claude',
      participant: { role: 'Primary' }
    })
    expect(edit.ok).toBe(false)
    expect(edit.error).toBe('second_in_command_standby')
  })

  it('C1 G1: Boss prose mentioning "quota"/"resets" does NOT flip authority', async () => {
    const { harness, roundId, captainRunId } = await startC1Harness()
    pushParticipantTerminal(
      harness,
      roundId,
      'claude',
      'Let me check when the quota resets before we continue.'
    )
    expect(
      harness.orchestrator.listParticipantsForRun(captainRunId).bossmanAuthorityRole
    ).toBeUndefined()
  })

  it('C1 G1c: a PEER quoting the wall does not flip Boss authority', async () => {
    const { harness, roundId, captainRunId } = await startC1Harness()
    pushParticipantTerminal(harness, roundId, 'codex', "You've hit your limit · resets Jul 14") // peer quotes it
    pushParticipantTerminal(harness, roundId, 'claude', 'Proceeding — Captain, review C1.') // Boss healthy
    expect(
      harness.orchestrator.listParticipantsForRun(captainRunId).bossmanAuthorityRole
    ).toBeUndefined()
  })

  it('C1 soft-scope: a quota-walled Boss does NOT reorder the worker roster', async () => {
    const { harness, roundId, captainRunId } = await startC1Harness()
    const before = harness.orchestrator
      .listParticipantsForRun(captainRunId)
      .participants?.map((p) => `${p.id}:${p.order}`)
    pushParticipantTerminal(harness, roundId, 'claude', "You've hit your limit · resets Jul 14")
    const after = harness.orchestrator.listParticipantsForRun(captainRunId)
    // Authority flipped (soft-scope consumer) ...
    expect(after.bossmanAuthorityRole).toBe('second_in_command')
    // ... but the ordered roster the worker scheduler reads is byte-identical.
    expect(after.participants?.map((p) => `${p.id}:${p.order}`)).toEqual(before)
  })

  it('allows Captain roster edit when Boss is disabled for the round', async () => {
    const chat = makeChat()
    chat.ensemble!.participants = [
      { ...chat.ensemble!.participants[0], enabled: false },
      chat.ensemble!.participants[1],
      {
        id: 'kimi',
        provider: 'kimi',
        enabled: true,
        role: 'Analyst',
        instructions: 'Analyze.',
        order: 3,
        permissionPresetId: 'read_only'
      }
    ]
    chat.ensemble!.bossmanParticipantId = 'claude'
    chat.ensemble!.secondInCommandParticipantId = 'codex'
    chat.ensemble!.bossmanAutoApprovals = {
      enabled: true,
      mode: 'permission_preset_once',
      confirmedAt: '2026-05-24T00:00:00.000Z'
    }
    const harness = makeHarness({ initialChat: chat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Continue.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('codex')

    const listed = harness.orchestrator.listParticipantsForRun(harness.dispatched[0].appRunId)
    expect(listed.bossmanAuthorityRole).toBe('second_in_command')
    const result = await harness.orchestrator.rosterEditForRun(harness.dispatched[0].appRunId, {
      action: 'edit_participant',
      targetParticipantId: 'kimi',
      participant: { role: 'Quota Relief' }
    })

    expect(result.ok).toBe(true)
    expect(
      harness.chat.ensemble?.participants.find((participant) => participant.id === 'kimi')?.role
    ).toBe('Quota Relief')
  })

  it('selects one later available Captain when earlier configured Captains are unavailable', async () => {
    const chat = makeChat()
    chat.ensemble!.participants = [
      {
        id: 'boss',
        provider: 'claude',
        enabled: false,
        role: 'Boss',
        instructions: 'Lead when available.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'captain-one',
        provider: 'cursor',
        enabled: false,
        role: 'Captain One',
        instructions: 'First fallback.',
        order: 2,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'captain-two',
        provider: 'codex',
        enabled: true,
        role: 'Captain Two',
        instructions: 'Second fallback.',
        order: 3,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'captain-three',
        provider: 'kimi',
        enabled: true,
        role: 'Captain Three',
        instructions: 'Third fallback.',
        order: 4,
        permissionPresetId: 'workspace_write'
      }
    ]
    chat.ensemble!.bossmanParticipantId = 'boss'
    chat.ensemble!.captainParticipantIds = ['captain-one', 'captain-two', 'captain-three']
    chat.ensemble!.secondInCommandParticipantId = 'captain-one'
    const harness = makeHarness({ initialChat: chat })

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Continue with the first available authority seat.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('captain-two')

    const listed = harness.orchestrator.listParticipantsForRun(harness.dispatched[0].appRunId)
    expect(listed.captainParticipantIds).toEqual(['captain-one', 'captain-two', 'captain-three'])
    expect(listed.secondInCommandParticipantId).toBe('captain-one')
    expect(listed.bossmanAuthorityRole).toBe('second_in_command')
  })

  it('schedules a wakeup and resumes the same participant in the active round', async () => {
    const scheduled: EnsembleWakeupRecord[] = []
    const signRunPermissionPosture = vi.fn(() => 'd'.repeat(64))
    const harness = makeHarness({
      scheduleWakeupTimer: (wakeup) => scheduled.push(wakeup),
      signRunPermissionPosture
    })
    harness.chat.ensemble!.participants[0].stageRole = 'worker'
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Start and sleep if blocked.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const claudeRunId = harness.dispatched[0].appRunId!

    const scheduledResult = harness.orchestrator.scheduleWakeupForRun(claudeRunId, {
      delayMs: 60_000,
      reason: 'Waiting for logs.'
    })
    expect(scheduledResult.ok).toBe(true)
    const wakeup = scheduledResult.wakeup!
    expect(wakeup.stageRole).toBe('worker')
    expect(wakeup.permissionPosture).toMatchObject({
      approvalMode: 'plan',
      workflowMode: 'normal',
      presetId: 'read_only',
      readOnly: true,
      signature: 'd'.repeat(64),
      signaturePresent: true,
      context: {
        provider: 'claude',
        scope: 'workspace',
        appRunId: wakeup.wakeupId,
        appChatId: 'ensemble-chat',
        workflowMode: 'normal',
        promptHash: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    })
    expect(wakeup.dispatchReceipt).toMatchObject({
      schemaVersion: 1,
      runId: wakeup.wakeupId,
      provider: 'claude',
      source: 'scheduled',
      workspaceId: 'ws-1',
      chatId: 'ensemble-chat',
      ensembleParticipantId: 'claude',
      ensembleRole: 'Reviewer',
      ensembleStageRole: 'worker',
      permissionPresetId: 'read_only',
      readOnly: true,
      permissionPostureHash: wakeup.permissionPosture!.postureHash,
      permissionPostureSignaturePresent: true
    })
    expect(wakeup.dispatchReceipt?.receiptHash).toMatch(/^[a-f0-9]{64}$/)
    expect(signRunPermissionPosture).toHaveBeenCalledWith(
      'plan',
      expect.objectContaining({ presetId: 'read_only', readOnly: true }),
      expect.objectContaining({
        appRunId: wakeup.wakeupId,
        appChatId: 'ensemble-chat',
        prompt: 'Start and sleep if blocked.'
      })
    )
    expect(scheduled).toHaveLength(1)
    expect(harness.chat.ensemble?.activeRound?.participants[0].status).toBe('sleeping')
    expect(harness.chat.ensemble?.activeRound?.pendingWakeupIds).toEqual([scheduled[0].wakeupId])

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    const codexRunId = harness.dispatched[1].appRunId!
    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: codexRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )

    await vi.waitFor(() => {
      expect(harness.chat.ensemble?.activeRound?.status).toBe('running')
      expect(harness.chat.ensemble?.activeRound?.pendingWakeupIds).toEqual([scheduled[0].wakeupId])
    })
    harness.chat.ensemble!.participants[0].role = 'Mutated Reviewer'
    harness.chat.ensemble!.participants[0].stageRole = 'reviewer'
    expect(harness.orchestrator.handleWakeupFired(scheduled[0].wakeupId)).toBe(true)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[2].ensembleRun?.participantId).toBe('claude')
    expect(harness.dispatched[2].ensembleRun?.role).toBe('Reviewer')
    expect(harness.dispatched[2].ensembleRun?.stageRole).toBe('worker')
    expect(harness.dispatched[2].prompt).toContain('[Scheduled wakeup]')
    expect(harness.dispatched[2].prompt).toContain('Waiting for logs.')
    expect(
      harness.chat.messages.some((message) =>
        message.content.includes('no native provider session id was available')
      )
    ).toBe(true)
    // 1.0.5-N6 — The resumed run carries the warning on the
    // ChatRun itself so the RunCard surfaces a transcript-resumed
    // chip beside the status. Claude in the fixture has no
    // linkedProviderSessionId, so the warning is set.
    const claudeRuns = harness.chat.runs.filter((entry) => entry.ensembleParticipantId === 'claude')
    expect(claudeRuns.length).toBeGreaterThanOrEqual(2)
    expect(claudeRuns[claudeRuns.length - 1].ensembleSleepResumeWarning).toContain(
      'no native provider session id was available'
    )
  })

  it('resumes a frozen reviewer wakeup after the live roster clears the stage', async () => {
    const scheduled: EnsembleWakeupRecord[] = []
    const chat = makeChat()
    chat.ensemble!.participants = [
      {
        id: 'claude',
        provider: 'claude',
        enabled: true,
        role: 'Frozen Reviewer',
        instructions: 'Review.',
        order: 1,
        permissionPresetId: 'read_only',
        stageRole: 'reviewer'
      }
    ]
    const harness = makeHarness({
      initialChat: chat,
      scheduleWakeupTimer: (wakeup) => scheduled.push(wakeup)
    })

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Review after a pause.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun?.stageRole).toBe('reviewer')

    const scheduledResult = harness.orchestrator.scheduleWakeupForRun(
      harness.dispatched[0].appRunId,
      { delayMs: 60_000, reason: 'Waiting for worker output.' }
    )
    expect(scheduledResult.ok).toBe(true)
    expect(scheduledResult.wakeup?.stageRole).toBe('reviewer')
    expect(scheduledResult.wakeup?.dispatchReceipt?.ensembleStageRole).toBe('reviewer')
    await vi.waitFor(() =>
      expect(harness.chat.ensemble?.activeRound?.pendingWakeupIds).toEqual([scheduled[0].wakeupId])
    )

    harness.chat.ensemble!.participants[0].role = 'Live Worker'
    delete harness.chat.ensemble!.participants[0].stageRole
    expect(harness.orchestrator.handleWakeupFired(scheduled[0].wakeupId)).toBe(true)

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].ensembleRun).toMatchObject({
      participantId: 'claude',
      role: 'Frozen Reviewer',
      stageRole: 'reviewer'
    })
    expect(harness.dispatched[1].prompt).toContain('[Scheduled wakeup]')
    expect(harness.dispatched[1].prompt).toContain('Waiting for worker output.')
  })

  it('omits the resume warning when the participant has a linked provider session', async () => {
    // 1.0.5-N6 negative case. With a linkedProviderSessionId set,
    // the resume is native (Codex sessionId / Claude resumeId etc.)
    // — no warning needed.
    const scheduled: EnsembleWakeupRecord[] = []
    const harness = makeHarness({
      scheduleWakeupTimer: (wakeup) => scheduled.push(wakeup)
    })
    harness.chat.ensemble!.participants[0].linkedProviderSessionId = 'claude-session-abc'
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Start and sleep.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const claudeRunId = harness.dispatched[0].appRunId!
    harness.orchestrator.scheduleWakeupForRun(claudeRunId, { delayMs: 60_000 })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() =>
      expect(harness.chat.ensemble?.activeRound?.pendingWakeupIds).toHaveLength(1)
    )
    expect(harness.orchestrator.handleWakeupFired(scheduled[0].wakeupId)).toBe(true)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    const claudeRuns = harness.chat.runs.filter((entry) => entry.ensembleParticipantId === 'claude')
    expect(claudeRuns[claudeRuns.length - 1].ensembleSleepResumeWarning).toBeUndefined()
  })

  it('cancels persisted user-input wakeups before starting a new round', async () => {
    const cancelledTimers: string[] = []
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Start and sleep.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const scheduled = harness.orchestrator.scheduleWakeupForRun(harness.dispatched[0].appRunId, {
      delayMs: 60_000,
      reason: 'User will add context.'
    })
    expect(scheduled.ok).toBe(true)
    const wakeupId = scheduled.wakeup!.wakeupId

    const restarted = makeHarness({
      initialChat: harness.chat,
      cancelWakeupTimer: (id) => cancelledTimers.push(id)
    })
    restarted.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'New user input should cancel sleepers.',
      event: { sender: {} as Electron.WebContents }
    })

    expect(restarted.chat.ensemble?.wakeups?.[wakeupId]).toMatchObject({
      status: 'cancelled',
      message: 'cancelled by user input'
    })
    expect(cancelledTimers).toEqual([wakeupId])
    expect(restarted.chat.ensemble?.activeRound?.prompt).toBe(
      'New user input should cancel sleepers.'
    )
  })

  it('rejects a second pending wakeup for the same participant and round', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Sleep once.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runId = harness.dispatched[0].appRunId!
    const roundId = harness.chat.ensemble!.activeRound!.roundId
    harness.chat.ensemble!.wakeups = {
      existing: {
        wakeupId: 'existing',
        chatId: 'ensemble-chat',
        roundId,
        participantId: 'claude',
        provider: 'claude',
        role: 'Reviewer',
        runId,
        scheduledAt: '2026-05-24T00:00:01.000Z',
        wakeAt: '2026-05-24T00:01:01.000Z',
        status: 'pending'
      }
    }
    const duplicate = harness.orchestrator.scheduleWakeupForRun(runId, { delayMs: 2000 })
    expect(duplicate.ok).toBe(false)
    expect(duplicate.error).toContain('already has a pending wakeup')
  })

  it('rejects wakeups beyond the 7-day delay cap', async () => {
    // 1.0.5-N4 — Node's setTimeout silently clamps delays >2^31-1 ms
    // (~24.86 days) to 1ms, which would make a far-future wakeup
    // fire IMMEDIATELY. Guard at schedule-time so the agent gets a
    // structured rejection instead of a silently-broken wakeup.
    const scheduled: EnsembleWakeupRecord[] = []
    const harness = makeHarness({
      scheduleWakeupTimer: (wakeup) => scheduled.push(wakeup)
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Start.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runId = harness.dispatched[0].appRunId!

    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000
    const result = harness.orchestrator.scheduleWakeupForRun(runId, {
      delayMs: thirtyDaysMs
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('max delay is 7 days')
    expect(result.error).toContain('~30 days')

    // No timer scheduled, no persisted record, run not put to sleep.
    expect(scheduled).toEqual([])
    expect(harness.chat.ensemble?.wakeups).toBeUndefined()
    expect(harness.chat.ensemble?.activeRound?.participants[0].status).not.toBe('sleeping')
  })

  it('resumes a persisted wakeup after a simulated app restart', async () => {
    // 1.0.5-N3 integration smoke. Exercises the end-to-end recovery
    // path that prior tests covered only at the unit boundary
    // (WakeupTimerService.classifyWakeupRecovery + the in-process
    // wake test). Models the full chain:
    //
    //   1) Pre-restart: claude schedules a wakeup, gets finalised
    //      as sleeping; codex runs.
    //   2) Simulated restart: new harness gets harness1.chat as
    //      initialChat. The orchestrator has no in-memory
    //      ActiveRoundRuntime for the chat — only the persisted
    //      pending wakeup survives.
    //   3) `resumePersistedWakeup(...)` reconstructs the runtime,
    //      flips the wakeup to fired with the recovery message,
    //      re-dispatches the participant with the resume prompt,
    //      and appends the "woke after app restart" status row.
    const signRunPermissionPosture = vi.fn(() => 'e'.repeat(64))
    const harness1 = makeHarness({
      scheduleWakeupTimer: () => {},
      signRunPermissionPosture
    })
    harness1.chat.ensemble!.participants[0].stageRole = 'worker'
    harness1.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Start and survive a restart.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness1.dispatched).toHaveLength(1))
    const claudeRunId = harness1.dispatched[0].appRunId!
    const sleepResult = harness1.orchestrator.scheduleWakeupForRun(claudeRunId, {
      delayMs: 60_000,
      reason: 'Waiting on background job.'
    })
    expect(sleepResult.ok).toBe(true)
    const sleepWakeup = sleepResult.wakeup!
    expect(sleepWakeup.stageRole).toBe('worker')
    expect(sleepWakeup.permissionPosture).toMatchObject({
      approvalMode: 'plan',
      workflowMode: 'normal',
      presetId: 'read_only',
      readOnly: true,
      signature: 'e'.repeat(64),
      signaturePresent: true,
      context: {
        provider: 'claude',
        scope: 'workspace',
        appRunId: sleepWakeup.wakeupId,
        appChatId: 'ensemble-chat',
        workflowMode: 'normal',
        promptHash: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    })
    expect(sleepWakeup.dispatchReceipt).toMatchObject({
      provider: 'claude',
      source: 'scheduled',
      workspaceId: 'ws-1',
      chatId: 'ensemble-chat',
      ensembleParticipantId: 'claude',
      ensembleRole: 'Reviewer',
      ensembleStageRole: 'worker',
      permissionPresetId: 'read_only',
      readOnly: true,
      permissionPostureHash: sleepWakeup.permissionPosture!.postureHash,
      permissionPostureSignaturePresent: true
    })
    expect(sleepWakeup.dispatchReceipt?.receiptHash).toMatch(/^[a-f0-9]{64}$/)
    expect(signRunPermissionPosture).toHaveBeenCalledWith(
      'plan',
      expect.objectContaining({ presetId: 'read_only', readOnly: true }),
      expect.objectContaining({
        appRunId: sleepWakeup.wakeupId,
        appChatId: 'ensemble-chat',
        prompt: 'Start and survive a restart.'
      })
    )
    const wakeupId = sleepWakeup.wakeupId

    // Codex runs while claude sleeps; the round stays 'running'
    // because the wakeup is still pending.
    await vi.waitFor(() => expect(harness1.dispatched).toHaveLength(2))
    harness1.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness1.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => {
      expect(harness1.chat.ensemble?.activeRound?.status).toBe('running')
      expect(harness1.chat.ensemble?.activeRound?.pendingWakeupIds).toEqual([wakeupId])
    })
    Object.assign(harness1.chat.ensemble!.activeRound!, {
      queuedPrompt: '@Worker continue after the recovered wakeup',
      queuedPrompts: ['@Worker continue after the recovered wakeup'],
      queuedPromptEntries: [
        {
          persistenceVersion: 1,
          id: 'queued-after-wakeup',
          prompt: '@Worker continue after the recovered wakeup',
          dmTargetParticipantId: 'codex',
          fanoutPolicy: 'off',
          imageAttachments: []
        }
      ]
    })
    harness1.chat.ensemble!.participants[0].role = 'Mutated Reviewer'
    harness1.chat.ensemble!.participants[0].stageRole = 'reviewer'

    // Simulated restart. The orchestrator below has no in-memory
    // runtime for this chat — only the persisted pending wakeup.
    const restarted = makeHarness({ initialChat: harness1.chat })
    const pending = restarted.chat.ensemble!.wakeups![wakeupId]
    expect(pending.status).toBe('pending')

    const ok = restarted.orchestrator.resumePersistedWakeup(pending, {} as Electron.WebContents)
    expect(ok).toBe(true)

    // Wakeup record was flipped to fired with the recovery marker.
    const fired = restarted.chat.ensemble!.wakeups![wakeupId]
    expect(fired.status).toBe('fired')
    expect(fired.firedAt).toBeDefined()
    expect(fired.message).toBe('recovered after app restart')

    // Claude was re-dispatched, with the resume prompt threaded in.
    await vi.waitFor(() => expect(restarted.dispatched).toHaveLength(1))
    expect(restarted.dispatched[0].ensembleRun?.participantId).toBe('claude')
    expect(restarted.dispatched[0].ensembleRun?.role).toBe('Reviewer')
    expect(restarted.dispatched[0].ensembleRun?.stageRole).toBe('worker')
    expect(restarted.dispatched[0].prompt).toContain('[Scheduled wakeup]')
    expect(restarted.dispatched[0].prompt).toContain('Waiting on background job.')

    // The transcript carries the woke-after-restart status row.
    expect(
      restarted.chat.messages.some((message) => message.content.includes('woke after app restart'))
    ).toBe(true)

    completeDispatchedRun(restarted, 0)
    await vi.waitFor(() => expect(restarted.dispatched).toHaveLength(2))
    expect(restarted.dispatched[1].provider).toBe('codex')
    expect(restarted.dispatched[1].imagePaths).toEqual([])
    expect(restarted.chat.ensemble?.activeRound?.dmTargetParticipantId).toBe('codex')
  })

  it('fails a recovered wakeup round when pre-dispatch construction rejects', async () => {
    const original = makeHarness({ scheduleWakeupTimer: () => {} })
    original.chat.ensemble!.participants = [original.chat.ensemble!.participants[0]]
    original.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Sleep through a restart.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(original.dispatched).toHaveLength(1))
    const scheduled = original.orchestrator.scheduleWakeupForRun(original.dispatched[0].appRunId!, {
      delayMs: 60_000,
      reason: 'Resume me.'
    })
    expect(scheduled.ok).toBe(true)

    const completed: Array<{ roundId: string; status: string }> = []
    const restarted = makeHarness({
      initialChat: original.chat,
      issueRunScopedExternalGrants: () => {
        throw new Error('recovered grant construction failed')
      },
      completeSessionCheckpoint: (_chatId, roundId, status) => {
        completed.push({ roundId, status })
      }
    })
    const pending = restarted.chat.ensemble!.wakeups![scheduled.wakeup!.wakeupId]

    expect(restarted.orchestrator.resumePersistedWakeup(pending, {} as Electron.WebContents)).toBe(
      true
    )
    await vi.waitFor(() => expect(restarted.chat.ensemble?.activeRound?.status).toBe('failed'))

    expect(restarted.cancelRun).toHaveBeenCalledTimes(1)
    expect(completed).toEqual([{ roundId: pending.roundId, status: 'failed' }])
    const internals = restarted.orchestrator as unknown as {
      roundsByChatId: Map<string, unknown>
      runsByRunId: Map<string, unknown>
    }
    expect(internals.roundsByChatId.has('ensemble-chat')).toBe(false)
    expect(internals.runsByRunId.size).toBe(0)
  })

  it('cancelWakeupById flips a pending wakeup to cancelled and clears the sleeping state', async () => {
    // 1.0.5-N7 — Backs the chip-overflow Cancel button. Symmetric
    // with handleWakeupFired (Wake Now) but cancels instead of
    // firing. Must (a) flip the persisted record to status
    // 'cancelled' with the supplied message, (b) drop it from
    // runtime.pendingWakeups, (c) clear the participant's
    // sleeping status on the round, (d) signal any wake waiter.
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Start.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runId = harness.dispatched[0].appRunId!
    const scheduled = harness.orchestrator.scheduleWakeupForRun(runId, {
      delayMs: 60_000,
      reason: 'Waiting.'
    })
    expect(scheduled.ok).toBe(true)
    const wakeupId = scheduled.wakeup!.wakeupId

    const cancelled = harness.orchestrator.cancelWakeupById(wakeupId, 'cancelled by user')
    expect(cancelled?.status).toBe('cancelled')
    expect(cancelled?.message).toBe('cancelled by user')
    expect(harness.chat.ensemble?.wakeups?.[wakeupId]?.status).toBe('cancelled')
    expect(harness.chat.ensemble?.activeRound?.pendingWakeupIds).toBeUndefined()
    const participantStates = harness.chat.ensemble?.activeRound?.participants || []
    const claudeState = participantStates.find((p) => p.participantId === 'claude')
    expect(claudeState?.status).not.toBe('sleeping')
  })

  it('cancelWakeupById returns null for a wakeup that is no longer pending', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Start.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runId = harness.dispatched[0].appRunId!
    const scheduled = harness.orchestrator.scheduleWakeupForRun(runId, {
      delayMs: 60_000
    })
    const wakeupId = scheduled.wakeup!.wakeupId
    harness.orchestrator.cancelWakeupById(wakeupId, 'first cancel')
    const second = harness.orchestrator.cancelWakeupById(wakeupId, 'second cancel')
    expect(second).toBeNull()
  })

  it('refuses to resume a persisted wakeup whose status is no longer pending', () => {
    // Guards the early-return at the top of resumePersistedWakeup.
    // A wakeup that already fired / cancelled / expired must not
    // re-arm if recovery happens to fire a second time (e.g. user
    // toggled the flag off and back on, or two recoveries race).
    const harness = makeHarness()
    const fired: EnsembleWakeupRecord = {
      wakeupId: 'wake-already-fired',
      chatId: 'ensemble-chat',
      roundId: harness.chat.ensemble!.activeRound?.roundId || 'round-stale',
      participantId: 'claude',
      provider: 'claude',
      role: 'Reviewer',
      runId: 'claude-run-0',
      scheduledAt: '2026-05-24T00:00:01.000Z',
      wakeAt: '2026-05-24T00:01:01.000Z',
      status: 'fired',
      firedAt: '2026-05-24T00:01:02.000Z'
    }
    const ok = harness.orchestrator.resumePersistedWakeup(fired, {} as Electron.WebContents)
    expect(ok).toBe(false)
    expect(harness.dispatched).toHaveLength(0)
  })

  it('accepts a wakeup exactly at the 7-day delay cap', async () => {
    // Boundary check — the cap is *strictly less than or equal to*
    // MAX_WAKEUP_DELAY_MS, so exactly-7-days must still succeed.
    const scheduled: EnsembleWakeupRecord[] = []
    const harness = makeHarness({
      scheduleWakeupTimer: (wakeup) => scheduled.push(wakeup)
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Start.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runId = harness.dispatched[0].appRunId!

    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
    const result = harness.orchestrator.scheduleWakeupForRun(runId, {
      delayMs: sevenDaysMs
    })
    expect(result.ok).toBe(true)
    expect(scheduled).toHaveLength(1)
  })

  it('persists and forwards image attachments for ensemble rounds', async () => {
    const harness = makeHarness()

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Review this screenshot.',
      imageAttachments: [
        { id: 'img-1', path: '/tmp/ensemble-screenshot.png', name: 'ensemble-screenshot.png' }
      ],
      imageThumbnails: [{ dataBase64: 'AAAA', mimeType: 'image/jpeg', width: 200, height: 120 }],
      event: { sender: {} as Electron.WebContents }
    })

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.chat.messages[0]).toMatchObject({
      role: 'user',
      metadata: {
        kind: 'ensembleRoundPrompt',
        imageAttachments: [
          { id: 'img-1', path: '/tmp/ensemble-screenshot.png', name: 'ensemble-screenshot.png' }
        ],
        imagePaths: ['/tmp/ensemble-screenshot.png'],
        imageThumbnails: [{ dataBase64: 'AAAA', mimeType: 'image/jpeg', width: 200, height: 120 }]
      }
    })
    expect(harness.dispatched[0].imagePaths).toEqual(['/tmp/ensemble-screenshot.png'])
    expect(harness.dispatched[0].prompt).toContain('Attachment references for this request:')
    expect(harness.dispatched[0].prompt).toContain('/tmp/ensemble-screenshot.png')
  })

  it('warns and continues when a seat cannot receive image attachments', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'pi',
        provider: 'pi',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review.',
        order: 1,
        permissionPresetId: 'read_only'
      },
      {
        id: 'codex',
        provider: 'codex',
        enabled: true,
        role: 'Worker',
        instructions: 'Work.',
        order: 2,
        permissionPresetId: 'workspace_write'
      }
    ]

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Inspect this screenshot.',
      imageAttachments: [
        { id: 'img-1', path: '/tmp/unsupported-lane.png', name: 'unsupported-lane.png' }
      ],
      event: { sender: {} as Electron.WebContents }
    })

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].provider).toBe('pi')
    expect(harness.dispatched[0].imagePaths).toEqual([])
    expect(
      harness.chat.messages.some(
        (message) =>
          typeof message.content === 'string' &&
          message.content.includes('[participant-health]') &&
          message.content.includes('cannot receive image attachments') &&
          message.content.includes('Continuing without')
      )
    ).toBe(true)

    harness.orchestrator.handleProviderOutput(
      'pi',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'Text-only review.' }
    )
    harness.orchestrator.handleProviderOutput(
      'pi',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('codex')
    expect(harness.dispatched[1].imagePaths).toEqual(['/tmp/unsupported-lane.png'])
    const piRound = harness.chat.ensemble?.activeRound?.participants.find(
      (participant) => participant.participantId === 'pi'
    )
    expect(piRound?.status).not.toBe('failed')
  })

  it('starts an ensemble round when attachments are the only prompt content', async () => {
    const harness = makeHarness()

    const result = harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: '   ',
      imageAttachments: [
        { id: 'img-1', path: '/tmp/attachment-only.png', name: 'attachment-only.png' }
      ],
      event: { sender: {} as Electron.WebContents }
    })

    expect(result.status).toBe('started')
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.chat.messages[0].content).toContain('Please inspect the attached file(s).')
    expect(harness.chat.messages[0].metadata?.imageAttachments).toEqual([
      { id: 'img-1', path: '/tmp/attachment-only.png', name: 'attachment-only.png' }
    ])
    expect(harness.dispatched[0].imagePaths).toEqual(['/tmp/attachment-only.png'])
    expect(harness.dispatched[0].prompt).toContain('Please inspect the attached file(s).')
    expect(harness.dispatched[0].prompt).toContain('/tmp/attachment-only.png')
  })

  it('keeps PDF attachments out of native image payloads and scopes external grant prompts per participant', async () => {
    const harness = makeHarness()
    const claudeGrant = externalGrant('claude', '/tmp/claude-notes.pdf')
    const codexGrant = externalGrant('codex', '/tmp/codex-notes.pdf')

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Review these files.',
      imageAttachments: [
        { id: 'img-1', path: '/tmp/screenshot.png', name: 'screenshot.png' },
        { id: 'pdf-1', path: '/tmp/spec.pdf', name: 'spec.pdf' }
      ],
      externalPathGrants: [claudeGrant, codexGrant],
      event: { sender: {} as Electron.WebContents }
    })

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.chat.messages[0]).toMatchObject({
      metadata: {
        imageAttachments: [
          { id: 'img-1', path: '/tmp/screenshot.png', name: 'screenshot.png' },
          { id: 'pdf-1', path: '/tmp/spec.pdf', name: 'spec.pdf' }
        ],
        imagePaths: ['/tmp/screenshot.png']
      }
    })
    expect(harness.dispatched[0].provider).toBe('claude')
    expect(harness.dispatched[0].imagePaths).toEqual(['/tmp/screenshot.png'])
    expect(harness.dispatched[0].prompt).toContain('/tmp/spec.pdf')
    expect(harness.dispatched[0].prompt).toContain('/tmp/claude-notes.pdf')
    expect(harness.dispatched[0].prompt).not.toContain('/tmp/codex-notes.pdf')

    harness.orchestrator.handleProviderOutput(
      'claude',
      {
        appRunId: harness.dispatched[0].appRunId,
        appChatId: 'ensemble-chat'
      },
      {
        type: 'result',
        status: 'success'
      }
    )

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('codex')
    expect(harness.dispatched[1].imagePaths).toEqual(['/tmp/screenshot.png'])
    expect(harness.dispatched[1].prompt).toContain('/tmp/spec.pdf')
    expect(harness.dispatched[1].prompt).toContain('/tmp/codex-notes.pdf')
    expect(harness.dispatched[1].prompt).not.toContain('/tmp/claude-notes.pdf')
  })

  it('mints non-image attachment grants against each exact serial participant run', async () => {
    const issueRunScopedExternalGrants = vi.fn(
      ({
        participant,
        appRunId,
        attachments
      }: Parameters<NonNullable<EnsembleOrchestratorDeps['issueRunScopedExternalGrants']>>[0]) => [
        externalGrant(participant.provider, attachments[0].path, {
          appRunId,
          chatId: 'ensemble-chat',
          workspaceId: 'ws-1'
        })
      ]
    )
    const harness = makeHarness({ issueRunScopedExternalGrants })

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Review the attachment.',
      imageAttachments: [{ id: 'pdf-1', path: '/tmp/spec.pdf', name: 'spec.pdf' }],
      event: { sender: {} as Electron.WebContents }
    })

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(issueRunScopedExternalGrants).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        appRunId: 'claude-run-1',
        participant: expect.objectContaining({ id: 'claude' })
      })
    )
    expect(harness.dispatched[0].externalPathGrants).toMatchObject([
      { provider: 'claude', path: '/tmp/spec.pdf', appRunId: 'claude-run-1' }
    ])

    completeDispatchedRun(harness, 0)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(issueRunScopedExternalGrants).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        appRunId: 'codex-run-2',
        participant: expect.objectContaining({ id: 'codex' })
      })
    )
    expect(harness.dispatched[1].externalPathGrants).toMatchObject([
      { provider: 'codex', path: '/tmp/spec.pdf', appRunId: 'codex-run-2' }
    ])
  })

  it('keeps each participant permission and tool posture on an attached workspace', async () => {
    const secondaryPath = '/tmp/secondary-workspace'
    const providerPostures = [
      { provider: 'codex', permissionPresetId: 'read_only' },
      { provider: 'claude', permissionPresetId: 'workspace_write' },
      { provider: 'cursor', permissionPresetId: 'read_only' },
      { provider: 'grok', permissionPresetId: 'workspace_write' },
      { provider: 'kimi', permissionPresetId: 'read_only' },
      { provider: 'ollama', permissionPresetId: 'workspace_write' }
    ] as const
    const initialChat = makeChat()
    initialChat.ensemble = {
      ...initialChat.ensemble!,
      maxParticipants: providerPostures.length,
      participants: providerPostures.map((entry, index) => ({
        id: entry.provider,
        provider: entry.provider,
        enabled: true,
        role: `${entry.provider} participant`,
        instructions: '',
        order: index + 1,
        model: 'cli-default',
        permissionPresetId: entry.permissionPresetId,
        permissionOverrides: { agenticServices: { mcpTools: 'deny' } }
      }))
    }
    const harness = makeHarness({ initialChat })

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Inspect the attached workspace.',
      externalPathGrants: providerPostures.map(({ provider }) =>
        externalGrant(provider, secondaryPath, {
          kind: 'directory',
          access: 'write',
          duration: 'thisThread'
        })
      ),
      event: { sender: {} as Electron.WebContents }
    })

    for (const [index, entry] of providerPostures.entries()) {
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(index + 1))
      const readOnly = entry.permissionPresetId === 'read_only'
      expect(harness.dispatched[index]).toMatchObject({
        provider: entry.provider,
        approvalMode: readOnly ? 'plan' : 'auto_edit',
        externalPathGrants: [{ provider: entry.provider, path: secondaryPath, access: 'write' }],
        effectivePermissions: {
          presetId: entry.permissionPresetId,
          readOnly,
          agenticServices: {
            // workspace_write auto-allows file changes inside the workspace.
            // Posture inversion (2026-08-04): read_only (Ask) prompts for edits.
            fileChanges: readOnly ? 'ask' : 'allow',
            mcpTools: 'deny'
          }
        }
      })
      if (index < providerPostures.length - 1) completeDispatchedRun(harness, index)
    }
  })

  it('forwards Discord context to ensemble participants without persisting raw messages', async () => {
    const harness = makeHarness()
    const snapshot = makeDiscordSnapshot()

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Summarize build status.',
      discordContextSnapshots: [snapshot],
      event: { sender: {} as Electron.WebContents }
    })

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].prompt).toContain('External Discord channel snapshot context')
    expect(harness.dispatched[0].prompt).toContain('Workspace Guild / #build-help')
    expect(harness.dispatched[0].prompt).toContain('alice: CI failed on linux.')

    expect(harness.chat.messages[0]).toMatchObject({
      role: 'user',
      content: 'Summarize build status.',
      metadata: {
        kind: 'ensembleRoundPrompt',
        discordContextReads: [
          {
            kind: 'discordContextRead',
            channelId: '200000000000000002',
            channelName: 'build-help',
            retention: 'run',
            previewMessages: []
          }
        ]
      }
    })
    expect(harness.chat.messages[0].content).not.toContain('CI failed on linux.')
    expect(harness.chat.messages[1].role).toBe('tool')
    expect(harness.chat.messages[1].toolActivities?.[0]).toMatchObject({
      displayName: 'Read Discord #build-help · 1 messages',
      category: 'read',
      status: 'success',
      resultSummary: expect.stringContaining('Preview omitted')
    })
    expect(harness.chat.messages[1].toolActivities?.[0].resultSummary).not.toContain(
      'CI failed on linux.'
    )
  })

  it('forwards Discord context to Grok and Cursor ensemble participants', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'grok',
        provider: 'grok',
        enabled: true,
        role: 'Grok',
        instructions: 'Review with Grok.',
        order: 1,
        permissionPresetId: 'read_only'
      },
      {
        id: 'cursor',
        provider: 'cursor',
        enabled: true,
        role: 'Cursor',
        instructions: 'Review with Cursor.',
        order: 2,
        permissionPresetId: 'read_only'
      }
    ]

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Summarize build status.',
      discordContextSnapshots: [makeDiscordSnapshot()],
      event: { sender: {} as Electron.WebContents }
    })

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    harness.orchestrator.handleProviderOutput(
      'grok',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched.map((payload) => payload.provider)).toEqual(['grok', 'cursor'])
    for (const payload of harness.dispatched) {
      expect(payload.prompt).toContain('External Discord channel snapshot context')
      expect(payload.prompt).toContain('alice: CI failed on linux.')
    }
  })

  it('appends project_reference_context to seat prompts; BG seats omit extract bodies', async () => {
    const { createHash } = await import('node:crypto')
    type Project = import('../../shared/projects').Project
    type ProjectReference = import('../../shared/projects').ProjectReference
    type ProjectReferenceExtract =
      import('../../shared/projectReferenceExtract').ProjectReferenceExtract

    const project: Project = {
      schemaVersion: 1,
      id: 'project-ensemble-refs',
      name: 'Ensemble Refs',
      icon: { iconKind: 'seed', seed: 'e' },
      hue: 2,
      parentId: null,
      order: 1,
      memberChatIds: ['ensemble-chat'],
      createdAt: 1,
      updatedAt: 1
    }
    const references: ProjectReference[] = [
      {
        id: 'brief-url',
        projectId: project.id,
        kind: 'url',
        locator: 'https://example.com/ensemble-brief',
        title: 'Ensemble brief',
        provenance: { addedBy: 'user', addedAt: 1 },
        contextPolicy: 'available',
        updatedAt: 1
      }
    ]
    const extractBody = 'Consentful extract body for Ensemble Use-next.'
    const digest = createHash('sha256').update(extractBody, 'utf8').digest('hex')
    const readyExtract: ProjectReferenceExtract = {
      schemaVersion: 1,
      id: 'extract-brief-1',
      projectId: project.id,
      referenceId: 'brief-url',
      kind: 'url-html',
      status: 'ready',
      consent: { at: 1, actor: 'user', scope: 'this-reference', chatId: 'ensemble-chat' },
      source: { locator: 'https://example.com/ensemble-brief' },
      text: { charCount: extractBody.length, truncated: false, artifactSha256: digest },
      createdAt: 1,
      updatedAt: 1
    }
    const selection = {
      schemaVersion: 1 as const,
      projectId: project.id,
      referenceIds: ['brief-url']
    }
    const previous = process.env.TASKWRAITH_CONCURRENT_LANES
    process.env.TASKWRAITH_CONCURRENT_LANES = '1'
    try {
      const harness = makeHarness({
        listProjects: () => [project],
        listProjectReferences: () => references,
        projectReferenceExtractLoader: {
          getActiveExtract: (projectId, referenceId) =>
            projectId === project.id && referenceId === 'brief-url' ? readyExtract : null,
          readExtractText: (extractId) => (extractId === readyExtract.id ? extractBody : null)
        }
      })
      harness.chat.ensemble!.bossmanParticipantId = 'claude'
      harness.chat.ensemble!.participants = [
        {
          id: 'claude',
          provider: 'claude',
          enabled: true,
          role: 'Boss',
          instructions: 'Coordinate.',
          order: 1,
          permissionPresetId: 'read_only'
        },
        {
          id: 'background-shell',
          provider: 'codex',
          enabled: true,
          role: 'BG',
          instructions: 'Detached checks.',
          order: 2,
          permissionPresetId: 'read_only',
          stageRole: 'background'
        }
      ]

      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: '@BG check the brief while Boss plans.',
        event: { sender: {} as Electron.WebContents },
        projectReferenceContextSelection: selection
      })

      await vi.waitFor(() => {
        expect(harness.dispatched.some((run) => run.ensembleRun?.participantId === 'claude')).toBe(
          true
        )
        expect(
          harness.dispatched.some((run) => run.ensembleRun?.participantId === 'background-shell')
        ).toBe(true)
      })

      const bossPrompt = harness.dispatched.find(
        (run) => run.ensembleRun?.participantId === 'claude'
      )?.prompt
      const bgPrompt = harness.dispatched.find(
        (run) => run.ensembleRun?.participantId === 'background-shell'
      )?.prompt
      expect(bossPrompt).toContain('<project_reference_context>')
      expect(bossPrompt).toContain('https://example.com/ensemble-brief')
      expect(bossPrompt).toContain('<project_reference_extracts>')
      expect(bossPrompt).toContain(extractBody)
      expect(bgPrompt).toContain('<project_reference_context>')
      expect(bgPrompt).not.toContain('<project_reference_extracts>')
      expect(bgPrompt).not.toContain(extractBody)
    } finally {
      if (previous === undefined) delete process.env.TASKWRAITH_CONCURRENT_LANES
      else process.env.TASKWRAITH_CONCURRENT_LANES = previous
    }
  })

  it('preserves Discord snapshots on queued ensemble rounds', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'claude',
        provider: 'claude',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review.',
        order: 1,
        permissionPresetId: 'read_only'
      }
    ]

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'First prompt',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const queued = harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Second prompt',
      discordContextSnapshots: [makeDiscordSnapshot('Queued Discord clue.')],
      event: { sender: {} as Electron.WebContents },
      mode: 'queue'
    })
    expect(queued.status).toBe('queued')

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].prompt).toContain('External Discord channel snapshot context')
    expect(harness.dispatched[1].prompt).toContain('alice: Queued Discord clue.')
  })

  it('quarantines queued run-only Discord context after restart instead of dispatching without it', async () => {
    const seed = makeHarness()
    seed.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'First prompt',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(seed.dispatched).toHaveLength(1))

    seed.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Use the selected Discord evidence',
      discordContextSnapshots: [makeDiscordSnapshot('Restart-sensitive Discord clue.')],
      event: { sender: {} as Electron.WebContents },
      mode: 'queue'
    })

    const persistedEntry = seed.chat.ensemble?.activeRound?.queuedPromptEntries?.[0]
    expect(persistedEntry).toMatchObject({
      persistenceVersion: 1,
      prompt: 'Use the selected Discord evidence',
      hadDiscordContext: true
    })
    expect(persistedEntry).not.toHaveProperty('discordContextSnapshots')
    expect(JSON.stringify(seed.chat)).not.toContain('Restart-sensitive Discord clue.')

    const restarted = makeHarness({ initialChat: seed.chat })
    const result = restarted.orchestrator.steerQueuedPrompt({
      chatId: 'ensemble-chat',
      index: 0,
      textPrefix: 'Use the selected Discord evidence',
      event: { sender: {} as Electron.WebContents }
    })

    expect(result.status).toBe('ignored')
    expect(result.error).toContain('Discord context was run-only and must be re-selected')
    expect(restarted.dispatched).toHaveLength(0)
    expect(restarted.chat.ensemble?.activeRound?.queuedPromptEntries?.[0]).toMatchObject({
      hadDiscordContext: true
    })
    expect(
      restarted.chat.messages.some((message) =>
        message.content.includes('Discord context was run-only and must be re-selected')
      )
    ).toBe(true)
  })

  it('absorbs a queued prompt into the same round after the current speaker finishes', async () => {
    const harness = makeHarness()
    const started = harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'First prompt',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const firstRoundId = started.roundId
    const queued = harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Second prompt',
      event: { sender: {} as Electron.WebContents },
      mode: 'queue'
    })
    expect(queued.status).toBe('queued')
    expect(queued.roundId).toBe(firstRoundId)
    harness.orchestrator.handleProviderOutput(
      'claude',
      {
        appRunId: harness.dispatched[0].appRunId,
        appChatId: 'ensemble-chat'
      },
      {
        type: 'result',
        status: 'success'
      }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.chat.ensemble?.activeRound?.roundId).toBe(firstRoundId)
    expect(harness.chat.messages.map((message) => message.content)).toContain('Second prompt')
    expect(
      harness.chat.messages.some(
        (message) =>
          message.content === 'Second prompt' && message.metadata?.kind === 'midRunSteering'
      )
    ).toBe(true)
  })

  it('captures a terminal synthesizer summary when the round completes', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.synthesizerParticipantId = 'codex'
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Summarise this round.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'Reviewed the plan.' }
    )
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    const summary = `Round summary:
The panel agreed to capture summaries at round close.

Decisions:
- Capture in finishRound.

Corrections:
- Do not capture from flushRun.

Open risks:
- Wakeups are still next.

Next action:
- Add renderer history tests.`
    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: summary }
    )
    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )

    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    const roundId = harness.chat.ensemble!.activeRound!.roundId
    expect(harness.chat.ensemble?.lastRoundSummary).toContain('Capture in finishRound')
    expect(harness.chat.ensemble?.roundSummaries?.[roundId]?.summary).toContain('Next action:')
  })

  it('threads the captured summary into the next round prompt', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.synthesizerParticipantId = 'codex'
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'First round.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'Review done.' }
    )
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      {
        type: 'content',
        text: `Round summary:
Carry this forward.

Decisions:
- Queue works.

Corrections:
- None.

Open risks:
- None.

Next action:
- Use it next round.`
      }
    )
    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )

    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Second round.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[2].prompt).toContain('Prior round summary')
    expect(harness.dispatched[2].prompt).toContain('Carry this forward')
  })

  it('steers into the live round without cancelling the active speaker', async () => {
    const cancelStarted = vi.fn()
    const harness = makeHarness({
      cancelRun: async () => {
        cancelStarted()
        return true
      }
    })
    const started = harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Original prompt',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const oldRun = harness.dispatched[0]
    const firstRoundId = started.roundId

    const steered = harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Steered prompt',
      event: { sender: {} as Electron.WebContents },
      mode: 'steer'
    })

    expect(steered.status).toBe('steered')
    expect(steered.roundId).toBe(firstRoundId)
    expect(cancelStarted).not.toHaveBeenCalled()
    expect(harness.dispatched).toHaveLength(1)
    expect(harness.chat.ensemble?.activeRound?.roundId).toBe(firstRoundId)
    expect(harness.chat.ensemble?.activeRound?.prompt).toBe('Original prompt')
    expect(harness.chat.messages.map((message) => message.content)).toContain('Steered prompt')
    expect(
      harness.chat.messages.some(
        (message) =>
          message.content === 'Steered prompt' && message.metadata?.kind === 'midRunSteering'
      )
    ).toBe(true)

    const handled = harness.orchestrator.handleProviderOutput(
      'claude',
      {
        appRunId: oldRun.appRunId,
        appChatId: 'ensemble-chat'
      },
      {
        type: 'content',
        text: 'live speaker continues'
      }
    )
    expect(handled).toBe(true)
  })

  it('steers a queued prompt by index into the live round while preserving the remaining FIFO queue', async () => {
    const cancelStarted = vi.fn()
    const harness = makeHarness({
      cancelRun: async () => {
        cancelStarted()
        return true
      }
    })
    const started = harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Original prompt',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const firstRoundId = started.roundId

    for (const prompt of ['Queued A', 'Queued B', 'Queued C']) {
      const queued = harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt,
        event: { sender: {} as Electron.WebContents },
        mode: 'queue'
      })
      expect(queued.status).toBe('queued')
    }
    expect(harness.chat.ensemble?.activeRound?.queuedPrompts).toEqual([
      'Queued A',
      'Queued B',
      'Queued C'
    ])

    const steered = harness.orchestrator.steerQueuedPrompt({
      chatId: 'ensemble-chat',
      index: 1,
      textPrefix: 'Queued B',
      event: { sender: {} as Electron.WebContents }
    })

    expect(steered.status).toBe('steered')
    expect(steered.roundId).toBe(firstRoundId)
    expect(cancelStarted).not.toHaveBeenCalled()
    expect(harness.dispatched).toHaveLength(1)
    expect(harness.chat.ensemble?.activeRound?.roundId).toBe(firstRoundId)
    expect(harness.chat.ensemble?.activeRound?.prompt).toBe('Original prompt')
    expect(harness.chat.ensemble?.activeRound?.queuedPrompts).toEqual(['Queued A', 'Queued C'])
    expect(harness.chat.ensemble?.activeRound?.queuedPrompt).toBe('Queued A')
    expect(harness.chat.messages.map((message) => message.content)).toContain('Queued B')
  })

  it('preserves a directed participant scope when steering a queued prompt', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    const started = harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Original prompt',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const firstRoundId = started.roundId

    const queued = harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: '@Worker directed follow-up',
      event: { sender: {} as Electron.WebContents },
      mode: 'queue',
      dmTargetParticipantId: 'codex',
      fanoutPolicy: 'off'
    })
    expect(queued.status).toBe('queued')
    expect(getRuntimeQueuedPrompts(harness.orchestrator, 'ensemble-chat')[0]).toMatchObject({
      prompt: '@Worker directed follow-up',
      dmTargetParticipantId: 'codex'
    })

    const steered = harness.orchestrator.steerQueuedPrompt({
      chatId: 'ensemble-chat',
      index: 0,
      textPrefix: '@Worker directed follow-up',
      event: { sender: {} as Electron.WebContents },
      // The queued-row UI supplies the roster's current policy. The queued
      // entry's own directed/off boundary must take precedence.
      fanoutPolicy: 'read_only'
    })

    expect(steered.status).toBe('steered')
    expect(steered.roundId).toBe(firstRoundId)
    expect(harness.dispatched).toHaveLength(1)
    expect(harness.chat.ensemble?.activeRound?.dmTargetParticipantId).toBe('codex')
    // The directed scope is held by the routing target — which every dispatch
    // gate reads, and which the boundary dispatch below actually proves. The
    // round it landed in keeps its own shape: narrowing the persisted record to
    // the target alone dropped seats that were still live members of the round,
    // taking their status pills, working rows and lane shimmer with them.
    expect(harness.chat.ensemble?.activeRound?.fanoutPolicy).toBe('read_only')
    expect(
      harness.chat.ensemble?.activeRound?.participants.map(
        (participant) => participant.participantId
      )
    ).toEqual(['claude', 'codex'])

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 10 } }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('codex')
    expect(harness.chat.ensemble?.activeRound?.roundId).toBe(firstRoundId)
  })

  it('preserves a directed participant scope when a queued prompt drains into the live round', async () => {
    const harness = makeHarness()
    const started = harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Original prompt',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const firstRoundId = started.roundId

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: '@Worker directed follow-up',
      event: { sender: {} as Electron.WebContents },
      mode: 'queue',
      dmTargetParticipantId: 'codex'
    })

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 10 } }
    )

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('codex')
    expect(harness.chat.ensemble?.activeRound?.roundId).toBe(firstRoundId)
    expect(harness.chat.ensemble?.activeRound?.prompt).toBe('Original prompt')
    expect(harness.chat.ensemble?.activeRound?.dmTargetParticipantId).toBe('codex')
    expect(harness.chat.messages.map((message) => message.content)).toContain(
      '@Worker directed follow-up'
    )
  })

  it('absorbs successive queued steers into the same live round without cancelling', async () => {
    // Steer-from-queue no longer parks a replacement round. Each steer absorbs
    // into the live round immediately; the active speaker keeps running.
    const cancelStarted = vi.fn()
    const harness = makeHarness({
      cancelRun: async () => {
        cancelStarted()
        return true
      }
    })

    const started = harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Original prompt',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const firstRoundId = started.roundId
    const oldRun = harness.dispatched[0]

    for (const prompt of ['Queued A', 'Queued B']) {
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt,
        event: { sender: {} as Electron.WebContents },
        mode: 'queue'
      })
    }

    const steer1 = harness.orchestrator.steerQueuedPrompt({
      chatId: 'ensemble-chat',
      index: 0,
      textPrefix: 'Queued A',
      event: { sender: {} as Electron.WebContents }
    })
    expect(steer1.status).toBe('steered')
    expect(steer1.roundId).toBe(firstRoundId)
    expect(harness.dispatched).toHaveLength(1)
    expect(harness.chat.ensemble?.activeRound?.queuedPrompts).toEqual(['Queued B'])
    expect(harness.chat.messages.map((message) => message.content)).toContain('Queued A')

    const steer2 = harness.orchestrator.steerQueuedPrompt({
      chatId: 'ensemble-chat',
      index: 0,
      textPrefix: 'Queued B',
      event: { sender: {} as Electron.WebContents }
    })
    expect(steer2.status).toBe('steered')
    expect(steer2.roundId).toBe(firstRoundId)
    expect(cancelStarted).not.toHaveBeenCalled()
    expect(harness.dispatched).toHaveLength(1)
    expect(harness.chat.ensemble?.activeRound?.roundId).toBe(firstRoundId)
    expect(harness.chat.ensemble?.activeRound?.prompt).toBe('Original prompt')
    expect(harness.chat.ensemble?.activeRound?.queuedPrompts || []).toEqual([])
    expect(harness.chat.messages.map((message) => message.content)).toContain('Queued B')

    // Live speaker output still belongs to this round.
    expect(
      harness.orchestrator.handleProviderOutput(
        'claude',
        { appRunId: oldRun.appRunId, appChatId: 'ensemble-chat' },
        { type: 'content', text: 'still speaking' }
      )
    ).toBe(true)
  })

  it('dequeues a steered prompt before the mid-run absorb save so the row cannot stick', async () => {
    // Regression: absorb used to broadcast with the item still in
    // queuedPrompts; the renderer optimistic-cleared, then restored from that
    // stale longer queue and refused the later empty update.
    const queuesSeenAtAbsorb: Array<string[] | undefined> = []
    const holder: { harness?: ReturnType<typeof makeHarness> } = {}
    holder.harness = makeHarness({
      appendMidRunSteering: (input) => {
        const current = holder.harness!.chat
        queuesSeenAtAbsorb.push(
          current.ensemble?.activeRound?.queuedPrompts
            ? [...current.ensemble.activeRound.queuedPrompts]
            : undefined
        )
        holder.harness!.saveChat({
          ...current,
          messages: [
            ...current.messages,
            {
              id: `steer-message-${queuesSeenAtAbsorb.length}`,
              role: 'user',
              content: input.text,
              timestamp: '2026-05-24T00:00:01.000Z',
              metadata: { kind: 'midRunSteering' }
            }
          ],
          updatedAt: Date.now()
        })
        return { messageId: `steer-message-${queuesSeenAtAbsorb.length}`, entryId: 'steer-entry-1' }
      }
    })
    const harness = holder.harness

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Original prompt',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Steer me now',
      event: { sender: {} as Electron.WebContents },
      mode: 'queue'
    })
    expect(harness.chat.ensemble?.activeRound?.queuedPrompts).toEqual(['Steer me now'])

    const steered = harness.orchestrator.steerQueuedPrompt({
      chatId: 'ensemble-chat',
      index: 0,
      textPrefix: 'Steer me now',
      event: { sender: {} as Electron.WebContents }
    })
    expect(steered.status).toBe('steered')
    expect(queuesSeenAtAbsorb).toEqual([[]])
    expect(harness.chat.ensemble?.activeRound?.queuedPrompts || []).toEqual([])
    expect(harness.chat.messages.map((message) => message.content)).toContain('Steer me now')
  })

  it('recovers a restart-orphaned queued steer (no in-memory runtime) by starting a fresh round', async () => {
    // Build a persisted `running` round with a FIFO queue on one orchestrator,
    // then hand its chat to a FRESH orchestrator whose `roundsByChatId` is empty
    // — exactly the post-app-restart state (persisted round is dispatch-live and
    // renders queued rows + a live Steer button, but no runtime was rehydrated).
    const seed = makeHarness()
    seed.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Original prompt',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(seed.dispatched).toHaveLength(1))
    seed.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Queued A',
      event: { sender: {} as Electron.WebContents },
      mode: 'queue'
    })
    seed.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Queued B',
      event: { sender: {} as Electron.WebContents },
      mode: 'queue',
      dmTargetParticipantId: 'codex',
      fanoutPolicy: 'off',
      externalPathGrants: [
        externalGrant('codex', '/tmp/stale-run-only', {
          id: 'stale-run-grant',
          appRunId: 'prior-process-run'
        }),
        externalGrant('codex', '/tmp/thread-notes', {
          id: 'durable-thread-grant',
          duration: 'thisThread'
        })
      ]
    })
    expect(seed.chat.ensemble?.activeRound?.status).toBe('running')
    expect(seed.chat.ensemble?.activeRound?.queuedPrompts?.[0]).toBe('Queued A')
    expect(seed.chat.ensemble?.activeRound?.queuedPrompts?.[1]).toContain('Queued B')
    expect(seed.chat.ensemble?.activeRound?.queuedPromptEntries?.[1]).toMatchObject({
      persistenceVersion: 1,
      dmTargetParticipantId: 'codex',
      fanoutPolicy: 'off',
      imageAttachments: [],
      externalPathGrants: [
        { id: 'durable-thread-grant', provider: 'codex', path: '/tmp/thread-notes' }
      ]
    })
    expect(
      seed.chat.ensemble?.activeRound?.queuedPromptEntries?.[1]?.externalPathGrants?.map(
        (grant) => grant.id
      )
    ).toEqual(['durable-thread-grant'])

    const restarted = makeHarness({ initialChat: seed.chat })
    // Sanity: the fresh orchestrator has no in-memory runtime for this chat.
    expect(getRuntimeQueuedPrompts(restarted.orchestrator, 'ensemble-chat')).toEqual([])

    const steered = restarted.orchestrator.steerQueuedPrompt({
      chatId: 'ensemble-chat',
      index: 1,
      textPrefix: 'Queued B',
      event: { sender: {} as Electron.WebContents }
    })
    expect(steered.status).toBe('steered')
    await vi.waitFor(() => expect(restarted.dispatched).toHaveLength(1))
    expect(restarted.dispatched[0].prompt).toContain('Queued B')
    expect(restarted.dispatched[0].provider).toBe('codex')
    expect(restarted.dispatched[0].imagePaths).toEqual([])
    expect(restarted.dispatched[0].externalPathGrants).toEqual([
      expect.objectContaining({
        id: 'durable-thread-grant',
        provider: 'codex',
        path: '/tmp/thread-notes',
        duration: 'thisThread'
      })
    ])
    expect(restarted.dispatched[0].externalPathGrants).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ appRunId: 'prior-process-run' })])
    )
    expect(restarted.chat.ensemble?.activeRound?.roundId).toBe(steered.roundId)
    expect(restarted.chat.ensemble?.activeRound?.prompt).toContain('Queued B')
    expect(restarted.chat.ensemble?.activeRound?.dmTargetParticipantId).toBe('codex')
    expect(restarted.chat.ensemble?.activeRound?.fanoutPolicy).toBe('off')
    // The un-steered sibling prompt is carried into the recovered round's queue.
    expect(restarted.chat.ensemble?.activeRound?.queuedPrompts).toEqual(['Queued A'])
    const carriedId = restarted.chat.ensemble?.activeRound?.queuedPromptEntries?.[0]?.id
    expect(carriedId).toBeDefined()

    restarted.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Queued C after restart',
      event: { sender: {} as Electron.WebContents },
      mode: 'queue'
    })
    const idsAfterRestartQueue =
      restarted.chat.ensemble?.activeRound?.queuedPromptEntries?.map((entry) => entry.id) || []
    expect(idsAfterRestartQueue[0]).toBe(carriedId)
    expect(new Set(idsAfterRestartQueue).size).toBe(2)
  })

  it('quarantines attachment-bearing queued prompts after restart until files are re-selected', async () => {
    const seed = makeHarness()
    seed.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Original prompt',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(seed.dispatched).toHaveLength(1))
    seed.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: '@Worker inspect the queued image',
      event: { sender: {} as Electron.WebContents },
      mode: 'queue',
      dmTargetParticipantId: 'codex',
      imageAttachments: [{ id: 'restart-image', path: '/tmp/restart.png', name: 'restart.png' }],
      imageThumbnails: [{ dataBase64: 'cmVzdGFydA==', mimeType: 'image/png', width: 12, height: 8 }]
    })

    const restarted = makeHarness({ initialChat: seed.chat })
    const result = restarted.orchestrator.steerQueuedPrompt({
      chatId: 'ensemble-chat',
      index: 0,
      textPrefix: '@Worker inspect the queued image',
      event: { sender: {} as Electron.WebContents }
    })

    expect(result.status).toBe('ignored')
    expect(result.error).toContain('attachment paths must be re-selected')
    expect(restarted.dispatched).toHaveLength(0)
    expect(restarted.chat.ensemble?.activeRound?.queuedPromptEntries?.[0]).toMatchObject({
      dmTargetParticipantId: 'codex',
      imageAttachments: [{ path: '/tmp/restart.png' }],
      imageThumbnails: [{ mimeType: 'image/png' }]
    })
    expect(
      restarted.chat.messages.some((message) =>
        message.content.includes('attachment paths must be re-selected')
      )
    ).toBe(true)
  })

  it('quarantines prompt-only legacy queue rows after restart instead of widening them', async () => {
    const seed = makeHarness()
    seed.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Original prompt',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(seed.dispatched).toHaveLength(1))
    seed.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: '@Worker legacy directed prompt',
      event: { sender: {} as Electron.WebContents },
      mode: 'queue',
      dmTargetParticipantId: 'codex'
    })
    seed.chat.ensemble!.activeRound!.queuedPromptEntries = undefined

    const restarted = makeHarness({ initialChat: seed.chat })
    const result = restarted.orchestrator.steerQueuedPrompt({
      chatId: 'ensemble-chat',
      index: 0,
      textPrefix: '@Worker legacy directed prompt',
      event: { sender: {} as Electron.WebContents }
    })

    expect(result.status).toBe('ignored')
    expect(result.error).toContain('routing metadata is unavailable')
    expect(restarted.dispatched).toHaveLength(0)
    expect(restarted.chat.ensemble?.activeRound?.queuedPrompts?.[0]).toContain(
      '@Worker legacy directed prompt'
    )
    expect(restarted.chat.messages.map((message) => message.content)).toContain(
      'Queued prompt preserved but not dispatched because its restart-era routing metadata is unavailable.'
    )
  })

  it('keeps a terminal orphan queue reachable and refuses to overwrite it with a new round', async () => {
    const seed = makeHarness()
    seed.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Original prompt',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(seed.dispatched).toHaveLength(1))
    seed.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Durable queued prompt',
      event: { sender: {} as Electron.WebContents },
      mode: 'queue'
    })
    seed.chat.ensemble!.activeRound!.status = 'failed'

    const restarted = makeHarness({ initialChat: seed.chat })
    const attemptedReplacement = restarted.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Do not overwrite the durable queue',
      event: { sender: {} as Electron.WebContents }
    })
    expect(attemptedReplacement.status).toBe('ignored')
    expect(restarted.dispatched).toHaveLength(0)
    expect(restarted.chat.ensemble?.activeRound?.queuedPrompts).toEqual(['Durable queued prompt'])

    const recovered = restarted.orchestrator.steerQueuedPrompt({
      chatId: 'ensemble-chat',
      index: 0,
      textPrefix: 'Durable queued prompt',
      event: { sender: {} as Electron.WebContents }
    })
    expect(recovered.status).toBe('steered')
    await vi.waitFor(() => expect(restarted.dispatched).toHaveLength(1))
    expect(restarted.dispatched[0].prompt).toContain('Durable queued prompt')
  })

  it('preserves and blocks a restart-recovered directed queue row whose target left the roster', async () => {
    const seed = makeHarness()
    seed.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Original prompt',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(seed.dispatched).toHaveLength(1))
    seed.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: '@Worker directed follow-up',
      event: { sender: {} as Electron.WebContents },
      mode: 'queue',
      dmTargetParticipantId: 'codex'
    })
    seed.chat.ensemble!.participants = seed.chat.ensemble!.participants.filter(
      (participant) => participant.id !== 'codex'
    )

    const restarted = makeHarness({ initialChat: seed.chat })
    const result = restarted.orchestrator.steerQueuedPrompt({
      chatId: 'ensemble-chat',
      index: 0,
      textPrefix: '@Worker directed follow-up',
      event: { sender: {} as Electron.WebContents }
    })

    expect(result.status).toBe('ignored')
    expect(result.error).toContain('codex')
    expect(restarted.dispatched).toHaveLength(0)
    expect(restarted.chat.ensemble?.activeRound?.queuedPromptEntries?.[0]).toMatchObject({
      dmTargetParticipantId: 'codex'
    })
    expect(
      restarted.chat.messages.some((message) =>
        message.content.includes('preserved but not dispatched')
      )
    ).toBe(true)
  })

  it('does not recover a queued steer when there is neither a runtime nor a live persisted round', () => {
    // No runtime and no persisted round → the original dead-state guard still returns 'ignored'.
    const harness = makeHarness()
    const result = harness.orchestrator.steerQueuedPrompt({
      chatId: 'ensemble-chat',
      index: 0,
      textPrefix: 'nope',
      event: { sender: {} as Electron.WebContents }
    })
    expect(result.status).toBe('ignored')
  })

  it('recovers a restart-orphaned queued delete (no in-memory runtime)', async () => {
    const seed = makeHarness()
    seed.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Original prompt',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(seed.dispatched).toHaveLength(1))
    for (const prompt of ['Queued A', 'Queued B']) {
      seed.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt,
        event: { sender: {} as Electron.WebContents },
        mode: 'queue'
      })
    }

    const restarted = makeHarness({ initialChat: seed.chat })
    const removed = restarted.orchestrator.removeQueuedPrompt({
      chatId: 'ensemble-chat',
      index: 0,
      textPrefix: 'Queued A'
    })
    expect(removed.ok).toBe(true)
    expect(removed.prompt).toBe('Queued A')
    expect(restarted.chat.ensemble?.activeRound?.queuedPrompts).toEqual(['Queued B'])
    // Recovery must NOT spuriously dispatch a round — delete only mutates the queue.
    expect(restarted.dispatched).toHaveLength(0)
  })

  it('returns ignored for a restart-orphaned steer with an out-of-range index (no dispatch)', async () => {
    const seed = makeHarness()
    seed.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Original prompt',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(seed.dispatched).toHaveLength(1))
    seed.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Queued A',
      event: { sender: {} as Electron.WebContents },
      mode: 'queue'
    })

    const restarted = makeHarness({ initialChat: seed.chat })
    const result = restarted.orchestrator.steerQueuedPrompt({
      chatId: 'ensemble-chat',
      index: 5,
      textPrefix: 'Queued A',
      event: { sender: {} as Electron.WebContents }
    })
    expect(result.status).toBe('ignored')
    expect(result.error).toBe('Queued item no longer exists')
    expect(restarted.dispatched).toHaveLength(0)
  })

  it('returns ignored for a restart-orphaned steer whose textPrefix no longer matches (no dispatch)', async () => {
    const seed = makeHarness()
    seed.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Original prompt',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(seed.dispatched).toHaveLength(1))
    seed.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Queued A',
      event: { sender: {} as Electron.WebContents },
      mode: 'queue'
    })

    const restarted = makeHarness({ initialChat: seed.chat })
    const result = restarted.orchestrator.steerQueuedPrompt({
      chatId: 'ensemble-chat',
      index: 0,
      textPrefix: 'A different prompt',
      event: { sender: {} as Electron.WebContents }
    })
    expect(result.status).toBe('ignored')
    expect(result.error).toBe('Queue changed underneath — refresh and retry')
    expect(restarted.dispatched).toHaveLength(0)
  })

  it('does not dispatch a participant onto a round cancelled during seat compaction (no zombie / stuck round)', async () => {
    // Deep-work chats compact seat context between turns; that await can block
    // for seconds. A Stop/Steer landing in that window cancels the round while
    // `activeRunId` is undefined (nothing to interrupt). Without a post-await
    // cancellation re-check the loop resumes and dispatches the next participant
    // onto the already-cancelled round — a zombie run the runtime no longer owns
    // (keeps speaking, Stop can't reach it, round reads stuck 'running').
    let resolveCompaction: (() => void) | undefined
    const harness = makeHarness({
      awaitPendingSeatCompaction: (_chatId, participantId) =>
        participantId === 'codex'
          ? new Promise<void>((resolve) => {
              resolveCompaction = resolve
            })
          : undefined
    })

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Original prompt',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1)) // p1 (claude) speaking

    // Finish p1 → the round advances to p2 (codex) and parks in seat compaction.
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(resolveCompaction).toBeDefined())
    expect(harness.dispatched).toHaveLength(1) // p2 not dispatched — parked in compaction

    // Stop lands during the compaction window (activeRunId undefined).
    await harness.orchestrator.cancelRound('ensemble-chat', 'cancelled')

    // Unblock compaction — the loop must NOT dispatch the zombie p2.
    resolveCompaction?.()
    await new Promise((r) => setTimeout(r, 20))
    expect(harness.dispatched).toHaveLength(1) // still only p1 — no zombie codex run
    expect(harness.chat.ensemble?.activeRound?.status).toBe('cancelled') // not stuck 'running'
  })

  it('does not resurrect messages or dispatch after history truncation cancels a paused health probe', async () => {
    let resolveProbe!: (result: ParticipantProbeResult) => void
    const probe = new Promise<ParticipantProbeResult>((resolve) => {
      resolveProbe = resolve
    })
    let historyPrepared = false
    const persistSessionCheckpoint = vi.fn()
    const completeSessionCheckpoint = vi.fn()
    const harness = makeHarness({
      probeParticipant: async () => probe,
      beforeSaveChat: () => {
        if (historyPrepared) throw new Error('AppStore history mutation is prepared')
      },
      persistSessionCheckpoint,
      completeSessionCheckpoint
    })

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Prompt that must be cleared',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.probeParticipant).toHaveBeenCalled())
    expect(harness.dispatched).toHaveLength(0)

    const roundId = harness.chat.ensemble!.activeRound!.roundId
    const saveCountAtPrepare = harness.saveChat.mock.calls.length
    const checkpointCountAtPrepare = persistSessionCheckpoint.mock.calls.length
    historyPrepared = true
    let cancellationJoined = false
    const cancelling = harness.orchestrator
      .cancelRoundForHistory('ensemble-chat', 'chat history cleared', roundId)
      .then((result) => {
        cancellationJoined = true
        return result
      })
    await Promise.resolve()
    expect(cancellationJoined).toBe(false)
    resolveProbe({ reachable: true })
    await expect(cancelling).resolves.toBe(true)
    expect(harness.saveChat).toHaveBeenCalledTimes(saveCountAtPrepare)
    expect(persistSessionCheckpoint).toHaveBeenCalledTimes(checkpointCountAtPrepare)
    expect(completeSessionCheckpoint).not.toHaveBeenCalled()

    // Model the truncate commit after exact round settlement: roster survives,
    // while transcript and active-round projection do not.
    harness.chat.messages = []
    harness.chat.ensemble!.activeRound = undefined

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(harness.dispatched).toHaveLength(0)
    expect(harness.chat.messages).toEqual([])
    expect(harness.chat.ensemble?.participants).toHaveLength(2)
    expect(harness.chat.ensemble?.activeRound).toBeUndefined()
  })

  it('joins an accepted transport without saving or checkpointing after history prepare', async () => {
    const transportJoinGate = deferred<boolean>()
    let historyPrepared = false
    const persistSessionCheckpoint = vi.fn()
    const completeSessionCheckpoint = vi.fn()
    const harness = makeHarness({
      terminateRunForHistory: async () => transportJoinGate.promise,
      beforeSaveChat: () => {
        if (historyPrepared) throw new Error('AppStore history mutation is prepared')
      },
      persistSessionCheckpoint,
      completeSessionCheckpoint
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Delete this live round under the prepared history write guard.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const liveRunId = harness.dispatched[0].appRunId!
    const roundId = harness.chat.ensemble!.activeRound!.roundId
    const saveCountAtPrepare = harness.saveChat.mock.calls.length
    const checkpointCountAtPrepare = persistSessionCheckpoint.mock.calls.length
    const queueTransitionCountAtPrepare = harness.transitionRunQueueJob.mock.calls.length
    historyPrepared = true

    let cancellationJoined = false
    const cancelling = harness.orchestrator
      .cancelRoundForHistory('ensemble-chat', 'chat history cleared', roundId)
      .then((result) => {
        cancellationJoined = true
        return result
      })
    await vi.waitFor(() =>
      expect(harness.terminateRunForHistory).toHaveBeenCalledWith('claude', liveRunId)
    )
    expect(cancellationJoined).toBe(false)
    expect(harness.cancelRun).not.toHaveBeenCalled()
    expect(harness.saveChat).toHaveBeenCalledTimes(saveCountAtPrepare)
    expect(persistSessionCheckpoint).toHaveBeenCalledTimes(checkpointCountAtPrepare)
    expect(completeSessionCheckpoint).not.toHaveBeenCalled()
    expect(harness.transitionRunQueueJob).toHaveBeenCalledTimes(queueTransitionCountAtPrepare)
    expect(
      harness.orchestrator.handleProviderOutput(
        'claude',
        { appRunId: liveRunId, appChatId: 'ensemble-chat' },
        { type: 'content', text: 'MUST-NOT-PERSIST-AFTER-PREPARE.' }
      )
    ).toBe(false)

    transportJoinGate.resolve(true)
    await expect(cancelling).resolves.toBe(true)
    expect(harness.saveChat).toHaveBeenCalledTimes(saveCountAtPrepare)
    expect(persistSessionCheckpoint).toHaveBeenCalledTimes(checkpointCountAtPrepare)
    expect(completeSessionCheckpoint).not.toHaveBeenCalled()
  })

  it('cancels orphaned and sleeping wakeup timers without a running runtime or durable write', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.activeRound = undefined
    initialChat.ensemble!.wakeups = {
      'orphan-wakeup': {
        wakeupId: 'orphan-wakeup',
        chatId: 'ensemble-chat',
        roundId: 'old-round',
        participantId: 'claude',
        provider: 'claude',
        runId: 'old-claude-run',
        scheduledAt: '2026-05-24T00:00:01.000Z',
        wakeAt: '2026-05-24T01:00:01.000Z',
        status: 'pending'
      },
      'sleeping-wakeup': {
        wakeupId: 'sleeping-wakeup',
        chatId: 'ensemble-chat',
        roundId: 'sleeping-round',
        participantId: 'codex',
        provider: 'codex',
        runId: 'old-codex-run',
        scheduledAt: '2026-05-24T00:00:02.000Z',
        wakeAt: '2026-05-24T02:00:02.000Z',
        status: 'pending'
      }
    }
    const cancelWakeupTimer = vi.fn()
    const persistSessionCheckpoint = vi.fn()
    const completeSessionCheckpoint = vi.fn()
    const harness = makeHarness({
      initialChat,
      cancelWakeupTimer,
      beforeSaveChat: () => {
        throw new Error('AppStore history mutation is prepared')
      },
      persistSessionCheckpoint,
      completeSessionCheckpoint
    })
    const targetPollTimer = setTimeout(() => undefined, 60_000)
    const siblingPollTimer = setTimeout(() => undefined, 60_000)
    targetPollTimer.unref?.()
    siblingPollTimer.unref?.()
    const pollTimers = (
      harness.orchestrator as unknown as {
        bossmanPollTimeoutsById: Map<
          string,
          {
            chatId: string
            pollId: string
            handle: ReturnType<typeof setTimeout>
          }
        >
      }
    ).bossmanPollTimeoutsById
    pollTimers.set('target-poll-key', {
      chatId: 'ensemble-chat',
      pollId: 'target-poll',
      handle: targetPollTimer
    })
    pollTimers.set('sibling-poll-key', {
      // Valid chat ids may contain `:`. This must not be treated as the target
      // chat merely because its textual prefix is the same.
      chatId: 'ensemble-chat:child',
      pollId: 'sibling-poll',
      handle: siblingPollTimer
    })

    try {
      await expect(harness.orchestrator.cancelRoundForHistory('ensemble-chat')).resolves.toBe(true)
      expect(cancelWakeupTimer.mock.calls.map(([id]) => id).sort()).toEqual([
        'orphan-wakeup',
        'sleeping-wakeup'
      ])
      expect(pollTimers.has('target-poll-key')).toBe(false)
      expect(pollTimers.get('sibling-poll-key')?.handle).toBe(siblingPollTimer)
      expect(harness.saveChat).not.toHaveBeenCalled()
      expect(persistSessionCheckpoint).not.toHaveBeenCalled()
      expect(completeSessionCheckpoint).not.toHaveBeenCalled()
      // The outer transaction owns the only durable mutation. Locally there is
      // no runtime left for an already-queued callback to fire or re-arm.
      expect(harness.orchestrator.handleWakeupFired('orphan-wakeup')).toBe(false)
      expect(harness.orchestrator.handleWakeupFired('sleeping-wakeup')).toBe(false)
      expect(harness.chat.ensemble?.wakeups?.['orphan-wakeup']?.status).toBe('pending')
    } finally {
      clearTimeout(targetPollTimer)
      clearTimeout(siblingPollTimer)
    }
  })

  it('does not dispatch fan-out lanes onto a round cancelled during seat compaction', async () => {
    // Same zombie-dispatch class as the serial path, but in the parallel
    // read-only fan-out pass: the seat-compaction barrier (Promise.all over every
    // lane) can block for seconds, and a Stop landing there cancels the round
    // while activeScoutRunIds is still empty — so cancelRound interrupts nothing
    // and, without a re-check, the pass seeds + dispatches zombie lanes.
    const previous = process.env.TASKWRAITH_CONCURRENT_LANES
    process.env.TASKWRAITH_CONCURRENT_LANES = '1'
    try {
      let resolveCompaction: (() => void) | undefined
      const harness = makeHarness({
        awaitPendingSeatCompaction: (_chatId, participantId) =>
          participantId === 'ollama-a'
            ? new Promise<void>((resolve) => {
                resolveCompaction = resolve
              })
            : undefined
      })
      harness.chat.ensemble!.participants = [
        {
          id: 'ollama-a',
          provider: 'ollama',
          enabled: true,
          role: 'Scout A',
          instructions: 'Scout.',
          order: 1,
          permissionPresetId: 'read_only',
          model: 'qwen3.5:9b',
          ollamaRunProfile: 'local_scout'
        },
        {
          id: 'ollama-b',
          provider: 'ollama',
          enabled: true,
          role: 'Scout B',
          instructions: 'Scout.',
          order: 2,
          permissionPresetId: 'read_only',
          model: 'gemma4:12b',
          ollamaRunProfile: 'local_scout'
        }
      ]

      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Fan out locally.',
        event: { sender: {} as Electron.WebContents },
        concurrentMode: true
      })

      // Fan-out pass parks in the Promise.all seat-compaction barrier (ollama-a).
      await vi.waitFor(() => expect(resolveCompaction).toBeDefined())
      expect(harness.dispatched).toHaveLength(0) // lanes not seeded yet

      await harness.orchestrator.cancelRound('ensemble-chat', 'cancelled')

      // Unblock — the pass must NOT seed/dispatch zombie lanes.
      resolveCompaction?.()
      await new Promise((r) => setTimeout(r, 20))
      expect(harness.dispatched).toHaveLength(0)
    } finally {
      if (previous === undefined) delete process.env.TASKWRAITH_CONCURRENT_LANES
      else process.env.TASKWRAITH_CONCURRENT_LANES = previous
    }
  })

  it('signposts fan-out lanes waiting on pre-dispatch seat compaction', async () => {
    const previous = process.env.TASKWRAITH_CONCURRENT_LANES
    process.env.TASKWRAITH_CONCURRENT_LANES = '1'
    try {
      let resolveCompaction: (() => void) | undefined
      const progressEvents: ContextCompactionProgressEvent[] = []
      const harness = makeHarness({
        awaitPendingSeatCompaction: (_chatId, participantId) =>
          participantId === 'ollama-a'
            ? new Promise<void>((resolve) => {
                resolveCompaction = resolve
              })
            : undefined,
        onContextCompactionProgress: (event) => progressEvents.push(event)
      })
      harness.chat.ensemble!.participants = [
        {
          id: 'ollama-a',
          provider: 'ollama',
          enabled: true,
          role: 'Scout A',
          instructions: 'Scout.',
          order: 1,
          permissionPresetId: 'read_only',
          model: 'qwen3.5:9b',
          ollamaRunProfile: 'local_scout'
        },
        {
          id: 'ollama-b',
          provider: 'ollama',
          enabled: true,
          role: 'Scout B',
          instructions: 'Scout.',
          order: 2,
          permissionPresetId: 'read_only',
          model: 'gemma4:12b',
          ollamaRunProfile: 'local_scout'
        }
      ]

      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Fan out locally.',
        event: { sender: {} as Electron.WebContents },
        concurrentMode: true
      })

      await vi.waitFor(() => expect(resolveCompaction).toBeDefined())
      expect(harness.dispatched).toHaveLength(0)
      expect(progressEvents).toContainEqual(
        expect.objectContaining({
          chatId: 'ensemble-chat',
          participantId: 'ollama-a',
          provider: 'ollama',
          status: 'started',
          trigger: 'auto',
          label: expect.stringContaining('Scout A')
        })
      )

      resolveCompaction?.()
      await vi.waitFor(() =>
        expect(progressEvents).toContainEqual(
          expect.objectContaining({
            chatId: 'ensemble-chat',
            participantId: 'ollama-a',
            provider: 'ollama',
            status: 'completed',
            trigger: 'auto'
          })
        )
      )
    } finally {
      if (previous === undefined) delete process.env.TASKWRAITH_CONCURRENT_LANES
      else process.env.TASKWRAITH_CONCURRENT_LANES = previous
    }
  })

  it('preserves queued prompt external grants when the queued ensemble round dispatches', async () => {
    const harness = makeHarness()
    // Single seat so the same-round boundary re-dispatches the grant's provider
    // after absorb (multi-seat would advance to the next peer first).
    harness.chat.ensemble!.participants = [harness.chat.ensemble!.participants[0]]
    const queuedGrant = externalGrant('claude', '/tmp/queued-spec.pdf')
    const started = harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Original prompt',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const firstRoundId = started.roundId

    const queued = harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Queued prompt',
      imageAttachments: [
        { id: 'pdf-queued', path: '/tmp/queued-spec.pdf', name: 'queued-spec.pdf' }
      ],
      externalPathGrants: [queuedGrant],
      event: { sender: {} as Electron.WebContents },
      mode: 'queue'
    })
    expect(queued.status).toBe('queued')

    harness.orchestrator.handleProviderOutput(
      'claude',
      {
        appRunId: harness.dispatched[0].appRunId,
        appChatId: 'ensemble-chat'
      },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('claude')
    expect(harness.chat.ensemble?.activeRound?.roundId).toBe(firstRoundId)
    expect(harness.dispatched[1].imagePaths).toEqual([])
    expect(harness.dispatched[1].prompt).toContain('/tmp/queued-spec.pdf')
    expect(harness.dispatched[1].prompt).toContain('User-approved additional workspace access')
    expect(harness.dispatched[1].externalPathGrants).toMatchObject([
      { provider: 'claude', path: '/tmp/queued-spec.pdf', access: 'read' }
    ])
  })

  it('returns attachment snapshots from removeQueuedPrompt so Edit can restore them', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Original prompt',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const queued = harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Queued with image',
      event: { sender: {} as Electron.WebContents },
      mode: 'queue',
      imageAttachments: [{ id: 'img-1', path: '/tmp/queued.png', name: 'queued.png' }]
    })
    expect(queued.status).toBe('queued')

    const removed = harness.orchestrator.removeQueuedPrompt({
      chatId: 'ensemble-chat',
      index: 0,
      textPrefix: 'Queued with image'
    })

    expect(removed).toMatchObject({
      ok: true,
      prompt: expect.stringContaining('Queued with image'),
      queuedPrompts: [],
      imageAttachments: [{ id: 'img-1', path: '/tmp/queued.png', name: 'queued.png' }]
    })
  })

  it('removes queued prompts from runtime state so deleted entries do not dispatch later', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Original prompt',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    for (const prompt of ['Queued A', 'Queued B']) {
      const queued = harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt,
        event: { sender: {} as Electron.WebContents },
        mode: 'queue'
      })
      expect(queued.status).toBe('queued')
    }

    const removed = harness.orchestrator.removeQueuedPrompt({
      chatId: 'ensemble-chat',
      index: 0,
      textPrefix: 'Queued A'
    })

    expect(removed).toMatchObject({
      ok: true,
      prompt: 'Queued A',
      queuedPrompts: ['Queued B']
    })
    expect(harness.chat.ensemble?.activeRound?.queuedPrompts).toEqual(['Queued B'])

    harness.orchestrator.handleProviderOutput(
      'claude',
      {
        appRunId: harness.dispatched[0].appRunId,
        appChatId: 'ensemble-chat'
      },
      {
        type: 'result',
        status: 'success'
      }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].prompt).toContain('Queued B')
    expect(harness.dispatched[1].prompt).not.toContain('Queued A')
    expect(harness.chat.ensemble?.activeRound?.prompt).toBe('Original prompt')
  })

  it('targets queued items by stable id when duplicate prompts exist', async () => {
    const harness = makeHarness()
    const started = harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Original prompt',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const firstRoundId = started.roundId

    for (const prompt of ['Queued A', 'Queued A', 'Queued C']) {
      const queued = harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt,
        event: { sender: {} as Electron.WebContents },
        mode: 'queue'
      })
      expect(queued.status).toBe('queued')
    }
    const runtimeQueue = getRuntimeQueuedPrompts(harness.orchestrator, 'ensemble-chat')
    expect(runtimeQueue.map((entry) => entry.prompt)).toEqual(['Queued A', 'Queued A', 'Queued C'])
    expect(runtimeQueue[1]).toBeDefined()
    const secondQueuedId = runtimeQueue[1]!.id
    const firstQueuedId = runtimeQueue[0]!.id

    const steered = harness.orchestrator.steerQueuedPrompt({
      chatId: 'ensemble-chat',
      index: 1,
      textPrefix: 'Queued A',
      queuedPromptId: secondQueuedId,
      event: { sender: {} as Electron.WebContents }
    })

    expect(steered.status).toBe('steered')
    expect(steered.roundId).toBe(firstRoundId)
    expect(harness.cancelRun).not.toHaveBeenCalled()
    expect(harness.dispatched).toHaveLength(1)
    expect(harness.chat.ensemble?.activeRound?.roundId).toBe(firstRoundId)
    expect(harness.chat.ensemble?.activeRound?.prompt).toBe('Original prompt')
    expect(harness.chat.ensemble?.activeRound?.queuedPrompts).toEqual(['Queued A', 'Queued C'])
    expect(harness.chat.ensemble?.activeRound?.queuedPrompt).toBe('Queued A')
    expect(
      getRuntimeQueuedPrompts(harness.orchestrator, 'ensemble-chat').map((entry) => entry.id)
    ).toEqual([firstQueuedId, runtimeQueue[2]!.id])
    expect(harness.chat.messages.map((message) => message.content)).toContain('Queued A')
  })

  it('removes a duplicate queued prompt by stable id and preserves FIFO order', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Original prompt',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    for (const prompt of ['Queued A', 'Queued A', 'Queued C']) {
      const queued = harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt,
        event: { sender: {} as Electron.WebContents },
        mode: 'queue'
      })
      expect(queued.status).toBe('queued')
    }

    const runtimeQueue = getRuntimeQueuedPrompts(harness.orchestrator, 'ensemble-chat')
    const secondQueuedId = runtimeQueue[1]!.id
    const removed = harness.orchestrator.removeQueuedPrompt({
      chatId: 'ensemble-chat',
      index: 1,
      textPrefix: 'Queued A',
      queuedPromptId: secondQueuedId
    })
    expect(removed).toMatchObject({
      ok: true,
      prompt: 'Queued A',
      queuedPrompts: ['Queued A', 'Queued C']
    })
    expect(harness.chat.ensemble?.activeRound?.queuedPrompts).toEqual(['Queued A', 'Queued C'])
    expect(
      getRuntimeQueuedPrompts(harness.orchestrator, 'ensemble-chat').map((entry) => entry.id)
    ).toEqual([runtimeQueue[0]!.id, runtimeQueue[2]!.id])

    harness.orchestrator.handleProviderOutput(
      'claude',
      {
        appRunId: harness.dispatched[0].appRunId,
        appChatId: 'ensemble-chat'
      },
      {
        type: 'result',
        status: 'success'
      }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].prompt).toContain('Queued A')
    expect(harness.dispatched[1].prompt).not.toContain('Queued C')
    expect(harness.chat.ensemble?.activeRound?.prompt).toBe('Original prompt')
    expect(harness.chat.ensemble?.activeRound?.queuedPrompts).toEqual(['Queued C'])

    harness.orchestrator.handleProviderOutput(
      harness.dispatched[1].provider,
      {
        appRunId: harness.dispatched[1].appRunId,
        appChatId: 'ensemble-chat'
      },
      {
        type: 'result',
        status: 'success'
      }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[2].prompt).toContain('Queued C')
    expect(harness.chat.ensemble?.activeRound?.prompt).toBe('Original prompt')
  })

  it('rejects queued prompt operations when id mismatches the index', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Original prompt',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const queue = ['Queued A', 'Queued B']
    for (const prompt of queue) {
      const queued = harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt,
        event: { sender: {} as Electron.WebContents },
        mode: 'queue'
      })
      expect(queued.status).toBe('queued')
    }

    const runtimeQueue = getRuntimeQueuedPrompts(harness.orchestrator, 'ensemble-chat')
    const result = harness.orchestrator.steerQueuedPrompt({
      chatId: 'ensemble-chat',
      index: 0,
      queuedPromptId: runtimeQueue[1]!.id,
      event: { sender: {} as Electron.WebContents }
    })
    expect(result.status).toBe('ignored')
    expect(result.error).toBe('Queue changed underneath — refresh and retry')
    expect(harness.chat.ensemble?.activeRound?.queuedPrompts).toEqual(queue)
  })

  it('rejects queued prompt removal when textPrefix no longer points at requested index', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Original prompt',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    for (const prompt of ['Queued A', 'Queued B']) {
      const queued = harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt,
        event: { sender: {} as Electron.WebContents },
        mode: 'queue'
      })
      expect(queued.status).toBe('queued')
    }

    const result = harness.orchestrator.removeQueuedPrompt({
      chatId: 'ensemble-chat',
      index: 0,
      textPrefix: 'Queued B'
    })

    expect(result).toMatchObject({
      ok: false,
      error: 'Queue changed underneath — refresh and retry'
    })
    expect(harness.chat.ensemble?.activeRound?.queuedPrompts).toEqual(['Queued A', 'Queued B'])
  })

  it('rejects stale index/textPrefix combinations instead of steering the wrong queued prompt', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Original prompt',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    for (const prompt of ['Queued A', 'Queued B']) {
      const queued = harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt,
        event: { sender: {} as Electron.WebContents },
        mode: 'queue'
      })
      expect(queued.status).toBe('queued')
    }

    const result = harness.orchestrator.steerQueuedPrompt({
      chatId: 'ensemble-chat',
      index: 0,
      textPrefix: 'Queued B',
      event: { sender: {} as Electron.WebContents }
    })

    expect(result.status).toBe('ignored')
    expect(result.error).toBe('Queue changed underneath — refresh and retry')
    expect(harness.chat.ensemble?.activeRound?.queuedPrompts).toEqual(['Queued A', 'Queued B'])
  })

  it('continues to the next participant when the current participant yields', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Split this work.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    expectYielded(
      harness.orchestrator.markYielded(harness.dispatched[0].appRunId!, 'Passing to worker.')
    )

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('codex')
    expect(harness.chat.messages.map((message) => message.content)).toContain(
      'Reviewer yielded. Passing to worker.'
    )
  })

  it('separates Codex ensemble assistant items instead of collapsing them into one wall', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Codex should execute this.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    harness.orchestrator.markYielded(harness.dispatched[0].appRunId!, 'Passing to worker.')
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

    harness.orchestrator.handleProviderOutput(
      'codex',
      {
        appRunId: harness.dispatched[1].appRunId,
        appChatId: 'ensemble-chat'
      },
      {
        type: 'content',
        text: 'Baselines are captured.',
        itemId: 'codex-agent-message-1'
      }
    )
    harness.orchestrator.handleProviderOutput(
      'codex',
      {
        appRunId: harness.dispatched[1].appRunId,
        appChatId: 'ensemble-chat'
      },
      {
        type: 'content',
        text: 'The bulk replacement path changed all markers.',
        itemId: 'codex-agent-message-2'
      }
    )
    harness.orchestrator.handleProviderOutput(
      'codex',
      {
        appRunId: harness.dispatched[1].appRunId,
        appChatId: 'ensemble-chat'
      },
      {
        type: 'result',
        status: 'success'
      }
    )

    const codexMessage = harness.chat.messages.find(
      (message) => message.role === 'assistant' && message.metadata?.ensembleProvider === 'codex'
    )
    expect(codexMessage?.content).toContain(
      'Baselines are captured.\n\n---\n\nThe bulk replacement path changed all markers.'
    )
    expect(codexMessage?.content).not.toContain(
      'Baselines are captured.The bulk replacement path changed all markers.'
    )
  })

  it('accumulates Gemini CLI message-shape deltas into the ensemble assistant message', async () => {
    // Regression: pre-fix, `handleProviderOutput` only matched
    // `{ type: 'content', text }` — Codex / Claude / Kimi shape. Gemini's
    // CLI fallback path emits `{ type: 'message', role: 'assistant',
    // delta: true, content }` so its deltas were silently dropped and
    // `run.content` stayed empty, leaving the participant's bubble
    // missing in the transcript. The shape branch in
    // `EnsembleOrchestrator.handleProviderOutput()` now accepts both.
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'ensemble-gemini',
        provider: 'gemini',
        enabled: true,
        role: 'Researcher',
        instructions: 'Research.',
        order: 1,
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Gemini, what is the weather?',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].provider).toBe('gemini')

    const route = {
      appRunId: harness.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }
    harness.orchestrator.handleProviderOutput('gemini', route, {
      type: 'message',
      role: 'assistant',
      delta: true,
      content: 'Yo!'
    })
    harness.orchestrator.handleProviderOutput('gemini', route, {
      type: 'message',
      role: 'assistant',
      delta: true,
      content: ' Doing great, honestly.'
    })
    harness.orchestrator.handleProviderOutput('gemini', route, {
      type: 'message',
      role: 'assistant',
      delta: true,
      content: ' Sunset is beautiful.'
    })
    harness.orchestrator.handleProviderOutput('gemini', route, {
      type: 'result',
      status: 'success',
      stats: { total_tokens: 47070 }
    })

    const geminiMessage = harness.chat.messages.find(
      (message) => message.role === 'assistant' && message.metadata?.ensembleProvider === 'gemini'
    )
    expect(geminiMessage?.content).toBe('Yo! Doing great, honestly. Sunset is beautiful.')
  })

  it('1.0.5-EW16: accumulates Gemini CLI token-shape events into the ensemble assistant message', async () => {
    // Regression: handleProviderOutput pre-EW16 had no branch for
    // `{ type: 'token', content }` events, so token-streamed Gemini
    // turns silently fell through to `return true` without ever
    // touching `run.content`. flushRun's content-trim guard then
    // skipped the assistant-message append, and the transcript
    // stayed blank while the round timer ticked — making it look
    // like Gemini was hung when it was actually streaming fine.
    // The renderer's GeminiAdapter has handled token events since
    // 1.0.0 (GeminiAdapter.ts:158-162); this brings the orchestrator
    // bridge to parity.
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'ensemble-gemini',
        provider: 'gemini',
        enabled: true,
        role: 'Researcher',
        instructions: 'Research.',
        order: 1,
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Gemini, what is the weather?',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const route = {
      appRunId: harness.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }
    harness.orchestrator.handleProviderOutput('gemini', route, {
      type: 'token',
      content: 'Token-streamed '
    })
    harness.orchestrator.handleProviderOutput('gemini', route, {
      type: 'token',
      content: 'reply '
    })
    harness.orchestrator.handleProviderOutput('gemini', route, {
      type: 'token',
      content: 'lands cleanly.'
    })
    harness.orchestrator.handleProviderOutput('gemini', route, {
      type: 'result',
      status: 'success',
      stats: { total_tokens: 31337 }
    })

    const geminiMessage = harness.chat.messages.find(
      (message) => message.role === 'assistant' && message.metadata?.ensembleProvider === 'gemini'
    )
    expect(geminiMessage?.content).toBe('Token-streamed reply lands cleanly.')
  })

  it('1.0.5-EW16: accepts content events that carry `content` instead of `text`', async () => {
    // Regression: pre-EW16 the orchestrator's content-branch
    // gated on `typeof payload.text === 'string'`. Some Gemini CLI
    // builds emit `{ type: 'content', content: '…' }` rather than
    // `{ type: 'content', text: '…' }` — the renderer's adapter
    // falls back to `parsed.content` (GeminiAdapter.ts:99), but the
    // orchestrator did not, so these events were dropped silently.
    // Same observable symptom as the token-event case: empty bubble
    // even though Gemini was clearly streaming.
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'ensemble-gemini',
        provider: 'gemini',
        enabled: true,
        role: 'Researcher',
        instructions: 'Research.',
        order: 1,
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Gemini, can you hear me?',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const route = {
      appRunId: harness.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }
    harness.orchestrator.handleProviderOutput('gemini', route, {
      type: 'content',
      content: 'Loud and clear.'
    })
    harness.orchestrator.handleProviderOutput('gemini', route, {
      type: 'result',
      status: 'success',
      stats: { total_tokens: 100 }
    })

    const geminiMessage = harness.chat.messages.find(
      (message) => message.role === 'assistant' && message.metadata?.ensembleProvider === 'gemini'
    )
    expect(geminiMessage?.content).toBe('Loud and clear.')
  })

  it('1.0.4-AB: does not double assistant content when a non-delta final message follows streamed deltas', async () => {
    // Regression: providers that stream `{ type: 'message', delta: true,
    // content }` deltas (Gemini CLI) AND then close the turn with a
    // non-delta `{ type: 'message', content: <full text> }` were
    // producing duplicated assistant bubbles — the final non-delta
    // payload would re-append the entire turn on top of the
    // already-accumulated delta stream.
    //
    // Reported by the maintainer from a Claude ensemble session that contained
    // the paragraph "(And — same ECONNREFUSED ...)" twice in a single
    // bubble. The fix: treat a non-delta `type: 'message'` as
    // authoritative ONLY when no deltas have already streamed; when
    // we already have accumulated content, the final repeat is a
    // no-op (the stream already produced the full text).
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'ensemble-gemini',
        provider: 'gemini',
        enabled: true,
        role: 'Researcher',
        instructions: 'Research.',
        order: 1,
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Tell me a fact.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const route = {
      appRunId: harness.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }
    // 1. Stream delta chunks.
    harness.orchestrator.handleProviderOutput('gemini', route, {
      type: 'message',
      role: 'assistant',
      delta: true,
      content: 'Sunsets are '
    })
    harness.orchestrator.handleProviderOutput('gemini', route, {
      type: 'message',
      role: 'assistant',
      delta: true,
      content: 'beautiful.'
    })
    // 2. Provider closes the turn with the full-text non-delta repeat
    //    BEFORE the result event arrives. Pre-fix this would have
    //    appended "Sunsets are beautiful." a second time.
    harness.orchestrator.handleProviderOutput('gemini', route, {
      type: 'message',
      role: 'assistant',
      content: 'Sunsets are beautiful.'
    })
    harness.orchestrator.handleProviderOutput('gemini', route, {
      type: 'result',
      status: 'success'
    })

    const geminiMessage = harness.chat.messages.find(
      (message) => message.role === 'assistant' && message.metadata?.ensembleProvider === 'gemini'
    )
    expect(geminiMessage?.content).toBe('Sunsets are beautiful.')
  })

  it('does not double assistant content when a tagged cumulative content payload follows streamed deltas', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Say something short.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const route = {
      appRunId: harness.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'content',
      text: 'Line one.'
    })
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'content',
      text: 'Line one.',
      cumulative: true
    })
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'result',
      status: 'success'
    })

    const claudeMessage = harness.chat.messages.find(
      (message) => message.role === 'assistant' && message.metadata?.ensembleProvider === 'claude'
    )
    expect(claudeMessage?.content).toBe('Line one.')
  })

  it('keeps only the tail from an explicitly tagged cumulative content snapshot', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Say something short.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const route = {
      appRunId: harness.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'content',
      text: 'Alpha'
    })
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'content',
      text: 'Alpha beta',
      runItemCumulative: true
    })
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'result',
      status: 'success'
    })

    const claudeMessage = harness.chat.messages.find(
      (message) => message.role === 'assistant' && message.metadata?.ensembleProvider === 'claude'
    )
    expect(claudeMessage?.content).toBe('Alpha beta')
  })

  it('preserves a one-character compat delta that matches the response prefix', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Reply with the exact lifecycle token.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const route = {
      appRunId: harness.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }
    for (const text of ['Captain', ' STE', 'ER', '-', 'C']) {
      harness.orchestrator.handleProviderOutput('claude', route, {
        type: 'content',
        text
      })
    }
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'result',
      status: 'success'
    })

    const captainMessage = harness.chat.messages.find(
      (message) => message.role === 'assistant' && message.runId === route.appRunId
    )
    expect(captainMessage?.content).toBe('Captain STEER-C')
  })

  it('places only the post-tool tail from a cumulative content restatement', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Use a tool then summarize.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const route = {
      appRunId: harness.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'content',
      text: 'Before.'
    })
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'tool_use',
      tool_id: 'call-1',
      tool_name: 'read_file',
      parameters: { file_path: '/tmp/notes.md' }
    })
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'tool_result',
      tool_id: 'call-1',
      content: 'File contents...'
    })
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'content',
      text: 'Before.After.',
      cumulative: true
    })
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'result',
      status: 'success'
    })

    const participantMessages = harness.chat.messages.filter(
      (message) =>
        message.runId === harness.dispatched[0].appRunId &&
        (message.role === 'assistant' || message.role === 'tool')
    )
    expect(participantMessages.map((message) => message.role)).toEqual([
      'assistant',
      'tool',
      'assistant'
    ])
    expect(participantMessages[0].content).toBe('Before.')
    expect(participantMessages[2].content).toBe('After.')
  })

  it('1.0.4-AB: non-delta message-shape payload stands alone when no deltas streamed', async () => {
    // Companion to the AB regression test above. The fix must NOT
    // break providers that emit ONLY a single non-delta
    // `{ type: 'message', content }` payload (no streaming deltas).
    // In that case the non-delta is authoritative and should
    // populate the assistant bubble exactly as before.
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'ensemble-gemini',
        provider: 'gemini',
        enabled: true,
        role: 'Researcher',
        instructions: 'Research.',
        order: 1,
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Fact, please.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const route = {
      appRunId: harness.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }
    // Single non-delta final message — no streaming deltas first.
    harness.orchestrator.handleProviderOutput('gemini', route, {
      type: 'message',
      role: 'assistant',
      content: 'Mountains are tall.'
    })
    harness.orchestrator.handleProviderOutput('gemini', route, {
      type: 'result',
      status: 'success'
    })

    const geminiMessage = harness.chat.messages.find(
      (message) => message.role === 'assistant' && message.metadata?.ensembleProvider === 'gemini'
    )
    expect(geminiMessage?.content).toBe('Mountains are tall.')
  })

  it('strips Gemini pseudo-system yield text from visible assistant content', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'ensemble-gemini',
        provider: 'gemini',
        enabled: true,
        role: 'Researcher',
        instructions: 'Research.',
        order: 1,
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Share your view, then yield.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const route = {
      appRunId: harness.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }
    harness.orchestrator.handleProviderOutput('gemini', route, {
      type: 'message',
      role: 'assistant',
      delta: true,
      content: 'A ledger would help agents interpret intentional setup changes.\n\n'
    })
    harness.orchestrator.handleProviderOutput('gemini', route, {
      type: 'message',
      role: 'assistant',
      delta: true,
      content:
        '[System] Yielding to Kimi to see if they agree before circling back to screenshots.\n\n'
    })
    harness.orchestrator.handleProviderOutput('gemini', route, {
      type: 'message',
      role: 'assistant',
      delta: true,
      content: 'I am passing the floor now.'
    })
    harness.orchestrator.handleProviderOutput('gemini', route, {
      type: 'result',
      status: 'success'
    })

    const geminiMessage = harness.chat.messages.find(
      (message) => message.role === 'assistant' && message.metadata?.ensembleProvider === 'gemini'
    )
    expect(geminiMessage?.content).toBe(
      'A ledger would help agents interpret intentional setup changes.\n\nI am passing the floor now.'
    )
    expect(geminiMessage?.content).not.toContain('[System]')
  })

  it('skipActiveParticipant cancels the active run and advances to the next participant', async () => {
    // Post-ship UX: replaces the redundant "Stop Ensemble" button with
    // a per-participant Skip affordance. Skip must:
    //   1. Call `cancelRun` so the provider stream stops
    //   2. Finalise the active run as `'skipped'` (not `'yielded'`,
    //      which implies the model voluntarily passed)
    //   3. Let `runRound`'s while-loop advance naturally to the next
    //      participant without restarting the round (unlike Steer,
    //      which cancels + re-dispatches the same participant)
    //   4. Drop a system message announcing the skip
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].provider).toBe('claude')

    const skipped = await harness.orchestrator.skipActiveParticipant('ensemble-chat')
    expect(skipped).toBe(true)
    expect(harness.cancelRun).toHaveBeenCalledWith('claude', harness.dispatched[0].appRunId)
    expect(harness.transitionRunQueueJob).toHaveBeenCalledWith(
      harness.dispatched[0].appRunId,
      'cancelled',
      { statusReason: 'Skipped by user.' }
    )

    // Round continues — next participant dispatched without restart.
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('codex')

    // System message announcing the skip.
    const skipMessage = harness.chat.messages.find(
      (message) => message.role === 'system' && message.metadata?.ensembleStatus === 'skipped'
    )
    expect(skipMessage?.content).toContain('Reviewer skipped.')
    expect(skipMessage?.metadata?.ensembleProvider).toBe('claude')
  })

  it('preserves every participant during the initial pass even when Boss requests a skip', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const result = await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'skip_participant',
      roundId: harness.chat.ensemble?.activeRound?.roundId,
      targetParticipantId: 'codex',
      reason: 'Codex lacks context for this turn.'
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('initial_pass_preserves_roster')
    const codexState = harness.chat.ensemble?.activeRound?.participants.find(
      (participant) => participant.participantId === 'codex'
    )
    expect(codexState?.status).toBe('idle')

    harness.orchestrator.handleProviderOutput(
      'claude',
      {
        appRunId: harness.dispatched[0].appRunId,
        appChatId: 'ensemble-chat'
      },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('codex')
    harness.orchestrator.handleProviderOutput(
      'codex',
      {
        appRunId: harness.dispatched[1].appRunId,
        appChatId: 'ensemble-chat'
      },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
  })

  it('lets a later Continuous-pass Boss keep an explicit subset and skips every other pending seat', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.orchestrationMode = 'continuous'
    initialChat.ensemble!.participants.push({
      id: 'kimi',
      provider: 'kimi',
      enabled: true,
      role: 'Researcher',
      instructions: 'Research.',
      order: 3,
      permissionPresetId: 'read_only'
    })
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runtime = (
      harness.orchestrator as unknown as {
        roundsByChatId: Map<string, { continuationPass: number }>
      }
    ).roundsByChatId.get('ensemble-chat')!
    runtime.continuationPass = 2

    const selection = await harness.orchestrator.bossmanControlForRun(
      harness.dispatched[0].appRunId,
      {
        action: 'select_participants',
        participantRoles: ['Worker'],
        reason: 'Implementation is ready for a single writer.'
      }
    )

    expect(selection).toMatchObject({ ok: true, action: 'select_participants' })
    expect(
      harness.chat.ensemble?.activeRound?.participants.find(
        (participant) => participant.participantId === 'kimi'
      )?.status
    ).toBe('skipped')
    expectYielded(
      harness.orchestrator.markYielded(harness.dispatched[0].appRunId!, 'Worker should continue.')
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('codex')
  })

  it('lets the active Captain select a later-pass subset after the Boss is unavailable', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.secondInCommandParticipantId = 'codex'
    initialChat.ensemble!.orchestrationMode = 'continuous'
    initialChat.ensemble!.participants = [
      { ...initialChat.ensemble!.participants[0], enabled: false, role: 'Boss' },
      { ...initialChat.ensemble!.participants[1], role: 'Captain' },
      {
        id: 'kimi',
        provider: 'kimi',
        enabled: true,
        role: 'Researcher',
        instructions: 'Research.',
        order: 3,
        permissionPresetId: 'read_only'
      },
      {
        id: 'grok',
        provider: 'grok',
        enabled: true,
        role: 'Analyst',
        instructions: 'Analyze.',
        order: 4,
        permissionPresetId: 'read_only'
      }
    ]
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('codex')
    const runtime = (
      harness.orchestrator as unknown as {
        roundsByChatId: Map<string, { continuationPass: number }>
      }
    ).roundsByChatId.get('ensemble-chat')!
    runtime.continuationPass = 2

    const selection = await harness.orchestrator.bossmanControlForRun(
      harness.dispatched[0].appRunId,
      {
        action: 'select_participants',
        participantRoles: ['Researcher'],
        reason: 'Only research needs another pass.'
      }
    )

    expect(selection).toMatchObject({ ok: true, action: 'select_participants' })
    expect(selection.message).toContain('Captain')
    expect(
      harness.chat.ensemble?.activeRound?.participants.find(
        (participant) => participant.participantId === 'grok'
      )?.status
    ).toBe('skipped')
    expectYielded(harness.orchestrator.markYielded(harness.dispatched[0].appRunId!))
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].ensembleRun?.participantId).toBe('kimi')
  })

  it('queues a late Continuous select_participants and applies it exactly once when the next pass forms', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.orchestrationMode = 'continuous'
    initialChat.ensemble!.participants.push({
      id: 'kimi',
      provider: 'kimi',
      enabled: true,
      role: 'Researcher',
      instructions: 'Research.',
      order: 3,
      permissionPresetId: 'read_only'
    })
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runtime = (
      harness.orchestrator as unknown as {
        roundsByChatId: Map<
          string,
          { continuationPass: number; remainingParticipants: EnsembleParticipant[] }
        >
      }
    ).roundsByChatId.get('ensemble-chat')!
    runtime.continuationPass = 2
    // Both worker seats are already past pending for this pass — the
    // retrospective shape: the Boss decided after the window closed. Splice in
    // place: the serial drain loop holds a reference to this exact array.
    runtime.remainingParticipants.splice(0, runtime.remainingParticipants.length)

    const selection = await harness.orchestrator.bossmanControlForRun(
      harness.dispatched[0].appRunId,
      {
        action: 'select_participants',
        participantRoles: ['Worker'],
        reason: 'Only the landing seat should continue.'
      }
    )

    expect(selection).toMatchObject({ ok: true, action: 'select_participants' })
    expect(selection.message).toContain('queued to apply once when the next Continuous pass forms')
    // Queueing rewrites no seat state in the live pass.
    expect(
      harness.chat.ensemble?.activeRound?.participants.find(
        (participant) => participant.participantId === 'kimi'
      )?.status
    ).toBe('idle')

    // Both worker seats already spoke this pass (that is WHY they were past
    // pending); reflect that so the drain reads a productive pass rather than
    // an administrative deadlock.
    for (const participant of harness.chat.ensemble!.activeRound!.participants) {
      if (participant.participantId !== 'claude') participant.status = 'answered'
    }

    // Boss ends its turn; the drained pass auto-continues into pass 3 with
    // only the kept Worker plus the queuing authority.
    expectYielded(
      harness.orchestrator.markYielded(harness.dispatched[0].appRunId!, 'Queued for next pass.')
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].ensembleRun?.participantId).toBe('claude')
    expect(
      harness.chat.messages.some(
        (message) =>
          typeof message.content === 'string' &&
          message.content.includes('Boss selection queued during pass 2 applied: keeping')
      )
    ).toBe(true)
    // The pass-3 authority turn makes its routing decision explicitly so its
    // completion advances the kept Worker instead of re-summoning the Boss.
    await harness.orchestrator.bossmanControlForRun(harness.dispatched[1].appRunId, {
      action: 'skip_intervention'
    })
    completeDispatchedRun(harness, 1)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[2].ensembleRun?.participantId).toBe('codex')
    expect(
      harness.dispatched.slice(1).map((payload) => payload.ensembleRun?.participantId)
    ).not.toContain('kimi')

    // One-shot: pass 4 forms via ordinary narrowing (authority-only here),
    // not the consumed queue, and the applied note never repeats.
    completeDispatchedRun(harness, 2)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(4))
    expect(harness.dispatched[3].ensembleRun?.participantId).toBe('claude')
    expect(
      harness.chat.messages.filter(
        (message) =>
          typeof message.content === 'string' &&
          message.content.includes('selection queued during pass 2 applied')
      )
    ).toHaveLength(1)
    expect(harness.dispatched.map((payload) => payload.ensembleRun?.participantId)).not.toContain(
      'kimi'
    )
  })

  it('keeps the plain not-pending rejection when no further pass can form', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runtime = (
      harness.orchestrator as unknown as {
        roundsByChatId: Map<
          string,
          { continuationPass: number; remainingParticipants: EnsembleParticipant[] }
        >
      }
    ).roundsByChatId.get('ensemble-chat')!
    runtime.continuationPass = 2
    runtime.remainingParticipants.splice(0, runtime.remainingParticipants.length)

    const selection = await harness.orchestrator.bossmanControlForRun(
      harness.dispatched[0].appRunId,
      {
        action: 'select_participants',
        participantRoles: ['Worker']
      }
    )

    expect(selection).toMatchObject({ ok: false, error: 'invalid_target' })
    expect(selection.message).toContain('no longer pending in this pass')
  })

  it('inserts a tagged Boss checkpoint before a peer yield and allows an explicit opt-out', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.orchestrationMode = 'continuous'
    initialChat.ensemble!.participants[0].role = 'Boss'
    initialChat.ensemble!.participants.push({
      id: 'kimi',
      provider: 'kimi',
      enabled: true,
      role: 'Researcher',
      instructions: 'Research.',
      order: 3,
      permissionPresetId: 'read_only'
    })
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expectYielded(
      harness.orchestrator.markYielded(
        harness.dispatched[0].appRunId!,
        'Worker should inspect the implementation first.',
        'Worker'
      )
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: '@Boss please make the next routing decision.' }
    )
    expectYielded(
      harness.orchestrator.markYielded(
        harness.dispatched[1].appRunId!,
        'Researcher should prepare evidence after the authority check.',
        'Researcher'
      )
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[2].provider).toBe('claude')
    expect(harness.dispatched[2].prompt).toContain('Authority routing checkpoint')

    expect(
      harness.orchestrator.markYielded(harness.dispatched[2].appRunId!, 'No routing change.')
    ).toEqual({
      kind: 'authority_routing_decision_required',
      pass: 1,
      requirement: 'tagged_intervention'
    })
    const optOut = await harness.orchestrator.bossmanControlForRun(harness.dispatched[2].appRunId, {
      action: 'skip_intervention'
    })
    expect(optOut).toMatchObject({ ok: true, action: 'skip_intervention' })
    expectYielded(
      harness.orchestrator.markYielded(
        harness.dispatched[2].appRunId!,
        'Proceed with the original handoff.',
        'Researcher'
      )
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(4))
    expect(harness.dispatched[3].provider).toBe('kimi')
  })

  it('Continuous later-pass Boss quiet answer re-summons authority and does not dispatch Worker', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.orchestrationMode = 'continuous'
    initialChat.ensemble!.maxContinuationHops = 50
    initialChat.ensemble!.participants[0].role = 'Boss'
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Own the round.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runtime = (
      harness.orchestrator as unknown as {
        roundsByChatId: Map<string, { continuationPass: number }>
      }
    ).roundsByChatId.get('ensemble-chat')!
    runtime.continuationPass = 2
    // Re-dispatch is not automatic when we mutate pass mid-run; the active Boss
    // run already carries (or will carry) a selectionRequired checkpoint once
    // Continuous later-pass ownership is enforced. Quiet-answer without a
    // routing decision must re-summon Boss rather than advance to Worker.
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'Looks fine; nothing to route.' }
    )
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(harness.dispatched.length).toBeGreaterThan(1))
    expect(harness.dispatched[1].provider).toBe('claude')
    expect(harness.dispatched[1].ensembleRun?.participantId).toBe('claude')
    expect(harness.dispatched.slice(1).some((entry) => entry.provider === 'codex')).toBe(false)
    expect(harness.chat.messages.some((message) => /re-summon/i.test(message.content || ''))).toBe(
      true
    )
  })

  it('Continuous pass-1 Boss can select_participants / skip; quiet answer without decision re-summons', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.orchestrationMode = 'continuous'
    initialChat.ensemble!.maxContinuationHops = 50
    initialChat.ensemble!.participants[0].role = 'Boss'
    initialChat.ensemble!.participants.push({
      id: 'kimi',
      provider: 'kimi',
      enabled: true,
      role: 'Researcher',
      instructions: 'Research.',
      order: 3,
      permissionPresetId: 'read_only'
    })
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Direct pass one.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].prompt).toContain('Authority routing checkpoint')

    const selection = await harness.orchestrator.bossmanControlForRun(
      harness.dispatched[0].appRunId,
      {
        action: 'select_participants',
        participantRoles: ['Worker'],
        reason: 'Only the writer is needed on pass 1.'
      }
    )
    expect(selection).toMatchObject({ ok: true, action: 'select_participants' })
    expect(
      harness.chat.ensemble?.activeRound?.participants.find(
        (participant) => participant.participantId === 'kimi'
      )?.status
    ).toBe('skipped')
    expectYielded(
      harness.orchestrator.markYielded(
        harness.dispatched[0].appRunId!,
        'Worker should continue.',
        'Worker'
      )
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('codex')

    const quietChat = makeChat()
    quietChat.ensemble!.bossmanParticipantId = 'claude'
    quietChat.ensemble!.orchestrationMode = 'continuous'
    quietChat.ensemble!.maxContinuationHops = 50
    quietChat.ensemble!.participants[0].role = 'Boss'
    const quiet = makeHarness({ initialChat: quietChat })
    quiet.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Direct pass one quietly.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(quiet.dispatched).toHaveLength(1))
    expect(quiet.dispatched[0].prompt).toContain('Authority routing checkpoint')
    quiet.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: quiet.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'Standing by.' }
    )
    quiet.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: quiet.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(quiet.dispatched.length).toBeGreaterThan(1))
    expect(quiet.dispatched[1].provider).toBe('claude')
    expect(quiet.dispatched.some((entry) => entry.provider === 'codex')).toBe(false)
  })

  it('unique @Worker mention from Continuous Boss counts as a routing decision', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.orchestrationMode = 'continuous'
    initialChat.ensemble!.maxContinuationHops = 50
    initialChat.ensemble!.participants[0].role = 'Boss'
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Route via mention.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].prompt).toContain('Authority routing checkpoint')

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: '@Worker please implement the next slice.' }
    )
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('codex')
    expect(harness.chat.messages.some((message) => /re-summon/i.test(message.content || ''))).toBe(
      false
    )
  })

  it('Turn-bound Boss quiet answer still advances without the Continuous must-route gate', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.participants[0].role = 'Boss'
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Panel answers.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].prompt || '').not.toContain(
      'Authority routing checkpoint (Continuous pass'
    )
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'My panel answer.' }
    )
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('codex')
  })

  it('lets Boss explicitly re-summon an answered worker in Continuous mode', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.orchestrationMode = 'continuous'
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.activeGoal = { ...buildActiveGoal('goal-x'), status: 'completed' }
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    expectYielded(
      harness.orchestrator.markYielded(
        harness.dispatched[0].appRunId!,
        'Worker should take the implementation first.',
        'Worker'
      )
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'Implemented most of it.' }
    )
    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[2].provider).toBe('claude')

    const result = await harness.orchestrator.bossmanControlForRun(harness.dispatched[2].appRunId, {
      action: 'summon_participant',
      roundId: harness.chat.ensemble?.activeRound?.roundId,
      targetParticipantId: 'codex',
      reason: 'Finish the implementation handoff.'
    })

    expect(result).toMatchObject({
      ok: true,
      action: 'summon_participant',
      participantId: 'codex'
    })
    expect(harness.chat.ensemble?.activeRound?.continuationHops).toBe(2)
    expect(
      harness.chat.messages.some((message) =>
        (message.content || '').includes(
          'Boss re-summoned Worker (codex). Reason: Finish the implementation handoff. Continuous handoff 2/'
        )
      )
    ).toBe(true)

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[2].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(4))
    expect(harness.dispatched[3].provider).toBe('codex')
  })

  it('does not let a Boss @mention re-summon an already answered worker', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.orchestrationMode = 'continuous'
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.activeGoal = { ...buildActiveGoal('goal-x'), status: 'completed' }
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    harness.orchestrator.markYielded(
      harness.dispatched[0].appRunId!,
      'Worker should take this.',
      'Worker'
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'Initial worker answer.' }
    )
    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[2].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: '@Worker still needs to finish this.' }
    )
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[2].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )

    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    expect(harness.dispatched).toHaveLength(3)
  })

  it('rejects Boss summon outside Continuous mode', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'summon_participant',
      roundId: harness.chat.ensemble?.activeRound?.roundId,
      targetParticipantId: 'codex',
      reason: 'Needs another turn.'
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('summon_not_continuous')
  })

  it('rejects Boss summon when the target is already pending', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.orchestrationMode = 'continuous'
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'summon_participant',
      roundId: harness.chat.ensemble?.activeRound?.roundId,
      targetParticipantId: 'codex',
      reason: 'Move worker now.'
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('summon_target_pending')
    expect(harness.dispatched).toHaveLength(1)
  })

  it('rejects Boss summon when the target participant is disabled', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.orchestrationMode = 'continuous'
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    harness.chat.ensemble!.participants.find((participant) => participant.id === 'codex')!.enabled =
      false

    const result = await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'summon_participant',
      roundId: harness.chat.ensemble?.activeRound?.roundId,
      targetParticipantId: 'codex',
      reason: 'Try a disabled target.'
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('summon_target_disabled')
  })

  it('rejects Boss summon after the per-target round cap', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.orchestrationMode = 'continuous'
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.activeGoal = { ...buildActiveGoal('goal-x'), status: 'completed' }
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    harness.orchestrator.markYielded(
      harness.dispatched[0].appRunId!,
      'Worker should take this.',
      'Worker'
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'Initial worker answer.' }
    )
    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))

    const runtime = (
      harness.orchestrator as unknown as {
        roundsByChatId: Map<string, { bossmanSummonCountsByParticipantId?: Map<string, number> }>
      }
    ).roundsByChatId.get('ensemble-chat')!
    runtime.bossmanSummonCountsByParticipantId = new Map([['codex', 3]])

    const result = await harness.orchestrator.bossmanControlForRun(harness.dispatched[2].appRunId, {
      action: 'summon_participant',
      roundId: harness.chat.ensemble?.activeRound?.roundId,
      targetParticipantId: 'codex',
      reason: 'Try again.'
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('summon_limit')
    expect(harness.chat.ensemble?.activeRound?.continuationHops).toBe(1)
  })

  it('rejects Boss summon when the continuation hop budget is exhausted', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.orchestrationMode = 'continuous'
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.maxContinuationHops = 1
    initialChat.activeGoal = { ...buildActiveGoal('goal-x'), status: 'completed' }
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    harness.orchestrator.markYielded(
      harness.dispatched[0].appRunId!,
      'Worker should take this.',
      'Worker'
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'Initial worker answer.' }
    )
    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))

    const result = await harness.orchestrator.bossmanControlForRun(harness.dispatched[2].appRunId, {
      action: 'summon_participant',
      roundId: harness.chat.ensemble?.activeRound?.roundId,
      targetParticipantId: 'codex',
      reason: 'Need one more pass.'
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('summon_hop_limit')
    expect(harness.dispatched).toHaveLength(3)
    expect(harness.chat.messages.map((message) => message.content)).not.toContain(
      'Continuous handoff limit reached (1/1); returning control to the user.'
    )
  })

  it('C2: set_review_gate stamps the active goal id onto the gate', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Go.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runId = harness.dispatched[0].appRunId
    const roundId = harness.chat.ensemble?.activeRound?.roundId

    await harness.orchestrator.bossmanControlForRun(runId, {
      action: 'set_goal',
      roundId,
      goal: 'Ship the C2 gate scoping'
    })
    const goalId = harness.chat.activeGoal?.id
    expect(goalId).toBeTruthy()
    expect(harness.chat.activeGoal?.objectiveSource).toBe('agent')

    await harness.orchestrator.bossmanControlForRun(runId, {
      action: 'set_review_gate',
      roundId,
      targetParticipantId: 'claude',
      scope: 'final diff'
    })
    const gate = harness.chat.ensemble?.bossmanControlState?.reviewGates?.[0]
    expect(gate?.goalId).toBe(goalId) // C2 — gate bound to the active goal
  })

  // ---- C2 P3 — reviewer-only verdict (submit_review_verdict) --------------
  // Owner-gated, non-upserting, one-sync-RMW, idempotent. codex is dispatched
  // first so it has an active run to call bossmanControlForRun as the caller.
  const mkGate = (
    id: string,
    reviewerParticipantId: string,
    status: 'required' | 'passed' | 'failed' | 'waived' = 'required'
  ) => ({
    id,
    reviewerParticipantId,
    scope: 'final diff',
    status,
    createdAt: '2026-07-12T01:00:00.000Z',
    updatedAt: '2026-07-12T01:00:00.000Z'
  })

  const startVerdictHarness = async (gates: ReturnType<typeof mkGate>[]) => {
    const chat = makeChat()
    chat.ensemble!.participants = [
      { ...chat.ensemble!.participants[0], order: 2 }, // claude order 2
      { ...chat.ensemble!.participants[1], order: 1 } // codex order 1 ⇒ the caller run
    ]
    chat.ensemble!.bossmanParticipantId = 'claude'
    chat.ensemble!.bossmanControlState = { reviewGates: gates }
    const harness = makeHarness({ initialChat: chat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Go.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('codex')
    return { harness, codexRunId: harness.dispatched[0].appRunId }
  }

  it('C2 P3 T6a: the gate owner submits a verdict on their OWN gate (status flips in one RMW)', async () => {
    const { harness, codexRunId } = await startVerdictHarness([mkGate('g1', 'codex', 'required')])
    const result = await harness.orchestrator.bossmanControlForRun(codexRunId, {
      action: 'submit_review_verdict',
      gateId: 'g1',
      verdict: 'passed'
    })
    expect(result.ok).toBe(true)
    expect(harness.chat.ensemble?.bossmanControlState?.reviewGates?.[0]?.status).toBe('passed')
  })

  it("C2 P3 T6b: a NON-owner caller cannot pass another reviewer's gate", async () => {
    const { harness, codexRunId } = await startVerdictHarness([mkGate('g1', 'claude', 'required')])
    const result = await harness.orchestrator.bossmanControlForRun(codexRunId, {
      action: 'submit_review_verdict',
      gateId: 'g1',
      verdict: 'passed'
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('not_gate_reviewer')
    expect(harness.chat.ensemble?.bossmanControlState?.reviewGates?.[0]?.status).toBe('required')
  })

  it('C2 P3 T6c: an unknown/absent gateId is rejected and NON-upserting (never creates a gate)', async () => {
    const { harness, codexRunId } = await startVerdictHarness([mkGate('g1', 'codex', 'required')])
    const unknown = await harness.orchestrator.bossmanControlForRun(codexRunId, {
      action: 'submit_review_verdict',
      gateId: 'nope',
      verdict: 'passed'
    })
    expect(unknown.ok).toBe(false)
    expect(unknown.error).toBe('review_gate_not_found')
    const absent = await harness.orchestrator.bossmanControlForRun(codexRunId, {
      action: 'submit_review_verdict',
      verdict: 'passed'
    })
    expect(absent.error).toBe('review_gate_not_found')
    expect(harness.chat.ensemble?.bossmanControlState?.reviewGates).toHaveLength(1) // never created
  })

  it('C2 P3 T6d: field-lock — missing verdict + null-owner gate are rejected', async () => {
    const { harness, codexRunId } = await startVerdictHarness([
      mkGate('g1', 'codex', 'required'),
      mkGate('g2', '', 'required') // null/empty owner ⇒ reviewer-self path denied
    ])
    const missing = await harness.orchestrator.bossmanControlForRun(codexRunId, {
      action: 'submit_review_verdict',
      gateId: 'g1'
    })
    expect(missing.error).toBe('invalid_verdict')
    const nullOwner = await harness.orchestrator.bossmanControlForRun(codexRunId, {
      action: 'submit_review_verdict',
      gateId: 'g2',
      verdict: 'passed'
    })
    expect(nullOwner.error).toBe('not_gate_reviewer')
  })

  it('C2 P3 T6e: a repeat identical verdict is idempotent (no duplicate audit line)', async () => {
    const { harness, codexRunId } = await startVerdictHarness([mkGate('g1', 'codex', 'required')])
    await harness.orchestrator.bossmanControlForRun(codexRunId, {
      action: 'submit_review_verdict',
      gateId: 'g1',
      verdict: 'passed'
    })
    const auditLines = () =>
      harness.chat.messages.filter((m) =>
        (m.content || '').includes('submitted review verdict for gate g1')
      ).length
    expect(auditLines()).toBe(1)
    const repeat = await harness.orchestrator.bossmanControlForRun(codexRunId, {
      action: 'submit_review_verdict',
      gateId: 'g1',
      verdict: 'passed'
    })
    expect(repeat.ok).toBe(true)
    expect(auditLines()).toBe(1) // idempotent: no duplicate audit line
  })

  it('C2 P2: set_goal mints a fresh id for a materially-new objective, preserves it for the same', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Go.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runId = harness.dispatched[0].appRunId
    const roundId = harness.chat.ensemble?.activeRound?.roundId

    await harness.orchestrator.bossmanControlForRun(runId, {
      action: 'set_goal',
      roundId,
      goal: 'First objective'
    })
    const firstId = harness.chat.activeGoal?.id
    expect(firstId).toBeTruthy()

    // Re-set the SAME objective ⇒ identity preserved (idempotent re-set).
    await harness.orchestrator.bossmanControlForRun(runId, {
      action: 'set_goal',
      roundId,
      goal: 'First objective'
    })
    expect(harness.chat.activeGoal?.id).toBe(firstId)

    // A materially-different objective ⇒ FRESH identity (kills the goalId-reuse trap
    // that would make C2's goal-scoped gate filter a no-op).
    await harness.orchestrator.bossmanControlForRun(runId, {
      action: 'set_goal',
      roundId,
      goal: 'A completely different objective'
    })
    expect(harness.chat.activeGoal?.id).not.toBe(firstId)
  })

  it('records Boss control state and injects it into later participant prompts', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'set_round_plan',
      roundId: harness.chat.ensemble?.activeRound?.roundId,
      goal: 'Ship the control primitives',
      phase: 'implementation',
      participantIds: ['codex'],
      doneCriteria: 'Tests prove state and routing.'
    })
    await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'assign_work',
      roundId: harness.chat.ensemble?.activeRound?.roundId,
      targetParticipantId: 'codex',
      objective: 'Implement the worker-owned slice.',
      acceptanceCriteria: 'Focused tests pass.',
      due: 'this_round'
    })
    await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'declare_decision',
      roundId: harness.chat.ensemble?.activeRound?.roundId,
      decision: 'Use bounded Boss actions instead of generic state patching.',
      reopenCriteria: 'Only reopen if a test exposes missing authority checks.'
    })
    await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'set_review_gate',
      roundId: harness.chat.ensemble?.activeRound?.roundId,
      targetParticipantId: 'claude',
      scope: 'final implementation diff',
      acceptanceCriteria: 'No turn-allocation regression.'
    })
    await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'create_poll',
      roundId: harness.chat.ensemble?.activeRound?.roundId,
      question: 'Which implementation path should continue?',
      options: ['bounded actions', 'generic patch API'],
      participantIds: ['codex']
    })

    expect(harness.chat.ensemble?.bossmanControlState?.roundPlan?.goal).toBe(
      'Ship the control primitives'
    )
    expect(harness.chat.ensemble?.bossmanControlState?.assignments?.[0]).toMatchObject({
      participantId: 'codex',
      objective: 'Implement the worker-owned slice.'
    })
    expect(harness.chat.ensemble?.bossmanControlState?.decisions?.[0]?.decision).toContain(
      'bounded Boss actions'
    )
    expect(harness.chat.ensemble?.bossmanControlState?.reviewGates?.[0]).toMatchObject({
      reviewerParticipantId: 'claude',
      scope: 'final implementation diff'
    })
    expect(harness.chat.ensemble?.bossmanControlState?.polls?.[0]?.question).toContain(
      'Which implementation path'
    )

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].prompt).toContain('Boss/Captain control state:')
    expect(harness.dispatched[1].prompt).toContain('Plan: Ship the control primitives')
    expect(harness.dispatched[1].prompt).toContain('Assignments:')
    expect(harness.dispatched[1].prompt).toContain('Implement the worker-owned slice.')
    expect(harness.dispatched[1].prompt).toContain('Decisions:')
    expect(harness.dispatched[1].prompt).toContain('Open polls:')
  })

  it('lets Boss replace and reopen a completed TaskWraith goal', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.activeGoal = {
      ...buildActiveGoal('goal-old'),
      status: 'completed',
      completedAt: '2026-05-24T01:00:00.000Z',
      completedSummary: 'Earlier run finished.'
    }
    const harness = makeHarness({ initialChat, nowIso: () => '2026-05-24T02:00:00.000Z' })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'set_goal',
      roundId: harness.chat.ensemble?.activeRound?.roundId,
      goal: 'Ship the next corrected slice',
      reason: 'Previous goal was closed too early.'
    })

    expect(result.ok).toBe(true)
    // C2 P2 — set_goal after a COMPLETED prior goal mints a FRESH identity: a new
    // objective is a new goal, NOT a reuse of the completed goal's id. This is the
    // ratified Adversary2/3 reuse-trap fix (reuse would make the goalId gate filter
    // a no-op). Reopening the SAME goal is update_goal's job, which preserves id.
    expect(result.goal?.id).not.toBe('goal-old')
    expect(result.goal).toMatchObject({
      objective: 'Ship the next corrected slice',
      status: 'active',
      mode: 'taskwraith_steered',
      provider: 'claude'
    })
    expect(harness.chat.activeGoal?.completedAt).toBeUndefined()
    expect(harness.chat.activeGoal?.completedSummary).toBeUndefined()
  })

  it('lets Captain reopen a blocked goal when Boss is unavailable', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.participants = [
      { ...initialChat.ensemble!.participants[0], enabled: false },
      initialChat.ensemble!.participants[1]
    ]
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.secondInCommandParticipantId = 'codex'
    initialChat.activeGoal = {
      ...buildActiveGoal('goal-blocked'),
      status: 'blocked',
      blockedAt: '2026-05-24T01:00:00.000Z',
      blockedReason: 'Waiting for local credentials.'
    }
    const harness = makeHarness({ initialChat, nowIso: () => '2026-05-24T02:00:00.000Z' })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Continue.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('codex')

    const result = await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'update_goal',
      roundId: harness.chat.ensemble?.activeRound?.roundId,
      goalStatus: 'active',
      reason: 'Credentials are now visible to the release shell.'
    })

    expect(result.ok).toBe(true)
    expect(result.goal).toMatchObject({
      id: 'goal-blocked',
      status: 'active'
    })
    expect(harness.chat.activeGoal?.blockedAt).toBeUndefined()
    expect(harness.chat.activeGoal?.blockedReason).toBeUndefined()
    expect(harness.chat.activeGoal?.lastStatusReason).toBe(
      'Credentials are now visible to the release shell.'
    )
  })

  it('lets Boss quarantine a pending participant so routing skips them', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'quarantine_participant',
      roundId: harness.chat.ensemble?.activeRound?.roundId,
      targetParticipantId: 'codex',
      category: 'looping',
      reason: 'Worker is repeating the same handoff.'
    })

    expect(result.ok).toBe(true)
    expect(harness.chat.ensemble?.bossmanControlState?.quarantines?.[0]).toMatchObject({
      participantId: 'codex',
      active: true,
      scope: 'round'
    })
    const codexState = harness.chat.ensemble?.activeRound?.participants.find(
      (participant) => participant.participantId === 'codex'
    )
    expect(codexState?.status).toBe('skipped')

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    expect(harness.dispatched).toHaveLength(1)
  })

  it('lets Boss adjust the active and default continuation hop budget', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.orchestrationMode = 'continuous'
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.maxContinuationHops = 2
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const runtime = (
      harness.orchestrator as unknown as {
        roundsByChatId: Map<
          string,
          { continuationLimitNotified?: boolean; continuationLimitPending?: boolean }
        >
      }
    ).roundsByChatId.get('ensemble-chat')!
    runtime.continuationLimitNotified = true
    runtime.continuationLimitPending = true

    const result = await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'adjust_hops',
      roundId: harness.chat.ensemble?.activeRound?.roundId,
      hopDelta: 3,
      reason: 'Longer horizon task.'
    })

    expect(result.ok).toBe(true)
    expect(harness.chat.ensemble?.maxContinuationHops).toBe(5)
    expect(harness.chat.ensemble?.activeRound?.maxContinuationHops).toBe(5)
    expect(runtime.continuationLimitNotified).toBe(false)
    expect(runtime.continuationLimitPending).toBe(false)
    expect(harness.chat.messages.at(-1)).toMatchObject({
      role: 'system',
      content: 'Boss changed max handoff turns from 2 to 5. Reason: Longer horizon task.',
      metadata: {
        kind: 'ensembleContinuationHopsChange',
        ensembleRoundId: harness.chat.ensemble?.activeRound?.roundId,
        continuationHopsChange: {
          before: 2,
          after: 5,
          actor: 'boss',
          actorParticipantId: 'claude',
          actorRole: 'Reviewer',
          reason: 'Longer horizon task.'
        }
      }
    })
  })

  it('attributes a continuation hop decrease to the acting Captain', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.participants[0].enabled = false
    initialChat.ensemble!.orchestrationMode = 'continuous'
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.secondInCommandParticipantId = 'codex'
    initialChat.ensemble!.maxContinuationHops = 8
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Finish the release.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('codex')

    const result = await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'adjust_hops',
      roundId: harness.chat.ensemble?.activeRound?.roundId,
      hopDelta: -3
    })

    expect(result.ok).toBe(true)
    expect(harness.chat.ensemble?.maxContinuationHops).toBe(5)
    expect(harness.chat.messages.at(-1)?.metadata?.continuationHopsChange).toMatchObject({
      before: 8,
      after: 5,
      actor: 'captain',
      actorParticipantId: 'codex',
      actorRole: 'Worker'
    })
  })

  it('returns quota bands and reset windows from Boss quota checks', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    const harness = makeHarness({
      initialChat,
      getProviderUsageSnapshot: (provider) =>
        provider === 'codex'
          ? {
              provider: 'codex',
              configured: true,
              source: 'codex-account',
              fetchedAt: '2026-05-24T00:00:00.000Z',
              windows: [
                {
                  id: 'weekly',
                  label: 'Weekly',
                  usedPercent: 94,
                  resetAt: '2026-05-31T00:00:00.000Z'
                }
              ]
            }
          : null
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const codex = await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'check_quota_resets',
      roundId: harness.chat.ensemble?.activeRound?.roundId,
      provider: 'codex'
    })
    const all = await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'check_quota_resets',
      roundId: harness.chat.ensemble?.activeRound?.roundId
    })

    expect(codex.ok).toBe(true)
    expect(codex.usage).toMatchObject({
      provider: 'codex',
      configured: true,
      worstBand: 'critical',
      windows: [
        {
          id: 'weekly',
          label: 'Weekly',
          usedPercent: 94,
          resetAt: '2026-05-31T00:00:00.000Z'
        }
      ]
    })
    expect(codex.message).toContain('resets Weekly: 2026-05-31T00:00:00.000Z')
    expect(all.providers?.codex?.worstBand).toBe('critical')
  })

  it('blocks Boss goal completion while review gates are still required', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.activeGoal = buildActiveGoal('goal-final')
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'set_review_gate',
      roundId: harness.chat.ensemble?.activeRound?.roundId,
      gateId: 'gate-final-review',
      targetParticipantId: 'codex',
      scope: 'final diff',
      acceptanceCriteria: 'Reviewer must approve before completion.'
    })
    const blocked = await harness.orchestrator.bossmanControlForRun(
      harness.dispatched[0].appRunId,
      {
        action: 'update_goal',
        roundId: harness.chat.ensemble?.activeRound?.roundId,
        goalStatus: 'completed',
        reason: 'Looks done.'
      }
    )

    expect(blocked.ok).toBe(false)
    expect(blocked.error).toBe('review_gate_blocked')
    expect(harness.chat.activeGoal?.status).toBe('active')
  })

  it('enforces Boss extra-turn budgets on directed participant summons', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.orchestrationMode = 'continuous'
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.activeGoal = { ...buildActiveGoal('goal-x'), status: 'completed' }
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'allocate_budget',
      roundId: harness.chat.ensemble?.activeRound?.roundId,
      targetParticipantId: 'codex',
      maxExtraTurns: 0,
      reason: 'Worker should not receive extra turns.'
    })
    harness.orchestrator.markYielded(
      harness.dispatched[0].appRunId!,
      'Worker should take this.',
      'Worker'
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'Initial worker answer.' }
    )
    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))

    const result = await harness.orchestrator.bossmanControlForRun(harness.dispatched[2].appRunId, {
      action: 'summon_participant',
      roundId: harness.chat.ensemble?.activeRound?.roundId,
      targetParticipantId: 'codex',
      reason: 'Need one more pass.'
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('budget_exhausted')
    expect(harness.dispatched).toHaveLength(3)
  })

  it('counts completed run usage against Boss budgets before later summons', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.orchestrationMode = 'continuous'
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.activeGoal = { ...buildActiveGoal('goal-x'), status: 'completed' }
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'allocate_budget',
      roundId: harness.chat.ensemble?.activeRound?.roundId,
      targetParticipantId: 'codex',
      maxDurationSeconds: 90,
      maxTokens: 100,
      reason: 'Worker gets one small pass.'
    })
    harness.orchestrator.markYielded(
      harness.dispatched[0].appRunId!,
      'Worker should take this.',
      'Worker'
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'Initial worker answer.' }
    )
    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { duration_ms: 91_000, total_tokens: 120 } }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))

    expect(harness.chat.ensemble?.bossmanControlState?.budgets?.[0]).toMatchObject({
      participantId: 'codex',
      maxDurationSeconds: 90,
      maxTokens: 100,
      durationSecondsUsed: 91,
      tokensUsed: 120
    })

    const result = await harness.orchestrator.bossmanControlForRun(harness.dispatched[2].appRunId, {
      action: 'summon_participant',
      roundId: harness.chat.ensemble?.activeRound?.roundId,
      targetParticipantId: 'codex',
      reason: 'Need another pass.'
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('budget_exhausted')
    expect(harness.dispatched).toHaveLength(3)
  })

  it('routes Boss-created polls to targeted voters before the natural order', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.participants = [
      initialChat.ensemble!.participants[0],
      initialChat.ensemble!.participants[1],
      {
        id: 'kimi',
        provider: 'kimi',
        enabled: true,
        role: 'TieBreaker',
        instructions: 'Vote when asked.',
        order: 3,
        permissionPresetId: 'read_only'
      }
    ]
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'create_poll',
      roundId: harness.chat.ensemble?.activeRound?.roundId,
      pollId: 'poll-route',
      question: 'Which path?',
      options: ['A', 'B'],
      participantIds: ['kimi']
    })
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].ensembleRun?.participantId).toBe('kimi')
  })

  it('closes targeted Boss status requests after the target responds', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'request_status',
      roundId: harness.chat.ensemble?.activeRound?.roundId,
      targetParticipantId: 'codex',
      question: 'Are you blocked?'
    })
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.chat.ensemble?.bossmanControlState?.statusRequests?.[0]?.status).toBe('open')

    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'Not blocked.' }
    )
    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )

    await vi.waitFor(() =>
      expect(harness.chat.ensemble?.bossmanControlState?.statusRequests?.[0]?.status).toBe('closed')
    )
  })

  it("closes a targeted Boss status request only after the target's owned lane returns", async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.fanoutPolicy = 'read_only'
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.participants = [
      initialChat.ensemble!.participants[0],
      initialChat.ensemble!.participants[1],
      {
        id: 'kimi',
        provider: 'kimi',
        enabled: true,
        role: 'LaneReviewer',
        instructions: 'Return a read-only review.',
        order: 3,
        stageRole: 'reviewer',
        permissionPresetId: 'read_only'
      }
    ]
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Request status, then let the target fan out.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'request_status',
      roundId: harness.chat.ensemble?.activeRound?.roundId,
      targetParticipantId: 'codex',
      question: 'Are you ready to report?'
    })
    completeDispatchedRun(harness, 0)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

    const ownerRunId = harness.dispatched[1].appRunId!
    const fanout = await harness.orchestrator.fanoutForRun(ownerRunId, {
      targets: ['LaneReviewer'],
      prompt: 'Verify my status before it closes.'
    })
    expect(fanout.ok).toBe(true)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))

    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: ownerRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'Ready after the reviewer returns.' }
    )
    completeDispatchedRun(harness, 1)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(harness.chat.ensemble?.bossmanControlState?.statusRequests?.[0]?.status).toBe('open')
    expect(
      harness.chat.ensemble?.activeRound?.participants.find(
        (participant) => participant.participantId === 'codex'
      )?.status
    ).toBe('running')
    expect(harness.transitionRunQueueJob).not.toHaveBeenCalledWith(
      ownerRunId,
      'completed',
      expect.anything()
    )

    completeDispatchedRun(harness, 2)
    await vi.waitFor(() =>
      expect(harness.chat.ensemble?.bossmanControlState?.statusRequests?.[0]?.status).toBe('closed')
    )
    expect(harness.transitionRunQueueJob).toHaveBeenCalledWith(ownerRunId, 'completed', {})
  })

  it('enforces Boss fan-out call budgets before dispatching lanes', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.fanoutPolicy = 'read_only'
    initialChat.ensemble!.bossmanParticipantId = 'codex'
    initialChat.ensemble!.participants = [
      {
        id: 'codex',
        provider: 'codex',
        enabled: true,
        role: 'LeadBoss',
        instructions: 'Coordinate.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'claude',
        provider: 'claude',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review.',
        order: 2,
        permissionPresetId: 'read_only'
      }
    ]
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'allocate_budget',
      roundId: harness.chat.ensemble?.activeRound?.roundId,
      targetParticipantId: 'claude',
      maxFanoutCalls: 0,
      reason: 'No fan-out calls for this reviewer.'
    })

    const result = await harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
      targets: ['Reviewer'],
      prompt: 'Inspect in parallel.'
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('budget_exhausted')
    expect(harness.dispatched).toHaveLength(1)
  })

  it('requires an explicit minimum delay for Boss scheduled ensemble wakeups', async () => {
    const scheduled: EnsembleWakeupRecord[] = []
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    const harness = makeHarness({
      initialChat,
      scheduleWakeupTimer: (wakeup) => scheduled.push(wakeup)
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const missingDelay = await harness.orchestrator.bossmanControlForRun(
      harness.dispatched[0].appRunId,
      {
        action: 'ensemble_scheduled_wakeup',
        roundId: harness.chat.ensemble?.activeRound?.roundId,
        reason: 'Wait for an external build.'
      }
    )
    const shortDelay = await harness.orchestrator.bossmanControlForRun(
      harness.dispatched[0].appRunId,
      {
        action: 'ensemble_scheduled_wakeup',
        roundId: harness.chat.ensemble?.activeRound?.roundId,
        delaySeconds: 59,
        reason: 'Wait for an external build.'
      }
    )

    expect(missingDelay.ok).toBe(false)
    expect(missingDelay.error).toBe('missing_required_field')
    expect(shortDelay.ok).toBe(false)
    expect(shortDelay.error).toBe('missing_required_field')
    expect(scheduled).toHaveLength(0)
    expect(harness.chat.ensemble?.wakeups).toBeUndefined()
  })

  it('records participant responses to Boss-created polls', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const poll = await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'create_poll',
      roundId: harness.chat.ensemble?.activeRound?.roundId,
      pollId: 'poll-build-path',
      question: 'Which path?',
      options: ['A', 'B'],
      participantIds: ['codex']
    })
    expect(poll.ok).toBe(true)

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

    const vote = harness.orchestrator.pollResponseForRun(harness.dispatched[1].appRunId, {
      pollId: 'poll-build-path',
      choice: 'A',
      rationale: 'Lower risk.'
    })

    expect(vote.ok).toBe(true)
    expect(harness.chat.ensemble?.bossmanControlState?.polls?.[0]?.votes).toEqual([
      expect.objectContaining({
        voterParticipantId: 'codex',
        choice: 'A',
        rationale: 'Lower risk.'
      })
    ])
  })

  it('persists a poll marker and records optional user poll votes', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const poll = await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'create_poll',
      roundId: harness.chat.ensemble?.activeRound?.roundId,
      pollId: 'poll-user-path',
      question: 'Which path should we take?',
      options: ['A', 'B'],
      participantIds: ['codex'],
      includeUser: true
    })
    const vote = harness.orchestrator.userPollResponseForChat('ensemble-chat', {
      pollId: 'poll-user-path',
      choice: 'B'
    })

    expect(poll.ok).toBe(true)
    expect(
      harness.chat.messages.some(
        (message) =>
          message.metadata?.kind === 'ensembleBossmanPoll' &&
          message.metadata.pollId === 'poll-user-path'
      )
    ).toBe(true)
    expect(vote.ok).toBe(true)
    expect(harness.chat.ensemble?.bossmanControlState?.polls?.[0]?.votes).toEqual([
      expect.objectContaining({
        voterLabel: 'User',
        choice: 'B'
      })
    ])
  })

  it('expires Boss-created polls on their scheduled timeout', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    vi.useFakeTimers()
    try {
      const poll = await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
        action: 'create_poll',
        roundId: harness.chat.ensemble?.activeRound?.roundId,
        pollId: 'poll-timeout',
        question: 'Which path should we take?',
        options: ['A', 'B'],
        timeoutSeconds: 30
      })

      expect(poll.ok).toBe(true)
      expect(harness.chat.ensemble?.bossmanControlState?.polls?.[0]?.status).toBe('open')

      await vi.advanceTimersByTimeAsync(29_999)
      expect(harness.chat.ensemble?.bossmanControlState?.polls?.[0]?.status).toBe('open')

      await vi.advanceTimersByTimeAsync(1)
      expect(harness.chat.ensemble?.bossmanControlState?.polls?.[0]?.status).toBe('expired')
      expect(harness.chat.messages.map((message) => message.content)).toContain(
        'Poll poll-timeout expired after reaching its timeout.'
      )
    } finally {
      vi.useRealTimers()
    }
  })

  // ---- 1.0.4-AN — binding goal-complete polls (O3) -----------------------
  const startBindingHarness = async (withGoal: boolean) => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    const harness = makeHarness({ initialChat })
    if (withGoal) harness.chat.activeGoal = buildActiveGoal('goal-x')
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Coordinate.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    return { harness, roundId: harness.chat.ensemble?.activeRound?.roundId }
  }

  it('rejects a binding goal-complete poll when there is no active goal', async () => {
    const { harness, roundId } = await startBindingHarness(false)
    const result = await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'create_poll',
      roundId,
      binding: { kind: 'goal_complete' }
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('no_active_goal')
  })

  it('mints a binding poll with fixed options, forced user vote, and eligibility snapshot', async () => {
    const { harness, roundId } = await startBindingHarness(true)
    const result = await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'create_poll',
      roundId,
      pollId: 'binding-1',
      binding: { kind: 'goal_complete' },
      options: ['yes', 'no'] // custom options are ignored for binding polls
    })
    expect(result.ok).toBe(true)
    const poll = harness.chat.ensemble?.bossmanControlState?.polls?.[0]
    expect(poll?.binding).toEqual({ kind: 'goal_complete', goalId: 'goal-x' })
    expect(poll?.options).toEqual(['complete', 'keep-working'])
    expect(poll?.includeUser).toBe(true)
    expect(poll?.roundId).toBe(roundId)
    expect(poll?.eligibleAtOpen).toBe(2)
    expect(poll?.authorityVoterIds).toContain('claude')
    expect(poll?.targetParticipantIds).toEqual(expect.arrayContaining(['claude', 'codex']))
  })

  it('allows only one open binding poll at a time', async () => {
    const { harness, roundId } = await startBindingHarness(true)
    const first = await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'create_poll',
      roundId,
      binding: { kind: 'goal_complete' }
    })
    expect(first.ok).toBe(true)
    const second = await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'create_poll',
      roundId,
      binding: { kind: 'goal_complete' }
    })
    expect(second.ok).toBe(false)
    expect(second.error).toBe('binding_poll_unavailable')
  })

  it('vetoes a binding poll immediately when an authority votes keep-working', async () => {
    const { harness, roundId } = await startBindingHarness(true)
    await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'create_poll',
      roundId,
      pollId: 'binding-veto',
      binding: { kind: 'goal_complete' }
    })
    // claude is Boss (authority) → a 'keep-working' vote is an immediate veto.
    const veto = harness.orchestrator.pollResponseForRun(harness.dispatched[0].appRunId, {
      pollId: 'binding-veto',
      choice: 'keep-working'
    })
    expect(veto.ok).toBe(true)
    const poll = harness.chat.ensemble?.bossmanControlState?.polls?.[0]
    expect(poll?.status).toBe('closed')
    expect(poll?.bindingResolution).toBe('vetoed')
    expect(harness.chat.activeGoal?.status).toBe('active')
    expect(harness.chat.ensemble?.bossmanControlState?.bindingPollCooldownUntil).toBeTruthy()
    // Cooldown blocks an immediate re-open.
    const reopen = await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'create_poll',
      roundId,
      binding: { kind: 'goal_complete' }
    })
    expect(reopen.ok).toBe(false)
    expect(reopen.error).toBe('binding_poll_unavailable')
  })

  it('completes the active goal when a binding poll passes quorum + floor', async () => {
    const { harness, roundId } = await startBindingHarness(true)
    await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'create_poll',
      roundId,
      pollId: 'binding-pass',
      binding: { kind: 'goal_complete' }
    })
    // Boss (claude) votes 'complete' on its own run — not yet terminal.
    const v1 = harness.orchestrator.pollResponseForRun(harness.dispatched[0].appRunId, {
      pollId: 'binding-pass',
      choice: 'complete'
    })
    expect(v1.ok).toBe(true)
    expect(harness.chat.activeGoal?.status).toBe('active')
    // Boss finishes → codex is dispatched and casts the final target vote.
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    const v2 = harness.orchestrator.pollResponseForRun(harness.dispatched[1].appRunId, {
      pollId: 'binding-pass',
      choice: 'complete'
    })
    expect(v2.ok).toBe(true)
    const poll = harness.chat.ensemble?.bossmanControlState?.polls?.[0]
    expect(poll?.status).toBe('closed')
    expect(poll?.bindingResolution).toBe('passed')
    expect(harness.chat.activeGoal?.status).toBe('completed')
  })

  it('fails a binding poll below the participation floor on timeout (goal stays active)', async () => {
    const { harness, roundId } = await startBindingHarness(true)
    vi.useFakeTimers()
    try {
      const poll = await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
        action: 'create_poll',
        roundId,
        pollId: 'binding-timeout',
        binding: { kind: 'goal_complete' },
        timeoutSeconds: 30
      })
      expect(poll.ok).toBe(true)
      await vi.advanceTimersByTimeAsync(30_000)
      const resolved = harness.chat.ensemble?.bossmanControlState?.polls?.[0]
      expect(resolved?.status).toBe('closed')
      expect(resolved?.bindingResolution).toBe('failed_floor')
      expect(harness.chat.activeGoal?.status).toBe('active')
    } finally {
      vi.useRealTimers()
    }
  })

  it('no-ops a binding poll whose active goal was swapped out (stale)', async () => {
    const { harness, roundId } = await startBindingHarness(true)
    vi.useFakeTimers()
    try {
      const poll = await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
        action: 'create_poll',
        roundId,
        pollId: 'binding-stale',
        binding: { kind: 'goal_complete' },
        timeoutSeconds: 30
      })
      expect(poll.ok).toBe(true)
      // The user moves on to a different goal while the poll is open.
      harness.chat.activeGoal = buildActiveGoal('goal-different')
      await vi.advanceTimersByTimeAsync(30_000)
      const resolved = harness.chat.ensemble?.bossmanControlState?.polls?.[0]
      expect(resolved?.bindingResolution).toBe('stale')
      expect(harness.chat.activeGoal?.id).toBe('goal-different')
      expect(harness.chat.activeGoal?.status).toBe('active')
    } finally {
      vi.useRealTimers()
    }
  })

  it('records a user vote without letting it drive or block binding resolution', async () => {
    const { harness, roundId } = await startBindingHarness(true)
    await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'create_poll',
      roundId,
      pollId: 'binding-user',
      binding: { kind: 'goal_complete' }
    })
    const userVote = harness.orchestrator.userPollResponseForChat('ensemble-chat', {
      pollId: 'binding-user',
      choice: 'complete'
    })
    expect(userVote.ok).toBe(true)
    const poll = harness.chat.ensemble?.bossmanControlState?.polls?.[0]
    // A user vote alone NEVER terminalizes the poll (participant-driven only)…
    expect(poll?.status).toBe('open')
    // …but it is recorded so it counts in the denominator at resolution.
    expect(
      poll?.votes.some((vote) => vote.voterLabel === 'User' && vote.choice === 'complete')
    ).toBe(true)
    expect(harness.chat.activeGoal?.status).toBe('active')
  })

  it('lets an eligible participant open a binding poll via proposeGoalCompleteForRun (M3)', async () => {
    const { harness } = await startBindingHarness(true)
    const result = harness.orchestrator.proposeGoalCompleteForRun(harness.dispatched[0].appRunId, {
      rationale: 'Work is done.'
    })
    expect(result.ok).toBe(true)
    expect(result.tool).toBe('ensemble_propose_goal_complete') // C0-A: correct tool identity
    const poll = harness.chat.ensemble?.bossmanControlState?.polls?.[0]
    expect(poll?.binding).toEqual({ kind: 'goal_complete', goalId: 'goal-x' })
    expect(poll?.options).toEqual(['complete', 'keep-working'])
    // The opener is an eligible-at-open voter (included in the target set).
    expect(poll?.targetParticipantIds).toContain('claude')
    // The optional rationale rides a visible round-status line.
    expect(
      harness.chat.messages.some((m) =>
        (m.content || '').includes('proposed goal completion: Work is done.')
      )
    ).toBe(true)
  })

  it('rejects proposeGoalCompleteForRun when there is no active goal (M3)', async () => {
    const { harness } = await startBindingHarness(false)
    const result = harness.orchestrator.proposeGoalCompleteForRun(
      harness.dispatched[0].appRunId,
      {}
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('no_active_goal')
    expect(result.tool).toBe('ensemble_propose_goal_complete') // C0-A
  })

  it('tags every proposeGoalCompleteForRun path as ensemble_propose_goal_complete (C0-A)', async () => {
    const { harness } = await startBindingHarness(true)
    // success path
    const ok = harness.orchestrator.proposeGoalCompleteForRun(harness.dispatched[0].appRunId, {})
    expect(ok.ok).toBe(true)
    expect(ok.tool).toBe('ensemble_propose_goal_complete')
    // error path: no run id ⇒ no_active_run
    const noRun = harness.orchestrator.proposeGoalCompleteForRun(undefined, {})
    expect(noRun.ok).toBe(false)
    expect(noRun.error).toBe('no_active_run')
    expect(noRun.tool).toBe('ensemble_propose_goal_complete')
    // error path: a second open while one is already open ⇒ binding_poll_unavailable
    const blocked = harness.orchestrator.proposeGoalCompleteForRun(
      harness.dispatched[0].appRunId,
      {}
    )
    expect(blocked.ok).toBe(false)
    expect(blocked.error).toBe('binding_poll_unavailable')
    expect(blocked.tool).toBe('ensemble_propose_goal_complete')
  })

  // ---- O3 slice-3 — resolver closure tests (items 1/3/4) ------------------
  const openBinding = async (
    harness: Awaited<ReturnType<typeof startBindingHarness>>['harness'],
    pollId: string
  ) => {
    await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'create_poll',
      roundId: harness.chat.ensemble?.activeRound?.roundId,
      pollId,
      binding: { kind: 'goal_complete' }
    })
    return harness.chat.ensemble?.bossmanControlState?.polls?.find((p) => p.id === pollId)
  }
  const findPoll = (
    harness: Awaited<ReturnType<typeof startBindingHarness>>['harness'],
    pollId: string
  ) => harness.chat.ensemble?.bossmanControlState?.polls?.find((p) => p.id === pollId)
  // Direct resolver call (private) — confirmatory tally-logic coverage; the vote
  // and timeout INVOCATION paths are covered by the A4-1 / slice-1 / slice-2 tests.
  const resolveDirect = (
    harness: Awaited<ReturnType<typeof startBindingHarness>>['harness'],
    pollId: string
  ) =>
    (
      harness.orchestrator as unknown as {
        resolveBindingPoll: (chatId: string, pollId: string, trigger: 'vote' | 'timeout') => void
      }
    ).resolveBindingPoll('ensemble-chat', pollId, 'timeout')
  const pvote = (id: string, choice: string) => ({
    voterParticipantId: id,
    voterLabel: id,
    choice,
    votedAt: '2026-05-24T00:00:00.000Z'
  })
  const uvote = (choice: string) => ({
    voterLabel: 'User',
    choice,
    votedAt: '2026-05-24T00:00:00.000Z'
  })

  it('A4-1: a late vote past a binding timeout routes to the resolver (not plain expired)', async () => {
    const { harness } = await startBindingHarness(true)
    await openBinding(harness, 'binding-late')
    // Force the deadline into the past WITHOUT firing the scheduled timer. The
    // harness clock is a small integer counter, so epoch 0 (getTime 0) is ≤ now().
    const poll = findPoll(harness, 'binding-late')!
    ;(poll as { timeoutAt?: string }).timeoutAt = '1970-01-01T00:00:00.000Z'
    const late = harness.orchestrator.pollResponseForRun(harness.dispatched[0].appRunId, {
      pollId: 'binding-late',
      choice: 'complete'
    })
    expect(late.ok).toBe(false) // late vote rejected…
    // …but the binding poll terminalized via the resolver, not a plain 'expired' mark.
    const resolved = findPoll(harness, 'binding-late')!
    expect(resolved.status).toBe('closed')
    expect(resolved.bindingResolution).toBe('failed_floor') // 0 votes cast < floor 2
    expect(harness.chat.activeGoal?.status).toBe('active')
  })

  it('blocks a binding PASS when a required review gate is active (gate preserved)', async () => {
    const { harness } = await startBindingHarness(true)
    await openBinding(harness, 'binding-gate')
    ;(harness.chat.ensemble!.bossmanControlState as { reviewGates?: unknown[] }).reviewGates = [
      { id: 'gate-x', scope: 'all', status: 'required', createdAt: '2026-05-24T00:00:00.000Z' }
    ]
    ;(findPoll(harness, 'binding-gate') as { votes: unknown[] }).votes = [
      pvote('claude', 'complete'),
      pvote('codex', 'complete')
    ]
    resolveDirect(harness, 'binding-gate')
    expect(findPoll(harness, 'binding-gate')?.bindingResolution).toBe('gate_blocked')
    expect(harness.chat.activeGoal?.status).toBe('active')
  })

  it('no-ops a binding poll from a stale round (roundId mismatch)', async () => {
    const { harness } = await startBindingHarness(true)
    await openBinding(harness, 'binding-stale-round')
    const poll = findPoll(harness, 'binding-stale-round')!
    ;(poll as { roundId?: string }).roundId = 'a-prior-round'
    ;(poll as { votes: unknown[] }).votes = [
      pvote('claude', 'complete'),
      pvote('codex', 'complete')
    ]
    resolveDirect(harness, 'binding-stale-round')
    expect(findPoll(harness, 'binding-stale-round')?.bindingResolution).toBe('stale')
    expect(harness.chat.activeGoal?.status).toBe('active')
  })

  it('confirmatory: resolveBindingPoll is a no-op on an already-resolved poll', async () => {
    const { harness } = await startBindingHarness(true)
    await openBinding(harness, 'binding-double')
    ;(findPoll(harness, 'binding-double') as { votes: unknown[] }).votes = [
      pvote('claude', 'keep-working') // authority (Boss) veto
    ]
    resolveDirect(harness, 'binding-double')
    expect(findPoll(harness, 'binding-double')?.bindingResolution).toBe('vetoed')
    expect(findPoll(harness, 'binding-double')?.status).toBe('closed')
    // C0-B: a second resolution attempt must be a no-op — assert NOT ONLY that the
    // final value is unchanged but that NO duplicate audit/status line is emitted
    // (a silently-removed guard would recompute the same value AND re-emit the line,
    // which the value-only assertion cannot distinguish).
    const statusLinesBefore = harness.chat.messages.filter((m) =>
      (m.content || '').includes('Binding goal-complete poll binding-double')
    ).length
    expect(statusLinesBefore).toBe(1) // the first resolution emitted exactly one audit line
    resolveDirect(harness, 'binding-double')
    const statusLinesAfter = harness.chat.messages.filter((m) =>
      (m.content || '').includes('Binding goal-complete poll binding-double')
    ).length
    expect(statusLinesAfter).toBe(statusLinesBefore) // no duplicate audit line on re-resolve
    expect(findPoll(harness, 'binding-double')?.bindingResolution).toBe('vetoed')
    expect(harness.chat.activeGoal?.status).toBe('active')
  })

  it('passes the 2/3 quorum edge (2-of-3 complete + 1 keep-working)', async () => {
    const { harness } = await startBindingHarness(true)
    await openBinding(harness, 'binding-edge-pass')
    const poll = findPoll(harness, 'binding-edge-pass')!
    ;(poll as { eligibleAtOpen?: number }).eligibleAtOpen = 3 // ⇒ floor 2
    ;(poll as { votes: unknown[] }).votes = [
      pvote('claude', 'complete'),
      pvote('codex', 'complete'),
      pvote('ghost', 'keep-working')
    ]
    resolveDirect(harness, 'binding-edge-pass')
    expect(findPoll(harness, 'binding-edge-pass')?.bindingResolution).toBe('passed')
    expect(harness.chat.activeGoal?.status).toBe('completed')
  })

  it('fails the 2/3 quorum edge (1-of-3 complete)', async () => {
    const { harness } = await startBindingHarness(true)
    await openBinding(harness, 'binding-edge-fail')
    const poll = findPoll(harness, 'binding-edge-fail')!
    ;(poll as { eligibleAtOpen?: number }).eligibleAtOpen = 3
    ;(poll as { votes: unknown[] }).votes = [
      pvote('claude', 'complete'),
      pvote('codex', 'keep-working'),
      pvote('ghost', 'keep-working')
    ]
    resolveDirect(harness, 'binding-edge-fail')
    expect(findPoll(harness, 'binding-edge-fail')?.bindingResolution).toBe('failed_quorum')
    expect(harness.chat.activeGoal?.status).toBe('active')
  })

  it('lets the Captain (secondInCommandParticipantId) veto a binding poll', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.secondInCommandParticipantId = 'codex' // Captain
    const harness = makeHarness({ initialChat })
    harness.chat.activeGoal = buildActiveGoal('goal-x')
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Coordinate.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    await openBinding(harness, 'binding-cap-veto')
    const poll = findPoll(harness, 'binding-cap-veto')!
    expect(poll.authorityVoterIds).toContain('codex') // Captain captured as authority
    ;(poll as { votes: unknown[] }).votes = [
      pvote('claude', 'complete'),
      pvote('codex', 'keep-working')
    ]
    resolveDirect(harness, 'binding-cap-veto')
    expect(findPoll(harness, 'binding-cap-veto')?.bindingResolution).toBe('vetoed')
    expect(harness.chat.activeGoal?.status).toBe('active')
  })

  it('counts the user vote in the denominator (user vote flips fail→pass)', async () => {
    const { harness } = await startBindingHarness(true)
    await openBinding(harness, 'binding-user-count')
    const poll = findPoll(harness, 'binding-user-count')!
    ;(poll as { eligibleAtOpen?: number }).eligibleAtOpen = 3 // floor 2
    // 2 participant votes clear the floor (1 complete + 1 keep-working); WITHOUT the
    // user this is 1/2 complete = FAIL. The user's 'complete' makes it 2/3 = PASS.
    ;(poll as { votes: unknown[] }).votes = [
      pvote('claude', 'complete'),
      pvote('codex', 'keep-working'),
      uvote('complete')
    ]
    resolveDirect(harness, 'binding-user-count')
    expect(findPoll(harness, 'binding-user-count')?.bindingResolution).toBe('passed')
    expect(harness.chat.activeGoal?.status).toBe('completed')
  })

  it('records authority-votes-cast in the resolution audit line (item 4)', async () => {
    const { harness } = await startBindingHarness(true)
    await openBinding(harness, 'binding-audit')
    ;(findPoll(harness, 'binding-audit') as { votes: unknown[] }).votes = [
      pvote('claude', 'complete'),
      pvote('codex', 'complete')
    ]
    resolveDirect(harness, 'binding-audit')
    // claude is the authority (Boss) and voted ⇒ "Authority votes: 1/1".
    expect(
      harness.chat.messages.some((m) => (m.content || '').includes('Authority votes: 1/1'))
    ).toBe(true)
  })

  it('flags authority-unreachable-at-resolution when authority is health-probed out (item 4)', async () => {
    const { harness } = await startBindingHarness(true)
    await openBinding(harness, 'binding-unreach')
    // Simulate the Boss going unreachable (quota wall) for the whole window.
    const runtime = (
      harness.orchestrator as unknown as {
        roundsByChatId: Map<string, { unreachableParticipantIds?: Set<string> }>
      }
    ).roundsByChatId.get('ensemble-chat')!
    runtime.unreachableParticipantIds = new Set(['claude'])
    const poll = findPoll(harness, 'binding-unreach')!
    ;(poll as { eligibleAtOpen?: number }).eligibleAtOpen = 3
    ;(poll as { votes: unknown[] }).votes = [pvote('codex', 'complete'), pvote('ghost', 'complete')]
    resolveDirect(harness, 'binding-unreach')
    expect(
      harness.chat.messages.some((m) =>
        (m.content || '').includes('authority unreachable at resolution')
      )
    ).toBe(true)
  })

  it('rejects Boss control from non-Boss callers and stale round ids', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const stale = await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'skip_participant',
      roundId: 'old-round',
      targetParticipantId: 'codex'
    })
    expect(stale.ok).toBe(false)
    expect(stale.error).toBe('stale_round')

    harness.orchestrator.handleProviderOutput(
      'claude',
      {
        appRunId: harness.dispatched[0].appRunId,
        appChatId: 'ensemble-chat'
      },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    const rejected = await harness.orchestrator.bossmanControlForRun(
      harness.dispatched[1].appRunId,
      {
        action: 'stop_round',
        roundId: harness.chat.ensemble?.activeRound?.roundId,
        reason: 'Not allowed.'
      }
    )
    expect(rejected.ok).toBe(false)
    expect(rejected.error).toBe('not_bossman')
  })

  it('audits a non-Boss control attempt to the durable ledger', async () => {
    const rejections: Array<{ metadata: Record<string, unknown> }> = []
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    const harness = makeHarness({
      initialChat,
      recordBossmanControlRejection: (rejection) => rejections.push(rejection)
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    const rejected = await harness.orchestrator.bossmanControlForRun(
      harness.dispatched[1].appRunId,
      {
        action: 'stop_round'
      }
    )
    expect(rejected.error).toBe('not_bossman')
    expect(rejections).toHaveLength(1)
    expect(rejections[0].metadata).toMatchObject({
      kind: 'bossman_control_rejected',
      rejectionReason: 'not_bossman',
      action: 'stop_round',
      attemptingParticipantId: 'codex',
      assignedBossmanParticipantId: 'claude'
    })
  })

  it('rejects roster edits from non-Boss callers and audits with roster_edit_rejected', async () => {
    const rejections: Array<{ metadata: Record<string, unknown> }> = []
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.bossmanAutoApprovals = {
      enabled: true,
      mode: 'permission_preset_once',
      confirmedAt: '2026-05-24T00:00:00.000Z'
    }
    initialChat.ensemble!.participants[0].permissionPresetId = 'workspace_write'
    const harness = makeHarness({
      initialChat,
      recordBossmanControlRejection: (rejection) => rejections.push(rejection)
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

    const rejected = await harness.orchestrator.rosterEditForRun(harness.dispatched[1].appRunId, {
      action: 'add_participant',
      participant: { provider: 'kimi' }
    })

    expect(rejected.ok).toBe(false)
    expect(rejected.error).toBe('not_bossman')
    expect(rejections).toHaveLength(1)
    expect(rejections[0].metadata).toMatchObject({
      kind: 'roster_edit_rejected',
      rejectionReason: 'not_bossman',
      action: 'add_participant',
      attemptingParticipantId: 'codex',
      assignedBossmanParticipantId: 'claude'
    })
  })

  it('lets the Boss rewrite and clear another participant brief through briefUpdateForRun', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.bossmanAutoApprovals = {
      enabled: true,
      mode: 'permission_preset_once',
      confirmedAt: '2026-05-24T00:00:00.000Z'
    }
    initialChat.ensemble!.participants[0].role = 'Boss'
    initialChat.ensemble!.participants[0].permissionPresetId = 'workspace_write'
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const rewritten = await harness.orchestrator.briefUpdateForRun(harness.dispatched[0].appRunId, {
      targetParticipantId: 'codex',
      brief: 'Coordinate reviewer handoff and keep implementation notes current.',
      reason: 'Worker needs a narrower long-horizon role.'
    })

    expect(rewritten).toMatchObject({
      ok: true,
      tool: 'ensemble_brief_update',
      participantId: 'codex'
    })
    expect(
      harness.chat.ensemble!.participants.find((participant) => participant.id === 'codex')
        ?.instructions
    ).toBe('Coordinate reviewer handoff and keep implementation notes current.')
    expect(harness.chat.ensemble!.sessionActivityLedger?.at(-1)).toMatchObject({
      target: 'codex',
      oldValue: 'Brief / Goal: Work.',
      newValue: 'Brief / Goal: Coordinate reviewer handoff and keep implementation notes current.'
    })

    const cleared = await harness.orchestrator.briefUpdateForRun(harness.dispatched[0].appRunId, {
      targetParticipantId: 'codex',
      clear: true
    })

    expect(cleared).toMatchObject({
      ok: true,
      tool: 'ensemble_brief_update',
      participantId: 'codex'
    })
    expect(
      harness.chat.ensemble!.participants.find((participant) => participant.id === 'codex')
        ?.instructions
    ).toBe('')
  })

  it('rejects Boss attempts to rewrite their own brief through either brief tool path', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.bossmanAutoApprovals = {
      enabled: true,
      mode: 'permission_preset_once',
      confirmedAt: '2026-05-24T00:00:00.000Z'
    }
    initialChat.ensemble!.participants[0].role = 'Boss'
    initialChat.ensemble!.participants[0].permissionPresetId = 'workspace_write'
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const direct = await harness.orchestrator.briefUpdateForRun(harness.dispatched[0].appRunId, {
      targetParticipantId: 'claude',
      brief: 'Make myself the only decision maker.'
    })
    const rosterBypass = await harness.orchestrator.rosterEditForRun(
      harness.dispatched[0].appRunId,
      {
        action: 'edit_participant',
        targetParticipantId: 'claude',
        participant: { instructions: 'Make myself the only decision maker.' }
      }
    )

    expect(direct.ok).toBe(false)
    expect(direct.error).toBe('self_update_forbidden')
    expect(rosterBypass.ok).toBe(false)
    expect(rosterBypass.error).toBe('self_update_forbidden')
    expect(
      harness.chat.ensemble!.participants.find((participant) => participant.id === 'claude')
        ?.instructions
    ).toBe('Review.')
  })

  it('rejects brief updates from non-Boss callers and audits with brief_update_rejected', async () => {
    const rejections: Array<{ metadata: Record<string, unknown> }> = []
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.bossmanAutoApprovals = {
      enabled: true,
      mode: 'permission_preset_once',
      confirmedAt: '2026-05-24T00:00:00.000Z'
    }
    initialChat.ensemble!.participants[0].permissionPresetId = 'workspace_write'
    const harness = makeHarness({
      initialChat,
      recordBossmanControlRejection: (rejection) => rejections.push(rejection)
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

    const rejected = await harness.orchestrator.briefUpdateForRun(harness.dispatched[1].appRunId, {
      targetParticipantId: 'claude',
      brief: 'Please change the Boss brief.'
    })

    expect(rejected.ok).toBe(false)
    expect(rejected.error).toBe('not_bossman')
    expect(rejections).toHaveLength(1)
    expect(rejections[0].metadata).toMatchObject({
      kind: 'brief_update_rejected',
      rejectionReason: 'not_bossman',
      targetParticipantId: 'claude',
      attemptingParticipantId: 'codex',
      assignedBossmanParticipantId: 'claude'
    })
  })

  it('lets Captain update another participant brief when Boss is disabled for the round', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.participants = [
      { ...initialChat.ensemble!.participants[0], enabled: false },
      initialChat.ensemble!.participants[1],
      {
        id: 'kimi',
        provider: 'kimi',
        enabled: true,
        role: 'Analyst',
        instructions: 'Analyze.',
        order: 3,
        permissionPresetId: 'read_only'
      }
    ]
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.secondInCommandParticipantId = 'codex'
    initialChat.ensemble!.bossmanAutoApprovals = {
      enabled: true,
      mode: 'permission_preset_once',
      confirmedAt: '2026-05-24T00:00:00.000Z'
    }
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Continue.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('codex')

    const result = await harness.orchestrator.briefUpdateForRun(harness.dispatched[0].appRunId, {
      targetParticipantId: 'kimi',
      brief: 'Track evidence gaps and brief the writer before commit.'
    })

    expect(result.ok).toBe(true)
    expect(
      harness.chat.ensemble?.participants.find((participant) => participant.id === 'kimi')
        ?.instructions
    ).toBe('Track evidence gaps and brief the writer before commit.')
  })

  it('rejects roster edits when Boss Auto Approvals consent is disabled', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.participants[0].permissionPresetId = 'workspace_write'
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = await harness.orchestrator.rosterEditForRun(harness.dispatched[0].appRunId, {
      action: 'add_participant',
      participant: { provider: 'kimi' }
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('auto_approvals_disabled')
  })

  it('adds a participant through rosterEditForRun after provider health passes', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.bossmanAutoApprovals = {
      enabled: true,
      mode: 'permission_preset_once',
      confirmedAt: '2026-05-24T00:00:00.000Z'
    }
    initialChat.ensemble!.participants[0].permissionPresetId = 'workspace_write'
    const harness = makeHarness({
      initialChat,
      probeParticipant: async () => ({ reachable: true })
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = await harness.orchestrator.rosterEditForRun(harness.dispatched[0].appRunId, {
      action: 'add_participant',
      participant: {
        provider: 'kimi',
        role: 'Verifier',
        model: 'kimi-k2',
        permissionPresetId: 'plan'
      }
    })

    expect(result.ok).toBe(true)
    expect(result.participantId).toMatch(/^bossman-roster-/)
    const added = harness.chat.ensemble!.participants.find(
      (participant) => participant.id === result.participantId
    )
    expect(added).toMatchObject({
      provider: 'kimi',
      role: 'Verifier',
      model: 'kimi-k2',
      permissionPresetId: 'plan'
    })
    expect(harness.chat.ensemble!.activeRound?.participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          participantId: result.participantId,
          provider: 'kimi',
          role: 'Verifier',
          model: 'kimi-k2',
          permissionPresetId: 'plan',
          initialSeatSnapshot: {
            schemaVersion: 1,
            provider: 'kimi',
            model: 'kimi-k2',
            thinkingEnabled: true,
            configuredPermissionPresetId: 'plan'
          },
          status: 'idle'
        })
      ])
    )
    expect(
      harness.probeParticipant?.mock.calls.some(([participant]) => participant.provider === 'kimi')
    ).toBe(true)
  })

  it('retains a removed no-turn participant as a skipped round audit row', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.bossmanAutoApprovals = {
      enabled: true,
      mode: 'permission_preset_once',
      confirmedAt: '2026-05-24T00:00:00.000Z'
    }
    initialChat.ensemble!.participants[0].permissionPresetId = 'workspace_write'
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = await harness.orchestrator.rosterEditForRun(harness.dispatched[0].appRunId, {
      action: 'remove_participant',
      targetParticipantId: 'codex'
    })

    expect(result).toMatchObject({ ok: true, participantId: 'codex' })
    expect(
      harness.chat.ensemble!.participants.some((participant) => participant.id === 'codex')
    ).toBe(false)
    expect(
      harness.chat.ensemble!.activeRound?.participants.find(
        (participant) => participant.participantId === 'codex'
      )
    ).toMatchObject({
      provider: 'codex',
      role: 'Worker',
      status: 'skipped',
      reason: 'Removed from the active roster during this round.'
    })
  })

  it('applies a Boss pending participant seat change before its upcoming turn', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.bossmanAutoApprovals = {
      enabled: true,
      mode: 'permission_preset_once',
      confirmedAt: '2026-05-24T00:00:00.000Z'
    }
    initialChat.ensemble!.participants[0].role = 'Boss'
    initialChat.ensemble!.participants[0].permissionPresetId = 'workspace_write'
    initialChat.ensemble!.participants[1].promptShellVersion = 'ensemble-shell-v1:old-codex-receipt'
    initialChat.ensemble!.participants[1].promptDynamicStateVersion =
      'ensemble-dynamic-v1:old-codex-receipt'
    initialChat.ensemble!.participants[1].taskWraithMcpProfileReceipt = {
      schemaVersion: 1,
      profileId: 'taskwraith-core-v1',
      provider: 'codex',
      providerSessionId: 'codex-session-before-swap',
      pinnedAt: '2026-07-11T00:00:00.000Z'
    }
    const harness = makeHarness({
      initialChat,
      probeParticipant: async () => ({ reachable: true })
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = await harness.orchestrator.rosterEditForRun(harness.dispatched[0].appRunId, {
      action: 'edit_participant',
      targetParticipantId: 'codex',
      participant: {
        provider: 'kimi',
        model: 'kimi-k2.7-code',
        role: 'Quota relief',
        instructions: 'Pick up the implementation if Codex quota is tight.',
        reasoningEffort: 'medium'
      }
    })

    expect(result).toMatchObject({
      ok: true,
      participantId: 'codex'
    })
    expect(result.deferred).toBeUndefined()
    expect(
      harness.chat.ensemble!.participants.find((participant) => participant.id === 'codex')
    ).toMatchObject({
      provider: 'kimi',
      model: 'kimi-k2.7-code',
      role: 'Quota relief',
      instructions: 'Pick up the implementation if Codex quota is tight.',
      reasoningEffort: 'medium'
    })
    expect(
      harness.chat.ensemble!.participants.find((participant) => participant.id === 'codex')
        ?.promptShellVersion
    ).toBeUndefined()
    expect(
      harness.chat.ensemble!.participants.find((participant) => participant.id === 'codex')
        ?.promptDynamicStateVersion
    ).toBeUndefined()
    expect(
      harness.chat.ensemble!.participants.find((participant) => participant.id === 'codex')
        ?.taskWraithMcpProfileReceipt
    ).toBeUndefined()
    expect(
      harness.chat.ensemble!.activeRound?.participants.find(
        (participant) => participant.participantId === 'codex'
      )
    ).toMatchObject({
      provider: 'kimi',
      role: 'Quota relief',
      status: 'idle'
    })

    const activeRoute = { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' }
    harness.orchestrator.handleProviderOutput('claude', activeRoute, {
      type: 'content',
      text: 'Seat change applied before the pending turn.'
    })
    harness.orchestrator.handleProviderOutput('claude', activeRoute, {
      type: 'result',
      status: 'success',
      stats: { total_tokens: 5 }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1]).toMatchObject({
      provider: 'kimi',
      model: 'kimi-k2.7-code',
      reasoningEffort: 'medium',
      ensembleRun: {
        participantId: 'codex',
        role: 'Quota relief'
      }
    })

    harness.orchestrator.handleProviderOutput(
      'kimi',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'Updated Kimi seat completed its turn.' }
    )
    harness.orchestrator.handleProviderOutput(
      'kimi',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 5 } }
    )

    expect(
      harness.chat.ensemble!.activeRound?.participants.find(
        (participant) => participant.participantId === 'codex'
      )
    ).toMatchObject({
      provider: 'kimi',
      role: 'Quota relief',
      status: 'answered'
    })
  })

  it('queues a Boss seat swap only until the active execution boundary', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.bossmanAutoApprovals = {
      enabled: true,
      mode: 'permission_preset_once',
      confirmedAt: '2026-05-24T00:00:00.000Z'
    }
    initialChat.ensemble!.participants[0].role = 'Boss'
    initialChat.ensemble!.participants[0].permissionPresetId = 'workspace_write'
    const harness = makeHarness({
      initialChat,
      probeParticipant: async () => ({ reachable: true })
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = await harness.orchestrator.rosterEditForRun(harness.dispatched[0].appRunId, {
      action: 'edit_participant',
      targetParticipantId: 'claude',
      participant: {
        provider: 'codex',
        model: 'gpt-5.5',
        role: 'Boss'
      }
    })

    expect(result).toMatchObject({
      ok: true,
      participantId: 'claude',
      deferred: true
    })
    expect(
      harness.chat.ensemble!.participants.find((participant) => participant.id === 'claude')
    ).toMatchObject({
      provider: 'claude',
      model: 'claude-model'
    })
    // A queued change writes NO transcript row: it has not happened yet, and
    // the seat element lands at the execution boundary below. The caller is
    // still told, through the tool result.
    expect(result.message).toContain('Authoritative seat change queued for Boss')
    expect(result.message).toContain(
      'It will apply when that participant finishes its current execution.'
    )
    expect(
      harness.chat.messages.filter((message) =>
        (message.content || '').includes('Authoritative seat change queued')
      )
    ).toHaveLength(0)

    const activeRoute = { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' }
    harness.orchestrator.handleProviderOutput('claude', activeRoute, {
      type: 'content',
      text: 'User-requested change will apply after this turn.'
    })
    harness.orchestrator.handleProviderOutput('claude', activeRoute, {
      type: 'result',
      status: 'success',
      stats: { total_tokens: 5 }
    })

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1]).toMatchObject({
      provider: 'codex',
      model: 'codex-model',
      ensembleRun: {
        participantId: 'codex',
        role: 'Worker'
      }
    })
    expect(
      harness.chat.ensemble!.participants.find((participant) => participant.id === 'claude')
    ).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.5',
      role: 'Boss'
    })

    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 5 } }
    )

    expect(
      harness.chat.ensemble!.activeRound?.participants.find(
        (participant) => participant.participantId === 'claude'
      )
    ).toMatchObject({
      provider: 'codex',
      role: 'Boss',
      status: 'answered'
    })
    expect(harness.chat.ensemble!.sessionActivityLedger?.at(-1)).toMatchObject({
      changedBy: 'orchestrator',
      scope: 'participant',
      target: 'claude',
      oldValue: expect.stringContaining('Claude / claude-model'),
      newValue: expect.stringContaining('Codex / gpt-5.5')
    })
    expect(
      harness.chat.messages.some((message) =>
        message.content.includes('Authoritative seat change applied at execution boundary for Boss')
      )
    ).toBe(true)
  })

  it('shows a roster the agent built mid-round as ONE stacked row with no before side', async () => {
    const initialChat = makeChat()
    // The solo→Ensemble case: the thread holds its single seed seat and nothing
    // else, then the agent switches Ensemble on and builds the roster around it.
    initialChat.ensemble!.participants = [initialChat.ensemble!.participants[0]]
    initialChat.ensemble!.participants[0].role = 'Boss'
    initialChat.ensemble!.participants[0].permissionPresetId = 'workspace_write'
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.bossmanAutoApprovals = {
      enabled: true,
      mode: 'permission_preset_once',
      confirmedAt: '2026-05-24T00:00:00.000Z'
    }
    const harness = makeHarness({
      initialChat,
      probeParticipant: async () => ({ reachable: true })
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    for (const participant of [
      { provider: 'kimi' as const, role: 'Verifier', model: 'kimi-k2', permissionPresetId: 'plan' },
      { provider: 'codex' as const, role: 'Scout', model: 'gpt-5.5', permissionPresetId: 'plan' }
    ]) {
      const result = await harness.orchestrator.rosterEditForRun(harness.dispatched[0].appRunId, {
        action: 'add_participant',
        participant
      })
      expect(result.ok).toBe(true)
    }

    const rosterRows = harness.chat.messages.filter((message) =>
      isSeatRosterPayload(message.metadata?.seatChange)
    )
    // Building a roster is a RUN of adds; one row per add would bury the round
    // in lines that each state a fraction of the truth.
    expect(rosterRows).toHaveLength(1)
    const payload = rosterRows[0].metadata?.seatChange
    if (!isSeatRosterPayload(payload)) throw new Error('expected the roster variant')
    // The whole roster as it now stands — the seed seat included, in order.
    expect(payload.seats.map((seat) => seat.role)).toEqual(['Boss', 'Verifier', 'Scout'])
    // No before side at all: a moment ago these seats did not exist.
    expect(payload).not.toHaveProperty('before')
    expect(payload).not.toHaveProperty('after')
    expect(rosterRows[0].metadata?.kind).toBe('ensembleSeatChange')
    // The plain status line is REPLACED, not written beside the stack.
    expect(harness.chat.messages.some((message) => message.content.includes('Boss added'))).toBe(
      false
    )
    // ...but prose surfaces (TUI / iOS / copy-paste) still get the whole roster.
    expect(rosterRows[0].content).toContain('Verifier')
    expect(rosterRows[0].content).toContain('Scout')
  })

  it('keeps an open roster stack truthful when the agent edits a seat it just added', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.participants = [initialChat.ensemble!.participants[0]]
    initialChat.ensemble!.participants[0].role = 'Boss'
    initialChat.ensemble!.participants[0].permissionPresetId = 'workspace_write'
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.bossmanAutoApprovals = {
      enabled: true,
      mode: 'permission_preset_once',
      confirmedAt: '2026-05-24T00:00:00.000Z'
    }
    const harness = makeHarness({
      initialChat,
      probeParticipant: async () => ({ reachable: true })
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const added = await harness.orchestrator.rosterEditForRun(harness.dispatched[0].appRunId, {
      action: 'add_participant',
      participant: {
        provider: 'codex',
        role: 'Scout',
        model: 'gpt-5.5',
        permissionPresetId: 'plan'
      }
    })
    expect(added.ok).toBe(true)

    await harness.orchestrator.rosterEditForRun(harness.dispatched[0].appRunId, {
      action: 'edit_participant',
      targetParticipantId: added.participantId,
      participant: { model: 'gpt-5.6' }
    })

    const rosterRows = harness.chat.messages.filter((message) =>
      isSeatRosterPayload(message.metadata?.seatChange)
    )
    // Still one stack — the edit refreshes it rather than opening a second.
    expect(rosterRows).toHaveLength(1)
    const payload = rosterRows[0].metadata?.seatChange
    if (!isSeatRosterPayload(payload)) throw new Error('expected the roster variant')
    // The stack must not go on displaying the seat's superseded model.
    expect(payload.seats.map((seat) => seat.model)).toContain('gpt-5.6')
    expect(payload.seats.map((seat) => seat.model)).not.toContain('gpt-5.5')
  })

  it('emits a structured seatChange transcript row and coalesces rapid edits to one row', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.bossmanAutoApprovals = {
      enabled: true,
      mode: 'permission_preset_once',
      confirmedAt: '2026-05-24T00:00:00.000Z'
    }
    initialChat.ensemble!.participants[0].role = 'Boss'
    const harness = makeHarness({
      initialChat,
      probeParticipant: async () => ({ reachable: true })
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    // Boss (claude) is executing; editing the idle codex seat applies immediately.
    const first = await harness.orchestrator.rosterEditForRun(harness.dispatched[0].appRunId, {
      action: 'edit_participant',
      targetParticipantId: 'codex',
      participant: { provider: 'codex', model: 'gpt-5.5', role: 'Worker' }
    })
    expect(first).toMatchObject({ ok: true, participantId: 'codex' })

    const seatChangeMessages = () =>
      harness.chat.messages.filter(
        (message) => message.metadata?.seatChange?.participantId === 'codex'
      )
    expect(seatChangeMessages()).toHaveLength(1)
    const firstRow = seatChangeMessages()[0]
    expect(firstRow.metadata?.kind).toBe('ensembleSeatChange')
    expect(firstRow.content).toContain('Authoritative seat change applied')
    expect(firstRow.metadata?.seatChange).toMatchObject({
      before: {
        provider: 'codex',
        model: 'codex-model',
        role: 'Worker',
        permissionPresetId: 'workspace_write',
        seatNumber: 2
      },
      after: { provider: 'codex', model: 'gpt-5.5', role: 'Worker', seatNumber: 2 }
    })

    // A second tweak inside the window replaces the row (lose one, gain one)
    // and inherits the ORIGINAL before-state.
    const second = await harness.orchestrator.rosterEditForRun(harness.dispatched[0].appRunId, {
      action: 'edit_participant',
      targetParticipantId: 'codex',
      participant: { provider: 'codex', model: 'gpt-5.5-codex', role: 'Worker' }
    })
    expect(second).toMatchObject({ ok: true, participantId: 'codex' })
    expect(seatChangeMessages()).toHaveLength(1)
    expect(seatChangeMessages()[0].metadata?.seatChange).toMatchObject({
      before: { provider: 'codex', model: 'codex-model' },
      after: { provider: 'codex', model: 'gpt-5.5-codex' }
    })
    expect(seatChangeMessages()[0].id).not.toBe(firstRow.id)
  })

  it('annotates toggle-only seat changes with the final enabled state', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.bossmanAutoApprovals = {
      enabled: true,
      mode: 'permission_preset_once',
      confirmedAt: '2026-05-24T00:00:00.000Z'
    }
    const harness = makeHarness({
      initialChat,
      probeParticipant: async () => ({ reachable: true })
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const seatChangeRow = () => {
      const payload = harness.chat.messages
        .filter((message) => message.metadata?.seatChange?.participantId === 'codex')
        .at(-1)?.metadata?.seatChange
      return isSeatRosterPayload(payload) ? undefined : payload
    }

    const disabled = await harness.orchestrator.requestParticipantSeatChange({
      chatId: 'ensemble-chat',
      participantId: 'codex',
      participant: { enabled: false },
      changedBy: 'user',
      reason: 'User disabled an idle seat.'
    })
    expect(disabled).toMatchObject({ ok: true, status: 'applied' })
    expect(seatChangeRow()).toMatchObject({ enabledChangedTo: false })
    // Enabled is deliberately event chrome rather than a composer chip field,
    // so a toggle-only row has identical visual seat snapshots plus the note.
    expect(seatChangeRow()!.before).toEqual(seatChangeRow()!.after)

    // An unrelated tweak folded into the same living row must not erase the
    // earlier status annotation.
    await harness.orchestrator.requestParticipantSeatChange({
      chatId: 'ensemble-chat',
      participantId: 'codex',
      participant: { model: 'gpt-5.5' },
      changedBy: 'user',
      reason: 'User changed an idle seat model.'
    })
    expect(seatChangeRow()).toMatchObject({ enabledChangedTo: false })

    // If the seat is toggled again inside the window, the latest final state
    // wins rather than truthiness-dropping `false` or OR-ing both toggles.
    const enabled = await harness.orchestrator.requestParticipantSeatChange({
      chatId: 'ensemble-chat',
      participantId: 'codex',
      participant: { enabled: true },
      changedBy: 'user',
      reason: 'User enabled an idle seat.'
    })
    expect(enabled).toMatchObject({ ok: true, status: 'applied' })
    expect(seatChangeRow()).toMatchObject({ enabledChangedTo: true })
  })

  it('flags a brief-only edit, which changes nothing the seat chips can show', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.bossmanAutoApprovals = {
      enabled: true,
      mode: 'permission_preset_once',
      confirmedAt: '2026-05-24T00:00:00.000Z'
    }
    const harness = makeHarness({
      initialChat,
      probeParticipant: async () => ({ reachable: true })
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    // `metadata.seatChange` also carries the roster-created STACK, which has no
    // before/after to compare. Narrowing through the shared guard rather than
    // casting keeps this a real assertion that a roster row never lands here.
    const seatChangeRow = () => {
      const payload = harness.chat.messages
        .filter((message) => message.metadata?.seatChange?.participantId === 'codex')
        .at(-1)?.metadata?.seatChange
      return isSeatRosterPayload(payload) ? undefined : payload
    }

    // Brief only: provider, model, role, tier, grants and stage all hold, so
    // every chip on the row is identical on both sides. Without the flag the
    // transcript announces a change and then shows none.
    await harness.orchestrator.rosterEditForRun(harness.dispatched[0].appRunId, {
      action: 'edit_participant',
      targetParticipantId: 'codex',
      participant: { instructions: 'Sweep the provider seams before you touch dispatch.' }
    })
    expect(seatChangeRow()).toMatchObject({ briefUpdated: true })
    expect(seatChangeRow()!.before).toEqual(seatChangeRow()!.after)

    // A later edit that leaves the brief alone must not carry the flag — it is
    // read as "the brief moved", not "this row is a seat change".
    await harness.orchestrator.rosterEditForRun(harness.dispatched[0].appRunId, {
      action: 'edit_participant',
      targetParticipantId: 'codex',
      participant: { model: 'gpt-5.5' }
    })
    // ...except through the coalescing window, where the surviving row still
    // stands for the brief edit it inherited its before-state from.
    expect(seatChangeRow()).toMatchObject({ briefUpdated: true })
    expect(seatChangeRow()!.after).toMatchObject({ model: 'gpt-5.5' })
  })

  it('merges active-seat picker edits and applies them at the execution boundary', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = await harness.orchestrator.requestParticipantSeatChange({
      chatId: 'ensemble-chat',
      participantId: 'claude',
      participant: {
        provider: 'codex',
        model: 'gpt-5.5',
        runtimeProfileId: 'runtime-active-seat',
        serviceTier: 'fast',
        linkedProviderSessionId: null
      },
      changedBy: 'user',
      reason: 'User changed the active seat.'
    })

    expect(result).toMatchObject({
      ok: true,
      status: 'queued',
      participantId: 'claude',
      pendingParticipant: {
        provider: 'codex',
        model: 'gpt-5.5',
        runtimeProfileId: 'runtime-active-seat',
        serviceTier: 'fast',
        linkedProviderSessionId: null
      }
    })
    const postureResult = await harness.orchestrator.requestParticipantSeatChange({
      chatId: 'ensemble-chat',
      participantId: 'claude',
      participant: {
        reasoningEffort: 'xhigh',
        permissionPresetId: 'workspace_write'
      },
      changedBy: 'user',
      reason: 'User finished configuring the active seat.'
    })
    expect(postureResult).toMatchObject({
      ok: true,
      status: 'queued',
      participantId: 'claude',
      pendingParticipant: {
        provider: 'codex',
        model: 'gpt-5.5',
        reasoningEffort: 'xhigh',
        permissionPresetId: 'workspace_write',
        runtimeProfileId: 'runtime-active-seat',
        serviceTier: 'fast',
        linkedProviderSessionId: null
      }
    })
    expect(
      harness.chat.ensemble!.participants.find((participant) => participant.id === 'claude')
    ).toMatchObject({
      provider: 'claude',
      model: 'claude-model'
    })

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 5 } }
    )

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(
      harness.chat.ensemble!.participants.find((participant) => participant.id === 'claude')
    ).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.5',
      reasoningEffort: 'xhigh',
      permissionPresetId: 'workspace_write',
      runtimeProfileId: 'runtime-active-seat',
      serviceTier: 'fast',
      linkedProviderSessionId: null
    })

    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 5 } }
    )

    expect(harness.chat.ensemble!.sessionActivityLedger?.at(-1)).toMatchObject({
      changedBy: 'user',
      target: 'claude',
      oldValue: expect.stringContaining('Claude / claude-model'),
      newValue: expect.stringContaining('Codex / gpt-5.5'),
      reason: 'User finished configuring the active seat.'
    })
  })

  it('applies an inactive participant provider/model/reasoning/permission change immediately', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = await harness.orchestrator.requestParticipantSeatChange({
      chatId: 'ensemble-chat',
      participantId: 'codex',
      participant: {
        provider: 'kimi',
        model: 'kimi-k2.7-code',
        role: 'Quota relief',
        reasoningEffort: 'high',
        permissionPresetId: 'read_only'
      },
      changedBy: 'user',
      reason: 'User changed an inactive seat.'
    })

    expect(result).toMatchObject({
      ok: true,
      status: 'applied',
      participantId: 'codex'
    })
    expect(
      harness.chat.ensemble!.participants.find((participant) => participant.id === 'codex')
    ).toMatchObject({
      provider: 'kimi',
      model: 'kimi-k2.7-code',
      role: 'Quota relief',
      reasoningEffort: 'high',
      permissionPresetId: 'read_only'
    })
    expect(
      harness.chat.ensemble!.activeRound?.participants.find(
        (participant) => participant.participantId === 'codex'
      )
    ).toMatchObject({
      provider: 'kimi',
      role: 'Quota relief',
      reasoningEffort: 'high',
      permissionPresetId: 'read_only',
      status: 'idle'
    })

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 5 } }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1]).toMatchObject({
      provider: 'kimi',
      model: 'kimi-k2.7-code',
      reasoningEffort: 'high',
      approvalMode: 'plan',
      ensembleRun: {
        participantId: 'codex',
        role: 'Quota relief'
      }
    })
    harness.orchestrator.handleProviderOutput(
      'kimi',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'Updated idle seat completed its turn.' }
    )
    harness.orchestrator.handleProviderOutput(
      'kimi',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 5 } }
    )

    expect(
      harness.chat.ensemble!.activeRound?.participants.find(
        (participant) => participant.participantId === 'codex'
      )
    ).toMatchObject({
      provider: 'kimi',
      role: 'Quota relief',
      status: 'answered'
    })
    expect(harness.chat.ensemble!.sessionActivityLedger?.at(-1)).toMatchObject({
      changedBy: 'user',
      target: 'codex',
      oldValue: expect.stringContaining('Codex / codex-model'),
      newValue: expect.stringContaining('Kimi / kimi-k2.7-code')
    })
  })

  it('applies idle Enabled and Stage edits immediately to the current round', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.bossmanAutoApprovals = {
      enabled: true,
      mode: 'permission_preset_once',
      confirmedAt: '2026-07-28T00:00:00.000Z'
    }
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const background = await harness.orchestrator.requestParticipantSeatChange({
      chatId: 'ensemble-chat',
      participantId: 'codex',
      participant: { stageRole: 'background' },
      changedBy: 'user',
      reason: 'User moved an idle seat to BG.'
    })
    expect(background).toMatchObject({ ok: true, status: 'applied' })
    expect(harness.chat.ensemble).toMatchObject({
      bossmanParticipantId: 'claude',
      bossmanAutoApprovals: { enabled: true }
    })
    expect(
      harness.chat.ensemble!.activeRound?.participants.find(
        (participant) => participant.participantId === 'codex'
      )
    ).toMatchObject({
      status: 'skipped',
      reason: 'Moved to BG during the active round.'
    })

    const restoredStage = await harness.orchestrator.requestParticipantSeatChange({
      chatId: 'ensemble-chat',
      participantId: 'codex',
      participant: { stageRole: 'reviewer' },
      changedBy: 'user',
      reason: 'User restored the seat to Review.'
    })
    expect(restoredStage).toMatchObject({ ok: true, status: 'applied' })
    expect(
      harness.chat.ensemble!.activeRound?.participants.find(
        (participant) => participant.participantId === 'codex'
      )
    ).toMatchObject({ status: 'idle' })

    const disabled = await harness.orchestrator.requestParticipantSeatChange({
      chatId: 'ensemble-chat',
      participantId: 'codex',
      participant: { enabled: false },
      changedBy: 'user',
      reason: 'User disabled an idle seat.'
    })
    expect(disabled).toMatchObject({ ok: true, status: 'applied' })
    expect(
      harness.chat.ensemble!.activeRound?.participants.find(
        (participant) => participant.participantId === 'codex'
      )
    ).toMatchObject({
      status: 'skipped',
      reason: 'Disabled during the active round.'
    })

    const reenabled = await harness.orchestrator.requestParticipantSeatChange({
      chatId: 'ensemble-chat',
      participantId: 'codex',
      participant: { enabled: true },
      changedBy: 'user',
      reason: 'User re-enabled the idle seat.'
    })
    expect(reenabled).toMatchObject({ ok: true, status: 'applied' })
    expect(
      harness.chat.ensemble!.activeRound?.participants.find(
        (participant) => participant.participantId === 'codex'
      )
    ).toMatchObject({ status: 'idle' })

    completeDispatchedRun(harness, 0)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].ensembleRun).toMatchObject({
      participantId: 'codex',
      stageRole: 'reviewer'
    })
    completeDispatchedRun(harness, 1)
  })

  it('applies live add, reorder, and idle removal before the next admission', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const added = harness.orchestrator.requestUserRosterMutation({
      chatId: 'ensemble-chat',
      action: 'add',
      participant: {
        id: 'kimi-added',
        provider: 'kimi',
        enabled: true,
        role: 'Added worker',
        instructions: 'Take the next safe turn.',
        order: 2,
        model: 'kimi-k2.7-code',
        permissionPresetId: 'read_only'
      }
    })
    expect(added).toMatchObject({ ok: true, status: 'applied' })

    const reordered = harness.orchestrator.requestUserRosterMutation({
      chatId: 'ensemble-chat',
      action: 'reorder',
      participantIds: ['claude', 'codex', 'kimi-added']
    })
    expect(reordered).toMatchObject({ ok: true, status: 'applied' })

    const removed = harness.orchestrator.requestUserRosterMutation({
      chatId: 'ensemble-chat',
      action: 'remove',
      participantId: 'codex'
    })
    expect(removed).toMatchObject({ ok: true, status: 'applied' })
    expect(harness.chat.ensemble!.participants.map((participant) => participant.id)).toEqual([
      'claude',
      'kimi-added'
    ])

    completeDispatchedRun(harness, 0)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1]).toMatchObject({
      provider: 'kimi',
      model: 'kimi-k2.7-code',
      ensembleRun: { participantId: 'kimi-added', role: 'Added worker' }
    })
    completeDispatchedRun(harness, 1)
  })

  it('synchronizes live Captain mutations into runtime and active-round authority', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.participants = [
      {
        ...initialChat.ensemble!.participants[1],
        id: 'worker',
        role: 'Worker',
        order: 1
      },
      {
        ...initialChat.ensemble!.participants[0],
        id: 'boss',
        role: 'Boss',
        order: 2
      }
    ]
    initialChat.ensemble!.bossmanParticipantId = 'boss'
    initialChat.ensemble!.captainParticipantIds = []
    initialChat.ensemble!.secondInCommandParticipantId = undefined
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Keep the live authority snapshot current.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('worker')

    expect(
      harness.orchestrator.requestUserRosterMutation({
        chatId: 'ensemble-chat',
        action: 'set_authority',
        participantId: 'worker',
        authority: 'captain'
      })
    ).toMatchObject({ ok: true, status: 'applied' })
    expect(
      harness.orchestrator.requestUserRosterMutation({
        chatId: 'ensemble-chat',
        action: 'add',
        authority: 'captain',
        participant: {
          id: 'captain-added',
          provider: 'kimi',
          enabled: true,
          role: 'Captain Added',
          instructions: 'Coordinate the next lane.',
          order: 3,
          permissionPresetId: 'default'
        }
      })
    ).toMatchObject({ ok: true, status: 'applied' })

    const listed = harness.orchestrator.listParticipantsForRun(harness.dispatched[0].appRunId)
    expect(listed.captainParticipantIds).toEqual(['worker', 'captain-added'])
    expect(harness.chat.ensemble!.activeRound).toMatchObject({
      bossmanParticipantId: 'boss',
      captainParticipantIds: ['worker', 'captain-added'],
      secondInCommandParticipantId: 'worker'
    })
  })

  it('queues active participant removal only until its execution boundary', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.bossmanParticipantId = 'codex'
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = harness.orchestrator.requestUserRosterMutation({
      chatId: 'ensemble-chat',
      action: 'remove',
      participantId: 'claude'
    })
    expect(result).toMatchObject({
      ok: true,
      status: 'queued',
      participantId: 'claude'
    })
    expect(
      harness.chat.ensemble!.participants.some((participant) => participant.id === 'claude')
    ).toBe(true)

    completeDispatchedRun(harness, 0)
    await vi.waitFor(() =>
      expect(
        harness.chat.ensemble!.participants.some((participant) => participant.id === 'claude')
      ).toBe(false)
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].ensembleRun).toMatchObject({ participantId: 'codex' })
    completeDispatchedRun(harness, 1)
  })

  it('defers a fanned-out participant change only until its lane finishes', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    harness.chat.ensemble!.participants[1].permissionPresetId = 'read_only'
    harness.chat.ensemble!.participants[1].stageRole = 'background'
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Review while the worker handles a parallel lane.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const fanout = harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
      targets: ['Worker'],
      prompt: 'Handle the parallel implementation lane.'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    await expect(fanout).resolves.toMatchObject({ ok: true, participantIds: ['codex'] })

    const result = await harness.orchestrator.requestParticipantSeatChange({
      chatId: 'ensemble-chat',
      participantId: 'codex',
      participant: {
        provider: 'kimi',
        model: 'kimi-k2.7-code',
        reasoningEffort: 'high',
        permissionPresetId: 'workspace_write'
      },
      changedBy: 'user',
      reason: 'Update the worker while its fan-out lane is active.'
    })

    expect(result).toMatchObject({
      ok: true,
      status: 'queued',
      participantId: 'codex'
    })
    expect(
      harness.chat.ensemble!.participants.find((participant) => participant.id === 'codex')
    ).toMatchObject({
      provider: 'codex',
      model: 'codex-model',
      permissionPresetId: 'read_only'
    })

    completeDispatchedRun(harness, 1)
    await vi.waitFor(() =>
      expect(
        harness.chat.ensemble!.participants.find((participant) => participant.id === 'codex')
      ).toMatchObject({
        provider: 'kimi',
        model: 'kimi-k2.7-code',
        reasoningEffort: 'high',
        permissionPresetId: 'workspace_write'
      })
    )

    completeDispatchedRun(harness, 0)
  })

  it('keeps a pinned MCP profile on the same seat session across an idle model change', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.participants[0] = {
      ...initialChat.ensemble!.participants[0],
      linkedProviderSessionId: 'claude-session-1',
      taskWraithMcpProfileReceipt: {
        schemaVersion: 1,
        profileId: 'taskwraith-core-v1',
        provider: 'claude',
        providerSessionId: 'claude-session-1',
        pinnedAt: '2026-07-11T00:00:00.000Z'
      }
    }
    const harness = makeHarness({ initialChat })

    const result = await harness.orchestrator.requestParticipantSeatChange({
      chatId: 'ensemble-chat',
      participantId: 'claude',
      participant: { model: 'claude-opus-next' },
      changedBy: 'user',
      reason: 'User changed the model.'
    })

    expect(result).toMatchObject({ ok: true, status: 'applied', participantId: 'claude' })
    const seat = harness.chat.ensemble?.participants.find(
      (participant) => participant.id === 'claude'
    )
    expect(seat?.model).toBe('claude-opus-next')
    expect(seat?.linkedProviderSessionId).toBe('claude-session-1')
    expect(seat?.taskWraithMcpProfileReceipt).toMatchObject({
      profileId: 'taskwraith-core-v1',
      providerSessionId: 'claude-session-1'
    })
  })

  it('does not persist a target session when main marks the run reroute-only', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.participants[0] = {
      ...initialChat.ensemble!.participants[0],
      linkedProviderSessionId: 'claude-session-a'
    }
    const shouldPersistProviderSessionForRun = vi.fn(() => false)
    const releaseProviderSessionPersistenceDecision = vi.fn()
    const harness = makeHarness({
      initialChat,
      shouldPersistProviderSessionForRun,
      releaseProviderSessionPersistenceDecision
    })

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Review this.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const route = {
      appRunId: harness.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }

    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'init',
      session_id: 'reroute-target-session'
    })
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'content',
      text: 'Review complete.'
    })
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'result',
      status: 'success'
    })

    await vi.waitFor(() =>
      expect(releaseProviderSessionPersistenceDecision).toHaveBeenCalledWith(
        harness.dispatched[0].appRunId
      )
    )
    expect(shouldPersistProviderSessionForRun).toHaveBeenCalledWith(harness.dispatched[0].appRunId)
    expect(harness.chat.ensemble?.participants[0].linkedProviderSessionId).toBe('claude-session-a')
  })

  it('clears a pinned MCP profile when an explicit provider patch resets the seat session', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.participants[0] = {
      ...initialChat.ensemble!.participants[0],
      linkedProviderSessionId: 'claude-session-1',
      taskWraithMcpProfileReceipt: {
        schemaVersion: 1,
        profileId: 'taskwraith-core-v1',
        provider: 'claude',
        providerSessionId: 'claude-session-1',
        pinnedAt: '2026-07-11T00:00:00.000Z'
      }
    }
    const harness = makeHarness({ initialChat })

    const result = await harness.orchestrator.requestParticipantSeatChange({
      chatId: 'ensemble-chat',
      participantId: 'claude',
      participant: { provider: 'claude' },
      changedBy: 'user',
      reason: 'User explicitly reset the provider seat.'
    })

    expect(result).toMatchObject({ ok: true, status: 'applied', participantId: 'claude' })
    const seat = harness.chat.ensemble?.participants.find(
      (participant) => participant.id === 'claude'
    )
    expect(seat?.linkedProviderSessionId).toBeNull()
    expect(seat?.taskWraithMcpProfileReceipt).toBeUndefined()
  })

  it('applies a user-requested inactive participant stage role immediately', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = await harness.orchestrator.requestParticipantSeatChange({
      chatId: 'ensemble-chat',
      participantId: 'codex',
      participant: {
        stageRole: 'reviewer'
      },
      changedBy: 'user',
      reason: 'User made Codex the reviewer.'
    })

    expect(result).toMatchObject({
      ok: true,
      status: 'applied',
      participantId: 'codex'
    })
    expect(
      harness.chat.ensemble!.participants.find((participant) => participant.id === 'codex')
    ).toMatchObject({
      provider: 'codex',
      stageRole: 'reviewer'
    })
    expect(harness.chat.ensemble!.sessionActivityLedger?.at(-1)).toMatchObject({
      changedBy: 'user',
      target: 'codex',
      oldValue: expect.stringContaining('Codex / codex-model'),
      newValue: expect.stringContaining('[reviewer]'),
      reason: 'User made Codex the reviewer.'
    })
  })

  it('clears a user-requested inactive participant stage role immediately', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.participants[1].stageRole = 'reviewer'
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = await harness.orchestrator.requestParticipantSeatChange({
      chatId: 'ensemble-chat',
      participantId: 'codex',
      participant: {
        stageRole: null
      },
      changedBy: 'user',
      reason: 'User cleared the reviewer stage.'
    })

    expect(result).toMatchObject({
      ok: true,
      status: 'applied',
      participantId: 'codex'
    })
    expect(
      harness.chat.ensemble!.participants.find((participant) => participant.id === 'codex')
        ?.stageRole
    ).toBeUndefined()
    expect(harness.chat.ensemble!.sessionActivityLedger?.at(-1)).toMatchObject({
      changedBy: 'user',
      target: 'codex',
      oldValue: expect.stringContaining('[reviewer]'),
      newValue: expect.not.stringContaining('[reviewer]'),
      reason: 'User cleared the reviewer stage.'
    })
  })

  it('rejects roster removal of the configured Boss participant', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.bossmanAutoApprovals = {
      enabled: true,
      mode: 'permission_preset_once',
      confirmedAt: '2026-05-24T00:00:00.000Z'
    }
    initialChat.ensemble!.participants[0].permissionPresetId = 'workspace_write'
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = await harness.orchestrator.rosterEditForRun(harness.dispatched[0].appRunId, {
      action: 'remove_participant',
      targetParticipantId: 'claude'
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('remove_boss')
  })

  it('rejects roster add with an unknown or retired provider', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.bossmanAutoApprovals = {
      enabled: true,
      mode: 'permission_preset_once',
      confirmedAt: '2026-05-24T00:00:00.000Z'
    }
    initialChat.ensemble!.participants[0].permissionPresetId = 'workspace_write'
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = await harness.orchestrator.rosterEditForRun(harness.dispatched[0].appRunId, {
      action: 'add_participant',
      participant: { provider: 'gemini' }
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('unknown_provider')
  })

  it('rejects roster add when the current roster is already at the maximum', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    initialChat.ensemble!.bossmanAutoApprovals = {
      enabled: true,
      mode: 'permission_preset_once',
      confirmedAt: '2026-05-24T00:00:00.000Z'
    }
    initialChat.ensemble!.participants = Array.from(
      { length: MAX_ENSEMBLE_PARTICIPANTS },
      (_, index) => ({
        id: index === 0 ? 'claude' : `worker-${index}`,
        provider: index === 0 ? 'claude' : 'codex',
        enabled: true,
        role: index === 0 ? 'Boss' : `Worker ${index}`,
        instructions: index === 0 ? 'Manage.' : 'Work.',
        order: index + 1,
        permissionPresetId: index === 0 ? 'workspace_write' : 'read_only'
      })
    )
    const harness = makeHarness({
      initialChat,
      probeParticipant: async () => ({ reachable: true })
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = await harness.orchestrator.rosterEditForRun(harness.dispatched[0].appRunId, {
      action: 'add_participant',
      participant: { provider: 'kimi' }
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('roster_max')
    expect(harness.chat.ensemble!.participants).toHaveLength(MAX_ENSEMBLE_PARTICIPANTS)
  })

  it('rejects skip with an unknown target participant (stale_target)', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const result = await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'skip_participant',
      targetParticipantId: 'ghost'
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('stale_target')
  })

  it('rejects skip with an unknown target run (stale_target_run)', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const result = await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'skip_participant',
      targetRunId: 'no-such-run'
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('stale_target_run')
  })

  it('skips the active participant: finalises first, then best-effort cancels and advances', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runtime = (
      harness.orchestrator as unknown as {
        roundsByChatId: Map<string, { continuationPass: number }>
      }
    ).roundsByChatId.get('ensemble-chat')!
    runtime.continuationPass = 2
    const result = await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'skip_participant',
      targetRunId: harness.dispatched[0].appRunId,
      targetParticipantId: 'claude',
      reason: 'Re-route to Codex.'
    })
    expect(result.ok).toBe(true)
    // The active run was finalised as skipped...
    const claudeState = harness.chat.ensemble?.activeRound?.participants.find(
      (participant) => participant.participantId === 'claude'
    )
    expect(claudeState?.status).toBe('skipped')
    // ...the provider process was best-effort cancelled...
    expect(harness.cancelRun).toHaveBeenCalled()
    // ...and the orchestrator advanced to the next participant immediately.
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('codex')
  })

  /**
   * S16 — an approved contribution is delivered at its seat's POSITION, not at
   * whatever boundary happens to come next. The external is not a member of the
   * round state machine (EnsembleRoundParticipantState.provider is a required
   * ProviderId and a human has none); what it has is an order that sorts in the
   * same space as the model seats.
   */
  /**
   * An OPTIONAL dep that production never passes is indistinguishable from a
   * working feature at the unit level: every test here injects both, so they
   * all pass while the shipped app returns early and delivers nothing.
   *
   * That is exactly what happened — `deliverExternalSeatTurns` landed in
   * b56d073eb and was never reachable in production until this assertion
   * existed. A source-region check on the construction site is the only thing
   * that can see the difference.
   */
  it('is actually wired at the production construction site', () => {
    const indexSource = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
    const start = indexSource.indexOf('new EnsembleOrchestrator({')
    expect(start).toBeGreaterThanOrEqual(0)
    let depth = 0
    let end = start
    for (let i = indexSource.indexOf('{', start); i < indexSource.length; i += 1) {
      if (indexSource[i] === '{') depth += 1
      else if (indexSource[i] === '}') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    const construction = indexSource.slice(start, end)
    expect(construction).toContain('resolveExternalSeats:')
    expect(construction).toContain('externalContributionQueue')
  })

  describe('external seat turns', () => {
    function queueStub(entries: Array<Record<string, unknown>>) {
      const materialised: string[] = []
      return {
        materialised,
        listAwaitingMaterialisation: () =>
          entries.filter((e) => !materialised.includes(e.entryId as string)),
        markMaterialised: (entryId: string) => {
          materialised.push(entryId)
          return null
        }
      }
    }

    function entry(overrides: Record<string, unknown> = {}) {
      return {
        entryId: 'entry-1',
        chatId: 'ensemble-chat',
        shareId: 'share-1',
        collaboratorId: 'collab-1',
        displayName: 'Alex',
        clientMessageId: 'client-1',
        sequence: 1,
        body: 'please check the migration',
        bodyBytes: 24,
        state: 'approved',
        materialised: false,
        enqueuedAt: 1,
        expiresAt: 2,
        messageId: 'external-row-1',
        ...overrides
      }
    }

    it('delivers at the seat’s position, before the seat it sorts ahead of', async () => {
      const queue = queueStub([entry()])
      const initialChat = makeChat()
      initialChat.ensemble!.bossmanParticipantId = 'claude'
      const harness = makeHarness({
        initialChat,
        externalContributionQueue: queue as never,
        // Seated at 1: ahead of codex (order 2), behind claude (order 1) on the
        // model-wins-a-dead-heat rule.
        resolveExternalSeats: () => [
          { shareId: 'share-1', collaboratorId: 'collab-1', displayName: 'Alex', seatOrder: 1 }
        ]
      })
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Plan and execute.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched.length).toBeGreaterThan(0))
      await vi.waitFor(() =>
        expect(harness.chat.messages.some((m) => m.metadata?.kind === 'externalSeatTurn')).toBe(
          true
        )
      )

      const row = harness.chat.messages.find((m) => m.metadata?.kind === 'externalSeatTurn')!
      expect(row.role).toBe('system')
      expect(row.metadata?.sourceTrust).toBe('external_untrusted')
      expect(row.metadata?.displayParticipantLabel).toBe('Alex / External')
      // Reached in position, so NOT flagged as arriving out of order.
      expect(row.metadata?.outOfPosition).toBeUndefined()
      expect(queue.materialised).toEqual(['entry-1'])
    })

    it('never appends a second row for a contribution already in the transcript', async () => {
      // The crash-recovery case the code exists to handle. The chat store
      // fsyncs and rethrows; the queue's persist neither fsyncs nor rethrows,
      // so the only asymmetric outcome is row-on-disk with the queue still
      // saying materialised:false. On relaunch the entry comes back for
      // delivery — and without the id check a second row lands under the SAME
      // id, scrambling the id-keyed transcript, showing the message twice to
      // every collaborator, and burning two slots of the per-prompt budget.
      const queue = queueStub([entry()])
      const initialChat = makeChat()
      initialChat.ensemble!.bossmanParticipantId = 'claude'
      // Stand in for "the row was written, the mark was lost".
      initialChat.messages = [
        {
          id: 'external-row-1',
          role: 'system',
          content: 'please check the migration',
          timestamp: '2026-07-31T00:00:00.000Z',
          metadata: { kind: 'externalSeatTurn' }
        } as never
      ]
      const harness = makeHarness({
        initialChat,
        externalContributionQueue: queue as never,
        resolveExternalSeats: () => [
          { shareId: 'share-1', collaboratorId: 'collab-1', displayName: 'Alex', seatOrder: 1 }
        ]
      })
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Plan and execute.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched.length).toBeGreaterThan(0))
      await vi.waitFor(() => expect(queue.materialised).toEqual(['entry-1']))

      // Exactly one row with that id, and the queue is reconciled rather than
      // left to retry the same entry at every future boundary.
      const rows = harness.chat.messages.filter((m) => m.id === 'external-row-1')
      expect(rows).toHaveLength(1)
    })

    it('does nothing at all when the chat has no externals', async () => {
      // The overwhelmingly common case: both deps absent, behaviour identical
      // to before S16.
      const initialChat = makeChat()
      initialChat.ensemble!.bossmanParticipantId = 'claude'
      const harness = makeHarness({ initialChat })
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Plan and execute.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched.length).toBeGreaterThan(0))
      expect(harness.chat.messages.some((m) => m.metadata?.kind === 'externalSeatTurn')).toBe(false)
    })

    it('never delivers for a muted seat', async () => {
      // Muting holds the position but declines the turn — deliberately unlike
      // revocation, which yields no seat at all.
      const queue = queueStub([entry()])
      const initialChat = makeChat()
      initialChat.ensemble!.bossmanParticipantId = 'claude'
      const harness = makeHarness({
        initialChat,
        externalContributionQueue: queue as never,
        resolveExternalSeats: () => [
          {
            shareId: 'share-1',
            collaboratorId: 'collab-1',
            displayName: 'Alex',
            seatOrder: 1,
            enabled: false
          }
        ]
      })
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Plan and execute.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched.length).toBeGreaterThan(0))
      expect(harness.chat.messages.some((m) => m.metadata?.kind === 'externalSeatTurn')).toBe(false)
      expect(queue.materialised).toEqual([])
    })

    it('never delivers for a seat that no longer exists', async () => {
      // Approved, then the person was revoked. Trust was withdrawn after the
      // approval, so the approval does not survive it.
      const queue = queueStub([entry()])
      const initialChat = makeChat()
      initialChat.ensemble!.bossmanParticipantId = 'claude'
      const harness = makeHarness({
        initialChat,
        externalContributionQueue: queue as never,
        resolveExternalSeats: () => []
      })
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Plan and execute.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched.length).toBeGreaterThan(0))
      expect(harness.chat.messages.some((m) => m.metadata?.kind === 'externalSeatTurn')).toBe(false)
    })
  })

  it('replaces a pending participant after a successful health check', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    const harness = makeHarness({
      initialChat,
      probeParticipant: async () => ({ reachable: true })
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const result = await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'replace_participant',
      targetParticipantId: 'codex',
      replacement: { provider: 'kimi', role: 'Pinch Hitter' }
    })
    expect(result.ok).toBe(true)
    expect(result.participantId).toMatch(/^bossman-replacement-/)
    const roster = harness.chat.ensemble!.participants
    expect(roster.some((participant) => participant.id === 'codex')).toBe(false)
    expect(roster.some((p) => p.provider === 'kimi' && p.role === 'Pinch Hitter')).toBe(true)
    expect(roster).toHaveLength(2)
  })

  /**
   * A replacement is a model/provider swap on ONE seat. It must never move that
   * seat's permissions — not wider, not narrower — because
   * `ensemble_roster_edit` → edit_participant is the audited door for that, and
   * a second door makes the invariant unreadable.
   *
   * The escalation this guards against was live: the old ceiling check rejected
   * only full_access and custom, so a Boss could replace a read_only reviewer
   * with a `default` one and hand it write access in the same call.
   */
  async function replaceSeatWithPermissions(
    seat: Partial<EnsembleParticipant>,
    replacement: Partial<EnsembleParticipant> & { provider: ProviderId }
  ) {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    const target = initialChat.ensemble!.participants.find(
      (participant) => participant.id === 'codex'
    )!
    Object.assign(target, seat)
    const harness = makeHarness({
      initialChat,
      probeParticipant: async () => ({ reachable: true })
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const result = await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'replace_participant',
      targetParticipantId: 'codex',
      replacement
    })
    return {
      result,
      harness,
      seated: harness.chat.ensemble!.participants.find(
        (participant) => participant.id === result.participantId
      )
    }
  }

  for (const permissionPresetId of ['read_only', 'plan', 'default'] as const) {
    it(`inherits the target seat's ${permissionPresetId} preset when none is requested`, async () => {
      const { result, seated } = await replaceSeatWithPermissions(
        { permissionPresetId },
        { provider: 'kimi' }
      )
      expect(result.ok).toBe(true)
      expect(seated?.permissionPresetId).toBe(permissionPresetId)
    })

    it(`accepts an explicit restatement of the seat's own ${permissionPresetId} preset`, async () => {
      // The schema advertises the field, so a model that faithfully echoes the
      // current preset must not be punished for it.
      const { result, seated } = await replaceSeatWithPermissions(
        { permissionPresetId },
        { provider: 'kimi', permissionPresetId }
      )
      expect(result.ok).toBe(true)
      expect(seated?.permissionPresetId).toBe(permissionPresetId)
    })
  }

  it('refuses to WIDEN a read_only seat to default through a replacement', async () => {
    const { result, harness } = await replaceSeatWithPermissions(
      { permissionPresetId: 'read_only' },
      { provider: 'kimi', permissionPresetId: 'default' }
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('permission_ceiling')
    // The seat survives at its original posture and no replacement was seated.
    const roster = harness.chat.ensemble!.participants
    expect(roster.find((participant) => participant.id === 'codex')?.permissionPresetId).toBe(
      'read_only'
    )
    expect(roster.some((participant) => participant.id.startsWith('bossman-replacement'))).toBe(
      false
    )
  })

  it('refuses to NARROW a seat through a replacement either', async () => {
    // Safe in isolation, refused on purpose: permitting it would make this path
    // a permission-deciding path, and then "a swap never moves permissions"
    // stops being checkable by reading one function.
    const { result } = await replaceSeatWithPermissions(
      { permissionPresetId: 'default' },
      { provider: 'kimi', permissionPresetId: 'read_only' }
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('permission_ceiling')
  })

  it('refuses a preset on a seat that carries none, rather than inventing one', async () => {
    const { result } = await replaceSeatWithPermissions(
      { permissionPresetId: undefined },
      { provider: 'kimi', permissionPresetId: 'default' }
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('permission_ceiling')
  })

  it("carries the target seat's permissionOverrides onto the replacement", async () => {
    // Dropping a NARROWING override widens the seat by omission just as surely
    // as a wider preset does.
    const permissionOverrides: EnsembleParticipant['permissionOverrides'] = {
      approvalMode: 'never',
      networkAccess: 'deny'
    }
    const { result, seated } = await replaceSeatWithPermissions(
      { permissionPresetId: 'read_only', permissionOverrides },
      { provider: 'kimi' }
    )
    expect(result.ok).toBe(true)
    expect(seated?.permissionOverrides).toEqual(permissionOverrides)
  })

  it('refuses a replacement that supplies its own permissionOverrides', async () => {
    // Not in the tool schema, but the input type is a Partial<EnsembleParticipant>
    // and JSON Schema admits unlisted properties, so a caller can send it.
    const { result } = await replaceSeatWithPermissions(
      { permissionPresetId: 'read_only' },
      { provider: 'kimi', permissionOverrides: { approvalMode: 'always' } }
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('permission_ceiling')
  })

  it('rejects a replacement when the provider health check fails (replacement_unreachable)', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    const harness = makeHarness({
      initialChat,
      // Reachable for the round's own pre-flight dispatch, unreachable for the
      // replacement candidate (kimi).
      probeParticipant: async (participant) => ({ reachable: participant.provider !== 'kimi' })
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const result = await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'replace_participant',
      targetParticipantId: 'codex',
      replacement: { provider: 'kimi' }
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('replacement_unreachable')
    // Roster untouched.
    expect(harness.chat.ensemble!.participants.some((p) => p.id === 'codex')).toBe(true)
  })

  for (const permissionPresetId of ['workspace_write', 'full_access', 'custom'] as const) {
    it(`rejects a replacement requesting ${permissionPresetId} (permission_ceiling)`, async () => {
      const initialChat = makeChat()
      initialChat.ensemble!.bossmanParticipantId = 'claude'
      const harness = makeHarness({
        initialChat,
        probeParticipant: async () => ({ reachable: true })
      })
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Plan and execute.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
      const result = await harness.orchestrator.bossmanControlForRun(
        harness.dispatched[0].appRunId,
        {
          action: 'replace_participant',
          targetParticipantId: 'codex',
          replacement: { provider: 'kimi', permissionPresetId }
        }
      )
      expect(result.ok).toBe(false)
      expect(result.error).toBe('permission_ceiling')
      expect(
        harness.chat.ensemble!.participants.some((participant) => participant.id === 'codex')
      ).toBe(true)
      expect(
        harness.chat.ensemble!.participants.some((participant) =>
          participant.id.startsWith('bossman-replacement')
        )
      ).toBe(false)
    })
  }

  it('rejects a replacement that would grow the round beyond its baseline (baseline_exceeded)', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    const harness: ReturnType<typeof makeHarness> = makeHarness({
      initialChat,
      probeParticipant: async (participant) => {
        // Simulate a concurrent roster add (2 -> 3) landing WHILE the
        // replacement health check is in flight. Baseline was 2.
        if (participant.id.startsWith('bossman-replacement')) {
          harness.chat.ensemble!.participants.push({
            id: 'late-add',
            provider: 'grok',
            enabled: true,
            role: 'Late',
            instructions: '',
            order: 3
          })
        }
        return { reachable: true }
      }
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const result = await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'replace_participant',
      targetParticipantId: 'codex',
      replacement: { provider: 'kimi' }
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('baseline_exceeded')
    // The original target is untouched — the round was not mutated.
    expect(harness.chat.ensemble!.participants.some((p) => p.id === 'codex')).toBe(true)
  })

  it('enforces the reorder cooldown (once per two completed rounds)', async () => {
    const initialChat = makeChat()
    initialChat.ensemble!.bossmanParticipantId = 'claude'
    const harness = makeHarness({ initialChat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const first = await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'reorder_remaining',
      participantIds: ['codex']
    })
    expect(first.ok).toBe(true)
    const second = await harness.orchestrator.bossmanControlForRun(harness.dispatched[0].appRunId, {
      action: 'reorder_remaining',
      participantIds: ['codex']
    })
    expect(second.ok).toBe(false)
    expect(second.error).toBe('reorder_cooldown')
  })

  it('classifies ECONNREFUSED dispatch errors and continues to the next participant', async () => {
    // 1.0.4 — Claude/Explorer's introspective feedback after a real
    // production round where ensemble_yield hit ECONNREFUSED on the
    // Gemini MCP socket and bubbled as a raw socket error. The
    // orchestrator already self-heals (round falls through to next
    // participant in `remaining`), this test asserts the diagnostic
    // upgrade: a structured "⚠ <Provider> / <Role> unreachable
    // (<code>). Skipping for this round..." system note instead of
    // the previous generic 'Dispatch failed.' line.
    //
    // The harness's dispatch fn throws an ECONNREFUSED error on the
    // FIRST call (Claude / Reviewer), then succeeds on subsequent
    // calls. We assert (a) the round continues to Codex / Worker
    // without halting, and (b) the transcript carries the typed
    // failure note.
    let callCount = 0
    const harness = makeHarness({
      dispatch: async () => {
        callCount += 1
        if (callCount === 1) {
          const err = new Error('connect ECONNREFUSED /tmp/taskwraith-claude.sock') as Error & {
            code?: string
          }
          err.code = 'ECONNREFUSED'
          throw err
        }
        return { dispatched: true, appRunId: '' }
      }
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Implement and review.',
      event: { sender: {} as Electron.WebContents }
    })
    // Round should reach the second participant despite the first
    // throwing — the dispatch was called twice (once for the failed
    // Claude, once for the succeeding Codex).
    await vi.waitFor(() => expect(callCount).toBeGreaterThanOrEqual(2))

    // The structured failure note lives in chat.messages as a
    // role:'system' message with the `ensembleRoundStatus` metadata
    // kind. The content carries the typed reason: provider + role +
    // posix code + recovery hint.
    const failureNote = harness.chat.messages.find(
      (message) =>
        message.role === 'system' &&
        message.metadata?.kind === 'ensembleRoundStatus' &&
        typeof message.content === 'string' &&
        message.content.includes('ECONNREFUSED')
    )
    expect(failureNote?.content).toContain('Claude / Reviewer')
    expect(failureNote?.content).toContain('unreachable')
    expect(failureNote?.content).toContain('ECONNREFUSED')
    expect(failureNote?.content).toContain('Skipping for this round')
  })

  it('surfaces a preflight refusal reason instead of a bare "dispatch failed"', async () => {
    // A preflight refusal returns `dispatched: false` WITHOUT throwing, so the
    // classifier never sees an error. RunCoordinator sends the reason to the
    // sender (which is why a solo run shows it) but used to drop it from the
    // result — leaving the orchestrator to emit the `unknown` variant, "dispatch
    // failed. Skipping for this round", with no cause.
    //
    // That is how a plain "Codex sign-in is required" became undiagnosable
    // inside a round, and why a panel seat invented a cause rather than
    // reporting one. The seat must now say WHY it was skipped.
    let callCount = 0
    const harness = makeHarness({
      dispatch: async () => {
        callCount += 1
        if (callCount === 1) {
          return {
            dispatched: false,
            appRunId: '',
            failureMessage: 'TaskWraith Codex sign-in is required.'
          }
        }
        return { dispatched: true, appRunId: '' }
      }
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Implement and review.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(callCount).toBeGreaterThanOrEqual(2))

    const note = harness.chat.messages.find(
      (message) =>
        message.role === 'system' &&
        message.metadata?.kind === 'ensembleRoundStatus' &&
        typeof message.content === 'string' &&
        message.content.includes('dispatch failed')
    )
    expect(note?.content).toContain('sign-in is required')
    expect(note?.content).toContain('Skipping for this round')
    // The whole point: NOT the reasonless variant.
    expect(note?.content).not.toMatch(/dispatch failed\.\s*Skipping/)
  })

  it('stays quiet when a refusal carries no reason (a cancellation is not a failure)', async () => {
    // `failureMessage` is deliberately absent for a lifecycle cancellation, so
    // the note must fall back to the reasonless variant rather than inventing
    // or borrowing a cause from elsewhere.
    let callCount = 0
    const harness = makeHarness({
      dispatch: async () => {
        callCount += 1
        if (callCount === 1) return { dispatched: false, appRunId: '' }
        return { dispatched: true, appRunId: '' }
      }
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Implement and review.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(callCount).toBeGreaterThanOrEqual(2))

    const note = harness.chat.messages.find(
      (message) =>
        message.role === 'system' &&
        message.metadata?.kind === 'ensembleRoundStatus' &&
        typeof message.content === 'string' &&
        message.content.includes('dispatch failed')
    )
    expect(note?.content).toMatch(/dispatch failed\.\s*Skipping/)
  })

  it('accepts a ParticipantUnreachableError thrown by an adapter and classifies it as unreachable', async () => {
    // 1.0.4 — adapter sites that already know the failure is socket-
    // level can throw the typed `ParticipantUnreachableError` instead
    // of preserving the raw Node ErrnoException shape. The classifier
    // recognises it via instanceof and the orchestrator emits the
    // same structured "unreachable" note as if a raw ECONNREFUSED
    // had bubbled. This proves the typed-error fast path works end-
    // to-end.
    const { ParticipantUnreachableError } = await import('../EnsembleErrors')
    let callCount = 0
    const harness = makeHarness({
      dispatch: async () => {
        callCount += 1
        if (callCount === 1) {
          throw new ParticipantUnreachableError('claude', 'claude', 'ENOENT')
        }
        return { dispatched: true, appRunId: '' }
      }
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Implement and review.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(callCount).toBeGreaterThanOrEqual(2))
    const failureNote = harness.chat.messages.find(
      (message) =>
        message.role === 'system' &&
        message.metadata?.kind === 'ensembleRoundStatus' &&
        typeof message.content === 'string' &&
        message.content.includes('ENOENT')
    )
    expect(failureNote?.content).toContain('Claude / Reviewer')
    expect(failureNote?.content).toContain('unreachable')
    expect(failureNote?.content).toContain('ENOENT')
  })

  it('routes past an unreachable yield target and emits a yield-specific transcript note', async () => {
    // 1.0.4 — the original production reproducer: Claude finishes its
    // turn, calls ensemble_yield(target='gemini'), but the Gemini MCP
    // socket is down (ECONNREFUSED). The orchestrator should:
    //   (a) emit a transcript note: "⚠ Yield target Gemini / Researcher
    //       unreachable (ECONNREFUSED). Routing to next participant in
    //       rotation (Codex / Worker)."
    //   (b) continue with Codex / Worker (the next-in-default-rotation)
    //       instead of hanging on the dead socket.
    // The generic "unreachable. Skipping for this round" note is
    // suppressed in this case — the yield-specific note already
    // carries the failure info plus the routing decision.
    const harness = makeHarness({
      dispatch: async (payload) => {
        if (payload.provider === 'gemini') {
          const err = new Error('connect ECONNREFUSED /tmp/taskwraith-gemini.sock') as Error & {
            code?: string
          }
          err.code = 'ECONNREFUSED'
          throw err
        }
        return { dispatched: true, appRunId: payload.appRunId || '' }
      }
    })
    harness.chat.ensemble!.participants = [
      {
        id: 'ensemble-claude',
        provider: 'claude',
        enabled: true,
        role: 'Planner',
        instructions: 'Plan.',
        order: 1,
        permissionPresetId: 'read_only'
      },
      {
        id: 'ensemble-gemini',
        provider: 'gemini',
        enabled: true,
        role: 'Researcher',
        instructions: 'Research.',
        order: 2,
        permissionPresetId: 'read_only'
      },
      {
        id: 'ensemble-codex',
        provider: 'codex',
        enabled: true,
        role: 'Worker',
        instructions: 'Work.',
        order: 3,
        permissionPresetId: 'workspace_write'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and hand off.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].provider).toBe('claude')

    // Claude yields to gemini via the orchestrator's markYielded path
    // (mirroring `ensemble_yield(target='gemini')`).
    harness.orchestrator.markYielded(harness.dispatched[0].appRunId!, 'Passing to Gemini', 'gemini')

    // Gemini's dispatch throws ECONNREFUSED → orchestrator routes
    // past it to Codex (next-in-default-rotation).
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[1].provider).toBe('gemini')
    expect(harness.dispatched[2].provider).toBe('codex')

    // Yield-specific transcript note should be present.
    const yieldNote = harness.chat.messages.find(
      (message) =>
        message.role === 'system' &&
        message.metadata?.kind === 'ensembleRoundStatus' &&
        typeof message.content === 'string' &&
        message.content.includes('Yield target')
    )
    expect(yieldNote?.content).toContain('Gemini / Researcher')
    expect(yieldNote?.content).toContain('ECONNREFUSED')
    expect(yieldNote?.content).toContain('Routing to next participant in rotation')
    expect(yieldNote?.content).toContain('Codex / Worker')

    // The generic "Skipping for this round" note should NOT have
    // been emitted for Gemini in this case — the yield-specific note
    // supersedes it. (The per-participant run's finalize reason is
    // still set to the generic note for chip-strip consistency, but
    // that lives on the run record, not the round-status transcript.)
    const skipNote = harness.chat.messages.find(
      (message) =>
        message.role === 'system' &&
        message.metadata?.kind === 'ensembleRoundStatus' &&
        typeof message.content === 'string' &&
        message.content.includes('Gemini / Researcher') &&
        message.content.includes('Skipping for this round')
    )
    expect(skipNote).toBeUndefined()
  })

  it('emits an all-unreachable user-fallback note when every dispatch fails ECONNREFUSED', async () => {
    // 1.0.4 — when none of the participants' sockets came up, the
    // round ends with no speaker. The orchestrator emits a final
    // "No reachable participants left. Returning to user — re-enable
    // participants from the chip strip and resume." system note so
    // the user has a single overall verdict instead of just back-to-
    // back skip notes.
    const harness = makeHarness({
      dispatch: async () => {
        const err = new Error('connect ECONNREFUSED') as Error & {
          code?: string
        }
        err.code = 'ECONNREFUSED'
        throw err
      }
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Anyone home?',
      event: { sender: {} as Electron.WebContents }
    })
    // Both participants attempted (Claude + Codex from the default
    // fixture), both failing — wait until both dispatches landed.
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

    const fallbackNote = harness.chat.messages.find(
      (message) =>
        message.role === 'system' &&
        message.metadata?.kind === 'ensembleRoundStatus' &&
        typeof message.content === 'string' &&
        message.content.includes('No reachable participants left')
    )
    expect(fallbackNote?.content).toContain('Returning to user')
    expect(fallbackNote?.content).toContain('chip strip')
  })

  it('does not emit the all-unreachable fallback when at least one participant succeeds', async () => {
    // Sanity check on the gating logic. If even one participant
    // produced output (or failed for a non-unreachable reason), the
    // fallback note must NOT fire — the user has either the answer
    // or a per-participant note with actionable info.
    let callCount = 0
    const harness = makeHarness({
      dispatch: async (payload) => {
        callCount += 1
        if (callCount === 1) {
          const err = new Error('connect ECONNREFUSED') as Error & {
            code?: string
          }
          err.code = 'ECONNREFUSED'
          throw err
        }
        return { dispatched: true, appRunId: payload.appRunId || '' }
      }
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Try both.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    // Finish Codex so the round closes cleanly.
    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 5 } }
    )
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    const fallbackNote = harness.chat.messages.find(
      (message) =>
        message.role === 'system' &&
        typeof message.content === 'string' &&
        message.content.includes('No reachable participants left')
    )
    expect(fallbackNote).toBeUndefined()
  })

  it('1.0.4-AD: skips a participant whose pre-flight probe reports unreachable', async () => {
    // The orchestrator now runs `probeParticipant(participant)` BEFORE
    // dispatch in `runRound`. When the probe returns
    // `reachable: false`, we expect:
    //   1. dispatch NEVER fires for that participant (we don't burn a
    //      runId on a dead provider)
    //   2. the round advances to the next participant in `remaining`
    //   3. the active round's per-participant state flips to
    //      `'unreachable'` with `lastFailureReason` populated from the
    //      probe's `reason`
    //   4. a `formatProbeFailureNote`-shaped transcript line lands as
    //      a `role: 'system'` message with the `ensembleRoundStatus`
    //      metadata kind (matches the existing dispatch-failure note
    //      shape so the renderer's status-card handling carries over)
    //   5. the `probeParticipant` dep gets called once per participant
    //      (one call for the unreachable one, one call for the
    //      survivor)
    const probeParticipant = async (
      participant: EnsembleParticipant
    ): Promise<ParticipantProbeResult> => {
      if (participant.id === 'claude') {
        return {
          reachable: false,
          reason: 'Claude CLI binary not found on PATH',
          underlyingCode: 'ENOENT'
        }
      }
      return { reachable: true }
    }
    const harness = makeHarness({ probeParticipant })

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Probe-skip path.',
      event: { sender: {} as Electron.WebContents }
    })

    // Only Codex (the survivor) is dispatched — Claude is skipped at
    // round start by the probe rather than burning a runId on dispatch.
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].provider).toBe('codex')

    // Probe was called for both participants in turn order — Claude
    // first (rejected), then Codex (accepted).
    expect(harness.probeParticipant).toHaveBeenCalledTimes(2)
    const probedIds = harness.probeParticipant!.mock.calls.map(([p]: [EnsembleParticipant]) => p.id)
    expect(probedIds).toEqual(['claude', 'codex'])

    // Active round's Claude state should be `unreachable` with the
    // probe's reason preserved on `lastFailureReason`. Codex should
    // either be running or already completed depending on timing —
    // we don't assert its state here, just Claude's.
    const claudeState = harness.chat.ensemble?.activeRound?.participants.find(
      (p) => p.participantId === 'claude'
    )
    expect(claudeState?.status).toBe('unreachable')
    expect(claudeState?.lastFailureReason).toBe('Claude CLI binary not found on PATH')

    // Transcript carries one consolidated participant-health card.
    // 1.0.5-EW29: emission kind is now `ensembleParticipantHealth`
    // (was `ensembleRoundStatus` pre-EW29) so the renderer can
    // route to a structured chip-strip card instead of a plain
    // system-message text block. The text-form fallback still
    // lives on `content` for log / export / debug consumers.
    const probeNote = harness.chat.messages.find(
      (message) =>
        message.role === 'system' &&
        message.metadata?.kind === 'ensembleParticipantHealth' &&
        typeof message.content === 'string' &&
        message.content.startsWith('[participant-health]') &&
        message.content.includes('Claude / Reviewer')
    )
    expect(probeNote?.content).toContain('Claude CLI binary not found on PATH')
    expect(probeNote?.content).toContain('(ENOENT)')
    expect(probeNote?.content).toContain('Codex / Worker: ok')
    // 1.0.5-EW29 — structured entries available for renderer.
    const entries = (probeNote?.metadata as { entries?: Array<unknown> })?.entries
    expect(Array.isArray(entries)).toBe(true)
    expect(entries?.length).toBe(2)
  })

  it('1.0.4-AD: treats a probe that throws as unreachable rather than crashing the round', async () => {
    // Defensive path. A probe implementation that throws shouldn't
    // take the whole round down — it's a reachability signal in its
    // own right. The orchestrator's wrapper catches and downgrades
    // the throw into a `reachable: false` result. The round must
    // still advance to the next participant.
    const probeParticipant = async (
      participant: EnsembleParticipant
    ): Promise<ParticipantProbeResult> => {
      if (participant.id === 'claude') {
        const err = new Error('boom: probe blew up') as Error & { code?: string }
        err.code = 'EPROBE_FAIL'
        throw err
      }
      return { reachable: true }
    }
    const harness = makeHarness({ probeParticipant })

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Probe-throws path.',
      event: { sender: {} as Electron.WebContents }
    })

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].provider).toBe('codex')

    const claudeState = harness.chat.ensemble?.activeRound?.participants.find(
      (p) => p.participantId === 'claude'
    )
    expect(claudeState?.status).toBe('unreachable')
    expect(claudeState?.lastFailureReason).toBe('boom: probe blew up')
  })

  it('1.0.4-AD: when every participant probe rejects, no dispatch fires and the all-unreachable note appears', async () => {
    // Round-end fallback gating still works for the probe path —
    // `dispatchAttempts` increments on every probe rejection, and
    // when every attempt counted as `unreachable`, the orchestrator
    // emits the all-unreachable note alongside the per-participant
    // probe notes.
    const probeParticipant = async (): Promise<ParticipantProbeResult> => ({
      reachable: false,
      reason: 'socket file missing',
      underlyingCode: 'ENOENT'
    })
    const harness = makeHarness({ probeParticipant })

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Probe-everyone-dead path.',
      event: { sender: {} as Electron.WebContents }
    })

    // Wait for the round to settle (both participants probed and
    // marked unreachable, no dispatches fired).
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    expect(harness.dispatched).toHaveLength(0)

    const fallbackNote = harness.chat.messages.find(
      (message) =>
        message.role === 'system' &&
        message.metadata?.kind === 'ensembleRoundStatus' &&
        typeof message.content === 'string' &&
        message.content.includes('No reachable participants left')
    )
    expect(fallbackNote).toBeDefined()
    // One consolidated probe header should list both participants.
    // 1.0.5-EW29: kind is now `ensembleParticipantHealth`.
    const probeNotes = harness.chat.messages.filter(
      (message) =>
        message.role === 'system' &&
        message.metadata?.kind === 'ensembleParticipantHealth' &&
        typeof message.content === 'string' &&
        message.content.startsWith('[participant-health]\n')
    )
    expect(probeNotes).toHaveLength(1)
    expect(probeNotes[0].content).toContain('Claude / Reviewer: unreachable')
    expect(probeNotes[0].content).toContain('Codex / Worker: unreachable')
    // 1.0.5-EW29 — structured entries on the metadata.
    const entries = (
      probeNotes[0].metadata as {
        entries?: Array<{ status: string; provider: string; role: string }>
      }
    )?.entries
    expect(entries?.every((e) => e.status === 'unreachable')).toBe(true)
    expect(entries?.length).toBe(2)
  })

  it('treats @user as informational text instead of closing the round', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Start the work.',
      event: { sender: {} as Electron.WebContents }
    })
    // First participant dispatched (Claude / Reviewer, order 1).
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].provider).toBe('claude')

    // Claude addresses the user inline. This should NOT close the
    // round before Codex (order 2) gets a turn.
    harness.orchestrator.handleProviderOutput(
      'claude',
      {
        appRunId: harness.dispatched[0].appRunId,
        appChatId: 'ensemble-chat'
      },
      {
        type: 'content',
        text: 'Quick scope: we should X. @user — does this match your intent?'
      }
    )
    harness.orchestrator.handleProviderOutput(
      'claude',
      {
        appRunId: harness.dispatched[0].appRunId,
        appChatId: 'ensemble-chat'
      },
      {
        type: 'result',
        status: 'success',
        stats: { total_tokens: 10 }
      }
    )

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('codex')
    expect(harness.chat.messages.map((message) => message.content).join('\n')).not.toContain(
      'handed control back to the user'
    )
  })

  it('closes the round when a speaker explicitly yields to user', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.bossmanParticipantId = 'claude'
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Start the work.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].provider).toBe('claude')

    expectYielded(
      harness.orchestrator.markYielded(
        harness.dispatched[0].appRunId!,
        'Need the user to choose.',
        'user'
      )
    )

    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    expect(harness.dispatched).toHaveLength(1)
    const closeNote = harness.chat.messages.find(
      (message) =>
        message.role === 'system' &&
        message.metadata?.kind === 'ensembleRoundStatus' &&
        typeof message.content === 'string' &&
        message.content.includes('yielded to the user')
    )
    expect(closeNote?.content).toContain('yielded to the user')
    expect(closeNote?.content).toContain('Round closed')
  })

  it('keeps an explicit yield to user terminal in Continuous mode', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.bossmanParticipantId = 'claude'
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.maxContinuationHops = 24
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Start the continuous work.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    // Continuous Boss with remaining seats must resolve the selectionRequired
    // checkpoint before a yield-to-user can close the round.
    expect(
      harness.orchestrator.markYielded(
        harness.dispatched[0].appRunId!,
        'Return control to the user.',
        'user'
      )
    ).toEqual({
      kind: 'authority_routing_decision_required',
      pass: 1,
      requirement: 'later_pass_selection'
    })
    const preserve = await harness.orchestrator.bossmanControlForRun(
      harness.dispatched[0].appRunId,
      {
        action: 'skip_intervention'
      }
    )
    expect(preserve).toMatchObject({ ok: true, action: 'skip_intervention' })
    expectYielded(
      harness.orchestrator.markYielded(
        harness.dispatched[0].appRunId!,
        'Return control to the user.',
        'user'
      )
    )

    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    expect(harness.dispatched).toHaveLength(1)
    expect(harness.chat.ensemble?.activeRound?.continuationHops).toBe(0)
    expect(
      harness.chat.messages.some((message) => message.content.includes('auto-continuing for pass'))
    ).toBe(false)
  })

  describe('yield-routing contract v2 regressions', () => {
    it('A: lets a non-authority Worker yield to user without authority_precedence', async () => {
      const harness = makeHarness()
      harness.chat.ensemble!.bossmanParticipantId = 'claude'
      harness.chat.ensemble!.orchestrationMode = 'continuous'
      harness.chat.ensemble!.maxContinuationHops = 10
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Boss opens, worker returns control.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
      const bossSelection = await harness.orchestrator.bossmanControlForRun(
        harness.dispatched[0].appRunId,
        {
          action: 'select_participants',
          participantRoles: ['Worker'],
          reason: 'Hand the next turn to Worker.'
        }
      )
      expect(bossSelection).toMatchObject({ ok: true, action: 'select_participants' })
      harness.orchestrator.handleProviderOutput(
        'claude',
        { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success', stats: { total_tokens: 10 } }
      )
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
      expect(harness.dispatched[1].provider).toBe('codex')

      const outcome = harness.orchestrator.markYielded(
        harness.dispatched[1].appRunId!,
        'Need the user to decide.',
        'user'
      )
      expect(outcome).toMatchObject({
        kind: 'yielded',
        routing: { ok: true, action: 'user' }
      })
      await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
      expect(harness.chat.ensemble?.activeRound?.continuationHops).toBe(0)
      expect(
        harness.chat.messages.some((message) =>
          (message.content || '').includes('authority_precedence')
        )
      ).toBe(false)
    })

    it('C: rejects yield-to-user from a detached fan-out lane with fanout_lane_ignored', async () => {
      const harness = makeFanoutRaceHarness()
      await startUnresolvedReviewerFanout(harness)

      const outcome = harness.orchestrator.markYielded(
        harness.dispatched[1].appRunId!,
        'Need the user.',
        'user'
      )
      expect(outcome).toMatchObject({
        kind: 'yielded',
        routing: { ok: false, reason: 'fanout_lane_ignored', target: 'user' }
      })
      const runtime = (
        harness.orchestrator as unknown as {
          roundsByChatId: Map<
            string,
            { yieldRouting?: { kind: string }; returnedControlToUser?: boolean }
          >
        }
      ).roundsByChatId.get('ensemble-chat')
      expect(runtime?.yieldRouting?.kind).toBe('rejected')
      expect(runtime?.returnedControlToUser).not.toBe(true)
    })

    it('D: rejects continuous re-summon at markYielded when hop budget is exhausted', async () => {
      const initialChat = makeChat()
      initialChat.ensemble!.orchestrationMode = 'continuous'
      initialChat.ensemble!.bossmanParticipantId = 'claude'
      initialChat.activeGoal = { ...buildActiveGoal('goal-x'), status: 'completed' }
      const harness = makeHarness({ initialChat })
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Plan and execute.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

      expectYielded(
        harness.orchestrator.markYielded(
          harness.dispatched[0].appRunId!,
          'Worker should take this.',
          'Worker'
        )
      )
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
      harness.orchestrator.handleProviderOutput(
        'codex',
        { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
        { type: 'content', text: 'Worker answer.' }
      )
      harness.orchestrator.handleProviderOutput(
        'codex',
        { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
      expect(harness.dispatched[2].provider).toBe('claude')

      const runtime = (
        harness.orchestrator as unknown as {
          roundsByChatId: Map<
            string,
            {
              continuationHops: number
              maxContinuationHops: number
              yieldRouting?: { kind: string; action?: string }
            }
          >
        }
      ).roundsByChatId.get('ensemble-chat')
      runtime!.continuationHops = runtime!.maxContinuationHops

      const outcome = harness.orchestrator.markYielded(
        harness.dispatched[2].appRunId!,
        'Need worker again.',
        'Worker'
      )
      expect(outcome).toMatchObject({
        kind: 'yielded',
        routing: { ok: false, reason: 'hop_limit', target: 'Worker' }
      })
      expect(runtime?.yieldRouting).toMatchObject({ kind: 'rejected', reason: 'hop_limit' })
      expect(
        harness.chat.messages.some((message) =>
          (message.content || '').includes('Yield target "Worker" was not routed: hop_limit')
        )
      ).toBe(true)
    })

    it('E: reserves exactly one continuation hop for an eligible re-summon yield', async () => {
      const initialChat = makeChat()
      initialChat.ensemble!.orchestrationMode = 'continuous'
      initialChat.ensemble!.bossmanParticipantId = 'claude'
      initialChat.ensemble!.maxContinuationHops = 6
      initialChat.activeGoal = { ...buildActiveGoal('goal-x'), status: 'completed' }
      const harness = makeHarness({ initialChat })
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Plan and execute.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

      expectYielded(
        harness.orchestrator.markYielded(
          harness.dispatched[0].appRunId!,
          'Worker should take this.',
          'Worker'
        )
      )
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
      harness.orchestrator.handleProviderOutput(
        'codex',
        { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
        { type: 'content', text: 'Worker answer.' }
      )
      harness.orchestrator.handleProviderOutput(
        'codex',
        { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
      expect(harness.dispatched[2].provider).toBe('claude')

      const runtime = (
        harness.orchestrator as unknown as {
          roundsByChatId: Map<
            string,
            {
              continuationHops: number
              yieldRouting?: { kind: string; continuationReserved?: boolean }
            }
          >
        }
      ).roundsByChatId.get('ensemble-chat')
      const hopsBefore = runtime!.continuationHops

      const outcome = harness.orchestrator.markYielded(
        harness.dispatched[2].appRunId!,
        'Need worker again.',
        'Worker'
      )
      expect(outcome).toMatchObject({
        kind: 'yielded',
        routing: { ok: true, action: 'resummoned', targetParticipantId: 'codex' }
      })
      expect(runtime!.continuationHops).toBe(hopsBefore + 1)
      expect(runtime?.yieldRouting).toMatchObject({
        kind: 'queue',
        action: 'resummoned',
        continuationReserved: true
      })

      harness.orchestrator.handleProviderOutput(
        'claude',
        { appRunId: harness.dispatched[2].appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(4))
      expect(harness.dispatched[3].provider).toBe('codex')
      expect(runtime!.continuationHops).toBe(hopsBefore + 1)
    })

    it('F: rejects turn-bound re-summon at plan time with blocked_status', async () => {
      const harness = makeHarness()
      harness.chat.ensemble!.bossmanParticipantId = 'codex'
      harness.chat.ensemble!.participants = [
        {
          id: 'claude',
          provider: 'claude',
          enabled: true,
          role: 'Planner',
          instructions: 'Plan.',
          order: 1,
          permissionPresetId: 'read_only'
        },
        {
          id: 'codex',
          provider: 'codex',
          enabled: true,
          role: 'Boss',
          instructions: 'Coordinate.',
          order: 2,
          permissionPresetId: 'workspace_write'
        }
      ]
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Turn-bound handoff.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
      completeDispatchedRun(harness, 0)
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

      const outcome = harness.orchestrator.markYielded(
        harness.dispatched[1].appRunId!,
        'Need the planner again.',
        'Planner'
      )
      expect(outcome).toMatchObject({
        kind: 'yielded',
        routing: { ok: false, reason: 'blocked_status', target: 'Planner' }
      })
    })

    it('G: treats idx=0 and idx>0 authority yields as promoted routes', async () => {
      const harness = makeHarness()
      harness.chat.ensemble!.bossmanParticipantId = 'ensemble-claude'
      harness.chat.ensemble!.participants = [
        {
          id: 'ensemble-claude',
          provider: 'claude',
          enabled: true,
          role: 'Planner',
          instructions: 'Plan.',
          order: 1,
          permissionPresetId: 'read_only'
        },
        {
          id: 'ensemble-gemini',
          provider: 'gemini',
          enabled: true,
          role: 'Researcher',
          instructions: 'Research.',
          order: 2,
          permissionPresetId: 'read_only'
        },
        {
          id: 'ensemble-codex',
          provider: 'codex',
          enabled: true,
          role: 'Worker',
          instructions: 'Work.',
          order: 3,
          permissionPresetId: 'workspace_write'
        }
      ]
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Route explicitly.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

      const idxPositive = harness.orchestrator.markYielded(
        harness.dispatched[0].appRunId!,
        'Plan complete',
        'codex'
      )
      expect(idxPositive).toMatchObject({
        kind: 'yielded',
        routing: { ok: true, action: 'promoted', targetParticipantId: 'ensemble-codex' }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
      expect(harness.dispatched[1].provider).toBe('codex')

      const idxZeroHarness = makeHarness()
      idxZeroHarness.chat.ensemble!.bossmanParticipantId = 'claude'
      idxZeroHarness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Worker is already next.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(idxZeroHarness.dispatched).toHaveLength(1))
      const idxZero = idxZeroHarness.orchestrator.markYielded(
        idxZeroHarness.dispatched[0].appRunId!,
        'Hand straight to Worker.',
        'Worker'
      )
      expect(idxZero).toMatchObject({
        kind: 'yielded',
        routing: { ok: true, action: 'promoted', targetParticipantId: 'codex' }
      })
    })
  })

  describe('yield-to-BG contract regressions', () => {
    function backgroundParticipant(
      overrides: Partial<EnsembleParticipant> = {}
    ): EnsembleParticipant {
      return {
        id: 'background-shell',
        provider: 'codex',
        enabled: true,
        role: 'Shell helper',
        instructions: 'Run scoped background checks and report evidence.',
        order: 3,
        permissionPresetId: 'read_only',
        stageRole: 'background',
        ...overrides
      }
    }

    it('launches a BG lane when an authority seat yields to a unique BG target', async () => {
      const previous = process.env.TASKWRAITH_CONCURRENT_LANES
      process.env.TASKWRAITH_CONCURRENT_LANES = '1'
      try {
        const harness = makeHarness()
        harness.chat.ensemble!.bossmanParticipantId = 'claude'
        harness.chat.ensemble!.participants = [
          {
            id: 'claude',
            provider: 'claude',
            enabled: true,
            role: 'Boss',
            instructions: 'Coordinate.',
            order: 1,
            permissionPresetId: 'read_only'
          },
          {
            id: 'codex',
            provider: 'codex',
            enabled: true,
            role: 'Worker',
            instructions: 'Work.',
            order: 2,
            permissionPresetId: 'workspace_write'
          },
          backgroundParticipant()
        ]
        harness.orchestrator.startRound({
          chatId: 'ensemble-chat',
          prompt: 'Open the round.',
          event: { sender: {} as Electron.WebContents }
        })
        await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
        expect(harness.dispatched[0].provider).toBe('claude')

        const outcome = harness.orchestrator.markYielded(
          harness.dispatched[0].appRunId!,
          'Run the long gate sequence in background.',
          'Shell helper'
        )
        expect(outcome).toMatchObject({
          kind: 'yielded',
          routing: {
            ok: true,
            action: 'background_reserved',
            targetParticipantId: 'background-shell'
          }
        })

        harness.orchestrator.handleProviderOutput(
          'claude',
          { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
          { type: 'result', status: 'success' }
        )
        await vi.waitFor(() => expect(harness.dispatched.length).toBeGreaterThanOrEqual(2))
        const backgroundRun = harness.dispatched.find(
          (payload) => payload.ensembleRun?.participantId === 'background-shell'
        )
        expect(backgroundRun).toBeTruthy()
        expect(backgroundRun?.ensembleRun?.laneId).toBeTruthy()
        expect(backgroundRun?.effectivePermissions?.readOnly).toBe(true)
      } finally {
        if (previous === undefined) delete process.env.TASKWRAITH_CONCURRENT_LANES
        else process.env.TASKWRAITH_CONCURRENT_LANES = previous
      }
    })

    it('rejects yield-to-BG at plan time when parallel lanes are disabled', async () => {
      const previous = process.env.TASKWRAITH_CONCURRENT_LANES
      process.env.TASKWRAITH_CONCURRENT_LANES = '0'
      try {
        const harness = makeHarness()
        harness.chat.ensemble!.bossmanParticipantId = 'claude'
        harness.chat.ensemble!.participants = [
          {
            id: 'claude',
            provider: 'claude',
            enabled: true,
            role: 'Boss',
            instructions: 'Coordinate.',
            order: 1,
            permissionPresetId: 'read_only'
          },
          backgroundParticipant()
        ]
        harness.orchestrator.startRound({
          chatId: 'ensemble-chat',
          prompt: 'Open the round.',
          event: { sender: {} as Electron.WebContents }
        })
        await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

        const outcome = harness.orchestrator.markYielded(
          harness.dispatched[0].appRunId!,
          'Background gates please.',
          'Shell helper'
        )
        expect(outcome).toMatchObject({
          kind: 'yielded',
          routing: { ok: false, reason: 'concurrent_lanes_disabled', target: 'Shell helper' }
        })
        expect(
          harness.chat.messages.some((message) =>
            (message.content || '').includes('concurrent_lanes_disabled')
          )
        ).toBe(true)
      } finally {
        if (previous === undefined) delete process.env.TASKWRAITH_CONCURRENT_LANES
        else process.env.TASKWRAITH_CONCURRENT_LANES = previous
      }
    })

    it('rejects non-authority yield-to-BG with authority_precedence', async () => {
      const previous = process.env.TASKWRAITH_CONCURRENT_LANES
      process.env.TASKWRAITH_CONCURRENT_LANES = '1'
      try {
        const harness = makeHarness()
        harness.chat.ensemble!.bossmanParticipantId = 'claude'
        harness.chat.ensemble!.participants = [
          {
            id: 'claude',
            provider: 'claude',
            enabled: true,
            role: 'Boss',
            instructions: 'Coordinate.',
            order: 1,
            permissionPresetId: 'read_only'
          },
          {
            id: 'codex',
            provider: 'codex',
            enabled: true,
            role: 'Worker',
            instructions: 'Work.',
            order: 2,
            permissionPresetId: 'workspace_write'
          },
          backgroundParticipant()
        ]
        harness.orchestrator.startRound({
          chatId: 'ensemble-chat',
          prompt: 'Open the round.',
          event: { sender: {} as Electron.WebContents }
        })
        await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
        harness.orchestrator.handleProviderOutput(
          'claude',
          { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
          { type: 'result', status: 'success' }
        )
        await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
        expect(harness.dispatched[1].provider).toBe('codex')

        const outcome = harness.orchestrator.markYielded(
          harness.dispatched[1].appRunId!,
          'Please run gates.',
          'Shell helper'
        )
        expect(outcome).toMatchObject({
          kind: 'yielded',
          routing: { ok: false, reason: 'authority_precedence', target: 'Shell helper' }
        })
      } finally {
        if (previous === undefined) delete process.env.TASKWRAITH_CONCURRENT_LANES
        else process.env.TASKWRAITH_CONCURRENT_LANES = previous
      }
    })
  })

  it('lets the assigned Boss definitively close the round and drop queued prompts', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.bossmanParticipantId = 'claude'
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Close-out pass.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].provider).toBe('claude')

    const queued = harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Fresh user prompt that should be dropped.',
      event: { sender: {} as Electron.WebContents },
      mode: 'queue'
    })
    expect(queued.status).toBe('queued')
    expect(harness.chat.ensemble?.activeRound?.queuedPrompts).toEqual([
      'Fresh user prompt that should be dropped.'
    ])

    expectYielded(
      harness.orchestrator.markYielded(
        harness.dispatched[0].appRunId!,
        'Need to return control to the user.',
        'user'
      )
    )

    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    expect(harness.dispatched).toHaveLength(1)
    expect(harness.chat.ensemble?.activeRound?.queuedPrompts).toEqual([])
    expect(harness.chat.ensemble?.activeRound?.queuedPrompt).toBeUndefined()
  })

  it('persists tool calls used by ensemble participants into a role:tool message', async () => {
    // Regression: tool calls used by ensemble participants weren't
    // showing in the transcript. Root cause: the renderer-side tool
    // accumulator (App.tsx:10292+) requires an active run context in
    // `activeRunsRef`, which only gets registered by `executeRun` on
    // the solo-chat path. Ensemble runs are dispatched from main, so
    // the renderer is a passive observer of the orchestrator's chat
    // saves — meaning the orchestrator has to persist tool messages
    // directly. This test exercises the tool_use → tool_result pairing
    // and asserts the resulting message lands in `chat.messages` with
    // ensemble metadata + ordering before the assistant message.
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Use a tool and tell me what you found.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].provider).toBe('claude')

    const route = {
      appRunId: harness.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }
    // Realistic chronology: agent narrates intent, calls a tool,
    // receives the result, then summarises. The timeline-driven
    // flush should produce three messages interleaved in this
    // order: assistant("Let me read…"), tool(read_file),
    // assistant("Found it.").
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'content',
      text: 'Let me read the file first.'
    })
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'tool_use',
      tool_id: 'call-1',
      tool_name: 'read_file',
      parameters: { file_path: '/tmp/notes.md' }
    })
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'tool_result',
      tool_id: 'call-1',
      content: 'File contents...'
    })
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'content',
      text: 'Found it — those are the notes.'
    })
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'result',
      status: 'success',
      stats: { total_tokens: 10 }
    })

    const toolMessages = harness.chat.messages.filter(
      (message) => message.role === 'tool' && message.metadata?.ensembleProvider === 'claude'
    )
    expect(toolMessages).toHaveLength(1)
    expect(toolMessages[0].toolActivities).toHaveLength(1)
    expect(toolMessages[0].toolActivities?.[0].toolName).toBe('read_file')
    expect(toolMessages[0].toolActivities?.[0].displayName).toBe('Read /tmp/notes.md')
    expect(toolMessages[0].toolActivities?.[0].status).toBe('success')
    expect(toolMessages[0].toolActivities?.[0].parameters?.file_path).toBe('/tmp/notes.md')
    expect(toolMessages[0].toolActivities?.[0].metadata).toMatchObject({
      provider: 'claude',
      ensembleProvider: 'claude'
    })

    // Interleaved ordering: the participant's transcript slice
    // should read assistant → tool → assistant. The flushRun
    // pass walks the timeline and emits one message per entry, so
    // a two-content + one-tool timeline produces three messages.
    const participantMessages = harness.chat.messages.filter(
      (message) =>
        message.runId === harness.dispatched[0].appRunId &&
        (message.role === 'assistant' || message.role === 'tool')
    )
    expect(participantMessages.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant'])
    expect(participantMessages[0].content).toContain('Let me read the file first.')
    expect(participantMessages[2].content).toContain('Found it')
  })

  it('preserves ensemble transcript row timestamps across streaming re-flushes', async () => {
    let tick = 0
    const harness = makeHarness({
      nowIso: () => new Date(Date.UTC(2026, 4, 24, 0, 0, tick++)).toISOString()
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Stream a growing answer.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const route = {
      appRunId: harness.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'content',
      text: 'First chunk.'
    })
    await vi.waitFor(() => {
      expect(
        harness.chat.messages.find(
          (message) => message.id === `ensemble-content-${route.appRunId}-0`
        )?.content
      ).toContain('First chunk.')
    })
    const first = harness.chat.messages.find(
      (message) => message.id === `ensemble-content-${route.appRunId}-0`
    )
    expect(first?.timestamp).toBeTruthy()

    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'content',
      text: ' Second chunk.'
    })
    await vi.waitFor(() => {
      expect(
        harness.chat.messages.find(
          (message) => message.id === `ensemble-content-${route.appRunId}-0`
        )?.content
      ).toContain('Second chunk.')
    })
    const updated = harness.chat.messages.find(
      (message) => message.id === `ensemble-content-${route.appRunId}-0`
    )
    expect(updated?.timestamp).toBe(first?.timestamp)
  })

  it('keeps system rows at their event position during participant re-flushes', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Stream, then emit status.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const route = {
      appRunId: harness.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'content',
      text: 'First visible participant chunk.'
    })
    await vi.waitFor(() =>
      expect(
        harness.chat.messages.find(
          (message) => message.id === `ensemble-content-${route.appRunId}-0`
        )?.content
      ).toContain('First visible participant chunk.')
    )

    expect(
      harness.orchestrator.appendStatusForRun(route.appRunId!, 'System event after chunk.')
    ).toBe(true)
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'tool_use',
      tool_id: 'call-after-system',
      tool_name: 'read_file',
      parameters: { file_path: '/tmp/after-system.md' }
    })
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'tool_result',
      tool_id: 'call-after-system',
      content: 'Later file contents.'
    })
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'content',
      text: 'Participant content after the system event.'
    })
    await vi.waitFor(() =>
      expect(
        harness.chat.messages.find(
          (message) => message.id === `ensemble-content-${route.appRunId}-2`
        )?.content
      ).toContain('Participant content after the system event.')
    )

    const systemMessage = harness.chat.messages.find(
      (message) =>
        message.metadata?.kind === 'ensembleRoundStatus' &&
        typeof message.content === 'string' &&
        message.content.includes('System event after chunk.')
    )
    expect(systemMessage).toBeTruthy()
    const relevantIds = new Set([
      `ensemble-content-${route.appRunId}-0`,
      systemMessage!.id,
      `ensemble-tool-${route.appRunId}-1`,
      `ensemble-content-${route.appRunId}-2`
    ])
    expect(
      harness.chat.messages
        .filter((message) => relevantIds.has(message.id))
        .map((message) => message.id)
    ).toEqual([
      `ensemble-content-${route.appRunId}-0`,
      systemMessage!.id,
      `ensemble-tool-${route.appRunId}-1`,
      `ensemble-content-${route.appRunId}-2`
    ])
  })

  it('persists real write_file line stats for ensemble tool activities', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Create a file.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const route = {
      appRunId: harness.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'tool_use',
      tool_id: 'write-1',
      tool_name: 'write_file',
      parameters: {
        path: 'local-p5-smoke.md',
        content: 'one\ntwo\nthree\nfour'
      }
    })
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'tool_result',
      tool_id: 'write-1',
      content: 'Wrote local-p5-smoke.md.'
    })
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'result',
      status: 'success',
      stats: { total_tokens: 10 }
    })

    await vi.waitFor(() =>
      expect(
        harness.chat.messages.filter(
          (message) => message.role === 'tool' && message.metadata?.ensembleProvider === 'claude'
        )
      ).toHaveLength(1)
    )
    const activity = harness.chat.messages.find((message) => message.role === 'tool')
      ?.toolActivities?.[0]
    expect(activity?.diffSummary).toMatchObject({
      additions: 4,
      deletions: 0,
      source: 'content',
      confidence: 'estimated',
      files: [
        {
          path: 'local-p5-smoke.md',
          additions: 4,
          deletions: 0
        }
      ]
    })
  })

  it('uses structured tool_kind to categorize ensemble tool activities with freeform names', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Use a Grok-style ACP tool.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const route = {
      appRunId: harness.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'tool_use',
      tool_id: 'freeform-edit-1',
      tool_name: 'Write package.json',
      tool_kind: 'edit',
      parameters: { path: 'package.json' }
    })
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'tool_result',
      tool_id: 'freeform-edit-1',
      content: 'Updated package.json.'
    })
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'result',
      status: 'success',
      stats: { total_tokens: 10 }
    })

    await vi.waitFor(() =>
      expect(
        harness.chat.messages.filter(
          (message) => message.role === 'tool' && message.metadata?.ensembleProvider === 'claude'
        )
      ).toHaveLength(1)
    )
    const activity = harness.chat.messages.find((message) => message.role === 'tool')
      ?.toolActivities?.[0]
    expect(activity).toMatchObject({
      toolName: 'Write package.json',
      category: 'write',
      status: 'success'
    })
  })

  it('categorizes ensemble thinking pseudo-tools as task activities without truncating results', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Think through the next step.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const route = {
      appRunId: harness.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }
    const trace = `${'reasoning trace '.repeat(120)}tail sentinel`
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'tool_use',
      tool_id: 'thinking-1',
      tool_name: 'grok_thinking',
      parameters: { kind: 'reasoning' }
    })
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'tool_result',
      tool_id: 'thinking-1',
      tool_name: 'grok_thinking',
      output: trace
    })
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'result',
      status: 'success',
      stats: { total_tokens: 10 }
    })

    await vi.waitFor(() =>
      expect(
        harness.chat.messages.filter(
          (message) => message.role === 'tool' && message.metadata?.ensembleProvider === 'claude'
        )
      ).toHaveLength(1)
    )
    const activity = harness.chat.messages.find((message) => message.role === 'tool')
      ?.toolActivities?.[0]
    expect(activity).toMatchObject({
      toolName: 'grok_thinking',
      category: 'task',
      status: 'success',
      resultSummary: trace
    })
    expect(activity?.resultSummary).toContain('tail sentinel')
    expect(activity?.resultSummary).not.toMatch(/\.\.\.$/)
  })

  it('derives result-side diffs for plain ensemble Edit tool activities', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Edit a file.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const route = {
      appRunId: harness.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'tool_use',
      tool_id: 'edit-1',
      tool_name: 'Edit',
      tool_kind: 'edit',
      parameters: { path: 'src/app.ts' }
    })
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'tool_result',
      tool_id: 'edit-1',
      content: [
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1,2 +1,3 @@',
        '-old line',
        '+new line',
        '+another line'
      ].join('\n')
    })
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'result',
      status: 'success',
      stats: { total_tokens: 10 }
    })

    await vi.waitFor(() =>
      expect(
        harness.chat.messages.filter(
          (message) => message.role === 'tool' && message.metadata?.ensembleProvider === 'claude'
        )
      ).toHaveLength(1)
    )
    const activity = harness.chat.messages.find((message) => message.role === 'tool')
      ?.toolActivities?.[0]
    expect(activity).toMatchObject({
      toolName: 'Edit',
      category: 'write',
      filePath: 'src/app.ts',
      diffSummary: {
        additions: 2,
        deletions: 1,
        source: 'result_diff',
        files: [{ path: 'src/app.ts', additions: 2, deletions: 1 }]
      }
    })
  })

  it('uses an immediate idle-seat change later in the same Continuous pass', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.maxContinuationHops = 8
    harness.chat.activeGoal = buildActiveGoal('continuous-seat-swap')
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Use the updated worker later in this pass.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const applied = await harness.orchestrator.requestParticipantSeatChange({
      chatId: 'ensemble-chat',
      participantId: 'codex',
      participant: {
        provider: 'kimi',
        model: 'kimi-k2.7-code',
        role: 'Replacement worker'
      },
      changedBy: 'user',
      reason: 'Swap the worker before its upcoming turn.'
    })
    expect(applied).toMatchObject({ ok: true, status: 'applied', participantId: 'codex' })

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'First pass review complete.' }
    )
    completeDispatchedRun(harness, 0)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1]).toMatchObject({
      provider: 'kimi',
      model: 'kimi-k2.7-code',
      ensembleRun: {
        participantId: 'codex',
        role: 'Replacement worker'
      }
    })
    harness.orchestrator.handleProviderOutput(
      'kimi',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'First pass implementation complete.' }
    )
    harness.chat.activeGoal = {
      ...harness.chat.activeGoal!,
      status: 'completed'
    }
    completeDispatchedRun(harness, 1)

    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    expect(harness.dispatched).toHaveLength(2)
    expect(
      harness.chat.ensemble?.participants.find((participant) => participant.id === 'codex')
    ).toMatchObject({
      provider: 'kimi',
      model: 'kimi-k2.7-code',
      role: 'Replacement worker'
    })
    expect(
      harness.chat.messages.some((message) =>
        message.content.includes('queued provider/model seat change before another pass')
      )
    ).toBe(false)
  })

  it('does not queue or announce a seat change that re-applies the running seat', async () => {
    const harness = makeHarness({ probeParticipant: async () => ({ reachable: true }) })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    // The mid-round picker snaps back to the seat the participant is actually
    // running, so re-applying it is easy to trigger repeatedly.
    const running = harness.chat.ensemble!.participants.find(
      (participant) => participant.id === 'claude'
    )!
    const result = await harness.orchestrator.requestParticipantSeatChange({
      chatId: 'ensemble-chat',
      participantId: 'claude',
      participant: { provider: running.provider, model: running.model },
      changedBy: 'user',
      reason: 'Re-apply the seat the participant already has.'
    })

    expect(result.ok).toBe(true)
    expect(result.status).toBeUndefined()
    expect(
      harness.chat.messages.filter((message) =>
        message.content.includes('Authoritative seat change queued')
      )
    ).toHaveLength(0)
  })

  it('announces a queued seat change once when the same change is resubmitted', async () => {
    const harness = makeHarness({ probeParticipant: async () => ({ reachable: true }) })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const change = {
      chatId: 'ensemble-chat',
      participantId: 'claude',
      participant: { provider: 'kimi', model: 'kimi-k2.7-code' },
      changedBy: 'user' as const,
      reason: 'Swap the reviewer.'
    }
    const first = await harness.orchestrator.requestParticipantSeatChange(change)
    expect(first).toMatchObject({
      ok: true,
      status: 'queued',
      participantId: 'claude',
      pendingParticipant: { provider: 'kimi', model: 'kimi-k2.7-code' }
    })

    const repeat = await harness.orchestrator.requestParticipantSeatChange(change)
    expect(repeat.ok).toBe(true)
    expect(repeat.status).toBeUndefined()
    expect(repeat.pendingParticipant).toMatchObject({
      provider: 'kimi',
      model: 'kimi-k2.7-code'
    })

    // Announced exactly once, and now on the tool result rather than the
    // transcript: the FIRST call reports the queue, the resubmission reports
    // that there is nothing new to queue.
    expect(first.message).toContain('Authoritative seat change queued')
    expect(repeat.message).toContain('nothing queued')
    expect(
      harness.chat.messages.filter((message) =>
        (message.content || '').includes('Authoritative seat change queued')
      )
    ).toHaveLength(0)
  })

  it('skipActiveParticipant returns false when no round is active', async () => {
    const harness = makeHarness()
    const skipped = await harness.orchestrator.skipActiveParticipant('ensemble-chat')
    expect(skipped).toBe(false)
    expect(harness.cancelRun).not.toHaveBeenCalled()
  })

  it('skips a failed dispatch and advances the round', async () => {
    let calls = 0
    const harness = makeHarness({
      dispatch: async (payload) => ({
        dispatched: ++calls !== 1,
        appRunId: payload.appRunId || ''
      })
    })

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Try both participants.',
      event: { sender: {} as Electron.WebContents }
    })

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[0].provider).toBe('claude')
    expect(harness.dispatched[1].provider).toBe('codex')
    // 1.0.4 — the generic 'Reviewer failed. Dispatch failed.' has
    // been replaced by the structured failure note from
    // `EnsembleErrors.formatDispatchFailureNote`. When the dispatch
    // returns `dispatched: false` WITHOUT throwing, we can't
    // classify the error (RunCoordinator already consumed it in
    // its preflight try/catch), so the note surfaces as the
    // `unknown` kind: "⚠ <Provider> / <Role> dispatch failed.
    // Skipping for this round."
    const failureNote = harness.chat.messages.find(
      (message) =>
        message.role === 'system' &&
        message.metadata?.kind === 'ensembleRoundStatus' &&
        typeof message.content === 'string' &&
        message.content.includes('Claude / Reviewer')
    )
    expect(failureNote?.content).toContain('Claude / Reviewer')
    expect(failureNote?.content).toContain('dispatch failed')
    expect(failureNote?.content).toContain('Skipping for this round')
  })

  it('cancels an exact serial transport when adapter dispatch throws after entry', async () => {
    let calls = 0
    const harness = makeHarness({
      dispatch: async (payload) => {
        if (++calls === 1) throw new Error('adapter rejected after entry')
        return { dispatched: true, appRunId: payload.appRunId || '' }
      }
    })

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Continue after a partial adapter start.',
      event: { sender: {} as Electron.WebContents }
    })

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.cancelRun).toHaveBeenCalledWith(
      harness.dispatched[0].provider,
      harness.dispatched[0].appRunId
    )
    completeDispatchedRun(harness, 1)
  })

  it('stores human-readable ensemble yield tool activity labels', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Review then yield.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const route = {
      appRunId: harness.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'tool_use',
      tool_id: 'yield-1',
      tool_name: 'mcp_TaskWraith_ensemble_yield',
      parameters: { target: 'Worker' }
    })
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'tool_result',
      tool_id: 'yield-1',
      content: 'Yielded.'
    })
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'result',
      status: 'success',
      stats: { total_tokens: 10 }
    })

    await vi.waitFor(() =>
      expect(
        harness.chat.messages.filter(
          (message) => message.role === 'tool' && message.metadata?.ensembleProvider === 'claude'
        )
      ).toHaveLength(1)
    )
    const toolMessages = harness.chat.messages.filter(
      (message) => message.role === 'tool' && message.metadata?.ensembleProvider === 'claude'
    )
    expect(toolMessages[0].toolActivities?.[0]).toMatchObject({
      toolName: 'mcp_TaskWraith_ensemble_yield',
      displayName: 'Reviewer yielded to Worker',
      category: 'task',
      status: 'success'
    })
  })

  it('deduplicates repeated ensemble yield tool_use events with the same id', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Review then yield.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const route = {
      appRunId: harness.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }
    const useEvent = {
      type: 'tool_use',
      tool_id: 'yield-dup',
      tool_name: 'mcp_TaskWraith_ensemble_yield',
      parameters: { target: 'Worker' }
    }
    harness.orchestrator.handleProviderOutput('claude', route, useEvent)
    harness.orchestrator.handleProviderOutput('claude', route, useEvent)

    await vi.waitFor(() =>
      expect(
        harness.chat.messages.filter(
          (message) => message.role === 'tool' && message.metadata?.ensembleProvider === 'claude'
        )
      ).toHaveLength(1)
    )
    let toolMessages = harness.chat.messages.filter(
      (message) => message.role === 'tool' && message.metadata?.ensembleProvider === 'claude'
    )
    expect(toolMessages[0].toolActivities).toHaveLength(1)
    expect(toolMessages[0].toolActivities?.[0]).toMatchObject({
      id: 'yield-dup',
      displayName: 'Reviewer yielding to Worker',
      status: 'running'
    })

    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'tool_result',
      tool_id: 'yield-dup',
      content: 'Yielded.'
    })
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'result',
      status: 'success',
      stats: { total_tokens: 10 }
    })

    await vi.waitFor(() =>
      expect(
        harness.chat.messages.filter(
          (message) => message.role === 'tool' && message.metadata?.ensembleProvider === 'claude'
        )
      ).toHaveLength(1)
    )
    toolMessages = harness.chat.messages.filter(
      (message) => message.role === 'tool' && message.metadata?.ensembleProvider === 'claude'
    )
    expect(toolMessages[0].toolActivities).toHaveLength(1)
    expect(toolMessages[0].toolActivities?.[0]).toMatchObject({
      id: 'yield-dup',
      displayName: 'Reviewer yielded to Worker',
      status: 'success'
    })
  })

  it('completes a pending ensemble yield activity before markYielded finalizes the run', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Review then yield.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const route = {
      appRunId: harness.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }
    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'tool_use',
      tool_id: 'yield-before-result',
      tool_name: 'mcp_TaskWraith_ensemble_yield',
      parameters: { target: 'Worker' }
    })

    expectYielded(
      harness.orchestrator.markYielded(
        harness.dispatched[0].appRunId!,
        'Passing to worker.',
        'Worker'
      )
    )

    harness.orchestrator.handleProviderOutput('claude', route, {
      type: 'tool_result',
      tool_id: 'yield-before-result',
      content: 'Yielded.'
    })

    await vi.waitFor(() =>
      expect(
        harness.chat.messages.filter(
          (message) => message.role === 'tool' && message.metadata?.ensembleProvider === 'claude'
        )
      ).toHaveLength(1)
    )
    const toolMessages = harness.chat.messages.filter(
      (message) => message.role === 'tool' && message.metadata?.ensembleProvider === 'claude'
    )
    expect(toolMessages[0].toolActivities).toHaveLength(1)
    expect(toolMessages[0].toolActivities?.[0]).toMatchObject({
      id: 'yield-before-result',
      displayName: 'Reviewer yielded to Worker',
      status: 'success'
    })
    expect(
      toolMessages
        .flatMap((message) => message.toolActivities || [])
        .some(
          (activity) =>
            String(activity.toolName).includes('ensemble_yield') && activity.status === 'running'
        )
    ).toBe(false)
  })

  it('clears queued work when a round is stopped', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Original prompt',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Queued prompt',
      event: { sender: {} as Electron.WebContents },
      mode: 'queue'
    })
    expect(harness.chat.ensemble?.activeRound?.queuedPrompt).toBe('Queued prompt')

    await harness.orchestrator.cancelRound('ensemble-chat')

    expect(harness.chat.ensemble?.activeRound?.status).toBe('cancelled')
    expect(harness.chat.ensemble?.activeRound?.queuedPrompt).toBeUndefined()
    expect(harness.cancelRun).toHaveBeenCalledWith('claude', harness.dispatched[0].appRunId)
    expect(harness.transitionRunQueueJob).toHaveBeenCalledWith(
      harness.dispatched[0].appRunId,
      'cancelled',
      { statusReason: 'cancelled' }
    )
  })

  it('publishes exactly one terminal outcome when cancellation wakes the serial loop', async () => {
    let cancelledProjectionCount = 0
    const completeSessionCheckpoint = vi.fn()
    const harness = makeHarness({
      beforeSaveChat: (chat) => {
        if (chat.ensemble?.activeRound?.status === 'cancelled') {
          cancelledProjectionCount += 1
        }
      },
      completeSessionCheckpoint
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Cancel while the participant is active.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const roundId = harness.chat.ensemble!.activeRound!.roundId

    await expect(harness.orchestrator.cancelRound('ensemble-chat')).resolves.toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(cancelledProjectionCount).toBe(1)
    expect(completeSessionCheckpoint).toHaveBeenCalledTimes(1)
    expect(completeSessionCheckpoint).toHaveBeenCalledWith('ensemble-chat', roundId, 'cancelled')
    expect(
      harness.chat.ensemble?.activeRound?.participants.map((participant) => participant.status)
    ).toEqual(['cancelled', 'cancelled'])
  })

  it('does not let an expected-round cancellation hit a replacement round', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Replacement-sensitive round.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const liveRoundId = harness.chat.ensemble!.activeRound!.roundId

    await expect(
      harness.orchestrator.cancelRound('ensemble-chat', 'stale cancel', 'older-round')
    ).resolves.toBe(false)
    expect(harness.chat.ensemble?.activeRound?.roundId).toBe(liveRoundId)
    expect(harness.chat.ensemble?.activeRound?.status).toBe('running')

    await expect(
      harness.orchestrator.cancelRound('ensemble-chat', 'exact cancel', liveRoundId)
    ).resolves.toBe(true)
  })

  it('does not queue behind a stale runtime whose persisted round already ended', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Original prompt',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const oldRoundId = harness.chat.ensemble?.activeRound?.roundId
    harness.chat.ensemble!.activeRound = {
      ...harness.chat.ensemble!.activeRound!,
      status: 'completed',
      endedAt: '2026-05-24T00:00:09.000Z'
    }

    const result = harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Fresh prompt',
      event: { sender: {} as Electron.WebContents },
      mode: 'queue'
    })

    expect(result.status).toBe('started')
    expect(harness.chat.ensemble?.activeRound?.status).toBe('running')
    expect(harness.chat.ensemble?.activeRound?.roundId).not.toBe(oldRoundId)
    expect(harness.chat.ensemble?.activeRound?.queuedPrompt).toBeUndefined()
    expect(harness.chat.messages.at(-1)?.content).toBe('Fresh prompt')
  })

  it('does not queue behind a stale running snapshot with no live dispatch evidence', async () => {
    const completedRounds: Array<{ chatId: string; roundId: string; status: string }> = []
    const harness = makeHarness({
      completeSessionCheckpoint: (chatId, roundId, status) =>
        completedRounds.push({ chatId, roundId, status })
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Original prompt',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const staleRound = harness.chat.ensemble!.activeRound!
    const oldRoundId = staleRound.roundId
    harness.chat.ensemble!.activeRound = {
      ...staleRound,
      status: 'running',
      activeParticipantId: 'claude',
      queuedPrompt: 'stale queued prompt',
      queuedPrompts: ['stale queued prompt'],
      participants: staleRound.participants.map((participant) => ({
        ...participant,
        status: participant.participantId === 'claude' ? 'answered' : 'skipped',
        endedAt: '2026-05-24T00:00:09.000Z'
      }))
    }

    const result = harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Fresh prompt',
      event: { sender: {} as Electron.WebContents },
      mode: 'queue'
    })

    expect(result.status).toBe('started')
    expect(harness.chat.ensemble?.activeRound?.status).toBe('running')
    expect(harness.chat.ensemble?.activeRound?.roundId).not.toBe(oldRoundId)
    expect(harness.chat.ensemble?.activeRound?.queuedPrompt).toBeUndefined()
    expect(harness.chat.messages.at(-1)?.content).toBe('Fresh prompt')
    expect(completedRounds).toContainEqual({
      chatId: 'ensemble-chat',
      roundId: oldRoundId,
      status: 'completed'
    })
  })

  it('can cancel a persisted running round even when its runtime is already gone', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Original prompt',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    ;(
      harness.orchestrator as unknown as {
        roundsByChatId: Map<string, unknown>
      }
    ).roundsByChatId.delete('ensemble-chat')

    const ok = await harness.orchestrator.cancelRound('ensemble-chat', 'stale runtime cleanup')

    expect(ok).toBe(true)
    expect(harness.chat.ensemble?.activeRound?.status).toBe('cancelled')
    expect(harness.chat.ensemble?.activeRound?.activeParticipantId).toBeUndefined()
    expect(harness.chat.ensemble?.activeRound?.queuedPrompt).toBeUndefined()
  })

  // Slice D (1.0.3) — per-participant reasoning + fast-mode + thinking
  // flow through the dispatch payload so each provider adapter sees
  // its own settings. Verifies the orchestrator-side wiring.
  // 1.0.4-M regression guard. The task ("Per-participant model not
  // persisting to dispatch") was opened mid-1.0.4 when the renderer's
  // CombinedModelPicker only wrote chat-level state; the dispatch
  // path then ignored per-participant `participant.model` values. The
  // pull-through fix landed implicitly via the Model-tag M1-M5 +
  // participant-scoped picker work (`updateSelectedParticipant` at
  // App.tsx:14417 writes `{ model: nextModel }` directly into
  // `chat.ensemble.participants[i].model`, and the orchestrator's
  // dispatch payload at `EnsembleOrchestrator.ts:1747` reads from
  // that same field). This test pins the END of the chain — set
  // `participant.model` on the chat record, observe the dispatch
  // payload carries it. Close this regression guard and you reopen
  // the original bug.
  it('threads per-participant model + reasoning + fast-mode through dispatch', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'claude',
        provider: 'claude',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review.',
        order: 1,
        model: 'claude-opus-4-7',
        permissionPresetId: 'read_only',
        reasoningEffort: 'high',
        fastModeEnabled: true
      },
      {
        id: 'codex',
        provider: 'codex',
        enabled: true,
        role: 'Worker',
        instructions: 'Work.',
        order: 2,
        model: 'gpt-5.5',
        permissionPresetId: 'workspace_write',
        reasoningEffort: 'xhigh',
        fastModeEnabled: true
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Tune per-participant settings.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const claudePayload = harness.dispatched[0]
    expect(claudePayload.provider).toBe('claude')
    expect(claudePayload.model).toBe('claude-opus-4-7')
    expect(claudePayload.claudeReasoningEffort).toBe('high')
    expect(claudePayload.claudeFastMode).toBe(true)
    // Claude run should NOT carry Codex-only fields.
    expect(claudePayload.reasoningEffort).toBeUndefined()
    expect(claudePayload.serviceTier).toBeUndefined()

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: claudePayload.appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 10 } }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    const codexPayload = harness.dispatched[1]
    expect(codexPayload.provider).toBe('codex')
    expect(codexPayload.model).toBe('gpt-5.5')
    expect(codexPayload.reasoningEffort).toBe('xhigh')
    expect(codexPayload.serviceTier).toBe('fast')
    expect(codexPayload.claudeReasoningEffort).toBeUndefined()
    expect(codexPayload.claudeFastMode).toBeUndefined()
  })

  it('threads Muse participant reasoningEffort through dispatch sharedReasoning', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'muse',
        provider: 'muse',
        enabled: true,
        role: 'Muse',
        instructions: 'Work.',
        order: 1,
        model: 'muse-spark-1.2',
        permissionPresetId: 'default',
        reasoningEffort: 'ultra'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Think carefully.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const musePayload = harness.dispatched[0]
    expect(musePayload.provider).toBe('muse')
    expect(musePayload.model).toBe('muse-spark-1.2')
    expect(musePayload.reasoningEffort).toBe('ultra')
  })

  it('threads Ollama participant tier and run profile through dispatch', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'ollama',
        provider: 'ollama',
        enabled: true,
        role: 'Local Worker',
        instructions: 'Work locally.',
        order: 1,
        model: 'ornith:35b',
        permissionPresetId: 'workspace_write',
        ollamaRunProfile: 'verify_with_shell'
      }
    ]

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Use local shell verification.',
      event: { sender: {} as Electron.WebContents }
    })

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0]).toMatchObject({
      provider: 'ollama',
      model: 'ornith:35b',
      ollamaRunProfile: 'verify_with_shell'
    })
  })

  it('threads participant-scoped tool grants through effective permissions', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'claude',
        provider: 'claude',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review.',
        order: 1,
        model: 'claude-model',
        permissionPresetId: 'read_only'
      },
      {
        id: 'codex',
        provider: 'codex',
        enabled: true,
        role: 'Worker',
        instructions: 'Work.',
        order: 2,
        model: 'codex-model',
        permissionPresetId: 'default',
        permissionOverrides: {
          agenticServices: {
            shellCommands: 'allow',
            fileChanges: 'allow'
          }
        }
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Check participant grants.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].effectivePermissions?.agenticServices.shellCommands).toBe('ask')
    expect(harness.dispatched[0].effectivePermissions?.agenticServices.fileChanges).toBe('ask')

    harness.orchestrator.markYielded(harness.dispatched[0].appRunId!, 'Passing to worker.')
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

    const codexPayload = harness.dispatched[1]
    expect(codexPayload.effectivePermissions?.agenticServices.shellCommands).toBe('allow')
    expect(codexPayload.effectivePermissions?.agenticServices.fileChanges).toBe('allow')
    expect(codexPayload.effectivePermissions?.workspaceGrantServiceIds).toEqual([])
    expect(codexPayload.prompt).toContain('TaskWraith shell-routing (effective grant)')
    expect(codexPayload.prompt).toContain('TaskWraith__run_shell_command')
    expect(codexPayload.prompt).toContain('already allowed shell commands')
  })

  // Slice C extension (1.0.3) — ensemble_yield(target:) reorders the
  // remaining participants so the named target speaks next.
  it('promotes a participant tagged via @mention to speak next', async () => {
    // Collaborative back-and-forth: Claude finishes its turn, mentions
    // @Researcher in its content, and the orchestrator promotes
    // Gemini (role 'Researcher') ahead of Codex even though Codex is
    // next in default order. Resolution mirrors `resolveYieldTargetIndex`
    // (id → provider → role).
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'ensemble-claude',
        provider: 'claude',
        enabled: true,
        role: 'Planner',
        instructions: 'Plan.',
        order: 1,
        permissionPresetId: 'read_only'
      },
      {
        id: 'ensemble-codex',
        provider: 'codex',
        enabled: true,
        role: 'Worker',
        instructions: 'Work.',
        order: 2,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'ensemble-gemini',
        provider: 'gemini',
        enabled: true,
        role: 'Researcher',
        instructions: 'Research.',
        order: 3,
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and hand off.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].provider).toBe('claude')

    // Claude emits content containing an @Researcher mention then
    // finishes naturally (result event drives finalize).
    const claudeRoute = {
      appRunId: harness.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }
    harness.orchestrator.handleProviderOutput('claude', claudeRoute, {
      type: 'content',
      text: 'Plan ready. Yielding to @Researcher for a fact-check.'
    })
    harness.orchestrator.handleProviderOutput('claude', claudeRoute, {
      type: 'result',
      status: 'success',
      stats: { total_tokens: 10 }
    })

    // Default order would be Codex next; @Researcher should override.
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('gemini')
  })

  it('promotes multiple @mentioned participants in mention order', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'ensemble-claude',
        provider: 'claude',
        enabled: true,
        role: 'Planner',
        instructions: 'Plan.',
        order: 1,
        permissionPresetId: 'read_only'
      },
      {
        id: 'ensemble-codex',
        provider: 'codex',
        enabled: true,
        role: 'Worker',
        instructions: 'Work.',
        order: 2,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'ensemble-gemini',
        provider: 'gemini',
        enabled: true,
        role: 'Researcher',
        instructions: 'Research.',
        order: 3,
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and route.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const claudeRoute = {
      appRunId: harness.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }
    harness.orchestrator.handleProviderOutput('claude', claudeRoute, {
      type: 'content',
      text: 'Plan ready. @Researcher check facts, then @Worker implement.'
    })
    harness.orchestrator.handleProviderOutput('claude', claudeRoute, {
      type: 'result',
      status: 'success',
      stats: { total_tokens: 10 }
    })

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('gemini')
    harness.orchestrator.handleProviderOutput(
      'gemini',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 10 } }
    )

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[2].provider).toBe('codex')
  })

  it('reopens a spoken participant only once when an explicit yield and @mention target the same seat', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.bossmanParticipantId = 'ensemble-claude'
    // This test isolates the explicit @-mention/yield ROUTING mechanics. A
    // pre-completed goal switches OFF continuous-mode auto-continuation (which
    // would otherwise start another pass at drain), so the round finalizes where
    // the mechanics assertion expects. The yield/@-mention path is independent of
    // the goal, so its behavior is unaffected.
    harness.chat.activeGoal = { ...buildActiveGoal('goal-continuous'), status: 'completed' }
    harness.chat.ensemble!.participants = [
      {
        id: 'ensemble-codex',
        provider: 'codex',
        enabled: true,
        role: 'Worker',
        instructions: 'Work.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'ensemble-claude',
        provider: 'claude',
        enabled: true,
        role: 'Planner',
        instructions: 'Plan.',
        order: 2,
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Call and response.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].provider).toBe('codex')

    // Codex speaks (with @claude in content) then yields via tool.
    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: '@claude, what is 2+3?' }
    )
    harness.orchestrator.markYielded(harness.dispatched[0].appRunId!, 'Passing to Claude', 'claude')
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('claude')

    // Claude speaks (with @codex in content) then explicitly yields via the
    // tool to Codex. Explicit yield is authoritative even though Codex already
    // spoke; the duplicate inline mention must not append a second copy.
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      {
        type: 'content',
        text: '@codex 2+3=5. Your turn — what is 7-4?'
      }
    )
    harness.orchestrator.markYielded(harness.dispatched[1].appRunId!, 'Passing to Codex', 'codex')
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[2].provider).toBe('codex')
    expect(harness.chat.ensemble?.activeRound?.continuationHops).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(harness.dispatched).toHaveLength(3)
  })

  const CONTINUOUS_PAIR: EnsembleParticipant[] = [
    {
      id: 'ensemble-codex',
      provider: 'codex',
      enabled: true,
      role: 'Worker',
      instructions: 'Work.',
      order: 1,
      permissionPresetId: 'workspace_write'
    },
    {
      id: 'ensemble-claude',
      provider: 'claude',
      enabled: true,
      role: 'Planner',
      instructions: 'Plan.',
      order: 2,
      permissionPresetId: 'read_only'
    }
  ]

  const CONTINUOUS_QUARTET: EnsembleParticipant[] = [
    ...CONTINUOUS_PAIR,
    {
      id: 'ensemble-grok',
      provider: 'grok',
      enabled: true,
      role: 'Scout',
      instructions: 'Scout.',
      order: 3,
      permissionPresetId: 'read_only'
    },
    {
      id: 'ensemble-cursor',
      provider: 'cursor',
      enabled: true,
      role: 'Reviewer',
      instructions: 'Review.',
      order: 4,
      permissionPresetId: 'read_only'
    }
  ]

  const CONTINUOUS_BACKGROUND: EnsembleParticipant = {
    id: 'ensemble-background',
    provider: 'kimi',
    enabled: true,
    role: 'Background checker',
    instructions: 'Run the detached check.',
    order: 5,
    permissionPresetId: 'read_only',
    stageRole: 'background'
  }

  const continuousForegroundRuns = (harness: ReturnType<typeof makeHarness>): AgentRunPayload[] =>
    harness.dispatched.filter((run) => !run.ensembleRun?.laneId)

  const continuousLimitStatuses = (
    harness: ReturnType<typeof makeHarness>,
    limit = 6
  ): ChatMessage[] =>
    harness.chat.messages.filter((message) =>
      new RegExp(`Continuous handoff limit reached \\(${limit}/${limit}\\)`).test(
        message.content || ''
      )
    )

  function completeLatestContinuousForeground(harness: ReturnType<typeof makeHarness>): void {
    const runs = continuousForegroundRuns(harness)
    const run = runs[runs.length - 1]
    harness.orchestrator.handleProviderOutput(
      run.provider,
      { appRunId: run.appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: `${run.provider} made progress.` }
    )
    harness.orchestrator.handleProviderOutput(
      run.provider,
      { appRunId: run.appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
  }

  async function advanceContinuousForegroundTo(
    harness: ReturnType<typeof makeHarness>,
    targetCount: number
  ): Promise<void> {
    while (continuousForegroundRuns(harness).length < targetCount) {
      const expectedCount = continuousForegroundRuns(harness).length + 1
      completeLatestContinuousForeground(harness)
      await vi.waitFor(() => expect(continuousForegroundRuns(harness)).toHaveLength(expectedCount))
    }
  }

  async function startContinuousQuartet(
    harness: ReturnType<typeof makeHarness>,
    withBackground = false
  ): Promise<number | undefined> {
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.maxContinuationHops = 6
    // Leave the foreground rotation without an active Boss so this helper
    // exercises the deferred drain itself; authority-ring ownership has its
    // dedicated regression below.
    harness.chat.ensemble!.bossmanParticipantId = 'ensemble-background'
    harness.chat.ensemble!.participants = [
      ...CONTINUOUS_QUARTET.map((participant) => ({ ...participant })),
      ...(withBackground ? [{ ...CONTINUOUS_BACKGROUND }] : [])
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: withBackground
        ? '@BG run a detached check while the foreground roster keeps working.'
        : 'Keep working through the bounded roster.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => {
      expect(continuousForegroundRuns(harness)).toHaveLength(1)
      expect(harness.dispatched.filter((run) => Boolean(run.ensembleRun?.laneId))).toHaveLength(
        withBackground ? 1 : 0
      )
    })
    if (!withBackground) return undefined
    const backgroundIndex = harness.dispatched.findIndex((run) => Boolean(run.ensembleRun?.laneId))
    expect(backgroundIndex).toBeGreaterThanOrEqual(0)
    return backgroundIndex
  }

  async function holdExhaustedContinuousRoundForBackground(
    harness: ReturnType<typeof makeHarness>
  ): Promise<number> {
    const backgroundIndex = await startContinuousQuartet(harness, true)
    // The detached lane must settle before the serial drain can reach the
    // continuous continuation decision. Finish the initial foreground pass,
    // then model the already-exhausted continuation boundary explicitly.
    await advanceContinuousForegroundTo(harness, 4)
    completeLatestContinuousForeground(harness)
    await vi.waitFor(() =>
      expect(
        harness.chat.messages.some((message) =>
          (message.content || '').includes('Serial queue drained · holding the round open')
        )
      ).toBe(true)
    )
    const runtime = (
      harness.orchestrator as unknown as {
        roundsByChatId: Map<
          string,
          {
            continuationHops: number
            maxContinuationHops: number
            continuationLimitPending?: boolean
          }
        >
      }
    ).roundsByChatId.get('ensemble-chat')!
    runtime.continuationHops = runtime.maxContinuationHops
    runtime.continuationLimitPending = true
    return backgroundIndex!
  }

  it('auto-continues a continuous round with no explicit handoff until the hop budget is exhausted', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.maxContinuationHops = 2
    harness.chat.ensemble!.participants = CONTINUOUS_PAIR.map((p) => ({ ...p }))
    const answerLatest = async (waitForLen?: number): Promise<void> => {
      const run = harness.dispatched[harness.dispatched.length - 1]
      harness.orchestrator.handleProviderOutput(
        run.provider,
        { appRunId: run.appRunId, appChatId: 'ensemble-chat' },
        { type: 'content', text: `${run.provider} made progress.` }
      )
      harness.orchestrator.handleProviderOutput(
        run.provider,
        { appRunId: run.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
      if (waitForLen) await vi.waitFor(() => expect(harness.dispatched.length).toBe(waitForLen))
    }

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Keep working.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    await answerLatest(2) // pass 1: codex → claude
    await answerLatest(3) // drain → NO handoff → auto-continue pass 2: codex
    await answerLatest(4) // pass 2: codex → claude
    await answerLatest() // drain → hop budget exhausted → stop

    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    expect(harness.dispatched).toHaveLength(4)
    expect(harness.chat.ensemble?.activeRound?.continuationHops).toBe(2)
    expect(harness.chat.messages.some((m) => /limit reached \(2\/2\)/.test(m.content || ''))).toBe(
      true
    )
  })

  it('repeats only the automatic Scout fan-out on a continuous continuation pass', async () => {
    const harness = makeHarness({ probeParticipant: async () => ({ reachable: true }) })
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.maxContinuationHops = 3
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    harness.chat.ensemble!.participants = [
      {
        id: 'claude-scout',
        provider: 'claude',
        enabled: true,
        role: 'Scout A',
        instructions: 'Inspect the workspace.',
        order: 1,
        permissionPresetId: 'read_only',
        stageRole: 'scout'
      },
      {
        id: 'grok-scout',
        provider: 'grok',
        enabled: true,
        role: 'Scout B',
        instructions: 'Independently inspect the workspace.',
        order: 2,
        permissionPresetId: 'read_only',
        stageRole: 'scout'
      },
      {
        id: 'codex-worker',
        provider: 'codex',
        enabled: true,
        role: 'Worker',
        instructions: 'Implement the next step.',
        order: 3,
        permissionPresetId: 'workspace_write',
        stageRole: 'worker'
      }
    ]
    const completeWithProgress = (payload: AgentRunPayload): void => {
      harness.orchestrator.handleProviderOutput(
        payload.provider,
        { appRunId: payload.appRunId, appChatId: 'ensemble-chat' },
        { type: 'content', text: `${payload.provider} made progress.` }
      )
      harness.orchestrator.handleProviderOutput(
        payload.provider,
        { appRunId: payload.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
    }

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Scout, then implement until the round completes.',
      event: { sender: {} as Electron.WebContents }
    })

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    const initialScouts = harness.dispatched.slice(0, 2)
    expect(initialScouts.map((payload) => payload.ensembleRun?.participantId)).toEqual([
      'claude-scout',
      'grok-scout'
    ])
    expect(initialScouts.every((payload) => Boolean(payload.ensembleRun?.laneId))).toBe(true)
    expect(harness.probeParticipant!).toHaveBeenCalledTimes(3)

    for (const payload of initialScouts) completeWithProgress(payload)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[2].ensembleRun?.participantId).toBe('codex-worker')
    expect(harness.dispatched[2].ensembleRun?.laneId).toBeUndefined()

    completeWithProgress(harness.dispatched[2])
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(5))
    const continuationScouts = harness.dispatched.slice(3, 5)
    expect(continuationScouts.map((payload) => payload.ensembleRun?.participantId)).toEqual([
      'claude-scout',
      'grok-scout'
    ])
    expect(continuationScouts.every((payload) => Boolean(payload.ensembleRun?.laneId))).toBe(true)
    // Continuations repeat the fresh Scout pass, but retain the one-time
    // health probe rather than treating every pass like a new user round.
    expect(harness.probeParticipant!).toHaveBeenCalledTimes(3)

    for (const payload of continuationScouts) completeWithProgress(payload)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(6))
    expect(harness.dispatched[5].ensembleRun?.participantId).toBe('codex-worker')
    expect(harness.dispatched[5].ensembleRun?.laneId).toBeUndefined()

    completeWithProgress(harness.dispatched[5])
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    expect(harness.chat.ensemble?.activeRound?.continuationHops).toBe(3)
    expect(
      harness.chat.messages.filter((message) =>
        message.content?.startsWith(
          'Automatic read stage · 2 participant(s) dispatched concurrently'
        )
      )
    ).toHaveLength(2)
  })

  it('dispatches a final partial continuous pass before publishing one terminal hop-limit status', async () => {
    const harness = makeHarness()
    await startContinuousQuartet(harness)

    // Initial four-seat pass, then one full four-seat continuation pass.
    await advanceContinuousForegroundTo(harness, 9)

    // Only two of the four seats fit in the remaining hop budget. The partial
    // pass must start before TaskWraith claims control is returning to the user.
    expect(
      continuousForegroundRuns(harness)
        .slice(8)
        .map((run) => run.ensembleRun?.participantId)
    ).toEqual(['ensemble-codex'])
    expect(continuousLimitStatuses(harness)).toHaveLength(0)

    await advanceContinuousForegroundTo(harness, 10)
    expect(
      continuousForegroundRuns(harness)
        .slice(8)
        .map((run) => run.ensembleRun?.participantId)
    ).toEqual(['ensemble-codex', 'ensemble-claude'])
    expect(continuousLimitStatuses(harness)).toHaveLength(0)

    completeLatestContinuousForeground(harness)
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))

    expect(harness.dispatched).toHaveLength(10)
    expect(harness.chat.ensemble?.activeRound?.continuationHops).toBe(6)
    expect(continuousLimitStatuses(harness)).toHaveLength(1)
    const messageContents = harness.chat.messages.map((message) => message.content || '')
    const partialPassStatusIndex = messageContents.findIndex((content) =>
      content.includes('auto-continuing for pass 3 (6/6 hops)')
    )
    const limitStatusIndex = messageContents.findIndex((content) =>
      content.includes('Continuous handoff limit reached (6/6)')
    )
    expect(partialPassStatusIndex).toBeGreaterThanOrEqual(0)
    expect(limitStatusIndex).toBeGreaterThan(partialPassStatusIndex)
  })

  it('defers a hop-limit notice when a final partial-pass participant yields to an answered seat', async () => {
    const harness = makeHarness()
    await startContinuousQuartet(harness)
    await advanceContinuousForegroundTo(harness, 9)

    const finalPartialCodex = continuousForegroundRuns(harness)[8]
    expect(finalPartialCodex.ensembleRun?.participantId).toBe('ensemble-codex')
    expectYielded(
      harness.orchestrator.markYielded(
        finalPartialCodex.appRunId!,
        'Scout should take another look.',
        'Scout'
      )
    )

    // Grok already answered and the hop budget is exhausted, so the directed
    // extra turn is correctly rejected. Claude was already admitted to the
    // partial pass and must still settle before the terminal notice appears.
    await vi.waitFor(() => expect(continuousForegroundRuns(harness)).toHaveLength(10))
    expect(continuousForegroundRuns(harness)[9].ensembleRun?.participantId).toBe('ensemble-claude')
    expect(
      harness.dispatched.filter((run) => run.ensembleRun?.participantId === 'ensemble-grok')
    ).toHaveLength(2)
    expect(
      harness.chat.messages.some((message) =>
        (message.content || '').includes('Yield target "Scout" was not routed: hop_limit')
      )
    ).toBe(true)
    expect(continuousLimitStatuses(harness)).toHaveLength(0)

    completeLatestContinuousForeground(harness)
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))

    expect(harness.dispatched).toHaveLength(10)
    expect(continuousLimitStatuses(harness)).toHaveLength(1)
  })

  it('publishes the terminal hop-limit status only after an unresolved BG lane settles', async () => {
    const harness = makeHarness()
    const backgroundIndex = await holdExhaustedContinuousRoundForBackground(harness)

    expect(harness.chat.ensemble?.activeRound?.status).toBe('running')
    expect(continuousLimitStatuses(harness)).toHaveLength(0)

    completeDispatchedRun(harness, backgroundIndex)
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    expect(continuousLimitStatuses(harness)).toHaveLength(1)
  })

  it('auto-continues continuous mode after a deferred BG lane settles with hops remaining', async () => {
    // Regression: maybeResumeDeferredDrain used to skip tryAutoContinueRound
    // unless allowAutoContinuation was set (owned settlement only). Detached
    // BG / Review-wave-adjacent resumes then finalized the round as Task
    // Complete while Continuous still had hops left.
    const harness = makeHarness()
    const backgroundIndex = await startContinuousQuartet(harness, true)
    expect(typeof backgroundIndex).toBe('number')

    await advanceContinuousForegroundTo(harness, 4)
    const foregroundBeforeDrain = continuousForegroundRuns(harness).length
    completeLatestContinuousForeground(harness)
    await vi.waitFor(() =>
      expect(
        harness.chat.messages.some((message) =>
          (message.content || '').includes('Serial queue drained · holding the round open')
        )
      ).toBe(true)
    )
    expect(harness.chat.ensemble?.activeRound?.status).toBe('running')
    expect(harness.chat.ensemble?.activeRound?.continuationHops || 0).toBe(0)

    completeDispatchedRun(harness, backgroundIndex!)
    await vi.waitFor(() =>
      expect(continuousForegroundRuns(harness).length).toBeGreaterThan(foregroundBeforeDrain)
    )
    expect(
      harness.chat.messages.some(
        (message) =>
          typeof message.content === 'string' &&
          message.content.includes('auto-continuing for pass 2')
      )
    ).toBe(true)
    expect(harness.chat.ensemble?.activeRound?.status).toBe('running')
    expect(harness.chat.ensemble?.activeRound?.continuationHops || 0).toBeGreaterThan(0)
  })

  it('rejects a stale continuation before publishing a pass or awaiting seat compaction', async () => {
    const compactionGate = deferred<unknown>()
    let blockOnCompaction = false
    const harness = makeHarness({
      awaitPendingSeatCompaction: () => (blockOnCompaction ? compactionGate.promise : undefined)
    })
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.maxContinuationHops = 50
    harness.chat.ensemble!.participants = CONTINUOUS_PAIR.map((participant) => ({
      ...participant
    }))
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Do not revive this round after it closes.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const io = harness.orchestrator as unknown as {
      roundsByChatId: Map<
        string,
        {
          continuationHops: number
          continuationPass: number
        }
      >
      tryAutoContinueRound: (runtime: object, chat: ChatRecord) => EnsembleParticipant[] | null
      runRound: (
        runtime: object,
        participants: EnsembleParticipant[],
        options?: { skipPreamble?: boolean }
      ) => Promise<void>
    }
    const runtime = io.roundsByChatId.get('ensemble-chat')!
    const round = harness.chat.ensemble!.activeRound!
    harness.chat.ensemble!.activeRound = {
      ...round,
      status: 'completed',
      endedAt: '2026-05-24T00:01:00.000Z',
      participants: round.participants.map((participant) => ({
        ...participant,
        status: 'answered' as const
      }))
    }
    io.roundsByChatId.delete('ensemble-chat')
    const hopsBefore = runtime.continuationHops
    const passBefore = runtime.continuationPass
    const messagesBefore = harness.chat.messages.length

    expect(io.tryAutoContinueRound.call(harness.orchestrator, runtime, harness.chat)).toBeNull()
    expect(runtime.continuationHops).toBe(hopsBefore)
    expect(runtime.continuationPass).toBe(passBefore)
    expect(harness.chat.messages).toHaveLength(messagesBefore)

    // This is the observed freeze seam: a stale run used to enter the pending
    // compaction wait before its first exact ownership check.
    blockOnCompaction = true
    const staleRun = io.runRound.call(
      harness.orchestrator,
      runtime,
      [harness.chat.ensemble!.participants[0]],
      { skipPreamble: true }
    )
    const outcome = await Promise.race([
      staleRun.then(() => 'returned' as const),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 20))
    ])
    compactionGate.resolve(undefined)
    await staleRun
    expect(outcome).toBe('returned')
    expect(harness.dispatched).toHaveLength(1)
  })

  it('holds a drained round for owner settlement after its fan-out lane turns terminal', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Keep the round open through owner cleanup.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const io = harness.orchestrator as unknown as {
      roundsByChatId: Map<string, object>
      runsByRunId: Map<string, { ownedFanoutSettlements?: Set<Promise<void>> }>
      deferredLaneDrainByChatId: Map<string, object>
      deferDrainForActiveLanes: (runtime: object) => boolean
    }
    const runtime = io.roundsByChatId.get('ensemble-chat')!
    const owner = io.runsByRunId.get(harness.dispatched[0].appRunId!)!
    owner.ownedFanoutSettlements = new Set([Promise.resolve()])

    expect(io.deferDrainForActiveLanes.call(harness.orchestrator, runtime)).toBe(true)
    expect(io.deferredLaneDrainByChatId.get('ensemble-chat')).toBe(runtime)
    expect(
      harness.chat.messages.some((message) =>
        (message.content || '').includes('pending fan-out settlement(s)')
      )
    ).toBe(true)

    owner.ownedFanoutSettlements = undefined
    io.deferredLaneDrainByChatId.delete('ensemble-chat')
    await harness.orchestrator.cancelRound('ensemble-chat', 'test cleanup')
  })

  it('suppresses a pending terminal hop-limit status when the held round is cancelled', async () => {
    const harness = makeHarness()
    await holdExhaustedContinuousRoundForBackground(harness)

    expect(continuousLimitStatuses(harness)).toHaveLength(0)
    expect(await harness.orchestrator.cancelRound('ensemble-chat')).toBe(true)
    expect(harness.chat.ensemble?.activeRound?.status).toBe('cancelled')
    expect(continuousLimitStatuses(harness)).toHaveLength(0)
  })

  it('does not auto-continue a continuous round once the active goal is marked complete', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.maxContinuationHops = 50 // plenty of hops remain
    harness.chat.activeGoal = { ...buildActiveGoal('goal-done'), status: 'completed' }
    harness.chat.ensemble!.participants = CONTINUOUS_PAIR.map((p) => ({ ...p }))
    const answerLatest = async (waitForLen?: number): Promise<void> => {
      const run = harness.dispatched[harness.dispatched.length - 1]
      harness.orchestrator.handleProviderOutput(
        run.provider,
        { appRunId: run.appRunId, appChatId: 'ensemble-chat' },
        { type: 'content', text: `${run.provider} did work.` }
      )
      harness.orchestrator.handleProviderOutput(
        run.provider,
        { appRunId: run.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
      if (waitForLen) await vi.waitFor(() => expect(harness.dispatched.length).toBe(waitForLen))
    }

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Finish up.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    await answerLatest(2)
    await answerLatest()
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    // Goal already complete → no second pass despite the hop budget.
    expect(harness.dispatched).toHaveLength(2)
    expect(harness.chat.ensemble?.activeRound?.continuationHops || 0).toBe(0)
  })

  it('does not auto-continue a continuous round that produced no content (no-progress guard)', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.maxContinuationHops = 50 // hops remain, but nobody spoke
    harness.chat.ensemble!.participants = CONTINUOUS_PAIR.map((p) => ({ ...p }))
    const skipLatest = async (waitForLen?: number): Promise<void> => {
      const run = harness.dispatched[harness.dispatched.length - 1]
      // result with NO content → finalized 'skipped'
      harness.orchestrator.handleProviderOutput(
        run.provider,
        { appRunId: run.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
      if (waitForLen) await vi.waitFor(() => expect(harness.dispatched.length).toBe(waitForLen))
    }

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Nothing to do.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    await skipLatest(2)
    await skipLatest()
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    // Whole pass was 'skipped' → don't spin another empty pass.
    expect(harness.dispatched).toHaveLength(2)
    expect(harness.chat.ensemble?.activeRound?.continuationHops || 0).toBe(0)
  })

  it('a queued user prompt wins over continuous auto-continuation at drain', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.maxContinuationHops = 50
    harness.chat.ensemble!.participants = CONTINUOUS_PAIR.map((p) => ({ ...p }))
    const answerLatest = async (waitForLen?: number): Promise<void> => {
      const run = harness.dispatched[harness.dispatched.length - 1]
      harness.orchestrator.handleProviderOutput(
        run.provider,
        { appRunId: run.appRunId, appChatId: 'ensemble-chat' },
        { type: 'content', text: `${run.provider} did work.` }
      )
      harness.orchestrator.handleProviderOutput(
        run.provider,
        { appRunId: run.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
      if (waitForLen) await vi.waitFor(() => expect(harness.dispatched.length).toBe(waitForLen))
    }

    const firstRound = harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'First round.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    // User queues a follow-up mid-round — absorbed into the same round at the
    // next speaker boundary (never a fresh beginRound).
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'User follow-up.',
      event: { sender: {} as Electron.WebContents },
      mode: 'queue'
    })
    await answerLatest(2)
    expect(harness.chat.messages.map((message) => message.content)).toContain('User follow-up.')
    expect(harness.dispatched[1].prompt).toContain('User follow-up.')
    expect(harness.chat.ensemble?.activeRound?.roundId).toBe(firstRound.roundId)
    expect(harness.chat.ensemble?.activeRound?.prompt).toBe('First round.')
    // Remaining seat finishes; follow-up already absorbed, so continuous must
    // not open a replacement round identity.
    await answerLatest()
    await vi.waitFor(() =>
      expect(harness.chat.ensemble?.activeRound?.roundId).toBe(firstRound.roundId)
    )
  })

  it('a user cancel wins over continuous auto-continuation at drain', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.maxContinuationHops = 50
    harness.chat.ensemble!.participants = CONTINUOUS_PAIR.map((p) => ({ ...p }))

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Work then get stopped.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const first = harness.dispatched[0]
    harness.orchestrator.handleProviderOutput(
      first.provider,
      { appRunId: first.appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'codex did work.' }
    )
    harness.orchestrator.handleProviderOutput(
      first.provider,
      { appRunId: first.appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    // Stop the round while claude is speaking.
    await harness.orchestrator.cancelRound('ensemble-chat', 'cancelled')
    await new Promise((r) => setTimeout(r, 20))
    expect(harness.chat.ensemble?.activeRound?.status).toBe('cancelled')
    expect(harness.dispatched).toHaveLength(2) // no auto-continue pass after a cancel
  })

  it('does not auto-continue a continuous round once the active goal is blocked', async () => {
    // An agent calling goal_blocked (status 'blocked') hands control back to the
    // user — the round must NOT keep spinning the roster to the hop cap.
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.maxContinuationHops = 50
    harness.chat.activeGoal = { ...buildActiveGoal('goal-blocked'), status: 'blocked' }
    harness.chat.ensemble!.participants = CONTINUOUS_PAIR.map((p) => ({ ...p }))
    const answerLatest = async (waitForLen?: number): Promise<void> => {
      const run = harness.dispatched[harness.dispatched.length - 1]
      harness.orchestrator.handleProviderOutput(
        run.provider,
        { appRunId: run.appRunId, appChatId: 'ensemble-chat' },
        { type: 'content', text: `${run.provider} is blocked.` }
      )
      harness.orchestrator.handleProviderOutput(
        run.provider,
        { appRunId: run.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
      if (waitForLen) await vi.waitFor(() => expect(harness.dispatched.length).toBe(waitForLen))
    }

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Try the blocked task.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    await answerLatest(2)
    await answerLatest()
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    expect(harness.dispatched).toHaveLength(2)
    expect(harness.chat.ensemble?.activeRound?.continuationHops || 0).toBe(0)
  })

  it('auto-continues a continuous round after an explicit yield resolves (goal active)', async () => {
    // Coverage: a mid-pass explicit yield must NOT suppress auto-continuation —
    // once the yield resolves and the pass drains, the round keeps going.
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.maxContinuationHops = 2
    harness.chat.activeGoal = { ...buildActiveGoal('goal-active') } // status 'active' → continue
    harness.chat.ensemble!.participants = CONTINUOUS_PAIR.map((p) => ({ ...p }))
    const answerLatest = async (waitForLen?: number): Promise<void> => {
      const run = harness.dispatched[harness.dispatched.length - 1]
      harness.orchestrator.handleProviderOutput(
        run.provider,
        { appRunId: run.appRunId, appChatId: 'ensemble-chat' },
        { type: 'content', text: `${run.provider} worked.` }
      )
      harness.orchestrator.handleProviderOutput(
        run.provider,
        { appRunId: run.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
      if (waitForLen) await vi.waitFor(() => expect(harness.dispatched.length).toBe(waitForLen))
    }

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Collaborate.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1)) // codex
    // codex explicitly yields to claude (the next serial participant → reorder,
    // no hop consumed).
    harness.orchestrator.markYielded(harness.dispatched[0].appRunId!, 'Over to Claude', 'claude')
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2)) // claude
    await answerLatest(3) // claude done → drain → auto-continue pass: codex
    await answerLatest(4) // codex → claude (pass 2)
    await answerLatest() // drain → hop budget (2) exhausted → stop
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    // The explicit yield did not stop auto-continuation: a full second pass ran.
    expect(harness.dispatched).toHaveLength(4)
    expect(harness.chat.ensemble?.activeRound?.continuationHops).toBe(2)
  })

  // C4 — administrative-idle-consensus terminal condition. `tryAutoContinueRound`
  // must STOP (escalate to Captain/user) rather than burn another pass when a whole
  // pass is an idle consensus (every seat yielded, no answered/sleeping work), there
  // is no pending assignment, and completion authority is unreachable (the Boss
  // yielded yet stays "available", so the Captain is stuck on standby). These reach
  // the private decision function directly (mirroring the terminal-status test
  // above) so the exact predicate is exercised without racing the async loop into a
  // deadlock. Boss = codex, Captain (standby) = claude.
  const c4Internals = (orchestrator: EnsembleOrchestrator) =>
    orchestrator as unknown as {
      roundsByChatId: Map<
        string,
        {
          continuationHops: number
          administrativeIdleEscalated?: boolean
          queuedPrompts: unknown[]
        }
      >
      tryAutoContinueRound: (runtime: object, chat: ChatRecord) => EnsembleParticipant[] | null
    }

  const makeC4Round = async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.maxContinuationHops = 50 // plenty of hops remain
    harness.chat.ensemble!.bossmanParticipantId = 'codex'
    harness.chat.ensemble!.secondInCommandParticipantId = 'claude'
    harness.chat.activeGoal = { ...buildActiveGoal('goal-c4') } // active, non-terminal
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Keep going.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const internals = c4Internals(harness.orchestrator)
    const runtime = internals.roundsByChatId.get('ensemble-chat')
    expect(runtime).toBeTruthy()
    const tryAutoContinue = internals.tryAutoContinueRound.bind(harness.orchestrator)
    const setStatuses = (statuses: Record<string, EnsembleParticipantStatus>): void => {
      const round = harness.chat.ensemble!.activeRound!
      harness.chat.ensemble!.activeRound = {
        ...round,
        participants: round.participants.map((participant) => ({
          ...participant,
          status: statuses[participant.participantId] ?? participant.status
        }))
      }
    }
    const deadlockAnnounced = (): boolean =>
      harness.chat.messages.some((message) =>
        /administrative deadlock/i.test(message.content || '')
      )
    return { harness, runtime: runtime!, tryAutoContinue, setStatuses, deadlockAnnounced }
  }

  it('C4: escalates and STOPS on an idle-consensus pass with an unreachable (yielded) Boss', async () => {
    const { harness, runtime, tryAutoContinue, setStatuses, deadlockAnnounced } =
      await makeC4Round()
    // Whole panel yielded — the lived deadlock: Boss (codex) yielded control so it
    // won't self-complete, yet is still classified available ⇒ Captain standby.
    setStatuses({ codex: 'yielded', claude: 'yielded' })
    const result = tryAutoContinue(runtime, harness.chat)
    expect(result).toBeNull() // terminal: do NOT re-dispatch the roster
    expect(runtime.continuationHops).toBe(0) // and did NOT burn a continuation hop
    expect(runtime.administrativeIdleEscalated).toBe(true)
    expect(deadlockAnnounced()).toBe(true)
  })

  it('C4: does NOT escalate on the same idle pass while a pending assignment has real work', async () => {
    const { harness, runtime, tryAutoContinue, setStatuses, deadlockAnnounced } =
      await makeC4Round()
    // A still-actionable assignment is concrete pending work — status alone is not
    // enough to call it idle; the round must keep rotating so its owner can act.
    harness.chat.ensemble!.bossmanControlState = {
      assignments: [
        {
          id: 'a1',
          participantId: 'codex',
          objective: 'finish the slice',
          status: 'open',
          createdAt: '2026-05-24T00:00:00.000Z',
          updatedAt: '2026-05-24T00:00:00.000Z'
        }
      ]
    }
    setStatuses({ codex: 'yielded', claude: 'yielded' })
    const result = tryAutoContinue(runtime, harness.chat)
    expect(result).not.toBeNull() // keeps rotating
    expect(result!.length).toBeGreaterThan(0)
    expect(runtime.administrativeIdleEscalated).toBeFalsy()
    expect(deadlockAnnounced()).toBe(false)
  })

  it('C4: does NOT escalate when a user steer is queued (an active user steer is never a deadlock)', async () => {
    const { harness, runtime, tryAutoContinue, setStatuses, deadlockAnnounced } =
      await makeC4Round()
    runtime.queuedPrompts = [{ id: 'q1', prompt: 'do this next' }]
    setStatuses({ codex: 'yielded', claude: 'yielded' })
    const result = tryAutoContinue(runtime, harness.chat)
    expect(result).not.toBeNull()
    expect(runtime.administrativeIdleEscalated).toBeFalsy()
    expect(deadlockAnnounced()).toBe(false)
  })

  it('C4: does NOT escalate when a seat produced real work this pass (incomplete goal, real progress)', async () => {
    const { harness, runtime, tryAutoContinue, setStatuses, deadlockAnnounced } =
      await makeC4Round()
    // Claude answered — a productive turn. A single ordinary Boss yield amid real
    // work must not read as unavailability, so the round keeps going.
    setStatuses({ codex: 'yielded', claude: 'answered' })
    const result = tryAutoContinue(runtime, harness.chat)
    expect(result).not.toBeNull()
    expect(runtime.administrativeIdleEscalated).toBeFalsy()
    expect(deadlockAnnounced()).toBe(false)
  })

  it('C4: does NOT escalate when the Boss is genuinely unavailable (Captain can then take authority)', async () => {
    const { harness, runtime, tryAutoContinue, setStatuses, deadlockAnnounced } =
      await makeC4Round()
    // Boss 'skipped' ⇒ primaryBossUnavailable ⇒ the Captain CAN take authority, so
    // completion is reachable: continue and let promotion happen, don't dead-stop.
    setStatuses({ codex: 'skipped', claude: 'yielded' })
    const result = tryAutoContinue(runtime, harness.chat)
    expect(result).not.toBeNull()
    expect(runtime.administrativeIdleEscalated).toBeFalsy()
    expect(deadlockAnnounced()).toBe(false)
  })

  it('resolves turn-bound yield targets by model alias', () => {
    const remaining: EnsembleParticipant[] = [
      {
        id: 'ensemble-codex',
        provider: 'codex',
        enabled: true,
        role: 'Worker',
        instructions: 'Work.',
        order: 1,
        model: 'gpt-5.5',
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'ensemble-claude',
        provider: 'claude',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review.',
        order: 2,
        model: 'claude-sonnet-4-7',
        permissionPresetId: 'read_only'
      }
    ]

    expect(resolveYieldTargetIndex(remaining, 'Sonnet 4.7')).toBe(1)
    expect(resolveYieldTargetIndex(remaining, 'GPT-5.5')).toBe(0)
    expect(resolveYieldTargetIndex(remaining, '@GPT-5.5')).toBe(0)
  })

  it('rejects ambiguous same-provider yield targets', () => {
    const remaining: EnsembleParticipant[] = [
      {
        id: 'ensemble-codex-main',
        provider: 'codex',
        enabled: true,
        role: 'MainWorker',
        instructions: 'Main work.',
        order: 1,
        model: 'gpt-5.5',
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'ensemble-codex-review',
        provider: 'codex',
        enabled: true,
        role: 'AdvReview',
        instructions: 'Review.',
        order: 2,
        model: 'gpt-5.4-mini',
        permissionPresetId: 'read_only'
      }
    ]

    expect(resolveYieldTargetIndex(remaining, 'codex')).toBe(-1)
    expect(resolveYieldTargetIndex(remaining, '@codex')).toBe(-1)
    expect(resolveYieldTargetIndex(remaining, 'MainWorker')).toBe(0)
    expect(resolveYieldTargetIndex(remaining, '@AdvReview')).toBe(1)
    expect(resolveYieldTargetIndex(remaining, 'GPT 5.5')).toBe(0)
  })

  it('promotes a Boss yield target already present later in the remaining queue', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.bossmanParticipantId = 'ensemble-claude'
    harness.chat.ensemble!.participants = [
      {
        id: 'ensemble-claude',
        provider: 'claude',
        enabled: true,
        role: 'Planner',
        instructions: 'Plan.',
        order: 1,
        permissionPresetId: 'read_only'
      },
      {
        id: 'ensemble-gemini',
        provider: 'gemini',
        enabled: true,
        role: 'Researcher',
        instructions: 'Research.',
        order: 2,
        permissionPresetId: 'read_only'
      },
      {
        id: 'ensemble-codex',
        provider: 'codex',
        enabled: true,
        role: 'Worker',
        instructions: 'Work.',
        order: 3,
        permissionPresetId: 'workspace_write'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan then hand straight to Codex.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const outcome = harness.orchestrator.markYielded(
      harness.dispatched[0].appRunId!,
      'Plan complete',
      'codex'
    )
    expect(outcome).toMatchObject({
      kind: 'yielded',
      routing: { ok: true, action: 'promoted', targetParticipantId: 'ensemble-codex' }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('codex')
  })

  it('rejects ambiguous same-provider yield targets with tool-visible failure', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.bossmanParticipantId = 'ensemble-codex-main'
    harness.chat.ensemble!.participants = [
      {
        id: 'ensemble-codex-main',
        provider: 'codex',
        enabled: true,
        role: 'MainWorker',
        instructions: 'Main work.',
        order: 1,
        model: 'gpt-5.5',
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'ensemble-codex-review',
        provider: 'codex',
        enabled: true,
        role: 'AdvReview',
        instructions: 'Review.',
        order: 2,
        model: 'gpt-5.4-mini',
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Route explicitly.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const outcome = harness.orchestrator.markYielded(
      harness.dispatched[0].appRunId!,
      'Need the other codex seat.',
      'codex'
    )
    expect(outcome).toMatchObject({
      kind: 'yielded',
      routing: { ok: false, reason: 'ambiguous', target: 'codex' }
    })
  })

  it('does not append an extra turn when @-tagging a participant who already reached a terminal status', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    // Pre-completed goal disables auto-continuation to isolate the @-mention
    // terminal-status mechanics under test (see the note on the first such test).
    harness.chat.activeGoal = { ...buildActiveGoal('goal-continuous'), status: 'completed' }
    harness.chat.ensemble!.participants = [
      {
        id: 'ensemble-claude',
        provider: 'claude',
        enabled: true,
        role: 'Planner',
        instructions: 'Plan.',
        order: 1,
        permissionPresetId: 'read_only'
      },
      {
        id: 'ensemble-codex',
        provider: 'codex',
        enabled: true,
        role: 'Worker',
        instructions: 'Work.',
        order: 2,
        permissionPresetId: 'workspace_write'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Quick back and forth.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].provider).toBe('claude')

    // Claude finishes without an @-mention.
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 10 } }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('codex')

    // Codex finishes and mentions @Planner — Claude already answered
    // earlier in this round, so no extra turn should be appended.
    const codexRoute = {
      appRunId: harness.dispatched[1].appRunId,
      appChatId: 'ensemble-chat'
    }
    harness.orchestrator.handleProviderOutput('codex', codexRoute, {
      type: 'content',
      text: 'Need clarification, calling on @Planner.'
    })
    harness.orchestrator.handleProviderOutput('codex', codexRoute, {
      type: 'result',
      status: 'success',
      stats: { total_tokens: 10 }
    })

    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    expect(harness.dispatched).toHaveLength(2)
    expect(harness.chat.ensemble?.activeRound?.continuationHops || 0).toBe(0)
  })

  it('does not append an extra turn when turn-bound @mention targets an already-spoken participant', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'ensemble-claude',
        provider: 'claude',
        enabled: true,
        role: 'Planner',
        instructions: 'Plan.',
        order: 1,
        permissionPresetId: 'read_only'
      },
      {
        id: 'ensemble-codex',
        provider: 'codex',
        enabled: true,
        role: 'Worker',
        instructions: 'Work.',
        order: 2,
        permissionPresetId: 'workspace_write'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'One pass only.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 10 } }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'Need clarification, calling on @Planner.' }
    )
    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 10 } }
    )

    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    expect(harness.dispatched).toHaveLength(2)
    expect(harness.chat.ensemble?.activeRound?.continuationHops || 0).toBe(0)
    expect(
      harness.chat.messages.some(
        (message) =>
          message.metadata?.kind === 'ensembleRoundStatus' &&
          message.content.includes('already spoke in this turn-bound round')
      )
    ).toBe(true)
  })

  it('does not let yield plus @mention bypass turn-bound for an already-spoken participant', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'ensemble-claude',
        provider: 'claude',
        enabled: true,
        role: 'Planner',
        instructions: 'Plan.',
        order: 1,
        permissionPresetId: 'read_only'
      },
      {
        id: 'ensemble-codex',
        provider: 'codex',
        enabled: true,
        role: 'Worker',
        instructions: 'Work.',
        order: 2,
        permissionPresetId: 'workspace_write'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'One pass only.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 10 } }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

    const codexRoute = {
      appRunId: harness.dispatched[1].appRunId,
      appChatId: 'ensemble-chat'
    }
    harness.orchestrator.handleProviderOutput('codex', codexRoute, {
      type: 'content',
      text: '@Planner please reconcile this.'
    })
    harness.orchestrator.markYielded(harness.dispatched[1].appRunId!, 'Passing back.', 'Planner')

    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    expect(harness.dispatched).toHaveLength(2)
    expect(harness.chat.ensemble?.activeRound?.continuationHops || 0).toBe(0)
  })

  it('does not append continuous continuations for terminal participant statuses', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Check terminal statuses.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const runtime = (
      harness.orchestrator as unknown as {
        roundsByChatId: Map<string, { continuationHops: number; maxContinuationHops: number }>
      }
    ).roundsByChatId.get('ensemble-chat')
    const appendContinuation = (
      harness.orchestrator as unknown as {
        tryAppendContinuationTurn: (
          runtime: object,
          remaining: EnsembleParticipant[],
          participant: EnsembleParticipant,
          statusMessage: string
        ) => { appended: boolean }
      }
    ).tryAppendContinuationTurn.bind(harness.orchestrator)
    const terminalStatuses: EnsembleParticipantStatus[] = [
      'answered',
      'yielded',
      'skipped',
      'cancelled',
      'failed',
      'unreachable'
    ]
    const target = harness.chat.ensemble!.participants[1]

    expect(runtime).toBeTruthy()
    for (const status of terminalStatuses) {
      runtime!.continuationHops = 0
      harness.chat.ensemble!.activeRound = {
        ...harness.chat.ensemble!.activeRound!,
        participants: harness.chat.ensemble!.activeRound!.participants.map((participant) =>
          participant.participantId === target.id
            ? {
                ...participant,
                status
              }
            : participant
        )
      }
      const remaining: EnsembleParticipant[] = []
      expect(
        appendContinuation(
          runtime!,
          remaining,
          target,
          `@-mention: extra turn appended for ${target.role}.`
        ).appended
      ).toBe(false)
      expect(remaining).toEqual([])
      expect(runtime!.continuationHops).toBe(0)
    }
  })

  it('rejects continuous continuation appends at the hop limit without publishing before drain', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.maxContinuationHops = 1
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Bounded continuation.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const runtime = (
      harness.orchestrator as unknown as {
        roundsByChatId: Map<
          string,
          {
            continuationHops: number
            maxContinuationHops: number
            continuationLimitNotified?: boolean
          }
        >
      }
    ).roundsByChatId.get('ensemble-chat')
    expect(runtime).toBeTruthy()
    runtime!.continuationHops = 1
    runtime!.maxContinuationHops = 1

    const appended = (
      harness.orchestrator as unknown as {
        tryAppendContinuationTurn: (
          runtime: object,
          remaining: EnsembleParticipant[],
          participant: EnsembleParticipant,
          statusMessage: string
        ) => { appended: boolean; reason?: string }
      }
    ).tryAppendContinuationTurn(
      runtime!,
      [],
      harness.chat.ensemble!.participants[1],
      '@-mention: extra turn appended for Worker.'
    )

    expect(appended.appended).toBe(false)
    expect(appended.reason).toBe('hop_limit')
    expect(runtime!.continuationLimitNotified).not.toBe(true)
    expect(harness.chat.messages.map((message) => message.content)).not.toContain(
      'Continuous handoff limit reached (1/1); returning control to the user.'
    )
  })

  it('allows configured continuous handoff limits up to 1200', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.maxContinuationHops = 1200

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Use the configured handoff cap.',
      event: { sender: {} as Electron.WebContents }
    })

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.chat.ensemble?.activeRound?.maxContinuationHops).toBe(1200)
  })

  it('does not promote on self-mention (speaker referencing their own role)', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'ensemble-claude',
        provider: 'claude',
        enabled: true,
        role: 'Planner',
        instructions: 'Plan.',
        order: 1,
        permissionPresetId: 'read_only'
      },
      {
        id: 'ensemble-codex',
        provider: 'codex',
        enabled: true,
        role: 'Worker',
        instructions: 'Work.',
        order: 2,
        permissionPresetId: 'workspace_write'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and execute.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    // Claude narrates its own role in its reply — should NOT loop
    // back to Claude.
    const claudeRoute = {
      appRunId: harness.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }
    harness.orchestrator.handleProviderOutput('claude', claudeRoute, {
      type: 'content',
      text: "As @Planner I'd suggest the following…"
    })
    harness.orchestrator.handleProviderOutput('claude', claudeRoute, {
      type: 'result',
      status: 'success',
      stats: { total_tokens: 10 }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    // Default order resumes with Codex; no infinite Claude→Claude loop.
    expect(harness.dispatched[1].provider).toBe('codex')
  })

  it('yields to a named target, skipping intervening participants', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'ensemble-claude',
        provider: 'claude',
        enabled: true,
        role: 'Planner',
        instructions: 'Plan.',
        order: 1,
        permissionPresetId: 'read_only'
      },
      {
        id: 'ensemble-gemini',
        provider: 'gemini',
        enabled: true,
        role: 'Researcher',
        instructions: 'Research.',
        order: 2,
        permissionPresetId: 'read_only'
      },
      {
        id: 'ensemble-codex',
        provider: 'codex',
        enabled: true,
        role: 'Worker',
        instructions: 'Work.',
        order: 3,
        permissionPresetId: 'workspace_write'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan then hand straight to Codex.',
      event: { sender: {} as Electron.WebContents }
    })
    // Claude (planner) goes first.
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].provider).toBe('claude')
    // Claude yields explicitly to Codex (skipping Gemini).
    const claudeRunId = harness.dispatched[0].appRunId!
    harness.orchestrator.markYielded(claudeRunId, 'Plan complete', 'codex')
    // Next dispatch must be Codex, not Gemini.
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('codex')
    // Codex finishes (no yield-target this time) → default ordering
    // resumes with Gemini, who's still in the remaining queue.
    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 10 } }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[2].provider).toBe('gemini')
  })

  it('routes an explicit continuous yield back to a participant who already spoke', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.maxContinuationHops = 24
    harness.chat.ensemble!.bossmanParticipantId = 'boss'
    harness.chat.ensemble!.participants = [
      {
        id: 'grok-tag-a',
        provider: 'grok',
        enabled: true,
        role: 'GrokTagA',
        instructions: 'Answer first.',
        order: 1,
        permissionPresetId: 'read_only'
      },
      {
        id: 'boss',
        provider: 'codex',
        enabled: true,
        role: 'Boss',
        instructions: 'Direct the round.',
        order: 2,
        permissionPresetId: 'default'
      },
      {
        id: 'captain',
        provider: 'claude',
        enabled: true,
        role: 'Captain',
        instructions: 'Wait for the handoff.',
        order: 3,
        permissionPresetId: 'read_only'
      }
    ]

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Exercise a back-reference handoff.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('grok-tag-a')

    harness.orchestrator.handleProviderOutput(
      'grok',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'Initial answer from GrokTagA.' }
    )
    harness.orchestrator.handleProviderOutput(
      'grok',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 10 } }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].ensembleRun?.participantId).toBe('boss')

    expectYielded(
      harness.orchestrator.markYielded(
        harness.dispatched[1].appRunId!,
        'Please check this again.',
        'GrokTagA'
      )
    )

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[2].ensembleRun?.participantId).toBe('grok-tag-a')
    expect(harness.chat.ensemble?.activeRound?.continuationHops).toBe(1)
    expect(
      harness.chat.messages.some(
        (message) =>
          message.metadata?.kind === 'ensembleRoundStatus' &&
          message.content.includes('Yielded back to GrokTagA (grok). Continuous handoff 1/24.')
      )
    ).toBe(true)
  })

  it('lets any foreground participant skip pending authority and re-summon a yielded peer', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.maxContinuationHops = 6
    harness.chat.ensemble!.bossmanParticipantId = 'boss'
    harness.chat.activeGoal = { ...buildActiveGoal('goal-explicit-yield'), status: 'completed' }
    harness.chat.ensemble!.participants = [
      {
        id: 'worker',
        provider: 'codex',
        enabled: true,
        role: 'Worker',
        instructions: 'Do the focused work.',
        order: 1,
        permissionPresetId: 'read_only'
      },
      {
        id: 'boss',
        provider: 'claude',
        enabled: true,
        role: 'Boss',
        instructions: 'Coordinate the panel.',
        order: 2,
        permissionPresetId: 'default'
      },
      {
        id: 'reviewer',
        provider: 'grok',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review the focused work.',
        order: 3,
        permissionPresetId: 'read_only'
      }
    ]

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Run only the seats the handoffs select.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('worker')

    const skipBoss = harness.orchestrator.markYielded(
      harness.dispatched[0].appRunId!,
      'Reviewer should inspect this before the Boss needs a turn.',
      'Reviewer'
    )
    expect(skipBoss).toMatchObject({
      kind: 'yielded',
      routing: { ok: true, action: 'promoted', targetParticipantId: 'reviewer' }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].ensembleRun?.participantId).toBe('reviewer')

    const returnToYieldedWorker = harness.orchestrator.markYielded(
      harness.dispatched[1].appRunId!,
      'Worker needs to action this review.',
      'Worker'
    )
    expect(returnToYieldedWorker).toMatchObject({
      kind: 'yielded',
      routing: { ok: true, action: 'resummoned', targetParticipantId: 'worker' }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[2].ensembleRun?.participantId).toBe('worker')
    expect(harness.chat.ensemble?.activeRound?.continuationHops).toBe(1)
  })

  it('auto-returns to the yielding participant after a yielded target answers', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    // Pre-completed goal disables auto-continuation to isolate the yield-return
    // mechanics under test (see the note on the first such test).
    harness.chat.activeGoal = { ...buildActiveGoal('goal-continuous'), status: 'completed' }
    harness.chat.ensemble!.participants = [
      {
        id: 'typecheckz',
        provider: 'claude',
        enabled: true,
        role: 'TypeCheckz',
        instructions: 'Gate.',
        order: 1,
        permissionPresetId: 'read_only'
      },
      {
        id: 'fixman',
        provider: 'codex',
        enabled: true,
        role: 'Fixman',
        instructions: 'Repair.',
        order: 2,
        permissionPresetId: 'workspace_write'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Gate and repair.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('typecheckz')

    expectYielded(
      harness.orchestrator.markYielded(harness.dispatched[0].appRunId!, 'Needs repair.', 'Fixman')
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].ensembleRun?.participantId).toBe('fixman')

    const fixmanRoute = {
      appRunId: harness.dispatched[1].appRunId,
      appChatId: 'ensemble-chat'
    }
    harness.orchestrator.handleProviderOutput('codex', fixmanRoute, {
      type: 'content',
      text: 'Repair applied.'
    })
    harness.orchestrator.handleProviderOutput('codex', fixmanRoute, {
      type: 'result',
      status: 'success',
      stats: { total_tokens: 10 }
    })

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[2].ensembleRun?.participantId).toBe('typecheckz')
    expect(harness.chat.ensemble?.activeRound?.continuationHops).toBe(1)
    expect(
      harness.chat.messages.some((message) =>
        message.content.includes('Yield-return: returning to TypeCheckz')
      )
    ).toBe(true)

    const typecheckzReturnRoute = {
      appRunId: harness.dispatched[2].appRunId,
      appChatId: 'ensemble-chat'
    }
    harness.orchestrator.handleProviderOutput('claude', typecheckzReturnRoute, {
      type: 'content',
      text: 'Gate passed.'
    })
    harness.orchestrator.handleProviderOutput('claude', typecheckzReturnRoute, {
      type: 'result',
      status: 'success',
      stats: { total_tokens: 5 }
    })
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
  })

  it('lets a yielded target route onward by @-mention before the implicit yield-return', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.activeGoal = { ...buildActiveGoal('goal-continuous'), status: 'completed' }
    harness.chat.ensemble!.participants = [
      {
        id: 'gate',
        provider: 'grok',
        enabled: true,
        role: 'Gate',
        instructions: 'Delegate the repair.',
        order: 1,
        permissionPresetId: 'default'
      },
      {
        id: 'fixman',
        provider: 'codex',
        enabled: true,
        role: 'Fixman',
        instructions: 'Repair and route review.',
        order: 2,
        permissionPresetId: 'read_only'
      },
      {
        id: 'reviewer',
        provider: 'claude',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review the repair.',
        order: 3,
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Repair, then review.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('gate')

    expectYielded(
      harness.orchestrator.markYielded(harness.dispatched[0].appRunId!, 'Fix this first.', 'Fixman')
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].ensembleRun?.participantId).toBe('fixman')

    const fixmanRoute = {
      appRunId: harness.dispatched[1].appRunId,
      appChatId: 'ensemble-chat'
    }
    harness.orchestrator.handleProviderOutput('codex', fixmanRoute, {
      type: 'content',
      text: 'Repair applied. @Reviewer please verify it.'
    })
    harness.orchestrator.handleProviderOutput('codex', fixmanRoute, {
      type: 'result',
      status: 'success',
      stats: { total_tokens: 10 }
    })

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[2].ensembleRun?.participantId).toBe('reviewer')
    expect(
      harness.chat.messages.some((message) =>
        message.content.includes('Yield-return: returning to Gate')
      )
    ).toBe(false)
    expect(
      harness.chat.messages.some((message) =>
        message.content.includes('@-mention: Reviewer promoted to speak next.')
      )
    ).toBe(true)
  })

  it('unwinds nested yield-return frames in LIFO order', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    // Pre-completed goal disables auto-continuation to isolate the nested
    // yield-return LIFO mechanics under test (see the note on the first such test).
    harness.chat.activeGoal = { ...buildActiveGoal('goal-continuous'), status: 'completed' }
    harness.chat.ensemble!.participants = [
      {
        id: 'participant-a',
        provider: 'claude',
        enabled: true,
        role: 'A',
        instructions: 'First gate.',
        order: 1,
        permissionPresetId: 'read_only'
      },
      {
        id: 'participant-b',
        provider: 'codex',
        enabled: true,
        role: 'B',
        instructions: 'Repair.',
        order: 2,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'participant-c',
        provider: 'kimi',
        enabled: true,
        role: 'C',
        instructions: 'Deep repair.',
        order: 3,
        permissionPresetId: 'default'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Nested repair chain.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    harness.orchestrator.markYielded(harness.dispatched[0].appRunId!, 'Needs B.', 'participant-b')
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    harness.orchestrator.markYielded(harness.dispatched[1].appRunId!, 'Needs C.', 'participant-c')
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))

    const cRoute = {
      appRunId: harness.dispatched[2].appRunId,
      appChatId: 'ensemble-chat'
    }
    harness.orchestrator.handleProviderOutput('kimi', cRoute, {
      type: 'content',
      text: 'C fixed the nested issue.'
    })
    harness.orchestrator.handleProviderOutput('kimi', cRoute, {
      type: 'result',
      status: 'success',
      stats: { total_tokens: 5 }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(4))
    expect(harness.dispatched[3].ensembleRun?.participantId).toBe('participant-b')

    const bReturnRoute = {
      appRunId: harness.dispatched[3].appRunId,
      appChatId: 'ensemble-chat'
    }
    harness.orchestrator.handleProviderOutput('codex', bReturnRoute, {
      type: 'content',
      text: 'B verified C and completed repair.'
    })
    harness.orchestrator.handleProviderOutput('codex', bReturnRoute, {
      type: 'result',
      status: 'success',
      stats: { total_tokens: 5 }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(5))
    expect(harness.dispatched.map((payload) => payload.ensembleRun?.participantId)).toEqual([
      'participant-a',
      'participant-b',
      'participant-c',
      'participant-b',
      'participant-a'
    ])
    expect(harness.chat.ensemble?.activeRound?.continuationHops).toBe(2)

    const aReturnRoute = {
      appRunId: harness.dispatched[4].appRunId,
      appChatId: 'ensemble-chat'
    }
    harness.orchestrator.handleProviderOutput('claude', aReturnRoute, {
      type: 'content',
      text: 'A re-gated the nested repair.'
    })
    harness.orchestrator.handleProviderOutput('claude', aReturnRoute, {
      type: 'result',
      status: 'success',
      stats: { total_tokens: 5 }
    })
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
  })

  it('clears yield-return frames when the yielded target returns to the user', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.bossmanParticipantId = 'fixman'
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    // Pre-completed goal disables auto-continuation to isolate the yield-return
    // frame-clearing mechanics under test (see the note on the first such test).
    harness.chat.activeGoal = { ...buildActiveGoal('goal-continuous'), status: 'completed' }
    harness.chat.ensemble!.participants = [
      {
        id: 'typecheckz',
        provider: 'claude',
        enabled: true,
        role: 'TypeCheckz',
        instructions: 'Gate.',
        order: 1,
        permissionPresetId: 'read_only'
      },
      {
        id: 'fixman',
        provider: 'codex',
        enabled: true,
        role: 'Fixman',
        instructions: 'Repair.',
        order: 2,
        permissionPresetId: 'workspace_write'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Gate and ask user if blocked.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    harness.orchestrator.markYielded(harness.dispatched[0].appRunId!, 'Needs repair.', 'Fixman')
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

    harness.orchestrator.markYielded(
      harness.dispatched[1].appRunId!,
      'Blocked on user input.',
      'user'
    )
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    expect(harness.dispatched).toHaveLength(2)
    expect(
      harness.chat.messages.some((message) => message.content.includes('Yield-return: returning'))
    ).toBe(false)
  })

  it('keeps default order but rejects an unresolved explicit yield target', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Yield to a phantom participant.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].provider).toBe('claude')
    // Yield with a target string that matches nothing in the
    // remaining queue — Codex is the only one left, so it should
    // still come up next.
    const outcome = harness.orchestrator.markYielded(
      harness.dispatched[0].appRunId!,
      'Pass it on',
      'NonExistentProvider'
    )
    expect(outcome).toMatchObject({
      kind: 'yielded',
      routing: { ok: false, reason: 'unresolved', target: 'NonExistentProvider' }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('codex')
  })

  it('threads Kimi thinking and HighSpeed tier through dispatch', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'kimi',
        provider: 'kimi',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review.',
        order: 1,
        model: 'kimi-k2.6',
        permissionPresetId: 'read_only',
        thinkingEnabled: true,
        fastModeEnabled: true,
        serviceTier: 'fast'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Think hard.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const kimiPayload = harness.dispatched[0]
    expect(kimiPayload.provider).toBe('kimi')
    expect(kimiPayload.kimiThinking).toBe(true)
    expect(kimiPayload.serviceTier).toBe('fast')
    // Kimi runs should not leak other providers' controls.
    expect(kimiPayload.reasoningEffort).toBeUndefined()
    expect(kimiPayload.claudeFastMode).toBeUndefined()
  })

  it('dispatches kimi thinking ON when the participant never set the flag', async () => {
    // Unset resolves to the provider default (thinking on) — must stay in
    // lockstep with getDefaultEnsembleParticipantConfig('kimi') so the chip
    // display ("Thinking on") and the dispatched run agree for seats that
    // predate the explicit seed (e.g. the seeded default panel).
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'kimi',
        provider: 'kimi',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review.',
        order: 1,
        model: 'kimi-k2.7-code',
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Think hard.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].kimiThinking).toBe(true)
    expect(harness.dispatched[0].serviceTier).toBe('standard')
  })

  it('dispatches K3 effort with thinking on and rejects a stale Fast tier', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'kimi-k3',
        provider: 'kimi',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review.',
        order: 1,
        model: 'kimi-k3',
        permissionPresetId: 'read_only',
        reasoningEffort: 'high',
        thinkingEnabled: false,
        fastModeEnabled: true
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Review deeply.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0]).toMatchObject({
      provider: 'kimi',
      reasoningEffort: 'high',
      kimiThinking: true,
      serviceTier: 'standard'
    })

    const runId = harness.dispatched[0].appRunId!
    harness.orchestrator.handleProviderOutput(
      'kimi',
      { appRunId: runId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'K3 review complete.' }
    )
    await vi.waitFor(() =>
      expect(
        harness.chat.messages.find(
          (message) =>
            message.runId === runId &&
            message.role === 'assistant' &&
            message.metadata?.kind === 'ensembleParticipant'
        )?.metadata
      ).toMatchObject({
        ensembleModel: 'kimi-k3',
        ensembleReasoningEffort: 'high'
      })
    )
    expect(
      harness.chat.messages.find(
        (message) =>
          message.runId === runId &&
          message.role === 'assistant' &&
          message.metadata?.kind === 'ensembleParticipant'
      )?.metadata?.ensembleThinkingEnabled
    ).toBeUndefined()
  })

  // A2 (1.0.3) — `dmTargetParticipantId` scopes the round to a
  // single chip. The orchestrator's machinery still drives the run
  // (so per-participant status pills + activeRound state stay
  // coherent), it just iterates a one-element participant list.
  it('scopes the round to a single participant when dmTargetParticipantId is set', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'DM Codex only.',
      event: { sender: {} as Electron.WebContents },
      dmTargetParticipantId: 'codex'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    // Codex runs, not Claude (which would normally be first per
    // the default fixture order).
    expect(harness.dispatched[0].provider).toBe('codex')
    // Round's activeRound participant list reflects the filter — the
    // single targeted chip, not the full enabled set.
    expect(harness.chat.ensemble?.activeRound?.participants.map((p) => p.participantId)).toEqual([
      'codex'
    ])
    expect(harness.chat.ensemble?.activeRound?.dmTargetParticipantId).toBe('codex')

    // Codex finishes → no further dispatch (no Claude/Gemini/Kimi
    // follow-up), because DM is single-participant.
    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 5 } }
    )
    // Give the orchestrator a microtask to settle and confirm no new
    // dispatch lands.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(harness.dispatched).toHaveLength(1)
  })

  it.each(['read_only', 'all'] as const)(
    'clamps inherited %s fan-out off for a directed participant round',
    async (inheritedFanoutPolicy) => {
      const harness = makeHarness()
      harness.chat.ensemble!.fanoutPolicy = inheritedFanoutPolicy
      harness.chat.ensemble!.concurrentModeEnabled = true

      expect(() =>
        harness.orchestrator.startRound({
          chatId: 'ensemble-chat',
          prompt: '@Worker directed steer.',
          event: { sender: {} as Electron.WebContents },
          mode: 'steer',
          dmTargetParticipantId: 'codex',
          // Model a stale/remote caller that forwards the live roster policy.
          concurrentMode: true,
          fanoutPolicy: inheritedFanoutPolicy
        })
      ).not.toThrow()

      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
      expect(harness.dispatched[0].provider).toBe('codex')
      expect(harness.chat.ensemble?.activeRound?.dmTargetParticipantId).toBe('codex')
      expect(harness.chat.ensemble?.activeRound?.fanoutPolicy).toBe('off')
      expect(harness.chat.ensemble?.activeRound?.concurrentMode).toBeUndefined()
      expect(
        harness.chat.ensemble?.activeRound?.participants.map(
          (participant) => participant.participantId
        )
      ).toEqual(['codex'])
      expect(harness.chat.ensemble?.activeRound?.lanes).toBeUndefined()
    }
  )

  it('does not let an agent @mention widen a continuous user-targeted round', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.maxContinuationHops = 192
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'DM Codex only.',
      event: { sender: {} as Electron.WebContents },
      dmTargetParticipantId: 'codex'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const codexRoute = {
      appRunId: harness.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }
    harness.orchestrator.handleProviderOutput('codex', codexRoute, {
      type: 'content',
      text: 'We are good to go. @Reviewer proceed with the next task.'
    })
    harness.orchestrator.handleProviderOutput('codex', codexRoute, {
      type: 'result',
      status: 'success',
      stats: { total_tokens: 10 }
    })

    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    expect(harness.dispatched).toHaveLength(1)
    expect(harness.chat.ensemble?.activeRound?.continuationHops || 0).toBe(0)
    expect(harness.chat.messages.map((message) => message.content)).toContain(
      '@-mention: @Reviewer is outside this user-targeted round; no turn appended.'
    )
  })

  it('does not let an agent yield outside a continuous user-targeted round', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'DM Codex only.',
      event: { sender: {} as Electron.WebContents },
      dmTargetParticipantId: 'codex'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    expectYielded(
      harness.orchestrator.markYielded(
        harness.dispatched[0].appRunId!,
        'Reviewer should continue.',
        'Reviewer'
      )
    )

    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    expect(harness.dispatched).toHaveLength(1)
    expect(harness.chat.ensemble?.activeRound?.continuationHops || 0).toBe(0)
    expect(
      harness.chat.messages.some(
        (message) =>
          message.metadata?.kind === 'ensembleRoundStatus' &&
          message.content.includes('Yield target "Reviewer" was not routed: outside_scope')
      )
    ).toBe(true)
  })

  it('does not let explicit fan-out widen a user-targeted round', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'DM Codex only.',
      event: { sender: {} as Electron.WebContents },
      dmTargetParticipantId: 'codex',
      // A targeted round itself stays fan-out-off regardless of the
      // chat-level fan-out policy.
      fanoutPolicy: 'off'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    await expect(
      harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
        targets: ['Reviewer'],
        prompt: 'Inspect in parallel.',
        mode: 'read_only'
      })
    ).resolves.toMatchObject({
      ok: false,
      error: 'not_authorized',
      message: expect.stringContaining('user-targeted round')
    })
    expect(harness.dispatched).toHaveLength(1)
    expect(harness.chat.ensemble?.activeRound?.participants.map((p) => p.participantId)).toEqual([
      'codex'
    ])
    expect(harness.chat.ensemble?.activeRound?.lanes).toBeUndefined()

    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
  })

  it('fails closed when dmTargetParticipantId points at a non-existent id', () => {
    const harness = makeHarness()
    expect(() =>
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'DM phantom.',
        event: { sender: {} as Electron.WebContents },
        dmTargetParticipantId: 'phantom-participant'
      })
    ).toThrow('Directed Ensemble target "phantom-participant" is no longer in the roster.')
    expect(harness.dispatched).toHaveLength(0)
    expect(harness.chat.ensemble?.activeRound).toBeUndefined()
  })

  // 1.0.4 — same-provider disambiguation. Two Codex participants
  // both claim the `codex` alias; when another participant writes
  // bare `@codex`, the orchestrator must surface a system note and
  // refuse to route. Exact role/model tags still route normally.
  it('emits a system warning and does not reroute when @<provider> is ambiguous', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.maxParticipants = 6
    harness.chat.ensemble!.participants = [
      {
        id: 'ensemble-kimi',
        provider: 'kimi',
        enabled: true,
        role: 'Coder',
        instructions: 'Code.',
        order: 1,
        model: 'kimi-k2.6',
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'ensemble-claude',
        provider: 'claude',
        enabled: true,
        role: 'Planner',
        instructions: 'Plan.',
        order: 2,
        model: 'claude-sonnet-4-7',
        permissionPresetId: 'read_only'
      },
      {
        id: 'ensemble-codex-brodex',
        provider: 'codex',
        enabled: true,
        role: 'Brodex',
        instructions: 'Implement.',
        order: 3,
        model: 'gpt-5.5',
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'ensemble-codex-chodex',
        provider: 'codex',
        enabled: true,
        role: 'Chodex #2',
        instructions: 'Review.',
        order: 4,
        model: 'gpt-5.4-mini',
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Plan and tag Codex.',
      event: { sender: {} as Electron.WebContents }
    })
    // Kimi speaks first, tags @codex (ambiguous), then finishes.
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].provider).toBe('kimi')
    const kimiRoute = {
      appRunId: harness.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }
    harness.orchestrator.handleProviderOutput('kimi', kimiRoute, {
      type: 'content',
      text: '@codex — you had the best view of the API surface.'
    })
    harness.orchestrator.handleProviderOutput('kimi', kimiRoute, {
      type: 'result',
      status: 'success',
      stats: { total_tokens: 10 }
    })

    // Both Codex participants are still in `remaining` after Kimi
    // finishes, so bare `@codex` is ambiguous and resolves to no
    // routing target. The default rotation stays intact: Claude/
    // Planner remains next instead of a Codex lane being promoted.
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('claude')
    expect(harness.dispatched[1].ensembleRun).toMatchObject({
      participantId: 'ensemble-claude'
    })
  })

  it('routes Boss before advisory worker mentions in the same assistant output', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.bossmanParticipantId = 'ensemble-codex-lead'
    harness.chat.ensemble!.maxParticipants = 6
    harness.chat.ensemble!.participants = [
      {
        id: 'ensemble-grok',
        provider: 'grok',
        enabled: true,
        role: 'Grok Recon',
        instructions: 'Recon.',
        order: 1,
        model: 'grok-build',
        permissionPresetId: 'read_only'
      },
      {
        id: 'ensemble-codex-main',
        provider: 'codex',
        enabled: true,
        role: 'Codex Main Work',
        instructions: 'Implement.',
        order: 2,
        model: 'gpt-5.5',
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'ensemble-codex-lead',
        provider: 'codex',
        enabled: true,
        role: 'Codex Lead',
        instructions: 'Orchestrate.',
        order: 3,
        model: 'gpt-5.5',
        permissionPresetId: 'workspace_write'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Coordinate the slice.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun).toMatchObject({
      participantId: 'ensemble-grok'
    })

    const grokRoute = {
      appRunId: harness.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }
    harness.orchestrator.handleProviderOutput('grok', grokRoute, {
      type: 'content',
      text: 'The main IPC worker is ready. @Codex Main Work can implement once @Codex Lead assigns it.'
    })
    harness.orchestrator.handleProviderOutput('grok', grokRoute, {
      type: 'result',
      status: 'success',
      stats: { total_tokens: 10 }
    })

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].ensembleRun).toMatchObject({
      participantId: 'ensemble-codex-lead'
    })
    const messages = harness.chat.messages.map((m) => m.content)
    expect(
      messages.some(
        (content) =>
          typeof content === 'string' &&
          content.includes('Boss') &&
          content.includes('takes routing priority')
      )
    ).toBe(true)
  })

  it('re-summons the Boss on a priority @-mention even after the Boss already spoke', async () => {
    // Before the fix, an @-mention of a Boss/Captain who already answered this
    // round emitted the priority note but silently dropped the route (the
    // continuation was blocked on the 'answered' status), so the round skipped to
    // the next participant. Now the priority authority is re-summoned.
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.bossmanParticipantId = 'ensemble-codex'
    // Completed goal disables auto-continuation, isolating the re-summon route.
    harness.chat.activeGoal = { ...buildActiveGoal('goal-x'), status: 'completed' }
    harness.chat.ensemble!.participants = [
      {
        id: 'ensemble-codex',
        provider: 'codex',
        enabled: true,
        role: 'Lead',
        instructions: 'Lead.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'ensemble-claude',
        provider: 'claude',
        enabled: true,
        role: 'Worker',
        instructions: 'Work.',
        order: 2,
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Coordinate.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].provider).toBe('codex') // Boss speaks first

    // Continuous Boss must keep Worker before a quiet answer can advance.
    const bossKeep = await harness.orchestrator.bossmanControlForRun(
      harness.dispatched[0].appRunId,
      {
        action: 'select_participants',
        participantRoles: ['Worker'],
        reason: 'Keep Worker for the implementation slice.'
      }
    )
    expect(bossKeep).toMatchObject({ ok: true, action: 'select_participants' })

    // Boss (codex) answers without a mention.
    const bossRun = { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' }
    harness.orchestrator.handleProviderOutput('codex', bossRun, {
      type: 'content',
      text: 'Kicking off. Worker, take the implementation.'
    })
    harness.orchestrator.handleProviderOutput('codex', bossRun, {
      type: 'result',
      status: 'success'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('claude')

    // Worker (claude) @-mentions the Boss, who has already spoken this round.
    const workerRun = { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' }
    harness.orchestrator.handleProviderOutput('claude', workerRun, {
      type: 'content',
      text: 'Done with the slice. @Lead please review and decide next steps.'
    })
    harness.orchestrator.handleProviderOutput('claude', workerRun, {
      type: 'result',
      status: 'success'
    })

    // The Boss is re-summoned (not skipped) — a third dispatch, back to codex.
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[2].provider).toBe('codex')
    expect(harness.chat.ensemble?.activeRound?.continuationHops).toBe(1)
  })

  it('re-summons a YIELDED Boss on a priority @-mention (parity with an answered Boss)', async () => {
    // Regression (orchestration-pains pass): a Boss/Captain who explicitly
    // yielded ('yielded' status) must still be re-summonable via a priority
    // @-mention — mirroring summon_participant, which already passes
    // allowYieldedParticipant. Before the fix the priority @-mention passed only
    // { allowAnsweredParticipant }, so a yielded Boss hit the 'it yielded control
    // this round' decline and Continuous mode spun with nobody able to close the
    // goal (observed live: repeated "could not re-summon General (Boss)").
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.bossmanParticipantId = 'ensemble-codex'
    // Completed goal disables auto-continuation, isolating the re-summon route.
    harness.chat.activeGoal = { ...buildActiveGoal('goal-x'), status: 'completed' }
    harness.chat.ensemble!.participants = [
      {
        id: 'ensemble-codex',
        provider: 'codex',
        enabled: true,
        role: 'Lead',
        instructions: 'Lead.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'ensemble-claude',
        provider: 'claude',
        enabled: true,
        role: 'Worker',
        instructions: 'Work.',
        order: 2,
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Coordinate.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].provider).toBe('codex') // Boss speaks first

    // Continuous Boss must clear the selectionRequired checkpoint before a
    // targetless yield is accepted. Keep Worker, then yield without a target so
    // NO yield-return frame is created: the ONLY path that can bring the Boss
    // back is the priority @-mention under test.
    const bossKeep = await harness.orchestrator.bossmanControlForRun(
      harness.dispatched[0].appRunId,
      {
        action: 'select_participants',
        participantRoles: ['Worker'],
        reason: 'Keep Worker after an explicit Boss yield.'
      }
    )
    expect(bossKeep).toMatchObject({ ok: true, action: 'select_participants' })
    const bossRunId = harness.dispatched[0].appRunId!
    expectYielded(harness.orchestrator.markYielded(bossRunId, 'Worker, take it.'))
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('claude')

    // Worker (claude) @-mentions the yielded Boss.
    const workerRun = { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' }
    harness.orchestrator.handleProviderOutput('claude', workerRun, {
      type: 'content',
      text: 'Done with the slice. @Lead please review and call goal_complete.'
    })
    harness.orchestrator.handleProviderOutput('claude', workerRun, {
      type: 'result',
      status: 'success'
    })

    // The yielded Boss is re-summoned (not declined) — a third dispatch, back to codex.
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[2].provider).toBe('codex')
    // The hop is still counted — re-summon is throttled like any continuation.
    expect(harness.chat.ensemble?.activeRound?.continuationHops).toBe(1)
    // And no 'yielded control this round' decline was emitted.
    expect(
      harness.chat.messages.some(
        (m) =>
          (m.content || '').includes('could not re-summon') &&
          (m.content || '').includes('yielded control this round')
      )
    ).toBe(false)
  })

  it('surfaces an honest note when a Boss priority @-mention cannot be re-summoned (hops exhausted)', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.bossmanParticipantId = 'ensemble-codex'
    harness.chat.ensemble!.maxContinuationHops = 1 // clamps to [1,1200]
    harness.chat.activeGoal = { ...buildActiveGoal('goal-x'), status: 'completed' }
    harness.chat.ensemble!.participants = [
      {
        id: 'ensemble-codex',
        provider: 'codex',
        enabled: true,
        role: 'Lead',
        instructions: 'Lead.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'ensemble-claude',
        provider: 'claude',
        enabled: true,
        role: 'Worker',
        instructions: 'Work.',
        order: 2,
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Coordinate.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const bossKeep = await harness.orchestrator.bossmanControlForRun(
      harness.dispatched[0].appRunId,
      {
        action: 'select_participants',
        participantRoles: ['Worker'],
        reason: 'Keep Worker so the hop-budget note can be isolated.'
      }
    )
    expect(bossKeep).toMatchObject({ ok: true, action: 'select_participants' })
    const bossRun = { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' }
    harness.orchestrator.handleProviderOutput('codex', bossRun, { type: 'content', text: 'Go.' })
    harness.orchestrator.handleProviderOutput('codex', bossRun, {
      type: 'result',
      status: 'success'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    // Exhaust the hop budget so the priority re-summon is blocked.
    const runtime = (
      harness.orchestrator as unknown as {
        roundsByChatId: Map<string, { continuationHops: number; maxContinuationHops: number }>
      }
    ).roundsByChatId.get('ensemble-chat')!
    runtime.continuationHops = runtime.maxContinuationHops
    const workerRun = { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' }
    harness.orchestrator.handleProviderOutput('claude', workerRun, {
      type: 'content',
      text: 'Done. @Lead review please.'
    })
    harness.orchestrator.handleProviderOutput('claude', workerRun, {
      type: 'result',
      status: 'success'
    })
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    // Boss NOT re-dispatched (no hop budget), and an honest note explains why —
    // with the ACCURATE reason (the hop budget), not a generic decline.
    expect(harness.dispatched).toHaveLength(2)
    expect(
      harness.chat.messages.some(
        (m) =>
          (m.content || '').includes('could not re-summon') &&
          (m.content || '').includes('continuation-hop budget exhausted')
      )
    ).toBe(true)
  })

  it('reports the ACCURATE reason (not the hop budget) when a Boss re-summon is blocked by a failed run', async () => {
    // Regression for the honesty-note misattribution: `tryAppendContinuationTurn`
    // declines a Boss re-summon for reasons OTHER than hop exhaustion (the Boss's
    // own run failed/was skipped/cancelled — not 'answered', so it isn't bypassed).
    // The note must say WHY accurately, not always blame the hop budget (which
    // would send the user chasing "add more hops" when the Boss run keeps failing).
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.bossmanParticipantId = 'ensemble-codex'
    harness.chat.activeGoal = { ...buildActiveGoal('goal-x'), status: 'completed' }
    harness.chat.ensemble!.participants = [
      {
        id: 'ensemble-codex',
        provider: 'codex',
        enabled: true,
        role: 'Lead',
        instructions: 'Lead.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'ensemble-claude',
        provider: 'claude',
        enabled: true,
        role: 'Worker',
        instructions: 'Work.',
        order: 2,
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Coordinate.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const bossKeep = await harness.orchestrator.bossmanControlForRun(
      harness.dispatched[0].appRunId,
      {
        action: 'select_participants',
        participantRoles: ['Worker'],
        reason: 'Keep Worker so the failed-run note can be isolated.'
      }
    )
    expect(bossKeep).toMatchObject({ ok: true, action: 'select_participants' })
    const bossRun = { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' }
    harness.orchestrator.handleProviderOutput('codex', bossRun, { type: 'content', text: 'Go.' })
    harness.orchestrator.handleProviderOutput('codex', bossRun, {
      type: 'result',
      status: 'success'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    // Force the Boss's round-participant status to 'failed' (hops untouched, so a
    // hop-budget attribution would be flatly wrong). The re-summon must decline
    // on the failed status and the note must report THAT, not the hop budget.
    harness.chat.ensemble!.activeRound = {
      ...harness.chat.ensemble!.activeRound!,
      participants: harness.chat.ensemble!.activeRound!.participants.map((p) =>
        p.participantId === 'ensemble-codex' ? { ...p, status: 'failed' } : p
      )
    }
    const workerRun = { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' }
    harness.orchestrator.handleProviderOutput('claude', workerRun, {
      type: 'content',
      text: 'Done. @Lead review please.'
    })
    harness.orchestrator.handleProviderOutput('claude', workerRun, {
      type: 'result',
      status: 'success'
    })
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    expect(harness.dispatched).toHaveLength(2) // Boss not re-dispatched.
    const note = harness.chat.messages
      .map((m) => m.content || '')
      .find((c) => c.includes('could not re-summon'))
    expect(note).toBeTruthy()
    expect(note).toContain('its last run failed')
    expect(note).not.toContain('continuation-hop budget exhausted')
  })

  it('does NOT emit an ambiguity warning when the speaker exclusion resolves the alias', async () => {
    // When the speaker is one of the same-provider peers (Codex
    // mentions @codex), the speaker-exclusion path collapses the
    // candidate set to a single survivor, so there is no ambiguity
    // and no warning should appear. Speaker self-mentions also
    // don't promote (existing behaviour) — verify both.
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.maxParticipants = 6
    harness.chat.ensemble!.participants = [
      {
        id: 'ensemble-codex-brodex',
        provider: 'codex',
        enabled: true,
        role: 'Brodex',
        instructions: 'Implement.',
        order: 1,
        model: 'gpt-5.5',
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'ensemble-codex-chodex',
        provider: 'codex',
        enabled: true,
        role: 'Chodex #2',
        instructions: 'Review.',
        order: 2,
        model: 'gpt-5.4-mini',
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Two Codex back and forth.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun).toMatchObject({
      participantId: 'ensemble-codex-brodex'
    })
    // Brodex speaks with @codex — speaker exclusion drops Brodex,
    // leaving only Chodex. Unambiguous → no warning.
    const brodexRoute = {
      appRunId: harness.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }
    harness.orchestrator.handleProviderOutput('codex', brodexRoute, {
      type: 'content',
      text: '@codex (you, the other one), please double-check.'
    })
    harness.orchestrator.handleProviderOutput('codex', brodexRoute, {
      type: 'result',
      status: 'success',
      stats: { total_tokens: 10 }
    })

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    // Chodex speaks next (the OTHER Codex).
    expect(harness.dispatched[1].ensembleRun).toMatchObject({
      participantId: 'ensemble-codex-chodex'
    })

    // No ambiguity warning in the transcript.
    const messages = harness.chat.messages.map((m) => m.content)
    expect(
      messages.some((content) => typeof content === 'string' && content.includes('was ambiguous'))
    ).toBe(false)
  })

  it('1.0.4-AF: /discuss prefix flips the round into self-reflective mode and strips the token', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: '/discuss what is the panel routing logic missing?',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const prompt = harness.dispatched[0].prompt
    // The slash token is stripped before the system prompt is built
    // — agents never see the literal `/discuss` marker.
    expect(prompt).not.toMatch(/^\/discuss/)
    expect(prompt).not.toContain('Current user request:\n/discuss')
    // Self-reflective deictic rule is in force for this dispatch.
    expect(prompt).toContain('Round subject: TaskWraith harness (self-reflective mode')
    expect(prompt).toContain('refer to TaskWraith / the harness / this ensemble')
    // The user message persisted on the chat shows the cleaned prompt
    // too, not the raw `/discuss …` text.
    const userMessages = harness.chat.messages.filter((m) => m.role === 'user')
    expect(userMessages.at(-1)?.content).toBe('what is the panel routing logic missing?')
  })

  it('1.0.4-AF: rounds without /discuss keep the workspace-pointing deictic rule', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Walk through this codebase.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const prompt = harness.dispatched[0].prompt
    expect(prompt).toContain('Round subject: repo (/repo)')
    expect(prompt).not.toContain('self-reflective mode')
    expect(prompt).toContain('NOT to TaskWraith')
  })

  it('honours a queued programmatic follow-up prompt at round end', async () => {
    // Verify the queue-drain → same-round boundary path for follow-ups queued
    // via enqueueFollowUpPrompt (Boss queue_followup / iOS remote).
    // Single-participant ensemble keeps the test focused.
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [harness.chat.ensemble!.participants[0]]
    const started = harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Round 1.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const firstRoundId = started.roundId
    // Queue a follow-up while Claude is mid-turn.
    harness.orchestrator.enqueueFollowUpPrompt('ensemble-chat', 'continue-please')
    // Close Claude's turn — absorb into the live round, then grant a same-round
    // boundary seat (no fresh beginRound).
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2), {
      timeout: 1000
    })
    expect(harness.dispatched[1].prompt).toContain('continue-please')
    expect(harness.chat.ensemble?.activeRound?.roundId).toBe(firstRoundId)
    expect(harness.chat.ensemble?.activeRound?.prompt).toBe('Round 1.')
  })

  // 1.0.4-AK5 — Parallel fan-out.
  // Gated behind a read fan-out policy + 2+ read-only participants.
  // When triggered, the orchestrator dispatches all read-only scouts
  // concurrently via Promise.all BEFORE the serial writer step begins.

  it('1.0.4-AK5: dispatches all read-only participants concurrently when fan-out is enabled', async () => {
    const harness = makeHarness()
    // 3-participant ensemble — 2 read-only scouts (Claude/Reviewer,
    // Gemini/Researcher) + 1 writer (Codex/Worker). Fan-out
    // should fan the two scouts out concurrently.
    harness.chat.ensemble!.participants = [
      {
        id: 'claude',
        provider: 'claude',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review.',
        order: 1,
        model: 'claude-model',
        permissionPresetId: 'read_only'
      },
      {
        id: 'gemini',
        provider: 'gemini',
        enabled: true,
        role: 'Researcher',
        instructions: 'Research.',
        order: 2,
        model: 'gemini-model',
        permissionPresetId: 'read_only'
      },
      {
        id: 'codex',
        provider: 'codex',
        enabled: true,
        role: 'Worker',
        instructions: 'Work.',
        order: 3,
        model: 'codex-model',
        permissionPresetId: 'workspace_write'
      }
    ]
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Investigate then implement.',
      event: { sender: {} as Electron.WebContents }
    })
    // Both scouts dispatch concurrently — toHaveLength(2) at the
    // start. Claude (order 1) + Gemini (order 2) BOTH have entries.
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2), {
      timeout: 1000
    })
    const dispatchProviders = harness.dispatched.map((p) => p.provider).sort()
    expect(dispatchProviders).toEqual(['claude', 'gemini'])
    expect(
      harness.dispatched.every(
        (payload) =>
          payload.effectivePermissions?.presetId === 'read_only' &&
          payload.effectivePermissions?.readOnly === true &&
          payload.approvalMode === 'plan'
      )
    ).toBe(true)

    // Resolve both scouts so the parallel-pass's Promise.all
    // settles. Each scout sends content + result.
    const claudeRun = harness.dispatched.find((p) => p.provider === 'claude')!
    const geminiRun = harness.dispatched.find((p) => p.provider === 'gemini')!
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: claudeRun.appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'Claude scout note.' }
    )
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: claudeRun.appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    harness.orchestrator.handleProviderOutput(
      'gemini',
      { appRunId: geminiRun.appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'Gemini scout note.' }
    )
    harness.orchestrator.handleProviderOutput(
      'gemini',
      { appRunId: geminiRun.appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )

    // After both scouts resolve, the serial writer step dispatches
    // Codex (order 3, workspace_write).
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3), {
      timeout: 1000
    })
    expect(harness.dispatched[2].provider).toBe('codex')
    expect(harness.dispatched[2].effectivePermissions?.presetId).toBe('workspace_write')

    // Transcript labels this host-owned stage pass distinctly from a later
    // participant-authored `ensemble_fanout` request.
    const fanoutOpenNote = harness.chat.messages.find(
      (m) =>
        m.role === 'system' &&
        typeof m.content === 'string' &&
        m.content.includes('Automatic read stage · 2 participant(s)')
    )
    expect(fanoutOpenNote).toBeDefined()
  })

  it('keeps fan-out lane transcript rows in participant order when lanes finish out of order', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'claude',
        provider: 'claude',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review.',
        order: 1,
        model: 'claude-model',
        permissionPresetId: 'read_only'
      },
      {
        id: 'gemini',
        provider: 'gemini',
        enabled: true,
        role: 'Researcher',
        instructions: 'Research.',
        order: 2,
        model: 'gemini-model',
        permissionPresetId: 'read_only'
      },
      {
        id: 'codex',
        provider: 'codex',
        enabled: true,
        role: 'Worker',
        instructions: 'Work.',
        order: 3,
        model: 'codex-model',
        permissionPresetId: 'workspace_write'
      }
    ]
    harness.chat.ensemble!.fanoutPolicy = 'read_only'

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Investigate then implement.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2), {
      timeout: 1000
    })

    const claudeRun = harness.dispatched.find((p) => p.provider === 'claude')!
    const geminiRun = harness.dispatched.find((p) => p.provider === 'gemini')!
    harness.orchestrator.handleProviderOutput(
      'gemini',
      { appRunId: geminiRun.appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'Gemini scout note.' }
    )
    harness.orchestrator.handleProviderOutput(
      'gemini',
      { appRunId: geminiRun.appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: claudeRun.appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'Claude scout note.' }
    )
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: claudeRun.appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3), {
      timeout: 1000
    })
    const claudeIndex = harness.chat.messages.findIndex((m) =>
      m.content.includes('Claude scout note.')
    )
    const geminiIndex = harness.chat.messages.findIndex((m) =>
      m.content.includes('Gemini scout note.')
    )
    expect(claudeIndex).toBeGreaterThanOrEqual(0)
    expect(geminiIndex).toBeGreaterThanOrEqual(0)
    expect(claudeIndex).toBeLessThan(geminiIndex)
    const claudeMessage = harness.chat.messages[claudeIndex]
    expect(claudeMessage.metadata).toMatchObject({
      ensembleLaneIntent: 'read',
      ensembleLaneId: expect.stringContaining('lane-')
    })
  })

  it('1.0.4-AK5: serial path unchanged when fan-out is disabled', async () => {
    // Same fixture as above but fan-out OFF. Verify the
    // existing serial dispatch path stays byte-identical: scouts
    // dispatch one at a time in roster order.
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'claude',
        provider: 'claude',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review.',
        order: 1,
        permissionPresetId: 'read_only'
      },
      {
        id: 'gemini',
        provider: 'gemini',
        enabled: true,
        role: 'Researcher',
        instructions: 'Research.',
        order: 2,
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Serial please.',
      event: { sender: {} as Electron.WebContents }
    })
    // ONE dispatch initially (serial).
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].provider).toBe('claude')
    // No parallel-pass status note.
    const scoutNote = harness.chat.messages.find(
      (m) =>
        m.role === 'system' &&
        typeof m.content === 'string' &&
        m.content.includes('Parallel fan-out')
    )
    expect(scoutNote).toBeUndefined()
  })

  it('1.0.8: ensemble_send appends a visible side message with routing metadata', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Coordinate visibly.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = harness.orchestrator.sendSideMessageForRun(harness.dispatched[0].appRunId, {
      to: 'Worker',
      message: 'Please check the write path after my review.',
      reason: 'handoff context'
    })

    expect(result.ok).toBe(true)
    const sideMessage = harness.chat.messages.find(
      (message) => message.metadata?.kind === 'ensembleSideMessage'
    )
    expect(sideMessage?.content).toContain('Reviewer to Worker')
    expect(sideMessage?.metadata?.toParticipantIds).toEqual(['codex'])
  })

  it('1.0.8: ensemble_fanout rejects invalid targets without dispatching lanes', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Try a bad target.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = await harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
      targets: ['MissingRole'],
      prompt: 'Please inspect this.'
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('invalid_target')
    expect(harness.dispatched).toHaveLength(1)
  })

  it('1.0.8: ensemble_fanout is rejected when round fan-out policy is off', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Keep this serial.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = await harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
      targets: ['Worker'],
      prompt: 'Try to fan out anyway.'
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('not_authorized')
    expect(result.message).toContain('fan-out is off')
    expect(harness.dispatched).toHaveLength(1)
  })

  it('rejects read-only ensemble_fanout while the round policy is write-only', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.fanoutPolicy = 'locked_writers_with_boss'
    harness.chat.ensemble!.bossmanParticipantId = 'codex'
    harness.chat.ensemble!.participants = [
      {
        id: 'codex',
        provider: 'codex',
        enabled: true,
        role: 'LeadBoss',
        instructions: 'Coordinate.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'claude',
        provider: 'claude',
        enabled: true,
        role: 'Scout',
        instructions: 'Scout.',
        order: 2,
        permissionPresetId: 'read_only',
        stageRole: 'scout'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Lead starts.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = await harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
      targets: ['Scout'],
      prompt: 'Try read fan-out.'
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('not_authorized')
    expect(result.message).toContain('Read or All')
    expect(harness.dispatched).toHaveLength(1)
  })

  it('targetStage=all fans out typed stage roles and excludes untyped Any roles', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.fanoutPolicy = 'off'
    harness.chat.ensemble!.bossmanParticipantId = 'codex'
    harness.chat.ensemble!.participants = [
      {
        id: 'codex',
        provider: 'codex',
        enabled: true,
        role: 'LeadBoss',
        instructions: 'Coordinate.',
        order: 1,
        permissionPresetId: 'workspace_write',
        stageRole: 'worker'
      },
      {
        id: 'claude',
        provider: 'claude',
        enabled: true,
        role: 'Scout',
        instructions: 'Scout.',
        order: 2,
        permissionPresetId: 'read_only',
        stageRole: 'scout'
      },
      {
        id: 'kimi-review',
        provider: 'kimi',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review.',
        order: 3,
        permissionPresetId: 'read_only',
        stageRole: 'reviewer'
      },
      {
        id: 'cursor-any',
        provider: 'cursor',
        enabled: true,
        role: 'Any',
        instructions: 'General.',
        order: 4,
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Lead starts.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runtime = (
      harness.orchestrator as unknown as {
        roundsByChatId: Map<string, { fanoutPolicy: EnsembleConfig['fanoutPolicy'] }>
      }
    ).roundsByChatId.get('ensemble-chat')
    expect(runtime).toBeTruthy()
    runtime!.fanoutPolicy = 'all'

    const fanout = harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
      prompt: 'Typed roles inspect this.',
      targetStage: 'all'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3), { timeout: 1000 })
    const laneRuns = harness.dispatched.slice(1)
    expect(laneRuns.map((payload) => payload.ensembleRun?.participantId)).toEqual([
      'claude',
      'kimi-review'
    ])

    for (const payload of laneRuns) {
      harness.orchestrator.handleProviderOutput(
        payload.provider,
        { appRunId: payload.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
    }
    await expect(fanout).resolves.toMatchObject({
      ok: true,
      targetStage: 'all',
      participantIds: ['claude', 'kimi-review']
    })
  })

  it('targetStage=backgrounds explicitly dispatches only BG seats', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.fanoutPolicy = 'off'
    harness.chat.ensemble!.bossmanParticipantId = 'codex'
    harness.chat.ensemble!.participants = [
      {
        id: 'codex',
        provider: 'codex',
        enabled: true,
        role: 'LeadBoss',
        instructions: 'Coordinate.',
        order: 1,
        permissionPresetId: 'workspace_write',
        stageRole: 'worker'
      },
      {
        id: 'claude-bg',
        provider: 'claude',
        enabled: true,
        role: 'Shell helper',
        instructions: 'Run checks.',
        order: 2,
        permissionPresetId: 'read_only',
        stageRole: 'background'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Lead starts without summoning BG.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runtime = (
      harness.orchestrator as unknown as {
        roundsByChatId: Map<string, { fanoutPolicy: EnsembleConfig['fanoutPolicy'] }>
      }
    ).roundsByChatId.get('ensemble-chat')
    expect(runtime).toBeTruthy()
    runtime!.fanoutPolicy = 'all'

    const result = await harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
      prompt: 'Run the background checks.',
      targetStage: 'backgrounds'
    })
    expect(result).toMatchObject({
      ok: true,
      targetStage: 'backgrounds',
      participantIds: ['claude-bg']
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].ensembleRun?.participantId).toBe('claude-bg')
    expect(harness.dispatched[1].ensembleRun?.laneId).toBeTruthy()
    completeDispatchedRun(harness, 1)
    completeDispatchedRun(harness, 0)
  })

  it('keeps an explicit locked-writer BG lane below Full Access', async () => {
    const previous = process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
    process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = '1'
    const isTrustedSessionGranted = vi.fn(() => true)
    try {
      const harness = makeHarness({ isTrustedSessionGranted })
      harness.chat.ensemble!.fanoutPolicy = 'all'
      harness.chat.ensemble!.bossmanParticipantId = 'lead'
      harness.chat.ensemble!.participants = [
        {
          id: 'lead',
          provider: 'codex',
          enabled: true,
          role: 'Lead',
          instructions: 'Coordinate.',
          order: 1,
          permissionPresetId: 'workspace_write',
          stageRole: 'worker'
        },
        {
          id: 'background-shell',
          provider: 'claude',
          enabled: true,
          role: 'Shell helper',
          instructions: 'Apply a scoped background edit.',
          order: 2,
          permissionPresetId: 'full_access',
          stageRole: 'background'
        }
      ]
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Lead starts.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

      const fanout = harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
        prompt: 'Edit only generated reports.',
        mode: 'locked_writers',
        targetStage: 'backgrounds',
        writeScopes: { 'background-shell': ['reports/generated/**'] }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
      const backgroundRun = harness.dispatched[1]
      expect(backgroundRun.ensembleRun?.participantId).toBe('background-shell')
      expect(backgroundRun.effectivePermissions?.presetId).toBe('workspace_write')
      expect(isTrustedSessionGranted).not.toHaveBeenCalledWith(
        expect.objectContaining({ ensembleParticipantId: 'background-shell' })
      )
      completeDispatchedRun(harness, 1)
      await expect(fanout).resolves.toMatchObject({
        ok: true,
        mode: 'locked_writers',
        targetStage: 'backgrounds'
      })
      completeDispatchedRun(harness, 0)
    } finally {
      if (previous === undefined) {
        delete process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
      } else {
        process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = previous
      }
    }
  })

  it('1.0.8: ensemble_fanout rejects broad fanout from non-authority participants', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    harness.chat.ensemble!.participants = [
      {
        id: 'codex',
        provider: 'codex',
        enabled: true,
        role: 'Worker',
        instructions: 'Work.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'claude',
        provider: 'claude',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review.',
        order: 2,
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Worker starts.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = await harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
      prompt: 'Everyone inspect this.'
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('not_authorized')
    expect(harness.dispatched).toHaveLength(1)
  })

  it('lets Captain request broad read-only fan-out while Boss is available', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    harness.chat.ensemble!.bossmanParticipantId = 'boss'
    harness.chat.ensemble!.secondInCommandParticipantId = 'captain'
    harness.chat.ensemble!.participants = [
      {
        id: 'captain',
        provider: 'codex',
        enabled: true,
        role: 'Captain',
        instructions: 'Coordinate parallel work.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'boss',
        provider: 'claude',
        enabled: true,
        role: 'Boss',
        instructions: 'Own controlling authority.',
        order: 2,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'reviewer',
        provider: 'kimi',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review.',
        order: 3,
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Captain starts while Boss remains healthy.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const captainRunId = harness.dispatched[0].appRunId
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('captain')
    // The general control resolver still keeps Captain on standby.
    expect(
      harness.orchestrator.listParticipantsForRun(captainRunId).bossmanAuthorityRole
    ).toBeUndefined()

    const result = await harness.orchestrator.fanoutForRun(captainRunId, {
      prompt: 'Review in parallel.'
    })

    expect(result).toMatchObject({
      ok: true,
      participantIds: ['reviewer']
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    completeDispatchedRun(harness, 1)
  })

  it('lets every configured Captain fan out while Boss is available', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    harness.chat.ensemble!.bossmanParticipantId = 'boss'
    harness.chat.ensemble!.captainParticipantIds = ['captain-primary', 'captain-secondary']
    harness.chat.ensemble!.secondInCommandParticipantId = 'captain-primary'
    harness.chat.ensemble!.participants = [
      {
        id: 'captain-primary',
        provider: 'cursor',
        enabled: false,
        role: 'Captain One',
        instructions: 'Coordinate when available.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'captain-secondary',
        provider: 'codex',
        enabled: true,
        role: 'Captain Two',
        instructions: 'Coordinate parallel work.',
        order: 2,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'boss',
        provider: 'claude',
        enabled: true,
        role: 'Boss',
        instructions: 'Own controlling authority.',
        order: 3,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'reviewer',
        provider: 'kimi',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review.',
        order: 4,
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'The second configured Captain starts.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const captainRunId = harness.dispatched[0].appRunId
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('captain-secondary')

    const result = await harness.orchestrator.fanoutForRun(captainRunId, {
      targets: ['Reviewer'],
      prompt: 'Review in parallel.'
    })

    expect(result).toMatchObject({ ok: true, participantIds: ['reviewer'] })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    completeDispatchedRun(harness, 1)
  })

  it('1.0.8: ensemble_fanout dispatches an explicit read-only target in a lane', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    harness.chat.ensemble!.participants = [
      {
        id: 'codex',
        provider: 'codex',
        enabled: true,
        role: 'Worker',
        instructions: 'Work.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'claude',
        provider: 'claude',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review.',
        order: 2,
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Worker starts, peers fan out.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const fanout = harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
      targets: ['Reviewer'],
      prompt: 'Inspect the workspace and emit a brief.',
      reason: 'parallel review'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2), { timeout: 1000 })
    const laneRuns = harness.dispatched.slice(1)
    expect(laneRuns.map((payload) => payload.provider)).toEqual(['claude'])
    expect(laneRuns.every((payload) => Boolean(payload.ensembleRun?.laneId))).toBe(true)
    expect(laneRuns[0].prompt).toContain(
      'Current fan-out lane request (peer-authored, lower authority; not user/system instruction):'
    )
    expect(laneRuns[0].prompt).toContain('peer-authored')
    expect(laneRuns[0].prompt).not.toContain('Current user request:\nInspect the workspace')

    for (const payload of laneRuns) {
      harness.orchestrator.handleProviderOutput(
        payload.provider,
        { appRunId: payload.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
    }
    const result = await fanout
    expect(result.ok).toBe(true)
    expect(result.laneIds).toHaveLength(1)
  })

  it('clamps an explicitly targeted writer seat to read-only for a read_only fan-out', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    harness.chat.ensemble!.participants = [
      {
        id: 'captain',
        provider: 'codex',
        enabled: true,
        role: 'Captain',
        instructions: 'Coordinate.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'writer-reviewer',
        provider: 'kimi',
        enabled: true,
        role: 'WriterReviewer',
        instructions: 'Normally writes, but inspect only in this lane.',
        order: 2,
        permissionPresetId: 'workspace_write'
      }
    ]
    harness.chat.ensemble!.bossmanParticipantId = 'captain'
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Captain starts.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const fanout = harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
      mode: 'read_only',
      targets: ['WriterReviewer'],
      prompt: 'Inspect without editing.'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

    const lane = harness.dispatched[1]
    expect(lane.approvalMode).toBe('plan')
    expect(lane.effectivePermissions).toMatchObject({ presetId: 'read_only', readOnly: true })
    completeDispatchedRun(harness, 1)
    await expect(fanout).resolves.toMatchObject({ ok: true })
  })

  it('binds fan-out attachment grants to the lane run instead of the parent run', async () => {
    const issueRunScopedExternalGrants = vi.fn(
      ({
        participant,
        appRunId,
        attachments
      }: Parameters<NonNullable<EnsembleOrchestratorDeps['issueRunScopedExternalGrants']>>[0]) => [
        externalGrant(participant.provider, attachments[0].path, {
          appRunId,
          chatId: 'ensemble-chat',
          workspaceId: 'ws-1'
        })
      ]
    )
    const harness = makeHarness({ issueRunScopedExternalGrants })
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    harness.chat.ensemble!.participants = [
      {
        id: 'codex',
        provider: 'codex',
        enabled: true,
        role: 'Worker',
        instructions: 'Work.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'claude',
        provider: 'claude',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review.',
        order: 2,
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Worker starts, reviewer inspects the attachment.',
      imageAttachments: [{ id: 'pdf-1', path: '/tmp/spec.pdf', name: 'spec.pdf' }],
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const fanout = harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
      targets: ['Reviewer'],
      prompt: 'Inspect the attached specification.'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2), { timeout: 1000 })

    const parentRunId = harness.dispatched[0].appRunId
    const laneRunId = harness.dispatched[1].appRunId
    expect(laneRunId).not.toBe(parentRunId)
    expect(harness.dispatched[0].externalPathGrants).toMatchObject([
      { provider: 'codex', path: '/tmp/spec.pdf', appRunId: parentRunId }
    ])
    expect(harness.dispatched[1].externalPathGrants).toMatchObject([
      { provider: 'claude', path: '/tmp/spec.pdf', appRunId: laneRunId }
    ])

    completeDispatchedRun(harness, 1)
    await expect(fanout).resolves.toMatchObject({ ok: true })
  })

  it('returns a fan-out dispatch receipt before the lane completes', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    harness.chat.ensemble!.participants = [
      {
        id: 'codex',
        provider: 'codex',
        enabled: true,
        role: 'Worker',
        instructions: 'Work.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'claude',
        provider: 'claude',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review.',
        order: 2,
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Worker starts, peer fans out.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = await harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
      targets: ['Reviewer'],
      prompt: 'Inspect the workspace and emit a brief.'
    })

    expect(result).toMatchObject({
      ok: true,
      status: 'dispatched',
      laneIds: [expect.any(String)],
      participantIds: ['claude']
    })
    expect(result.message).toContain('dispatched')
    expect(harness.dispatched).toHaveLength(2)
    expect(
      harness.chat.messages.some((message) => message.content.includes('Parallel fan-out complete'))
    ).toBe(false)

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() =>
      expect(
        harness.chat.messages.some((message) =>
          message.content.includes('Parallel fan-out complete')
        )
      ).toBe(true)
    )
  })

  it('returns from fan-out when the adapter is invoked even if dispatch settles at child close', async () => {
    const laneDispatch = deferred<{ dispatched: boolean; appRunId: string }>()
    let laneDispatchSettled = false
    void laneDispatch.promise.finally(() => {
      laneDispatchSettled = true
    })
    const harness = makeHarness({
      dispatch: async (payload, _event, observer) => {
        if (!payload.ensembleRun?.laneId) {
          return { dispatched: true, appRunId: payload.appRunId || '' }
        }
        observer?.onAdapterInvoked?.({
          provider: payload.provider,
          appRunId: payload.appRunId || '',
          ...(payload.workspace ? { effectiveWorkspacePath: payload.workspace } : {})
        })
        return laneDispatch.promise
      }
    })
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    harness.chat.ensemble!.participants = [
      {
        id: 'codex',
        provider: 'codex',
        enabled: true,
        role: 'Worker',
        instructions: 'Work.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'claude',
        provider: 'claude',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review.',
        order: 2,
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Worker starts, peer fans out.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = await harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
      targets: ['Reviewer'],
      prompt: 'Inspect the workspace and emit a brief.'
    })

    expect(result).toMatchObject({
      ok: true,
      status: 'dispatched',
      participantIds: ['claude']
    })
    expect(laneDispatchSettled).toBe(false)

    const lanePayload = harness.dispatched[1]
    harness.orchestrator.handleProviderOutput(
      lanePayload.provider,
      { appRunId: lanePayload.appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    laneDispatch.resolve({ dispatched: true, appRunId: lanePayload.appRunId || '' })
    await vi.waitFor(() => expect(laneDispatchSettled).toBe(true))
  })

  it('dispatches explicit ensemble_fanout targets up to the participant cap', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    const fullRoster: EnsembleParticipant[] = Array.from(
      { length: MAX_ENSEMBLE_PARTICIPANTS },
      (_, index) => ({
        id: index === 0 ? 'lead' : `reviewer-${index}`,
        provider: index === 0 ? 'codex' : 'claude',
        enabled: true,
        role: index === 0 ? 'LeadBoss' : `Reviewer ${index}`,
        instructions: index === 0 ? 'Coordinate.' : 'Review.',
        order: index + 1,
        permissionPresetId: index === 0 ? 'workspace_write' : 'read_only'
      })
    )
    harness.chat.ensemble!.participants = fullRoster.slice(0, 2)
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Lead starts, everyone fans out.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    harness.chat.ensemble!.participants = fullRoster

    const peerCount = MAX_ENSEMBLE_PARTICIPANTS - 1
    const fanout = harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
      targets: Array.from({ length: peerCount }, (_, index) => `Reviewer ${index + 1}`),
      prompt: 'Inspect this in parallel.'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(MAX_ENSEMBLE_PARTICIPANTS), {
      timeout: 1000
    })
    const expectedParticipantIds = Array.from(
      { length: peerCount },
      (_, index) => `reviewer-${index + 1}`
    )
    const laneRuns = harness.dispatched.slice(1)
    expect(laneRuns.map((payload) => payload.ensembleRun?.participantId)).toEqual(
      expectedParticipantIds
    )

    for (const payload of laneRuns) {
      harness.orchestrator.handleProviderOutput(
        payload.provider,
        { appRunId: payload.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
    }
    await expect(fanout).resolves.toMatchObject({
      ok: true,
      participantIds: expectedParticipantIds
    })
  })

  it('1.0.8: ensemble_fanout allows broad fanout from Boss', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    harness.chat.ensemble!.bossmanParticipantId = 'codex'
    harness.chat.ensemble!.participants = [
      {
        id: 'codex',
        provider: 'codex',
        enabled: true,
        role: 'LeadBoss',
        instructions: 'Coordinate.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'claude',
        provider: 'claude',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review.',
        order: 2,
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Lead starts.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const fanout = harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
      prompt: 'Inspect in parallel.'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await expect(fanout).resolves.toMatchObject({ ok: true, participantIds: ['claude'] })
  })

  it('1.0.8: ensemble_fanout does not dispatch the same future participants again serially', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    harness.chat.ensemble!.participants = [
      {
        id: 'codex',
        provider: 'codex',
        enabled: true,
        role: 'Worker',
        instructions: 'Work.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'claude',
        provider: 'claude',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review.',
        order: 2,
        permissionPresetId: 'read_only'
      },
      {
        id: 'gemini',
        provider: 'gemini',
        enabled: true,
        role: 'Researcher',
        instructions: 'Research.',
        order: 3,
        permissionPresetId: 'workspace_write'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Worker starts, peers fan out.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const fanout = harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
      targets: ['Reviewer'],
      prompt: 'Inspect the workspace and emit a brief.'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2), { timeout: 1000 })
    for (const payload of harness.dispatched.slice(1)) {
      harness.orchestrator.handleProviderOutput(
        payload.provider,
        { appRunId: payload.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
    }
    await expect(fanout).resolves.toMatchObject({ ok: true })

    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3), { timeout: 1000 })
    expect(harness.dispatched.map((payload) => payload.provider).sort()).toEqual([
      'claude',
      'codex',
      'gemini'
    ])
    harness.orchestrator.handleProviderOutput(
      'gemini',
      { appRunId: harness.dispatched[2].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
  })

  it("holds foreground rotation until the caller's fan-out lane returns", async () => {
    const harness = makeFanoutRaceHarness()
    const { fanout } = await startUnresolvedReviewerFanout(harness)

    completeDispatchedRun(harness, 0)

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(harness.dispatched).toHaveLength(2)
    expect(
      harness.chat.messages.some((message) =>
        message.content.includes('waiting for its fan-out lane(s) to return')
      )
    ).toBe(true)

    completeDispatchedRun(harness, 1)
    await expect(fanout).resolves.toMatchObject({ ok: true })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3), { timeout: 1000 })
    expect(harness.dispatched[2].ensembleRun?.participantId).toBe('gemini')
    expect(
      harness.dispatched.filter((payload) => payload.ensembleRun?.participantId === 'claude')
    ).toHaveLength(1)

    completeDispatchedRun(harness, 2)
  })

  it('holds foreground ownership while an accepted fan-out dispatch receipt is pending', async () => {
    const dispatchGate = deferred<boolean>()
    const harness = makeFanoutRaceHarness({
      dispatch: async (payload) => {
        if (!payload.ensembleRun?.laneId) {
          return { dispatched: true, appRunId: payload.appRunId || '' }
        }
        const accepted = await dispatchGate.promise
        return { dispatched: accepted, appRunId: payload.appRunId || '' }
      }
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Keep the lead in charge while the reviewer dispatch is pending.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const ownerRunId = harness.dispatched[0].appRunId!

    const fanout = harness.orchestrator.fanoutForRun(ownerRunId, {
      targets: ['Reviewer'],
      prompt: 'Review this before foreground rotation continues.'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    completeDispatchedRun(harness, 0)

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(harness.dispatched).toHaveLength(2)
    const internals = harness.orchestrator as unknown as {
      runsByRunId: Map<
        string,
        { terminalFinalized?: boolean; pendingFanoutDispatches?: Set<Promise<void>> }
      >
    }
    expect(internals.runsByRunId.get(ownerRunId)?.terminalFinalized).toBe(true)
    expect(internals.runsByRunId.get(ownerRunId)?.pendingFanoutDispatches?.size).toBe(1)

    dispatchGate.resolve(true)
    await expect(fanout).resolves.toMatchObject({ ok: true, participantIds: ['claude'] })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(harness.dispatched).toHaveLength(2)

    completeDispatchedRun(harness, 1)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[2].ensembleRun?.participantId).toBe('gemini')
    expect(internals.runsByRunId.has(ownerRunId)).toBe(false)
    completeDispatchedRun(harness, 2)
  })

  it('keeps a provider-terminal fan-out owner successful when the round is stopped', async () => {
    const harness = makeFanoutRaceHarness()
    const { fanout } = await startUnresolvedReviewerFanout(harness)
    const ownerRunId = harness.dispatched[0].appRunId!

    completeDispatchedRun(harness, 0)
    await vi.waitFor(() =>
      expect(harness.chat.runs?.find((run) => run.runId === ownerRunId)?.status).toBe('success')
    )

    await expect(
      harness.orchestrator.cancelRound('ensemble-chat', 'Stopped after provider completion.')
    ).resolves.toBe(true)
    await expect(fanout).resolves.toMatchObject({ ok: true })

    expect(harness.cancelRun).not.toHaveBeenCalledWith('codex', ownerRunId)
    expect(harness.chat.runs?.find((run) => run.runId === ownerRunId)?.status).toBe('success')
    expect(
      harness.chat.messages
        .filter(
          (message) =>
            message.runId === ownerRunId && message.metadata?.kind === 'ensembleParticipant'
        )
        .every((message) => message.metadata?.ensembleStatus === 'success')
    ).toBe(true)
    expect(harness.chat.ensemble?.activeRound?.status).toBe('cancelled')
  })

  it('releases foreground ownership when a pending fan-out dispatch is rejected', async () => {
    const dispatchGate = deferred<boolean>()
    const harness = makeFanoutRaceHarness({
      dispatch: async (payload) => {
        if (!payload.ensembleRun?.laneId) {
          return { dispatched: true, appRunId: payload.appRunId || '' }
        }
        const accepted = await dispatchGate.promise
        return { dispatched: accepted, appRunId: payload.appRunId || '' }
      }
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Release the lead if the reviewer lane cannot start.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const ownerRunId = harness.dispatched[0].appRunId!

    const fanout = harness.orchestrator.fanoutForRun(ownerRunId, {
      targets: ['Reviewer'],
      prompt: 'This lane dispatch will be rejected.'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    completeDispatchedRun(harness, 0)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(harness.dispatched).toHaveLength(2)

    dispatchGate.resolve(false)
    await expect(fanout).resolves.toMatchObject({ ok: false, error: 'dispatch_failed' })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[2].ensembleRun?.participantId).toBe('claude')
    expect(harness.dispatched[2].ensembleRun?.laneId).toBeUndefined()

    completeDispatchedRun(harness, 2)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(4))
    expect(harness.dispatched[3].ensembleRun?.participantId).toBe('gemini')
    completeDispatchedRun(harness, 3)
  })

  it('cancels an exact fan-out transport when adapter dispatch throws after entry', async () => {
    const harness = makeFanoutRaceHarness({
      dispatch: async (payload) => {
        if (payload.ensembleRun?.laneId) {
          throw new Error('fan-out adapter rejected after entry')
        }
        return { dispatched: true, appRunId: payload.appRunId || '' }
      }
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Cancel a partial reviewer lane.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const fanout = harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
      targets: ['Reviewer'],
      prompt: 'This lane throws after adapter entry.'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    await expect(fanout).resolves.toMatchObject({ ok: false, error: 'dispatch_failed' })
    expect(harness.cancelRun).toHaveBeenCalledWith(
      harness.dispatched[1].provider,
      harness.dispatched[1].appRunId
    )
    await harness.orchestrator.cancelRound('ensemble-chat', 'test cleanup')
  })

  it('cancels a provisionally owned lane when its owner is skipped before dispatch receipt', async () => {
    const dispatchGate = deferred<boolean>()
    const harness = makeFanoutRaceHarness({
      dispatch: async (payload) => {
        if (!payload.ensembleRun?.laneId) {
          return { dispatched: true, appRunId: payload.appRunId || '' }
        }
        const accepted = await dispatchGate.promise
        return { dispatched: accepted, appRunId: payload.appRunId || '' }
      }
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Skip the owner while its reviewer dispatch is pending.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const ownerRunId = harness.dispatched[0].appRunId!

    const fanout = harness.orchestrator.fanoutForRun(ownerRunId, {
      targets: ['Reviewer'],
      prompt: 'This provisional lane must be cancelled with its owner.'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    const provisionalLane = harness.dispatched[1]

    await expect(harness.orchestrator.skipActiveParticipant('ensemble-chat')).resolves.toBe(true)
    expect(harness.cancelRun).toHaveBeenCalledWith('codex', ownerRunId)
    expect(harness.cancelRun).toHaveBeenCalledWith('claude', provisionalLane.appRunId)
    expect(
      harness.orchestrator.handleProviderOutput(
        'claude',
        { appRunId: provisionalLane.appRunId, appChatId: 'ensemble-chat' },
        { type: 'content', text: 'ZOMBIE-LANE-OUTPUT-BEFORE-RECEIPT.' }
      )
    ).toBe(false)
    expect(harness.dispatched).toHaveLength(2)

    dispatchGate.resolve(true)
    await expect(fanout).resolves.toMatchObject({ ok: false, error: 'dispatch_failed' })
    const targetCancelCount = harness.cancelRun.mock.calls.filter(
      ([provider, runId]) => provider === 'claude' && runId === provisionalLane.appRunId
    ).length
    expect(targetCancelCount).toBeGreaterThanOrEqual(2)
    expect(
      harness.orchestrator.handleProviderOutput(
        'claude',
        { appRunId: provisionalLane.appRunId, appChatId: 'ensemble-chat' },
        { type: 'content', text: 'ZOMBIE-LANE-OUTPUT-AFTER-RECEIPT.' }
      )
    ).toBe(false)
    expect(
      harness.chat.messages.some((message) => message.content.includes('ZOMBIE-LANE-OUTPUT'))
    ).toBe(false)

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[2].ensembleRun?.participantId).toBe('claude')
    expect(harness.dispatched[2].ensembleRun?.laneId).toBeUndefined()
    completeDispatchedRun(harness, 2)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(4))
    expect(harness.dispatched[3].ensembleRun?.participantId).toBe('gemini')
    completeDispatchedRun(harness, 3)
  })

  it('re-cancels a target accepted after Stop during its pending dispatch receipt', async () => {
    const dispatchGate = deferred<boolean>()
    const harness = makeFanoutRaceHarness({
      dispatch: async (payload) => {
        if (!payload.ensembleRun?.laneId) {
          return { dispatched: true, appRunId: payload.appRunId || '' }
        }
        const accepted = await dispatchGate.promise
        return { dispatched: accepted, appRunId: payload.appRunId || '' }
      }
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Stop the round while its reviewer dispatch is pending.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const ownerRunId = harness.dispatched[0].appRunId!

    const fanout = harness.orchestrator.fanoutForRun(ownerRunId, {
      targets: ['Reviewer'],
      prompt: 'This target must not survive a Stop before dispatch receipt.'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    const provisionalLane = harness.dispatched[1]

    await expect(
      harness.orchestrator.cancelRound('ensemble-chat', 'Stopped by user.')
    ).resolves.toBe(true)
    expect(harness.chat.ensemble?.activeRound?.status).toBe('cancelled')
    expect(harness.cancelRun).toHaveBeenCalledWith('codex', ownerRunId)
    expect(harness.cancelRun).toHaveBeenCalledWith('claude', provisionalLane.appRunId)
    expect(
      harness.orchestrator.handleProviderOutput(
        'claude',
        { appRunId: provisionalLane.appRunId, appChatId: 'ensemble-chat' },
        { type: 'content', text: 'STOPPED-ZOMBIE-LANE-OUTPUT-BEFORE-RECEIPT.' }
      )
    ).toBe(false)

    dispatchGate.resolve(true)
    await expect(fanout).resolves.toMatchObject({ ok: false, error: 'dispatch_failed' })
    const targetCancelCount = harness.cancelRun.mock.calls.filter(
      ([provider, runId]) => provider === 'claude' && runId === provisionalLane.appRunId
    ).length
    expect(targetCancelCount).toBeGreaterThanOrEqual(2)
    expect(
      harness.orchestrator.handleProviderOutput(
        'claude',
        { appRunId: provisionalLane.appRunId, appChatId: 'ensemble-chat' },
        { type: 'content', text: 'STOPPED-ZOMBIE-LANE-OUTPUT-AFTER-RECEIPT.' }
      )
    ).toBe(false)
    expect(
      harness.chat.messages.some((message) =>
        message.content.includes('STOPPED-ZOMBIE-LANE-OUTPUT')
      )
    ).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(harness.dispatched).toHaveLength(2)
    expect(harness.chat.ensemble?.activeRound?.status).toBe('cancelled')
  })

  it('joins and re-cancels a fan-out transport accepted after history cancellation', async () => {
    const dispatchGate = deferred<boolean>()
    const transportJoinGate = deferred<boolean>()
    let laneAdapterRegistered = false
    let historyPrepared = false
    const persistSessionCheckpoint = vi.fn()
    const completeSessionCheckpoint = vi.fn()
    const harness = makeFanoutRaceHarness({
      dispatch: async (payload) => {
        if (!payload.ensembleRun?.laneId) {
          return { dispatched: true, appRunId: payload.appRunId || '' }
        }
        const accepted = await dispatchGate.promise
        laneAdapterRegistered = accepted
        return { dispatched: accepted, appRunId: payload.appRunId || '' }
      },
      cancelRun: async (provider) => provider !== 'claude' || laneAdapterRegistered,
      terminateRunForHistory: async (provider) =>
        provider === 'claude' ? transportJoinGate.promise : true,
      beforeSaveChat: () => {
        if (historyPrepared) throw new Error('AppStore history mutation is prepared')
      },
      persistSessionCheckpoint,
      completeSessionCheckpoint
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Delete history while the reviewer dispatch receipt is pending.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const fanout = harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
      targets: ['Reviewer'],
      prompt: 'This late-accepted lane must be joined before history commit.'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    const provisionalLane = harness.dispatched[1]
    const roundId = harness.chat.ensemble!.activeRound!.roundId
    const saveCountAtPrepare = harness.saveChat.mock.calls.length
    const checkpointCountAtPrepare = persistSessionCheckpoint.mock.calls.length
    historyPrepared = true

    let cancellationJoined = false
    const cancelling = harness.orchestrator
      .cancelRoundForHistory('ensemble-chat', 'chat history cleared', roundId)
      .then((result) => {
        cancellationJoined = true
        return result
      })
    await Promise.resolve()
    expect(cancellationJoined).toBe(false)
    expect(harness.terminateRunForHistory).not.toHaveBeenCalled()
    expect(harness.saveChat).toHaveBeenCalledTimes(saveCountAtPrepare)
    expect(persistSessionCheckpoint).toHaveBeenCalledTimes(checkpointCountAtPrepare)
    expect(completeSessionCheckpoint).not.toHaveBeenCalled()

    dispatchGate.resolve(true)
    await expect(fanout).resolves.toMatchObject({ ok: false, error: 'dispatch_failed' })
    await vi.waitFor(() =>
      expect(harness.terminateRunForHistory).toHaveBeenCalledWith(
        'claude',
        provisionalLane.appRunId
      )
    )
    expect(cancellationJoined).toBe(false)
    transportJoinGate.resolve(true)
    await expect(cancelling).resolves.toBe(true)
    const laneCancellationCount = harness.cancelRun.mock.calls.filter(
      ([provider, runId]) => provider === 'claude' && runId === provisionalLane.appRunId
    ).length
    expect(laneCancellationCount).toBeGreaterThanOrEqual(1)
    expect(harness.saveChat).toHaveBeenCalledTimes(saveCountAtPrepare)
    expect(persistSessionCheckpoint).toHaveBeenCalledTimes(checkpointCountAtPrepare)
    expect(completeSessionCheckpoint).not.toHaveBeenCalled()

    harness.chat.messages = []
    harness.chat.ensemble!.activeRound = undefined
    expect(
      harness.orchestrator.handleProviderOutput(
        'claude',
        { appRunId: provisionalLane.appRunId, appChatId: 'ensemble-chat' },
        { type: 'content', text: 'HISTORY-ZOMBIE-LANE-OUTPUT.' }
      )
    ).toBe(false)
    expect(harness.chat.messages).toEqual([])
  })

  it('rejects late tools and provider events from a terminal owner retained for settlement', async () => {
    const harness = makeFanoutRaceHarness()
    harness.chat.ensemble!.bossmanParticipantId = 'codex'
    const { fanout } = await startUnresolvedReviewerFanout(harness)
    await expect(fanout).resolves.toMatchObject({ ok: true })
    const ownerRunId = harness.dispatched[0].appRunId!

    expect(
      harness.orchestrator.handleProviderOutput(
        'codex',
        { appRunId: ownerRunId, appChatId: 'ensemble-chat' },
        { type: 'content', text: 'OWNER-TERMINAL-ANSWER.' }
      )
    ).toBe(true)
    completeDispatchedRun(harness, 0)
    await new Promise((resolve) => setTimeout(resolve, 20))

    const internals = harness.orchestrator as unknown as {
      runsByRunId: Map<string, { terminalFinalized?: boolean }>
    }
    expect(internals.runsByRunId.get(ownerRunId)?.terminalFinalized).toBe(true)
    expect(harness.orchestrator.getParticipantIdForRun(ownerRunId)).toBeNull()
    expect(harness.orchestrator.markYielded(ownerRunId, 'late yield', 'Researcher').kind).toBe(
      'already_settled'
    )
    await expect(
      harness.orchestrator.fanoutForRun(ownerRunId, {
        targets: ['Researcher'],
        prompt: 'This late fan-out must not start.'
      })
    ).resolves.toMatchObject({ ok: false, error: 'no_active_run' })
    await expect(
      harness.orchestrator.bossmanControlForRun(ownerRunId, {
        action: 'adjust_hops',
        maxContinuationHops: 99
      })
    ).resolves.toMatchObject({ ok: false, error: 'no_active_run' })
    expect(harness.orchestrator.appendStatusForRun(ownerRunId, 'LATE-STATUS')).toBe(false)
    expect(
      harness.orchestrator.validateLaneWriteScopeForRun(ownerRunId, {
        toolName: 'write_file',
        workspacePath: '/repo',
        resourcePath: '/repo/late.txt'
      })
    ).toMatchObject({ ok: false })
    expect(
      harness.orchestrator.reportParticipantTokenUsage(ownerRunId, { total_tokens: 999 })
    ).toBe(false)
    expect(
      harness.orchestrator.handleProviderOutput(
        'codex',
        { appRunId: ownerRunId, appChatId: 'ensemble-chat' },
        { type: 'content', text: 'LATE-PROVIDER-CONTENT.' }
      )
    ).toBe(false)
    // The current authority-ring contract re-summons the Boss while the
    // review lane is unresolved; the late original owner remains sealed.
    expect(harness.dispatched).toHaveLength(3)
    expect(harness.dispatched[2].ensembleRun?.participantId).toBe('codex')
    expect(
      harness.chat.messages.some(
        (message) =>
          message.content.includes('LATE-PROVIDER-CONTENT.') ||
          message.content.includes('LATE-STATUS')
      )
    ).toBe(false)

    completeDispatchedRun(harness, 1)
    await expect(fanout).resolves.toMatchObject({ ok: true })
    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[2].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'OWNER-SYNTHESIS.' }
    )
    completeDispatchedRun(harness, 2)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(4))
    expect(harness.dispatched[3].ensembleRun?.participantId).toBe('gemini')
    expect(internals.runsByRunId.has(ownerRunId)).toBe(false)
    expect(harness.orchestrator.markYielded(ownerRunId, 'duplicate late yield').kind).toBe(
      'already_settled'
    )
    expect(
      harness.chat.messages.filter((message) => message.content.includes('OWNER-TERMINAL-ANSWER.'))
    ).toHaveLength(1)
    completeDispatchedRun(harness, 3)
  })

  it("defers an ensemble_yield handoff until the caller's fan-out lane returns", async () => {
    const harness = makeFanoutRaceHarness()
    const { fanout } = await startUnresolvedReviewerFanout(harness)

    expect(
      harness.orchestrator.markYielded(
        harness.dispatched[0].appRunId!,
        'Researcher should take it after the review returns.',
        'Researcher'
      )
    )

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(harness.dispatched).toHaveLength(2)

    completeDispatchedRun(harness, 1)
    await expect(fanout).resolves.toMatchObject({ ok: true })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3), { timeout: 1000 })
    expect(harness.dispatched[2].ensembleRun?.participantId).toBe('gemini')
    completeDispatchedRun(harness, 2)
  })

  it('defers a Boss-to-worker yield while fan-out is active, then applies it after settlement', async () => {
    const harness = makeFanoutRaceHarness()
    harness.chat.ensemble!.bossmanParticipantId = 'codex'
    const { fanout } = await startUnresolvedReviewerFanout(harness)
    const ownerRunId = harness.dispatched[0].appRunId!

    // Targetless / user yields still hold the authority seat alive for synthesis.
    expect(harness.orchestrator.markYielded(ownerRunId, 'No target yet.')).toMatchObject({
      kind: 'fanout_handoff_held'
    })
    expect(
      harness.orchestrator.markYielded(ownerRunId, 'Return control early.', 'user')
    ).toMatchObject({ kind: 'fanout_handoff_held' })

    // Concrete worker yield is recorded immediately (like non-Boss owners) and
    // applied once the lane settles — no second yield required.
    expectYielded(
      harness.orchestrator.markYielded(
        ownerRunId,
        'Researcher should take it after the review returns.',
        'Researcher'
      )
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(harness.dispatched).toHaveLength(2)

    completeDispatchedRun(harness, 1)
    await expect(fanout).resolves.toMatchObject({ ok: true })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3), { timeout: 1000 })
    expect(harness.dispatched[2].ensembleRun?.participantId).toBe('gemini')
    completeDispatchedRun(harness, 2)
  })

  it('allows Boss to yield to a reviewer whose fan-out lane already settled (handled)', async () => {
    const harness = makeFanoutRaceHarness()
    harness.chat.ensemble!.bossmanParticipantId = 'codex'
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.maxContinuationHops = 8
    const { fanout } = await startUnresolvedReviewerFanout(harness)
    const ownerRunId = harness.dispatched[0].appRunId!

    completeDispatchedRun(harness, 1)
    await expect(fanout).resolves.toMatchObject({ ok: true })

    // Reviewer is 'handled' after the wave — still a valid yield target.
    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: ownerRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'REVIEW-SYNTHESIS.' }
    )
    expectYielded(
      harness.orchestrator.markYielded(
        ownerRunId,
        'Hand back to the reviewer who already fanned out.',
        'Reviewer'
      )
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3), { timeout: 1000 })
    expect(harness.dispatched[2].ensembleRun?.participantId).toBe('claude')
    expect(harness.dispatched[2].ensembleRun?.laneId).toBeUndefined()
    completeDispatchedRun(harness, 2)
  })

  it('keeps both Boss and Captain inside the active fan-out authority ring', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.bossmanParticipantId = 'boss'
    harness.chat.ensemble!.secondInCommandParticipantId = 'captain'
    harness.chat.ensemble!.participants = [
      {
        id: 'boss',
        provider: 'codex',
        enabled: true,
        role: 'Boss',
        instructions: 'Lead.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'captain',
        provider: 'kimi',
        enabled: true,
        role: 'Captain',
        instructions: 'Coordinate.',
        order: 2,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'reviewer',
        provider: 'claude',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review.',
        order: 3,
        permissionPresetId: 'read_only'
      },
      {
        id: 'worker',
        provider: 'gemini',
        enabled: true,
        role: 'Worker',
        instructions: 'Work.',
        order: 4,
        permissionPresetId: 'workspace_write'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Managers retain the fan-out baton.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const bossRunId = harness.dispatched[0].appRunId!
    const bossFanout = harness.orchestrator.fanoutForRun(bossRunId, {
      targets: ['Reviewer'],
      prompt: 'Review while management remains active.'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

    const toCaptain = harness.orchestrator.markYielded(
      bossRunId,
      'Captain owns the next authority turn.',
      'Captain'
    )
    expect(toCaptain).toMatchObject({
      kind: 'yielded',
      routing: { ok: true, targetParticipantId: 'captain' }
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(harness.dispatched).toHaveLength(2)

    completeDispatchedRun(harness, 1)
    await expect(bossFanout).resolves.toMatchObject({ ok: true })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3), { timeout: 1000 })
    expect(harness.dispatched[2].ensembleRun?.participantId).toBe('captain')

    const captainRunId = harness.dispatched[2].appRunId!
    const captainFanout = harness.orchestrator.fanoutForRun(captainRunId, {
      targets: ['Reviewer'],
      prompt: 'Second review wave while Captain holds authority.'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(4))

    expect(
      harness.orchestrator.markYielded(captainRunId, 'Return the authority baton to Boss.', 'Boss')
    ).toMatchObject({
      kind: 'yielded',
      routing: { ok: true, action: 'resummoned', targetParticipantId: 'boss' }
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(harness.dispatched).toHaveLength(4)

    completeDispatchedRun(harness, 3)
    await expect(captainFanout).resolves.toMatchObject({ ok: true })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(5), { timeout: 1000 })
    expect(harness.dispatched[4].ensembleRun?.participantId).toBe('boss')
    await harness.orchestrator.cancelRound('ensemble-chat', 'Test complete.')
  })

  it('re-summons Boss after a silent fan-out exit instead of advancing ordinary writers', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.maxContinuationHops = 8
    harness.chat.ensemble!.bossmanParticipantId = 'boss'
    harness.chat.ensemble!.participants = [
      {
        id: 'boss',
        provider: 'codex',
        enabled: true,
        role: 'Boss',
        instructions: 'Lead.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'reviewer',
        provider: 'claude',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review.',
        order: 2,
        permissionPresetId: 'read_only'
      },
      {
        id: 'worker',
        provider: 'gemini',
        enabled: true,
        role: 'Worker',
        instructions: 'Work.',
        order: 3,
        permissionPresetId: 'workspace_write'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Boss fans out and must retain the turn.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const bossFanout = harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId!, {
      targets: ['Reviewer'],
      prompt: 'Review while Boss remains responsible.'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

    // Boss ends without synthesis while the lane is still live — ordinary
    // writers must not start; Boss is re-summoned into the authority ring.
    completeDispatchedRun(harness, 0)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3), { timeout: 1000 })
    expect(harness.dispatched[2].ensembleRun?.participantId).toBe('boss')
    expect(harness.dispatched[2].ensembleRun?.laneId).toBeUndefined()
    expect(
      harness.chat.messages.some(
        (message) =>
          typeof message.content === 'string' &&
          message.content.includes('retains the authority turn')
      )
    ).toBe(true)

    // Lane returns while the re-summoned Boss turn is active.
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'LANE-FINDING.' }
    )
    completeDispatchedRun(harness, 1)
    await expect(bossFanout).resolves.toMatchObject({ ok: true })

    // Empty Boss re-summon still owes synthesis — do not hand the baton to Worker.
    completeDispatchedRun(harness, 2)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(4), { timeout: 1000 })
    expect(harness.dispatched[3].ensembleRun?.participantId).toBe('boss')

    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[3].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'BOSS-SYNTHESIS after the fan-out wave.' }
    )
    completeDispatchedRun(harness, 3)
    // Authority-only Continuous auto-continue re-admits Boss (and fan-out
    // targets), not unanswered ordinary writers, after a productive synthesis.
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(5), { timeout: 1000 })
    expect(harness.dispatched[4].ensembleRun?.participantId).toBe('boss')
    await harness.orchestrator.cancelRound('ensemble-chat', 'Test complete.')
  })

  it("defers an @mention handoff until the caller's fan-out lane returns", async () => {
    const harness = makeFanoutRaceHarness()
    const { fanout } = await startUnresolvedReviewerFanout(harness)

    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: '@Researcher please take the next pass after review returns.' }
    )
    completeDispatchedRun(harness, 0)

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(harness.dispatched).toHaveLength(2)

    completeDispatchedRun(harness, 1)
    await expect(fanout).resolves.toMatchObject({ ok: true })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3), { timeout: 1000 })
    expect(harness.dispatched[2].ensembleRun?.participantId).toBe('gemini')
    expect(
      harness.chat.messages.some((message) =>
        message.content.includes('@-mention: Researcher promoted to speak next.')
      )
    ).toBe(true)
    completeDispatchedRun(harness, 2)
  })

  it('serializes concurrent accepted fan-outs and retains both ownership settlements', async () => {
    const reviewerGate = deferred<boolean>()
    const researcherGate = deferred<boolean>()
    const harness = makeHarness({
      dispatch: async (payload) => {
        if (!payload.ensembleRun?.laneId) {
          return { dispatched: true, appRunId: payload.appRunId || '' }
        }
        const accepted = await (payload.ensembleRun.participantId === 'claude'
          ? reviewerGate.promise
          : researcherGate.promise)
        return { dispatched: accepted, appRunId: payload.appRunId || '' }
      }
    })
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    harness.chat.ensemble!.participants = [
      {
        id: 'codex',
        provider: 'codex',
        enabled: true,
        role: 'Lead',
        instructions: 'Lead.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'claude',
        provider: 'claude',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review.',
        order: 2,
        permissionPresetId: 'read_only'
      },
      {
        id: 'kimi',
        provider: 'kimi',
        enabled: true,
        role: 'Researcher',
        instructions: 'Research.',
        order: 3,
        stageRole: 'reviewer',
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Issue two fan-out calls concurrently.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const ownerRunId = harness.dispatched[0].appRunId!

    const first = harness.orchestrator.fanoutForRun(ownerRunId, {
      targets: ['Reviewer'],
      prompt: 'First distinct review.'
    })
    const second = harness.orchestrator.fanoutForRun(ownerRunId, {
      targets: ['Researcher'],
      prompt: 'Second distinct review.'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(harness.dispatched).toHaveLength(2)

    reviewerGate.resolve(true)
    await expect(first).resolves.toMatchObject({ ok: true, participantIds: ['claude'] })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[2].ensembleRun?.participantId).toBe('kimi')
    researcherGate.resolve(true)
    await expect(second).resolves.toMatchObject({ ok: true, participantIds: ['kimi'] })

    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: ownerRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'OWNER-AFTER-TWO-FANOUTS.' }
    )
    completeDispatchedRun(harness, 0)
    harness.orchestrator.handleProviderOutput(
      'kimi',
      { appRunId: harness.dispatched[2].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'RESEARCHER-REPORT.' }
    )
    completeDispatchedRun(harness, 2)

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'REVIEWER-REPORT.' }
    )
    completeDispatchedRun(harness, 1)
    await vi.waitFor(() =>
      expect(
        harness.chat.messages.some((message) =>
          message.content.includes('OWNER-AFTER-TWO-FANOUTS.')
        )
      ).toBe(true)
    )
    const ownerIndex = harness.chat.messages.findIndex((message) =>
      message.content.includes('OWNER-AFTER-TWO-FANOUTS.')
    )
    expect(
      harness.chat.messages.findIndex((message) => message.content.includes('REVIEWER-REPORT.'))
    ).toBeLessThan(ownerIndex)
    expect(
      harness.chat.messages.findIndex((message) => message.content.includes('RESEARCHER-REPORT.'))
    ).toBeLessThan(ownerIndex)
  })

  it('serializes a failed fan-out before an accepted fan-out without losing its boundary', async () => {
    const rejectedGate = deferred<boolean>()
    const acceptedGate = deferred<boolean>()
    const harness = makeHarness({
      dispatch: async (payload) => {
        if (!payload.ensembleRun?.laneId) {
          return { dispatched: true, appRunId: payload.appRunId || '' }
        }
        const accepted = await (payload.ensembleRun.participantId === 'claude'
          ? rejectedGate.promise
          : acceptedGate.promise)
        return { dispatched: accepted, appRunId: payload.appRunId || '' }
      }
    })
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    harness.chat.ensemble!.participants = [
      {
        id: 'codex',
        provider: 'codex',
        enabled: true,
        role: 'Lead',
        instructions: 'Lead.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'claude',
        provider: 'claude',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review.',
        order: 2,
        permissionPresetId: 'read_only'
      },
      {
        id: 'kimi',
        provider: 'kimi',
        enabled: true,
        role: 'Researcher',
        instructions: 'Research.',
        order: 3,
        stageRole: 'reviewer',
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'The first concurrent call fails and the second succeeds.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const ownerRunId = harness.dispatched[0].appRunId!

    const rejected = harness.orchestrator.fanoutForRun(ownerRunId, {
      targets: ['Reviewer'],
      prompt: 'This dispatch will fail.'
    })
    const accepted = harness.orchestrator.fanoutForRun(ownerRunId, {
      targets: ['Researcher'],
      prompt: 'This dispatch will succeed.'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    rejectedGate.resolve(false)
    await expect(rejected).resolves.toMatchObject({ ok: false, error: 'dispatch_failed' })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    acceptedGate.resolve(true)
    await expect(accepted).resolves.toMatchObject({ ok: true, participantIds: ['kimi'] })

    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: ownerRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'OWNER-AFTER-FAILED-THEN-ACCEPTED.' }
    )
    completeDispatchedRun(harness, 0)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(
      harness.chat.messages.some((message) =>
        message.content.includes('OWNER-AFTER-FAILED-THEN-ACCEPTED.')
      )
    ).toBe(false)

    harness.orchestrator.handleProviderOutput(
      'kimi',
      { appRunId: harness.dispatched[2].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'ACCEPTED-REPORT.' }
    )
    completeDispatchedRun(harness, 2)
    await vi.waitFor(() =>
      expect(
        harness.chat.messages.some((message) =>
          message.content.includes('OWNER-AFTER-FAILED-THEN-ACCEPTED.')
        )
      ).toBe(true)
    )
    expect(
      harness.chat.messages.findIndex((message) => message.content.includes('ACCEPTED-REPORT.'))
    ).toBeLessThan(
      harness.chat.messages.findIndex((message) =>
        message.content.includes('OWNER-AFTER-FAILED-THEN-ACCEPTED.')
      )
    )
  })

  it('releases ownership when both completion-status saves fail', async () => {
    let rejectCompletionStatus = false
    const harness = makeHarness({
      beforeSaveChat: (next) => {
        const content = next.messages.at(-1)?.content || ''
        if (
          rejectCompletionStatus &&
          (content.includes('complete ·') || content.includes('tracking failed:'))
        ) {
          throw new Error('injected fan-out status save failure')
        }
      }
    })
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    harness.chat.ensemble!.participants = [
      {
        id: 'codex',
        provider: 'codex',
        enabled: true,
        role: 'Lead',
        instructions: 'Lead.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'claude',
        provider: 'claude',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review.',
        order: 2,
        permissionPresetId: 'read_only'
      },
      {
        id: 'gemini',
        provider: 'gemini',
        enabled: true,
        role: 'NextWriter',
        instructions: 'Continue.',
        order: 3,
        permissionPresetId: 'workspace_write'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Continue even if completion telemetry cannot persist.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const ownerRunId = harness.dispatched[0].appRunId!
    const fanout = await harness.orchestrator.fanoutForRun(ownerRunId, {
      targets: ['Reviewer'],
      prompt: 'Return before the next writer.'
    })
    expect(fanout.ok).toBe(true)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: ownerRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'OWNER-RELEASED-AFTER-STATUS-FAILURE.' }
    )
    completeDispatchedRun(harness, 0)
    rejectCompletionStatus = true
    completeDispatchedRun(harness, 1)

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(
      harness.chat.messages.some((message) =>
        message.content.includes('OWNER-RELEASED-AFTER-STATUS-FAILURE.')
      )
    ).toBe(true)
    const internals = harness.orchestrator as unknown as {
      roundsByChatId: Map<string, { activeScoutRunIds?: Set<string> }>
      runsByRunId: Map<string, unknown>
    }
    expect(internals.roundsByChatId.get('ensemble-chat')?.activeScoutRunIds).toBeUndefined()
    expect(internals.runsByRunId.has(ownerRunId)).toBe(false)

    rejectCompletionStatus = false
    completeDispatchedRun(harness, 2)
  })

  it('holds foreground ownership for an accepted single locked-writer lane', async () => {
    const previous = process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
    process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = '1'
    try {
      const harness = makeHarness()
      harness.chat.ensemble = {
        ...harness.chat.ensemble!,
        bossmanParticipantId: 'codex',
        fanoutPolicy: 'all',
        participants: [
          {
            id: 'codex',
            provider: 'codex',
            enabled: true,
            role: 'Boss',
            instructions: 'Coordinate.',
            order: 1,
            permissionPresetId: 'workspace_write'
          },
          {
            id: 'claude',
            provider: 'claude',
            enabled: true,
            role: 'Worker',
            instructions: 'Implement.',
            order: 2,
            permissionPresetId: 'workspace_write',
            stageRole: 'worker'
          },
          {
            id: 'gemini',
            provider: 'gemini',
            enabled: true,
            role: 'Verifier',
            instructions: 'Verify after implementation.',
            order: 3,
            permissionPresetId: 'workspace_write'
          }
        ]
      }
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Boss starts one writer lane, then verification follows.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1), { timeout: 1000 })

      const result = await harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
        targets: ['Worker'],
        prompt: 'Implement the scoped change.',
        mode: 'locked_writers',
        targetStage: 'workers',
        writeScopes: { Worker: ['src/worker/**'] }
      })
      expect(result).toMatchObject({
        ok: true,
        participantIds: ['claude'],
        laneIds: [expect.any(String)]
      })

      completeDispatchedRun(harness, 0)
      await new Promise((resolve) => setTimeout(resolve, 20))
      // The authority ring keeps the Boss on the baton while the accepted
      // writer lane is unresolved.
      expect(harness.dispatched).toHaveLength(3)
      expect(harness.dispatched[2].ensembleRun?.participantId).toBe('codex')

      completeDispatchedRun(harness, 1)
      harness.orchestrator.handleProviderOutput(
        'codex',
        { appRunId: harness.dispatched[2].appRunId, appChatId: 'ensemble-chat' },
        { type: 'content', text: 'BOSS-SYNTHESIS.' }
      )
      completeDispatchedRun(harness, 2)
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(4), { timeout: 1000 })
      expect(harness.dispatched[3].ensembleRun?.participantId).toBe('gemini')
      completeDispatchedRun(harness, 3)
    } finally {
      if (previous === undefined) delete process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
      else process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = previous
    }
  })

  it('releases a single locked writer back to serial rotation when its lane dispatch is not accepted', async () => {
    const previous = process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
    process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = '1'
    try {
      const harness = makeHarness({
        dispatch: async (payload) => ({
          dispatched: !payload.ensembleRun?.laneId,
          appRunId: payload.appRunId || ''
        })
      })
      harness.chat.ensemble = {
        ...harness.chat.ensemble!,
        bossmanParticipantId: 'codex',
        fanoutPolicy: 'all',
        participants: [
          {
            id: 'codex',
            provider: 'codex',
            enabled: true,
            role: 'Boss',
            instructions: 'Coordinate.',
            order: 1,
            permissionPresetId: 'workspace_write'
          },
          {
            id: 'claude',
            provider: 'claude',
            enabled: true,
            role: 'Worker',
            instructions: 'Implement.',
            order: 2,
            permissionPresetId: 'workspace_write',
            stageRole: 'worker'
          }
        ]
      }
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Boss starts and tries one writer lane.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1), { timeout: 1000 })

      const result = await harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
        targets: ['Worker'],
        prompt: 'Implement the scoped change.',
        mode: 'locked_writers',
        targetStage: 'workers',
        writeScopes: { Worker: ['src/worker/**'] }
      })

      expect(result).toMatchObject({ ok: false, error: 'dispatch_failed' })
      completeDispatchedRun(harness, 0)
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3), { timeout: 1000 })
      expect(harness.dispatched[1].ensembleRun?.laneId).toBeTruthy()
      expect(harness.dispatched[2].ensembleRun?.participantId).toBe('claude')
      expect(harness.dispatched[2].ensembleRun?.laneId).toBeUndefined()
      completeDispatchedRun(harness, 2)
    } finally {
      if (previous === undefined) delete process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
      else process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = previous
    }
  })

  it('does not let a fan-out lane yield poison the parent serial routing target', async () => {
    const harness = makeFanoutRaceHarness()
    const { fanout } = await startUnresolvedReviewerFanout(harness)

    const outcome = harness.orchestrator.markYielded(
      harness.dispatched[1].appRunId!,
      'Lane is done.',
      'Researcher'
    )
    expect(outcome).toMatchObject({
      kind: 'yielded',
      routing: { ok: false, reason: 'fanout_lane_ignored', target: 'Researcher' }
    })
    const runtime = (
      harness.orchestrator as unknown as {
        roundsByChatId: Map<
          string,
          {
            yieldRouting?: { kind: string }
            yieldReturnStack?: Array<{ targetParticipantId: string }>
          }
        >
      }
    ).roundsByChatId.get('ensemble-chat')
    expect(runtime?.yieldRouting?.kind).toBe('rejected')
    expect(runtime?.yieldReturnStack || []).toHaveLength(0)
    await expect(fanout).resolves.toMatchObject({ ok: true })

    completeDispatchedRun(harness, 0)

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3), { timeout: 1000 })
    expect(harness.dispatched[2].ensembleRun?.participantId).toBe('gemini')
    completeDispatchedRun(harness, 2)
  })

  it('review wave does not re-dispatch a reviewer already running in a fan-out lane', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    harness.chat.ensemble!.participants = [
      {
        id: 'codex',
        provider: 'codex',
        enabled: true,
        role: 'Builder',
        instructions: 'Do the work.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'claude',
        provider: 'claude',
        enabled: true,
        role: 'Reviewer A',
        instructions: 'Review.',
        order: 2,
        permissionPresetId: 'read_only',
        stageRole: 'reviewer'
      },
      {
        id: 'kimi',
        provider: 'kimi',
        enabled: true,
        role: 'Reviewer B',
        instructions: 'Review.',
        order: 3,
        permissionPresetId: 'read_only',
        stageRole: 'reviewer'
      },
      {
        id: 'gemini',
        provider: 'gemini',
        enabled: true,
        role: 'Reviewer C',
        instructions: 'Review.',
        order: 4,
        permissionPresetId: 'read_only',
        stageRole: 'reviewer'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Build, fan out one reviewer early, then close with the wave.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1), { timeout: 1000 })
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('codex')
    const fanout = harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
      targets: ['Reviewer A'],
      prompt: 'Early look while I keep building.'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2), { timeout: 1000 })
    expect(harness.dispatched[1].ensembleRun?.participantId).toBe('claude')

    completeDispatchedRun(harness, 0)

    // The caller retains foreground ownership while Reviewer A is still live.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(harness.dispatched).toHaveLength(2)

    completeDispatchedRun(harness, 1)
    await expect(fanout).resolves.toMatchObject({ ok: true })

    // Once Reviewer A returns, the closing wave fires only for the two idle
    // reviewers. The already-returned lane target must not be re-dispatched.
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(4), { timeout: 1000 })
    expect(
      new Set(harness.dispatched.slice(2).map((payload) => payload.ensembleRun?.participantId))
    ).toEqual(new Set(['kimi', 'gemini']))
    expect(
      harness.dispatched.filter((payload) => payload.ensembleRun?.participantId === 'claude')
    ).toHaveLength(1)

    completeDispatchedRun(harness, 2)
    completeDispatchedRun(harness, 3)
  })

  it('ensemble_fanout cannot target a participant reserved for a pending fan-out lane', async () => {
    const harness = makeFanoutRaceHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Lead starts.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1), { timeout: 1000 })
    // Simulate the reservation window: targets are reserved before their lane
    // runs are seeded into runsByRunId (the seat-compaction barrier can hold
    // that window open for seconds), so a concurrent ensemble_fanout must be
    // rejected by the reservation, not just by a live run.
    const runtime = (
      harness.orchestrator as unknown as {
        roundsByChatId: Map<string, { fanoutReservedParticipantIds?: Set<string> }>
      }
    ).roundsByChatId.get('ensemble-chat')!
    runtime.fanoutReservedParticipantIds = new Set(['claude'])

    await expect(
      harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
        targets: ['Reviewer'],
        prompt: 'Duplicate consult.'
      })
    ).resolves.toMatchObject({
      ok: false,
      error: 'invalid_target',
      message: expect.stringContaining('reserved')
    })
    expect(harness.dispatched).toHaveLength(1)

    runtime.fanoutReservedParticipantIds = undefined
    completeDispatchedRun(harness, 0)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2), { timeout: 1000 })
    completeDispatchedRun(harness, 1)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3), { timeout: 1000 })
    completeDispatchedRun(harness, 2)
  })

  it('1.0.8: ensemble_fanout locked_writers mode is feature-gated', async () => {
    const previous = process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
    process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = '0'
    try {
      const harness = makeHarness()
      harness.chat.ensemble!.fanoutPolicy = 'locked_writers_with_boss'
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Try writer fan-out.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

      const result = await harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
        targets: ['Worker'],
        prompt: 'Please edit in parallel.',
        mode: 'locked_writers'
      })

      expect(result.ok).toBe(false)
      expect(result.error).toBe('write_lanes_disabled')
    } finally {
      if (previous === undefined) {
        delete process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
      } else {
        process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = previous
      }
    }
  })

  it('all fan-out policy allows Boss-triggered locked writer lanes with writeScopes', async () => {
    const previous = process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
    process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = '1'
    try {
      const harness = makeHarness()
      harness.chat.ensemble = {
        ...harness.chat.ensemble!,
        bossmanParticipantId: 'claude',
        fanoutPolicy: 'all',
        participants: harness.chat.ensemble!.participants.map((participant) =>
          participant.id === 'codex' ? { ...participant, stageRole: 'worker' } : participant
        )
      }
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Boss starts.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1), { timeout: 1000 })

      const fanout = harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
        targets: ['Worker'],
        prompt: 'Edit only the worker files.',
        mode: 'locked_writers',
        targetStage: 'workers',
        writeScopes: { Worker: ['src/worker/**'] }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2), { timeout: 1000 })
      const writerRun = harness.dispatched[1]
      expect(writerRun.ensembleRun?.participantId).toBe('codex')
      expect(writerRun.ensembleRun?.laneId).toBeTruthy()
      harness.orchestrator.handleProviderOutput(
        writerRun.provider,
        { appRunId: writerRun.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
      await expect(fanout).resolves.toMatchObject({
        ok: true,
        targetStage: 'workers',
        participantIds: ['codex']
      })
    } finally {
      if (previous === undefined) {
        delete process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
      } else {
        process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = previous
      }
    }
  })

  it('1.0.8: falls back to serial dispatch when concurrent lanes are explicitly disabled', () => {
    const previous = process.env.TASKWRAITH_CONCURRENT_LANES
    process.env.TASKWRAITH_CONCURRENT_LANES = '0'
    try {
      const harness = makeHarness()
      const result = harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Try parallel.',
        event: { sender: {} as Electron.WebContents },
        concurrentMode: true
      })
      expect(result.status).toBe('started')
      expect(harness.chat.ensemble?.activeRound?.concurrentMode).toBeUndefined()
      expect(harness.chat.ensemble?.activeRound?.fanoutPolicy).toBe('off')
      expect(harness.chat.messages.at(-1)?.content).toContain('running participants serially')
    } finally {
      if (previous === undefined) {
        delete process.env.TASKWRAITH_CONCURRENT_LANES
      } else {
        process.env.TASKWRAITH_CONCURRENT_LANES = previous
      }
    }
  })

  it('1.0.8: fans out read-only Ollama participants in concurrent mode', async () => {
    const previous = process.env.TASKWRAITH_CONCURRENT_LANES
    process.env.TASKWRAITH_CONCURRENT_LANES = '1'
    try {
      const harness = makeHarness()
      harness.chat.ensemble!.participants = [
        {
          id: 'ollama-a',
          provider: 'ollama',
          enabled: true,
          role: 'Scout A',
          instructions: 'Scout.',
          order: 1,
          permissionPresetId: 'read_only',
          model: 'qwen3.5:9b',
          ollamaRunProfile: 'local_scout'
        },
        {
          id: 'ollama-b',
          provider: 'ollama',
          enabled: true,
          role: 'Scout B',
          instructions: 'Scout.',
          order: 2,
          permissionPresetId: 'read_only',
          model: 'gemma4:12b',
          ollamaRunProfile: 'approved_patcher'
        }
      ]

      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Fan out locally.',
        event: { sender: {} as Electron.WebContents },
        concurrentMode: true
      })

      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2), { timeout: 1000 })
      expect(harness.dispatched.map((payload) => payload.provider)).toEqual(['ollama', 'ollama'])
      expect(harness.dispatched.map((payload) => payload.ollamaRunProfile)).toEqual([
        'local_scout',
        'approved_patcher'
      ])
      expect(harness.chat.messages.at(-1)?.content).toContain('2 Ollama lane(s)')
    } finally {
      if (previous === undefined) {
        delete process.env.TASKWRAITH_CONCURRENT_LANES
      } else {
        process.env.TASKWRAITH_CONCURRENT_LANES = previous
      }
    }
  })

  it('1.0.8: fans out read-only participants in concurrent mode', async () => {
    const previous = process.env.TASKWRAITH_CONCURRENT_LANES
    process.env.TASKWRAITH_CONCURRENT_LANES = '1'
    try {
      const harness = makeHarness()
      harness.chat.ensemble!.participants = [
        {
          id: 'claude',
          provider: 'claude',
          enabled: true,
          role: 'Reviewer',
          instructions: 'Review.',
          order: 1,
          permissionPresetId: 'read_only'
        },
        {
          id: 'gemini',
          provider: 'gemini',
          enabled: true,
          role: 'Researcher',
          instructions: 'Research.',
          order: 2,
          permissionPresetId: 'read_only'
        },
        {
          id: 'codex',
          provider: 'codex',
          enabled: true,
          role: 'Worker',
          instructions: 'Work.',
          order: 3,
          permissionPresetId: 'workspace_write'
        }
      ]

      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Fan out then implement.',
        event: { sender: {} as Electron.WebContents },
        concurrentMode: true
      })

      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2), { timeout: 1000 })
      expect(harness.dispatched.map((p) => p.provider).sort()).toEqual(['claude', 'gemini'])
      expect(harness.chat.ensemble?.activeRound?.concurrentMode).toBe(true)
      expect(harness.chat.ensemble?.activeRound?.fanoutPolicy).toBe('read_only')
      const initialLanes = Object.values(harness.chat.ensemble?.activeRound?.lanes || {})
      expect(initialLanes).toHaveLength(2)
      expect(initialLanes.map((lane) => lane.status).sort()).toEqual(['running', 'running'])
      expect(harness.chat.ensemble?.activeRound?.activeParticipantId).toBeUndefined()
      expect(harness.dispatched[0].ensembleRun?.laneId).toBeTruthy()
      expect(harness.dispatched[1].ensembleRun?.laneId).toBeTruthy()

      const claudeRun = harness.dispatched.find((p) => p.provider === 'claude')!
      const geminiRun = harness.dispatched.find((p) => p.provider === 'gemini')!
      harness.orchestrator.handleProviderOutput(
        'claude',
        { appRunId: claudeRun.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
      harness.orchestrator.handleProviderOutput(
        'gemini',
        { appRunId: geminiRun.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )

      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3), { timeout: 1000 })
      expect(harness.dispatched[2].provider).toBe('codex')
      const finalLanes = Object.values(harness.chat.ensemble?.activeRound?.lanes || {})
      expect(finalLanes.map((lane) => lane.status).sort()).toEqual(['completed', 'completed'])
    } finally {
      if (previous === undefined) {
        delete process.env.TASKWRAITH_CONCURRENT_LANES
      } else {
        process.env.TASKWRAITH_CONCURRENT_LANES = previous
      }
    }
  })

  it('1.0.8: skips active read fan-out and continues to the serial writer', async () => {
    const previous = process.env.TASKWRAITH_CONCURRENT_LANES
    process.env.TASKWRAITH_CONCURRENT_LANES = '1'
    try {
      const harness = makeHarness()
      harness.chat.ensemble!.participants = [
        {
          id: 'claude',
          provider: 'claude',
          enabled: true,
          role: 'Reviewer',
          instructions: 'Review.',
          order: 1,
          permissionPresetId: 'read_only'
        },
        {
          id: 'gemini',
          provider: 'gemini',
          enabled: true,
          role: 'Researcher',
          instructions: 'Research.',
          order: 2,
          permissionPresetId: 'read_only'
        },
        {
          id: 'codex',
          provider: 'codex',
          enabled: true,
          role: 'Worker',
          instructions: 'Work.',
          order: 3,
          permissionPresetId: 'workspace_write'
        }
      ]

      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Fan out then implement.',
        event: { sender: {} as Electron.WebContents },
        concurrentMode: true
      })

      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2), { timeout: 1000 })
      const skipped = await harness.orchestrator.skipReadFanout('ensemble-chat')

      expect(skipped).toBe(true)
      expect(harness.cancelRun.mock.calls.map(([provider]) => provider).sort()).toEqual([
        'claude',
        'gemini'
      ])
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3), { timeout: 1000 })
      expect(harness.dispatched[2].provider).toBe('codex')
      const lanes = Object.values(harness.chat.ensemble?.activeRound?.lanes || {})
      expect(lanes.map((lane) => lane.status).sort()).toEqual(['cancelled', 'cancelled'])
      expect(
        harness.chat.messages.some(
          (message) =>
            message.role === 'system' &&
            typeof message.content === 'string' &&
            message.content.includes('Read fan-out skipped')
        )
      ).toBe(true)
    } finally {
      if (previous === undefined) {
        delete process.env.TASKWRAITH_CONCURRENT_LANES
      } else {
        process.env.TASKWRAITH_CONCURRENT_LANES = previous
      }
    }
  })

  it('1.0.8: does not skip active locked writer lanes', async () => {
    const previousWrite = process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
    process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = '1'
    try {
      const harness = makeHarness()
      harness.chat.ensemble = {
        ...harness.chat.ensemble!,
        bossmanParticipantId: 'claude',
        fanoutPolicy: 'locked_writers_with_boss'
      }
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Boss starts.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1), { timeout: 1000 })

      const fanout = harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
        targets: ['Worker'],
        prompt: 'Edit only the worker files.',
        mode: 'locked_writers',
        writeScopes: { Worker: ['src/worker/**'] }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2), { timeout: 1000 })

      const skipped = await harness.orchestrator.skipReadFanout('ensemble-chat')

      expect(skipped).toBe(false)
      expect(harness.cancelRun).not.toHaveBeenCalled()
      const writerRun = harness.dispatched[1]
      harness.orchestrator.handleProviderOutput(
        writerRun.provider,
        { appRunId: writerRun.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
      await expect(fanout).resolves.toMatchObject({ ok: true, participantIds: ['codex'] })
    } finally {
      if (previousWrite === undefined) {
        delete process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
      } else {
        process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = previousWrite
      }
    }
  })

  it('1.0.8: legacy concurrent mode keeps writers serial even when the write-lane gate is on', async () => {
    const previousConcurrent = process.env.TASKWRAITH_CONCURRENT_LANES
    const previousWrite = process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
    process.env.TASKWRAITH_CONCURRENT_LANES = '1'
    process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = '1'
    try {
      const harness = makeHarness()
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Run both lanes.',
        event: { sender: {} as Electron.WebContents },
        concurrentMode: true
      })

      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1), { timeout: 1000 })
      expect(harness.dispatched[0].provider).toBe('claude')
      expect(Object.values(harness.chat.ensemble?.activeRound?.lanes || {})).toHaveLength(0)
      expect(harness.chat.ensemble?.activeRound?.fanoutPolicy).toBe('read_only')
      expect(
        harness.chat.messages.some(
          (message) =>
            message.role === 'system' &&
            typeof message.content === 'string' &&
            message.content.includes(
              'Locked writer fan-out needs at least two writer-capable participants'
            )
        )
      ).toBe(false)

      harness.orchestrator.handleProviderOutput(
        'claude',
        { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2), { timeout: 1000 })
      expect(harness.dispatched[1].provider).toBe('codex')
    } finally {
      if (previousConcurrent === undefined) {
        delete process.env.TASKWRAITH_CONCURRENT_LANES
      } else {
        process.env.TASKWRAITH_CONCURRENT_LANES = previousConcurrent
      }
      if (previousWrite === undefined) {
        delete process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
      } else {
        process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = previousWrite
      }
    }
  })

  it('1.0.8: legacy concurrent mode does not run no-Boss writer preflight', async () => {
    const previousConcurrent = process.env.TASKWRAITH_CONCURRENT_LANES
    const previousWrite = process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
    process.env.TASKWRAITH_CONCURRENT_LANES = '1'
    process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = '1'
    try {
      const harness = makeHarness()
      harness.chat.ensemble = {
        ...harness.chat.ensemble!,
        participants: [
          {
            ...harness.chat.ensemble!.participants[0],
            role: 'WorkerA',
            permissionPresetId: 'workspace_write'
          },
          {
            ...harness.chat.ensemble!.participants[1],
            role: 'WorkerB',
            permissionPresetId: 'workspace_write'
          }
        ]
      }
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Legacy fan-out request.',
        event: { sender: {} as Electron.WebContents },
        concurrentMode: true
      })

      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1), { timeout: 1000 })
      expect(harness.chat.ensemble?.activeRound?.fanoutPolicy).toBe('read_only')
      expect(harness.dispatched[0].prompt).not.toContain('taskwraith_write_claim')
      expect(Object.values(harness.chat.ensemble?.activeRound?.lanes || {})).toHaveLength(0)
    } finally {
      if (previousConcurrent === undefined) {
        delete process.env.TASKWRAITH_CONCURRENT_LANES
      } else {
        process.env.TASKWRAITH_CONCURRENT_LANES = previousConcurrent
      }
      if (previousWrite === undefined) {
        delete process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
      } else {
        process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = previousWrite
      }
    }
  })

  it('1.0.8: user-preflight policy runs writer lanes after claim and matrix ack preflight', async () => {
    const previousConcurrent = process.env.TASKWRAITH_CONCURRENT_LANES
    const previousWrite = process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
    process.env.TASKWRAITH_CONCURRENT_LANES = '1'
    process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = '1'
    try {
      const harness = makeHarness()
      harness.chat.ensemble = {
        ...harness.chat.ensemble!,
        participants: [
          {
            ...harness.chat.ensemble!.participants[0],
            role: 'WorkerA',
            permissionPresetId: 'workspace_write'
          },
          {
            ...harness.chat.ensemble!.participants[1],
            role: 'WorkerB',
            permissionPresetId: 'workspace_write'
          }
        ]
      }
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Run parallel writers.',
        event: { sender: {} as Electron.WebContents },
        fanoutPolicy: 'locked_writers_user_preflight'
      })

      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2), { timeout: 1000 })
      const claimA = harness.dispatched[0]
      const claimB = harness.dispatched[1]
      expect(claimA.effectivePermissions?.readOnly).toBe(true)
      expect(claimB.effectivePermissions?.readOnly).toBe(true)
      harness.orchestrator.handleProviderOutput(
        claimA.provider,
        { appRunId: claimA.appRunId, appChatId: 'ensemble-chat' },
        {
          type: 'content',
          text: '```taskwraith_write_claim\n{"writeScopes":["src/a/**"],"operations":["edit"],"rationale":"Own A","canFallbackToSerial":true,"acknowledgeExclusiveScope":true}\n```'
        }
      )
      harness.orchestrator.handleProviderOutput(
        claimA.provider,
        { appRunId: claimA.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
      harness.orchestrator.handleProviderOutput(
        claimB.provider,
        { appRunId: claimB.appRunId, appChatId: 'ensemble-chat' },
        {
          type: 'content',
          text: '```taskwraith_write_claim\n{"writeScopes":["src/b/**"],"operations":["edit"],"rationale":"Own B","canFallbackToSerial":true,"acknowledgeExclusiveScope":true}\n```'
        }
      )
      harness.orchestrator.handleProviderOutput(
        claimB.provider,
        { appRunId: claimB.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )

      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(4), { timeout: 1000 })
      for (const ackRun of harness.dispatched.slice(2, 4)) {
        expect(ackRun.effectivePermissions?.readOnly).toBe(true)
        harness.orchestrator.handleProviderOutput(
          ackRun.provider,
          { appRunId: ackRun.appRunId, appChatId: 'ensemble-chat' },
          { type: 'content', text: '```taskwraith_write_ack\n{"acknowledgeMatrix":true}\n```' }
        )
        harness.orchestrator.handleProviderOutput(
          ackRun.provider,
          { appRunId: ackRun.appRunId, appChatId: 'ensemble-chat' },
          { type: 'result', status: 'success' }
        )
      }

      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(6), { timeout: 1000 })
      const writerRuns = harness.dispatched.slice(4, 6)
      expect(writerRuns.every((payload) => payload.effectivePermissions?.readOnly === false)).toBe(
        true
      )
      const writeLanes = Object.values(harness.chat.ensemble?.activeRound?.lanes || {}).filter(
        (lane) => lane.intent === 'write'
      )
      expect(writeLanes).toHaveLength(2)
      expect(writeLanes.map((lane) => lane.approvedWriteScopes?.[0]?.approvedBy).sort()).toEqual([
        'user-preflight',
        'user-preflight'
      ])
      const workerAWrite = writerRuns.find((payload) => payload.provider === claimA.provider)!
      expect(
        harness.orchestrator.validateLaneWriteScopeForRun(workerAWrite.appRunId, {
          toolName: 'write_file',
          workspacePath: '/repo',
          resourcePath: '/repo/src/a/output.ts'
        })
      ).toEqual({ ok: true })
      expect(
        harness.orchestrator.validateLaneWriteScopeForRun(workerAWrite.appRunId, {
          toolName: 'write_file',
          workspacePath: '/repo',
          resourcePath: '/repo/src/b/output.ts'
        })
      ).toMatchObject({ ok: false })

      for (const writerRun of writerRuns) {
        harness.orchestrator.handleProviderOutput(
          writerRun.provider,
          { appRunId: writerRun.appRunId, appChatId: 'ensemble-chat' },
          { type: 'result', status: 'success' }
        )
      }
    } finally {
      if (previousConcurrent === undefined) {
        delete process.env.TASKWRAITH_CONCURRENT_LANES
      } else {
        process.env.TASKWRAITH_CONCURRENT_LANES = previousConcurrent
      }
      if (previousWrite === undefined) {
        delete process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
      } else {
        process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = previousWrite
      }
    }
  })

  it('1.0.8: user-preflight policy falls back to serial on overlapping claims', async () => {
    const previousConcurrent = process.env.TASKWRAITH_CONCURRENT_LANES
    const previousWrite = process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
    process.env.TASKWRAITH_CONCURRENT_LANES = '1'
    process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = '1'
    try {
      const harness = makeHarness()
      harness.chat.ensemble = {
        ...harness.chat.ensemble!,
        participants: [
          {
            ...harness.chat.ensemble!.participants[0],
            role: 'WorkerA',
            permissionPresetId: 'workspace_write'
          },
          {
            ...harness.chat.ensemble!.participants[1],
            role: 'WorkerB',
            permissionPresetId: 'workspace_write'
          }
        ]
      }
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Run parallel writers.',
        event: { sender: {} as Electron.WebContents },
        fanoutPolicy: 'locked_writers_user_preflight'
      })

      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2), { timeout: 1000 })
      for (const claimRun of harness.dispatched.slice(0, 2)) {
        harness.orchestrator.handleProviderOutput(
          claimRun.provider,
          { appRunId: claimRun.appRunId, appChatId: 'ensemble-chat' },
          {
            type: 'content',
            text: '```taskwraith_write_claim\n{"writeScopes":["src/shared/**"],"operations":["edit"],"rationale":"Need shared files","canFallbackToSerial":true,"acknowledgeExclusiveScope":true}\n```'
          }
        )
        harness.orchestrator.handleProviderOutput(
          claimRun.provider,
          { appRunId: claimRun.appRunId, appChatId: 'ensemble-chat' },
          { type: 'result', status: 'success' }
        )
      }

      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3), { timeout: 1000 })
      expect(
        harness.chat.messages.some(
          (message) =>
            message.role === 'system' &&
            typeof message.content === 'string' &&
            message.content.includes('write-scope preflight found overlapping claims')
        )
      ).toBe(true)
      expect(harness.dispatched[2].ensembleRun?.laneId).toBeUndefined()
      expect(
        Object.values(harness.chat.ensemble?.activeRound?.lanes || {}).some(
          (lane) => lane.intent === 'write'
        )
      ).toBe(false)
    } finally {
      if (previousConcurrent === undefined) {
        delete process.env.TASKWRAITH_CONCURRENT_LANES
      } else {
        process.env.TASKWRAITH_CONCURRENT_LANES = previousConcurrent
      }
      if (previousWrite === undefined) {
        delete process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
      } else {
        process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = previousWrite
      }
    }
  })

  it('1.0.8: rejects explicit locked writer fan-out from a non-Boss and audits it', async () => {
    const previousWrite = process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
    process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = '1'
    const rejections: Array<{ metadata: Record<string, unknown> }> = []
    try {
      const harness = makeHarness({
        recordFanoutAuthorizationRejection: (rejection) => {
          rejections.push({ metadata: rejection.metadata })
        }
      })
      harness.chat.ensemble = {
        ...harness.chat.ensemble!,
        bossmanParticipantId: 'codex',
        fanoutPolicy: 'locked_writers_with_boss'
      }
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Reviewer starts.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1), { timeout: 1000 })

      const result = await harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
        targets: ['Worker'],
        prompt: 'Edit in parallel.',
        mode: 'locked_writers',
        writeScopes: { Worker: ['src/worker/**'] }
      })

      expect(result.ok).toBe(false)
      expect(result.error).toBe('not_authorized')
      expect(rejections).toHaveLength(1)
      expect(rejections[0].metadata).toMatchObject({
        kind: 'ensemble_fanout_rejected',
        reason: 'locked_writer_not_authorized',
        assignedBossmanParticipantId: 'codex'
      })
    } finally {
      if (previousWrite === undefined) {
        delete process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
      } else {
        process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = previousWrite
      }
    }
  })

  it('lets Captain dispatch locked writer variants while Boss is available', async () => {
    const previousWrite = process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
    process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = '1'
    try {
      const harness = makeHarness()
      harness.chat.ensemble = {
        ...harness.chat.ensemble!,
        bossmanParticipantId: 'boss',
        secondInCommandParticipantId: 'captain',
        fanoutPolicy: 'locked_writers_with_boss',
        participants: [
          {
            id: 'captain',
            provider: 'codex',
            enabled: true,
            role: 'Captain',
            instructions: 'Coordinate parallel work.',
            order: 1,
            permissionPresetId: 'workspace_write'
          },
          {
            id: 'boss',
            provider: 'claude',
            enabled: true,
            role: 'Boss',
            instructions: 'Own controlling authority.',
            order: 2,
            permissionPresetId: 'workspace_write'
          },
          {
            id: 'worker',
            provider: 'kimi',
            enabled: true,
            role: 'Worker',
            instructions: 'Implement.',
            order: 3,
            permissionPresetId: 'workspace_write',
            stageRole: 'worker'
          }
        ]
      }
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Captain starts while Boss remains healthy.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
      const captainRunId = harness.dispatched[0].appRunId
      expect(
        harness.orchestrator.listParticipantsForRun(captainRunId).bossmanAuthorityRole
      ).toBeUndefined()

      const result = await harness.orchestrator.fanoutForRun(captainRunId, {
        targets: ['Worker'],
        prompt: 'Implement only the worker slice.',
        mode: 'locked_writers',
        targetStage: 'workers',
        writeScopes: { Worker: ['src/worker/**'] },
        isolation: 'off'
      })

      expect(result).toMatchObject({
        ok: true,
        mode: 'locked_writers',
        targetStage: 'workers',
        participantIds: ['worker']
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
      expect(Object.values(harness.chat.ensemble?.activeRound?.lanes || {})).toEqual([
        expect.objectContaining({
          intent: 'write',
          approvedWriteScopes: [
            expect.objectContaining({
              kind: 'glob',
              path: 'src/worker/**',
              approvedBy: 'captain'
            })
          ]
        })
      ])
      completeDispatchedRun(harness, 1)
    } finally {
      if (previousWrite === undefined) {
        delete process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
      } else {
        process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = previousWrite
      }
    }
  })

  it('1.0.8: Boss can dispatch locked writer lanes only with approved write scopes', async () => {
    const previousWrite = process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
    process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = '1'
    try {
      const harness = makeHarness()
      harness.chat.ensemble = {
        ...harness.chat.ensemble!,
        bossmanParticipantId: 'claude',
        fanoutPolicy: 'locked_writers_with_boss'
      }
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Boss starts.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1), { timeout: 1000 })

      const missingScopes = await harness.orchestrator.fanoutForRun(
        harness.dispatched[0].appRunId,
        {
          targets: ['Worker'],
          prompt: 'Edit in parallel.',
          mode: 'locked_writers'
        }
      )
      expect(missingScopes.ok).toBe(false)
      expect(missingScopes.error).toBe('missing_write_scope')

      const fanout = harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
        targets: ['Worker'],
        prompt: 'Edit only the worker files.',
        mode: 'locked_writers',
        writeScopes: { Worker: ['src/worker/**'] }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2), { timeout: 1000 })
      const workerRun = harness.dispatched[1]
      const lanes = Object.values(harness.chat.ensemble?.activeRound?.lanes || {})
      expect(lanes).toHaveLength(1)
      expect(lanes[0]).toMatchObject({
        intent: 'write',
        approvedWriteScopes: [{ kind: 'glob', path: 'src/worker/**', approvedBy: 'boss' }]
      })
      expect(
        harness.orchestrator.validateLaneWriteScopeForRun(workerRun.appRunId, {
          toolName: 'write_file',
          workspacePath: '/repo',
          resourcePath: '/repo/src/worker/output.ts'
        })
      ).toEqual({ ok: true })
      expect(
        harness.orchestrator.validateLaneWriteScopeForRun(workerRun.appRunId, {
          toolName: 'apply_patch',
          workspacePath: '/repo',
          resourcePaths: ['/repo/src/worker/a.ts', '/repo/src/worker/nested/b.ts']
        })
      ).toEqual({ ok: true })
      expect(
        harness.orchestrator.validateLaneWriteScopeForRun(workerRun.appRunId, {
          toolName: 'apply_patch',
          workspacePath: '/repo',
          resourcePaths: ['/repo/src/worker/a.ts', '/repo/src/other/b.ts']
        })
      ).toMatchObject({ ok: false })
      expect(
        harness.orchestrator.validateLaneWriteScopeForRun(workerRun.appRunId, {
          toolName: 'write_file',
          workspacePath: '/repo',
          resourcePath: '/repo/src/other/output.ts'
        })
      ).toMatchObject({ ok: false })
      expect(
        harness.orchestrator.validateLaneWriteScopeForRun(workerRun.appRunId, {
          toolName: 'write_file',
          workspacePath: '/repo',
          resourcePath: '/tmp/outside.ts'
        })
      ).toMatchObject({ ok: false })
      expect(
        harness.orchestrator.validateLaneWriteScopeForRun(workerRun.appRunId, {
          toolName: 'git_commit',
          workspacePath: '/repo'
        })
      ).toMatchObject({ ok: false })

      harness.orchestrator.handleProviderOutput(
        workerRun.provider,
        { appRunId: workerRun.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
      await expect(fanout).resolves.toMatchObject({ ok: true, participantIds: ['codex'] })
    } finally {
      if (previousWrite === undefined) {
        delete process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
      } else {
        process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = previousWrite
      }
    }
  })

  it("1.0.4-AK6: threads fan-out briefs into the writer's prompt context after the parallel pass", async () => {
    // End-to-end: fan-out records briefs, then the serial
    // writer's prompt should include the "Fan-out briefs from the
    // parallel pass:" section with each scout's findings.
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'claude',
        provider: 'claude',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review.',
        order: 1,
        permissionPresetId: 'read_only'
      },
      {
        id: 'gemini',
        provider: 'gemini',
        enabled: true,
        role: 'Researcher',
        instructions: 'Research.',
        order: 2,
        permissionPresetId: 'read_only'
      },
      {
        id: 'codex',
        provider: 'codex',
        enabled: true,
        role: 'Worker',
        instructions: 'Implement.',
        order: 3,
        permissionPresetId: 'workspace_write'
      }
    ]
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Investigate then implement.',
      event: { sender: {} as Electron.WebContents }
    })
    // Both scouts dispatch in parallel.
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2), {
      timeout: 1000
    })
    const claudeRun = harness.dispatched.find((p) => p.provider === 'claude')!
    const geminiRun = harness.dispatched.find((p) => p.provider === 'gemini')!

    // Record briefs directly via the orchestrator API (matches
    // what the scout_brief MCP dispatcher does when an agent
    // calls the tool from within its lane).
    harness.orchestrator.recordScoutBrief(claudeRun.appRunId!, {
      participantId: 'claude',
      participantRole: 'Reviewer',
      provider: 'claude',
      findings: 'Module X locks shared state.',
      confidence: 'high',
      blockers: ['concurrency in X'],
      emittedAt: new Date().toISOString()
    })
    harness.orchestrator.recordScoutBrief(geminiRun.appRunId!, {
      participantId: 'gemini',
      participantRole: 'Researcher',
      provider: 'gemini',
      findings: 'External API expects v2 shape.',
      confidence: 'medium',
      emittedAt: new Date().toISOString()
    })

    // Resolve both scouts so the parallel pass closes.
    for (const run of [claudeRun, geminiRun]) {
      harness.orchestrator.handleProviderOutput(
        run.provider,
        { appRunId: run.appRunId, appChatId: 'ensemble-chat' },
        { type: 'content', text: 'Scout done.' }
      )
      harness.orchestrator.handleProviderOutput(
        run.provider,
        { appRunId: run.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
    }
    // Codex's writer dispatch happens — its prompt should now
    // contain the fan-out briefs section.
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3), {
      timeout: 1000
    })
    expect(harness.dispatched[2].provider).toBe('codex')
    const writerPrompt = harness.dispatched[2].prompt
    expect(writerPrompt).toContain('Fan-out briefs from the parallel pass:')
    expect(writerPrompt).toContain('[Reviewer (claude)] (high)')
    expect(writerPrompt).toContain('Module X locks shared state.')
    expect(writerPrompt).toContain('[Researcher (gemini)] (medium)')
    expect(writerPrompt).toContain('External API expects v2 shape.')
    // Blocker from Claude's brief surfaces too.
    expect(writerPrompt).toContain('Blockers:')
    expect(writerPrompt).toContain('- concurrency in X')
  })

  it('1.0.4-AK6: isParticipantInScoutPass returns false outside scout window', async () => {
    // Defensive coverage: the scout_brief handler relies on
    // isParticipantInScoutPass to gate writes. Outside a Work
    // Session (or before/after a fan-out pass) this MUST return
    // false so writer-step calls can't smuggle briefs in.
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Just a regular round.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runId = harness.dispatched[0].appRunId!
    // No fan-out pass ran — must be false.
    expect(harness.orchestrator.isParticipantInScoutPass(runId)).toBe(false)
  })

  it('1.0.4-AK5: skips fan-out when only one read-only participant is present', async () => {
    // Edge case: fan-out requires 2+ read-only participants
    // to actually parallelise. A single scout falls through to
    // the normal serial loop.
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'claude',
        provider: 'claude',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review.',
        order: 1,
        permissionPresetId: 'read_only'
      },
      {
        id: 'codex',
        provider: 'codex',
        enabled: true,
        role: 'Worker',
        instructions: 'Work.',
        order: 2,
        permissionPresetId: 'workspace_write'
      }
    ]
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Solo scout.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].provider).toBe('claude')
    // No parallel-pass note — only 1 scout means the gate
    // doesn't trigger.
    const scoutNote = harness.chat.messages.find(
      (m) =>
        m.role === 'system' &&
        typeof m.content === 'string' &&
        m.content.includes('Parallel fan-out')
    )
    expect(scoutNote).toBeUndefined()
  })

  it('P1b: clamps every participant to safe Plan for an unattended round', async () => {
    // Default fixture: Claude (read_only) then Codex (workspace_write).
    // An unattended/scheduled round must force BOTH to read-only so a
    // write-capable participant preset can't auto-accept edits with no
    // human at the keyboard. Claude is read-only natively, so the
    // load-bearing assertion is on Codex (the write-capable seat); we
    // drive Codex by completing Claude's run first.
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Run the scheduled occurrence.',
      event: { sender: {} as Electron.WebContents },
      unattended: true
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].provider).toBe('claude')
    expect(harness.dispatched[0].effectivePermissions?.presetId).toBe('plan')
    expect(harness.dispatched[0].effectivePermissions?.readOnly).toBe(true)
    expect(harness.dispatched[0].approvalMode).toBe('plan')
    expect(harness.dispatched[0].effectivePermissions?.agenticServices.subThreadDelegation).toBe(
      'ask'
    )
    expect(harness.dispatched[0].effectivePermissions?.agenticServices.simulatorCanvas).toBe('ask')

    // Advance to the write-capable Codex participant.
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 5 } }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

    // Codex carries `workspace_write` in the fixture; the unattended
    // clamp must override it to read-only (plan + readOnly).
    expect(harness.dispatched[1].provider).toBe('codex')
    expect(harness.dispatched[1].effectivePermissions?.presetId).toBe('plan')
    expect(harness.dispatched[1].effectivePermissions?.readOnly).toBe(true)
    expect(harness.dispatched[1].effectivePermissions?.approvalMode).toBe('plan')
    expect(harness.dispatched[1].approvalMode).toBe('plan')
    expect(harness.dispatched[1].effectivePermissions?.agenticServices.shellCommands).toBe('ask')
    expect(harness.dispatched[1].effectivePermissions?.agenticServices.fileChanges).toBe('ask')
    expect(harness.dispatched[1].effectivePermissions?.agenticServices.subThreadDelegation).toBe(
      'ask'
    )
    expect(harness.dispatched[1].effectivePermissions?.agenticServices.simulatorCanvas).toBe('ask')
  })

  it('P1b: an interactive round (unattended omitted) preserves the write-capable preset', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Run interactively.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].provider).toBe('claude')

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 5 } }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

    expect(harness.dispatched[1].provider).toBe('codex')
    expect(harness.dispatched[1].effectivePermissions?.presetId).toBe('workspace_write')
    expect(harness.dispatched[1].effectivePermissions?.readOnly).toBe(false)
  })

  it('P2: verified full_access lifts EVERY participant to workspace_write / auto_edit', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Run the elevated scheduled occurrence.',
      event: { sender: {} as Electron.WebContents },
      unattended: true,
      unattendedElevationLevel: 'full_access'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    // Even the natively read_only Claude participant is lifted to the uniform level.
    expect(harness.dispatched[0].provider).toBe('claude')
    expect(harness.dispatched[0].effectivePermissions?.presetId).toBe('workspace_write')
    expect(harness.dispatched[0].effectivePermissions?.readOnly).toBe(false)
    expect(harness.dispatched[0].effectivePermissions?.approvalMode).toBe('auto_edit')
    // Unattended elevation force-denies network egress.
    expect(harness.dispatched[0].effectivePermissions?.networkAccess).toBe('deny')
    expect(harness.dispatched[0].effectivePermissions?.agenticServices.subThreadDelegation).toBe(
      'allow'
    )
    expect(harness.dispatched[0].effectivePermissions?.agenticServices.simulatorCanvas).toBe(
      'allow'
    )

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 5 } }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('codex')
    expect(harness.dispatched[1].effectivePermissions?.presetId).toBe('workspace_write')
    expect(harness.dispatched[1].effectivePermissions?.readOnly).toBe(false)
    expect(harness.dispatched[1].effectivePermissions?.agenticServices.subThreadDelegation).toBe(
      'allow'
    )
    expect(harness.dispatched[1].effectivePermissions?.agenticServices.simulatorCanvas).toBe(
      'allow'
    )
  })

  it('keeps recorded Simulator grants compatible but redundant after elevation', async () => {
    const harness = makeHarness({
      getSettings: () => ({
        ...makeSettings(),
        agenticWorkspaceGrants: [
          {
            id: 'sim-grant',
            provider: 'agents',
            workspacePath: '/repo',
            service: 'simulatorCanvas',
            createdAt: '2026-08-08T00:00:00.000Z',
            updatedAt: '2026-08-08T00:00:00.000Z'
          }
        ]
      })
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Run the elevated scheduled occurrence with Simulator grant.',
      event: { sender: {} as Electron.WebContents },
      unattended: true,
      unattendedElevationLevel: 'full_access'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].effectivePermissions?.presetId).toBe('workspace_write')
    expect(harness.dispatched[0].effectivePermissions?.workspaceGrantServiceIds).toContain(
      'simulatorCanvas'
    )
    expect(harness.dispatched[0].effectivePermissions?.agenticServices.simulatorCanvas).toBe(
      'allow'
    )
    expect(harness.dispatched[0].effectivePermissions?.agenticServices.subThreadDelegation).toBe(
      'allow'
    )
  })

  it('honors elevation for GA GPT-5.6 participants in elevated unattended rounds (5.5 parity)', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.participants = harness.chat.ensemble!.participants.map((participant) =>
      participant.provider === 'codex' ? { ...participant, model: 'gpt-5.6-sol' } : participant
    )
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Run the elevated scheduled occurrence.',
      event: { sender: {} as Electron.WebContents },
      unattended: true,
      unattendedElevationLevel: 'full_access'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 5 } }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

    expect(harness.dispatched[1].provider).toBe('codex')
    expect(harness.dispatched[1].model).toBe('gpt-5.6-sol')
    expect(harness.dispatched[1].effectivePermissions?.presetId).toBe('workspace_write')
    expect(harness.dispatched[1].approvalMode).toBe('auto_edit')
    expect(harness.dispatched[1].effectivePermissions?.readOnly).toBe(false)
  })

  it('P2: verified default → the default preset', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Run default-elevated.',
      event: { sender: {} as Electron.WebContents },
      unattended: true,
      unattendedElevationLevel: 'default'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].effectivePermissions?.presetId).toBe('default')
    expect(harness.dispatched[0].effectivePermissions?.readOnly).toBe(false)
  })

  it('P2: no elevation level on an unattended round → safe Plan', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Run unattended, no elevation.',
      event: { sender: {} as Electron.WebContents },
      unattended: true
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].effectivePermissions?.presetId).toBe('plan')
    expect(harness.dispatched[0].approvalMode).toBe('plan')
  })

  it('P2: an elevation level WITHOUT unattended is ignored (interactive stays preset-driven)', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Interactive run.',
      event: { sender: {} as Electron.WebContents },
      unattendedElevationLevel: 'full_access' // no `unattended: true`
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    // Claude keeps its native read_only preset — the runtime never stashed the
    // level because `unattended` was false.
    expect(harness.dispatched[0].effectivePermissions?.presetId).toBe('read_only')
  })
})

describe('parseSelfReflectivePrefix', () => {
  it('strips a leading /discuss token and reports selfReflective=true', () => {
    expect(parseSelfReflectivePrefix('/discuss talk about TaskWraith')).toEqual({
      prompt: 'talk about TaskWraith',
      selfReflective: true
    })
  })

  it('accepts /meta as an alias', () => {
    expect(parseSelfReflectivePrefix('/meta reflect on the harness')).toEqual({
      prompt: 'reflect on the harness',
      selfReflective: true
    })
  })

  it('matches case-insensitively', () => {
    expect(parseSelfReflectivePrefix('/DISCUSS hey')).toEqual({
      prompt: 'hey',
      selfReflective: true
    })
  })

  it('does not match /discuss buried in the prompt body', () => {
    const input = 'Please explain how /discuss differs from /plan.'
    expect(parseSelfReflectivePrefix(input)).toEqual({
      prompt: input,
      selfReflective: false
    })
  })

  it('does not match prefixes like /discussion that share the leading letters', () => {
    const input = '/discussion topic'
    expect(parseSelfReflectivePrefix(input)).toEqual({
      prompt: input,
      selfReflective: false
    })
  })

  it('returns the original input when no slash prefix is present', () => {
    expect(parseSelfReflectivePrefix('plain prompt')).toEqual({
      prompt: 'plain prompt',
      selfReflective: false
    })
  })
})

/*
 * Spike 4 (docs/ensemble-posture-fanout-preamble-design.md) — staged
 * fan-out. Stage-role reviewers are excluded from the round-start read
 * pass and deferred behind every non-reviewer turn; once only reviewers
 * remain, eligible ones run as one parallel read-only "Review wave".
 */
describe('staged fan-out (stageRole)', () => {
  function completeRun(harness: ReturnType<typeof makeHarness>, index: number, text: string): void {
    harness.orchestrator.handleProviderOutput(
      harness.dispatched[index].provider as EnsembleParticipant['provider'],
      { appRunId: harness.dispatched[index].appRunId, appChatId: 'ensemble-chat' },
      { type: 'message', role: 'assistant', delta: true, content: text }
    )
    harness.orchestrator.handleProviderOutput(
      harness.dispatched[index].provider as EnsembleParticipant['provider'],
      { appRunId: harness.dispatched[index].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 5 } }
    )
  }

  it('defers a stage-role reviewer behind non-reviewer turns in a serial round', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'claude',
        provider: 'claude',
        enabled: true,
        role: 'Auditor',
        instructions: 'Review the work.',
        order: 1,
        permissionPresetId: 'read_only',
        stageRole: 'reviewer'
      },
      {
        id: 'codex',
        provider: 'codex',
        enabled: true,
        role: 'Builder',
        instructions: 'Do the work.',
        order: 2,
        permissionPresetId: 'workspace_write'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Build it, then review it.',
      event: { sender: {} as Electron.WebContents }
    })
    // Despite order 1, the reviewer waits: the Builder dispatches first.
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].provider).toBe('codex')
    const deferralNote = harness.chat.messages.find((message) =>
      message.content?.includes('is a reviewer; deferring their turn')
    )
    expect(deferralNote).toBeTruthy()
    completeRun(harness, 0, 'Built.')
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('claude')
  })

  it('keeps reviewers out of the round-start read pass and runs them as a closing review wave', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    harness.chat.ensemble!.participants = [
      {
        id: 'claude-rev',
        provider: 'claude',
        enabled: true,
        role: 'Reviewer A',
        instructions: 'Review.',
        order: 1,
        permissionPresetId: 'read_only',
        stageRole: 'reviewer'
      },
      {
        id: 'kimi-rev',
        provider: 'kimi',
        enabled: true,
        role: 'Reviewer B',
        instructions: 'Review.',
        order: 2,
        permissionPresetId: 'read_only',
        stageRole: 'reviewer'
      },
      {
        id: 'codex',
        provider: 'codex',
        enabled: true,
        role: 'Builder',
        instructions: 'Do the work.',
        order: 3,
        permissionPresetId: 'workspace_write'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Build then review.',
      event: { sender: {} as Electron.WebContents }
    })
    // Pre-spike both read_only reviewers would have fanned out at round
    // start, BEFORE the Builder's work existed. Now the Builder goes first.
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].provider).toBe('codex')
    completeRun(harness, 0, 'Built the feature.')
    // With only reviewers left, both dispatch concurrently as one wave.
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(new Set(harness.dispatched.slice(1).map((payload) => payload.provider))).toEqual(
      new Set(['claude', 'kimi'])
    )
    const waveNote = harness.chat.messages.find((message) =>
      message.content?.includes('Review wave')
    )
    expect(waveNote).toBeTruthy()
  })

  it('lets an explicit yield target run a reviewer immediately (routing outranks the stage gate)', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'codex',
        provider: 'codex',
        enabled: true,
        role: 'Builder',
        instructions: 'Do the work.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'claude',
        provider: 'claude',
        enabled: true,
        role: 'Auditor',
        instructions: 'Review the work.',
        order: 2,
        permissionPresetId: 'read_only',
        stageRole: 'reviewer'
      },
      {
        id: 'kimi',
        provider: 'kimi',
        enabled: true,
        role: 'Helper',
        instructions: 'Help.',
        order: 3,
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Start building.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].provider).toBe('codex')
    // Builder explicitly yields to the Auditor: the reviewer speaks next
    // even though the Helper (a non-reviewer) still awaits its turn.
    expectYielded(
      harness.orchestrator.markYielded(
        harness.dispatched[0].appRunId!,
        'Need a review now.',
        'Auditor'
      )
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('claude')
  })

  // Stage roles are permission-agnostic: a stage is a fan-out dispatch role,
  // never a permission requirement. Wave lanes always dispatch under the
  // signed read_only ("Ask") lane clamp regardless of the seat's configured
  // preset — the seat's own posture governs only its ordinary serial turns.
  // The only role-based permission distinction in ensembles stays Boss/
  // Captain authority, which is stage-independent.

  it('dispatches a write-postured scout in the opening wave under the read-only lane clamp', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    harness.chat.ensemble!.participants = [
      {
        id: 'kimi-scout',
        provider: 'kimi',
        enabled: true,
        role: 'Scout A',
        instructions: 'Investigate.',
        order: 1,
        permissionPresetId: 'read_only',
        stageRole: 'scout'
      },
      {
        id: 'codex-scout',
        provider: 'codex',
        enabled: true,
        role: 'Scout B',
        instructions: 'Investigate the build.',
        order: 2,
        permissionPresetId: 'workspace_write',
        stageRole: 'scout'
      },
      {
        id: 'claude-builder',
        provider: 'claude',
        enabled: true,
        role: 'Builder',
        instructions: 'Do the work.',
        order: 3,
        permissionPresetId: 'workspace_write'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Investigate, then build.',
      event: { sender: {} as Electron.WebContents }
    })
    // Both explicit scouts fan out concurrently — the write-postured seat's
    // preset no longer disqualifies it from the wave.
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(new Set(harness.dispatched.map((payload) => payload.provider))).toEqual(
      new Set(['kimi', 'codex'])
    )
    // Every wave lane carries the signed read_only lane clamp, including the
    // workspace_write scout.
    expect(
      harness.dispatched.every(
        (payload) =>
          payload.effectivePermissions?.presetId === 'read_only' &&
          payload.effectivePermissions?.readOnly === true
      )
    ).toBe(true)
    completeRun(harness, 0, 'Scout A findings.')
    completeRun(harness, 1, 'Scout B findings.')
    // The unstaged Builder keeps its ordinary serial turn under its OWN posture.
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[2].provider).toBe('claude')
    expect(harness.dispatched[2].effectivePermissions?.presetId).toBe('workspace_write')
    const waveNote = harness.chat.messages.find((message) =>
      message.content?.includes('Automatic read stage · 2 participant(s) dispatched concurrently')
    )
    expect(waveNote).toBeTruthy()
  })

  it('runs write-postured reviewers as a closing review wave under the read-only lane clamp', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    harness.chat.ensemble!.participants = [
      {
        id: 'codex',
        provider: 'codex',
        enabled: true,
        role: 'Builder',
        instructions: 'Do the work.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'claude-rev',
        provider: 'claude',
        enabled: true,
        role: 'Reviewer A',
        instructions: 'Review.',
        order: 2,
        permissionPresetId: 'workspace_write',
        stageRole: 'reviewer'
      },
      {
        id: 'kimi-rev',
        provider: 'kimi',
        enabled: true,
        role: 'Reviewer B',
        instructions: 'Review.',
        order: 3,
        permissionPresetId: 'workspace_write',
        stageRole: 'reviewer'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Build then review.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].provider).toBe('codex')
    completeRun(harness, 0, 'Built the feature.')
    // Pre-change these write-postured reviewers fell through to serial turns.
    // Now the review wave is stage-driven: both dispatch concurrently, each
    // lane clamped read-only.
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(new Set(harness.dispatched.slice(1).map((payload) => payload.provider))).toEqual(
      new Set(['claude', 'kimi'])
    )
    expect(
      harness.dispatched
        .slice(1)
        .every(
          (payload) =>
            payload.effectivePermissions?.presetId === 'read_only' &&
            payload.effectivePermissions?.readOnly === true
        )
    ).toBe(true)
    const waveNote = harness.chat.messages.find((message) =>
      message.content?.includes('Review wave')
    )
    expect(waveNote).toBeTruthy()
  })

  it('auto-continues Continuous mode after Review wave when hops remain', async () => {
    // Regression: after "Review wave complete · returning to serial writer
    // step." Continuous must keep going while hop budget remains — the
    // closing wave ends the serial queue for that pass, not the round.
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.maxContinuationHops = 50
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    harness.chat.ensemble!.participants = [
      {
        id: 'codex',
        provider: 'codex',
        enabled: true,
        role: 'Builder',
        instructions: 'Do the work.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'claude-rev',
        provider: 'claude',
        enabled: true,
        role: 'Reviewer A',
        instructions: 'Review.',
        order: 2,
        permissionPresetId: 'read_only',
        stageRole: 'reviewer'
      },
      {
        id: 'kimi-rev',
        provider: 'kimi',
        enabled: true,
        role: 'Reviewer B',
        instructions: 'Review.',
        order: 3,
        permissionPresetId: 'read_only',
        stageRole: 'reviewer'
      }
    ]
    const completeWithProgress = (index: number, text: string): void => {
      const payload = harness.dispatched[index]
      harness.orchestrator.handleProviderOutput(
        payload.provider as EnsembleParticipant['provider'],
        { appRunId: payload.appRunId, appChatId: 'ensemble-chat' },
        { type: 'content', text }
      )
      harness.orchestrator.handleProviderOutput(
        payload.provider as EnsembleParticipant['provider'],
        { appRunId: payload.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
    }

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Build, review, keep going.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('codex')
    completeWithProgress(0, 'Built the feature.')

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(new Set(harness.dispatched.slice(1).map((payload) => payload.provider))).toEqual(
      new Set(['claude', 'kimi'])
    )
    expect(
      harness.chat.messages.some((message) => (message.content || '').includes('Review wave'))
    ).toBe(true)

    completeWithProgress(1, 'Looks good from A.')
    completeWithProgress(2, 'Looks good from B.')

    await vi.waitFor(() =>
      expect(
        harness.chat.messages.some(
          (message) =>
            (message.content || '').includes(
              'Review wave complete · returning to serial writer step.'
            ) ||
            (message.content || '').includes(
              'Review wave complete · continuing Continuous while hops remain.'
            )
        )
      ).toBe(true)
    )
    await vi.waitFor(() => expect(harness.dispatched.length).toBeGreaterThan(3))
    expect(harness.chat.ensemble?.activeRound?.status).toBe('running')
    expect(
      harness.chat.messages.some(
        (message) =>
          typeof message.content === 'string' &&
          message.content.includes('auto-continuing for pass')
      )
    ).toBe(true)
    expect(harness.chat.ensemble?.activeRound?.continuationHops || 0).toBeGreaterThan(0)
  })

  it('auto-continues Continuous mode after Review wave when Boss routed the writer', async () => {
    // Same closing-wave drain as above, but with Continuous authority
    // selection on pass 1 (Boss must route before ordinary seats).
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.maxContinuationHops = 50
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    harness.chat.ensemble!.bossmanParticipantId = 'codex-boss'
    harness.chat.ensemble!.participants = [
      {
        id: 'codex-boss',
        provider: 'codex',
        enabled: true,
        role: 'Boss',
        instructions: 'Coordinate.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'claude-worker',
        provider: 'claude',
        enabled: true,
        role: 'Worker',
        instructions: 'Do the work.',
        order: 2,
        permissionPresetId: 'workspace_write',
        stageRole: 'worker'
      },
      {
        id: 'kimi-rev',
        provider: 'kimi',
        enabled: true,
        role: 'Reviewer A',
        instructions: 'Review.',
        order: 3,
        permissionPresetId: 'read_only',
        stageRole: 'reviewer'
      },
      {
        id: 'grok-rev',
        provider: 'grok',
        enabled: true,
        role: 'Reviewer B',
        instructions: 'Review.',
        order: 4,
        permissionPresetId: 'read_only',
        stageRole: 'reviewer'
      }
    ]
    const completeWithProgress = (index: number, text: string): void => {
      const payload = harness.dispatched[index]
      harness.orchestrator.handleProviderOutput(
        payload.provider as EnsembleParticipant['provider'],
        { appRunId: payload.appRunId, appChatId: 'ensemble-chat' },
        { type: 'content', text }
      )
      harness.orchestrator.handleProviderOutput(
        payload.provider as EnsembleParticipant['provider'],
        { appRunId: payload.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
    }

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Boss directs, then review, keep going.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('codex-boss')
    expect(harness.dispatched[0].prompt).toContain('Authority routing checkpoint')

    const selection = await harness.orchestrator.bossmanControlForRun(
      harness.dispatched[0].appRunId,
      {
        action: 'select_participants',
        participantRoles: ['Worker', 'Reviewer A', 'Reviewer B'],
        reason: 'Keep the worker and both reviewers.'
      }
    )
    expect(selection).toMatchObject({ ok: true, action: 'select_participants' })
    // End without yield so the selected serial queue (Worker → Review wave)
    // advances instead of a yield-return re-summoning Boss.
    completeWithProgress(0, 'Selected the worker and reviewers; proceed.')

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].ensembleRun?.participantId).toBe('claude-worker')
    completeWithProgress(1, 'Built.')

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(4))
    expect(new Set(harness.dispatched.slice(2).map((payload) => payload.provider))).toEqual(
      new Set(['kimi', 'grok'])
    )
    completeWithProgress(2, 'Review A ok.')
    completeWithProgress(3, 'Review B ok.')

    await vi.waitFor(() =>
      expect(
        harness.chat.messages.some(
          (message) =>
            (message.content || '').includes(
              'Review wave complete · returning to serial writer step.'
            ) ||
            (message.content || '').includes(
              'Review wave complete · continuing Continuous while hops remain.'
            )
        )
      ).toBe(true)
    )
    await vi.waitFor(() => expect(harness.dispatched.length).toBeGreaterThan(4))
    expect(harness.chat.ensemble?.activeRound?.status).toBe('running')
    expect(
      harness.chat.messages.some(
        (message) =>
          typeof message.content === 'string' &&
          message.content.includes('auto-continuing for pass')
      )
    ).toBe(true)
    expect(harness.chat.ensemble?.activeRound?.continuationHops || 0).toBeGreaterThan(0)
  })

  it('keeps Continuous going after Review wave when the pass produced only skipped output', async () => {
    // Regression: tryAutoContinueRound's no-progress guard treats an all-skipped
    // pass as terminal. A closing Review wave with empty lane output (and a
    // quiet Boss) used to Task-Complete while hops remained.
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.maxContinuationHops = 50
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    harness.chat.ensemble!.bossmanParticipantId = 'codex-boss'
    harness.chat.ensemble!.participants = [
      {
        id: 'codex-boss',
        provider: 'codex',
        enabled: true,
        role: 'Boss',
        instructions: 'Coordinate.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'claude-rev',
        provider: 'claude',
        enabled: true,
        role: 'Reviewer A',
        instructions: 'Review.',
        order: 2,
        permissionPresetId: 'read_only',
        stageRole: 'reviewer'
      },
      {
        id: 'kimi-rev',
        provider: 'kimi',
        enabled: true,
        role: 'Reviewer B',
        instructions: 'Review.',
        order: 3,
        permissionPresetId: 'read_only',
        stageRole: 'reviewer'
      }
    ]
    const completeEmpty = (index: number): void => {
      const payload = harness.dispatched[index]
      harness.orchestrator.handleProviderOutput(
        payload.provider as EnsembleParticipant['provider'],
        { appRunId: payload.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
    }

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Review quietly and keep the round alive.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('codex-boss')
    const selection = await harness.orchestrator.bossmanControlForRun(
      harness.dispatched[0].appRunId,
      {
        action: 'select_participants',
        participantRoles: ['Reviewer A', 'Reviewer B'],
        reason: 'Only reviewers this pass.'
      }
    )
    expect(selection).toMatchObject({ ok: true, action: 'select_participants' })
    completeEmpty(0)

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(new Set(harness.dispatched.slice(1).map((payload) => payload.provider))).toEqual(
      new Set(['claude', 'kimi'])
    )
    completeEmpty(1)
    completeEmpty(2)

    await vi.waitFor(() =>
      expect(
        harness.chat.messages.some((message) =>
          (message.content || '').includes('Review wave complete')
        )
      ).toBe(true)
    )
    await vi.waitFor(() => expect(harness.dispatched.length).toBeGreaterThan(3))
    expect(harness.chat.ensemble?.activeRound?.status).toBe('running')
    expect(harness.chat.ensemble?.activeRound?.continuationHops || 0).toBeGreaterThan(0)
  })

  it('broad ensemble_fanout discovery includes write-postured idle seats as clamped lanes', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    harness.chat.ensemble!.bossmanParticipantId = 'codex'
    harness.chat.ensemble!.participants = [
      {
        id: 'codex',
        provider: 'codex',
        enabled: true,
        role: 'Boss',
        instructions: 'Coordinate.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'claude',
        provider: 'claude',
        enabled: true,
        role: 'Helper',
        instructions: 'Help out.',
        order: 2,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'kimi',
        provider: 'kimi',
        enabled: true,
        role: 'Researcher',
        instructions: 'Research.',
        order: 3,
        permissionPresetId: 'read_only'
      }
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Fan the panel out.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].provider).toBe('codex')
    // Broad discovery (no targets) used to exclude the write-postured Helper.
    // Discovery is now permission-agnostic; every lane still dispatches under
    // the read_only clamp.
    const result = await harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
      prompt: 'Everyone: inspect the failing suite.'
    })
    expect(result.ok).toBe(true)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(new Set(harness.dispatched.slice(1).map((payload) => payload.provider))).toEqual(
      new Set(['claude', 'kimi'])
    )
    expect(
      harness.dispatched
        .slice(1)
        .every(
          (payload) =>
            payload.effectivePermissions?.presetId === 'read_only' &&
            payload.effectivePermissions?.readOnly === true
        )
    ).toBe(true)
  })
})

describe('background stage routing', () => {
  function backgroundParticipant(
    overrides: Partial<EnsembleParticipant> = {}
  ): EnsembleParticipant {
    return {
      id: 'background-shell',
      provider: 'claude',
      enabled: true,
      role: 'Shell helper',
      instructions: 'Run scoped background checks and report evidence.',
      order: 2,
      permissionPresetId: 'workspace_write',
      stageRole: 'background' as EnsembleParticipant['stageRole'],
      ...overrides
    }
  }

  it('does not give a background participant an ordinary serial turn', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'lead',
        provider: 'codex',
        enabled: true,
        role: 'Lead',
        instructions: 'Lead the round.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      backgroundParticipant()
    ]

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Handle this normally without delegating background work.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('lead')

    completeDispatchedRun(harness, 0)
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    expect(harness.dispatched).toHaveLength(1)
    expect(
      harness.chat.ensemble?.activeRound?.participants.map((entry) => entry.participantId)
    ).toEqual(['lead'])
  })

  it('keeps a one-foreground-plus-BG roster usable when Read fan-out is selected', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    harness.chat.ensemble!.participants = [
      {
        id: 'lead',
        provider: 'codex',
        enabled: true,
        role: 'Lead',
        instructions: 'Lead the round.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      backgroundParticipant()
    ]

    expect(() =>
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Handle this without background work.',
        event: { sender: {} as Electron.WebContents }
      })
    ).not.toThrow()
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('lead')

    completeDispatchedRun(harness, 0)
  })

  it('explains an all-BG round that did not explicitly delegate a seat', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      backgroundParticipant({ id: 'background-tests', role: 'Test runner', order: 1 }),
      backgroundParticipant({
        id: 'background-logs',
        provider: 'kimi',
        role: 'Log watcher',
        order: 2
      })
    ]

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Investigate this.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    expect(harness.dispatched).toHaveLength(0)
    expect(
      harness.chat.messages.some(
        (message) =>
          typeof message.content === 'string' &&
          message.content.includes('No foreground participant was scheduled')
      )
    ).toBe(true)
  })

  it('launches a user-mentioned BG seat asynchronously under its own seat posture', async () => {
    // 1e429e182: a composer @BG mention honors the seat's own permissions
    // (workspace_write here) instead of the old unconditional read-only clamp;
    // peer/yield-directed BG lanes keep the clamp (EnsembleBackgroundPosture.test.ts).
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'lead',
        provider: 'codex',
        enabled: true,
        role: 'Lead',
        instructions: 'Lead the foreground round.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      backgroundParticipant()
    ]

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: '@BG run the shell checks while Lead handles the foreground answer.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    const backgroundIndex = harness.dispatched.findIndex(
      (payload) => payload.ensembleRun?.participantId === 'background-shell'
    )
    const leadIndex = harness.dispatched.findIndex(
      (payload) => payload.ensembleRun?.participantId === 'lead'
    )
    expect(backgroundIndex).toBeGreaterThanOrEqual(0)
    expect(leadIndex).toBeGreaterThanOrEqual(0)
    expect(harness.dispatched[backgroundIndex].ensembleRun?.laneId).toBeTruthy()
    expect(harness.dispatched[backgroundIndex].effectivePermissions?.readOnly).toBe(false)
    expect(harness.dispatched[backgroundIndex].prompt).toContain('Stage role: background')

    completeDispatchedRun(harness, leadIndex)
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('running'))
    harness.orchestrator.handleProviderOutput(
      harness.dispatched[backgroundIndex].provider,
      {
        appRunId: harness.dispatched[backgroundIndex].appRunId,
        appChatId: 'ensemble-chat'
      },
      { type: 'message', role: 'assistant', delta: true, content: 'BG checks passed.' }
    )
    completeDispatchedRun(harness, backgroundIndex)
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    const result = harness.chat.messages.find((message) =>
      message.content?.includes('BG checks passed.')
    )
    expect(result?.metadata).toMatchObject({
      ensembleParticipantId: 'background-shell',
      ensembleStageRole: 'background',
      ensembleLaneIntent: 'write'
    })
  })

  it('appends detached BG completion before draining into a queued round', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'lead',
        provider: 'codex',
        enabled: true,
        role: 'Lead',
        instructions: 'Lead the foreground round.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      backgroundParticipant()
    ]

    const started = harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: '@BG run checks while Lead handles the first round.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    const firstRoundId = started.roundId
    const backgroundIndex = harness.dispatched.findIndex(
      (payload) => payload.ensembleRun?.participantId === 'background-shell'
    )
    const leadIndex = harness.dispatched.findIndex(
      (payload) => payload.ensembleRun?.participantId === 'lead'
    )
    expect(
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'QUEUED-AFTER-BACKGROUND',
        event: { sender: {} as Electron.WebContents }
      })
    ).toMatchObject({ status: 'queued' })

    completeDispatchedRun(harness, leadIndex)
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('running'))
    harness.orchestrator.handleProviderOutput(
      harness.dispatched[backgroundIndex].provider,
      {
        appRunId: harness.dispatched[backgroundIndex].appRunId,
        appChatId: 'ensemble-chat'
      },
      {
        type: 'message',
        role: 'assistant',
        delta: true,
        content: 'BG-BEFORE-QUEUED-ROUND'
      }
    )
    completeDispatchedRun(harness, backgroundIndex)

    // Same-round absorb after BG settles — not a fresh beginRound.
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[2].ensembleRun?.participantId).toBe('lead')
    expect(harness.chat.ensemble?.activeRound?.roundId).toBe(firstRoundId)
    const bgResultIndex = harness.chat.messages.findIndex(
      (message) => message.content === 'BG-BEFORE-QUEUED-ROUND'
    )
    const bgCompleteIndex = harness.chat.messages.findIndex((message) =>
      message.content.includes('Background complete')
    )
    const queuedRoundIndex = harness.chat.messages.findIndex(
      (message) => message.role === 'user' && message.content === 'QUEUED-AFTER-BACKGROUND'
    )
    expect(bgResultIndex).toBeGreaterThanOrEqual(0)
    expect(bgCompleteIndex).toBeGreaterThan(bgResultIndex)
    expect(queuedRoundIndex).toBeGreaterThan(bgCompleteIndex)

    completeDispatchedRun(harness, 2)
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
  })

  it('does not bypass the global parallel-lane kill switch', async () => {
    const previous = process.env.TASKWRAITH_CONCURRENT_LANES
    process.env.TASKWRAITH_CONCURRENT_LANES = '0'
    try {
      const harness = makeHarness()
      harness.chat.ensemble!.participants = [
        {
          id: 'lead',
          provider: 'codex',
          enabled: true,
          role: 'Lead',
          instructions: 'Lead the foreground round.',
          order: 1,
          permissionPresetId: 'workspace_write'
        },
        backgroundParticipant()
      ]
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: '@BG run checks while Lead continues.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
      expect(harness.dispatched[0].ensembleRun?.participantId).toBe('lead')
      expect(
        harness.chat.messages.some(
          (message) =>
            typeof message.content === 'string' &&
            message.content.includes('Background dispatch not launched') &&
            message.content.includes('TASKWRAITH_CONCURRENT_LANES=0')
        )
      ).toBe(true)
      completeDispatchedRun(harness, 0)
    } finally {
      if (previous === undefined) {
        delete process.env.TASKWRAITH_CONCURRENT_LANES
      } else {
        process.env.TASKWRAITH_CONCURRENT_LANES = previous
      }
    }
  })

  it('does not guess when a bare @BG mention matches multiple background seats', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'lead',
        provider: 'codex',
        enabled: true,
        role: 'Lead',
        instructions: 'Lead the foreground round.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      backgroundParticipant({
        id: 'background-tests',
        role: 'Test runner',
        order: 2
      }),
      backgroundParticipant({
        id: 'background-logs',
        provider: 'kimi',
        role: 'Log watcher',
        order: 3
      })
    ]

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: '@BG investigate while Lead continues.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('lead')
    expect(
      harness.chat.messages.some(
        (message) =>
          typeof message.content === 'string' &&
          message.content.includes('`@BG` was ambiguous') &&
          message.content.includes('No background lane launched')
      )
    ).toBe(true)

    completeDispatchedRun(harness, 0)
  })

  it('never treats a background lane as Boss or Captain authority', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.bossmanParticipantId = 'background-shell'
    harness.chat.ensemble!.participants = [
      {
        id: 'lead',
        provider: 'codex',
        enabled: true,
        role: 'Lead',
        instructions: 'Lead the foreground round.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      backgroundParticipant()
    ]

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: '@BG run the checks while Lead continues.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    const backgroundRun = harness.dispatched.find(
      (payload) => payload.ensembleRun?.participantId === 'background-shell'
    )
    expect(backgroundRun).toBeTruthy()

    const participantView = harness.orchestrator.listParticipantsForRun(backgroundRun?.appRunId)
    expect(participantView.ok).toBe(true)
    expect(participantView.bossmanAuthorityRole).toBeUndefined()
    expect(participantView.rosterEditAllowed).toBe(false)
    expect(
      harness.chat.messages.some(
        (message) =>
          typeof message.content === 'string' &&
          message.content.includes('BG seats cannot own Ensemble authority')
      )
    ).toBe(true)

    await harness.orchestrator.cancelRound('ensemble-chat')
  })

  it('turns an agent @BG mention into a lane without delaying the next serial seat', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'lead',
        provider: 'codex',
        enabled: true,
        role: 'Lead',
        instructions: 'Delegate checks.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'worker',
        provider: 'kimi',
        enabled: true,
        role: 'Worker',
        instructions: 'Continue foreground work.',
        order: 2,
        permissionPresetId: 'workspace_write'
      },
      backgroundParticipant({ order: 3 })
    ]

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Coordinate the work.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      {
        type: 'message',
        role: 'assistant',
        delta: true,
        content: '@BG run the shell tests while Worker continues.'
      }
    )
    completeDispatchedRun(harness, 0)

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    const backgroundIndex = harness.dispatched.findIndex(
      (payload) => payload.ensembleRun?.participantId === 'background-shell'
    )
    const workerIndex = harness.dispatched.findIndex(
      (payload) => payload.ensembleRun?.participantId === 'worker'
    )
    expect(harness.dispatched[backgroundIndex].ensembleRun?.laneId).toBeTruthy()
    expect(harness.dispatched[workerIndex].ensembleRun?.laneId).toBeUndefined()

    completeDispatchedRun(harness, workerIndex)
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('running'))
    completeDispatchedRun(harness, backgroundIndex)
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
  })

  it('can dispatch the same BG seat twice without duplicating either result', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'lead',
        provider: 'codex',
        enabled: true,
        role: 'Lead',
        instructions: 'Delegate the first check.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'worker',
        provider: 'kimi',
        enabled: true,
        role: 'Worker',
        instructions: 'Delegate the second check.',
        order: 2,
        permissionPresetId: 'workspace_write'
      },
      backgroundParticipant({ order: 3 })
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Run two foreground steps.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'message', role: 'assistant', delta: true, content: '@BG run first check.' }
    )
    completeDispatchedRun(harness, 0)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    const firstBackgroundIndex = harness.dispatched.findIndex(
      (payload, index) => index > 0 && payload.ensembleRun?.participantId === 'background-shell'
    )
    const workerIndex = harness.dispatched.findIndex(
      (payload) => payload.ensembleRun?.participantId === 'worker'
    )
    harness.orchestrator.handleProviderOutput(
      harness.dispatched[firstBackgroundIndex].provider,
      {
        appRunId: harness.dispatched[firstBackgroundIndex].appRunId,
        appChatId: 'ensemble-chat'
      },
      { type: 'message', role: 'assistant', delta: true, content: 'FIRST-BG-RESULT' }
    )
    completeDispatchedRun(harness, firstBackgroundIndex)
    await vi.waitFor(() =>
      expect(
        harness.chat.messages.some(
          (message) =>
            typeof message.content === 'string' && message.content.includes('Background complete')
        )
      ).toBe(true)
    )

    harness.orchestrator.handleProviderOutput(
      harness.dispatched[workerIndex].provider,
      { appRunId: harness.dispatched[workerIndex].appRunId, appChatId: 'ensemble-chat' },
      { type: 'message', role: 'assistant', delta: true, content: '@BG run second check.' }
    )
    completeDispatchedRun(harness, workerIndex)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(4))
    const secondBackgroundIndex = harness.dispatched.findIndex(
      (payload, index) =>
        index !== firstBackgroundIndex && payload.ensembleRun?.participantId === 'background-shell'
    )
    harness.orchestrator.handleProviderOutput(
      harness.dispatched[secondBackgroundIndex].provider,
      {
        appRunId: harness.dispatched[secondBackgroundIndex].appRunId,
        appChatId: 'ensemble-chat'
      },
      { type: 'message', role: 'assistant', delta: true, content: 'SECOND-BG-RESULT' }
    )
    completeDispatchedRun(harness, secondBackgroundIndex)
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))

    expect(
      harness.chat.messages.filter((message) => message.content === 'FIRST-BG-RESULT')
    ).toHaveLength(1)
    expect(
      harness.chat.messages.filter((message) => message.content === 'SECOND-BG-RESULT')
    ).toHaveLength(1)
    const backgroundRunPromptIds = harness.chat.runs
      .filter((run) => run.ensembleParticipantId === 'background-shell')
      .map((run) => run.promptMessageId)
    expect(new Set(backgroundRunPromptIds).size).toBe(2)
  })

  it('cancels an active BG lane immediately with the rest of the round', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [
      {
        id: 'lead',
        provider: 'codex',
        enabled: true,
        role: 'Lead',
        instructions: 'Lead foreground work.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      backgroundParticipant()
    ]
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: '@BG run a long check while Lead works.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

    expect(await harness.orchestrator.cancelRound('ensemble-chat')).toBe(true)
    expect(harness.chat.ensemble?.activeRound?.status).toBe('cancelled')
    const lanes = Object.values(harness.chat.ensemble?.activeRound?.lanes || {})
    expect(lanes).toHaveLength(1)
    expect(lanes[0].status).toBe('cancelled')
    expect(harness.cancelRun).toHaveBeenCalledTimes(2)
  })
})

/*
 * Spike 6 — durable scout briefs. `runtime.scoutBriefs` dies with the
 * round; recordScoutBrief now also upserts a session-scoped blackboard
 * entry so the hand-off context survives into later rounds' digests.
 */
describe('scout briefs persist to the blackboard', () => {
  it('upserts a session-scoped blackboard entry per brief and replaces on re-brief', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Investigate.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runId = harness.dispatched[0].appRunId!

    harness.orchestrator.recordScoutBrief(runId, {
      participantId: 'claude',
      participantRole: 'Reviewer',
      provider: 'claude',
      findings: 'Module X locks shared state.',
      confidence: 'high',
      recommendations: ['serialize access'],
      emittedAt: '2026-05-24T00:00:01.000Z'
    })
    const blackboard = harness.chat.ensemble?.blackboard || []
    expect(blackboard).toHaveLength(1)
    expect(blackboard[0]).toMatchObject({
      participantId: 'claude',
      key: 'scout-brief:Reviewer',
      scope: 'session',
      derivedFrom: 'scout_brief'
    })
    expect(blackboard[0].value).toContain('Module X locks shared state.')
    expect(blackboard[0].value).toContain('Recommends: serialize access')

    // Same participant briefs again → replaces, not stacks.
    harness.orchestrator.recordScoutBrief(runId, {
      participantId: 'claude',
      participantRole: 'Reviewer',
      provider: 'claude',
      findings: 'Updated: lock removed in module X.',
      confidence: 'high',
      emittedAt: '2026-05-24T00:00:02.000Z'
    })
    const after = harness.chat.ensemble?.blackboard || []
    expect(after).toHaveLength(1)
    expect(after[0].value).toContain('Updated: lock removed')
  })
})

/*
 * Spike 5 — slim resumed-turn prompts (TASKWRAITH_ENSEMBLE_SLIM_RESUME).
 * A resumable seat whose persisted shell stamp matches the current config
 * gets only the dynamic turn context; first turns / stamp mismatches /
 * non-resumable providers keep the full shell.
 */
describe('slim resumed-turn prompts', () => {
  it('sends the slim prompt only for stamped resumable seats, and stamps seats on flush', async () => {
    const previous = process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME
    process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME = '1'
    try {
      const chat = makeChat()
      const stamp = computeEnsemblePromptShellStamp(chat.ensemble!)
      const dynamicStateVersion = buildEnsembleDynamicStateSnapshot(chat, chat.ensemble!).version
      chat.ensemble!.participants = chat.ensemble!.participants.map((participant) =>
        participant.id === 'claude'
          ? {
              ...participant,
              linkedProviderSessionId: 'claude-session-1',
              promptShellVersion: stamp
            }
          : participant
      )
      const harness = makeHarness({ initialChat: chat })
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Round two, continue.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
      // Claude (stamped + resumable) gets the slim shell.
      expect(harness.dispatched[0].provider).toBe('claude')
      expect(harness.dispatched[0].ensembleRun?.promptMode).toBe('slim')
      expect(harness.dispatched[0].prompt).toContain('TaskWraith Ensemble Mode — resumed turn')
      expect(harness.dispatched[0].prompt).not.toContain('Participant roster:')
      expect(harness.dispatched[0].prompt).toContain('Current user request:')
      // Complete Claude's run → the next (unstamped) seat gets the FULL shell.
      harness.orchestrator.handleProviderOutput(
        'claude',
        { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
        { type: 'message', role: 'assistant', delta: true, content: 'Continuing.' }
      )
      harness.orchestrator.handleProviderOutput(
        'claude',
        { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success', stats: { total_tokens: 5 } }
      )
      await vi.waitFor(() => {
        const claudeSeat = harness.chat.ensemble?.participants.find(
          (participant) => participant.id === 'claude'
        )
        const claudeRun = harness.chat.runs.find(
          (run) => run.runId === harness.dispatched[0].appRunId
        )
        expect(claudeSeat?.promptDynamicStateVersion).toBe(dynamicStateVersion)
        expect(claudeRun?.promptDynamicStateVersion).toBe(dynamicStateVersion)
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
      expect(harness.dispatched[1].prompt).toContain('Participant roster:')
      // Complete the codex run — flushRun persists the stamp so codex's
      // NEXT dispatch is slim-eligible.
      harness.orchestrator.handleProviderOutput(
        'codex',
        { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
        { type: 'message', role: 'assistant', delta: true, content: 'Done.' }
      )
      harness.orchestrator.handleProviderOutput(
        'codex',
        { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success', stats: { total_tokens: 5 } }
      )
      await vi.waitFor(() => {
        const codexSeat = harness.chat.ensemble?.participants.find(
          (participant) => participant.id === 'codex'
        )
        expect(codexSeat?.promptShellVersion).toBe(stamp)
      })
    } finally {
      if (previous === undefined) delete process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME
      else process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME = previous
    }
  })

  it('falls back to the full shell when the kill switch is set even for stamped seats', async () => {
    const previous = process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME
    process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME = '0'
    const chat = makeChat()
    const stamp = computeEnsemblePromptShellStamp(chat.ensemble!)
    chat.ensemble!.participants = chat.ensemble!.participants.map((participant) =>
      participant.id === 'claude'
        ? {
            ...participant,
            linkedProviderSessionId: 'claude-session-1',
            promptShellVersion: stamp
          }
        : participant
    )
    const harness = makeHarness({ initialChat: chat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Round two, continue.',
      event: { sender: {} as Electron.WebContents }
    })
    try {
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
      expect(harness.dispatched[0].prompt).toContain('Participant roster:')
    } finally {
      if (previous === undefined) delete process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME
      else process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME = previous
    }
  })

  it('pairs a native Kimi slim resume with a signed full-shell recovery prompt', async () => {
    const previous = process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME
    process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME = '1'
    try {
      const chat = makeChat()
      chat.ensemble!.participants = [
        {
          id: 'kimi',
          provider: 'kimi',
          enabled: true,
          role: 'Worker',
          instructions: 'Continue the work.',
          order: 1,
          model: 'kimi-k2.7-code',
          permissionPresetId: 'read_only',
          linkedProviderSessionId: 'session_native-kimi-1',
          kimiAcpNativeSession: true,
          kimiAcpPostureVersion: KIMI_ACP_PRODUCTION_POSTURE_VERSION
        }
      ]
      chat.ensemble!.participants[0].promptShellVersion = computeEnsemblePromptShellStamp(
        chat.ensemble!
      )
      const signRunPermissionPosture = vi.fn(() => 'a'.repeat(64))
      const harness = makeHarness({ initialChat: chat, signRunPermissionPosture })

      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Continue from the native Kimi session.',
        event: { sender: {} as Electron.WebContents }
      })

      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
      const payload = harness.dispatched[0]
      expect(payload.provider).toBe('kimi')
      expect(payload.providerSessionId).toBe('session_native-kimi-1')
      expect(payload.ensembleRun?.promptMode).toBe('slim')
      expect(payload.prompt).toContain('TaskWraith Ensemble Mode — resumed turn')
      expect(payload.prompt).not.toContain('Participant roster:')
      expect(payload.resumeFallbackPrompt).toContain('Participant roster:')
      expect(payload.resumeFallbackPrompt).not.toContain('TaskWraith Ensemble Mode — resumed turn')
      expect(signRunPermissionPosture).toHaveBeenCalledWith(
        'plan',
        expect.objectContaining({ presetId: 'read_only', readOnly: true }),
        expect.objectContaining({
          provider: 'kimi',
          prompt: payload.prompt,
          resumeFallbackPrompt: payload.resumeFallbackPrompt,
          ensembleParticipantId: 'kimi'
        })
      )
    } finally {
      if (previous === undefined) delete process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME
      else process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME = previous
    }
  })

  it.each(['codex-exec-1780439561126', 'not-a-codex-thread'])(
    'keeps a stamped Codex seat on the full prompt for non-app-server session %s',
    async (linkedProviderSessionId) => {
      const previous = process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME
      process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME = '1'
      try {
        const chat = makeChat()
        chat.ensemble!.participants = chat
          .ensemble!.participants.filter((participant) => participant.id === 'codex')
          .map((participant) => ({
            ...participant,
            order: 1,
            linkedProviderSessionId,
            promptShellVersion: computeEnsemblePromptShellStamp({
              ...chat.ensemble!,
              participants: [{ ...participant, order: 1 }]
            })
          }))
        // The stamp must reflect the final one-seat roster.
        chat.ensemble!.participants[0].promptShellVersion = computeEnsemblePromptShellStamp(
          chat.ensemble!
        )
        const harness = makeHarness({ initialChat: chat })
        harness.orchestrator.startRound({
          chatId: 'ensemble-chat',
          prompt: 'Continue.',
          event: { sender: {} as Electron.WebContents }
        })
        await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
        expect(harness.dispatched[0].provider).toBe('codex')
        expect(harness.dispatched[0].ensembleRun?.promptMode).toBe('full')
        expect(harness.dispatched[0].prompt).toContain('Participant roster:')
        expect(harness.dispatched[0].prompt).not.toContain(
          'TaskWraith Ensemble Mode — resumed turn'
        )
      } finally {
        if (previous === undefined) delete process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME
        else process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME = previous
      }
    }
  )

  it('allows a stamped Codex seat with a real app-server UUID to use a slim prompt', async () => {
    const previous = process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME
    process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME = '1'
    try {
      const chat = makeChat()
      chat.ensemble!.participants = chat
        .ensemble!.participants.filter((participant) => participant.id === 'codex')
        .map((participant) => ({
          ...participant,
          order: 1,
          linkedProviderSessionId: '7b057c8b-33fa-4eca-9efe-3313a83669f4'
        }))
      chat.ensemble!.participants[0].promptShellVersion = computeEnsemblePromptShellStamp(
        chat.ensemble!
      )
      const harness = makeHarness({ initialChat: chat })
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Continue.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
      expect(harness.dispatched[0].ensembleRun?.promptMode).toBe('slim')
      expect(harness.dispatched[0].prompt).toContain('TaskWraith Ensemble Mode — resumed turn')
      expect(harness.dispatched[0].prompt).not.toContain('Participant roster:')
      expect(harness.dispatched[0].resumeFallbackPrompt).toContain('Participant roster:')
      expect(harness.dispatched[0].resumeFallbackPrompt).not.toContain(
        'TaskWraith Ensemble Mode — resumed turn'
      )
    } finally {
      if (previous === undefined) delete process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME
      else process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME = previous
    }
  })
})

/*
 * Review F1 regression — a stage-role reviewer must never be swept into the
 * locked-writers write-claim preflight (it used to be dispatched a
 * write-scope claim lane at round start, and its missing claim rejected the
 * whole preflight). With a reviewer on the roster the round degrades to
 * serial writers with an explanatory note; the reviewer still goes last.
 */
describe('locked-writers preflight excludes stage reviewers', () => {
  it('runs the write-scope preflight for the writers and defers the reviewer (reviewer no longer vetoes fan-out)', async () => {
    // A stage reviewer sitting in `remaining` is provably deferred to the end by
    // the reviewer stage-gate, so it must NOT count against `eligibleWriterTail`.
    // Before the fix, this single deferred reviewer wrongly dropped the two
    // writers to serial ("no intervening serial participants" note). Now the
    // write-scope preflight engages: the claim pass fans out to BOTH writers only.
    const previous = process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
    process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = '1'
    try {
      const harness = makeHarness()
      harness.chat.ensemble!.fanoutPolicy = 'locked_writers_user_preflight'
      harness.chat.ensemble!.participants = [
        {
          id: 'codex',
          provider: 'codex',
          enabled: true,
          role: 'Builder A',
          instructions: 'Build.',
          order: 1,
          permissionPresetId: 'workspace_write'
        },
        {
          id: 'claude',
          provider: 'claude',
          enabled: true,
          role: 'Builder B',
          instructions: 'Build.',
          order: 2,
          permissionPresetId: 'workspace_write'
        },
        {
          id: 'kimi',
          provider: 'kimi',
          enabled: true,
          role: 'Auditor',
          instructions: 'Review.',
          order: 3,
          permissionPresetId: 'read_only',
          stageRole: 'reviewer'
        }
      ]
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Build it, then review.',
        event: { sender: {} as Electron.WebContents }
      })
      // The write-scope claim preflight fans out to BOTH writers concurrently.
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
      expect(harness.dispatched.map((payload) => payload.provider).sort()).toEqual([
        'claude',
        'codex'
      ])
      // The reviewer is NOT part of the writer preflight.
      expect(harness.dispatched.every((payload) => payload.provider !== 'kimi')).toBe(true)
      // The preflight engaged; the false "intervening serial participant" veto is gone.
      expect(
        harness.chat.messages.some((message) => message.content?.includes('Write-scope preflight'))
      ).toBe(true)
      expect(
        harness.chat.messages.some((message) =>
          message.content?.includes('no intervening serial participants')
        )
      ).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
      else process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = previous
    }
  })
})

/*
 * Review F2c regression — a failed dispatch must NOT persist the prompt-shell
 * stamp: the provider session never saw the shell, so the next turn must not
 * slim-qualify against it.
 */
describe('shell stamp persistence requires a successful dispatch', () => {
  it('leaves promptShellVersion unset when dispatch fails', async () => {
    const harness = makeHarness({
      dispatch: async (payload) => ({ dispatched: false, appRunId: payload.appRunId || '' })
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Try to run.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).not.toBe('running'))
    for (const participant of harness.chat.ensemble?.participants || []) {
      expect(participant.promptShellVersion).toBeUndefined()
      expect(participant.promptDynamicStateVersion).toBeUndefined()
    }
    expect(harness.chat.runs.some((run) => typeof run.promptDynamicStateVersion === 'string')).toBe(
      false
    )
  })
})

describe('dynamic-state receipt invalidation', () => {
  it('does not persist either prompt receipt when an accepted dispatch later fails', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Try a failing turn.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runId = harness.dispatched[0].appRunId
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: runId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'failed', stats: { total_tokens: 5 } }
    )
    await vi.waitFor(() => {
      const participant = harness.chat.ensemble?.participants.find((entry) => entry.id === 'claude')
      expect(participant?.promptShellVersion).toBeUndefined()
      expect(participant?.promptDynamicStateVersion).toBeUndefined()
    })
  })

  it('does not persist a candidate when a dispatched run ends skipped without an answer', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Try a no-output turn.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runId = harness.dispatched[0].appRunId
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: runId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 5 } }
    )
    await vi.waitFor(() => {
      const run = harness.chat.runs.find((entry) => entry.runId === runId)
      expect(run?.status).toBe('success')
      expect(run?.promptDynamicStateVersion).toBeUndefined()
      expect(
        harness.chat.ensemble?.participants.find((participant) => participant.id === 'claude')
          ?.promptDynamicStateVersion
      ).toBeUndefined()
    })
  })

  it('clears a receipt on completed native compaction and never re-acknowledges it at final flush', async () => {
    const chat = makeChat()
    chat.ensemble!.participants = chat.ensemble!.participants.map((participant) =>
      participant.id === 'claude'
        ? {
            ...participant,
            linkedProviderSessionId: 'claude-session-1',
            promptShellVersion: computeEnsemblePromptShellStamp(chat.ensemble!),
            promptDynamicStateVersion: 'ensemble-dynamic-v1:old-receipt',
            taskWraithMcpProfileReceipt: {
              schemaVersion: 1,
              profileId: 'taskwraith-core-v1',
              provider: 'claude',
              providerSessionId: 'claude-session-1',
              pinnedAt: '2026-07-11T00:00:00.000Z'
            }
          }
        : participant
    )
    const harness = makeHarness({ initialChat: chat })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Continue safely.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runId = harness.dispatched[0].appRunId
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: runId, appChatId: 'ensemble-chat' },
      {
        type: 'compaction_event',
        compaction: { kind: 'completed', telemetry: { provider: 'claude', trigger: 'auto' } }
      }
    )
    expect(
      harness.chat.ensemble?.participants.find((participant) => participant.id === 'claude')
        ?.promptShellVersion
    ).toBeUndefined()
    expect(
      harness.chat.ensemble?.participants.find((participant) => participant.id === 'claude')
        ?.promptDynamicStateVersion
    ).toBeUndefined()
    expect(
      harness.chat.ensemble?.participants.find((participant) => participant.id === 'claude')
        ?.taskWraithMcpProfileReceipt
    ).toMatchObject({
      profileId: 'taskwraith-core-v1',
      providerSessionId: 'claude-session-1'
    })

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: runId, appChatId: 'ensemble-chat' },
      { type: 'message', role: 'assistant', delta: true, content: 'Compacted and continued.' }
    )
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: runId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 5 } }
    )
    await vi.waitFor(() => {
      const run = harness.chat.runs.find((entry) => entry.runId === runId)
      expect(run?.promptDynamicStateVersion).toBeUndefined()
      expect(
        harness.chat.ensemble?.participants.find((participant) => participant.id === 'claude')
          ?.promptShellVersion
      ).toBeUndefined()
      expect(
        harness.chat.ensemble?.participants.find((participant) => participant.id === 'claude')
          ?.promptDynamicStateVersion
      ).toBeUndefined()
      expect(
        harness.chat.ensemble?.participants.find((participant) => participant.id === 'claude')
          ?.taskWraithMcpProfileReceipt
      ).toMatchObject({
        profileId: 'taskwraith-core-v1',
        providerSessionId: 'claude-session-1'
      })
    })
  })
})

describe('classified context-overflow seat relief', () => {
  const overflowText = "This model's maximum context length is 128000 tokens"

  function hostSeatChat(provider: 'kimi' | 'grok', id = provider): ChatRecord {
    const chat = makeChat()
    chat.ensemble!.participants = [
      {
        id,
        provider,
        enabled: true,
        role: 'Worker',
        instructions: 'Work.',
        order: 1,
        model: `${provider}-model`,
        permissionPresetId: 'read_only'
      }
    ]
    return chat
  }

  it('compacts once only after a matching failed serial run settles', async () => {
    const compactSeatContext = vi.fn(async () => ({ ok: true }))
    const harness = makeHarness({
      initialChat: hostSeatChat('grok'),
      compactSeatContext
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Use the Grok worker.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const route = {
      appRunId: harness.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }

    expect(
      harness.orchestrator.noteProviderFailureText(
        'grok',
        { ...route, appChatId: 'wrong' },
        overflowText
      )
    ).toBe(false)
    expect(harness.orchestrator.noteProviderFailureText('kimi', route, overflowText)).toBe(false)
    expect(
      harness.orchestrator.noteProviderFailureText('grok', route, 'Too many tokens for team')
    ).toBe(false)
    expect(harness.orchestrator.noteProviderFailureText('grok', route, overflowText)).toBe(true)
    expect(harness.orchestrator.noteProviderFailureText('grok', route, overflowText)).toBe(true)
    expect(compactSeatContext).not.toHaveBeenCalled()

    harness.orchestrator.handleProviderOutput('grok', route, {
      type: 'result',
      status: 'failed'
    })

    await vi.waitFor(() => expect(compactSeatContext).toHaveBeenCalledTimes(1))
    expect(compactSeatContext).toHaveBeenCalledWith({
      chatId: 'ensemble-chat',
      participantId: 'grok',
      provider: 'grok',
      trigger: 'auto'
    })
    expect(harness.orchestrator.noteProviderFailureText('grok', route, overflowText)).toBe(false)
  })

  it('does not promote classified text from successful or cancelled runs', async () => {
    const successCompact = vi.fn(async () => ({ ok: true }))
    const success = makeHarness({
      initialChat: hostSeatChat('kimi'),
      compactSeatContext: successCompact
    })
    success.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Try the shorter request.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(success.dispatched).toHaveLength(1))
    const successRoute = {
      appRunId: success.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }
    expect(success.orchestrator.noteProviderFailureText('kimi', successRoute, overflowText)).toBe(
      true
    )
    success.orchestrator.handleProviderOutput('kimi', successRoute, {
      type: 'result',
      status: 'success'
    })
    await vi.waitFor(() => expect(success.chat.ensemble?.activeRound?.status).toBe('completed'))
    expect(successCompact).not.toHaveBeenCalled()

    const cancelledCompact = vi.fn(async () => ({ ok: true }))
    const cancelled = makeHarness({
      initialChat: hostSeatChat('grok'),
      compactSeatContext: cancelledCompact
    })
    cancelled.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Start then cancel.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(cancelled.dispatched).toHaveLength(1))
    const cancelledRoute = {
      appRunId: cancelled.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }
    expect(
      cancelled.orchestrator.noteProviderFailureText('grok', cancelledRoute, overflowText)
    ).toBe(true)
    await cancelled.orchestrator.cancelRound('ensemble-chat')
    expect(cancelledCompact).not.toHaveBeenCalled()
  })

  it('keeps evidence behind an in-flight barrier and drops it after a seat relink', async () => {
    let compactionBarrierActive = false
    const compactSeatContext = vi.fn(async () => ({ ok: true }))
    const harness = makeHarness({
      initialChat: hostSeatChat('grok'),
      compactSeatContext,
      awaitPendingSeatCompaction: () =>
        compactionBarrierActive ? Promise.resolve({ ok: true }) : undefined
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Overflow the original seat.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const route = {
      appRunId: harness.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }
    expect(harness.orchestrator.noteProviderFailureText('grok', route, overflowText)).toBe(true)
    compactionBarrierActive = true
    harness.orchestrator.handleProviderOutput('grok', route, {
      type: 'result',
      status: 'failed'
    })
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    expect(compactSeatContext).not.toHaveBeenCalled()

    const seat = harness.chat.ensemble!.participants[0]
    seat.model = 'grok-relinked-model'
    seat.linkedProviderSessionId = 'grok-relinked-session'
    compactionBarrierActive = false
    ;(
      harness.orchestrator as unknown as {
        maybeAutoCompactSeatAfterTurn: (chatId: string, participantId: string) => void
      }
    ).maybeAutoCompactSeatAfterTurn('ensemble-chat', seat.id)

    expect(compactSeatContext).not.toHaveBeenCalled()
    const pending = (
      harness.orchestrator as unknown as {
        pendingSeatOverflowEvidence: Map<string, unknown>
      }
    ).pendingSeatOverflowEvidence
    expect(pending.size).toBe(0)
  })

  it('honors the host auto-compaction kill switch for classified overflow', async () => {
    let hostAutoCompactEnabled = false
    const compactSeatContext = vi.fn(async () => ({ ok: true }))
    const harness = makeHarness({
      initialChat: hostSeatChat('grok'),
      compactSeatContext,
      getSettings: () => ({ ...makeSettings(), hostAutoCompactEnabled })
    })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Keep automatic recovery disabled.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const route = {
      appRunId: harness.dispatched[0].appRunId,
      appChatId: 'ensemble-chat'
    }
    expect(harness.orchestrator.noteProviderFailureText('grok', route, overflowText)).toBe(true)
    harness.orchestrator.handleProviderOutput('grok', route, {
      type: 'result',
      status: 'failed'
    })
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    expect(compactSeatContext).not.toHaveBeenCalled()

    hostAutoCompactEnabled = true
    ;(
      harness.orchestrator as unknown as {
        maybeAutoCompactSeatAfterTurn: (chatId: string, participantId: string) => void
      }
    ).maybeAutoCompactSeatAfterTurn('ensemble-chat', 'grok')
    await vi.waitFor(() => expect(compactSeatContext).toHaveBeenCalledTimes(1))
  })

  it('retains new classified evidence until the per-seat cooldown expires', async () => {
    let clock = 1_000
    const compactSeatContext = vi.fn(async () => ({ ok: true }))
    const harness = makeHarness({
      initialChat: hostSeatChat('grok'),
      compactSeatContext,
      now: () => clock
    })
    const failRoundWithOverflow = async (prompt: string): Promise<void> => {
      const expectedDispatchCount = harness.dispatched.length + 1
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt,
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(expectedDispatchCount))
      const payload = harness.dispatched.at(-1)!
      const route = { appRunId: payload.appRunId, appChatId: 'ensemble-chat' }
      expect(harness.orchestrator.noteProviderFailureText('grok', route, overflowText)).toBe(true)
      harness.orchestrator.handleProviderOutput('grok', route, {
        type: 'result',
        status: 'failed'
      })
      await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    }

    await failRoundWithOverflow('First overflow.')
    await vi.waitFor(() => expect(compactSeatContext).toHaveBeenCalledTimes(1))

    clock += CONTEXT_AUTO_COMPACT_COOLDOWN_MS - 1
    await failRoundWithOverflow('Second overflow inside cooldown.')
    expect(compactSeatContext).toHaveBeenCalledTimes(1)

    clock += 1
    ;(
      harness.orchestrator as unknown as {
        maybeAutoCompactSeatAfterTurn: (chatId: string, participantId: string) => void
      }
    ).maybeAutoCompactSeatAfterTurn('ensemble-chat', 'grok')
    await vi.waitFor(() => expect(compactSeatContext).toHaveBeenCalledTimes(2))
  })

  it('waits for every fan-out lane before starting overflow maintenance', async () => {
    const chat = makeChat()
    chat.ensemble!.participants = [
      {
        id: 'lead',
        provider: 'codex',
        enabled: true,
        role: 'Lead',
        instructions: 'Lead.',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'kimi-lane',
        provider: 'kimi',
        enabled: true,
        role: 'Kimi lane',
        instructions: 'Inspect.',
        order: 2,
        model: 'kimi-model',
        permissionPresetId: 'read_only'
      },
      {
        id: 'grok-lane',
        provider: 'grok',
        enabled: true,
        role: 'Grok lane',
        instructions: 'Inspect.',
        order: 3,
        model: 'grok-model',
        permissionPresetId: 'read_only'
      }
    ]
    const compactSeatContext = vi.fn(async () => ({ ok: true }))
    const harness = makeHarness({ initialChat: chat, compactSeatContext })
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Lead then fan out.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const runtime = (
      harness.orchestrator as unknown as {
        roundsByChatId: Map<string, { fanoutPolicy: EnsembleConfig['fanoutPolicy'] }>
      }
    ).roundsByChatId.get('ensemble-chat')
    expect(runtime).toBeTruthy()
    runtime!.fanoutPolicy = 'read_only'
    const receipt = await harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
      targets: ['kimi-lane', 'grok-lane'],
      prompt: 'Inspect in parallel.'
    })
    expect(receipt.ok).toBe(true)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    const kimiPayload = harness.dispatched[1]
    const grokPayload = harness.dispatched[2]
    const kimiRoute = {
      appRunId: kimiPayload.appRunId,
      appChatId: 'ensemble-chat'
    }
    expect(harness.orchestrator.noteProviderFailureText('kimi', kimiRoute, overflowText)).toBe(true)
    harness.orchestrator.handleProviderOutput('kimi', kimiRoute, {
      type: 'result',
      status: 'failed'
    })
    expect(compactSeatContext).not.toHaveBeenCalled()

    harness.orchestrator.handleProviderOutput(
      'grok',
      { appRunId: grokPayload.appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(compactSeatContext).toHaveBeenCalledTimes(1))
    expect(compactSeatContext).toHaveBeenCalledWith({
      chatId: 'ensemble-chat',
      participantId: 'kimi-lane',
      provider: 'kimi',
      trigger: 'auto'
    })
  })
})

describe('post-round host seat auto-compaction (maybeAutoCompactSeatsAfterRound)', () => {
  // These sealed stats produce a deterministic processed-usage percentage.
  // That value remains diagnostic only and must not authorize a session reset.
  function seatRun(
    participantId: string,
    provider: EnsembleParticipant['provider'],
    tokens: number,
    limit: number,
    startedAt = '2026-05-24T00:00:01.000Z'
  ): ChatRun {
    return {
      runId: `${participantId}-run`,
      provider,
      ensembleParticipantId: participantId,
      startedAt,
      endedAt: startedAt,
      status: 'success',
      stats: { input_tokens: tokens, output_tokens: 0, totalTokenLimit: limit }
    }
  }

  function participant(
    over: Partial<EnsembleParticipant> & Pick<EnsembleParticipant, 'id' | 'provider'>
  ): EnsembleParticipant {
    return {
      enabled: true,
      role: 'Seat',
      instructions: '',
      order: 1,
      model: `${over.provider}-model`,
      ...over
    }
  }

  function transcriptRows(count: number): ChatMessage[] {
    return Array.from({ length: count }, (_, index) => ({
      id: `message-${index + 1}`,
      role: 'user' as const,
      content: `Transcript row ${index + 1}`,
      timestamp: `2026-05-24T00:00:${String(index).padStart(2, '0')}.000Z`
    }))
  }

  function harness(opts: {
    participants: EnsembleParticipant[]
    runs: ChatRun[]
    hostAutoCompactEnabled?: boolean
    startClock?: number
    onCompactSeatContext?: (input: {
      chatId: string
      participantId: string
      provider: 'cursor' | 'kimi' | 'grok'
      trigger: 'auto'
    }) => Promise<void> | void
  }) {
    let clock = opts.startClock ?? 1_000
    const progressEvents: ContextCompactionProgressEvent[] = []
    const compactSeatContext = vi.fn(
      async (_input: {
        chatId: string
        participantId: string
        provider: 'cursor' | 'kimi' | 'grok'
        trigger: 'auto'
      }): Promise<{ ok: boolean; error?: string }> => {
        await opts.onCompactSeatContext?.(_input)
        return { ok: true }
      }
    )
    const chat: ChatRecord = {
      ...makeChat(),
      runs: opts.runs,
      ensemble: { ...ensemble, participants: opts.participants }
    }
    const settings: AppSettings = {
      ...makeSettings(),
      hostAutoCompactEnabled: opts.hostAutoCompactEnabled
    }
    const orchestrator = new EnsembleOrchestrator({
      getChat: () => chat,
      saveChat: () => undefined,
      getSettings: () => settings,
      dispatch: vi.fn(async (payload: AgentRunPayload) => ({
        dispatched: true,
        appRunId: payload.appRunId || ''
      })),
      cancelRun: vi.fn(async () => true),
      createRunId: (provider) => `${provider}-run`,
      now: () => clock,
      nowIso: () => '2026-05-24T00:00:01.000Z',
      compactSeatContext,
      onContextCompactionProgress: (event) => progressEvents.push(event)
    })
    const fire = (status: 'completed' | 'cancelled' | 'failed' = 'completed'): void => {
      ;(
        orchestrator as unknown as {
          maybeAutoCompactSeatsAfterRound: (chatId: string, status: string) => void
        }
      ).maybeAutoCompactSeatsAfterRound('ensemble-chat', status)
      vi.advanceTimersByTime(250)
    }
    const beforeDispatch = (participant: EnsembleParticipant): Promise<void> =>
      (
        orchestrator as unknown as {
          awaitSeatCompactionBeforeDispatch: (
            chatId: string,
            participant: EnsembleParticipant
          ) => Promise<void>
        }
      ).awaitSeatCompactionBeforeDispatch('ensemble-chat', participant)
    const afterTurn = (participantId: string): void => {
      ;(
        orchestrator as unknown as {
          maybeAutoCompactSeatAfterTurn: (chatId: string, participantId: string) => void
        }
      ).maybeAutoCompactSeatAfterTurn('ensemble-chat', participantId)
    }
    return {
      chat,
      compactSeatContext,
      progressEvents,
      fire,
      setClock: (v: number) => (clock = v),
      beforeDispatch,
      afterTurn
    }
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does not treat cache-inclusive cursor run usage as live occupancy', () => {
    const seat = participant({
      id: 'cursor',
      provider: 'cursor',
      linkedProviderSessionId: 'sess-1'
    })
    const h = harness({
      participants: [seat],
      runs: [seatRun('cursor', 'cursor', 195_000, 200_000)] // 97.5%
    })
    h.fire('completed')
    expect(h.compactSeatContext).not.toHaveBeenCalled()
  })

  it('auto-compacts Kimi when exact eligible rows fall outside its prompt projection', async () => {
    const h = harness({
      participants: [participant({ id: 'kimi', provider: 'kimi' })],
      runs: []
    })
    h.chat.messages = transcriptRows(18)

    await h.beforeDispatch(h.chat.ensemble!.participants[0])

    expect(h.compactSeatContext).toHaveBeenCalledTimes(1)
    expect(h.compactSeatContext).toHaveBeenCalledWith({
      chatId: 'ensemble-chat',
      participantId: 'kimi',
      provider: 'kimi',
      trigger: 'auto'
    })
  })

  it('does not count the dispatch-live round request rendered separately', async () => {
    const h = harness({
      participants: [participant({ id: 'kimi', provider: 'kimi' })],
      runs: []
    })
    h.chat.ensemble!.activeRound = {
      roundId: 'live-round',
      status: 'running',
      prompt: 'Current request.',
      startedAt: '2026-05-24T00:00:00.000Z',
      activeParticipantId: 'kimi',
      participants: [
        {
          participantId: 'kimi',
          provider: 'kimi',
          role: 'Seat',
          order: 1,
          status: 'running'
        }
      ]
    }
    h.chat.messages = [
      ...transcriptRows(16),
      {
        id: 'live-round-prompt',
        role: 'user',
        content: 'Current request.',
        timestamp: '2026-05-24T00:01:00.000Z',
        metadata: { kind: 'ensembleRoundPrompt', ensembleRoundId: 'live-round' }
      }
    ]

    await h.beforeDispatch(h.chat.ensemble!.participants[0])

    expect(h.compactSeatContext).not.toHaveBeenCalled()
  })

  it('does not recompact Kimi when bounded provenance represents every omitted row', async () => {
    const seat = participant({
      id: 'kimi',
      provider: 'kimi',
      contextCompactionSummary: {
        text: 'Durable summary of the oldest rows.',
        createdAt: '2026-05-24T00:01:00.000Z',
        provider: 'kimi',
        provenance: {
          kind: 'bounded_prompt_window',
          suppliedMessageIds: ['message-1', 'message-2']
        }
      }
    })
    const h = harness({ participants: [seat], runs: [] })
    h.chat.messages = transcriptRows(18)

    await h.beforeDispatch(h.chat.ensemble!.participants[0])

    expect(h.compactSeatContext).not.toHaveBeenCalled()
  })

  it('keeps exact prompt-projection evidence Kimi-only', async () => {
    for (const provider of ['cursor', 'grok'] as const) {
      const seat = participant({
        id: provider,
        provider,
        ...(provider === 'cursor' ? { linkedProviderSessionId: 'cursor-session' } : {})
      })
      const h = harness({ participants: [seat], runs: [] })
      h.chat.messages = transcriptRows(18)

      await h.beforeDispatch(h.chat.ensemble!.participants[0])

      expect(h.compactSeatContext).not.toHaveBeenCalled()
    }
  })

  it('applies the cooldown to repeated Kimi projection evidence', async () => {
    const h = harness({
      participants: [participant({ id: 'kimi', provider: 'kimi' })],
      runs: [],
      startClock: 10_000
    })
    h.chat.messages = transcriptRows(18)

    await h.beforeDispatch(h.chat.ensemble!.participants[0])
    expect(h.compactSeatContext).toHaveBeenCalledTimes(1)

    h.setClock(10_000 + CONTEXT_AUTO_COMPACT_COOLDOWN_MS - 1)
    await h.beforeDispatch(h.chat.ensemble!.participants[0])
    expect(h.compactSeatContext).toHaveBeenCalledTimes(1)

    h.setClock(10_000 + CONTEXT_AUTO_COMPACT_COOLDOWN_MS)
    await h.beforeDispatch(h.chat.ensemble!.participants[0])
    expect(h.compactSeatContext).toHaveBeenCalledTimes(2)
  })

  it('treats a completed round prompt as ordinary post-round projection context', () => {
    const h = harness({
      participants: [participant({ id: 'kimi', provider: 'kimi' })],
      runs: []
    })
    h.chat.ensemble!.activeRound = {
      roundId: 'completed-round',
      status: 'completed',
      prompt: 'Completed request.',
      startedAt: '2026-05-24T00:00:00.000Z',
      endedAt: '2026-05-24T00:01:00.000Z',
      participants: []
    }
    h.chat.messages = [
      {
        id: 'completed-round-prompt',
        role: 'user',
        content: 'Completed request.',
        timestamp: '2026-05-24T00:00:00.000Z',
        metadata: { kind: 'ensembleRoundPrompt', ensembleRoundId: 'completed-round' }
      },
      ...transcriptRows(16)
    ]

    h.fire('completed')

    expect(h.compactSeatContext).toHaveBeenCalledWith({
      chatId: 'ensemble-chat',
      participantId: 'kimi',
      provider: 'kimi',
      trigger: 'auto'
    })
  })

  it('does not rank generic usage as automatic compaction evidence', () => {
    const h = harness({
      participants: [
        participant({ id: 'cursor', provider: 'cursor', linkedProviderSessionId: 's-c' }),
        participant({ id: 'kimi', provider: 'kimi' })
      ],
      runs: [
        seatRun('cursor', 'cursor', 182_000, 200_000), // 91%
        seatRun('kimi', 'kimi', 250_000, 256_000) // ~97.6%
      ]
    })
    h.fire('completed')
    expect(h.compactSeatContext).not.toHaveBeenCalled()
  })

  it('does nothing for a non-completed round', () => {
    const h = harness({
      participants: [
        participant({ id: 'cursor', provider: 'cursor', linkedProviderSessionId: 's' })
      ],
      runs: [seatRun('cursor', 'cursor', 195_000, 200_000)]
    })
    h.fire('cancelled')
    h.fire('failed')
    expect(h.compactSeatContext).not.toHaveBeenCalled()
  })

  it('does nothing when every seat is below the threshold', () => {
    const h = harness({
      participants: [
        participant({ id: 'cursor', provider: 'cursor', linkedProviderSessionId: 's' })
      ],
      runs: [seatRun('cursor', 'cursor', 120_000, 200_000)] // 60%
    })
    h.fire('completed')
    expect(h.compactSeatContext).not.toHaveBeenCalled()
  })

  it('respects the hostAutoCompactEnabled=false kill switch', () => {
    const h = harness({
      participants: [
        participant({ id: 'cursor', provider: 'cursor', linkedProviderSessionId: 's' })
      ],
      runs: [seatRun('cursor', 'cursor', 195_000, 200_000)],
      hostAutoCompactEnabled: false
    })
    h.fire('completed')
    expect(h.compactSeatContext).not.toHaveBeenCalled()
  })

  it('does not become eligible after a cooldown when evidence is still generic usage', () => {
    const h = harness({
      participants: [
        participant({ id: 'cursor', provider: 'cursor', linkedProviderSessionId: 's' })
      ],
      runs: [seatRun('cursor', 'cursor', 195_000, 200_000)],
      startClock: 1_000
    })
    h.fire('completed')
    expect(h.compactSeatContext).not.toHaveBeenCalled()
    h.setClock(1_000 + CONTEXT_AUTO_COMPACT_COOLDOWN_MS - 1)
    h.fire('completed')
    expect(h.compactSeatContext).not.toHaveBeenCalled()
    h.setClock(1_000 + CONTEXT_AUTO_COMPACT_COOLDOWN_MS + 1)
    h.fire('completed')
    expect(h.compactSeatContext).not.toHaveBeenCalled()
  })

  it('keeps Cursor, Kimi, and Grok manual-only when only generic usage exists', () => {
    const cursorOnly = harness({
      participants: [participant({ id: 'cursor', provider: 'cursor' })], // no session
      runs: [seatRun('cursor', 'cursor', 195_000, 200_000)]
    })
    cursorOnly.fire('completed')
    expect(cursorOnly.compactSeatContext).not.toHaveBeenCalled()

    const kimiOnly = harness({
      participants: [participant({ id: 'kimi', provider: 'kimi' })], // material is in-prompt
      runs: [seatRun('kimi', 'kimi', 250_000, 256_000)]
    })
    kimiOnly.fire('completed')
    expect(kimiOnly.compactSeatContext).not.toHaveBeenCalled()

    const grokOnly = harness({
      participants: [participant({ id: 'grok', provider: 'grok' })], // material is in-prompt
      runs: [seatRun('grok', 'grok', 250_000, 256_000)]
    })
    grokOnly.fire('completed')
    expect(grokOnly.compactSeatContext).not.toHaveBeenCalled()
  })

  it('does not reset Grok from a terminal usage estimate', () => {
    const h = harness({
      participants: [participant({ id: 'grok', provider: 'grok', linkedProviderSessionId: 's' })],
      runs: [seatRun('grok', 'grok', 250_000, 256_000)] // ~97.6%
    })
    h.fire('completed')
    expect(h.compactSeatContext).not.toHaveBeenCalled()
  })

  it('does not compact from generic usage before dispatch', async () => {
    const h = harness({
      participants: [participant({ id: 'grok', provider: 'grok' })],
      runs: [seatRun('grok', 'grok', 250_000, 256_000)]
    })
    await h.beforeDispatch(h.chat.ensemble!.participants[0])
    expect(h.compactSeatContext).not.toHaveBeenCalled()
    expect(h.progressEvents).toEqual([])
  })

  it('does not compact from generic usage after a turn', () => {
    const h = harness({
      participants: [
        participant({ id: 'grok', provider: 'grok' }),
        participant({ id: 'codex', provider: 'codex' })
      ],
      runs: [seatRun('grok', 'grok', 250_000, 256_000)]
    })

    h.afterTurn('grok')

    expect(h.compactSeatContext).not.toHaveBeenCalled()
  })

  it('remains manual-only across repeated pre-dispatch checks', async () => {
    const h = harness({
      participants: [participant({ id: 'kimi', provider: 'kimi' })],
      runs: [seatRun('kimi', 'kimi', 250_000, 256_000)],
      startClock: 10_000
    })
    await h.beforeDispatch(h.chat.ensemble!.participants[0])
    expect(h.compactSeatContext).not.toHaveBeenCalled()

    h.setClock(10_000 + CONTEXT_AUTO_COMPACT_COOLDOWN_MS - 1)
    await h.beforeDispatch(h.chat.ensemble!.participants[0])
    expect(h.compactSeatContext).not.toHaveBeenCalled()
  })
})

describe('I-drop regression — leading assistant content delta preservation', () => {
  // GH2 `sidequest-i-drop-fix-plan`: three REAL captured content-delta streams
  // (Codex / Kimi / Grok) where a mid-stream delta ("I" / "I" / "Review") vanished
  // from the persisted transcript ("IpcValidation"→"pcValidation",
  // "useScopedIpc.ts"→"useScopedpc.ts", "\n\nReviewed"→"\n\ned"). The raw wire
  // captured at sendAgentCompatLine was complete in every case, so the drop is
  // DOWNSTREAM of extraction. This replays each stream through the orchestrator's
  // SYNCHRONOUS apply path (handleProviderOutput → appendProviderContent →
  // flushRun) to localise the drop there — or, if the joined text survives every
  // delta, to EXONERATE that path and redirect the investigation to the
  // async/persistence lane. Provider label is irrelevant: the content branch is
  // provider-agnostic, so all three replay as the first (default) participant.
  const CASES: Array<{ name: string; deltas: string[]; mustContain: string; brokenIf: string }> = [
    {
      name: 'Codex — dropped leading "I" in `IpcValidation`',
      deltas: [
        'The',
        ' focused',
        ' tests',
        ' pass',
        ',',
        ' and',
        ' `',
        'I',
        'pc',
        'Validation',
        '` passes.'
      ],
      mustContain: '`IpcValidation`',
      brokenIf: '`pcValidation'
    },
    {
      name: 'Kimi — dropped leading "I" in useScopedIpc.ts',
      deltas: ['/src', '/h', 'ooks', '/use', 'Scoped', 'I', 'pc', '.ts'],
      mustContain: 'useScopedIpc.ts',
      brokenIf: 'useScopedpc.ts'
    },
    {
      name: 'Grok — dropped leading word "Review" in Reviewed',
      deltas: [')**\n\n', 'Review', 'ed', ' the frozen diff:'],
      mustContain: '\n\nReviewed',
      brokenIf: '\n\ned'
    }
  ]

  for (const testCase of CASES) {
    it(`preserves every content delta — ${testCase.name}`, async () => {
      const harness = makeHarness()
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'go',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
      const runId = harness.dispatched[0].appRunId!
      const route = { appRunId: runId, appChatId: 'ensemble-chat' }
      const provider = harness.chat.ensemble!.participants[0].provider

      for (const delta of testCase.deltas) {
        harness.orchestrator.handleProviderOutput(provider, route, {
          type: 'content',
          text: delta
        })
      }

      const findMessage = () =>
        harness.chat.messages.find(
          (m) => m.role === 'assistant' && m.metadata?.kind === 'ensembleParticipant'
        )
      await vi.waitFor(() => expect(findMessage()?.content).toBeTruthy())

      const content = findMessage()?.content ?? ''
      // The whole point: no content delta may be dropped from the transcript.
      expect(content).toContain(testCase.mustContain)
      expect(content).not.toContain(testCase.brokenIf)
      expect(content).toBe(testCase.deltas.join(''))
    })
  }
})

describe('ensemble_fanout_all (authority full-roster fan-out)', () => {
  const rosterParticipants = (): EnsembleParticipant[] => [
    {
      id: 'codex',
      provider: 'codex' as const,
      enabled: true,
      role: 'LeadBoss',
      instructions: 'Coordinate.',
      order: 1,
      permissionPresetId: 'workspace_write'
    },
    {
      id: 'claude',
      provider: 'claude' as const,
      enabled: true,
      role: 'Reviewer',
      instructions: 'Review.',
      order: 2,
      permissionPresetId: 'read_only'
    },
    {
      id: 'kimi',
      provider: 'kimi' as const,
      enabled: true,
      role: 'Builder',
      instructions: 'Build.',
      order: 3,
      permissionPresetId: 'workspace_write'
    }
  ]

  it('rejects a non-authority caller even with explicit targets', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    harness.chat.ensemble!.bossmanParticipantId = 'claude'
    harness.chat.ensemble!.participants = rosterParticipants()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Lead starts.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = await harness.orchestrator.fanoutAllForRun(harness.dispatched[0].appRunId, {
      targets: ['@Builder'],
      prompt: 'Everyone build.'
    })
    expect(result).toMatchObject({ ok: false, error: 'not_authorized' })
    expect(harness.dispatched).toHaveLength(1)
  })

  it('lets Captain fan out the full roster while Boss is available', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.fanoutPolicy = 'off'
    harness.chat.ensemble!.bossmanParticipantId = 'claude'
    harness.chat.ensemble!.secondInCommandParticipantId = 'codex'
    harness.chat.ensemble!.participants = rosterParticipants()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Captain starts while Boss remains healthy.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const captainRunId = harness.dispatched[0].appRunId
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('codex')
    expect(
      harness.orchestrator.listParticipantsForRun(captainRunId).bossmanAuthorityRole
    ).toBeUndefined()

    const fanout = harness.orchestrator.fanoutAllForRun(captainRunId, {
      prompt: 'All hands: take your assigned system.'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(
      harness.dispatched.slice(1).map((payload) => payload.ensembleRun?.participantId)
    ).toEqual(['claude', 'kimi'])
    for (const lane of harness.dispatched.slice(1)) {
      harness.orchestrator.handleProviderOutput(
        lane.provider,
        { appRunId: lane.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
    }
    await expect(fanout).resolves.toMatchObject({
      ok: true,
      participantIds: ['claude', 'kimi']
    })
  })

  it('dispatches every idle seat under its OWN posture, ignoring fan-out policy off', async () => {
    const harness = makeHarness()
    // ensemble_fanout would reject outright with policy off; fanout_all must not.
    harness.chat.ensemble!.fanoutPolicy = 'off'
    harness.chat.ensemble!.bossmanParticipantId = 'codex'
    harness.chat.ensemble!.participants = rosterParticipants()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Lead starts.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const fanout = harness.orchestrator.fanoutAllForRun(harness.dispatched[0].appRunId, {
      prompt: 'All hands: take your assigned system.'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    for (const lane of harness.dispatched.slice(1)) {
      harness.orchestrator.handleProviderOutput(
        lane.provider,
        { appRunId: lane.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
    }
    const result = await fanout
    expect(result.ok).toBe(true)
    expect(result.participantIds).toEqual(expect.arrayContaining(['claude', 'kimi']))
    expect(result.laneIds).toHaveLength(2)

    // Own-posture dispatch: the read_only seat stays clamped to plan while the
    // write-capable seat keeps its writer posture (the old tool's read-only
    // fan-out clamp must NOT apply here).
    const claudeLane = harness.dispatched.find(
      (payload, index) => index > 0 && payload.provider === 'claude'
    )
    const kimiLane = harness.dispatched.find(
      (payload, index) => index > 0 && payload.provider === 'kimi'
    )
    expect(claudeLane?.approvalMode).toBe('plan')
    expect(kimiLane?.approvalMode).not.toBe('plan')
  })

  it('resolves explicit @mention targets without stage or permission filtering', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.fanoutPolicy = 'off'
    harness.chat.ensemble!.bossmanParticipantId = 'codex'
    harness.chat.ensemble!.participants = rosterParticipants()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Lead starts.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const fanout = harness.orchestrator.fanoutAllForRun(harness.dispatched[0].appRunId, {
      targets: ['@Builder'],
      prompt: 'Builder: implement the ballistics system.'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    harness.orchestrator.handleProviderOutput(
      'kimi',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await expect(fanout).resolves.toMatchObject({
      ok: true,
      participantIds: ['kimi']
    })
  })
})

// Efficiency audit 2026-07 — terminal-goal pre-emption + assignment-aware
// continuation rosters. Both reach the private functions directly (the C4
// pattern above) so the exact predicates are exercised without racing the
// async serial loop.
describe('terminal-goal pre-emption of the serial queue', () => {
  const internals = (orchestrator: EnsembleOrchestrator) =>
    orchestrator as unknown as {
      roundsByChatId: Map<
        string,
        {
          remainingParticipants?: EnsembleParticipant[]
          roundStartGoalId?: string
          roundStartGoalWasTerminal?: boolean
          goalTerminalPreemptionNoted?: boolean
          fannedOutParticipantIds?: Set<string>
          orchestrationMode: string
        }
      >
      preemptRemainingForTerminalGoal: (
        runtime: object,
        chat: ChatRecord,
        remaining: EnsembleParticipant[],
        exemptIds: ReadonlySet<string>
      ) => void
    }

  const makePreemptionRound = async (options: { goalAtStart?: ActiveGoal } = {}) => {
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.maxContinuationHops = 50
    if (options.goalAtStart) harness.chat.activeGoal = options.goalAtStart
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Work the goal.',
      event: { sender: {} as Electron.WebContents }
    })
    // claude (order 1) dispatches; codex stays queued in remainingParticipants.
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const io = internals(harness.orchestrator)
    const runtime = io.roundsByChatId.get('ensemble-chat')!
    expect(runtime).toBeTruthy()
    const preempt = io.preemptRemainingForTerminalGoal.bind(harness.orchestrator)
    const roundParticipant = (participantId: string) =>
      harness.chat.ensemble!.activeRound!.participants.find(
        (entry) => entry.participantId === participantId
      )
    const preemptionAnnounced = (): boolean =>
      harness.chat.messages.some((message) => /pre-empted/i.test(message.content || ''))
    return { harness, runtime, preempt, roundParticipant, preemptionAnnounced }
  }

  it('sweeps undispatched seats once the goal completes mid-round (continuous mode)', async () => {
    const { harness, runtime, preempt, roundParticipant, preemptionAnnounced } =
      await makePreemptionRound({ goalAtStart: buildActiveGoal('goal-live') })
    // Goal snapshot: active at round start.
    expect(runtime.roundStartGoalId).toBe('goal-live')
    expect(runtime.roundStartGoalWasTerminal).toBe(false)
    // Boss completes the goal mid-round.
    harness.chat.activeGoal = { ...harness.chat.activeGoal!, status: 'completed' }
    preempt(runtime, harness.chat, runtime.remainingParticipants!, new Set())
    expect(runtime.remainingParticipants).toHaveLength(0)
    expect(roundParticipant('codex')?.status).toBe('skipped')
    expect(preemptionAnnounced()).toBe(true)
    // Fire-once: a second sweep on an already-empty queue adds nothing.
    const messageCount = harness.chat.messages.length
    preempt(runtime, harness.chat, runtime.remainingParticipants!, new Set())
    expect(harness.chat.messages.length).toBe(messageCount)
  })

  it('era guard: a goal already terminal at round start never pre-empts pass 1', async () => {
    const { harness, runtime, preempt, roundParticipant } = await makePreemptionRound({
      goalAtStart: { ...buildActiveGoal('goal-stale'), status: 'completed' }
    })
    expect(runtime.roundStartGoalWasTerminal).toBe(true)
    const before = runtime.remainingParticipants!.length
    preempt(runtime, harness.chat, runtime.remainingParticipants!, new Set())
    expect(runtime.remainingParticipants).toHaveLength(before)
    expect(roundParticipant('codex')?.status).not.toBe('skipped')
  })

  it('a goal minted and completed within the round pre-empts despite a stale start snapshot', async () => {
    const { harness, runtime, preempt } = await makePreemptionRound({
      goalAtStart: { ...buildActiveGoal('goal-old'), status: 'completed' }
    })
    // set_goal minted a fresh goal mid-round, then the Boss completed it.
    harness.chat.activeGoal = { ...buildActiveGoal('goal-new'), status: 'completed' }
    preempt(runtime, harness.chat, runtime.remainingParticipants!, new Set())
    expect(runtime.remainingParticipants).toHaveLength(0)
  })

  it('turn_bound rounds also pre-empt remaining seats and persist skipped status', async () => {
    const harness = makeHarness()
    harness.chat.activeGoal = buildActiveGoal('goal-tb')
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Panel question.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const io = internals(harness.orchestrator)
    const runtime = io.roundsByChatId.get('ensemble-chat')!
    expect(runtime.orchestrationMode).not.toBe('continuous')
    harness.chat.activeGoal = { ...harness.chat.activeGoal!, status: 'completed' }
    io.preemptRemainingForTerminalGoal.call(
      harness.orchestrator,
      runtime,
      harness.chat,
      runtime.remainingParticipants!,
      new Set()
    )
    expect(runtime.remainingParticipants).toHaveLength(0)
    const codexState = harness.chat.ensemble?.activeRound?.participants.find(
      (participant) => participant.participantId === 'codex'
    )
    expect(codexState?.status).toBe('skipped')
    expect(codexState?.reason).toMatch(/Goal completed — remaining turn pre-empted/)
    // Durable chat projection (not runtime-only): goal terminal + skipped seat remain on the chat record.
    expect(harness.chat.activeGoal?.status).toBe('completed')
    expect(harness.saveChat).toHaveBeenCalled()
    const saved = harness.saveChat.mock.calls.at(-1)?.[0] as ChatRecord | undefined
    expect(saved?.activeGoal?.status).toBe('completed')
    expect(
      saved?.ensemble?.activeRound?.participants.find(
        (participant) => participant.participantId === 'codex'
      )?.status
    ).toBe('skipped')
  })

  it('explicitly-routed and fan-out-lane seats survive the sweep', async () => {
    const { harness, runtime, preempt, roundParticipant } = await makePreemptionRound({
      goalAtStart: buildActiveGoal('goal-exempt')
    })
    // Add a third seat so the queue holds two undispatched participants.
    harness.chat.ensemble!.participants.push({
      id: 'kimi',
      provider: 'kimi',
      enabled: true,
      role: 'Scout',
      instructions: 'Scout.',
      order: 3,
      model: 'kimi-model',
      permissionPresetId: 'read_only'
    })
    const kimiSeat = harness.chat.ensemble!.participants.find((entry) => entry.id === 'kimi')!
    runtime.remainingParticipants!.push(kimiSeat as EnsembleParticipant)
    harness.chat.activeGoal = { ...harness.chat.activeGoal!, status: 'completed' }
    // codex was yield-promoted (exempt); kimi is an ordinary queued seat.
    preempt(runtime, harness.chat, runtime.remainingParticipants!, new Set(['codex']))
    expect(runtime.remainingParticipants!.map((entry) => entry.id)).toEqual(['codex'])
    expect(roundParticipant('codex')?.status).not.toBe('skipped')
  })
})

describe('assignment-aware continuation roster narrowing', () => {
  const internals = (orchestrator: EnsembleOrchestrator) =>
    orchestrator as unknown as {
      roundsByChatId: Map<string, object>
      narrowContinuationRosterToOpenWork: (
        chat: ChatRecord,
        fullRoster: EnsembleParticipant[],
        runtime?: object
      ) => EnsembleParticipant[]
      tryAutoContinueRound: (runtime: object, chat: ChatRecord) => EnsembleParticipant[] | null
    }

  const seat = (id: string, order: number): EnsembleParticipant =>
    ({
      id,
      provider: 'claude',
      enabled: true,
      role: id,
      instructions: 'Do.',
      order,
      model: 'claude-model',
      permissionPresetId: 'workspace_write'
    }) as EnsembleParticipant

  const fullRoster = [
    seat('boss', 1),
    seat('captain', 2),
    seat('worker1', 3),
    seat('reviewer1', 4),
    seat('scout1', 5)
  ]

  const makeNarrowingChat = (): ChatRecord => {
    const chat = makeChat()
    chat.activeGoal = buildActiveGoal('goal-n')
    chat.ensemble!.bossmanParticipantId = 'boss'
    chat.ensemble!.secondInCommandParticipantId = 'captain'
    return chat
  }

  const narrow = () => {
    const harness = makeHarness()
    return internals(harness.orchestrator).narrowContinuationRosterToOpenWork.bind(
      harness.orchestrator
    )
  }

  const stamp = { createdAt: '2026-05-24T00:00:00.000Z', updatedAt: '2026-05-24T00:00:00.000Z' }

  it('keeps the full roster when assign_work was never used and no Continuous runtime is supplied', () => {
    const chat = makeNarrowingChat()
    expect(narrow()(chat, fullRoster)).toHaveLength(fullRoster.length)
  })

  it('authority-only Continuous auto-continue admits fan-out targets plus Boss, not prior speakers alone', async () => {
    const harness = makeHarness()
    const roster = [...fullRoster]
    harness.chat.ensemble!.participants = roster
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.bossmanParticipantId = 'boss'
    harness.chat.ensemble!.secondInCommandParticipantId = 'captain'
    harness.chat.activeGoal = buildActiveGoal('goal-directed')
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Keep going without assign_work.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const io = internals(harness.orchestrator)
    const runtime = io.roundsByChatId.get('ensemble-chat') as {
      orchestrationMode: string
      fannedOutParticipantIds?: Set<string>
    }
    runtime.fannedOutParticipantIds = new Set(['worker1'])
    harness.chat.ensemble!.activeRound!.participants =
      harness.chat.ensemble!.activeRound!.participants.map((participant) => ({
        ...participant,
        status:
          participant.participantId === 'boss' ||
          participant.participantId === 'worker1' ||
          participant.participantId === 'scout1'
            ? ('answered' as const)
            : ('idle' as const)
      }))

    const narrowed = io.narrowContinuationRosterToOpenWork.call(
      harness.orchestrator,
      harness.chat,
      roster,
      runtime
    )
    // fan-out admits worker1; answered scout1 alone must NOT admit
    expect(narrowed.map((participant) => participant.id)).toEqual(['boss', 'worker1'])
  })

  it('authority-only Continuous narrowing drops answered-only workers with no fan-out or yield-return', async () => {
    const harness = makeHarness()
    const roster = [...fullRoster]
    harness.chat.ensemble!.participants = roster
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.bossmanParticipantId = 'boss'
    harness.chat.ensemble!.secondInCommandParticipantId = 'captain'
    harness.chat.activeGoal = buildActiveGoal('goal-answered-only')
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Answered workers must not re-admit without authority direction.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const io = internals(harness.orchestrator)
    const runtime = io.roundsByChatId.get('ensemble-chat') as {
      orchestrationMode: string
      fannedOutParticipantIds?: Set<string>
    }
    runtime.fannedOutParticipantIds = undefined
    harness.chat.ensemble!.activeRound!.participants =
      harness.chat.ensemble!.activeRound!.participants.map((participant) => ({
        ...participant,
        status:
          participant.participantId === 'boss' || participant.participantId === 'worker1'
            ? ('answered' as const)
            : ('idle' as const)
      }))

    const narrowed = io.narrowContinuationRosterToOpenWork.call(
      harness.orchestrator,
      harness.chat,
      roster,
      runtime
    )
    expect(narrowed.map((participant) => participant.id)).toEqual(['boss'])
  })

  it('authority-only Continuous Boss-only hop after productive pass with no expansion', async () => {
    const harness = makeHarness()
    const roster = [...fullRoster]
    harness.chat.ensemble!.participants = roster
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.maxContinuationHops = 50
    harness.chat.ensemble!.bossmanParticipantId = 'boss'
    harness.chat.ensemble!.secondInCommandParticipantId = 'captain'
    harness.chat.activeGoal = buildActiveGoal('goal-boss-only')
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Productive pass, no fan-out expansion.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const io = internals(harness.orchestrator)
    const runtime = io.roundsByChatId.get('ensemble-chat')!
    harness.chat.ensemble!.activeRound!.participants =
      harness.chat.ensemble!.activeRound!.participants.map((participant) => ({
        ...participant,
        status: 'answered' as const
      }))

    const fresh = io.tryAutoContinueRound.call(harness.orchestrator, runtime, harness.chat)
    expect(fresh).not.toBeNull()
    expect(fresh!.map((entry) => entry.id)).toEqual(['boss'])
    expect(harness.chat.ensemble?.activeRound?.continuationPass).toBe(2)
    expect(
      harness.chat.messages.some((message) =>
        /Focused continuation pass: 1 of 5 seats/.test(message.content || '')
      )
    ).toBe(true)
  })

  it('authority-directed Continuous narrowing fail-opens to the full roster when the admit set is empty', async () => {
    const harness = makeHarness()
    const roster = [...fullRoster]
    harness.chat.ensemble!.participants = roster
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.bossmanParticipantId = undefined
    harness.chat.ensemble!.secondInCommandParticipantId = undefined
    harness.chat.ensemble!.captainParticipantIds = []
    harness.chat.activeGoal = buildActiveGoal('goal-failopen')
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'No directed seats.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const io = internals(harness.orchestrator)
    const runtime = io.roundsByChatId.get('ensemble-chat')!
    harness.chat.ensemble!.activeRound!.participants =
      harness.chat.ensemble!.activeRound!.participants.map((participant) => ({
        ...participant,
        status: 'idle' as const
      }))
    const narrowed = io.narrowContinuationRosterToOpenWork.call(
      harness.orchestrator,
      harness.chat,
      roster,
      runtime
    )
    expect(narrowed).toHaveLength(fullRoster.length)
  })

  it('admits open-assignment owners plus the Boss; idle scouts/reviewers/captain are dropped', () => {
    const chat = makeNarrowingChat()
    chat.ensemble!.bossmanControlState = {
      assignments: [
        { id: 'a1', participantId: 'worker1', objective: 'slice', status: 'open', ...stamp },
        { id: 'a2', participantId: 'scout1', objective: 'done bit', status: 'done', ...stamp }
      ]
    }
    const narrowed = narrow()(chat, fullRoster)
    expect(narrowed.map((entry) => entry.id)).toEqual(['boss', 'worker1'])
  })

  it('admits reviewers of required gates bound to the active goal', () => {
    const chat = makeNarrowingChat()
    chat.ensemble!.bossmanControlState = {
      assignments: [
        { id: 'a1', participantId: 'worker1', objective: 'slice', status: 'done', ...stamp }
      ],
      reviewGates: [
        {
          id: 'g1',
          reviewerParticipantId: 'reviewer1',
          scope: 'the slice',
          status: 'required',
          goalId: 'goal-n',
          ...stamp
        },
        {
          id: 'g-old',
          reviewerParticipantId: 'scout1',
          scope: 'a prior goal',
          status: 'required',
          goalId: 'goal-prior',
          ...stamp
        }
      ]
    }
    const narrowed = narrow()(chat, fullRoster)
    expect(narrowed.map((entry) => entry.id)).toEqual(['boss', 'reviewer1'])
  })

  it('all work closed → the Boss gets a solo closure pass', () => {
    const chat = makeNarrowingChat()
    chat.ensemble!.bossmanControlState = {
      assignments: [
        { id: 'a1', participantId: 'worker1', objective: 'slice', status: 'done', ...stamp },
        { id: 'a2', participantId: 'scout1', objective: 'recon', status: 'cancelled', ...stamp }
      ]
    }
    expect(narrow()(chat, fullRoster).map((entry) => entry.id)).toEqual(['boss'])
  })

  it("an open poll pins the full roster (voting is everyone's job)", () => {
    const chat = makeNarrowingChat()
    chat.ensemble!.bossmanControlState = {
      assignments: [
        { id: 'a1', participantId: 'worker1', objective: 'slice', status: 'done', ...stamp }
      ],
      polls: [
        {
          id: 'p1',
          question: 'Ship it?',
          options: ['yes', 'no'],
          status: 'open',
          createdAt: '2026-05-24T00:00:00.000Z'
        } as never
      ]
    }
    expect(narrow()(chat, fullRoster)).toHaveLength(fullRoster.length)
  })

  it('the Captain substitutes only when the Boss is outside the eligible roster', () => {
    const chat = makeNarrowingChat()
    chat.ensemble!.bossmanControlState = {
      assignments: [
        { id: 'a1', participantId: 'worker1', objective: 'slice', status: 'in_progress', ...stamp }
      ]
    }
    const rosterWithoutBoss = fullRoster.filter((entry) => entry.id !== 'boss')
    expect(narrow()(chat, rosterWithoutBoss).map((entry) => entry.id)).toEqual([
      'captain',
      'worker1'
    ])
  })

  it('admits only the first available Captain after a live-round Boss failure', async () => {
    const harness = makeHarness()
    const roster = [
      seat('boss', 1),
      seat('captain-one', 2),
      seat('captain-two', 3),
      seat('worker1', 4)
    ]
    harness.chat.ensemble!.participants = roster
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.bossmanParticipantId = 'boss'
    harness.chat.ensemble!.captainParticipantIds = ['captain-one', 'captain-two']
    harness.chat.ensemble!.secondInCommandParticipantId = 'captain-one'
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Work the assigned slice.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const io = internals(harness.orchestrator)
    const runtime = io.roundsByChatId.get('ensemble-chat')!
    harness.chat.ensemble!.activeRound!.participants =
      harness.chat.ensemble!.activeRound!.participants.map((participant) => ({
        ...participant,
        status:
          participant.participantId === 'boss'
            ? 'failed'
            : participant.participantId === 'captain-one'
              ? 'skipped'
              : 'idle'
      }))
    harness.chat.ensemble!.bossmanControlState = {
      assignments: [
        {
          id: 'a1',
          participantId: 'worker1',
          objective: 'slice',
          status: 'open',
          ...stamp
        }
      ]
    }

    const narrowed = io.narrowContinuationRosterToOpenWork.call(
      harness.orchestrator,
      harness.chat,
      roster,
      runtime
    )
    expect(narrowed.map((participant) => participant.id)).toEqual(['captain-two', 'worker1'])
  })

  it('targeted open status requests admit their targets; untargeted ones never pin the roster', () => {
    const chat = makeNarrowingChat()
    chat.ensemble!.bossmanControlState = {
      assignments: [
        { id: 'a1', participantId: 'worker1', objective: 'slice', status: 'open', ...stamp }
      ],
      statusRequests: [
        {
          id: 's1',
          targetParticipantIds: ['scout1'],
          prompt: 'Scout report?',
          status: 'open',
          createdAt: '2026-05-24T00:00:00.000Z'
        },
        {
          id: 's2',
          prompt: 'Everyone check in',
          status: 'open',
          createdAt: '2026-05-24T00:00:00.000Z'
        }
      ]
    }
    const narrowed = narrow()(chat, fullRoster)
    expect(narrowed.map((entry) => entry.id)).toEqual(['boss', 'worker1', 'scout1'])
  })

  it('a narrowing that would admit nobody falls back to the full roster', () => {
    const chat = makeNarrowingChat()
    chat.ensemble!.bossmanParticipantId = undefined
    chat.ensemble!.secondInCommandParticipantId = undefined
    chat.ensemble!.bossmanControlState = {
      assignments: [
        { id: 'a1', participantId: 'worker1', objective: 'slice', status: 'done', ...stamp }
      ]
    }
    expect(narrow()(chat, fullRoster)).toHaveLength(fullRoster.length)
  })

  it('tryAutoContinueRound wires the narrowing into the next pass and says so', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.maxContinuationHops = 50
    harness.chat.ensemble!.bossmanParticipantId = 'codex'
    harness.chat.activeGoal = buildActiveGoal('goal-wire')
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Keep going.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const io = internals(harness.orchestrator)
    const runtime = io.roundsByChatId.get('ensemble-chat')!
    harness.chat.ensemble!.bossmanControlState = {
      assignments: [
        {
          id: 'a1',
          participantId: 'codex',
          objective: 'finish the slice',
          status: 'in_progress',
          createdAt: '2026-05-24T00:00:00.000Z',
          updatedAt: '2026-05-24T00:00:00.000Z'
        }
      ]
    }
    // A productive pass: both seats answered.
    const round = harness.chat.ensemble!.activeRound!
    harness.chat.ensemble!.activeRound = {
      ...round,
      participants: round.participants.map((participant) => ({
        ...participant,
        status: 'answered' as const
      }))
    }
    const fresh = io.tryAutoContinueRound.call(harness.orchestrator, runtime, harness.chat)
    expect(fresh).not.toBeNull()
    // codex is Boss AND assignment owner; claude (no open work) is narrowed out.
    expect(fresh!.map((entry) => entry.id)).toEqual(['codex'])
    expect(harness.chat.ensemble?.activeRound?.continuationPass).toBe(2)
    expect(
      harness.chat.messages.some((message) =>
        /Focused continuation pass: 1 of 2 seats/.test(message.content || '')
      )
    ).toBe(true)
  })
})

describe('fan-out worktree isolation', () => {
  const isolationRoster = (): EnsembleParticipant[] => [
    {
      id: 'codex',
      provider: 'codex' as const,
      enabled: true,
      role: 'LeadBoss',
      instructions: 'Coordinate.',
      order: 1,
      permissionPresetId: 'workspace_write'
    },
    {
      id: 'claude',
      provider: 'claude' as const,
      enabled: true,
      role: 'Reviewer',
      instructions: 'Review.',
      order: 2,
      permissionPresetId: 'read_only'
    },
    {
      id: 'kimi',
      provider: 'kimi' as const,
      enabled: true,
      role: 'Builder',
      instructions: 'Build.',
      order: 3,
      permissionPresetId: 'workspace_write'
    }
  ]

  function allocationFor(laneId: string) {
    return {
      baseWorkspacePath: '/repo',
      effectiveWorkspacePath: `/worktrees/${laneId}`,
      branch: `taskwraith/fanout-${laneId}`
    }
  }

  async function startIsolationRound(harness: ReturnType<typeof makeHarness>) {
    harness.chat.ensemble!.fanoutPolicy = 'off'
    harness.chat.ensemble!.bossmanParticipantId = 'codex'
    harness.chat.ensemble!.participants = isolationRoster()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Lead starts.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
  }

  it('gives WRITE-intent lanes isolated worktrees and leaves read lanes on the shared checkout', async () => {
    const allocate = vi.fn(async (input: { laneId: string }) => allocationFor(input.laneId))
    const settle = vi.fn()
    const harness = makeHarness({
      allocateFanoutLaneWorktree: allocate as never,
      settleFanoutLaneWorktree: settle
    })
    await startIsolationRound(harness)
    harness.chat.ensemble!.fanoutIsolation = 'worktree'

    const fanout = harness.orchestrator.fanoutAllForRun(harness.dispatched[0].appRunId, {
      prompt: 'All hands: take your assigned system.'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    for (const lane of harness.dispatched.slice(1)) {
      const route = { appRunId: lane.appRunId, appChatId: 'ensemble-chat' }
      if (lane.provider === 'kimi') {
        // Content-bearing completion finalizes as 'answered'. The quiet
        // Reviewer lane finalizes as an empty-output skip — a lane's worktree
        // diff, not its chatter, is the deliverable, so both settle
        // 'completed'.
        harness.orchestrator.handleProviderOutput(lane.provider, route, {
          type: 'content',
          text: 'Implemented in my worktree.'
        })
      }
      harness.orchestrator.handleProviderOutput(lane.provider, route, {
        type: 'result',
        status: 'success'
      })
    }
    const result = await fanout
    expect(result.ok).toBe(true)

    // Exactly one allocation: the write-capable Builder seat. The read-only
    // Reviewer must keep the live shared checkout.
    expect(allocate).toHaveBeenCalledTimes(1)
    expect(allocate.mock.calls[0][0]).toMatchObject({
      chatId: 'ensemble-chat',
      participantId: 'kimi',
      provider: 'kimi',
      baseWorkspacePath: '/repo'
    })
    const kimiLane = harness.dispatched.find(
      (payload, index) => index > 0 && payload.provider === 'kimi'
    )
    const claudeLane = harness.dispatched.find(
      (payload, index) => index > 0 && payload.provider === 'claude'
    )
    expect(kimiLane?.runtimeWorktree).toMatchObject({
      requested: true,
      source: 'ensembleLane',
      status: 'selected',
      baseWorkspacePath: '/repo'
    })
    expect(kimiLane?.runtimeWorktree?.effectiveWorkspacePath).toContain('/worktrees/')
    expect(claudeLane?.runtimeWorktree).toBeUndefined()

    // Terminal settlement fires for the isolated lane with a mapped status.
    await vi.waitFor(() =>
      expect(settle).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'ensemble-chat',
          runStatus: 'completed'
        })
      )
    )
  })

  it('clamps an explicit worktree override while the chat pins Shared (default)', async () => {
    // The Isolate setting is user authority: unset/off means the shared
    // checkout is PINNED, and a Boss-side isolation=worktree cannot escape
    // it. Before this rule the per-call parameter silently overrode the
    // user's visible "Shared" toggle, which made the toggle read as a no-op.
    const allocate = vi.fn(async (input: { laneId: string }) => allocationFor(input.laneId))
    const harness = makeHarness({ allocateFanoutLaneWorktree: allocate as never })
    await startIsolationRound(harness)

    const fanout = harness.orchestrator.fanoutAllForRun(harness.dispatched[0].appRunId, {
      prompt: 'All hands.',
      isolation: 'worktree'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    for (const lane of harness.dispatched.slice(1)) {
      harness.orchestrator.handleProviderOutput(
        lane.provider,
        { appRunId: lane.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
    }
    const result = await fanout
    expect(result.ok).toBe(true)
    expect(allocate).not.toHaveBeenCalled()
    for (const payload of harness.dispatched) {
      expect(payload.runtimeWorktree).toBeUndefined()
    }
    // The receipt teaches the caller about the clamp instead of silently
    // ignoring the parameter.
    expect(result.message).toContain('Isolate setting pins')
    expect(result.message).toContain('Any')
  })

  it('any policy honors an explicit worktree override', async () => {
    const allocate = vi.fn(async (input: { laneId: string }) => allocationFor(input.laneId))
    const harness = makeHarness({ allocateFanoutLaneWorktree: allocate as never })
    await startIsolationRound(harness)
    harness.chat.ensemble!.fanoutIsolation = 'any'

    const fanout = harness.orchestrator.fanoutAllForRun(harness.dispatched[0].appRunId, {
      prompt: 'All hands.',
      isolation: 'worktree'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    for (const lane of harness.dispatched.slice(1)) {
      harness.orchestrator.handleProviderOutput(
        lane.provider,
        { appRunId: lane.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
    }
    const result = await fanout
    expect(result.ok).toBe(true)
    expect(result.message).not.toContain('Isolate setting pins')
    expect(allocate).toHaveBeenCalledTimes(1)
  })

  it('any policy defaults to the shared checkout when the caller omits isolation', async () => {
    const allocate = vi.fn(async (input: { laneId: string }) => allocationFor(input.laneId))
    const harness = makeHarness({ allocateFanoutLaneWorktree: allocate as never })
    await startIsolationRound(harness)
    harness.chat.ensemble!.fanoutIsolation = 'any'

    const fanout = harness.orchestrator.fanoutAllForRun(harness.dispatched[0].appRunId, {
      prompt: 'All hands.'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    for (const lane of harness.dispatched.slice(1)) {
      harness.orchestrator.handleProviderOutput(
        lane.provider,
        { appRunId: lane.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
    }
    await fanout
    expect(allocate).not.toHaveBeenCalled()
  })

  it('a pinned Worktrees setting overrides an explicit off request', async () => {
    const allocate = vi.fn(async (input: { laneId: string }) => allocationFor(input.laneId))
    const harness = makeHarness({ allocateFanoutLaneWorktree: allocate as never })
    await startIsolationRound(harness)
    harness.chat.ensemble!.fanoutIsolation = 'worktree'

    const fanout = harness.orchestrator.fanoutAllForRun(harness.dispatched[0].appRunId, {
      prompt: 'All hands.',
      isolation: 'off'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    for (const lane of harness.dispatched.slice(1)) {
      harness.orchestrator.handleProviderOutput(
        lane.provider,
        { appRunId: lane.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
    }
    const result = await fanout
    expect(result.ok).toBe(true)
    expect(result.message).toContain('Isolate setting pins')
    expect(allocate).toHaveBeenCalledTimes(1)
  })

  it('fails write lanes closed when Worktrees is pinned but no allocator is wired', async () => {
    // Silently running a write lane in the shared checkout would defeat the
    // isolation the user pinned — the lane must fail pre-dispatch instead,
    // exactly like a thrown allocation error, while read lanes proceed.
    const harness = makeHarness()
    await startIsolationRound(harness)
    harness.chat.ensemble!.fanoutIsolation = 'worktree'

    const fanout = harness.orchestrator.fanoutAllForRun(harness.dispatched[0].appRunId, {
      prompt: 'All hands.'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('claude')
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    const result = await fanout
    expect(result.ok).toBe(true)
    expect(result.laneIds).toHaveLength(1)
    expect(
      harness.chat.messages.some(
        (message) =>
          typeof message.content === 'string' &&
          message.content.includes('fan-out lane failed before dispatch') &&
          message.content.includes('refusing to run this write lane')
      )
    ).toBe(true)
  })

  it('rejects an unrecognized isolation value', async () => {
    const harness = makeHarness()
    await startIsolationRound(harness)

    const result = await harness.orchestrator.fanoutAllForRun(harness.dispatched[0].appRunId, {
      prompt: 'All hands.',
      isolation: 'container'
    })
    expect(result).toMatchObject({ ok: false, error: 'invalid_isolation' })
    expect(harness.dispatched).toHaveLength(1)
  })

  it('fails ONLY the lane whose allocation failed; sibling lanes still dispatch', async () => {
    const allocate = vi.fn(async () => {
      throw new Error('disk full while adding worktree')
    })
    const harness = makeHarness({ allocateFanoutLaneWorktree: allocate as never })
    await startIsolationRound(harness)
    harness.chat.ensemble!.fanoutIsolation = 'worktree'

    const fanout = harness.orchestrator.fanoutAllForRun(harness.dispatched[0].appRunId, {
      prompt: 'All hands.'
    })
    // Only the read-only Reviewer lane reaches a provider; the Builder lane
    // fails closed before dispatch instead of silently sharing the checkout.
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('claude')
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    const result = await fanout
    expect(result.ok).toBe(true)
    expect(result.laneIds).toHaveLength(1)
    expect(
      harness.chat.messages.some(
        (message) =>
          typeof message.content === 'string' &&
          message.content.includes('fan-out lane failed before dispatch') &&
          message.content.includes('disk full')
      )
    ).toBe(true)
  })

  it('never allocates when isolation is off (default) even with the dep wired', async () => {
    const allocate = vi.fn(async (input: { laneId: string }) => allocationFor(input.laneId))
    const harness = makeHarness({ allocateFanoutLaneWorktree: allocate as never })
    await startIsolationRound(harness)

    const fanout = harness.orchestrator.fanoutAllForRun(harness.dispatched[0].appRunId, {
      prompt: 'All hands.'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    for (const lane of harness.dispatched.slice(1)) {
      harness.orchestrator.handleProviderOutput(
        lane.provider,
        { appRunId: lane.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
    }
    await fanout
    expect(allocate).not.toHaveBeenCalled()
    for (const payload of harness.dispatched) {
      expect(payload.runtimeWorktree).toBeUndefined()
    }
  })
})

describe('agent-programmed graph primitives (ensemble_await / ensemble_lane_result)', () => {
  const graphRoster = (): EnsembleParticipant[] => [
    {
      id: 'codex',
      provider: 'codex' as const,
      enabled: true,
      role: 'LeadBoss',
      instructions: 'Coordinate.',
      order: 1,
      permissionPresetId: 'workspace_write'
    },
    {
      id: 'claude',
      provider: 'claude' as const,
      enabled: true,
      role: 'Reviewer',
      instructions: 'Review.',
      order: 2,
      permissionPresetId: 'read_only'
    },
    {
      id: 'kimi',
      provider: 'kimi' as const,
      enabled: true,
      role: 'Builder',
      instructions: 'Build.',
      order: 3,
      permissionPresetId: 'workspace_write'
    }
  ]

  async function startGraphRound(
    harness: ReturnType<typeof makeHarness>
  ): Promise<{ ownerRunId: string }> {
    harness.chat.ensemble!.fanoutPolicy = 'off'
    harness.chat.ensemble!.bossmanParticipantId = 'codex'
    harness.chat.ensemble!.participants = graphRoster()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Lead starts.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    return { ownerRunId: harness.dispatched[0].appRunId! }
  }

  async function dispatchLanes(
    harness: ReturnType<typeof makeHarness>,
    ownerRunId: string
  ): Promise<string[]> {
    const fanout = harness.orchestrator.fanoutAllForRun(ownerRunId, {
      prompt: 'All hands.'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    const result = await fanout
    expect(result.ok).toBe(true)
    return result.laneIds || []
  }

  function settleLane(
    harness: ReturnType<typeof makeHarness>,
    provider: string,
    text?: string
  ): void {
    const lane = harness.dispatched.find(
      (payload, index) => index > 0 && payload.provider === provider
    )!
    const route = { appRunId: lane.appRunId, appChatId: 'ensemble-chat' }
    if (text) {
      harness.orchestrator.handleProviderOutput(lane.provider, route, {
        type: 'content',
        text
      })
    }
    harness.orchestrator.handleProviderOutput(lane.provider, route, {
      type: 'result',
      status: 'success'
    })
  }

  it('await returns settled immediately once every awaited lane is terminal', async () => {
    const harness = makeHarness()
    const { ownerRunId } = await startGraphRound(harness)
    const laneIds = await dispatchLanes(harness, ownerRunId)
    settleLane(harness, 'claude')
    settleLane(harness, 'kimi', 'Built the ballistics system.')
    await vi.waitFor(() => {
      const lanes = harness.chat.ensemble?.activeRound?.lanes || {}
      expect(Object.values(lanes).every((lane) => lane.endedAt)).toBe(true)
    })

    const result = await harness.orchestrator.awaitLanesForRun(ownerRunId, { laneIds })
    expect(result.ok).toBe(true)
    expect(result.status).toBe('settled')
    expect(result.settledCount).toBe(2)
    expect(result.pendingCount).toBe(0)
    expect(result.lanes?.map((lane) => lane.settled)).toEqual([true, true])
  })

  it('await times out with a partial picture while lanes still run', async () => {
    let clock = 0
    const harness = makeHarness({ now: () => (clock += 3_000) })
    const { ownerRunId } = await startGraphRound(harness)
    const laneIds = await dispatchLanes(harness, ownerRunId)
    settleLane(harness, 'claude')

    const result = await harness.orchestrator.awaitLanesForRun(ownerRunId, {
      laneIds,
      timeoutSeconds: 5
    })
    expect(result.ok).toBe(true)
    expect(result.status).toBe('timeout')
    expect(result.settledCount).toBe(1)
    expect(result.pendingCount).toBe(1)
    expect(result.message).toContain('Re-invoke ensemble_await')

    settleLane(harness, 'kimi')
  })

  it('names skipped and failed lanes with their reasons in the wave-completion status', async () => {
    const harness = makeHarness()
    const { ownerRunId } = await startGraphRound(harness)
    await dispatchLanes(harness, ownerRunId)
    // Reviewer lane completes with an empty transcript (the permission-walled
    // seat shape); Builder lane fails outright.
    settleLane(harness, 'claude')
    const kimiLane = harness.dispatched.find((payload) => payload.provider === 'kimi')!
    harness.orchestrator.handleProviderOutput(
      'kimi',
      { appRunId: kimiLane.appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'failed' }
    )

    await vi.waitFor(() =>
      expect(
        harness.chat.messages.some(
          (message) =>
            typeof message.content === 'string' &&
            message.content.includes(
              '0 lane(s) returned, 1 failed, 1 skipped (Reviewer — Completed without producing output.)'
            )
        )
      ).toBe(true)
    )
    void ownerRunId
  })

  it('carries each settled lane reason through ensemble_await and ensemble_lane_result', async () => {
    const harness = makeHarness()
    const { ownerRunId } = await startGraphRound(harness)
    const laneIds = await dispatchLanes(harness, ownerRunId)
    settleLane(harness, 'claude')
    settleLane(harness, 'kimi', 'Built the ballistics system.')
    await vi.waitFor(() => {
      const lanes = harness.chat.ensemble?.activeRound?.lanes || {}
      expect(Object.values(lanes).every((lane) => lane.endedAt)).toBe(true)
    })

    const awaited = await harness.orchestrator.awaitLanesForRun(ownerRunId, { laneIds })
    expect(awaited.ok).toBe(true)
    const reviewerLane = awaited.lanes?.find((lane) => lane.participantId === 'claude')
    expect(reviewerLane?.reason).toBe('Completed without producing output.')
    const builderLane = awaited.lanes?.find((lane) => lane.participantId === 'kimi')
    expect(builderLane?.reason).toBeUndefined()

    const laneRecord = Object.values(harness.chat.ensemble?.activeRound?.lanes || {}).find(
      (lane) => lane.participantId === 'claude'
    )!
    const read = harness.orchestrator.laneResultForRun(ownerRunId, {
      laneId: laneRecord.laneId
    })
    expect(read.ok).toBe(true)
    expect(read.reason).toBe('Completed without producing output.')
  })

  it('await validates lane ids and reports empty rounds', async () => {
    const harness = makeHarness()
    const { ownerRunId } = await startGraphRound(harness)

    await expect(harness.orchestrator.awaitLanesForRun(ownerRunId, {})).resolves.toMatchObject({
      ok: false,
      error: 'no_lanes'
    })
    await expect(
      harness.orchestrator.awaitLanesForRun(ownerRunId, { laneIds: 'lane-1' })
    ).resolves.toMatchObject({ ok: false, error: 'invalid_lane' })

    await dispatchLanes(harness, ownerRunId)
    await expect(
      harness.orchestrator.awaitLanesForRun(ownerRunId, { laneIds: ['lane-bogus'] })
    ).resolves.toMatchObject({ ok: false, error: 'invalid_lane' })
  })

  it('lane_result returns a settled lane output and tail-truncates to maxChars', async () => {
    const harness = makeHarness()
    const { ownerRunId } = await startGraphRound(harness)
    const laneIds = await dispatchLanes(harness, ownerRunId)
    const longTail = `${'x'.repeat(1_400)}FINAL-ANSWER`
    settleLane(harness, 'kimi', longTail)
    settleLane(harness, 'claude')
    await vi.waitFor(() => {
      const lanes = harness.chat.ensemble?.activeRound?.lanes || {}
      expect(Object.values(lanes).every((lane) => lane.endedAt)).toBe(true)
    })
    const kimiLaneId = laneIds.find((laneId) => laneId.includes('kimi'))!

    const full = harness.orchestrator.laneResultForRun(ownerRunId, { laneId: kimiLaneId })
    expect(full.ok).toBe(true)
    expect(full.settled).toBe(true)
    expect(full.laneStatus).toBe('completed')
    expect(full.participantId).toBe('kimi')
    expect(full.content).toContain('FINAL-ANSWER')
    expect(full.truncated).toBe(false)

    const clamped = harness.orchestrator.laneResultForRun(ownerRunId, {
      laneId: kimiLaneId,
      maxChars: 1_000
    })
    expect(clamped.truncated).toBe(true)
    expect(clamped.content?.length).toBe(1_000)
    // Tail-kept: the final answer survives truncation.
    expect(clamped.content?.endsWith('FINAL-ANSWER')).toBe(true)

    const quiet = harness.orchestrator.laneResultForRun(ownerRunId, {
      laneId: laneIds.find((laneId) => laneId.includes('claude'))!
    })
    expect(quiet.ok).toBe(true)
    expect(quiet.message).toContain('without transcript output')
  })

  it('lane_result rejects unknown and missing lane ids', async () => {
    const harness = makeHarness()
    const { ownerRunId } = await startGraphRound(harness)
    expect(
      harness.orchestrator.laneResultForRun(ownerRunId, { laneId: 'lane-bogus' })
    ).toMatchObject({ ok: false, error: 'invalid_lane' })
    expect(harness.orchestrator.laneResultForRun(ownerRunId, {})).toMatchObject({
      ok: false,
      error: 'missing_lane_id'
    })
    expect(harness.orchestrator.laneResultForRun(undefined, { laneId: 'lane-1' })).toMatchObject({
      ok: false,
      error: 'no_active_run'
    })
  })
})

describe('ensemble_await timeout clamp (owner request 2026-08-05)', () => {
  it('defaults to 3 minutes and allows up to 10 per call', () => {
    expect(clampAwaitTimeoutSeconds(undefined)).toBe(180)
    expect(clampAwaitTimeoutSeconds(Number.NaN)).toBe(180)
    expect(clampAwaitTimeoutSeconds(600)).toBe(600)
    expect(clampAwaitTimeoutSeconds(6000)).toBe(600)
    expect(clampAwaitTimeoutSeconds(1)).toBe(5)
    expect(clampAwaitTimeoutSeconds(45)).toBe(45)
  })
})
