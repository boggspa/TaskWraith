/** Projection of HostProfileDomainStore into HostSnapshot donor families. */

import type { HostSnapshotProjectorInput } from './HostSnapshotProjector'
import { HostProfileDomainStore } from './HostProfileDomainStore'
import { basename } from 'node:path'
import {
  createEmptyHostSnapshot,
  decodeHostSnapshot,
  type HostHealthProjection,
  type HostParticipantProjection,
  type HostProviderModelProjection
} from '../shared/hostProtocol'

export type HostProfileDomainSnapshotFamilies = Omit<
  HostSnapshotProjectorInput,
  'position' | 'recovery'
>

/**
 * Build only donor families. Position and recovery remain Host-runtime owned;
 * this profile store never invents a second cursor/generation journal.
 */
export interface HostProfileDomainProjectionOptions {
  readonly store: HostProfileDomainStore
  /** Lifecycle/supervision truth is owned by the standalone composition. */
  readonly health: HostHealthProjection
  /** Current provider inventory/runtime availability; never infer from chats. */
  readonly providers: readonly HostProviderModelProjection[]
}

function safePreview(
  messages: ReturnType<HostProfileDomainStore['listThreads']>[number]['messages']
): string | undefined {
  for (const message of [...messages].reverse()) {
    const terminalSafe = [...message.content].every((character) => {
      const code = character.charCodeAt(0)
      return code === 0x09 || code === 0x0a || code === 0x0d || (code > 0x1f && code !== 0x7f)
    })
    if (
      (message.role === 'user' || message.role === 'assistant' || message.role === 'system') &&
      message.content.length > 0 &&
      terminalSafe
    ) {
      return message.content.slice(0, 2_000)
    }
  }
  return undefined
}

function timestamp(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function providerOutcome(
  status: string | undefined
): 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown' {
  switch (typeof status === 'string' ? status.toLowerCase() : '') {
    case 'starting':
    case 'pending':
    case 'queued':
    case 'awaiting':
    case 'running':
      return 'running'
    case 'success':
    case 'succeeded':
    case 'completed':
      return 'completed'
    case 'failed':
    case 'error':
      return 'failed'
    case 'cancelled':
    case 'canceled':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

type ProfileThread = ReturnType<HostProfileDomainStore['listThreads']>[number]

const PARTICIPANT_VALIDATION_SNAPSHOT = createEmptyHostSnapshot({
  generation: 0,
  cursor: 0
})

function decodeParticipantCandidate(
  thread: ProfileThread,
  value: unknown,
  activeParticipantId: unknown
): HostParticipantProjection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const participant = value as Record<string, unknown>
  const hasModelId = Object.prototype.hasOwnProperty.call(participant, 'modelId')
  const hasModel = Object.prototype.hasOwnProperty.call(participant, 'model')
  const candidate = {
    id: participant.id,
    threadId: thread.appChatId,
    providerId: participant.provider,
    role: participant.role,
    ...(hasModelId
      ? { modelId: participant.modelId }
      : hasModel
        ? { modelId: participant.model }
        : {}),
    ...(Object.prototype.hasOwnProperty.call(participant, 'stageRole')
      ? { stage: participant.stageRole }
      : Object.prototype.hasOwnProperty.call(participant, 'stage')
        ? { stage: participant.stage }
        : {}),
    order: participant.order,
    enabled: participant.enabled,
    ...(Object.prototype.hasOwnProperty.call(participant, 'status')
      ? { status: participant.status }
      : {}),
    active: participant.active === true || participant.id === activeParticipantId
  }
  const decoded = decodeHostSnapshot({
    ...PARTICIPANT_VALIDATION_SNAPSHOT,
    participants: [candidate]
  })
  return decoded.ok ? (decoded.value.participants[0] ?? null) : null
}

function projectThreadParticipants(thread: ProfileThread): HostParticipantProjection[] {
  if (thread.chatKind !== 'ensemble') return []
  const ensemble = thread.ensemble
  if (!ensemble || typeof ensemble !== 'object' || Array.isArray(ensemble)) return []
  const record = ensemble as Record<string, unknown>
  if (!Array.isArray(record.participants)) return []
  const activeRound =
    record.activeRound &&
    typeof record.activeRound === 'object' &&
    !Array.isArray(record.activeRound)
      ? (record.activeRound as Record<string, unknown>)
      : null
  const activeParticipantId = activeRound?.activeParticipantId
  const seen = new Set<string>()
  const out: HostParticipantProjection[] = []

  for (const value of record.participants) {
    const participant = decodeParticipantCandidate(thread, value, activeParticipantId)
    if (!participant || seen.has(participant.id)) continue
    seen.add(participant.id)
    out.push(participant)
  }
  return out
}

export function projectHostProfileDomainSnapshot(
  options: HostProfileDomainProjectionOptions
): HostProfileDomainSnapshotFamilies {
  const { store, health, providers } = options
  const workspaces = store.listWorkspaces().map((workspace) => ({
    id: workspace.id,
    name: (workspace.displayName ?? basename(workspace.path)) || 'Workspace',
    path: workspace.realPath,
    pinned: workspace.pinned,
    updatedAt: workspace.updatedAt
  }))
  const threads = store.listThreads()
  return {
    health,
    workspaces,
    threads: threads.map((thread) => ({
      id: thread.appChatId,
      workspaceId: thread.scope === 'workspace' ? (thread.workspaceId ?? null) : null,
      title: thread.title,
      chatKind: thread.chatKind === 'ensemble' ? 'ensemble' : 'single',
      archived: thread.archived,
      pinned: thread.pinned === true,
      updatedAt: thread.updatedAt,
      messageCount: thread.messages.length,
      ...(safePreview(thread.messages) ? { latestPreview: safePreview(thread.messages) } : {}),
      ...(thread.provider ? { providerId: thread.provider } : {})
    })),
    runs: threads.flatMap((thread) =>
      (thread.runs ?? []).map((run) => ({
        runId: run.runId,
        threadId: thread.appChatId,
        providerId: run.provider ?? thread.provider ?? 'unknown',
        providerOutcome: providerOutcome(run.status),
        ...(timestamp(run.startedAt) !== undefined ? { startedAt: timestamp(run.startedAt) } : {}),
        ...(timestamp(run.endedAt) !== undefined ? { endedAt: timestamp(run.endedAt) } : {}),
        ...(run.requestedModel ? { modelId: run.requestedModel } : {})
      }))
    ),
    missions: [],
    rounds: [],
    participants: threads.flatMap(projectThreadParticipants),
    providers: [...providers],
    questions: [],
    approvals: [],
    schedules: [],
    usage: { availability: 'unavailable', confidence: 'unknown', band: 'unknown' },
    artifacts: [],
    warnings: []
  }
}
