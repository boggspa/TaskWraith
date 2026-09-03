/*
 * DevinUsage — Devin plan quota snapshot (daily + weekly windows).
 *
 * Devin's CLI is an ACP stdio server with no TUI and no /usage surface, and
 * the public REST API (docs.devin.ai /v3/consumption/*) only exposes ACU
 * consumption telemetry — no time-boxed quota windows. The real source for
 * the daily/weekly plan quotas is the Devin desktop client's local SQLite
 * state DB, exactly as the standalone "Limit Counter" reference app reads
 * it:
 *
 *   ~/Library/Application Support/Devin/User/globalStorage/state.vscdb
 *   SQLite ItemTable, value is a JSON blob holding the cached plan info.
 *
 * Key families tried (DEVIN_PLAN_INFO_SQL), in priority order — this
 * mirrors DevinLocalStateReader in the reference app
 * (ProviderClient.swift, loadAllCachedPlanInfos + decodeAllRows):
 *   1. reactSettings.cachedPlanInfoData:user-*  (current Devin format)
 *   2. devin./windsurf./codeium. settings.cachedPlanInfo, or any
 *      '%PlanInfo%' key                              (legacy format)
 *   3. '%AuthStatus%' keys                           (last resort — these
 *      normally carry credentials; some builds nest planInfo inside)
 * The row value IS the plan-info object in formats 1/2; format 3 wraps it
 * under a `planInfo` key, which parseDevinPlanInfoBlob unwraps.
 *
 * Two traps this module is built around (each has a named test):
 *  - THE INVERSION: the DB stores REMAINING percent; the meter wants USED.
 *    used = 100 - remaining.
 *  - THE HIDE FLAGS: hideDailyQuota / hideWeeklyQuota mean the plan has no
 *    such window at all — emit NO window, never a fabricated 0%/100%.
 *
 * Safety: read-only. The host injects a `readPlanInfoRows` query runner
 * (index.ts shells out to the macOS /usr/bin/sqlite3 CLI with a read-only
 * URI, the same pattern as MuseSessionLog.ts), so this module stays pure,
 * unit-testable with no sqlite and no real DB, and we never bundle a
 * native SQLite dependency. macOS-only: the DB path is a macOS path and
 * other platforms are unowned, so they return `configured: false`.
 */

export interface DevinUsageWindow {
  id: string
  label: string
  limitLabel: string
  /** 0..100 percent of this window consumed (DB remaining percent inverted). */
  usedPercent: number
  /** ISO timestamp of the window reset. */
  resetAt?: string
  /** Window length in seconds — daily 86400 (6 dashes), weekly 604800 (7). */
  limitWindowSeconds?: number
}

export interface DevinUsageSnapshot {
  provider: 'devin'
  source: string
  windows: DevinUsageWindow[]
  balances: never[]
  /** true once a readable state DB yielded a plan-info blob. */
  configured: boolean
  error?: string
  /** ISO timestamp the snapshot was produced. */
  fetchedAt: string
  /** Plan display name from the cached plan info (for example `Core`). */
  planType?: string
}

/** macOS path of the Devin desktop client's global-storage SQLite DB. */
export const DEVIN_STATE_DB_RELATIVE =
  'Library/Application Support/Devin/User/globalStorage/state.vscdb'

export const DEVIN_USAGE_SOURCE = 'devin-state-vscdb'
export const DEVIN_DAILY_WINDOW_SECONDS = 24 * 60 * 60
export const DEVIN_WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60

/**
 * Candidate DB paths to try in order: the live DB then the client's
 * `.backup` (the reference app falls back to the backup when the live file
 * is locked / mid-write).
 */
export function devinStateDbCandidates(homeDir: string): string[] {
  const base = `${homeDir.replace(/\/+$/, '')}/${DEVIN_STATE_DB_RELATIVE}`
  return [base, `${base}.backup`]
}

/**
 * Read every candidate plan-info row, best keys first. Rows that do not
 * carry a plan-info shape are skipped by the parser, so over-matching keys
 * (AuthStatus blobs without planInfo) are harmless.
 */
export const DEVIN_PLAN_INFO_SQL = `
SELECT value FROM ItemTable
WHERE key LIKE '%reactSettings.cachedPlanInfoData:user-%'
   OR key IN ('devin.settings.cachedPlanInfo', 'windsurf.settings.cachedPlanInfo', 'codeium.settings.cachedPlanInfo', 'cachedPlanInfo')
   OR key LIKE '%PlanInfo%'
   OR key LIKE '%AuthStatus%'
ORDER BY CASE
  WHEN key LIKE '%reactSettings.cachedPlanInfoData%' THEN 0
  WHEN key LIKE 'devin.%' THEN 1
  WHEN key LIKE 'windsurf.%' THEN 2
  WHEN key LIKE 'codeium.%' THEN 3
  WHEN key LIKE '%PlanInfo%' THEN 4
  ELSE 5
END;
`

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

function unixSecondsToIso(value: unknown): string | undefined {
  const seconds = finiteNumber(value)
  if (seconds === undefined || seconds <= 0) return undefined
  const date = new Date(seconds * 1000)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** planInfo.endTimestamp is milliseconds since epoch (reference app divides by 1000). */
function epochMsToIso(value: unknown): string | undefined {
  const ms = finiteNumber(value)
  if (ms === undefined || ms <= 0) return undefined
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

export interface DevinParsedPlanInfo {
  windows: DevinUsageWindow[]
  planName?: string
}

/**
 * Pure parser: turn one cached plan-info JSON payload into the daily and
 * weekly quota windows. Defensive — a payload without any plan-info shape
 * yields no windows, so callers can skip non-matching rows.
 */
export function parseDevinPlanInfoBlob(payload: unknown): DevinParsedPlanInfo {
  const root = record(payload)
  if (!root) return { windows: [] }
  // AuthStatus-shaped rows wrap the plan info; cachedPlanInfo rows ARE it.
  const planInfo = record(root.planInfo) ?? root

  const hasPlanShape =
    typeof planInfo.planName === 'string' ||
    record(planInfo.quotaUsage) !== null ||
    record(planInfo.usage) !== null
  if (!hasPlanShape) return { windows: [] }

  const planName =
    typeof planInfo.planName === 'string' && planInfo.planName.trim()
      ? planInfo.planName.trim()
      : undefined
  const quotaUsage = record(planInfo.quotaUsage)
  const usage = record(planInfo.usage)
  const endResetIso = epochMsToIso(planInfo.endTimestamp)

  const windows: DevinParsedPlanInfo['windows'] = []

  // Daily: prefer quotaUsage (remaining percent + reset); fall back to the
  // messages counters. used = 100 - remaining — the DB stores REMAINING.
  const dailyRemaining = finiteNumber(quotaUsage?.dailyRemainingPercent)
  const dailyResetAt = unixSecondsToIso(quotaUsage?.dailyResetAtUnix) ?? endResetIso
  let dailyUsedPercent: number | undefined
  if (dailyRemaining !== undefined) {
    dailyUsedPercent = clampPercent(100 - dailyRemaining)
  } else if (usage) {
    const messages = finiteNumber(usage.messages)
    const usedMessages = finiteNumber(usage.usedMessages)
    if (messages !== undefined && messages > 0 && usedMessages !== undefined) {
      dailyUsedPercent = clampPercent((usedMessages / messages) * 100)
    }
  }
  if (planInfo.hideDailyQuota !== true && dailyUsedPercent !== undefined) {
    windows.push({
      id: 'devin-daily',
      label: planName ? `Daily quota (${planName})` : 'Daily quota usage',
      limitLabel: 'Today',
      usedPercent: dailyUsedPercent,
      ...(dailyResetAt ? { resetAt: dailyResetAt } : {}),
      limitWindowSeconds: DEVIN_DAILY_WINDOW_SECONDS
    })
  }

  // Weekly: same inversion and fallback shape, via flowActions counters.
  const weeklyRemaining = finiteNumber(quotaUsage?.weeklyRemainingPercent)
  const weeklyResetAt = unixSecondsToIso(quotaUsage?.weeklyResetAtUnix) ?? endResetIso
  let weeklyUsedPercent: number | undefined
  if (weeklyRemaining !== undefined) {
    weeklyUsedPercent = clampPercent(100 - weeklyRemaining)
  } else if (usage) {
    const flowActions = finiteNumber(usage.flowActions)
    const usedFlowActions = finiteNumber(usage.usedFlowActions)
    if (flowActions !== undefined && flowActions > 0 && usedFlowActions !== undefined) {
      weeklyUsedPercent = clampPercent((usedFlowActions / flowActions) * 100)
    }
  }
  if (planInfo.hideWeeklyQuota !== true && weeklyUsedPercent !== undefined) {
    windows.push({
      id: 'devin-weekly',
      label: planName ? `Weekly quota (${planName})` : 'Weekly quota usage',
      limitLabel: 'This week',
      usedPercent: weeklyUsedPercent,
      ...(weeklyResetAt ? { resetAt: weeklyResetAt } : {}),
      limitWindowSeconds: DEVIN_WEEKLY_WINDOW_SECONDS
    })
  }

  return { windows, ...(planName ? { planName } : {}) }
}

/** True when a row's JSON parses to something carrying a plan-info shape. */
export function isDevinPlanInfoBlob(payload: unknown): boolean {
  const parsed = parseDevinPlanInfoBlob(payload)
  return parsed.windows.length > 0 || parsed.planName !== undefined
}

export function buildDevinUsageSnapshot(
  payload: unknown,
  fetchedAtIso: string
): DevinUsageSnapshot {
  const { windows, planName } = parseDevinPlanInfoBlob(payload)
  return {
    provider: 'devin',
    source: DEVIN_USAGE_SOURCE,
    windows,
    balances: [],
    configured: true,
    fetchedAt: fetchedAtIso,
    ...(planName ? { planType: planName } : {})
  }
}

export function emptyDevinUsageSnapshot(
  fetchedAtIso: string,
  opts: { configured: boolean; error?: string } = { configured: false }
): DevinUsageSnapshot {
  return {
    provider: 'devin',
    source: DEVIN_USAGE_SOURCE,
    windows: [],
    balances: [],
    configured: opts.configured,
    error: opts.error,
    fetchedAt: fetchedAtIso
  }
}

export interface DevinUsageLoadDeps {
  /**
   * Run DEVIN_PLAN_INFO_SQL against the first readable candidate DB and
   * resolve the raw row values (JSON strings), best keys first. Resolves
   * [] when the DB is missing, unreadable, or holds no matching keys.
   */
  readPlanInfoRows: () => Promise<string[]>
  /** Injectable clock (defaults to Date.now). */
  now?: () => number
  /** Injectable platform (defaults to process.platform) for testing. */
  platform?: NodeJS.Platform
}

/**
 * Orchestrate a single local read. Never throws: non-macOS platforms and a
 * missing/unreadable DB yield `configured: false`; a DB that answers but
 * holds no usable plan info yields `configured: true` with an error, so the
 * UI can distinguish "not installed / not signed in" from "signed in but
 * the cached plan info was absent or unreadable".
 */
export async function loadDevinUsageSnapshot(
  deps: DevinUsageLoadDeps
): Promise<DevinUsageSnapshot> {
  const now = deps.now ?? (() => Date.now())
  const platform = deps.platform ?? process.platform
  const fetchedAtIso = new Date(now()).toISOString()

  if (platform !== 'darwin') {
    return emptyDevinUsageSnapshot(fetchedAtIso, {
      configured: false,
      error: 'Devin plan usage is only available on macOS (local state DB).'
    })
  }

  let rows: string[]
  try {
    rows = await deps.readPlanInfoRows()
  } catch (error) {
    return emptyDevinUsageSnapshot(fetchedAtIso, {
      configured: false,
      error: error instanceof Error ? error.message : 'Devin state DB read failed.'
    })
  }
  if (rows.length === 0) {
    return emptyDevinUsageSnapshot(fetchedAtIso, {
      configured: false,
      error: 'Devin state DB was not found. Open the Devin app while signed in to see usage.'
    })
  }

  for (const row of rows) {
    let payload: unknown
    try {
      payload = JSON.parse(row)
    } catch {
      continue
    }
    if (isDevinPlanInfoBlob(payload)) {
      return buildDevinUsageSnapshot(payload, fetchedAtIso)
    }
  }

  return emptyDevinUsageSnapshot(fetchedAtIso, {
    configured: true,
    error: 'No cached Devin plan info found in the state DB.'
  })
}
