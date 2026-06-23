import { randomUUID } from 'crypto'
import type {
  RunEventFilter,
  RunEventInput,
  RunEventRecord,
  RunEventReplay,
  RunQueueJob,
  RunQueueJobFilter,
  RunQueueJobStatus,
  RunRecoveryFilter,
  RunRecoveryRecord
} from './store/types'
import type { RunQueueJobInput } from './RunQueue'
import type { RunSession } from './RunManager'
import { AppStore } from './store'

export interface RunRepositoryOptions {
  providerLabel: (provider: RunSession['provider']) => string
  emitRunQueueChanged: () => void
  emitRunEventsChanged: (record: {
    runId: string
    chatId?: string
    workspaceId?: string
    sequence: number
  }) => void
}

export interface RunTransitionInput {
  runId: string
  provider: RunQueueJob['provider']
  workspacePath?: string
  chatId?: string
  workspaceId?: string
  scope?: RunQueueJob['scope']
  source?: RunQueueJob['source']
  promptPreview?: string
  statusReason?: string
  lastError?: string
}

export interface RunQueueLeaseRequest {
  runId?: string
  provider?: RunQueueJob['provider']
  statusReason?: string
}

export class RunRepository {
  constructor(private readonly options: RunRepositoryOptions) {}

  persistSessionQueueState(session: RunSession | undefined): void {
    if (!session) return
    const status = this.mapRunSessionStatusToQueueStatus(session.status)
    const existing = AppStore.getRunQueueJob(session.runId)
    const processLike = session.process as unknown as
      | {
          pid?: unknown
          spawnfile?: unknown
          spawnargs?: unknown
        }
      | undefined
    const processPid = typeof processLike?.pid === 'number' ? processLike.pid : undefined
    const processCommand = Array.isArray(processLike?.spawnargs)
      ? processLike.spawnargs.filter((part): part is string => typeof part === 'string').join(' ')
      : typeof processLike?.spawnfile === 'string'
        ? processLike.spawnfile
        : undefined
    const partial: Partial<RunQueueJob> = {
      provider: session.provider,
      chatId: session.appChatId,
      workspacePath: session.workspacePath || existing?.workspacePath,
      providerSessionId: session.providerSessionId,
      providerRunId: session.providerRunId,
      processPid,
      processCommand,
      processStartedAt: processPid
        ? existing?.processStartedAt || new Date(session.startedAt).toISOString()
        : undefined,
      status
    }

    if (existing) {
      AppStore.updateRunQueueJob(session.runId, partial)
    } else {
      AppStore.saveRunQueueJob({
        id: session.runId,
        runId: session.runId,
        provider: session.provider,
        chatId: session.appChatId,
        workspacePath: partial.workspacePath,
        scope: partial.workspacePath ? 'workspace' : 'global',
        source: 'system',
        status,
        promptPreview: `${this.options.providerLabel(session.provider)} run`
      })
    }
    this.options.emitRunQueueChanged()
  }

  appendRunEvent(input: RunEventInput): RunEventRecord | null {
    try {
      const record = AppStore.appendRunEvent(input)
      this.options.emitRunEventsChanged(record)
      return record
    } catch (error) {
      console.error('Failed to append run event', error)
      return null
    }
  }

  appendRunEvents(inputs: RunEventInput[]): RunEventRecord[] {
    return inputs
      .map((input) => this.appendRunEvent(input))
      .filter((record): record is RunEventRecord => Boolean(record))
  }

  getRunEvents(filter: RunEventFilter = {}): RunEventRecord[] {
    return AppStore.getRunEvents(filter)
  }

  /** Async read used by the renderer's get-run-events IPC so a whole-dir read
   * can't block the main event loop. */
  getRunEventsAsync(filter: RunEventFilter = {}): Promise<RunEventRecord[]> {
    return AppStore.getRunEventsAsync(filter)
  }

  eventsForRunSinceSequence(runId: string, sequence: number): RunEventRecord[] {
    const fromSequence = Number.isFinite(sequence) ? Math.max(1, Math.floor(sequence) + 1) : 1
    return this.getRunEvents({ runId, fromSequence })
  }

  getRunEventReplay(runId: string): RunEventReplay {
    return AppStore.getRunEventReplay(runId)
  }

  getRunQueueJobs(filter: RunQueueJobFilter = {}): RunQueueJob[] {
    return AppStore.getRunQueueJobs(filter)
  }

  saveRunQueueJob(input: RunQueueJobInput): RunQueueJob {
    const saved = AppStore.saveRunQueueJob(input)
    this.options.emitRunQueueChanged()
    return saved
  }

  leaseQueuedRun(input: RunQueueLeaseRequest = {}): RunQueueJob | null {
    const candidate = input.runId
      ? AppStore.getRunQueueJob(input.runId)
      : AppStore.getRunQueueJobs({
          provider: input.provider,
          statuses: ['queued']
        })[0]
    if (!candidate || candidate.status !== 'queued') {
      return null
    }
    if (input.provider && candidate.provider !== input.provider) {
      return null
    }
    return this.updateRunQueueJob(candidate.runId, {
      status: 'starting',
      statusReason: input.statusReason || 'Leased by main scheduler.'
    })
  }

  transitionRunQueueJob(
    runIdOrId: string,
    status: RunQueueJobStatus,
    partial: Pick<Partial<RunQueueJob>, 'statusReason' | 'lastError'> = {}
  ): RunQueueJob | null {
    return this.updateRunQueueJob(runIdOrId, {
      status,
      statusReason: partial.statusReason,
      lastError: partial.lastError
    })
  }

  transition(input: RunTransitionInput, status: RunQueueJobStatus): RunQueueJob {
    return this.saveRunQueueJob({
      id: input.runId,
      runId: input.runId,
      provider: input.provider,
      scope: input.scope,
      workspacePath: input.workspacePath,
      chatId: input.chatId,
      workspaceId: input.workspaceId,
      source: input.source || 'system',
      promptPreview: input.promptPreview || `${this.options.providerLabel(input.provider)} run`,
      status,
      statusReason: input.statusReason,
      lastError: input.lastError
    })
  }

  markQueued(input: RunTransitionInput): RunQueueJob {
    return this.transition(input, 'queued')
  }

  markStarting(input: RunTransitionInput): RunQueueJob {
    return this.transition(input, 'starting')
  }

  markRunning(input: RunTransitionInput): RunQueueJob {
    return this.transition(input, 'active')
  }

  markCompleted(input: RunTransitionInput): RunQueueJob {
    return this.transition(input, 'completed')
  }

  markFailed(input: RunTransitionInput): RunQueueJob {
    return this.transition(input, 'failed')
  }

  markCancelled(input: RunTransitionInput): RunQueueJob {
    return this.transition(input, 'cancelled')
  }

  markRecovered(input: Omit<RunTransitionInput, 'runId'> & { runId?: string }): RunQueueJob {
    return this.transition(
      {
        ...input,
        runId: input.runId || randomUUID(),
        statusReason: input.statusReason || 'Recovered run state after app restart.'
      },
      'failed'
    )
  }

  updateRunQueueJob(runIdOrId: string, partial: Partial<RunQueueJob>): RunQueueJob | null {
    const updated = AppStore.updateRunQueueJob(runIdOrId, partial)
    this.options.emitRunQueueChanged()
    return updated
  }

  deleteRunQueueJob(runIdOrId: string): void {
    AppStore.deleteRunQueueJob(runIdOrId)
    this.options.emitRunQueueChanged()
  }

  getRunRecoveryRecords(filter: RunRecoveryFilter = {}): RunRecoveryRecord[] {
    return AppStore.getRunRecoveryRecords(filter)
  }

  appendLifecycleEvent(
    eventType: 'created' | 'updated' | 'removed',
    session: RunSession
  ): RunEventRecord | null {
    return this.appendRunEvent({
      runId: session.runId,
      chatId: session.appChatId,
      provider: session.provider,
      providerSessionId: session.providerSessionId,
      providerRunId: session.providerRunId,
      workspacePath: session.workspacePath,
      kind: 'lifecycle',
      phase: 'control',
      source: 'main',
      summary: `Runtime session ${eventType}: ${session.status}`,
      payload: {
        eventType,
        status: session.status,
        startedAt: session.startedAt,
        updatedAt: session.updatedAt,
        hasProcess: Boolean(session.process),
        hasAbortController: Boolean(session.abortController),
        approvalIds: [...session.approvalIds]
      }
    })
  }

  private mapRunSessionStatusToQueueStatus(status: string): RunQueueJobStatus {
    if (status === 'completed') return 'completed'
    if (status === 'failed') return 'failed'
    if (status === 'cancelled') return 'cancelled'
    if (status === 'starting') return 'starting'
    return 'active'
  }
}
