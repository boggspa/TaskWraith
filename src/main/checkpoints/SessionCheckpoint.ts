import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'

import type {
  BlackboardEntry,
  ChatRecord,
  EnsembleRoundParticipantState,
  EnsembleRoundState
} from '../store/types'

export const SESSION_CHECKPOINT_SCHEMA_VERSION = 1
export const SESSION_CHECKPOINT_FILENAME = 'session-checkpoints.json'

export type SessionCheckpointStatus = 'available' | 'accepted' | 'dismissed' | 'superseded'

export type SessionCheckpointReason =
  | 'round-started'
  | 'round-updated'
  | 'participant-updated'
  | 'round-completed'
  | 'round-cancelled'
  | 'round-failed'

export interface SessionCheckpointQueueState {
  roundStatus: EnsembleRoundState['status']
  prompt: string
  startedAt: string
  endedAt?: string
  activeParticipantId?: string
  orchestrationMode?: EnsembleRoundState['orchestrationMode']
  continuationHops?: number
  maxContinuationHops?: number
  queuedPrompts: string[]
  sleepingParticipantIds: string[]
  pendingWakeupIds: string[]
  participants: EnsembleRoundParticipantState[]
}

export interface SessionCheckpointSnapshot {
  blackboard: BlackboardEntry[]
  openTasks: string[]
  lastRoundSummary?: string
  queueState: SessionCheckpointQueueState
}

export interface SessionCheckpointRecord {
  schemaVersion: typeof SESSION_CHECKPOINT_SCHEMA_VERSION
  id: string
  chatId: string
  chatTitle?: string
  workspaceId?: string
  workspacePath?: string
  roundId: string
  status: SessionCheckpointStatus
  reason: SessionCheckpointReason
  createdAt: string
  updatedAt: string
  acceptedAt?: string
  dismissedAt?: string
  supersededAt?: string
  snapshot: SessionCheckpointSnapshot
}

export interface SessionCheckpointStoreOptions {
  storagePath?: string
  now?: () => string
  idFactory?: () => string
  log?: (line: string) => void
}

export function defaultSessionCheckpointPath(): string | null {
  if (!app || typeof app.getPath !== 'function') return null
  try {
    return join(app.getPath('userData'), 'checkpoints', SESSION_CHECKPOINT_FILENAME)
  } catch {
    return null
  }
}

export function createDefaultSessionCheckpointStore(
  options: { log?: (line: string) => void } = {}
): SessionCheckpointStore | null {
  const storagePath = defaultSessionCheckpointPath()
  return storagePath ? new SessionCheckpointStore({ storagePath, log: options.log }) : null
}

export function buildSessionCheckpointFromChat(
  chat: ChatRecord,
  reason: SessionCheckpointReason,
  now: string,
  existing?: SessionCheckpointRecord
): SessionCheckpointRecord | null {
  const round = chat.ensemble?.activeRound
  if (!round) return null
  const id = existing?.id || stableCheckpointId(chat.appChatId, round.roundId)
  const status =
    existing?.status === 'accepted' || existing?.status === 'dismissed'
      ? existing.status
      : 'available'
  const lastRoundSummary = cleanOptionalText(chat.ensemble?.lastRoundSummary)
  return {
    schemaVersion: SESSION_CHECKPOINT_SCHEMA_VERSION,
    id,
    chatId: chat.appChatId,
    ...(chat.title ? { chatTitle: chat.title } : {}),
    ...(chat.workspaceId ? { workspaceId: chat.workspaceId } : {}),
    ...(chat.workspacePath ? { workspacePath: chat.workspacePath } : {}),
    roundId: round.roundId,
    status,
    reason,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    ...(existing?.acceptedAt ? { acceptedAt: existing.acceptedAt } : {}),
    ...(existing?.dismissedAt ? { dismissedAt: existing.dismissedAt } : {}),
    snapshot: {
      blackboard: cloneArray(chat.ensemble?.blackboard || []),
      openTasks: extractOpenTasks(chat, round),
      ...(lastRoundSummary ? { lastRoundSummary } : {}),
      queueState: {
        roundStatus: round.status,
        prompt: round.prompt,
        startedAt: round.startedAt,
        ...(round.endedAt ? { endedAt: round.endedAt } : {}),
        ...(round.activeParticipantId ? { activeParticipantId: round.activeParticipantId } : {}),
        ...(round.orchestrationMode ? { orchestrationMode: round.orchestrationMode } : {}),
        ...(round.continuationHops !== undefined ? { continuationHops: round.continuationHops } : {}),
        ...(round.maxContinuationHops !== undefined
          ? { maxContinuationHops: round.maxContinuationHops }
          : {}),
        queuedPrompts: [...(round.queuedPrompts || (round.queuedPrompt ? [round.queuedPrompt] : []))],
        sleepingParticipantIds: [...(round.sleepingParticipantIds || [])],
        pendingWakeupIds: [...(round.pendingWakeupIds || [])],
        participants: cloneArray(round.participants || [])
      }
    }
  }
}

export function formatSessionCheckpointResumePrompt(record: SessionCheckpointRecord): string {
  const queue = record.snapshot.queueState
  const lines: string[] = [
    `Resume the interrupted Ensemble session from checkpoint ${record.updatedAt}.`,
    '',
    'Before continuing, verify the current transcript and workspace state because provider processes were not auto-resumed after restart.',
    '',
    'Interrupted round prompt:',
    queue.prompt
  ]

  if (record.snapshot.lastRoundSummary) {
    lines.push('', 'Prior round summary:', record.snapshot.lastRoundSummary)
  }

  if (record.snapshot.openTasks.length > 0) {
    lines.push('', 'Open tasks:')
    for (const task of record.snapshot.openTasks) {
      lines.push(`- ${task}`)
    }
  }

  if (queue.queuedPrompts.length > 0) {
    lines.push('', 'Queued prompts at checkpoint:')
    for (const prompt of queue.queuedPrompts) {
      lines.push(`- ${truncateOneLine(prompt, 220)}`)
    }
  }

  const active = queue.participants.find((participant) => participant.participantId === queue.activeParticipantId)
  if (active) {
    lines.push(
      '',
      `Active participant at checkpoint: ${active.role || active.provider} (${active.provider}) was ${active.status}.`
    )
  }

  return lines.join('\n')
}

export class SessionCheckpointStore {
  private readonly storagePath?: string
  private readonly now: () => string
  private readonly idFactory: () => string
  private readonly log: (line: string) => void
  private records: SessionCheckpointRecord[] = []

  constructor(options: SessionCheckpointStoreOptions = {}) {
    this.storagePath = options.storagePath
    this.now = options.now ?? (() => new Date().toISOString())
    this.idFactory = options.idFactory ?? (() => randomUUID())
    this.log = options.log ?? (() => {})
    if (this.storagePath) {
      this.records = this.readFromDisk()
    }
  }

  list(): SessionCheckpointRecord[] {
    return cloneArray(this.records)
  }

  latestForChat(chatId: string): SessionCheckpointRecord | null {
    const matching = this.records
      .filter((record) => record.chatId === chatId && record.status === 'available')
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    return matching[0] ? cloneRecord(matching[0]) : null
  }

  upsertFromChat(chat: ChatRecord, reason: SessionCheckpointReason): SessionCheckpointRecord | null {
    const round = chat.ensemble?.activeRound
    if (!round) return null
    const id = stableCheckpointId(chat.appChatId, round.roundId)
    const existing = this.records.find((record) => record.id === id)
    const record = buildSessionCheckpointFromChat(chat, reason, this.now(), existing)
    if (!record) return null
    this.records = this.records.map((row) =>
      row.chatId === chat.appChatId && row.id !== record.id && row.status === 'available'
        ? {
            ...row,
            status: 'superseded' as const,
            supersededAt: record.updatedAt,
            updatedAt: record.updatedAt
          }
        : row
    )
    const index = this.records.findIndex((row) => row.id === record.id)
    if (index >= 0) {
      this.records[index] = record
    } else {
      this.records.push(record)
    }
    this.persist()
    return cloneRecord(record)
  }

  completeRound(
    chatId: string,
    roundId: string,
    status: Extract<EnsembleRoundState['status'], 'completed' | 'cancelled' | 'failed'>
  ): SessionCheckpointRecord | null {
    const index = this.records.findIndex(
      (record) =>
        record.chatId === chatId && record.roundId === roundId && record.status === 'available'
    )
    if (index < 0) return null
    const updatedAt = this.now()
    const reason: SessionCheckpointReason =
      status === 'completed'
        ? 'round-completed'
        : status === 'cancelled'
          ? 'round-cancelled'
          : 'round-failed'
    const updated: SessionCheckpointRecord = {
      ...this.records[index],
      status: 'superseded',
      reason,
      supersededAt: updatedAt,
      updatedAt
    }
    this.records[index] = updated
    this.persist()
    return cloneRecord(updated)
  }

  accept(id: string): { checkpoint: SessionCheckpointRecord; resumePrompt: string } | null {
    const updated = this.transition(id, 'accepted')
    return updated
      ? {
          checkpoint: updated,
          resumePrompt: formatSessionCheckpointResumePrompt(updated)
        }
      : null
  }

  dismiss(id: string): SessionCheckpointRecord | null {
    return this.transition(id, 'dismissed')
  }

  private transition(
    id: string,
    status: Extract<SessionCheckpointStatus, 'accepted' | 'dismissed'>
  ): SessionCheckpointRecord | null {
    const index = this.records.findIndex((record) => record.id === id)
    if (index < 0) return null
    const updatedAt = this.now()
    const updated: SessionCheckpointRecord = {
      ...this.records[index],
      status,
      updatedAt,
      ...(status === 'accepted' ? { acceptedAt: updatedAt } : { dismissedAt: updatedAt })
    }
    this.records[index] = updated
    this.persist()
    return cloneRecord(updated)
  }

  private readFromDisk(): SessionCheckpointRecord[] {
    if (!this.storagePath || !existsSync(this.storagePath)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.storagePath, 'utf-8')) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.filter(isSessionCheckpointRecord)
    } catch (err) {
      this.log(
        `[SessionCheckpointStore] load failed (starting empty): ${err instanceof Error ? err.message : String(err)}`
      )
      return []
    }
  }

  private persist(): void {
    if (!this.storagePath) return
    try {
      mkdirSync(dirname(this.storagePath), { recursive: true })
      const tmpPath = `${this.storagePath}.${this.idFactory()}.tmp`
      writeFileSync(tmpPath, JSON.stringify(this.records), 'utf-8')
      renameSync(tmpPath, this.storagePath)
    } catch (err) {
      this.log(
        `[SessionCheckpointStore] persist failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
}

function stableCheckpointId(chatId: string, roundId: string): string {
  return `session-checkpoint-${chatId}-${roundId}`
}

function cleanOptionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function extractOpenTasks(chat: ChatRecord, round: EnsembleRoundState): string[] {
  const out: string[] = []
  const workSession = chat.ensemble?.workSession
  if (workSession?.enabled && workSession.status !== 'idle') {
    pushTask(out, `Objective: ${workSession.objective}`)
    pushTask(out, `Acceptance: ${workSession.acceptanceCriteria}`)
    pushTask(out, `Session status: ${workSession.status}`)
  }
  for (const prompt of round.queuedPrompts || []) {
    pushTask(out, `Queued: ${truncateOneLine(prompt, 220)}`)
  }
  for (const entry of chat.ensemble?.blackboard || []) {
    if (entry.category === 'risk' || entry.category === 'note') {
      pushTask(out, `${entry.category}: ${entry.value}`)
    }
  }
  const summary = cleanOptionalText(chat.ensemble?.lastRoundSummary)
  if (summary) {
    for (const line of summary.split(/\r?\n/)) {
      const task = line.replace(/^\s*[-*]\s*/, '').trim()
      if (/^(next action|open risk|risk|todo|remaining|blocked|follow[- ]?up)\b/i.test(task)) {
        pushTask(out, task)
      }
    }
  }
  if (out.length === 0) {
    const active = round.participants.find((participant) => participant.participantId === round.activeParticipantId)
    if (active) pushTask(out, `${active.role || active.provider} was ${active.status}`)
  }
  return out.slice(0, 12)
}

function pushTask(out: string[], value: string): void {
  const trimmed = truncateOneLine(value, 260)
  if (!trimmed) return
  if (!out.includes(trimmed)) out.push(trimmed)
}

function truncateOneLine(value: string, maxLength: number): string {
  const oneLine = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength - 1)}…` : oneLine
}

function cloneArray<T>(value: T[]): T[] {
  return JSON.parse(JSON.stringify(value)) as T[]
}

function cloneRecord(record: SessionCheckpointRecord): SessionCheckpointRecord {
  return JSON.parse(JSON.stringify(record)) as SessionCheckpointRecord
}

function isSessionCheckpointRecord(value: unknown): value is SessionCheckpointRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const snapshot = record.snapshot as Record<string, unknown> | undefined
  const queueState = snapshot?.queueState as Record<string, unknown> | undefined
  return (
    record.schemaVersion === SESSION_CHECKPOINT_SCHEMA_VERSION &&
    typeof record.id === 'string' &&
    typeof record.chatId === 'string' &&
    typeof record.roundId === 'string' &&
    (record.status === 'available' ||
      record.status === 'accepted' ||
      record.status === 'dismissed' ||
      record.status === 'superseded') &&
    typeof record.reason === 'string' &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string' &&
    Number.isFinite(Date.parse(record.createdAt)) &&
    Number.isFinite(Date.parse(record.updatedAt)) &&
    Boolean(snapshot) &&
    Array.isArray(snapshot?.blackboard) &&
    Array.isArray(snapshot?.openTasks) &&
    Boolean(queueState) &&
    typeof queueState?.prompt === 'string' &&
    Array.isArray(queueState?.participants) &&
    Array.isArray(queueState?.queuedPrompts)
  )
}
