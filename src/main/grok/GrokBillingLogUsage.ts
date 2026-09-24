import { open } from 'node:fs/promises'
import type { GrokUsageSnapshot } from './GrokUsage'

const MAX_LOG_TAIL_BYTES = 1_000_000
const ACTIVE_PERIOD_SKEW_MS = 5 * 60 * 1000
const WEEKLY_MAX_DURATION_MS = 8 * 24 * 60 * 60 * 1000

interface BillingPeriod {
  type?: unknown
  start?: unknown
  end?: unknown
}

interface BillingConfig {
  creditUsagePercent?: unknown
  currentPeriod?: BillingPeriod
  billingPeriodStart?: unknown
  billingPeriodEnd?: unknown
}

interface BillingLogEntry {
  ts?: unknown
  msg?: unknown
  ctx?: {
    config?: BillingConfig
    subscriptionTier?: unknown
    onDemandEnabled?: unknown
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function finitePercent(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value.replace(/%/g, '').trim())
        : Number.NaN
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null
}

function isoDate(value: unknown): string | null {
  const raw = nonEmptyString(value)
  if (!raw) return null
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function compactPercent(value: number): string {
  return Number.isInteger(value) ? `${value}%` : `${Number(value.toFixed(2))}%`
}

function periodBounds(config: BillingConfig): { start: string | null; end: string | null } {
  return {
    start: isoDate(config.currentPeriod?.start ?? config.billingPeriodStart),
    end: isoDate(config.currentPeriod?.end ?? config.billingPeriodEnd)
  }
}

function sameBillingPeriod(left: BillingConfig, right: BillingConfig): boolean {
  const lhs = periodBounds(left)
  const rhs = periodBounds(right)
  if ((!lhs.start && !lhs.end) || (!rhs.start && !rhs.end)) return false
  return lhs.start === rhs.start && lhs.end === rhs.end
}

function periodDurationSeconds(start: string | null, end: string | null): number | null {
  if (!start || !end) return null
  const duration = Date.parse(end) - Date.parse(start)
  return Number.isFinite(duration) && duration > 0 ? duration / 1000 : null
}

function isBillingConfigEntry(value: unknown): value is BillingLogEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as BillingLogEntry
  return (
    typeof entry.msg === 'string' &&
    entry.msg.toLowerCase().includes('billing: fetched credits config') &&
    Boolean(entry.ctx?.config && typeof entry.ctx.config === 'object')
  )
}

function priorUsageInSamePeriod(
  entries: readonly BillingLogEntry[],
  before: number,
  target: BillingConfig
): number | null {
  for (let index = before - 1; index >= 0; index -= 1) {
    const candidate = entries[index]
    const config = candidate.ctx?.config
    if (!config || !sameBillingPeriod(config, target)) continue
    const usage = finitePercent(config.creditUsagePercent)
    if (usage !== null) return usage
  }
  return null
}

function snapshotFromEntry(
  entry: BillingLogEntry,
  priorUsage: number | null,
  now: Date
): GrokUsageSnapshot | null {
  const config = entry.ctx?.config
  if (!config) return null
  const bounds = periodBounds(config)
  const durationSeconds = periodDurationSeconds(bounds.start, bounds.end)
  const periodType = nonEmptyString(config.currentPeriod?.type)?.toUpperCase() ?? ''
  const isWeekly =
    periodType.includes('WEEKLY') ||
    (durationSeconds !== null && durationSeconds * 1000 <= WEEKLY_MAX_DURATION_MS)
  const startMs = bounds.start ? Date.parse(bounds.start) : Number.NaN
  const endMs = bounds.end ? Date.parse(bounds.end) : Number.NaN
  const isActive =
    Number.isFinite(startMs) &&
    Number.isFinite(endMs) &&
    startMs <= now.getTime() + ACTIVE_PERIOD_SKEW_MS &&
    endMs > now.getTime() - ACTIVE_PERIOD_SKEW_MS
  const reportedUsage = finitePercent(config.creditUsagePercent)
  const used =
    reportedUsage ??
    priorUsage ??
    // During an X Premium ↔ SuperGrok transition the first metadata row for
    // the newly-active weekly period can omit creditUsagePercent. Its dated
    // active period is authoritative evidence of a reset, not “unavailable”.
    (isWeekly && isActive ? 0 : null)
  if (used === null) return null

  const refreshedAt = isoDate(entry.ts) ?? now.toISOString()
  const planLabel = nonEmptyString(entry.ctx?.subscriptionTier)
  const display = compactPercent(used)
  return {
    provider: 'grok',
    source: 'grok-cli-billing-log',
    usageKind: isWeekly ? 'weekly_limit' : 'subscription_credits',
    creditsUsedPercent: used,
    creditsUsedDisplay: display,
    resetAtText: null,
    resetAt: bounds.end,
    limitWindowSeconds: durationSeconds,
    periodStartAt: bounds.start,
    periodEndAt: bounds.end,
    planLabel,
    payAsYouGoEnabled:
      typeof entry.ctx?.onDemandEnabled === 'boolean' ? entry.ctx.onDemandEnabled : null,
    refreshedAt,
    confidence: 'observed'
  }
}

/**
 * Coalesce the Grok CLI billing log onto the newest active billing metadata.
 * A later row wins for plan/period identity, while a missing percentage may
 * inherit only from the exact same period. This prevents upgrade transitions
 * from pairing the old SuperGrok percentage with the new X Premium window.
 */
export function parseGrokBillingLogUsage(
  text: string,
  now: Date = new Date()
): GrokUsageSnapshot | null {
  const entries = String(text || '')
    .split('\n')
    .flatMap((line): BillingLogEntry[] => {
      if (!line.includes('billing: fetched credits config')) return []
      try {
        const parsed = JSON.parse(line) as unknown
        return isBillingConfigEntry(parsed) ? [parsed] : []
      } catch {
        return []
      }
    })

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    const config = entry.ctx?.config
    if (!config) continue
    const snapshot = snapshotFromEntry(entry, priorUsageInSamePeriod(entries, index, config), now)
    if (snapshot) return snapshot
  }
  return null
}

function activePeriodScore(snapshot: GrokUsageSnapshot, now: number): number {
  if (snapshot.confidence !== 'observed') return -1
  const start = snapshot.periodStartAt ? Date.parse(snapshot.periodStartAt) : Number.NaN
  const end = snapshot.periodEndAt
    ? Date.parse(snapshot.periodEndAt)
    : snapshot.resetAt
      ? Date.parse(snapshot.resetAt)
      : Number.NaN
  if (Number.isFinite(end) && end <= now - ACTIVE_PERIOD_SKEW_MS) return 0
  if (Number.isFinite(start) && start > now + ACTIVE_PERIOD_SKEW_MS) return 0
  if (Number.isFinite(end)) return 3
  return 1
}

/**
 * Pick the observation belonging to the active billing account/period. The
 * TUI remains the preferred live source when both candidates describe the
 * same reset, while a log row for a newer active period beats stale TUI
 * metadata left behind during a subscription upgrade.
 */
export function coalesceGrokUsageToActivePeriod(
  tuiSnapshot: GrokUsageSnapshot,
  billingLogSnapshot: GrokUsageSnapshot | null,
  now: Date = new Date()
): GrokUsageSnapshot {
  if (!billingLogSnapshot) return tuiSnapshot
  const candidates = [tuiSnapshot, billingLogSnapshot]
  const ranked = candidates
    .map((snapshot, index) => ({
      snapshot,
      index,
      active: activePeriodScore(snapshot, now.getTime()),
      reset: snapshot.resetAt ? Date.parse(snapshot.resetAt) : Number.NEGATIVE_INFINITY,
      refreshed: Date.parse(snapshot.refreshedAt)
    }))
    .sort(
      (left, right) =>
        right.active - left.active ||
        right.reset - left.reset ||
        right.refreshed - left.refreshed ||
        left.index - right.index
    )
  return ranked[0]?.snapshot ?? tuiSnapshot
}

/** Read only the bounded tail of ~/.grok/logs/unified.jsonl. */
export async function readGrokBillingLogUsage(
  logPath: string,
  now: Date = new Date()
): Promise<GrokUsageSnapshot | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(logPath, 'r')
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size <= 0) return null
    const offset = Math.max(0, stat.size - MAX_LOG_TAIL_BYTES)
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_LOG_TAIL_BYTES))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
    let text = buffer.subarray(0, bytesRead).toString('utf8')
    if (offset > 0) {
      const firstNewline = text.indexOf('\n')
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : ''
    }
    return parseGrokBillingLogUsage(text, now)
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}
