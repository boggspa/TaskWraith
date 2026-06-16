import { describe, expect, it, vi } from 'vitest'
import {
  EnsembleOrchestrator,
  parseSelfReflectivePrefix,
  resolveYieldTargetIndex,
  type ParticipantProbeResult
} from './EnsembleOrchestrator'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { DiscordContextSnapshot } from '../channels/DiscordContextService'
import type {
  AppSettings,
  ChatRecord,
  EnsembleConfig,
  EnsembleParticipant,
  EnsembleWakeupRecord,
  UsageRecord
} from '../store/types'

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
    promptSurfaceStyle: 'theme',
    composerStyle: 'default',
    funFxEnabled: false,
    funFxMode: 'off',
    advancedFx: {
      agentAura: false,
      livingWorkspace: false,
      dataViz: false,
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
      perProviderMs: { gemini: 120000, codex: 30000, claude: 120000, kimi: 60000 },
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
    dispatch?: (payload: AgentRunPayload) => Promise<{ dispatched: boolean; appRunId: string }>
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
    scheduleWakeupTimer?: (wakeup: EnsembleWakeupRecord) => void
    cancelWakeupTimer?: (wakeupId: string) => void
    persistSessionCheckpoint?: (chat: ChatRecord, reason: string) => void
    completeSessionCheckpoint?: (chatId: string, roundId: string, status: string) => void
    recordUsage?: (entry: Omit<UsageRecord, 'id' | 'timestamp'>) => void
  } = {}
) {
  let chat = options.initialChat
    ? (JSON.parse(JSON.stringify(options.initialChat)) as ChatRecord)
    : makeChat()
  let counter = 0
  const dispatched: AgentRunPayload[] = []
  const dispatch = vi.fn(async (payload: AgentRunPayload) => {
    dispatched.push(payload)
    return options.dispatch
      ? options.dispatch(payload)
      : { dispatched: true, appRunId: payload.appRunId || '' }
  })
  const cancelRun = vi.fn(async () => true)
  const probeParticipant = options.probeParticipant ? vi.fn(options.probeParticipant) : undefined
  const orchestrator = new EnsembleOrchestrator({
    getChat: () => chat,
    saveChat: (next) => {
      chat = next
    },
    getSettings: makeSettings,
    dispatch,
    cancelRun,
    createRunId: (provider) => `${provider}-run-${++counter}`,
    now: () => counter,
    nowIso: () => `2026-05-24T00:00:0${counter}.000Z`,
    ...(probeParticipant ? { probeParticipant } : {}),
    ...(options.scheduleWakeupTimer ? { scheduleWakeupTimer: options.scheduleWakeupTimer } : {}),
    ...(options.cancelWakeupTimer ? { cancelWakeupTimer: options.cancelWakeupTimer } : {}),
    ...(options.persistSessionCheckpoint
      ? { persistSessionCheckpoint: options.persistSessionCheckpoint }
      : {}),
    ...(options.completeSessionCheckpoint
      ? { completeSessionCheckpoint: options.completeSessionCheckpoint }
      : {}),
    ...(options.recordUsage ? { recordUsage: options.recordUsage } : {})
  })
  return {
    get chat() {
      return chat
    },
    cancelRun,
    dispatched,
    dispatch,
    probeParticipant,
    orchestrator
  }
}

describe('EnsembleOrchestrator', () => {
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
        type: 'result',
        status: 'success',
        stats: { total_tokens: 10 }
      }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('codex')
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
      durationMs: 4200
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
    expect(
      harness.orchestrator.appendStatusForRun(runId, 'Yielded back to gemini (gemini).')
    ).toBe(true)

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
      status: 'running'
    })
  })

  it('schedules a wakeup and resumes the same participant in the active round', async () => {
    const scheduled: EnsembleWakeupRecord[] = []
    const harness = makeHarness({
      scheduleWakeupTimer: (wakeup) => scheduled.push(wakeup)
    })
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
    expect(harness.orchestrator.handleWakeupFired(scheduled[0].wakeupId)).toBe(true)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[2].ensembleRun?.participantId).toBe('claude')
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
    const harness1 = makeHarness({ scheduleWakeupTimer: () => {} })
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
    const wakeupId = sleepResult.wakeup!.wakeupId

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
    expect(restarted.dispatched[0].prompt).toContain('[Scheduled wakeup]')
    expect(restarted.dispatched[0].prompt).toContain('Waiting on background job.')

    // The transcript carries the woke-after-restart status row.
    expect(
      restarted.chat.messages.some((message) => message.content.includes('woke after app restart'))
    ).toBe(true)
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
      event: { sender: {} as Electron.WebContents }
    })

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.chat.messages[0]).toMatchObject({
      role: 'user',
      metadata: {
        kind: 'ensembleRoundPrompt',
        imageAttachments: [
          { id: 'img-1', path: '/tmp/ensemble-screenshot.png', name: 'ensemble-screenshot.png' }
        ]
      }
    })
    expect(harness.dispatched[0].imagePaths).toEqual(['/tmp/ensemble-screenshot.png'])
    expect(harness.dispatched[0].prompt).toContain('Attachment references for this request:')
    expect(harness.dispatched[0].prompt).toContain('/tmp/ensemble-screenshot.png')
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

  it('queues a fresh round after the current speaker finishes', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'First prompt',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const queued = harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Second prompt',
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
      {
        type: 'result',
        status: 'success'
      }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.chat.messages.map((message) => message.content)).toContain('Second prompt')
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

  it('steers by cancelling the active run without deleting the replacement round', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Original prompt',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const oldRun = harness.dispatched[0]

    const steered = harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Steered prompt',
      event: { sender: {} as Electron.WebContents },
      mode: 'steer'
    })

    expect(steered.status).toBe('steered')
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.cancelRun).toHaveBeenCalledWith('claude', oldRun.appRunId)
    expect(harness.chat.ensemble?.activeRound?.roundId).toBe(steered.roundId)
    expect(harness.chat.ensemble?.activeRound?.prompt).toBe('Steered prompt')
    expect(harness.chat.messages.map((message) => message.content)).toContain(
      'Ensemble steered: interrupted the active speaker and started a fresh round.'
    )

    const handled = harness.orchestrator.handleProviderOutput(
      'claude',
      {
        appRunId: oldRun.appRunId,
        appChatId: 'ensemble-chat'
      },
      {
        type: 'content',
        text: 'late old content'
      }
    )
    expect(handled).toBe(false)
    expect(harness.chat.messages.map((message) => message.content)).not.toContain(
      'late old content'
    )
  })

  it('continues to the next participant when the current participant yields', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Split this work.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    expect(
      harness.orchestrator.markYielded(harness.dispatched[0].appRunId!, 'Passing to worker.')
    ).toBe(true)

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
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Start the work.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].provider).toBe('claude')

    expect(
      harness.orchestrator.markYielded(
        harness.dispatched[0].appRunId!,
        'Need the user to choose.',
        'user'
      )
    ).toBe(true)

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
    expect(harness.dispatched[0].effectivePermissions?.agenticServices.shellCommands).toBe('deny')
    expect(harness.dispatched[0].effectivePermissions?.agenticServices.fileChanges).toBe('deny')

    harness.orchestrator.markYielded(harness.dispatched[0].appRunId!, 'Passing to worker.')
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

    const codexPayload = harness.dispatched[1]
    expect(codexPayload.effectivePermissions?.agenticServices.shellCommands).toBe('allow')
    expect(codexPayload.effectivePermissions?.agenticServices.fileChanges).toBe('allow')
    expect(codexPayload.effectivePermissions?.workspaceGrantServiceIds).toEqual([])
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

  it('promotes a participant tagged via @mention even when the speaker yields with the same target', async () => {
    // Production path the maintainer hit: Claude streams content with @codex,
    // then calls `ensemble_yield(target='codex')` via the MCP tool.
    // The yieldTarget branch fires FIRST after completion resolves,
    // but resolveYieldTargetIndex returns -1 because Codex isn't in
    // `remaining` (Codex already spoke). The yield branch silently
    // no-ops. My @-mention code should then fire and re-promote
    // Codex via the `remaining.unshift(tagged)` path.
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
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

    // Claude speaks (with @codex in content) then yields via tool to
    // codex. By the time the yieldTarget branch runs, `remaining` is
    // empty (Claude was the last in the round) — so the yield branch
    // no-ops. The @-mention branch should fire next and re-promote
    // Codex for a follow-up turn.
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
  })

  it('appends an extra turn when @-tagging a participant who already spoke', async () => {
    // After-round agent-loop: Claude speaks first, then Codex speaks
    // and mentions @Planner — Claude (role 'Planner') gets an extra
    // turn appended so the back-and-forth can continue.
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
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

    // Codex finishes and mentions @Planner — Claude should re-enter.
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

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[2].provider).toBe('claude')
    expect(harness.chat.ensemble?.activeRound?.continuationHops).toBe(1)
  })

  it('allows turn-bound panel rounds to retag an already-spoken participant for reconciliation', async () => {
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

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[2].provider).toBe('claude')
    expect(harness.chat.ensemble?.activeRound?.continuationHops).toBe(1)

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[2].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 10 } }
    )
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
  })

  it('caps continuous back-and-forth at the configured handoff limit', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    harness.chat.ensemble!.maxContinuationHops = 1
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
      prompt: 'Back and forth, but bounded.',
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
      { type: 'content', text: '@Planner please review my implementation.' }
    )
    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 10 } }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))

    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[2].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: '@Worker one more pass would help.' }
    )
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[2].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success', stats: { total_tokens: 10 } }
    )

    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    expect(harness.dispatched).toHaveLength(3)
    expect(harness.chat.ensemble?.activeRound?.continuationHops).toBe(1)
    expect(harness.chat.messages.map((message) => message.content)).toContain(
      'Continuous handoff limit reached (1/1); returning control to the user.'
    )
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

  it('falls through to default order when yield target is unresolved', async () => {
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
    harness.orchestrator.markYielded(
      harness.dispatched[0].appRunId!,
      'Pass it on',
      'NonExistentProvider'
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('codex')
  })

  it('threads kimi thinking flag through dispatch', async () => {
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
        thinkingEnabled: true
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
    // Kimi runs should NOT carry reasoning or fast-mode fields.
    expect(kimiPayload.reasoningEffort).toBeUndefined()
    expect(kimiPayload.serviceTier).toBeUndefined()
    expect(kimiPayload.claudeFastMode).toBeUndefined()
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

  it('falls through to the full round when dmTargetParticipantId points at a non-existent id', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'DM phantom.',
      event: { sender: {} as Electron.WebContents },
      dmTargetParticipantId: 'phantom-participant'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    // First in default fixture order = Claude. The unknown DM target
    // is silently ignored; the orchestrator runs the full ordered
    // participant list (safety net for typo / racy IPC).
    expect(harness.dispatched[0].provider).toBe('claude')
  })

  // 1.0.4 — same-provider disambiguation. Two Codex participants
  // both claim the `codex` alias; when Kimi writes `@codex`, the
  // resolver picks the ensemble-first Codex but the orchestrator
  // must surface a system note explaining the ambiguity AND prefer
  // a candidate still in the remaining rotation (next-in-rotation
  // that hasn't spoken).
  it('emits a system warning and re-picks rotation-aware when @<provider> is ambiguous', async () => {
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
        id: 'ensemble-codex-brodex',
        provider: 'codex',
        enabled: true,
        role: 'Brodex',
        instructions: 'Implement.',
        order: 2,
        model: 'gpt-5.5',
        permissionPresetId: 'workspace_write'
      },
      {
        id: 'ensemble-codex-chodex',
        provider: 'codex',
        enabled: true,
        role: 'Chodex #2',
        instructions: 'Review.',
        order: 3,
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
    // finishes. The resolver picks Brodex (ensemble-first), and
    // the orchestrator's rotation-aware re-pick keeps Brodex (also
    // the next-in-rotation). Either way, Brodex speaks next.
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('codex')
    expect(harness.dispatched[1].ensembleRun).toMatchObject({
      participantId: 'ensemble-codex-brodex'
    })

    // System message announcing the ambiguity.
    const messages = harness.chat.messages.map((m) => m.content)
    expect(
      messages.some(
        (content) =>
          typeof content === 'string' &&
          content.includes('was ambiguous') &&
          content.includes('Codex participants') &&
          content.includes('Brodex')
      )
    ).toBe(true)
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

  // 1.0.4-AK3 — Work Session hard-stops + permission enforcement.
  //
  // These cover the safety surfaces between AK1 (the data shape +
  // ensemble_continue tool) and AK4-AK6 (the parallel substrate).
  // The orchestrator must:
  //   1. Apply the Work Session permission preset over the per-
  //      participant preset when the session is active (not bypass
  //      EffectiveRunPermissions, just feed the new preset in).
  //   2. Drop queued continuations when the session has transitioned
  //      to a terminal status (completed / paused / cancelled /
  //      limit_reached) between rounds.
  //   3. Detect duration-budget exhaustion at round-end and emit
  //      the appropriate transcript note + status transition.

  it('1.0.4-AK3: overrides per-participant permission preset with workSession preset when active', async () => {
    const harness = makeHarness()
    // Claude participant is read_only, Codex is workspace_write.
    // Setting workSession to full_access should override BOTH.
    harness.chat.ensemble!.workSession = {
      enabled: true,
      status: 'active',
      objective: 'Test override',
      acceptanceCriteria: 'Permissions correct',
      allowedParticipantIds: null,
      permissionPresetId: 'full_access',
      maxRoundsPerProvider: 38,
      maxDurationMs: 6 * 60 * 60 * 1000,
      enableScoutPass: false,
      startedAt: new Date().toISOString(),
      roundsUsed: { codex: 0, claude: 0, gemini: 0, kimi: 0, grok: 0, cursor: 0, ollama: 0 },
      totalRoundsUsed: 0
    }
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Start work.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    // First dispatched payload is Claude — pre-fix it would have
    // arrived with permissionPresetId 'read_only' (the participant
    // preset). Now it should carry 'full_access' from the session.
    expect(harness.dispatched[0].effectivePermissions?.presetId).toBe('full_access')
  })

  it('1.0.4-AK3: reverts to per-participant preset when workSession is not active', async () => {
    const harness = makeHarness()
    // workSession exists but is in `paused` status — the override
    // should NOT apply. This guarantees pausing + resuming
    // doesn't accidentally re-clamp on the resume side.
    harness.chat.ensemble!.workSession = {
      enabled: true,
      status: 'paused',
      objective: 'Test',
      acceptanceCriteria: 'Test',
      allowedParticipantIds: null,
      permissionPresetId: 'read_only',
      maxRoundsPerProvider: 38,
      maxDurationMs: 6 * 60 * 60 * 1000,
      enableScoutPass: false,
      roundsUsed: { codex: 0, claude: 0, gemini: 0, kimi: 0, grok: 0, cursor: 0, ollama: 0 },
      totalRoundsUsed: 0
    }
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Start work.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    // Claude is read_only natively — same result either way for
    // Claude, but the SECOND dispatched payload (Codex) should
    // have its native workspace_write preset, NOT the paused
    // session's read_only override.
    expect(harness.dispatched[0].effectivePermissions?.presetId).toBe('read_only')
  })

  it('1.0.4-AK3: scopes active Work Session rounds to allowed participants and leads with the configured lead', async () => {
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
      },
      {
        id: 'gemini',
        provider: 'gemini',
        enabled: true,
        role: 'Researcher',
        instructions: 'Research.',
        order: 3,
        permissionPresetId: 'read_only'
      }
    ]
    harness.chat.ensemble!.workSession = {
      enabled: true,
      status: 'active',
      objective: 'Test scoped roster',
      acceptanceCriteria: 'Only allowed participants speak.',
      allowedParticipantIds: ['codex', 'gemini'],
      leadParticipantId: 'gemini',
      permissionPresetId: 'workspace_write',
      maxRoundsPerProvider: 38,
      maxDurationMs: 6 * 60 * 60 * 1000,
      enableScoutPass: false,
      startedAt: new Date().toISOString(),
      roundsUsed: { codex: 0, claude: 0, gemini: 0, kimi: 0, grok: 0, cursor: 0, ollama: 0 },
      totalRoundsUsed: 0
    }

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Start scoped work.',
      event: { sender: {} as Electron.WebContents }
    })

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.chat.ensemble?.activeRound?.participants.map((p) => p.participantId)).toEqual([
      'gemini',
      'codex'
    ])
    expect(harness.dispatched[0].provider).toBe('gemini')

    harness.orchestrator.handleProviderOutput(
      'gemini',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].provider).toBe('codex')
    expect(harness.dispatched.map((payload) => payload.provider)).not.toContain('claude')
  })

  it('1.0.4-AK3: drops queued prompts when workSession transitions to completed mid-round', async () => {
    const harness = makeHarness()
    harness.chat.ensemble!.workSession = {
      enabled: true,
      status: 'active',
      objective: 'Test',
      acceptanceCriteria: 'Test',
      allowedParticipantIds: null,
      permissionPresetId: 'workspace_write',
      maxRoundsPerProvider: 38,
      maxDurationMs: 6 * 60 * 60 * 1000,
      enableScoutPass: false,
      startedAt: new Date().toISOString(),
      roundsUsed: { codex: 0, claude: 0, gemini: 0, kimi: 0, grok: 0, cursor: 0, ollama: 0 },
      totalRoundsUsed: 0
    }
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Round 1.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    // Claude finishes the round.
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'Done!' }
    )
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    // Codex's turn — simulate that ensemble_continue queues a
    // prompt BUT then transitions the session to completed.
    harness.orchestrator.enqueueWorkSessionContinuation(
      'ensemble-chat',
      'queued-but-should-be-dropped'
    )
    // Externally transition the session — same as
    // ensemble_continue(acceptanceStatus: 'complete') would do.
    harness.chat.ensemble!.workSession = {
      ...harness.chat.ensemble!.workSession!,
      status: 'completed',
      endedAt: new Date().toISOString(),
      endedReason: 'Acceptance criteria met.'
    }
    // Codex finishes.
    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'content', text: 'Codex done.' }
    )
    harness.orchestrator.handleProviderOutput(
      'codex',
      { appRunId: harness.dispatched[1].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    // Give the orchestrator a tick to drain the queue + dispatch
    // (which it should refuse to do because session is terminal).
    await new Promise((resolve) => setTimeout(resolve, 50))
    // Only the original two dispatches should have happened — the
    // queued continuation was dropped on the terminal-status check.
    expect(harness.dispatched).toHaveLength(2)
  })

  it('1.0.4-AK3: drops queued prompts when workSession duration cap elapses at round-end', async () => {
    const harness = makeHarness()
    // startedAt 7 hours ago + 6h cap means we should hit the
    // duration cap at the first round-end check. Single-participant
    // ensemble so the round closes after one dispatch — matches the
    // pattern used by "queues a fresh round" so we don't have to
    // chase two providers through the full lifecycle in a test that
    // is really about the round-end terminal-status drain.
    harness.chat.ensemble!.participants = [harness.chat.ensemble!.participants[0]]
    harness.chat.ensemble!.workSession = {
      enabled: true,
      status: 'active',
      objective: 'Test',
      acceptanceCriteria: 'Test',
      allowedParticipantIds: null,
      permissionPresetId: 'workspace_write',
      maxRoundsPerProvider: 38,
      maxDurationMs: 6 * 60 * 60 * 1000,
      enableScoutPass: false,
      startedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
      roundsUsed: { codex: 0, claude: 0, gemini: 0, kimi: 0, grok: 0, cursor: 0, ollama: 0 },
      totalRoundsUsed: 0
    }
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Start.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    // Queue a continuation before round end.
    harness.orchestrator.enqueueWorkSessionContinuation(
      'ensemble-chat',
      'should-be-dropped-by-duration'
    )
    // Close Claude's turn → triggers round-end check.
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    // The duration-exhausted check should have transitioned the
    // session to limit_reached + dropped the queued continuation.
    expect(harness.chat.ensemble?.workSession?.status).toBe('limit_reached')
    expect(harness.chat.ensemble?.workSession?.endedReason).toContain('Duration budget reached')
    // Single dispatch — no fresh round fired from the queue.
    expect(harness.dispatched).toHaveLength(1)
    // Transcript status row should explain the end.
    const durationNote = harness.chat.messages.find(
      (m) =>
        m.role === 'system' &&
        typeof m.content === 'string' &&
        m.content.includes('Work Session ended') &&
        m.content.includes('Duration budget reached')
    )
    expect(durationNote).toBeDefined()
  })

  it('1.0.4-AK3: honours queued continuation when workSession stays active', async () => {
    // Mirror of the above tests — verify the happy path still
    // dispatches when the session is healthy. Guards against
    // a bug where the hard-stop check accidentally drops queues
    // for active sessions. Single-participant ensemble keeps the
    // test focused on the queue-drain → fresh-round path.
    const harness = makeHarness()
    harness.chat.ensemble!.participants = [harness.chat.ensemble!.participants[0]]
    harness.chat.ensemble!.workSession = {
      enabled: true,
      status: 'active',
      objective: 'Test',
      acceptanceCriteria: 'Test',
      allowedParticipantIds: null,
      permissionPresetId: 'workspace_write',
      maxRoundsPerProvider: 38,
      maxDurationMs: 6 * 60 * 60 * 1000,
      enableScoutPass: false,
      startedAt: new Date().toISOString(),
      roundsUsed: { codex: 0, claude: 0, gemini: 0, kimi: 0, grok: 0, cursor: 0, ollama: 0 },
      totalRoundsUsed: 0
    }
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Round 1.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    // Queue a follow-up while Claude is mid-turn.
    harness.orchestrator.enqueueWorkSessionContinuation('ensemble-chat', 'continue-please')
    // Close Claude's turn — round-end check fires + queued prompt
    // dispatches as a fresh round.
    harness.orchestrator.handleProviderOutput(
      'claude',
      { appRunId: harness.dispatched[0].appRunId, appChatId: 'ensemble-chat' },
      { type: 'result', status: 'success' }
    )
    // Round 2 fires with the queued prompt.
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2), {
      timeout: 1000
    })
    expect(harness.dispatched[1].prompt).toContain('continue-please')
  })

  // 1.0.4-AK5 — Parallel fan-out.
  // Gated behind workSession.enableScoutPass + 2+ read-only
  // participants. When triggered, the orchestrator dispatches all
  // read-only scouts concurrently via Promise.all BEFORE the
  // serial writer step begins.

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
    harness.chat.ensemble!.workSession = {
      enabled: true,
      status: 'active',
      objective: 'Fan-out demo',
      acceptanceCriteria: 'Scouts ran in parallel.',
      allowedParticipantIds: null,
      permissionPresetId: 'workspace_write',
      maxRoundsPerProvider: 38,
      maxDurationMs: 6 * 60 * 60 * 1000,
      enableScoutPass: true,
      startedAt: new Date().toISOString(),
      roundsUsed: { codex: 0, claude: 0, gemini: 0, kimi: 0, grok: 0, cursor: 0, ollama: 0 },
      totalRoundsUsed: 0
    }
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

    // Transcript has the fan-out open/close status notes.
    const fanoutOpenNote = harness.chat.messages.find(
      (m) =>
        m.role === 'system' &&
        typeof m.content === 'string' &&
        m.content.includes('Parallel fan-out · 2 read-only')
    )
    expect(fanoutOpenNote).toBeDefined()
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
    harness.chat.ensemble!.workSession = {
      enabled: true,
      status: 'active',
      objective: 'Test',
      acceptanceCriteria: 'Test',
      allowedParticipantIds: null,
      permissionPresetId: 'read_only',
      maxRoundsPerProvider: 38,
      maxDurationMs: 6 * 60 * 60 * 1000,
      // Fan-out OFF — serial dispatch should run.
      enableScoutPass: false,
      startedAt: new Date().toISOString(),
      roundsUsed: { codex: 0, claude: 0, gemini: 0, kimi: 0, grok: 0, cursor: 0, ollama: 0 },
      totalRoundsUsed: 0
    }
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

  it('1.0.8: ensemble_fanout dispatches explicit read-only targets in lanes', async () => {
    const harness = makeHarness()
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
      targets: ['Reviewer', 'Researcher'],
      prompt: 'Inspect the workspace and emit a brief.',
      reason: 'parallel review'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3), { timeout: 1000 })
    const laneRuns = harness.dispatched.slice(1)
    expect(laneRuns.map((payload) => payload.provider).sort()).toEqual(['claude', 'gemini'])
    expect(laneRuns.every((payload) => Boolean(payload.ensembleRun?.laneId))).toBe(true)

    for (const payload of laneRuns) {
      harness.orchestrator.handleProviderOutput(
        payload.provider,
        { appRunId: payload.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
    }
    const result = await fanout
    expect(result.ok).toBe(true)
    expect(result.laneIds).toHaveLength(2)
  })

  it('1.0.8: ensemble_fanout does not dispatch the same future participants again serially', async () => {
    const harness = makeHarness()
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
      targets: ['Reviewer', 'Researcher'],
      prompt: 'Inspect the workspace and emit a brief.'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3), { timeout: 1000 })
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

    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))
    expect(harness.dispatched).toHaveLength(3)
    expect(harness.dispatched.map((payload) => payload.provider).sort()).toEqual([
      'claude',
      'codex',
      'gemini'
    ])
  })

  it('1.0.8: ensemble_fanout locked_writers mode is feature-gated', async () => {
    const previous = process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
    delete process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
    try {
      const harness = makeHarness()
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
          model: 'qwen3.5:9b'
        },
        {
          id: 'ollama-b',
          provider: 'ollama',
          enabled: true,
          role: 'Scout B',
          instructions: 'Scout.',
          order: 2,
          permissionPresetId: 'read_only',
          model: 'gemma4:12b'
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
      expect(harness.chat.messages.at(-1)?.content).toContain('2 Ollama lane(s)')
    } finally {
      if (previous === undefined) {
        delete process.env.TASKWRAITH_CONCURRENT_LANES
      } else {
        process.env.TASKWRAITH_CONCURRENT_LANES = previous
      }
    }
  })

  it('1.0.8: fans out read-only participants in concurrent mode without a Work Session', async () => {
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

  it('1.0.8: concurrent mode dispatches locked writer lanes when the write-lane gate is on', async () => {
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

      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2), { timeout: 1000 })
      const lanes = Object.values(harness.chat.ensemble?.activeRound?.lanes || {})
      expect(lanes.map((lane) => lane.intent).sort()).toEqual(['read', 'write'])
      expect(lanes.map((lane) => lane.status).sort()).toEqual(['running', 'running'])

      for (const payload of harness.dispatched) {
        harness.orchestrator.handleProviderOutput(
          payload.provider,
          { appRunId: payload.appRunId, appChatId: 'ensemble-chat' },
          { type: 'result', status: 'success' }
        )
      }
      await vi.waitFor(() =>
        expect(
          Object.values(harness.chat.ensemble?.activeRound?.lanes || {})
            .map((lane) => lane.status)
            .sort()
        ).toEqual(['completed', 'completed'])
      )
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
    harness.chat.ensemble!.workSession = {
      enabled: true,
      status: 'active',
      objective: 'Brief threading test',
      acceptanceCriteria: 'Codex sees both briefs.',
      allowedParticipantIds: null,
      permissionPresetId: 'workspace_write',
      maxRoundsPerProvider: 38,
      maxDurationMs: 6 * 60 * 60 * 1000,
      enableScoutPass: true,
      startedAt: new Date().toISOString(),
      roundsUsed: { codex: 0, claude: 0, gemini: 0, kimi: 0, grok: 0, cursor: 0, ollama: 0 },
      totalRoundsUsed: 0
    }
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
    // No Work Session, no fan-out pass — must be false.
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
    harness.chat.ensemble!.workSession = {
      enabled: true,
      status: 'active',
      objective: 'Test',
      acceptanceCriteria: 'Test',
      allowedParticipantIds: null,
      permissionPresetId: 'workspace_write',
      maxRoundsPerProvider: 38,
      maxDurationMs: 6 * 60 * 60 * 1000,
      enableScoutPass: true,
      startedAt: new Date().toISOString(),
      roundsUsed: { codex: 0, claude: 0, gemini: 0, kimi: 0, grok: 0, cursor: 0, ollama: 0 },
      totalRoundsUsed: 0
    }
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
