import { basename } from 'node:path'
import { deriveRemoteTaskStatusForChat } from '../RemoteTaskProjection'
import { projectRemoteThread, type RemoteThreadRow } from '../RemoteThreadProjection'
import { collectExternalPathGrantsFromMetadata } from '../store/ExternalPathGrants'
import { messageOriginLabel } from '../../shared/messageOrigin'
import type {
  ChatListItem,
  ChatMessage,
  ChatRecord,
  ChatRun,
  EnsembleParticipant,
  EnsembleRoundParticipantState,
  WorkspaceRecord
} from '../store/types'
import type { ChatInventoryRow } from '../BridgeBroadcaster'
import type {
  TaskWraithControlEnsembleSummary,
  TaskWraithControlParticipant,
  TaskWraithControlProviderPresentation,
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
import {
  clampTaskWraithControlThreadLimit,
  type TaskWraithControlEnsembleFacts,
  type TaskWraithControlGrantFacts,
  type TaskWraithControlRunWindow,
  type TaskWraithControlThreadContextFacts,
  type TaskWraithControlThreadFacts,
  type TaskWraithControlThreadProjection
} from '../../shared/taskWraithControlProjection'

/**
 * TaskWraithControlProjector — the pure projections behind the local TUI.
 *
 * Everything here reads a `ChatRecord` (or a chat-list row) and produces the
 * contract in `src/shared/taskWraithControlProjection.ts`, with no clock, no
 * store and no main-only cache: the thread-catalogue worker runs the same
 * functions over the canonical record, and the facade hydrates the result
 * (wall time, workspace names, ensemble preset name) at read time. The
 * per-record helpers are the facade's original ones, moved verbatim.
 */

/** A chat-list row as the facade sees it: catalogue facts when attached. */
export type TaskWraithControlInventoryRow = ChatInventoryRow & {
  catalogueControl?: TaskWraithControlThreadFacts
  messageCount?: number
  runCount?: number
}

/** The decoder's revision rule: a non-negative safe integer, else 0. */
export function taskWraithControlRevisionOf(chat: Pick<ChatRecord, 'persistenceRevision'>): number {
  const revision = chat.persistenceRevision
  return Number.isSafeInteger(revision) && (revision ?? -1) >= 0 ? (revision as number) : 0
}

/** Facade-side clock for a run window: (endedAt ?? now) - startedAt. */
export function wallTimeFromRunWindow(
  window: TaskWraithControlRunWindow | undefined,
  now: number
): number | undefined {
  if (!window?.startedAt) return undefined
  const start = Date.parse(window.startedAt)
  const end = window.endedAt ? Date.parse(window.endedAt) : now
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined
  return end - start
}

function runWindowForChat(chat: ChatRecord): TaskWraithControlRunWindow | undefined {
  const run = activeRun(chat) ?? latestRun(chat)
  if (!run?.startedAt) return undefined
  return { startedAt: run.startedAt, ...(run.endedAt ? { endedAt: run.endedAt } : {}) }
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function nonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function latestRun(chat: Pick<ChatRecord, 'runs'>): ChatRun | undefined {
  return [...(chat.runs ?? [])].reverse().find((run) => Boolean(run?.runId))
}

export function activeRun(chat: Pick<ChatRecord, 'runs'>): ChatRun | undefined {
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

export function participantForActiveRound(chat: ChatRecord): EnsembleParticipant | undefined {
  const activeId = chat.ensemble?.activeRound?.activeParticipantId
  if (!activeId) return undefined
  return chat.ensemble?.participants.find((participant) => participant.id === activeId)
}

export function modelForChat(chat: ChatRecord | ChatListItem): string | undefined {
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

export function providerForChat(chat: ChatRecord | ChatListItem): string {
  return (
    participantForActiveRound(chat)?.provider ||
    latestRun(chat)?.provider ||
    chat.provider ||
    'gemini'
  )
}

export function reasoningForProvider(
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
    muse: ['museReasoningEffort', 'reasoningEffort'],
    ollama: ['ollamaReasoningEffort', 'reasoningEffort'],
    cursor: ['cursorReasoningEffort', 'reasoningEffort'],
    antigravity: ['geminiReasoningEffort', 'reasoningEffort'],
    gemini: ['geminiReasoningEffort', 'reasoningEffort']
  }
  return nonEmptyString(
    ...(keyByProvider[provider] ?? ['reasoningEffort']).map((key) => metadata[key])
  )
}

function statusForChat(chat: ChatRecord): TaskWraithControlThreadStatus {
  return statusForRemote(deriveRemoteTaskStatusForChat(chat))
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

function ensembleFactsForChat(chat: ChatRecord): TaskWraithControlEnsembleFacts | undefined {
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
  const rawFanout =
    round?.fanoutPolicy ??
    config.fanoutPolicy ??
    (round?.concurrentMode || config.concurrentModeEnabled ? 'all' : 'off')
  // On/Off collapse: legacy graded levels project as On ('all').
  const fanout = rawFanout === 'off' ? 'off' : 'all'
  // The preset NAME lives in main's preset cache; the id travels and the
  // facade resolves it at read time, so a worker can build these facts too.
  const presetId = nonEmptyString(config.activeRosterPresetId)
  // Disabled seats stay in the projection (flagged `enabled: false`, after the
  // enabled speaking order) so the seat lens can re-enable them; run-lane
  // chrome (baton, next-seat math above) keeps filtering to enabled seats.
  const disabledOrdered = [...config.participants]
    .filter((participant) => !participant.enabled)
    .sort((a, b) => a.order - b.order)
  return {
    ...(presetId ? { presetId } : {}),
    mode: 'continuous',
    fanout,
    continuationHops: round?.continuationHops ?? 0,
    maxContinuationHops: round?.maxContinuationHops ?? config.maxContinuationHops ?? 0,
    backgroundCount: ordered.filter((participant) => participant.stageRole === 'background').length,
    participants: [...ordered, ...disabledOrdered].map((participant) =>
      participantPresentation(participant, roundById.get(participant.id), activeId, next?.id)
    )
  }
}

export function threadProvider(
  chat: ChatRecord | ChatListItem
): TaskWraithControlProviderPresentation {
  const provider = providerForChat(chat)
  return resolveTaskWraithProviderPresentation(provider, modelForChat(chat))
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
  if (message.role === 'user') return messageOriginLabel(message.metadata?.origin) ?? 'You'
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

function statusForRemote(
  status: ReturnType<typeof deriveRemoteTaskStatusForChat>
): TaskWraithControlThreadStatus {
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

/** The list facts for one canonical record: what the TUI thread row shows, minus clocks. */
export function projectTaskWraithControlThreadFacts(
  chat: ChatRecord
): TaskWraithControlThreadFacts {
  const provider = threadProvider(chat)
  const participant = participantForActiveRound(chat)
  const reasoning = reasoningForProvider(provider.runtimeProvider, chat, participant)
  const tokenEstimate = tokenEstimateForChat(chat)
  const ensemble = ensembleFactsForChat(chat)
  const runWindow = runWindowForChat(chat)
  return {
    revision: taskWraithControlRevisionOf(chat),
    thread: {
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
      ...(tokenEstimate !== undefined ? { tokenEstimate } : {})
    },
    ...(runWindow ? { runWindow } : {}),
    ...(ensemble ? { ensemble } : {})
  }
}

/**
 * Best-effort facts for a chat-list row that carries no `catalogueControl`
 * (a legacy index row, or a catalogue that predates the field): the row's
 * presentation decides the status, its last run stands in for the run array,
 * and its counts replace the transcript it does not have.
 */
export function taskWraithControlThreadFactsFromInventoryRow(
  row: TaskWraithControlInventoryRow
): TaskWraithControlThreadFacts {
  if (row.catalogueControl) return row.catalogueControl
  const runs = (row.runs ?? []).length > 0 ? row.runs : row.lastRun ? [row.lastRun] : []
  const facts = projectTaskWraithControlThreadFacts({
    ...row,
    runs,
    messages: row.messages ?? []
  } as ChatRecord)
  const presentation = row.cataloguePresentation
  const messageCount =
    row.summaryOnly === true && typeof row.messageCount === 'number'
      ? row.messageCount
      : facts.thread.messageCount
  return {
    ...facts,
    thread: {
      ...facts.thread,
      ...(presentation ? { status: statusForRemote(presentation.status) } : {}),
      messageCount
    }
  }
}

export interface HydrateTaskWraithControlThreadOptions {
  now: number
  /** Resolves an ensemble preset id to its display name (main's preset cache). */
  presetName?: (presetId: string | undefined) => string | undefined
  costText?: string
}

function ensembleSummaryFromFacts(
  facts: TaskWraithControlEnsembleFacts,
  presetName: HydrateTaskWraithControlThreadOptions['presetName']
): TaskWraithControlEnsembleSummary {
  const { presetId, ...rest } = facts
  return { preset: (presetId ? presetName?.(presetId) : undefined) || 'Custom', ...rest }
}

/** The TUI thread row: facts plus the clock and the preset name only the facade holds. */
export function hydrateTaskWraithControlThread(
  facts: TaskWraithControlThreadFacts,
  options: HydrateTaskWraithControlThreadOptions
): TaskWraithControlThread {
  const { tokenEstimate, ...thread } = facts.thread
  const wallTimeMs = wallTimeFromRunWindow(facts.runWindow, options.now)
  const ensemble = facts.ensemble
    ? ensembleSummaryFromFacts(facts.ensemble, options.presetName)
    : undefined
  return {
    ...thread,
    ...(wallTimeMs !== undefined ? { wallTimeMs } : {}),
    ...(tokenEstimate !== undefined ? { tokenEstimate } : {}),
    ...(options.costText ? { costText: options.costText } : {}),
    ...(ensemble ? { ensemble } : {})
  }
}

/** Grants deduplicated by path, write winning, in first-seen order. */
function grantFactsForChat(chat: ChatRecord): TaskWraithControlGrantFacts[] {
  const byPath = new Map<string, 'read' | 'write'>()
  for (const grant of collectExternalPathGrantsFromMetadata(chat.providerMetadata)) {
    const previous = byPath.get(grant.path)
    if (!previous || grant.access === 'write') byPath.set(grant.path, grant.access)
  }
  return [...byPath].map(([path, access]) => ({ path, access }))
}

/**
 * The selected thread's pane at the record's current revision: bounded rows,
 * no clock. Pure — the same inputs (and `generatedAt`) give the same output,
 * whether it runs here or in the catalogue worker.
 */
export function projectTaskWraithControlThread(
  chat: ChatRecord,
  request: { limit: number },
  generatedAt: string = new Date().toISOString()
): TaskWraithControlThreadProjection {
  const projected = projectRemoteThread(chat.messages, chat.runs, {
    threadId: chat.appChatId,
    mode: { kind: 'latestN', n: clampTaskWraithControlThreadLimit(request.limit) },
    // The TUI is a reading surface, not a transcript export. Keep each
    // projected row useful but compact enough that a worst-case page stays
    // inside the bounded local-control frame.
    previewMaxChars: 4_000,
    notes: chat.pinnedNotes,
    blackboardEntries: chat.ensemble?.blackboard,
    generatedAt,
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
  const facts = projectTaskWraithControlThreadFacts(chat)
  const provider = threadProvider(chat)
  const reasoning = reasoningForProvider(
    provider.runtimeProvider,
    chat,
    participantForActiveRound(chat)
  )
  const permission = permissionForChat(chat)
  const tokenEstimate = tokenEstimateForChat(chat)
  const context: TaskWraithControlThreadContextFacts = {
    workspaceId: chat.workspaceId || null,
    workspaceAccess: workspaceAccessForChat(chat),
    grants: grantFactsForChat(chat),
    provider,
    ...(reasoning ? { reasoning } : {}),
    ...(permission ? { permission } : {}),
    ...(tokenEstimate !== undefined ? { tokenEstimate } : {}),
    ...(projected.conversationCostText ? { costText: projected.conversationCostText } : {})
  }
  return {
    threadId: chat.appChatId,
    revision: facts.revision,
    generatedAt: projected.generatedAt,
    facts,
    rows: transcriptRows(chat, projected.rows),
    totalRows: projected.totalRows,
    hasMoreAbove: projected.hasMoreAbove,
    context
  }
}

export interface HydrateTaskWraithControlThreadSnapshotOptions {
  now: number
  sequence: number
  workspaces: WorkspaceRecord[]
  presetName?: HydrateTaskWraithControlThreadOptions['presetName']
}

function workspaceContextFromFacts(
  context: TaskWraithControlThreadContextFacts,
  workspaces: WorkspaceRecord[]
): TaskWraithControlWorkspaceContext[] {
  const primary = context.workspaceId
    ? workspaces.find((workspace) => workspace.id === context.workspaceId)
    : undefined
  const result: TaskWraithControlWorkspaceContext[] = []
  if (primary) {
    result.push({
      id: primary.id,
      name: primary.displayName || basename(primary.path),
      path: primary.path,
      access: context.workspaceAccess,
      primary: true
    })
  }
  for (const grant of context.grants) {
    if (primary?.path === grant.path) continue
    const registered = workspaces.find((workspace) => workspace.path === grant.path)
    result.push({
      id: registered?.id || grant.path,
      name: registered?.displayName || basename(grant.path),
      path: grant.path,
      access: grant.access,
      primary: false
    })
  }
  return result
}

/** The TUI pane: a cached projection plus this moment's clock, names and sequence. */
export function hydrateTaskWraithControlThreadSnapshot(
  projection: TaskWraithControlThreadProjection,
  options: HydrateTaskWraithControlThreadSnapshotOptions
): TaskWraithControlThreadSnapshot {
  const thread = hydrateTaskWraithControlThread(projection.facts, {
    now: options.now,
    presetName: options.presetName,
    costText: projection.context.costText
  })
  const source = projection.context
  const context: TaskWraithControlThreadContext = {
    workspaces: workspaceContextFromFacts(source, options.workspaces),
    provider: source.provider,
    ...(source.reasoning ? { reasoning: source.reasoning } : {}),
    ...(source.permission ? { permission: source.permission } : {}),
    ...(thread.wallTimeMs !== undefined ? { wallTimeMs: thread.wallTimeMs } : {}),
    ...(source.tokenEstimate !== undefined ? { tokenEstimate: source.tokenEstimate } : {}),
    ...(source.costText ? { costText: source.costText } : {}),
    ...(thread.ensemble ? { ensemble: thread.ensemble } : {})
  }
  return {
    generatedAt: projection.generatedAt,
    sequence: options.sequence,
    thread,
    rows: projection.rows,
    totalRows: projection.totalRows,
    hasMoreAbove: projection.hasMoreAbove,
    context
  }
}
