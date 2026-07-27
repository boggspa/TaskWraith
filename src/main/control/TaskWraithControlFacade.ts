import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type {
  BridgeCancelRunAction,
  BridgeComposerPromptAction,
  BridgeEnsembleCancelRoundAction,
  BridgeEnsembleSteerAction
} from '../BridgeActionPayload'
import type { BridgeActionExecutionResult } from '../BridgeActionExecutor'
import { deriveRemoteTaskStatusForChat } from '../RemoteTaskProjection'
import { projectRemoteThread, type RemoteThreadRow } from '../RemoteThreadProjection'
import { AppStore } from '../store'
import { collectExternalPathGrantsFromMetadata } from '../store/ExternalPathGrants'
import { getCachedRemoteEnsemblePresets } from '../remote/EnsembleRosterPresetsCache'
import type {
  ChatListItem,
  ChatMessage,
  ChatRecord,
  ChatRun,
  EnsembleParticipant,
  EnsembleRoundParticipantState,
  WorkspaceRecord
} from '../store/types'
import type {
  TaskWraithControlEnsembleSummary,
  TaskWraithControlParticipant,
  TaskWraithControlProviderPresentation,
  TaskWraithControlSnapshot,
  TaskWraithControlThread,
  TaskWraithControlThreadContext,
  TaskWraithControlThreadSnapshot,
  TaskWraithControlThreadStatus,
  TaskWraithControlTranscriptRow,
  TaskWraithControlWorkspaceContext
} from '../../shared/taskWraithControlProtocol'
import {
  resolveTaskWraithProviderPresentation,
  taskWraithProviderLabel
} from '../../shared/taskWraithProviderPresentation'
import { LocalControlServer, type LocalControlServerOptions } from './LocalControlServer'

export interface TaskWraithControlFacadeOptions {
  executeComposerPrompt: (
    action: BridgeComposerPromptAction
  ) => Promise<BridgeActionExecutionResult>
  executeCancelRun: (action: BridgeCancelRunAction) => Promise<BridgeActionExecutionResult>
  executeEnsembleSteer: (action: BridgeEnsembleSteerAction) => Promise<BridgeActionExecutionResult>
  executeEnsembleCancelRound: (
    action: BridgeEnsembleCancelRoundAction
  ) => Promise<BridgeActionExecutionResult>
  now?: () => number
}

export interface StartTaskWraithLocalControlOptions extends TaskWraithControlFacadeOptions {
  userDataPath: string
  hostVersion: string
  log?: (line: string) => void
  platform?: NodeJS.Platform
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function nonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function latestRun(chat: Pick<ChatRecord, 'runs'>): ChatRun | undefined {
  return [...(chat.runs ?? [])].reverse().find((run) => Boolean(run?.runId))
}

function activeRun(chat: Pick<ChatRecord, 'runs'>): ChatRun | undefined {
  return [...(chat.runs ?? [])]
    .reverse()
    .find(
      (run) =>
        !run.endedAt &&
        !run.cancelled &&
        !['completed', 'success', 'failed', 'cancelled'].includes(
          String(run.status || '').toLowerCase()
        )
    )
}

function participantForActiveRound(chat: ChatRecord): EnsembleParticipant | undefined {
  const activeId = chat.ensemble?.activeRound?.activeParticipantId
  if (!activeId) return undefined
  return chat.ensemble?.participants.find((participant) => participant.id === activeId)
}

function modelForChat(chat: ChatRecord | ChatListItem): string | undefined {
  const participant = participantForActiveRound(chat)
  const run = latestRun(chat)
  const metadata = record(chat.providerMetadata)
  return nonEmptyString(
    participant?.model,
    run?.actualModel,
    run?.requestedModel,
    metadata.customModel,
    metadata.selectedModelType,
    chat.requestedModel,
    chat.lastActualModel
  )
}

function providerForChat(chat: ChatRecord | ChatListItem): string {
  return (
    participantForActiveRound(chat)?.provider ||
    latestRun(chat)?.provider ||
    chat.provider ||
    'gemini'
  )
}

function reasoningForProvider(
  provider: string,
  chat: ChatRecord | ChatListItem,
  participant?: EnsembleParticipant
): string | undefined {
  if (participant?.reasoningEffort) return participant.reasoningEffort
  const metadata = record(chat.providerMetadata)
  const keyByProvider: Record<string, string[]> = {
    codex: ['codexReasoningEffort', 'reasoningEffort'],
    claude: ['claudeReasoningEffort', 'reasoningEffort'],
    kimi: ['kimiReasoningEffort', 'reasoningEffort'],
    grok: ['grokReasoningEffort', 'reasoningEffort'],
    cursor: ['cursorReasoningEffort', 'reasoningEffort'],
    antigravity: ['geminiReasoningEffort', 'reasoningEffort'],
    gemini: ['geminiReasoningEffort', 'reasoningEffort']
  }
  return nonEmptyString(
    ...(keyByProvider[provider] ?? ['reasoningEffort']).map((key) => metadata[key])
  )
}

function statusForChat(chat: ChatRecord): TaskWraithControlThreadStatus {
  const status = deriveRemoteTaskStatusForChat(chat)
  switch (status) {
    case 'running':
      return 'working'
    case 'awaitingApproval':
    case 'awaitingQuestion':
      return 'needs-input'
    case 'queued':
      return 'queued'
    case 'success':
      return 'complete'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'idle'
  }
}

function wallTimeForChat(chat: ChatRecord, now: number): number | undefined {
  const run = activeRun(chat) ?? latestRun(chat)
  if (!run?.startedAt) return undefined
  const start = Date.parse(run.startedAt)
  const end = run.endedAt ? Date.parse(run.endedAt) : now
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined
  return end - start
}

function tokenEstimateForRun(run: ChatRun | undefined): number | undefined {
  if (!run) return undefined
  const stats = record(run.stats)
  for (const value of [
    stats.total_tokens,
    stats.totalTokens,
    stats.output_tokens,
    stats.outputTokens,
    stats.tokens
  ]) {
    const parsed = typeof value === 'number' ? value : Number(value)
    if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed)
  }
  return undefined
}

function tokenEstimateForChat(chat: ChatRecord): number | undefined {
  const run = activeRun(chat) ?? latestRun(chat)
  const reported = tokenEstimateForRun(run)
  if (reported !== undefined) return reported
  if (!run?.runId) return undefined
  const visibleCharacters = chat.messages
    .filter((message) => message.runId === run.runId && message.role === 'assistant')
    .reduce(
      (total, message) =>
        total + (typeof message.content === 'string' ? message.content.length : 0),
      0
    )
  return visibleCharacters > 0 ? Math.max(1, Math.round(visibleCharacters / 4)) : undefined
}

function participantPresentation(
  participant: EnsembleParticipant,
  roundState: EnsembleRoundParticipantState | undefined,
  activeId: string | undefined,
  nextId: string | undefined
): TaskWraithControlParticipant {
  const rawModel = roundState?.model ?? participant.model
  const presentation = resolveTaskWraithProviderPresentation(participant.provider, rawModel)
  return {
    id: participant.id,
    provider: participant.provider,
    displayProvider: presentation.displayProvider,
    hueKey: presentation.hueKey,
    accent: presentation.accent,
    shortCode: presentation.shortCode,
    role: participant.role || presentation.displayProvider,
    ...(rawModel ? { model: presentation.modelLabel ?? rawModel } : {}),
    ...((roundState?.reasoningEffort ?? participant.reasoningEffort)
      ? { reasoning: roundState?.reasoningEffort ?? participant.reasoningEffort }
      : {}),
    order: participant.order,
    ...(participant.stageRole ? { stage: participant.stageRole } : {}),
    ...(roundState?.status ? { status: roundState.status } : {}),
    active: participant.id === activeId,
    next: participant.id === nextId,
    enabled: participant.enabled
  }
}

function ensembleForChat(chat: ChatRecord): TaskWraithControlEnsembleSummary | undefined {
  if (chat.chatKind !== 'ensemble' && !chat.ensemble?.enabled) return undefined
  const config = chat.ensemble
  if (!config) return undefined
  const round = config.activeRound
  const enabled = [...config.participants].filter((participant) => participant.enabled)
  const ordered = enabled.sort((a, b) => a.order - b.order)
  const activeId = round?.activeParticipantId
  const roundById = new Map(
    (round?.participants ?? []).map((participant) => [participant.participantId, participant])
  )
  const activeIndex = activeId
    ? ordered.findIndex((participant) => participant.id === activeId)
    : -1
  const nextCandidates =
    activeIndex >= 0
      ? [...ordered.slice(activeIndex + 1), ...ordered.slice(0, activeIndex)]
      : ordered
  const next = nextCandidates.find((participant) => {
    const status = roundById.get(participant.id)?.status
    return !status || ['idle', 'pending', 'queued'].includes(status)
  })
  const fanout =
    round?.fanoutPolicy ??
    config.fanoutPolicy ??
    (round?.concurrentMode || config.concurrentModeEnabled ? 'read_only' : 'off')
  const presetName = config.activeRosterPresetId
    ? getCachedRemoteEnsemblePresets().find((preset) => preset.id === config.activeRosterPresetId)
        ?.name
    : undefined
  return {
    preset: presetName || 'Custom',
    mode: round?.orchestrationMode ?? config.orchestrationMode ?? 'turn-bound',
    fanout,
    continuationHops: round?.continuationHops ?? 0,
    maxContinuationHops: round?.maxContinuationHops ?? config.maxContinuationHops ?? 0,
    backgroundCount: ordered.filter((participant) => participant.stageRole === 'background').length,
    participants: ordered.map((participant) =>
      participantPresentation(participant, roundById.get(participant.id), activeId, next?.id)
    )
  }
}

function threadProvider(chat: ChatRecord | ChatListItem): TaskWraithControlProviderPresentation {
  const provider = providerForChat(chat)
  return resolveTaskWraithProviderPresentation(provider, modelForChat(chat))
}

function threadSummary(chat: ChatRecord, now: number, costText?: string): TaskWraithControlThread {
  const provider = threadProvider(chat)
  const participant = participantForActiveRound(chat)
  const reasoning = reasoningForProvider(provider.runtimeProvider, chat, participant)
  const wallTimeMs = wallTimeForChat(chat, now)
  const tokenEstimate = tokenEstimateForChat(chat)
  const ensemble = ensembleForChat(chat)
  return {
    id: chat.appChatId,
    workspaceId: chat.scope === 'global' ? null : chat.workspaceId || null,
    ...(chat.parentChatId ? { parentThreadId: chat.parentChatId } : {}),
    title: chat.title || 'Untitled chat',
    provider,
    ...(reasoning ? { reasoning } : {}),
    status: statusForChat(chat),
    chatKind: chat.chatKind === 'ensemble' || chat.ensemble?.enabled ? 'ensemble' : 'single',
    archived: chat.archived === true,
    pinned: chat.pinned === true,
    updatedAt: chat.updatedAt,
    messageCount: chat.messages?.length ?? 0,
    ...(wallTimeMs !== undefined ? { wallTimeMs } : {}),
    ...(tokenEstimate !== undefined ? { tokenEstimate } : {}),
    ...(costText ? { costText } : {}),
    ...(ensemble ? { ensemble } : {})
  }
}

function workspaceSummary(workspace: WorkspaceRecord) {
  return {
    id: workspace.id,
    name: workspace.displayName || basename(workspace.path),
    path: workspace.path,
    pinned: workspace.pinned,
    updatedAt: workspace.lastOpenedAt
  }
}

function speakerProvider(
  chat: ChatRecord,
  message: ChatMessage
): TaskWraithControlProviderPresentation | undefined {
  if (message.role === 'user') return undefined
  const metadata = record(message.metadata)
  const run = message.runId
    ? chat.runs?.find((candidate) => candidate.runId === message.runId)
    : undefined
  const provider = nonEmptyString(
    metadata.ensembleProvider,
    metadata.provider,
    run?.provider,
    chat.provider
  )
  if (!provider) return undefined
  const model = nonEmptyString(
    metadata.ensembleModel,
    metadata.providerModel,
    run?.actualModel,
    run?.requestedModel,
    modelForChat(chat)
  )
  return resolveTaskWraithProviderPresentation(provider, model)
}

function projectedSpeaker(
  chat: ChatRecord,
  message: ChatMessage,
  row: RemoteThreadRow,
  presentation?: TaskWraithControlProviderPresentation
): string {
  if (message.role === 'user') return 'You'
  if (row.speaker) return row.speaker
  if (message.role === 'assistant')
    return presentation?.displayProvider ?? taskWraithProviderLabel(chat.provider || '')
  if (message.role === 'tool') return 'Tool'
  return 'TaskWraith'
}

function transcriptRows(
  chat: ChatRecord,
  rows: RemoteThreadRow[]
): TaskWraithControlTranscriptRow[] {
  const byId = new Map(chat.messages.map((message) => [message.id, message]))
  return rows.map((row) => {
    const message = byId.get(row.id)
    const provider = message ? speakerProvider(chat, message) : undefined
    return {
      id: row.id,
      role: row.role,
      kind: row.kind,
      speaker: message
        ? projectedSpeaker(chat, message, row, provider)
        : row.speaker || 'TaskWraith',
      ...(provider ? { provider } : {}),
      text: row.preview,
      timestamp: row.timestamp,
      truncated: row.truncated,
      ...(row.toolSummary?.tools?.length
        ? {
            tools: row.toolSummary.tools.map((tool) => ({
              name: tool.name,
              category: tool.category,
              status: tool.status,
              ...(tool.detail ? { detail: tool.detail } : {}),
              ...(tool.file ? { file: tool.file } : {}),
              ...(tool.additions !== undefined ? { additions: tool.additions } : {}),
              ...(tool.deletions !== undefined ? { deletions: tool.deletions } : {})
            }))
          }
        : {}),
      ...(row.thinking
        ? {
            thinking: {
              title: row.thinking.title,
              text: row.thinking.preview,
              ...(row.thinking.status ? { status: row.thinking.status } : {})
            }
          }
        : {})
    }
  })
}

function workspaceContext(chat: ChatRecord): TaskWraithControlWorkspaceContext[] {
  const workspaces = AppStore.getWorkspaces()
  const primary = chat.workspaceId
    ? workspaces.find((workspace) => workspace.id === chat.workspaceId)
    : undefined
  const result: TaskWraithControlWorkspaceContext[] = []
  if (primary) {
    result.push({
      id: primary.id,
      name: primary.displayName || basename(primary.path),
      path: primary.path,
      access: workspaceAccessForChat(chat),
      primary: true
    })
  }
  const grants = collectExternalPathGrantsFromMetadata(chat.providerMetadata)
  const byPath = new Map<string, 'read' | 'write'>()
  for (const grant of grants) {
    const previous = byPath.get(grant.path)
    if (!previous || grant.access === 'write') byPath.set(grant.path, grant.access)
  }
  for (const [path, access] of byPath) {
    if (primary?.path === path) continue
    const registered = workspaces.find((workspace) => workspace.path === path)
    result.push({
      id: registered?.id || path,
      name: registered?.displayName || basename(path),
      path,
      access,
      primary: false
    })
  }
  return result
}

function permissionForChat(chat: ChatRecord): string | undefined {
  const participant = participantForActiveRound(chat)
  const run = activeRun(chat) ?? latestRun(chat)
  const posture = record(run?.permissionPosture)
  const metadata = record(chat.providerMetadata)
  return nonEmptyString(
    participant?.permissionPresetId,
    posture.presetId,
    metadata.permissionPresetId,
    run?.approvalMode,
    chat.settingsSnapshot?.approvalMode
  )
}

function workspaceAccessForChat(chat: ChatRecord): 'read' | 'write' {
  const permission = String(permissionForChat(chat) || '').toLowerCase()
  return permission.includes('read') || permission === 'plan' ? 'read' : 'write'
}

export function createTaskWraithControlFacade(options: TaskWraithControlFacadeOptions) {
  const now = options.now ?? (() => Date.now())
  let sequence = 0

  const snapshot = (): TaskWraithControlSnapshot => {
    const generatedAt = new Date(now()).toISOString()
    const chats = AppStore.getChats()
    return {
      generatedAt,
      sequence: ++sequence,
      workspaces: AppStore.getWorkspaces().map(workspaceSummary),
      threads: chats.map((chat) => threadSummary(chat, now()))
    }
  }

  const selectThread = (threadId: string, limit: number): TaskWraithControlThreadSnapshot => {
    const chat = AppStore.getChat(threadId)
    if (!chat) throw new Error('Thread not found.')
    const projected = projectRemoteThread(chat.messages, chat.runs, {
      threadId,
      mode: { kind: 'latestN', n: Math.min(200, Math.max(1, limit)) },
      // The TUI is a reading surface, not a transcript export. Keep each
      // projected row useful but compact enough that a worst-case page stays
      // inside the bounded local-control frame.
      previewMaxChars: 4_000,
      notes: chat.pinnedNotes,
      blackboardEntries: chat.ensemble?.blackboard,
      speakerForMessage: (message) => {
        const metadata = record(message.metadata)
        const role = nonEmptyString(metadata.ensembleRole)
        const provider = nonEmptyString(metadata.ensembleProvider)
        const model = nonEmptyString(metadata.ensembleModel)
        if (!provider) return undefined
        const presentation = resolveTaskWraithProviderPresentation(provider, model)
        return role ? `${presentation.displayProvider} · ${role}` : presentation.displayProvider
      }
    })
    const provider = threadProvider(chat)
    const reasoning = reasoningForProvider(
      provider.runtimeProvider,
      chat,
      participantForActiveRound(chat)
    )
    const permission = permissionForChat(chat)
    const wallTimeMs = wallTimeForChat(chat, now())
    const tokenEstimate = tokenEstimateForChat(chat)
    const ensemble = ensembleForChat(chat)
    const context: TaskWraithControlThreadContext = {
      workspaces: workspaceContext(chat),
      provider,
      ...(reasoning ? { reasoning } : {}),
      ...(permission ? { permission } : {}),
      ...(wallTimeMs !== undefined ? { wallTimeMs } : {}),
      ...(tokenEstimate !== undefined ? { tokenEstimate } : {}),
      ...(projected.conversationCostText ? { costText: projected.conversationCostText } : {}),
      ...(ensemble ? { ensemble } : {})
    }
    return {
      generatedAt: projected.generatedAt,
      sequence: ++sequence,
      thread: threadSummary(chat, now(), projected.conversationCostText),
      rows: transcriptRows(chat, projected.rows),
      totalRows: projected.totalRows,
      hasMoreAbove: projected.hasMoreAbove,
      context
    }
  }

  const sendPrompt = async (threadId: string, text: string) => {
    const chat = AppStore.getChat(threadId)
    if (!chat) throw new Error('Thread not found.')
    if (chat.archived) throw new Error('Archived threads cannot start a new turn.')
    const prompt = text.trim()
    if (!prompt) throw new Error('Prompt is empty.')
    const issuedAt = now()
    const workspaceId = chat.scope === 'global' ? 'global' : chat.workspaceId || ''
    if (chat.chatKind === 'ensemble' || chat.ensemble?.enabled) {
      const action: BridgeEnsembleSteerAction = {
        kind: 'ensembleSteer',
        actionId: `tui-ensemble:${threadId}:${randomUUID()}`,
        issuedAt,
        expiresAt: issuedAt + 2 * 60_000,
        workspaceId,
        threadId,
        ...(chat.ensemble?.activeRound?.status === 'running'
          ? { roundId: chat.ensemble.activeRound.roundId }
          : {}),
        text: prompt,
        message: 'Sent from the local TaskWraith TUI.'
      }
      const result = await options.executeEnsembleSteer(action)
      return { dispatched: result.executed, message: result.message }
    }
    const provider = providerForChat(chat)
    const metadata = record(chat.providerMetadata)
    const action: BridgeComposerPromptAction = {
      kind: 'composerPrompt',
      actionId: `tui:${threadId}:${randomUUID()}`,
      issuedAt,
      expiresAt: issuedAt + 2 * 60_000,
      workspaceId,
      threadId,
      text: prompt,
      provider,
      ...(modelForChat(chat) ? { model: modelForChat(chat) } : {}),
      ...(chat.workflowMode ? { workflowMode: chat.workflowMode } : {}),
      ...(nonEmptyString(metadata.approvalMode, chat.settingsSnapshot?.approvalMode)
        ? {
            approvalMode: nonEmptyString(metadata.approvalMode, chat.settingsSnapshot?.approvalMode)
          }
        : {}),
      ...(reasoningForProvider(provider, chat, participantForActiveRound(chat))
        ? { reasoningEffort: reasoningForProvider(provider, chat, participantForActiveRound(chat)) }
        : {})
    }
    const result = await options.executeComposerPrompt(action)
    return { dispatched: result.executed, message: result.message }
  }

  const cancelRun = async (threadId: string) => {
    const chat = AppStore.getChat(threadId)
    if (!chat) throw new Error('Thread not found.')
    const issuedAt = now()
    const workspaceId = chat.scope === 'global' ? 'global' : chat.workspaceId || ''
    if (
      (chat.chatKind === 'ensemble' || chat.ensemble?.enabled) &&
      chat.ensemble?.activeRound?.status === 'running'
    ) {
      const action: BridgeEnsembleCancelRoundAction = {
        kind: 'ensembleCancelRound',
        actionId: `tui-cancel-ensemble:${chat.ensemble.activeRound.roundId}:${randomUUID()}`,
        issuedAt,
        expiresAt: issuedAt + 60_000,
        workspaceId,
        threadId,
        roundId: chat.ensemble.activeRound.roundId,
        message: 'Cancelled from the local TaskWraith TUI.'
      }
      const result = await options.executeEnsembleCancelRound(action)
      return { cancelled: result.executed, message: result.message }
    }
    const run = activeRun(chat)
    if (!run?.runId) return { cancelled: false, message: 'No active run to cancel.' }
    const action: BridgeCancelRunAction = {
      kind: 'cancelRun',
      actionId: `tui-cancel:${run.runId}:${randomUUID()}`,
      issuedAt,
      expiresAt: issuedAt + 60_000,
      workspaceId,
      threadId,
      provider: run.provider || chat.provider || 'gemini',
      runId: run.runId,
      message: 'Cancelled from the local TaskWraith TUI.'
    }
    const result = await options.executeCancelRun(action)
    return { cancelled: result.executed, message: result.message }
  }

  return { snapshot, selectThread, sendPrompt, cancelRun }
}

export async function startTaskWraithLocalControl(
  options: StartTaskWraithLocalControlOptions
): Promise<LocalControlServer> {
  const facade = createTaskWraithControlFacade(options)
  const serverOptions: LocalControlServerOptions = {
    userDataPath: options.userDataPath,
    hostVersion: options.hostVersion,
    facade,
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.log ? { log: options.log } : {})
  }
  const server = new LocalControlServer(serverOptions)
  await server.start()
  return server
}
