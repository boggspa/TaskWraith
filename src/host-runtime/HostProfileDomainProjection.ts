/** Projection of HostProfileDomainStore into HostSnapshot donor families. */

import type { HostSnapshotProjectorInput } from './HostSnapshotProjector'
import { HostProfileDomainStore } from './HostProfileDomainStore'
import { basename } from 'node:path'
import type { HostHealthProjection, HostProviderModelProjection } from '../shared/hostProtocol'

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
      chatKind: 'single',
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
    participants: [],
    providers: [...providers],
    questions: [],
    approvals: [],
    schedules: [],
    usage: { availability: 'unavailable', confidence: 'unknown', band: 'unknown' },
    artifacts: [],
    warnings: []
  }
}
