import { lstatSync, realpathSync, statSync } from 'node:fs'

import type {
  HostProfileDomainStore,
  HostProfileThread
} from '../host-runtime/HostProfileDomainStore'
import {
  normalizeHostProviderRunBegin,
  normalizeHostProviderRunEvent,
  normalizeHostProviderRunFinish,
  normalizeHostProviderRunThread,
  normalizeHostProviderRunTranscriptAppend,
  normalizeHostProviderRunUpdate,
  type HostProviderRunBegin,
  type HostProviderRunCancelRegistrationResult,
  type HostProviderRunEvent,
  type HostProviderRunFinish,
  type HostProviderRunPort,
  type HostProviderRunThread,
  type HostProviderRunTranscriptAppend,
  type HostProviderRunUpdate
} from '../host-runtime/HostProviderRunPort'
import type { HostRunEventTarget } from '../host-runtime/HostRunEventTarget'
import { isLiveSelectableProvider } from '../shared/retiredProviders'

export interface HostNodeRunEventSink {
  publish(target: HostRunEventTarget, event: HostProviderRunEvent): void
}

export interface HostNodeProfileRunPortOptions {
  readonly store: HostProfileDomainStore
  readonly events: HostNodeRunEventSink
}

type ActiveRun = {
  readonly threadId: string
  phase: HostProviderRunUpdate['phase']
  terminal?: HostProviderRunFinish['status']
  cancel?: () => void
  cancelInvoked: boolean
}

function isCanonicalId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    // eslint-disable-next-line no-control-regex -- store-derived IDs reject C0 controls.
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function providerMetadata(thread: HostProfileThread): Record<string, unknown> | null {
  return thread.providerMetadata && typeof thread.providerMetadata === 'object'
    ? thread.providerMetadata
    : null
}

function postureFromThread(thread: HostProfileThread) {
  const metadata = providerMetadata(thread)
  const preset = metadata?.permissionPresetId
  const approvalMode = metadata?.approvalMode
  const explicitConsentAcknowledged = metadata?.explicitConsentAcknowledged === true
  if (preset === 'workspace_write' && approvalMode === 'default') {
    return {
      postureId: 'workspace_write',
      approvalMode,
      requiresExplicitConsent: true,
      explicitConsentAcknowledged
    } as const
  }
  if (preset === 'default' && approvalMode === 'default') {
    return {
      postureId: 'default',
      approvalMode,
      requiresExplicitConsent: false,
      explicitConsentAcknowledged: false
    } as const
  }
  if (preset === 'read_only' && approvalMode === 'plan') {
    return {
      postureId: thread.workflowMode === 'plan' ? 'plan' : 'read_only',
      approvalMode,
      requiresExplicitConsent: false,
      explicitConsentAcknowledged: false
    } as const
  }
  return null
}

function phaseRank(phase: HostProviderRunUpdate['phase']): number {
  switch (phase) {
    case 'starting':
      return 0
    case 'streaming':
      return 1
    case 'cancelling':
      return 2
  }
}

/**
 * Maps a canonical, configured workspace thread for any live-selectable
 * provider onto the provider run port. Global threads, stale paths, archived
 * threads, and incomplete provider metadata fail closed as absent.
 */
export class HostNodeProfileRunPort implements HostProviderRunPort {
  private readonly active = new Map<string, ActiveRun>()

  constructor(private readonly options: HostNodeProfileRunPortOptions) {}

  getThread(threadId: string): HostProviderRunThread | null {
    if (!isCanonicalId(threadId)) return null
    const thread = this.options.store.getThread(threadId)
    if (
      !thread ||
      thread.archived ||
      thread.scope !== 'workspace' ||
      !isLiveSelectableProvider(thread.provider) ||
      !isCanonicalId(thread.workspaceId) ||
      typeof thread.workspacePath !== 'string'
    ) {
      return null
    }
    const workspace = this.options.store
      .listWorkspaces()
      .find(
        (candidate) =>
          candidate.id === thread.workspaceId &&
          (candidate.realPath === thread.workspacePath || candidate.path === thread.workspacePath)
      )
    const metadata = providerMetadata(thread)
    const modelId = metadata?.selectedModelType
    const reasoningId = metadata?.reasoningEffort
    const posture = postureFromThread(thread)
    const persistedSessionId = [...(thread.runs ?? [])]
      .reverse()
      .map((run) => run.providerSessionId)
      .find(isCanonicalId)
    const legacySessionId = (thread as Record<string, unknown>).linkedProviderSessionId
    const canonicalWorkspacePath = workspace
      ? this.verifyWorkspacePath(workspace.path, workspace.realPath)
      : null
    if (!workspace || !canonicalWorkspacePath || !isCanonicalId(modelId) || !posture) return null
    const candidate: HostProviderRunThread = {
      threadId: thread.appChatId,
      workspace: {
        workspaceId: workspace.id,
        canonicalPath: canonicalWorkspacePath,
        canonical: true
      },
      providerId: thread.provider,
      modelId,
      ...(isCanonicalId(reasoningId) ? { reasoningId } : {}),
      ...(isCanonicalId(persistedSessionId)
        ? { providerSessionId: persistedSessionId }
        : isCanonicalId(legacySessionId)
          ? { providerSessionId: legacySessionId }
          : {}),
      posture
    }
    return normalizeHostProviderRunThread(candidate)
  }

  appendTranscript(input: HostProviderRunTranscriptAppend): void {
    const normalized = normalizeHostProviderRunTranscriptAppend(input)
    if (!normalized) throw new Error('Host profile transcript append is invalid')
    this.options.store.appendTranscript({
      threadId: normalized.threadId,
      runId: normalized.runId,
      role: normalized.role,
      content: normalized.text,
      timestamp: normalized.createdAt
    })
  }

  beginRun(input: HostProviderRunBegin) {
    const normalized = normalizeHostProviderRunBegin(input)
    if (!normalized) {
      throw new Error('Host profile run begin is invalid')
    }
    if (this.active.has(normalized.runId)) return { kind: 'duplicate' as const }
    const thread = this.options.store.getThread(normalized.threadId)
    if (!thread) throw new Error('Host profile run thread is unavailable')
    if (!isLiveSelectableProvider(thread.provider) || normalized.providerId !== thread.provider) {
      throw new Error('Host profile run provider does not match thread')
    }
    if ((thread.runs ?? []).some((run) => run.status === 'running')) {
      throw new Error('Host profile thread already has an active run')
    }
    if (
      this.options.store
        .listThreadSummaries()
        .some((candidate) => (candidate.runs ?? []).some((run) => run.runId === normalized.runId))
    ) {
      return { kind: 'duplicate' as const }
    }
    this.options.store.updateRun({
      threadId: normalized.threadId,
      runId: normalized.runId,
      status: 'running',
      provider: thread.provider,
      requestedModel: normalized.modelId,
      phase: 'starting',
      startedAt: normalized.startedAt
    })
    this.active.set(normalized.runId, {
      threadId: normalized.threadId,
      phase: 'starting',
      cancelInvoked: false
    })
    return { kind: 'started' as const }
  }

  updateRun(input: HostProviderRunUpdate): void {
    const normalized = normalizeHostProviderRunUpdate(input)
    if (!normalized) throw new Error('Host profile run update is invalid')
    const active = this.active.get(normalized.runId)
    if (!active || active.terminal) throw new Error('Host profile run is not active')
    if (phaseRank(normalized.phase) < phaseRank(active.phase)) {
      throw new Error('Host profile run phase cannot move backwards')
    }
    if (normalized.phase === active.phase) return
    this.options.store.updateRun({
      threadId: active.threadId,
      runId: normalized.runId,
      status: 'running',
      phase: normalized.phase
    })
    active.phase = normalized.phase
  }

  finishRun(input: HostProviderRunFinish): void {
    const normalized = normalizeHostProviderRunFinish(input)
    if (!normalized) throw new Error('Host profile run finish is invalid')
    const active = this.active.get(normalized.runId)
    if (!active) {
      const threadId = this.threadIdForStoredRun(normalized.runId)
      if (!threadId) throw new Error('Host profile run is unavailable')
      this.writeFinish(threadId, normalized)
      return
    }
    if (active.terminal) {
      this.writeFinish(active.threadId, normalized)
      return
    }
    this.writeFinish(active.threadId, normalized)
    active.terminal = normalized.status
  }

  registerCancel(runId: string, cancel: () => void): HostProviderRunCancelRegistrationResult {
    if (!isCanonicalId(runId) || typeof cancel !== 'function') {
      throw new Error('Host profile cancel registration is invalid')
    }
    const active = this.active.get(runId)
    if (!active || active.terminal || active.cancel) return { kind: 'duplicate' }
    active.cancel = cancel
    return { kind: 'registered' }
  }

  clearCancel(runId: string): void {
    if (!isCanonicalId(runId)) throw new Error('Host profile cancel clear is invalid')
    this.active.delete(runId)
  }

  publishRunEvent(target: HostRunEventTarget, event: HostProviderRunEvent): void {
    const normalized = normalizeHostProviderRunEvent(event)
    if (!normalized) throw new Error('Host profile run event is invalid')
    this.options.events.publish(target, normalized)
  }

  /** Exact thread-scoped cancellation for Host `run.cancel`; never target-lifetime driven. */
  cancelThread(threadId: string): 'cancelled' | 'not_found' | 'not_cancellable' {
    if (!isCanonicalId(threadId)) return 'not_found'
    const entry = [...this.active.entries()].find(
      ([, active]) => active.threadId === threadId && !active.terminal
    )
    if (!entry) return 'not_found'
    const [, active] = entry
    if (!active.cancel || active.cancelInvoked) return 'not_cancellable'
    active.cancelInvoked = true
    active.cancel()
    return 'cancelled'
  }

  /** Cancels every registered active run at most once during Host shutdown. */
  cancelAll(): number {
    let cancelled = 0
    for (const active of this.active.values()) {
      if (active.terminal || !active.cancel || active.cancelInvoked) continue
      active.cancelInvoked = true
      active.cancel()
      cancelled += 1
    }
    return cancelled
  }

  hasBegun(runId: string, threadId: string): boolean {
    const active = this.active.get(runId)
    return Boolean(active && active.threadId === threadId)
  }

  private threadIdForStoredRun(runId: string): string | null {
    for (const thread of this.options.store.listThreadSummaries()) {
      if ((thread.runs ?? []).some((run) => run.runId === runId)) return thread.appChatId
    }
    return null
  }

  private writeFinish(threadId: string, input: HostProviderRunFinish): void {
    this.options.store.updateRun({
      threadId,
      runId: input.runId,
      status: input.status,
      endedAt: input.finishedAt,
      ...(input.providerSessionId ? { providerSessionId: input.providerSessionId } : {}),
      ...(input.usage ? { usage: input.usage } : {}),
      warningSummaries: input.warningSummaries,
      ...(input.errorCode ? { errorCode: input.errorCode } : {})
    })
  }

  private verifyWorkspacePath(path: string, expectedRealPath: string): string | null {
    try {
      const direct = lstatSync(path)
      if (!direct.isDirectory() || direct.isSymbolicLink()) return null
      const canonical = realpathSync(path)
      const canonicalEntry = lstatSync(canonical)
      const stat = statSync(canonical)
      if (
        !canonicalEntry.isDirectory() ||
        canonicalEntry.isSymbolicLink() ||
        !stat.isDirectory() ||
        canonical !== expectedRealPath
      ) {
        return null
      }
      return canonical
    } catch {
      return null
    }
  }
}
