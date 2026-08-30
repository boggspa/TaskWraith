/**
 * Wave 4.2a — map HostSnapshot onto the existing TUI render model.
 *
 * Host protocol projections are compact and family-separated. The TUI render
 * path still consumes TaskWraithControl* shapes. This module is the only
 * translation layer for the read-only cutover:
 *
 * - workspaces map 1:1
 * - threads get provider presentation from the Host providers family (or the
 *   shared presentation helper when Host only carries providerId)
 * - thread status is derived from Host runs / missionOutcome / active round —
 *   never invented as "working" without evidence
 * - ensemble roster is joined from Host rounds + participants when present
 * - transcript bodies are NOT on HostSnapshot; thread detail exposes at most
 *   the bounded `latestPreview` as a single truncated row
 *
 * Unavailable usage stays unavailable (never coerced to token/cost zero).
 * Command cutover is Wave 4.2b — this file never submits Host commands.
 */

import {
  createEmptyHostSnapshot,
  type HostParticipantProjection,
  type HostProviderModelProjection,
  type HostRoundProjection,
  type HostRunProjection,
  type HostSnapshot,
  type HostThreadProjection,
  type HostUsageObservation,
  type HostWorkspaceProjection
} from '../shared/hostProtocol'
import type {
  TaskWraithControlEnsembleSummary,
  TaskWraithControlParticipant,
  TaskWraithControlProviderPresentation,
  TaskWraithControlSnapshot,
  TaskWraithControlThread,
  TaskWraithControlThreadSnapshot,
  TaskWraithControlThreadStatus,
  TaskWraithControlTranscriptRow,
  TaskWraithControlWorkspace
} from '../shared/taskWraithControlProtocol'
import type { HostTranscriptHistoryEntry } from '../shared/hostHistoryProtocol'
import { resolveTaskWraithProviderPresentation } from '../shared/taskWraithProviderPresentation'

/** Explicit marker so UIs can say "preview only" rather than "full transcript". */
export const HOST_TUI_PREVIEW_ROW_KIND = 'host-preview'

/** Maps bounded Host history entries to existing renderer-independent transcript rows. */
export function mapHostHistoryEntriesToTranscriptRows(
  entries: readonly HostTranscriptHistoryEntry[],
  thread?: TaskWraithControlThread
): TaskWraithControlTranscriptRow[] {
  const provider = thread?.provider
  const model = provider?.modelLabel ?? provider?.model
  return entries.map((entry) => ({
    id: `host-history:${entry.entryId}`,
    role: entry.role,
    kind: 'host-history',
    speaker:
      entry.label || (entry.role === 'user' ? 'You' : (provider?.displayProvider ?? 'TaskWraith')),
    ...(entry.role === 'assistant' && provider ? { provider } : {}),
    ...(entry.role === 'assistant' && model ? { model } : {}),
    ...(entry.role === 'assistant' && thread?.reasoning ? { reasoning: thread.reasoning } : {}),
    text: entry.text,
    timestamp: new Date(entry.createdAt).toISOString(),
    truncated: false,
    ...(entry.tools?.length
      ? {
          tools: entry.tools.map((tool) => ({
            name: tool.name,
            category: tool.category,
            status: tool.status,
            ...(tool.file ? { file: tool.file } : {}),
            ...(tool.additions !== undefined ? { additions: tool.additions } : {}),
            ...(tool.deletions !== undefined ? { deletions: tool.deletions } : {}),
            ...(tool.diff ? { diff: tool.diff } : {}),
            ...(tool.command ? { command: tool.command } : {})
          }))
        }
      : {})
  }))
}

export interface HostTuiThreadDetail {
  /** Control-shaped thread detail for the existing renderer. */
  thread: TaskWraithControlThreadSnapshot
  /**
   * True when the detail was built from Host list fields only (no transcript
   * family). Full history remains a later Host surface / 4.2b concern.
   */
  previewOnly: boolean
}

function mapWorkspace(workspace: HostWorkspaceProjection): TaskWraithControlWorkspace {
  return {
    id: workspace.id,
    name: workspace.name,
    path: workspace.path,
    pinned: workspace.pinned,
    updatedAt: workspace.updatedAt
  }
}

function providerPresentation(
  providers: readonly HostProviderModelProjection[],
  providerId: string | undefined,
  modelId?: string | undefined
): TaskWraithControlProviderPresentation {
  const match = providerId
    ? providers.find((provider) => provider.providerId === providerId)
    : undefined
  if (match) {
    const projectedLabel = !modelId || modelId === match.modelId ? match.modelLabel : undefined
    const base = resolveTaskWraithProviderPresentation(
      match.providerId,
      modelId ?? match.modelId,
      projectedLabel
    )
    return {
      ...base,
      displayProvider: match.displayProvider || base.displayProvider,
      shortCode: match.shortCode || base.shortCode,
      ...(match.hueKey ? { hueKey: match.hueKey } : {}),
      ...(match.modelId || modelId
        ? { model: modelId ?? match.modelId }
        : base.model
          ? { model: base.model }
          : {}),
      ...(projectedLabel || base.modelLabel
        ? { modelLabel: projectedLabel ?? base.modelLabel }
        : {})
    }
  }
  return resolveTaskWraithProviderPresentation(providerId, modelId)
}

function usageCostText(usage: HostUsageObservation | undefined): string | undefined {
  if (!usage || usage.availability === 'unavailable') return undefined
  if (typeof usage.costText === 'string' && usage.costText.trim()) return usage.costText
  return undefined
}

function usageTokenEstimate(usage: HostUsageObservation | undefined): number | undefined {
  if (!usage || usage.availability === 'unavailable') return undefined
  if (typeof usage.tokens === 'number' && Number.isFinite(usage.tokens)) return usage.tokens
  return undefined
}

function latestRunUsage(
  snapshot: HostSnapshot,
  threadId: string
): HostUsageObservation | undefined {
  let latest: { at: number; usage: HostUsageObservation } | undefined
  for (const run of snapshot.runs) {
    if (run.threadId !== threadId || !run.usage) continue
    const at = run.endedAt ?? run.startedAt ?? 0
    if (!latest || at >= latest.at) latest = { at, usage: run.usage }
  }
  return latest?.usage
}

function threadStatusFromHost(
  thread: HostThreadProjection,
  runs: readonly HostRunProjection[],
  rounds: readonly HostRoundProjection[]
): TaskWraithControlThreadStatus {
  const threadRuns = runs.filter((run) => run.threadId === thread.id)
  if (threadRuns.some((run) => run.providerOutcome === 'running')) return 'working'
  if (threadRuns.some((run) => run.providerOutcome === 'requires_action')) return 'needs-input'
  if (threadRuns.some((run) => run.providerOutcome === 'failed')) return 'failed'
  if (threadRuns.some((run) => run.providerOutcome === 'cancelled')) return 'cancelled'
  if (threadRuns.some((run) => run.providerOutcome === 'completed')) return 'complete'

  if (thread.missionOutcome === 'active' || thread.missionOutcome === 'blocked') return 'working'
  if (thread.missionOutcome === 'failed') return 'failed'
  if (thread.missionOutcome === 'cancelled') return 'cancelled'
  if (thread.missionOutcome === 'completed') return 'complete'

  const round =
    (thread.activeRoundId
      ? rounds.find((candidate) => candidate.roundId === thread.activeRoundId)
      : undefined) ?? rounds.find((candidate) => candidate.threadId === thread.id)
  if (round?.status === 'running') return 'working'
  if (round?.status === 'failed') return 'failed'
  if (round?.status === 'cancelled') return 'cancelled'
  if (round?.status === 'completed') return 'complete'

  return 'idle'
}

function mapParticipant(
  participant: HostParticipantProjection,
  providers: readonly HostProviderModelProjection[],
  activeId: string | undefined,
  nextId: string | undefined
): TaskWraithControlParticipant {
  const presentation = providerPresentation(providers, participant.providerId, participant.modelId)
  return {
    id: participant.id,
    provider: presentation.runtimeProvider,
    displayProvider: presentation.displayProvider,
    hueKey: presentation.hueKey,
    accent: presentation.accent,
    shortCode: presentation.shortCode,
    role: participant.role,
    ...(presentation.modelLabel || presentation.model
      ? { model: presentation.modelLabel ?? presentation.model }
      : {}),
    order: participant.order,
    ...(participant.stage && participant.stage !== 'any' ? { stage: participant.stage } : {}),
    ...(participant.status ? { status: participant.status } : {}),
    active: participant.active || participant.id === activeId,
    next: participant.id === nextId,
    enabled: participant.enabled
  }
}

function mapEnsemble(
  thread: HostThreadProjection,
  snapshot: HostSnapshot
): TaskWraithControlEnsembleSummary | undefined {
  if (thread.chatKind !== 'ensemble') return undefined
  const round =
    (thread.activeRoundId
      ? snapshot.rounds.find((candidate) => candidate.roundId === thread.activeRoundId)
      : undefined) ?? snapshot.rounds.find((candidate) => candidate.threadId === thread.id)
  if (!round) return undefined

  const routing = round.routing ?? snapshot.routing
  const participantIds =
    round.participantIds.length > 0
      ? round.participantIds
      : (round.waves ?? []).flatMap((wave) => wave.participantIds)
  const threadParticipants = snapshot.participants.filter(
    (participant) => participant.threadId === thread.id
  )
  const byId = new Map(threadParticipants.map((participant) => [participant.id, participant]))
  const ordered = participantIds
    .map((id) => byId.get(id))
    .filter((participant): participant is HostParticipantProjection => Boolean(participant))
  const roster =
    ordered.length > 0
      ? ordered
      : threadParticipants.filter((participant) => participant.enabled).slice()

  if (roster.length === 0) return undefined

  const activeId = routing?.activeParticipantId
  const nextCandidate = roster.find((participant) => !participant.active && participant.enabled)
  const nextId = nextCandidate?.id
  const participants = roster
    .slice()
    .sort((left, right) => left.order - right.order)
    .map((participant) => mapParticipant(participant, snapshot.providers, activeId, nextId))

  return {
    preset: 'Ensemble',
    mode: routing?.mode ?? 'turn_bound',
    fanout: routing?.fanout ?? 'off',
    continuationHops: routing?.continuationHops ?? 0,
    maxContinuationHops: routing?.maxContinuationHops ?? 0,
    backgroundCount: participants.filter((participant) => participant.stage === 'background')
      .length,
    participants
  }
}

function mapThread(thread: HostThreadProjection, snapshot: HostSnapshot): TaskWraithControlThread {
  const provider = providerPresentation(snapshot.providers, thread.providerId, thread.modelId)
  const status = threadStatusFromHost(thread, snapshot.runs, snapshot.rounds)
  const ensemble = mapEnsemble(thread, snapshot)
  const usage = thread.usage ?? latestRunUsage(snapshot, thread.id)
  const tokenEstimate = usageTokenEstimate(usage)
  const costText = usageCostText(thread.usage)
  return {
    id: thread.id,
    workspaceId: thread.workspaceId,
    ...(thread.parentThreadId ? { parentThreadId: thread.parentThreadId } : {}),
    title: thread.title,
    provider,
    status,
    chatKind: thread.chatKind,
    archived: thread.archived,
    pinned: thread.pinned,
    updatedAt: thread.updatedAt,
    messageCount: thread.messageCount,
    ...(tokenEstimate !== undefined ? { tokenEstimate } : {}),
    ...(costText ? { costText } : {}),
    ...(thread.reasoningEffort ? { reasoning: thread.reasoningEffort } : {}),
    ...(ensemble ? { ensemble } : {})
  }
}

/**
 * Map a HostSnapshot onto the TUI list snapshot shape.
 * Sequence uses Host cursor (stable ordering authority), not a fabricated counter.
 */
export function mapHostSnapshotToControlSnapshot(
  snapshot: HostSnapshot
): TaskWraithControlSnapshot {
  return {
    generatedAt: snapshot.generatedAt,
    sequence: snapshot.cursor,
    workspaces: snapshot.workspaces.map(mapWorkspace),
    threads: snapshot.threads.map((thread) => mapThread(thread, snapshot))
  }
}

/**
 * Build a read-only thread detail from Host list fields only.
 * Returns null when the thread id is absent from the snapshot.
 */
export function mapHostSnapshotToThreadDetail(
  snapshot: HostSnapshot,
  threadId: string
): HostTuiThreadDetail | null {
  const hostThread = snapshot.threads.find((thread) => thread.id === threadId)
  if (!hostThread) return null

  const thread = mapThread(hostThread, snapshot)
  const rows: TaskWraithControlTranscriptRow[] = []
  const preview = hostThread.latestPreview?.trim()
  if (preview) {
    rows.push({
      id: `host-preview:${thread.id}`,
      role: 'assistant',
      kind: HOST_TUI_PREVIEW_ROW_KIND,
      speaker: thread.provider.displayProvider,
      provider: thread.provider,
      ...(thread.provider.modelLabel || thread.provider.model
        ? { model: thread.provider.modelLabel ?? thread.provider.model }
        : {}),
      ...(thread.reasoning ? { reasoning: thread.reasoning } : {}),
      text: preview,
      timestamp: snapshot.generatedAt,
      truncated: Boolean(hostThread.previewTruncated)
    })
  }

  const workspaces = snapshot.workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    path: workspace.path,
    access: 'read' as const,
    primary: workspace.id === hostThread.workspaceId
  }))

  return {
    previewOnly: true,
    thread: {
      generatedAt: snapshot.generatedAt,
      sequence: snapshot.cursor,
      thread,
      rows,
      totalRows: rows.length,
      hasMoreAbove: Boolean(hostThread.messageCount > rows.length),
      context: {
        workspaces:
          workspaces.length > 0
            ? workspaces
            : hostThread.workspaceId
              ? [
                  {
                    id: hostThread.workspaceId,
                    name: hostThread.workspaceId,
                    path: '',
                    access: 'read',
                    primary: true
                  }
                ]
              : [],
        provider: thread.provider,
        ...(thread.reasoning ? { reasoning: thread.reasoning } : {}),
        ...(hostThread.permissionPresetId ? { permission: hostThread.permissionPresetId } : {}),
        ...(thread.ensemble ? { ensemble: thread.ensemble } : {}),
        ...(thread.tokenEstimate !== undefined ? { tokenEstimate: thread.tokenEstimate } : {}),
        ...(thread.costText ? { costText: thread.costText } : {})
      }
    }
  }
}

/** Test / demo helper — empty Host families with live freshness. */
export function emptyHostSnapshotForTests(
  overrides?: Partial<HostSnapshot> & { generation?: number; cursor?: number }
): HostSnapshot {
  const base = createEmptyHostSnapshot({
    generation: overrides?.generation ?? 1,
    cursor: overrides?.cursor ?? 1,
    freshness: 'live',
    generatedAt: overrides?.generatedAt
  })
  return { ...base, ...overrides, usage: overrides?.usage ?? base.usage }
}
