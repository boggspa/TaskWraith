import {
  isSafeHostIdentifier,
  resolveHostCommandActionId,
  type HostCommandActionId
} from './HostCommandIdentity'
import type { HostProjectionOperationRunner } from '../../host-runtime/HostProjectionSerialQueue'

export type HostBridgeStartRef =
  | { readonly kind: 'solo'; readonly runId: string }
  | {
      readonly kind: 'ensemble'
      readonly roundId: string
      readonly participantRunIds: readonly string[]
    }

export type HostBridgeStartEffectRef = {
  readonly family: 'thread' | 'run' | 'round'
  readonly entityId: string
}

export interface HostBridgeQueuedStartRegistration {
  readonly hostCommandActionId: string
  readonly threadId: string
  /** Authority-owned opaque correlation; Bridge events never replace it. */
  readonly authority: {
    readonly actorId: string
    readonly clientId: string
    readonly clientClass: string
    readonly commandFingerprint: string
  }
}

export interface HostBridgeQueuedEvent {
  readonly kind: 'queued'
  readonly hostCommandActionId: string
  readonly threadId: string
  readonly queueId: string
  readonly reservedRunId: string
}

export interface HostBridgePreparedEvent {
  readonly kind: 'prepared'
  readonly hostCommandActionId: string
  readonly threadId: string
  /** Literal assertion supplied only after prompt/start persistence succeeds. */
  readonly durablePromptAndStartPersisted: true
  readonly start: HostBridgeStartRef
  readonly effectRefs: readonly HostBridgeStartEffectRef[]
}

export interface HostBridgeSettledEvent {
  readonly kind: 'settled'
  readonly hostCommandActionId: string
  readonly threadId: string
  readonly status: 'started' | 'failed' | 'cancelled'
  readonly start?: HostBridgeStartRef
  readonly errorCode?: string
}

export type HostBridgeQueuedStartEvent =
  | HostBridgeQueuedEvent
  | HostBridgePreparedEvent
  | HostBridgeSettledEvent

export interface HostBridgeQueuedStartView {
  readonly hostCommandActionId: HostCommandActionId
  readonly threadId: string
  readonly authority: HostBridgeQueuedStartRegistration['authority']
  readonly phase: 'registered' | 'queued' | 'prepared' | 'settled'
  readonly queued?: {
    readonly queueId: string
    readonly reservedRunId: string
  }
  readonly prepared?: {
    readonly start: HostBridgeStartRef
    readonly effectRefs: readonly HostBridgeStartEffectRef[]
  }
  readonly settled?: {
    readonly status: 'started' | 'failed' | 'cancelled'
    readonly start?: HostBridgeStartRef
    readonly errorCode?: string
  }
}

export type HostBridgeQueuedStartRegisterResult =
  | { readonly kind: 'registered'; readonly view: HostBridgeQueuedStartView }
  | { readonly kind: 'unchanged'; readonly view: HostBridgeQueuedStartView }
  | { readonly kind: 'refused'; readonly reason: 'invalid' | 'mismatch' | 'shutting_down' }

export type HostBridgeQueuedStartEventResult =
  | { readonly kind: 'applied'; readonly view: HostBridgeQueuedStartView }
  | { readonly kind: 'unchanged'; readonly view: HostBridgeQueuedStartView }
  | {
      readonly kind: 'refused'
      readonly reason:
        | 'invalid'
        | 'unknown'
        | 'mismatch'
        | 'regression'
        | 'terminal'
        | 'shutting_down'
    }
  | { readonly kind: 'failed'; readonly reason: 'publication_failed' }

export interface HostBridgeQueuedStartFailure {
  readonly hostCommandActionId: HostCommandActionId
  readonly threadId: string
  readonly reason: 'publication_failed'
}

export interface HostBridgeQueuedStartAdapterOptions {
  readonly runProjectionOperation: HostProjectionOperationRunner
  readonly onQueued?: (view: HostBridgeQueuedStartView) => void | Promise<void>
  readonly onPrepared?: (view: HostBridgeQueuedStartView) => void | Promise<void>
  readonly onSettled?: (view: HostBridgeQueuedStartView) => void | Promise<void>
  readonly onFailure?: (failure: HostBridgeQueuedStartFailure) => void | Promise<void>
}

interface RecordState {
  readonly hostCommandActionId: HostCommandActionId
  readonly threadId: string
  readonly authority: HostBridgeQueuedStartRegistration['authority']
  phase: HostBridgeQueuedStartView['phase']
  queued?: HostBridgeQueuedStartView['queued']
  prepared?: HostBridgeQueuedStartView['prepared']
  settled?: HostBridgeQueuedStartView['settled']
}

const EFFECT_ORDER: Readonly<Record<HostBridgeStartEffectRef['family'], number>> = {
  thread: 0,
  run: 1,
  round: 2
}

function validId(value: unknown): value is string {
  return isSafeHostIdentifier(value)
}

function normalizeAuthority(
  value: HostBridgeQueuedStartRegistration['authority']
): HostBridgeQueuedStartRegistration['authority'] | null {
  if (
    !value ||
    !validId(value.actorId) ||
    !validId(value.clientId) ||
    !validId(value.clientClass) ||
    !validId(value.commandFingerprint)
  ) {
    return null
  }
  return {
    actorId: value.actorId,
    clientId: value.clientId,
    clientClass: value.clientClass,
    commandFingerprint: value.commandFingerprint
  }
}

function normalizeStartRef(value: HostBridgeStartRef | undefined): HostBridgeStartRef | null {
  if (!value || typeof value !== 'object') return null
  if (value.kind === 'solo') {
    return validId(value.runId) ? { kind: 'solo', runId: value.runId } : null
  }
  if (
    value.kind !== 'ensemble' ||
    !validId(value.roundId) ||
    !Array.isArray(value.participantRunIds) ||
    value.participantRunIds.length === 0 ||
    value.participantRunIds.some((runId) => !validId(runId)) ||
    new Set(value.participantRunIds).size !== value.participantRunIds.length
  ) {
    return null
  }
  return {
    kind: 'ensemble',
    roundId: value.roundId,
    participantRunIds: [...value.participantRunIds].sort()
  }
}

function expectedEffectKeys(threadId: string, start: HostBridgeStartRef): string[] {
  const keys = ['thread:' + threadId]
  if (start.kind === 'solo') {
    keys.push('run:' + start.runId)
  } else {
    keys.push('round:' + start.roundId)
    for (const runId of start.participantRunIds) keys.push('run:' + runId)
  }
  return keys.sort()
}

function normalizeEffectRefs(
  value: readonly HostBridgeStartEffectRef[],
  threadId: string,
  start: HostBridgeStartRef
): readonly HostBridgeStartEffectRef[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const normalized: HostBridgeStartEffectRef[] = []
  const keys = new Set<string>()
  for (const ref of value) {
    if (!ref || !['thread', 'run', 'round'].includes(ref.family) || !validId(ref.entityId)) {
      return null
    }
    const key = ref.family + ':' + ref.entityId
    if (keys.has(key)) return null
    keys.add(key)
    normalized.push({ family: ref.family, entityId: ref.entityId })
  }
  if (JSON.stringify([...keys].sort()) !== JSON.stringify(expectedEffectKeys(threadId, start))) {
    return null
  }
  return normalized.sort(
    (left, right) =>
      EFFECT_ORDER[left.family] - EFFECT_ORDER[right.family] ||
      left.entityId.localeCompare(right.entityId)
  )
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function cloneStart(start: HostBridgeStartRef): HostBridgeStartRef {
  return start.kind === 'solo'
    ? { kind: 'solo', runId: start.runId }
    : {
        kind: 'ensemble',
        roundId: start.roundId,
        participantRunIds: [...start.participantRunIds]
      }
}

function cloneView(record: RecordState): HostBridgeQueuedStartView {
  return {
    hostCommandActionId: record.hostCommandActionId,
    threadId: record.threadId,
    authority: { ...record.authority },
    phase: record.phase,
    ...(record.queued ? { queued: { ...record.queued } } : {}),
    ...(record.prepared
      ? {
          prepared: {
            start: cloneStart(record.prepared.start),
            effectRefs: record.prepared.effectRefs.map((ref) => ({ ...ref }))
          }
        }
      : {}),
    ...(record.settled
      ? {
          settled: {
            status: record.settled.status,
            ...(record.settled.start ? { start: cloneStart(record.settled.start) } : {}),
            ...(record.settled.errorCode ? { errorCode: record.settled.errorCode } : {})
          }
        }
      : {})
  }
}

export function createHostBridgeQueuedStartAdapter(options: HostBridgeQueuedStartAdapterOptions): {
  register(input: HostBridgeQueuedStartRegistration): HostBridgeQueuedStartRegisterResult
  queued(event: HostBridgeQueuedEvent): Promise<HostBridgeQueuedStartEventResult>
  prepared(event: HostBridgePreparedEvent): Promise<HostBridgeQueuedStartEventResult>
  settled(event: HostBridgeSettledEvent): Promise<HostBridgeQueuedStartEventResult>
  get(hostCommandActionId: string): HostBridgeQueuedStartView | undefined
  pendingCount(): number
  beginShutdown(): void
  drain(): Promise<void>
} {
  if (!options || typeof options.runProjectionOperation !== 'function') {
    throw new Error('HostBridgeQueuedStartAdapter requires runProjectionOperation')
  }
  const records = new Map<HostCommandActionId, RecordState>()
  const inFlight = new Set<Promise<HostBridgeQueuedStartEventResult>>()
  let shuttingDown = false

  const failClosed = async (
    actionId: HostCommandActionId,
    record: RecordState | undefined
  ): Promise<HostBridgeQueuedStartEventResult> => {
    const transitioned = Boolean(record && record.phase !== 'settled')
    if (record && transitioned) {
      record.phase = 'settled'
      record.settled = { status: 'failed', errorCode: 'publication_failed' }
    }
    if (record && transitioned && options.onFailure) {
      try {
        await options.onFailure({
          hostCommandActionId: actionId,
          threadId: record.threadId,
          reason: 'publication_failed'
        })
      } catch {
        // Failure reporting is advisory; the state is already terminal.
      }
    }
    return { kind: 'failed', reason: 'publication_failed' }
  }

  const schedule = (
    actionId: HostCommandActionId,
    operation: () => Promise<HostBridgeQueuedStartEventResult>
  ): Promise<HostBridgeQueuedStartEventResult> => {
    let work: Promise<HostBridgeQueuedStartEventResult>
    try {
      work = Promise.resolve(
        options.runProjectionOperation(operation, 'bridge-queued-start:' + actionId)
      ).catch(() => failClosed(actionId, records.get(actionId)))
    } catch {
      work = failClosed(actionId, records.get(actionId))
    }
    const tracked = work.finally(() => {
      inFlight.delete(tracked)
    })
    inFlight.add(tracked)
    return tracked
  }

  const locate = (
    hostCommandActionId: string,
    threadId: string
  ):
    | { actionId: HostCommandActionId; record: RecordState }
    | { reason: 'invalid' | 'unknown' | 'mismatch' } => {
    const actionId = resolveHostCommandActionId(hostCommandActionId)
    if (!actionId || !validId(threadId)) return { reason: 'invalid' }
    const record = records.get(actionId)
    if (!record) return { reason: 'unknown' }
    if (record.threadId !== threadId) return { reason: 'mismatch' }
    return { actionId, record }
  }

  const register = (
    input: HostBridgeQueuedStartRegistration
  ): HostBridgeQueuedStartRegisterResult => {
    if (shuttingDown) return { kind: 'refused', reason: 'shutting_down' }
    const actionId = resolveHostCommandActionId(input?.hostCommandActionId)
    const authority = input ? normalizeAuthority(input.authority) : null
    if (!actionId || !validId(input?.threadId) || !authority) {
      return { kind: 'refused', reason: 'invalid' }
    }
    const candidate = {
      hostCommandActionId: actionId,
      threadId: input.threadId,
      authority
    }
    const existing = records.get(actionId)
    if (existing) {
      const comparable = {
        hostCommandActionId: existing.hostCommandActionId,
        threadId: existing.threadId,
        authority: existing.authority
      }
      return same(comparable, candidate)
        ? { kind: 'unchanged', view: cloneView(existing) }
        : { kind: 'refused', reason: 'mismatch' }
    }
    const record: RecordState = { ...candidate, phase: 'registered' }
    records.set(actionId, record)
    return { kind: 'registered', view: cloneView(record) }
  }

  const queued = async (
    event: HostBridgeQueuedEvent
  ): Promise<HostBridgeQueuedStartEventResult> => {
    const found = locate(event?.hostCommandActionId, event?.threadId)
    if ('reason' in found) return { kind: 'refused', reason: found.reason }
    if (!validId(event.queueId) || !validId(event.reservedRunId)) {
      return { kind: 'refused', reason: 'invalid' }
    }
    if (shuttingDown) return { kind: 'refused', reason: 'shutting_down' }
    const candidate = { queueId: event.queueId, reservedRunId: event.reservedRunId }
    return schedule(found.actionId, async () => {
      const record = found.record
      if (record.phase === 'settled') return { kind: 'refused', reason: 'terminal' }
      if (record.phase === 'queued') {
        return same(record.queued, candidate)
          ? { kind: 'unchanged', view: cloneView(record) }
          : { kind: 'refused', reason: 'mismatch' }
      }
      if (record.phase !== 'registered') return { kind: 'refused', reason: 'regression' }
      const view = cloneView({ ...record, phase: 'queued', queued: candidate })
      await options.onQueued?.(view)
      record.phase = 'queued'
      record.queued = candidate
      return { kind: 'applied', view: cloneView(record) }
    })
  }

  const prepared = async (
    event: HostBridgePreparedEvent
  ): Promise<HostBridgeQueuedStartEventResult> => {
    const found = locate(event?.hostCommandActionId, event?.threadId)
    if ('reason' in found) return { kind: 'refused', reason: found.reason }
    if (event.durablePromptAndStartPersisted !== true) {
      return { kind: 'refused', reason: 'invalid' }
    }
    const start = normalizeStartRef(event.start)
    const effectRefs = start
      ? normalizeEffectRefs(event.effectRefs, found.record.threadId, start)
      : null
    if (!start || !effectRefs) return { kind: 'refused', reason: 'invalid' }
    if (shuttingDown) return { kind: 'refused', reason: 'shutting_down' }
    return schedule(found.actionId, async () => {
      const record = found.record
      const candidate = { start, effectRefs }
      if (record.phase === 'settled') return { kind: 'refused', reason: 'terminal' }
      if (record.phase === 'prepared') {
        return same(record.prepared, candidate)
          ? { kind: 'unchanged', view: cloneView(record) }
          : { kind: 'refused', reason: 'mismatch' }
      }
      if (record.phase !== 'registered' && record.phase !== 'queued') {
        return { kind: 'refused', reason: 'regression' }
      }
      if (record.queued && start.kind === 'solo' && record.queued.reservedRunId !== start.runId) {
        return { kind: 'refused', reason: 'mismatch' }
      }
      const view = cloneView({ ...record, phase: 'prepared', prepared: candidate })
      await options.onPrepared?.(view)
      record.phase = 'prepared'
      record.prepared = candidate
      return { kind: 'applied', view: cloneView(record) }
    })
  }

  const settled = async (
    event: HostBridgeSettledEvent
  ): Promise<HostBridgeQueuedStartEventResult> => {
    const found = locate(event?.hostCommandActionId, event?.threadId)
    if ('reason' in found) return { kind: 'refused', reason: found.reason }
    if (!['started', 'failed', 'cancelled'].includes(event.status)) {
      return { kind: 'refused', reason: 'invalid' }
    }
    const suppliedStart = event.start === undefined ? undefined : normalizeStartRef(event.start)
    if (event.start !== undefined && !suppliedStart) {
      return { kind: 'refused', reason: 'invalid' }
    }
    if (event.errorCode !== undefined && !validId(event.errorCode)) {
      return { kind: 'refused', reason: 'invalid' }
    }
    const status = event.status
    const errorCode = event.errorCode
    return schedule(found.actionId, async () => {
      const record = found.record
      const effectiveStart =
        status === 'started' ? (suppliedStart ?? record.prepared?.start) : suppliedStart
      const candidate: NonNullable<HostBridgeQueuedStartView['settled']> = {
        status,
        ...(effectiveStart ? { start: effectiveStart } : {}),
        ...(errorCode ? { errorCode } : {})
      }
      if (record.phase === 'settled') {
        return same(record.settled, candidate)
          ? { kind: 'unchanged', view: cloneView(record) }
          : { kind: 'refused', reason: 'terminal' }
      }
      if (status === 'started' && record.phase !== 'prepared') {
        return { kind: 'refused', reason: 'regression' }
      }
      if (suppliedStart && (!record.prepared || !same(record.prepared.start, suppliedStart))) {
        return { kind: 'refused', reason: 'mismatch' }
      }
      const view = cloneView({ ...record, phase: 'settled', settled: candidate })
      await options.onSettled?.(view)
      record.phase = 'settled'
      record.settled = candidate
      return { kind: 'applied', view: cloneView(record) }
    })
  }

  return {
    register,
    queued,
    prepared,
    settled,
    get(hostCommandActionId: string) {
      const actionId = resolveHostCommandActionId(hostCommandActionId)
      const record = actionId ? records.get(actionId) : undefined
      return record ? cloneView(record) : undefined
    },
    pendingCount() {
      let count = 0
      for (const record of records.values()) {
        if (record.phase !== 'settled') count += 1
      }
      return count
    },
    beginShutdown() {
      shuttingDown = true
    },
    async drain() {
      while (inFlight.size > 0) {
        await Promise.all([...inFlight])
      }
    }
  }
}
