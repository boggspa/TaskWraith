/*
 * Dedicated daily Thread Introspection scheduler.
 *
 * Read-only: invokes runManualIntrospection with trigger='scheduled' over a
 * rolling 24h window. Idempotent per workspace per calendar day.
 */

import type {
  IntrospectionRunRecord,
  IntrospectionScheduleRecord,
  IntrospectionScheduleSettings
} from '../store/types'
import type { RunManualIntrospectionInput, RunManualIntrospectionResult } from './IntrospectionRunService'

export const INTROSPECTION_SCHEDULE_INTERVAL_MS = 24 * 60 * 60 * 1000

const MAX_TEXT = 120

function text(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : undefined
}

function iso(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

export function scheduleWorkspaceKey(workspaceId?: string | null): string {
  return text(workspaceId, MAX_TEXT) || ''
}

export function calendarDayKey(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10)
}

export function normalizeIntrospectionScheduleRecord(
  value: unknown
): IntrospectionScheduleRecord | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<IntrospectionScheduleRecord>
  const nowIso = new Date().toISOString()
  const workspaceId = scheduleWorkspaceKey(input.workspaceId)
  const enabled = input.enabled === true
  const lastRunAt = text(input.lastRunAt, 64)
  const nextRunAt = text(input.nextRunAt, 64)
  return {
    schemaVersion: 1,
    workspaceId,
    enabled,
    createdAt: iso(input.createdAt, nowIso),
    updatedAt: iso(input.updatedAt, nowIso),
    ...(lastRunAt ? { lastRunAt } : {}),
    ...(nextRunAt ? { nextRunAt } : {})
  }
}

export function toIntrospectionScheduleSettings(
  record: IntrospectionScheduleRecord | null,
  workspaceId?: string | null
): IntrospectionScheduleSettings {
  const scopedWorkspaceId = scheduleWorkspaceKey(workspaceId)
  if (!record || record.workspaceId !== scopedWorkspaceId) {
    return {
      enabled: false,
      workspaceId: scopedWorkspaceId || null,
      lastRunAt: null,
      nextRunAt: null
    }
  }
  return {
    enabled: record.enabled,
    workspaceId: record.workspaceId || null,
    lastRunAt: record.lastRunAt ?? null,
    nextRunAt: record.nextRunAt ?? null
  }
}

export function computeNextIntrospectionRunAt(
  enabled: boolean,
  lastRunAt: string | null | undefined,
  nowMs: number
): string | null {
  if (!enabled) return null
  if (!lastRunAt) return new Date(nowMs).toISOString()
  const lastMs = Date.parse(lastRunAt)
  if (!Number.isFinite(lastMs)) return new Date(nowMs).toISOString()
  return new Date(lastMs + INTROSPECTION_SCHEDULE_INTERVAL_MS).toISOString()
}

export function buildRolling24hWindow(nowIso: string): { windowStart: string; windowEnd: string } {
  const windowEndMs = Date.parse(nowIso)
  const endMs = Number.isFinite(windowEndMs) ? windowEndMs : Date.now()
  return {
    windowStart: new Date(endMs - INTROSPECTION_SCHEDULE_INTERVAL_MS).toISOString(),
    windowEnd: new Date(endMs).toISOString()
  }
}

export function isIntrospectionScheduleDue(
  schedule: Pick<IntrospectionScheduleSettings, 'enabled' | 'nextRunAt'>,
  nowMs: number
): boolean {
  if (!schedule.enabled || !schedule.nextRunAt) return false
  const nextMs = Date.parse(schedule.nextRunAt)
  return Number.isFinite(nextMs) && nextMs <= nowMs
}

export function hasScheduledIntrospectionForDay(
  runs: IntrospectionRunRecord[],
  workspaceId: string | undefined,
  dayKey: string
): boolean {
  const scopedKey = scheduleWorkspaceKey(workspaceId)
  return runs.some((run) => {
    if (run.trigger !== 'scheduled') return false
    const runWorkspaceKey = scheduleWorkspaceKey(run.workspaceId)
    if (scopedKey && runWorkspaceKey !== scopedKey) return false
    return calendarDayKey(run.createdAt) === dayKey
  })
}

export function getNextIntrospectionScheduleRunAtMs(
  records: readonly IntrospectionScheduleRecord[],
  _nowMs = Date.now()
): number | null {
  const candidates: number[] = []
  for (const record of records) {
    if (!record.enabled || !record.nextRunAt) continue
    const nextMs = Date.parse(record.nextRunAt)
    if (Number.isFinite(nextMs)) candidates.push(nextMs)
  }
  if (candidates.length === 0) return null
  return Math.min(...candidates)
}

export interface IntrospectionSchedulerStore {
  getIntrospectionScheduleRecords: () => IntrospectionScheduleRecord[]
  updateIntrospectionScheduleRecord: (
    partial: Partial<IntrospectionScheduleSettings> & { workspaceId?: string | null }
  ) => IntrospectionScheduleSettings
  getIntrospectionRuns: (workspaceId?: string) => IntrospectionRunRecord[]
  getWorkspacePath: (workspaceId: string) => string | undefined
  runManualIntrospection: (input: RunManualIntrospectionInput) => RunManualIntrospectionResult
}

export interface DispatchDueIntrospectionSchedulesResult {
  workspaceId: string | null
  skipped: boolean
  reason?: 'already_ran_today' | 'disabled' | 'not_due'
  packId?: string
  evidenceCount?: number
  proposalCount?: number
}

export function dispatchDueIntrospectionSchedules(
  store: IntrospectionSchedulerStore,
  nowMs = Date.now()
): DispatchDueIntrospectionSchedulesResult[] {
  const nowIso = new Date(nowMs).toISOString()
  const dayKey = calendarDayKey(nowIso)
  const results: DispatchDueIntrospectionSchedulesResult[] = []

  for (const record of store.getIntrospectionScheduleRecords()) {
    const settings = toIntrospectionScheduleSettings(record, record.workspaceId)
    if (!isIntrospectionScheduleDue(settings, nowMs)) {
      results.push({
        workspaceId: settings.workspaceId ?? null,
        skipped: true,
        reason: 'not_due'
      })
      continue
    }

    const workspaceId = settings.workspaceId || undefined
    const scopedRuns = store.getIntrospectionRuns(workspaceId)
    if (hasScheduledIntrospectionForDay(scopedRuns, workspaceId, dayKey)) {
      store.updateIntrospectionScheduleRecord({
        workspaceId: settings.workspaceId,
        lastRunAt: nowIso,
        nextRunAt: computeNextIntrospectionRunAt(true, nowIso, nowMs)
      })
      results.push({
        workspaceId: settings.workspaceId ?? null,
        skipped: true,
        reason: 'already_ran_today'
      })
      continue
    }

    const window = buildRolling24hWindow(nowIso)
    const workspacePath = workspaceId ? store.getWorkspacePath(workspaceId) : undefined
    const outcome = store.runManualIntrospection({
      ...window,
      workspaceId,
      workspacePath,
      trigger: 'scheduled'
    })

    store.updateIntrospectionScheduleRecord({
      workspaceId: settings.workspaceId,
      enabled: true,
      lastRunAt: nowIso,
      nextRunAt: computeNextIntrospectionRunAt(true, nowIso, nowMs)
    })

    results.push({
      workspaceId: settings.workspaceId ?? null,
      skipped: false,
      packId: outcome.pack.id,
      evidenceCount: outcome.evidenceCount,
      proposalCount: outcome.proposalCount
    })
  }

  return results
}

export function mergeIntrospectionScheduleUpdate(
  existing: IntrospectionScheduleRecord | null,
  partial: Partial<IntrospectionScheduleSettings> & { workspaceId?: string | null },
  nowIso: string,
  nowMs = Date.now()
): IntrospectionScheduleRecord {
  const workspaceId = scheduleWorkspaceKey(partial.workspaceId ?? existing?.workspaceId)
  const enabled = partial.enabled ?? existing?.enabled ?? false
  const lastRunAt =
    partial.lastRunAt === null
      ? undefined
      : text(partial.lastRunAt, 64) ?? existing?.lastRunAt
  const explicitNextRunAt =
    partial.nextRunAt === null
      ? null
      : text(partial.nextRunAt, 64) ?? undefined
  const nextRunAt =
    explicitNextRunAt === null
      ? undefined
      : explicitNextRunAt ??
        computeNextIntrospectionRunAt(enabled, lastRunAt ?? null, nowMs) ??
        undefined

  return {
    schemaVersion: 1,
    workspaceId,
    enabled,
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
    ...(lastRunAt ? { lastRunAt } : {}),
    ...(nextRunAt ? { nextRunAt } : {})
  }
}