import { createHash } from 'crypto'
import type {
  EffectiveRunPermissions,
  ExternalPathGrant,
  ProviderId,
  SubThreadJoinPolicy,
  SubThreadWorkerControl,
  SubThreadWorkerEvent,
  SubThreadWorkerEventPriority,
  SubThreadWorkerEventStatus
} from './store/types'

export const SUBTHREAD_WORKER_CONTROL_SCHEMA_VERSION = 1 as const
export const MAX_SUBTHREAD_WORKER_PENDING_EVENTS = 16
export const MAX_SUBTHREAD_WORKER_EVENT_PROMPT_CHARS = 20_000
export const MAX_SUBTHREAD_WORKER_PENDING_PROMPT_CHARS = 64_000
export const MAX_SUBTHREAD_WORKER_TERMINAL_EVENTS = 64

export interface SubThreadWorkerEventInput {
  id?: string
  sourceToolCallId: string
  parentChatId: string
  subThreadId: string
  targetProvider: ProviderId
  parentProvider: ProviderId
  parentRunId?: string
  prompt: string
  returnResultToParent: boolean
  priority?: SubThreadWorkerEventPriority
  approvalMode: string
  runtimeProfileId?: string
  effectivePermissions?: EffectiveRunPermissions
  externalPathGrants?: ExternalPathGrant[]
  joinPolicy?: SubThreadJoinPolicy
}

export interface SubThreadWorkerRunSnapshot {
  runId: string
  status: string
  cancelled?: boolean
}

export interface SubThreadWorkerControlSummary {
  attachedAt?: string
  pending: number
  active: number
  terminal: number
  nextEventId?: string
  nextPriority?: SubThreadWorkerEventPriority
}

const ACTIVE_EVENT_STATUSES = new Set<SubThreadWorkerEventStatus>(['claimed', 'dispatched'])
const TERMINAL_EVENT_STATUSES = new Set<SubThreadWorkerEventStatus>([
  'completed',
  'failed',
  'cancelled'
])
const ACTIVE_RUN_STATUSES = new Set([
  'running',
  'queued',
  'starting',
  'active',
  'paused',
  'cancelling',
  'steer_promoting'
])

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isWorkerEventStatus(value: unknown): value is SubThreadWorkerEventStatus {
  return (
    value === 'pending' ||
    value === 'claimed' ||
    value === 'dispatched' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
  )
}

function cloneExternalPathGrants(
  grants: ExternalPathGrant[] | undefined
): ExternalPathGrant[] | undefined {
  return grants?.map((grant) => ({ ...grant }))
}

function cloneEffectivePermissions(
  permissions: EffectiveRunPermissions | undefined
): EffectiveRunPermissions | undefined {
  if (!permissions) return undefined
  return {
    ...permissions,
    agenticServices: { ...permissions.agenticServices },
    externalPathGrants: cloneExternalPathGrants(permissions.externalPathGrants) || [],
    workspaceGrantServiceIds: [...permissions.workspaceGrantServiceIds]
  }
}

function cloneJoinPolicy(policy: SubThreadJoinPolicy | undefined): SubThreadJoinPolicy | undefined {
  return policy ? { ...policy } : undefined
}

function cloneEvent(event: SubThreadWorkerEvent): SubThreadWorkerEvent {
  return {
    ...event,
    ...(event.effectivePermissions
      ? { effectivePermissions: cloneEffectivePermissions(event.effectivePermissions) }
      : {}),
    ...(event.externalPathGrants
      ? { externalPathGrants: cloneExternalPathGrants(event.externalPathGrants) }
      : {}),
    ...(event.joinPolicy ? { joinPolicy: cloneJoinPolicy(event.joinPolicy) } : {})
  }
}

function compactTerminalHistory(events: SubThreadWorkerEvent[]): SubThreadWorkerEvent[] {
  const terminal = events.filter((event) => TERMINAL_EVENT_STATUSES.has(event.status))
  if (terminal.length <= MAX_SUBTHREAD_WORKER_TERMINAL_EVENTS) return events
  const keepTerminalIds = new Set(
    terminal.slice(-MAX_SUBTHREAD_WORKER_TERMINAL_EVENTS).map((event) => event.id)
  )
  return events.filter(
    (event) => !TERMINAL_EVENT_STATUSES.has(event.status) || keepTerminalIds.has(event.id)
  )
}

function normalizeEvent(value: unknown): SubThreadWorkerEvent | null {
  if (!isRecord(value)) return null
  const id = nonEmptyString(value.id)
  const sourceToolCallId = nonEmptyString(value.sourceToolCallId)
  const parentChatId = nonEmptyString(value.parentChatId)
  const subThreadId = nonEmptyString(value.subThreadId)
  const targetProvider = nonEmptyString(value.targetProvider) as ProviderId | undefined
  const parentProvider = nonEmptyString(value.parentProvider) as ProviderId | undefined
  const prompt = typeof value.prompt === 'string' ? value.prompt.trim() : ''
  const enqueuedAt = nonEmptyString(value.enqueuedAt)
  const approvalMode = nonEmptyString(value.approvalMode)
  const status = isWorkerEventStatus(value.status) ? value.status : 'pending'
  if (
    !id ||
    !sourceToolCallId ||
    !parentChatId ||
    !subThreadId ||
    !targetProvider ||
    !parentProvider ||
    !prompt ||
    !enqueuedAt ||
    !approvalMode
  ) {
    return null
  }
  return {
    schemaVersion: SUBTHREAD_WORKER_CONTROL_SCHEMA_VERSION,
    id,
    sourceToolCallId,
    parentChatId,
    subThreadId,
    targetProvider,
    parentProvider,
    ...(nonEmptyString(value.parentRunId)
      ? { parentRunId: nonEmptyString(value.parentRunId) }
      : {}),
    prompt: prompt.slice(0, MAX_SUBTHREAD_WORKER_EVENT_PROMPT_CHARS),
    returnResultToParent: value.returnResultToParent !== false,
    priority: value.priority === 'interrupt' ? 'interrupt' : 'normal',
    status,
    enqueuedAt,
    approvalMode,
    ...(nonEmptyString(value.runtimeProfileId)
      ? { runtimeProfileId: nonEmptyString(value.runtimeProfileId) }
      : {}),
    ...(isRecord(value.effectivePermissions)
      ? { effectivePermissions: value.effectivePermissions as unknown as EffectiveRunPermissions }
      : {}),
    ...(Array.isArray(value.externalPathGrants)
      ? { externalPathGrants: value.externalPathGrants as ExternalPathGrant[] }
      : {}),
    ...(isRecord(value.joinPolicy)
      ? { joinPolicy: value.joinPolicy as unknown as SubThreadJoinPolicy }
      : {}),
    attempts:
      typeof value.attempts === 'number' && Number.isFinite(value.attempts)
        ? Math.max(0, Math.floor(value.attempts))
        : 0,
    ...(nonEmptyString(value.claimId) ? { claimId: nonEmptyString(value.claimId) } : {}),
    ...(nonEmptyString(value.claimedAt) ? { claimedAt: nonEmptyString(value.claimedAt) } : {}),
    ...(nonEmptyString(value.dispatchRunId)
      ? { dispatchRunId: nonEmptyString(value.dispatchRunId) }
      : {}),
    ...(nonEmptyString(value.processedAt)
      ? { processedAt: nonEmptyString(value.processedAt) }
      : {}),
    ...(nonEmptyString(value.terminalAt) ? { terminalAt: nonEmptyString(value.terminalAt) } : {}),
    ...(nonEmptyString(value.error) ? { error: nonEmptyString(value.error)?.slice(0, 1_000) } : {})
  }
}

export function normalizeSubThreadWorkerControl(
  value: unknown,
  now: string = new Date().toISOString()
): SubThreadWorkerControl {
  const record = isRecord(value) ? value : null
  const attachedAt = nonEmptyString(record?.attachedAt) || now
  const events = Array.isArray(record?.events)
    ? record.events
        .map((event) => normalizeEvent(event))
        .filter((event): event is SubThreadWorkerEvent => Boolean(event))
    : []
  const seen = new Set<string>()
  return {
    schemaVersion: SUBTHREAD_WORKER_CONTROL_SCHEMA_VERSION,
    attachedAt,
    events: compactTerminalHistory(
      events.filter((event) => {
        if (seen.has(event.id)) return false
        seen.add(event.id)
        return true
      })
    )
  }
}

export function createSubThreadWorkerEventId(
  parentChatId: string,
  subThreadId: string,
  sourceToolCallId: string
): string {
  const digest = createHash('sha256')
    .update(`${parentChatId}\0${subThreadId}\0${sourceToolCallId}`)
    .digest('hex')
    .slice(0, 24)
  return `subthread-worker-${digest}`
}

export function enqueueSubThreadWorkerEvent(
  current: SubThreadWorkerControl | null | undefined,
  input: SubThreadWorkerEventInput,
  now: string = new Date().toISOString()
): { control: SubThreadWorkerControl; event: SubThreadWorkerEvent; added: boolean } {
  const control = normalizeSubThreadWorkerControl(current, now)
  const sourceToolCallId = input.sourceToolCallId.trim()
  const prompt = input.prompt.trim()
  if (!sourceToolCallId) throw new Error('Sub-thread worker event requires a source tool-call id.')
  if (!prompt) throw new Error('Sub-thread worker event requires a non-empty prompt.')
  if (prompt.length > MAX_SUBTHREAD_WORKER_EVENT_PROMPT_CHARS) {
    throw new Error(
      `Sub-thread worker prompt exceeds ${MAX_SUBTHREAD_WORKER_EVENT_PROMPT_CHARS} characters.`
    )
  }
  const id =
    input.id ||
    createSubThreadWorkerEventId(input.parentChatId, input.subThreadId, sourceToolCallId)
  const existing = control.events.find((event) => event.id === id)
  if (existing) return { control, event: cloneEvent(existing), added: false }

  const pending = control.events.filter((event) => !TERMINAL_EVENT_STATUSES.has(event.status))
  if (pending.length >= MAX_SUBTHREAD_WORKER_PENDING_EVENTS) {
    throw new Error(
      `Sub-thread worker queue is full (${MAX_SUBTHREAD_WORKER_PENDING_EVENTS} pending events).`
    )
  }
  const pendingPromptChars = pending.reduce((total, event) => total + event.prompt.length, 0)
  if (pendingPromptChars + prompt.length > MAX_SUBTHREAD_WORKER_PENDING_PROMPT_CHARS) {
    throw new Error(
      `Sub-thread worker queue exceeds its ${MAX_SUBTHREAD_WORKER_PENDING_PROMPT_CHARS}-character aggregate prompt budget.`
    )
  }

  const event: SubThreadWorkerEvent = {
    schemaVersion: SUBTHREAD_WORKER_CONTROL_SCHEMA_VERSION,
    id,
    sourceToolCallId,
    parentChatId: input.parentChatId,
    subThreadId: input.subThreadId,
    targetProvider: input.targetProvider,
    parentProvider: input.parentProvider,
    ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
    prompt,
    returnResultToParent: input.returnResultToParent,
    priority: input.priority === 'interrupt' ? 'interrupt' : 'normal',
    status: 'pending',
    enqueuedAt: now,
    approvalMode: input.approvalMode,
    ...(input.runtimeProfileId ? { runtimeProfileId: input.runtimeProfileId } : {}),
    ...(input.effectivePermissions
      ? { effectivePermissions: cloneEffectivePermissions(input.effectivePermissions) }
      : {}),
    ...(input.externalPathGrants
      ? { externalPathGrants: cloneExternalPathGrants(input.externalPathGrants) }
      : {}),
    ...(input.joinPolicy ? { joinPolicy: cloneJoinPolicy(input.joinPolicy) } : {}),
    attempts: 0
  }
  return {
    control: { ...control, events: compactTerminalHistory([...control.events, event]) },
    event: cloneEvent(event),
    added: true
  }
}

export function pendingSubThreadWorkerEvents(
  current: SubThreadWorkerControl | null | undefined
): SubThreadWorkerEvent[] {
  const events = normalizeSubThreadWorkerControl(current).events.filter(
    (event) => event.status === 'pending'
  )
  return events.map(cloneEvent).sort((left, right) => {
    if (left.priority !== right.priority) return left.priority === 'interrupt' ? -1 : 1
    return Date.parse(left.enqueuedAt) - Date.parse(right.enqueuedAt)
  })
}

export function claimNextSubThreadWorkerEvent(
  current: SubThreadWorkerControl | null | undefined,
  claimId: string,
  now: string = new Date().toISOString()
): { control: SubThreadWorkerControl; event?: SubThreadWorkerEvent } {
  const control = normalizeSubThreadWorkerControl(current, now)
  if (control.events.some((event) => ACTIVE_EVENT_STATUSES.has(event.status))) {
    return { control }
  }
  const next = pendingSubThreadWorkerEvents(control)[0]
  if (!next) return { control }
  const events = control.events.map((event) =>
    event.id === next.id
      ? {
          ...event,
          status: 'claimed' as const,
          claimId,
          claimedAt: now,
          attempts: event.attempts + 1
        }
      : event
  )
  const claimed = events.find((event) => event.id === next.id)
  return {
    control: { ...control, events },
    ...(claimed ? { event: cloneEvent(claimed) } : {})
  }
}

export function releaseSubThreadWorkerEventClaim(
  current: SubThreadWorkerControl | null | undefined,
  eventId: string,
  claimId: string
): SubThreadWorkerControl {
  const control = normalizeSubThreadWorkerControl(current)
  return {
    ...control,
    events: control.events.map((event) =>
      event.id === eventId && event.status === 'claimed' && event.claimId === claimId
        ? {
            ...event,
            status: 'pending' as const,
            claimId: undefined,
            claimedAt: undefined
          }
        : event
    )
  }
}

export function bindSubThreadWorkerEventToRun(
  current: SubThreadWorkerControl | null | undefined,
  eventId: string,
  claimId: string,
  dispatchRunId: string,
  now: string = new Date().toISOString()
): SubThreadWorkerControl {
  const control = normalizeSubThreadWorkerControl(current, now)
  const runId = dispatchRunId.trim()
  if (!runId) throw new Error('Sub-thread worker dispatch requires a run id.')
  const event = control.events.find((candidate) => candidate.id === eventId)
  if (!event || event.status !== 'claimed' || event.claimId !== claimId) {
    throw new Error('Sub-thread worker event claim no longer owns this dispatch.')
  }
  return {
    ...control,
    events: control.events.map((candidate) =>
      candidate.id === eventId
        ? {
            ...candidate,
            status: 'dispatched' as const,
            dispatchRunId: runId,
            processedAt: candidate.processedAt || now
          }
        : candidate
    )
  }
}

export function settleSubThreadWorkerEvent(
  current: SubThreadWorkerControl | null | undefined,
  dispatchRunId: string,
  status: 'completed' | 'failed' | 'cancelled',
  options: { now?: string; error?: string } = {}
): { control: SubThreadWorkerControl; event?: SubThreadWorkerEvent } {
  const now = options.now || new Date().toISOString()
  const control = normalizeSubThreadWorkerControl(current, now)
  let settled: SubThreadWorkerEvent | undefined
  const events = control.events.map((event) => {
    if (event.dispatchRunId !== dispatchRunId || event.status !== 'dispatched') return event
    settled = {
      ...event,
      status,
      terminalAt: now,
      ...(options.error ? { error: options.error.replace(/\s+/g, ' ').trim().slice(0, 1_000) } : {})
    }
    return settled
  })
  return {
    control: { ...control, events: compactTerminalHistory(events) },
    ...(settled ? { event: cloneEvent(settled) } : {})
  }
}

export function cancelPendingSubThreadWorkerEvents(
  current: SubThreadWorkerControl | null | undefined,
  options: { now?: string; reason?: string } = {}
): { control: SubThreadWorkerControl; cancelledEventIds: string[] } {
  const now = options.now || new Date().toISOString()
  const control = normalizeSubThreadWorkerControl(current, now)
  const cancelledEventIds: string[] = []
  const events = control.events.map((event) => {
    if (event.status !== 'pending' && event.status !== 'claimed') return event
    cancelledEventIds.push(event.id)
    return {
      ...event,
      status: 'cancelled' as const,
      claimId: undefined,
      claimedAt: undefined,
      terminalAt: now,
      ...(options.reason
        ? { error: options.reason.replace(/\s+/g, ' ').trim().slice(0, 1_000) }
        : {})
    }
  })
  return {
    control: { ...control, events: compactTerminalHistory(events) },
    cancelledEventIds
  }
}

function terminalEventStatusForRun(
  run: SubThreadWorkerRunSnapshot
): 'completed' | 'failed' | 'cancelled' | null {
  if (run.cancelled || run.status === 'cancelled') return 'cancelled'
  if (
    run.status === 'success' ||
    run.status === 'success_with_warnings' ||
    run.status === 'completed'
  ) {
    return 'completed'
  }
  if (ACTIVE_RUN_STATUSES.has(run.status)) return null
  return 'failed'
}

export function recoverSubThreadWorkerControl(
  current: SubThreadWorkerControl | null | undefined,
  runs: readonly SubThreadWorkerRunSnapshot[],
  now: string = new Date().toISOString()
): SubThreadWorkerControl {
  let control = normalizeSubThreadWorkerControl(current, now)
  const runsById = new Map(runs.map((run) => [run.runId, run]))
  control = {
    ...control,
    events: control.events.map((event) =>
      event.status === 'claimed'
        ? {
            ...event,
            status: 'pending' as const,
            claimId: undefined,
            claimedAt: undefined
          }
        : event
    )
  }
  for (const event of control.events) {
    if (event.status !== 'dispatched' || !event.dispatchRunId) continue
    const run = runsById.get(event.dispatchRunId)
    if (!run) {
      control = settleSubThreadWorkerEvent(control, event.dispatchRunId, 'failed', {
        now,
        error:
          'Worker dispatch identity was persisted, but its run record is missing after recovery; TaskWraith did not replay it to avoid duplicate provider work.'
      }).control
      continue
    }
    const terminalStatus = terminalEventStatusForRun(run)
    if (terminalStatus) {
      control = settleSubThreadWorkerEvent(control, event.dispatchRunId, terminalStatus, {
        now
      }).control
    }
  }
  return control
}

export function summarizeSubThreadWorkerControl(
  current: SubThreadWorkerControl | null | undefined
): SubThreadWorkerControlSummary {
  if (!current) return { pending: 0, active: 0, terminal: 0 }
  const control = normalizeSubThreadWorkerControl(current)
  const pending = pendingSubThreadWorkerEvents(control)
  return {
    attachedAt: control.attachedAt,
    pending: pending.length,
    active: control.events.filter((event) => ACTIVE_EVENT_STATUSES.has(event.status)).length,
    terminal: control.events.filter((event) => TERMINAL_EVENT_STATUSES.has(event.status)).length,
    ...(pending[0] ? { nextEventId: pending[0].id, nextPriority: pending[0].priority } : {})
  }
}
