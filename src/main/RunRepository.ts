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

type SteerQueueMetadata = {
  promotionOwnerToken?: string
  promotionToken?: string
  promotionAttempt?: number
  transitionVersion?: number
  promotedAt?: string
  queueMessageId?: string
}

type RunQueueJobStatusLike = RunQueueJob['status'] | 'steer_promoting'

type RunQueueJobWithSteerMetadata = RunQueueJob & SteerQueueMetadata

const STEER_PROMOTING_STATUS: RunQueueJobStatusLike = 'steer_promoting'

function lookupEnsembleQueueMetadata(
  session: RunSession
): Pick<RunQueueJob, 'ensembleParticipantId' | 'ensembleLaneId' | 'ensembleRole' | 'ensembleStageRole'> {
  const chatId = typeof session.appChatId === 'string' ? session.appChatId.trim() : ''
  const runId = typeof session.runId === 'string' ? session.runId.trim() : ''
  if (!chatId || !runId) return {}
  const matchedRun = AppStore.getChat(chatId)?.runs?.find((run) => run.runId === runId)
  if (!matchedRun) return {}
  return {
    ...(matchedRun.ensembleParticipantId
      ? { ensembleParticipantId: matchedRun.ensembleParticipantId }
      : {}),
    ...(matchedRun.ensembleLaneId ? { ensembleLaneId: matchedRun.ensembleLaneId } : {}),
    ...(matchedRun.ensembleRole ? { ensembleRole: matchedRun.ensembleRole } : {}),
    ...(matchedRun.ensembleStageRole ? { ensembleStageRole: matchedRun.ensembleStageRole } : {})
  }
}

export interface RunRepositoryOptions {
  providerLabel: (provider: RunSession['provider']) => string
  permissionPostureForSession?: (session: RunSession) => RunQueueJob['permissionPosture'] | undefined
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

export interface PromoteQueuedSteerInput {
  runId?: string
  jobId?: string
  ownerToken: string
  provider?: RunQueueJob['provider']
  chatId?: string
  statusReason?: string
  queueMessageId?: string
  transitionVersion?: number
}

export interface LeasePromotedSteerInput {
  runId: string
  ownerToken: string
  statusReason?: string
}

export interface FallbackPromotedSteerInput {
  runId: string
  ownerToken: string
  reason: string
  fallbackStatus?: RunQueueJobStatus
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
    const ensembleMetadata = lookupEnsembleQueueMetadata(session)
    const permissionPosture = this.options.permissionPostureForSession?.(session)
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
      ...ensembleMetadata,
      providerSessionId: session.providerSessionId,
      providerRunId: session.providerRunId,
      processPid,
      processCommand,
      processStartedAt: processPid
        ? existing?.processStartedAt || new Date(session.startedAt).toISOString()
        : undefined,
      ...(permissionPosture ? { permissionPosture } : {}),
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
        ensembleParticipantId: partial.ensembleParticipantId,
        ensembleLaneId: partial.ensembleLaneId,
        ensembleRole: partial.ensembleRole,
        ensembleStageRole: partial.ensembleStageRole,
        scope: partial.workspacePath ? 'workspace' : 'global',
        source: 'system',
        status,
        ...(permissionPosture ? { permissionPosture } : {}),
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

  promoteQueuedJobForSteer(input: PromoteQueuedSteerInput): RunQueueJob | null {
    const runId = input.runId || input.jobId
    if (!runId || !input.ownerToken) return null
    const candidate = AppStore.getRunQueueJob(runId)
    if (!candidate) return null
    if (input.provider && candidate.provider !== input.provider) return null
    if (input.chatId && candidate.chatId && candidate.chatId !== input.chatId) return null
    if (candidate.status === STEER_PROMOTING_STATUS) {
      const ownerToken = this.getRunQueuePromotionOwnerToken(candidate)
      if (ownerToken && ownerToken !== input.ownerToken) return null
      if (ownerToken === input.ownerToken) {
        this.appendSteerLifecycleEvent({
          runId,
          from: 'queued',
          to: STEER_PROMOTING_STATUS,
          ownerToken: input.ownerToken,
          transitionVersion: candidate.transitionVersion,
          promotionAttempt: candidate.promotionAttempt,
          queueMessageId: candidate.queueMessageId,
          statusReason:
            optionalString(candidate.statusReason) ||
            optionalString(input.statusReason) ||
            'Promoted from main scheduler for remote steering.',
          chatId: candidate.chatId,
          provider: candidate.provider,
          workspacePath: candidate.workspacePath,
          workspaceId: candidate.workspaceId
        })
        return candidate
      }
    }
    if (candidate.status !== 'queued') return null
    const now = new Date().toISOString()
    const updated = this.updateRunQueueJob(runId, {
      status: STEER_PROMOTING_STATUS as RunQueueJob['status'],
      statusReason:
        input.statusReason?.trim() || 'Promoted from main scheduler for remote steering.',
      promotionOwnerToken: input.ownerToken,
      promotionToken: input.ownerToken,
      promotionAttempt: this.nextSteerPromotionAttempt(candidate),
      transitionVersion: this.nextSteerTransitionVersion(candidate, input.transitionVersion),
      promotedAt: now,
      queueMessageId: optionalString(input.queueMessageId)
    })
    if (updated) {
      this.appendSteerLifecycleEvent({
        runId,
        from: candidate.status,
        to: STEER_PROMOTING_STATUS,
        ownerToken: input.ownerToken,
        transitionVersion: updated.transitionVersion,
        promotionAttempt: updated.promotionAttempt,
        queueMessageId: updated.queueMessageId,
        statusReason:
          input.statusReason?.trim() || 'Promoted from main scheduler for remote steering.',
        chatId: candidate.chatId,
        provider: candidate.provider,
        workspacePath: candidate.workspacePath,
        workspaceId: candidate.workspaceId
      })
    }
    return updated
  }

  leasePromotedSteerJob(input: LeasePromotedSteerInput): RunQueueJob | null {
    if (!input.ownerToken) return null
    const candidate = AppStore.getRunQueueJob(input.runId)
    if (!candidate || candidate.status !== STEER_PROMOTING_STATUS) return null
    const ownerToken = this.getRunQueuePromotionOwnerToken(candidate)
    if (!ownerToken || ownerToken !== input.ownerToken) return null
    const updated = this.updateRunQueueJob(input.runId, {
      status: 'starting',
      statusReason: optionalString(input.statusReason) || 'Leased from steer promotion queue.',
      promotionOwnerToken: undefined,
      promotionToken: undefined
    })
    if (updated) {
      this.appendSteerLifecycleEvent({
        runId: input.runId,
        from: STEER_PROMOTING_STATUS,
        to: 'starting',
        ownerToken: input.ownerToken,
        transitionVersion: updated.transitionVersion,
        promotionAttempt: updated.promotionAttempt,
        queueMessageId: updated.queueMessageId,
        statusReason: optionalString(input.statusReason) || 'Leased from steer promotion queue.',
        chatId: candidate.chatId,
        provider: candidate.provider,
        workspacePath: candidate.workspacePath,
        workspaceId: candidate.workspaceId
      })
    }
    return updated
  }

  fallbackPromotedSteerJob(input: FallbackPromotedSteerInput): RunQueueJob | null {
    if (!input.ownerToken) return null
    const reason = optionalString(input.reason)
    const reasonText = reason || 'Steer promotion failed.'
    const candidate = AppStore.getRunQueueJob(input.runId)
    if (!candidate || candidate.status !== STEER_PROMOTING_STATUS) return null
    const ownerToken = this.getRunQueuePromotionOwnerToken(candidate)
    if (!ownerToken || ownerToken !== input.ownerToken) return null
    const targetStatus: RunQueueJobStatus =
      input.fallbackStatus || this.resolveSteerFallbackStatus(reasonText)
    const updated = this.updateRunQueueJob(input.runId, {
      status: targetStatus,
      statusReason: reasonText,
      promotionOwnerToken: undefined,
      promotionToken: undefined
    })
    if (updated) {
      this.appendSteerLifecycleEvent({
        runId: input.runId,
        from: STEER_PROMOTING_STATUS,
        to: targetStatus,
        ownerToken: input.ownerToken,
        transitionVersion: updated.transitionVersion,
        promotionAttempt: updated.promotionAttempt,
        queueMessageId: updated.queueMessageId,
        statusReason: reasonText,
        chatId: candidate.chatId,
        provider: candidate.provider,
        workspacePath: candidate.workspacePath,
        workspaceId: candidate.workspaceId
      })
    }
    return updated
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

  private appendSteerLifecycleEvent(input: {
    runId: string
    from: RunQueueJobStatusLike
    to: RunQueueJobStatusLike
    ownerToken: string
    transitionVersion?: number
    promotionAttempt?: number
    queueMessageId?: string
    statusReason: string
    chatId?: string
    provider: RunQueueJob['provider']
    workspaceId?: string
    workspacePath?: string
  }): RunEventRecord | null {
    const idempotencyKey = this.steerLifecycleEventId(input)
    const existing = this.findRunEventById(input.runId, idempotencyKey)
    if (existing) return existing

    return this.appendRunEvent({
      id: idempotencyKey,
      runId: input.runId,
      chatId: input.chatId,
      provider: input.provider,
      workspaceId: input.workspaceId,
      workspacePath: input.workspacePath,
      kind: 'lifecycle',
      phase: 'control',
      source: 'main',
      summary: `Queue job steer transition: ${input.from} -> ${input.to}`,
      payload: {
        eventType: 'steerTransition',
        idempotencyKey,
        fromStatus: input.from,
        toStatus: input.to,
        ownerToken: input.ownerToken,
        transitionVersion: input.transitionVersion,
        promotionAttempt: input.promotionAttempt,
        queueMessageId: input.queueMessageId,
        statusReason: input.statusReason
      }
    })
  }

  private steerLifecycleEventId(input: {
    runId: string
    from: RunQueueJobStatusLike
    to: RunQueueJobStatusLike
    transitionVersion?: number
    promotionAttempt?: number
  }): string {
    const version = Number.isFinite(input.transitionVersion)
      ? Math.max(0, Math.floor(input.transitionVersion as number))
      : Number.isFinite(input.promotionAttempt)
        ? Math.max(0, Math.floor(input.promotionAttempt as number))
        : 0
    return [
      'run-queue',
      this.eventIdPart(input.runId),
      'steer-transition',
      version,
      this.eventIdPart(String(input.from)),
      this.eventIdPart(String(input.to))
    ].join(':')
  }

  private eventIdPart(value: string): string {
    return String(value || 'unknown')
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 96) || 'unknown'
  }

  private findRunEventById(runId: string, id: string): RunEventRecord | null {
    try {
      return this.getRunEvents({ runId, kinds: ['lifecycle'] }).find((event) => event.id === id) || null
    } catch (error) {
      console.error('Failed to read run events for idempotency check', error)
      return null
    }
  }

  private getRunQueuePromotionOwnerToken(job: RunQueueJobWithSteerMetadata): string | undefined {
    return job.promotionOwnerToken || job.promotionToken
  }

  private nextSteerPromotionAttempt(job: RunQueueJobWithSteerMetadata): number {
    const existing = Number(job.promotionAttempt)
    if (Number.isFinite(existing) && existing > 0) return Math.floor(existing) + 1
    return 1
  }

  private nextSteerTransitionVersion(
    job: RunQueueJobWithSteerMetadata,
    requestedVersion?: number
  ): number {
    const existing = Number(job.transitionVersion)
    const nextRequested = Number.isFinite(requestedVersion as number)
      ? Math.floor(requestedVersion as number)
      : undefined
    if (nextRequested !== undefined && nextRequested > (Number.isFinite(existing) ? existing : -Infinity)) {
      return nextRequested
    }
    return Number.isFinite(existing) ? Math.floor(existing) + 1 : 1
  }

  private resolveSteerFallbackStatus(reason: string): RunQueueJobStatus {
    const normalized = reason.toLowerCase()
    if (normalized.includes('cancel')) return 'cancelled'
    if (
      normalized.includes('fatal') ||
      normalized.includes('hard') ||
      normalized.includes('fail')
    ) {
      return 'failed'
    }
    return 'queued'
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

  updateRunQueueJob(
    runIdOrId: string,
    partial: Partial<RunQueueJob> & Partial<SteerQueueMetadata>
  ): RunQueueJob | null {
    const updated = AppStore.updateRunQueueJob(runIdOrId, partial as Partial<RunQueueJob>)
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
    const permissionPosture = this.options.permissionPostureForSession?.(session)
    const dispatchReceipt = AppStore.getRunQueueJob(session.runId)?.dispatchReceipt
    const ensembleMetadata = lookupEnsembleQueueMetadata(session)
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
        ...(Object.keys(ensembleMetadata).length > 0 ? { ensembleRun: ensembleMetadata } : {}),
        status: session.status,
        startedAt: session.startedAt,
        updatedAt: session.updatedAt,
        hasProcess: Boolean(session.process),
        hasAbortController: Boolean(session.abortController),
        approvalIds: [...session.approvalIds],
        ...(dispatchReceipt ? { dispatchReceipt } : {}),
        ...(permissionPosture ? { permissionPosture } : {})
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

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}
