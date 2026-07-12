import type { ProviderId } from './store/types'

export interface NormalizedProviderUsageWindow {
  id: string
  label: string
  runs: number
  totalTokens: number
  limitLabel: string
  resetAt?: string
  trackingOnly: boolean
  usedPercent: number
  remainingPercent?: number
  windowKind?: string
  limitWindowSeconds?: number
  resetAfterSeconds?: number
  sourceModelId?: string
}

export interface NormalizedProviderUsageSnapshot {
  provider: ProviderId
  source: string | null
  configured: boolean
  fetchedAt?: string
  windows?: NormalizedProviderUsageWindow[]
  balances?: Array<{
    label: string
    amount: number
    unit: string
    subtitle?: string
    resetAt?: string
  }>
  stale?: boolean
  error?: string
  planType?: string | null
  subscriptionType?: string
  accountId?: string | null
  importedAt?: string
  encryptionAvailable?: boolean
}

export interface CodexUsageCredentialLike {
  accountId?: string | null
  importedAt?: string
}

export interface ClaudeOAuthCredentialLike {
  subscriptionType?: string
}

export function redactAccountId(accountId?: string | null): string | null {
  const raw = String(accountId || '').trim()
  if (!raw) return null
  return raw.length <= 10 ? raw : `${raw.slice(0, 6)}...${raw.slice(-4)}`
}

export function hasProviderUsageSnapshotContent(snapshot: unknown): boolean {
  const record = usageRecord(snapshot)
  return (
    (Array.isArray(record?.windows) && record.windows.length > 0) ||
    (Array.isArray(record?.balances) && record.balances.length > 0)
  )
}

function usageRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null
}

function numericUsageValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

function parseIsoDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function normalizeCodexUsageWindow(
  id: string,
  label: string,
  windowKind: string,
  window: any
): NormalizedProviderUsageWindow {
  const usedPercent = clampPercent(Number(window?.used_percent ?? window?.usedPercent ?? 0))
  const remainingPercent = clampPercent(100 - usedPercent)
  const resetAtSeconds = Number(window?.reset_at ?? window?.resetAt ?? 0)
  const resetAfterSeconds = Number(window?.reset_after_seconds ?? window?.resetAfterSeconds ?? 0)
  const limitWindowSeconds = Number(window?.limit_window_seconds ?? window?.limitWindowSeconds ?? 0)
  return {
    id,
    label,
    windowKind,
    runs: 0,
    totalTokens: 0,
    limitLabel: `${Math.round(remainingPercent)}% remaining`,
    resetAt: resetAtSeconds > 0 ? new Date(resetAtSeconds * 1000).toISOString() : undefined,
    trackingOnly: false,
    usedPercent,
    remainingPercent,
    limitWindowSeconds: Number.isFinite(limitWindowSeconds) ? limitWindowSeconds : undefined,
    resetAfterSeconds: Number.isFinite(resetAfterSeconds) ? resetAfterSeconds : undefined
  }
}

function codexUsageWindowIdentity(windowEntry: any): string {
  const label = String(windowEntry?.label || '')
    .trim()
    .toLowerCase()
  const windowKind = String(windowEntry?.windowKind || '')
    .trim()
    .toLowerCase()
  if (label === 'session' || label === '5h') return 'aggregate-session'
  if (label === 'weekly') return 'aggregate-weekly'
  return `${windowKind}:${label}`
}

function dedupeCodexUsageWindows(
  windows: NormalizedProviderUsageWindow[]
): NormalizedProviderUsageWindow[] {
  const seen = new Set<string>()
  return windows.filter((windowEntry) => {
    const key = [
      codexUsageWindowIdentity(windowEntry),
      windowEntry.resetAt || '',
      Math.round(Number(windowEntry.remainingPercent || 0))
    ].join(':')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function codexUsageWindowValue(rateLimit: any, kind: 'primary' | 'secondary') {
  if (!rateLimit || typeof rateLimit !== 'object') return null
  if (kind === 'primary') {
    return (
      rateLimit.primary_window ||
      rateLimit.primaryWindow ||
      rateLimit.primary ||
      rateLimit.five_hour_window ||
      rateLimit.fiveHourWindow ||
      null
    )
  }
  return (
    rateLimit.secondary_window ||
    rateLimit.secondaryWindow ||
    rateLimit.secondary ||
    rateLimit.weekly_window ||
    rateLimit.weeklyWindow ||
    null
  )
}

function codexUsageFraction(windowEntry: NormalizedProviderUsageWindow): number {
  return clampPercent(Number(windowEntry.usedPercent || 0)) / 100
}

function codexResetMs(windowEntry: NormalizedProviderUsageWindow): number | null {
  if (!windowEntry.resetAt) return null
  const ms = new Date(windowEntry.resetAt).getTime()
  return Number.isNaN(ms) ? null : ms
}

function staleAggregateResetShiftThreshold(windowEntry: NormalizedProviderUsageWindow): number {
  const durationMs = Math.max(0, Number(windowEntry.limitWindowSeconds || 0) * 1000)
  if (durationMs <= 0) return 30 * 60 * 1000
  return Math.min(Math.max(durationMs * 0.05, 30 * 60 * 1000), 12 * 60 * 60 * 1000)
}

function isStaleCodexAggregateWindow(
  aggregateWindow: NormalizedProviderUsageWindow,
  additionalWindows: NormalizedProviderUsageWindow[],
  now: number = Date.now()
): boolean {
  const aggregateTotal = Number(aggregateWindow.limitWindowSeconds || 0)
  const aggregateReset = codexResetMs(aggregateWindow)
  if (
    aggregateTotal <= 0 ||
    aggregateReset === null ||
    codexUsageFraction(aggregateWindow) < 0.98 ||
    // 1.0.6 — a saturated aggregate window whose reset is still in the FUTURE
    // is legitimately maxed-out, not stale data. The pre-existing predicate
    // (≥98% used + same-bucket Spark sibling at ≤20% with a later reset) was
    // suppressing the Codex Session/5h meter the moment it hit 100%, because
    // the Spark sibling's reset clock is naturally a few minutes-to-hours
    // later than Session's, easily clearing the small (30 min for 5h windows)
    // structural threshold. Stale data is when the BACKEND still reports 100%
    // even though the bucket has already rolled over — i.e. the reset has
    // PASSED. Gate the suppression on that condition so a saturated current
    // window keeps showing while genuinely-stale post-rollover reads still
    // get filtered (testable via the injected `now` arg).
    aggregateReset > now
  ) {
    return false
  }

  const threshold = staleAggregateResetShiftThreshold(aggregateWindow)
  return additionalWindows.some((additionalWindow) => {
    const additionalTotal = Number(additionalWindow.limitWindowSeconds || 0)
    const additionalReset = codexResetMs(additionalWindow)
    return (
      additionalWindow.windowKind === aggregateWindow.windowKind &&
      additionalTotal > 0 &&
      additionalReset !== null &&
      Math.abs(additionalTotal - aggregateTotal) <= Math.max(1, aggregateTotal * 0.05) &&
      codexUsageFraction(additionalWindow) <= 0.2 &&
      additionalReset - aggregateReset >= threshold
    )
  })
}

function reconciledCodexWindows(
  aggregateWindows: NormalizedProviderUsageWindow[],
  additionalWindows: NormalizedProviderUsageWindow[]
): NormalizedProviderUsageWindow[] {
  return [
    ...aggregateWindows.filter(
      (windowEntry) => !isStaleCodexAggregateWindow(windowEntry, additionalWindows)
    ),
    ...additionalWindows
  ]
}

export function normalizeCodexUsagePayload(
  payload: any,
  credential: CodexUsageCredentialLike = {}
): NormalizedProviderUsageSnapshot {
  const aggregateWindows: NormalizedProviderUsageWindow[] = []
  const additionalWindows: NormalizedProviderUsageWindow[] = []
  const rateLimit =
    payload?.rate_limit || payload?.rateLimit || payload?.rate_limits || payload?.rateLimits || {}
  const primaryWindow = codexUsageWindowValue(rateLimit, 'primary')
  const secondaryWindow = codexUsageWindowValue(rateLimit, 'secondary')
  if (primaryWindow) {
    aggregateWindows.push(
      normalizeCodexUsageWindow('primary-5h', 'Session', 'session', primaryWindow)
    )
  }
  if (secondaryWindow) {
    aggregateWindows.push(
      normalizeCodexUsageWindow('secondary-weekly', 'Weekly', 'weekly', secondaryWindow)
    )
  }
  const additional = Array.isArray(payload?.additional_rate_limits)
    ? payload.additional_rate_limits
    : Array.isArray(payload?.additionalRateLimits)
      ? payload.additionalRateLimits
      : []
  additional.forEach((limit: any, index: number) => {
    const rawName =
      String(
        limit?.limit_name ||
          limit?.limitName ||
          limit?.metered_feature ||
          limit?.meteredFeature ||
          'Additional Codex'
      ).trim() || 'Additional Codex'
    const nested = limit?.rate_limit || limit?.rateLimit || {}
    const nestedPrimary = codexUsageWindowValue(nested, 'primary')
    const nestedSecondary = codexUsageWindowValue(nested, 'secondary')
    if (nestedPrimary) {
      additionalWindows.push(
        normalizeCodexUsageWindow(
          `additional-${index}-5h`,
          `${rawName} 5h`,
          'session',
          nestedPrimary
        )
      )
    }
    if (nestedSecondary) {
      additionalWindows.push(
        normalizeCodexUsageWindow(
          `additional-${index}-weekly`,
          `${rawName} Weekly`,
          'weekly',
          nestedSecondary
        )
      )
    }
  })
  const creditBalance = payload?.credits?.balance
  return {
    provider: 'codex',
    configured: true,
    source: 'chatgpt-wham',
    accountId: redactAccountId(credential.accountId),
    importedAt: credential.importedAt,
    fetchedAt: new Date().toISOString(),
    planType: payload?.plan_type || payload?.planType || null,
    windows: dedupeCodexUsageWindows(reconciledCodexWindows(aggregateWindows, additionalWindows)),
    balances:
      creditBalance === undefined || creditBalance === null
        ? []
        : [
            {
              label: 'Credits Remaining',
              amount: Number(creditBalance),
              unit: 'credits'
            }
          ]
  }
}

function kimiDurationLabel(window: unknown): string {
  const record = usageRecord(window)
  const duration = numericUsageValue(record?.duration)
  const unit = String(record?.timeUnit || record?.time_unit || '').toUpperCase()
  if (!duration || !unit) return 'Rolling'
  const rounded = Math.round(duration)
  if (unit.includes('MINUTE')) {
    return rounded % 60 === 0 ? `${Math.round(rounded / 60)}H` : `${rounded}M`
  }
  if (unit.includes('HOUR')) return `${rounded}H`
  if (unit.includes('DAY')) return rounded === 7 ? 'Weekly' : `${rounded}D`
  return 'Rolling'
}

function kimiQuotaWindow(
  id: string,
  label: string,
  detail: unknown
): NormalizedProviderUsageWindow | null {
  const record = usageRecord(detail)
  const limit = numericUsageValue(record?.limit)
  const reportedUsed = numericUsageValue(record?.used)
  const reportedRemaining = numericUsageValue(record?.remaining)
  if (limit === undefined && reportedUsed === undefined && reportedRemaining === undefined) {
    return null
  }
  const usableLimit = limit !== undefined && limit > 0 ? limit : undefined
  const used =
    reportedUsed !== undefined
      ? usableLimit !== undefined
        ? Math.max(0, Math.min(usableLimit, reportedUsed))
        : Math.max(0, reportedUsed)
      : usableLimit !== undefined && reportedRemaining !== undefined
        ? Math.max(0, Math.min(usableLimit, usableLimit - reportedRemaining))
        : undefined
  // Kimi's aggregate weekly response may report `used` without a
  // `remaining` field. Derive the complement so both response shapes keep the
  // same honest contract: usedPercent = USED, remainingPercent = REMAINING.
  const remaining =
    usableLimit !== undefined && used !== undefined
      ? Math.max(0, usableLimit - used)
      : reportedRemaining !== undefined
        ? Math.max(0, reportedRemaining)
        : undefined
  const usedPercent =
    usableLimit !== undefined && used !== undefined ? clampPercent((used / usableLimit) * 100) : 0
  const remainingPercent = clampPercent(100 - usedPercent)
  const limitLabel =
    usableLimit !== undefined && remaining !== undefined
      ? `${Math.round(remaining).toLocaleString()} / ${Math.round(usableLimit).toLocaleString()} remaining`
      : remaining !== undefined
        ? `${Math.round(remaining).toLocaleString()} remaining`
        : `${Math.round(remainingPercent)}% remaining`
  return {
    id,
    label,
    runs: 0,
    totalTokens: 0,
    limitLabel,
    resetAt: parseIsoDate(
      record?.resetTime ?? record?.reset_time ?? record?.resetAt ?? record?.reset_at
    ),
    trackingOnly: false,
    usedPercent,
    remainingPercent
  }
}

export function normalizeKimiUsageSnapshot(payload: unknown): NormalizedProviderUsageSnapshot {
  const record = usageRecord(payload)
  const windows: NormalizedProviderUsageWindow[] = []
  const balances: NormalizedProviderUsageSnapshot['balances'] = []
  const rawLimits = record?.limits
  const limits: unknown[] = Array.isArray(rawLimits) ? rawLimits : []
  limits.forEach((limit, index) => {
    const limitRecord = usageRecord(limit)
    const detail = usageRecord(limitRecord?.detail) ?? limitRecord
    const windowEntry = kimiQuotaWindow(
      `kimi-limit-${index}`,
      kimiDurationLabel(limitRecord?.window),
      detail
    )
    if (windowEntry) windows.push(windowEntry)
  })
  const usage = usageRecord(record?.usage)
  if (usage) {
    const weekly = kimiQuotaWindow('kimi-weekly', 'Weekly', usage)
    if (weekly) windows.push(weekly)
  }
  const totalQuota = usageRecord(record?.totalQuota ?? record?.total_quota)
  const totalRemaining = numericUsageValue(totalQuota?.remaining)
  if (totalRemaining !== undefined) {
    const totalLimit = numericUsageValue(totalQuota?.limit)
    balances.push({
      label: 'Total Quota',
      amount: totalRemaining,
      unit: 'quota',
      subtitle:
        totalLimit !== undefined
          ? `${Math.round(totalLimit).toLocaleString()} total membership quota`
          : undefined
    })
  }
  return {
    provider: 'kimi',
    source: 'kimi-live-usage',
    configured: true,
    fetchedAt: new Date().toISOString(),
    windows,
    balances
  }
}

const CLAUDE_SESSION_WINDOW_SECONDS = 5 * 60 * 60
const CLAUDE_WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60

function claudeUsageWindow(
  id: string,
  label: string,
  payload: any,
  limitWindowSeconds?: number
): NormalizedProviderUsageWindow | null {
  if (!payload || typeof payload !== 'object') return null
  const utilization = numericUsageValue(payload.utilization)
  if (utilization === undefined) return null
  const usedPercent = clampPercent(utilization)
  const remainingPercent = clampPercent(100 - usedPercent)
  return {
    id,
    label,
    runs: 0,
    totalTokens: 0,
    limitLabel: `${Math.round(remainingPercent)}% remaining`,
    // The live OAuth endpoint emits `resets_at` (Limit Counter parity);
    // older shapes used `reset_at` / camelCase.
    resetAt: parseIsoDate(payload.resetAt ?? payload.reset_at ?? payload.resets_at),
    trackingOnly: false,
    usedPercent,
    remainingPercent,
    // Known rollover cadence powers the QuotaPace tick (the bare 'Fable' /
    // 'Opus' labels match none of QuotaPace's label-duration patterns) and
    // lets projectStaleSnapshotForward roll a stale persisted window over.
    ...(limitWindowSeconds ? { limitWindowSeconds } : {})
  }
}

export function normalizeClaudeUsageSnapshot(
  payload: any,
  credential: ClaudeOAuthCredentialLike = {}
): NormalizedProviderUsageSnapshot {
  const windows: NormalizedProviderUsageWindow[] = []
  const balances: NormalizedProviderUsageSnapshot['balances'] = []
  const fiveHour = claudeUsageWindow(
    'claude-5h',
    'Session',
    payload?.fiveHour ?? payload?.five_hour ?? pickClaudeAggregateLimitWindow(payload, 'five_hour'),
    CLAUDE_SESSION_WINDOW_SECONDS
  )
  if (fiveHour) windows.push(fiveHour)
  const sevenDay = claudeUsageWindow(
    'claude-weekly',
    'Weekly',
    payload?.sevenDay ?? payload?.seven_day ?? pickClaudeAggregateLimitWindow(payload, 'weekly'),
    CLAUDE_WEEKLY_WINDOW_SECONDS
  )
  if (sevenDay) windows.push(sevenDay)
  /*
   * 1.0.3 hotfix — the Fable + Opus per-family weekly meters were
   * sometimes missing from TaskWraith's Claude usage panel even when
   * Limit Counter (the maintainer's reference app) was clearly showing them.
   * The previous probe only knew the top-level snake/camel pair
   * (`seven_day_sonnet` / `sevenDaySonnet`). Anthropic's OAuth usage
   * response has subtly different shapes across subscription tiers
   * and account types; we now also probe the nested forms used by
   * `seven_day.fable` / `sevenDay.fable`, plus the `models.fable`
   * sub-tree some account variants emit, plus (mid-2026, the current
   * live shape) `limits[]` entries with `kind: "weekly_scoped"` and a
   * `scope` naming the family. First non-null wins. Legacy
   * Sonnet keys are still accepted as aliases for the renamed Fable
   * meter so older cached/provider payload shapes do not disappear.
   * Same broadening for Opus below. If all probes miss but the
   * top-level `seven_day` window is present, we log a one-shot
   * diagnostic so any further field-shape drift surfaces in dev
   * console rather than silently dropping the meter.
   */
  const sevenDayFable = pickClaudeModelWindow(payload, 'fable')
  const fableWindow = claudeUsageWindow(
    'claude-weekly-fable',
    'Fable',
    sevenDayFable,
    CLAUDE_WEEKLY_WINDOW_SECONDS
  )
  if (fableWindow) windows.push(fableWindow)
  const sevenDayOpus = pickClaudeModelWindow(payload, 'opus')
  const opusWindow = claudeUsageWindow(
    'claude-weekly-opus',
    'Opus',
    sevenDayOpus,
    CLAUDE_WEEKLY_WINDOW_SECONDS
  )
  if (opusWindow) windows.push(opusWindow)
  if (sevenDay && !fableWindow && !opusWindow && payload && typeof payload === 'object') {
    logClaudeUsageMissingFamilyWindowOnce(payload)
  }
  const extraUsage = payload?.extraUsage ?? payload?.extra_usage
  if (extraUsage?.isEnabled ?? extraUsage?.is_enabled) {
    const unit = String(extraUsage?.currency || 'credits')
    const usedCredits = numericUsageValue(extraUsage?.usedCredits ?? extraUsage?.used_credits)
    const monthlyLimit = numericUsageValue(extraUsage?.monthlyLimit ?? extraUsage?.monthly_limit)
    if (usedCredits !== undefined && monthlyLimit !== undefined) {
      balances.push({
        label: 'Extra Usage',
        amount: Math.max(0, monthlyLimit - usedCredits),
        unit,
        subtitle: `${usedCredits.toLocaleString()} of ${monthlyLimit.toLocaleString()} ${unit} used this month`
      })
    } else if (usedCredits !== undefined) {
      balances.push({
        label: 'Extra Usage',
        amount: usedCredits,
        unit,
        subtitle: 'Additional usage this month'
      })
    }
  }
  return {
    provider: 'claude',
    source: 'claude-oauth-usage',
    configured: true,
    subscriptionType: credential.subscriptionType,
    fetchedAt: new Date().toISOString(),
    windows,
    balances
  }
}

/**
 * Pick a Claude per-family weekly window from the OAuth usage payload.
 * Tries every shape Anthropic has been observed to emit, returns the
 * first non-null candidate. Used for Fable + Opus.
 *
 *   Top-level snake/camel: `seven_day_fable` / `sevenDayFable`
 *   Nested under seven_day: `seven_day.fable` / `sevenDay.fable`
 *   Nested under models: `models.fable` / `models.fable.weekly` /
 *                        `models.fable.seven_day`
 *   Alt prefix: `weekly_fable` / `weeklyFable`
 *   Limits array (current live shape, mid-2026): `limits[]` entries of
 *     `{ group: "weekly", kind: "weekly_scoped", percent, resets_at,
 *        scope: { label: "Fable" } | "fable" | absent }`
 *
 * Preference order mirrors Limit Counter (the maintainer's reference
 * app): direct family fields → scoped `limits[]` entry → legacy Sonnet
 * aliases. The scoped limits entry must beat `seven_day_sonnet` because
 * accounts in transition have carried a STALE legacy Sonnet field
 * alongside the live scoped Fable entry.
 *
 * The `family` argument is the lowercase model family name (`fable`
 * or `opus`). Returns whatever's at the matched path; `claudeUsageWindow`
 * decides if there's a usable `utilization` numeric inside.
 */
function pickClaudeModelWindow(payload: any, family: 'fable' | 'opus'): any {
  if (!payload || typeof payload !== 'object') return null
  const directShapes = (alias: string): any[] => {
    const camelSuffix = alias === 'fable' ? 'Fable' : alias === 'sonnet' ? 'Sonnet' : 'Opus'
    return [
      payload[`seven_day_${alias}`],
      payload[`sevenDay${camelSuffix}`],
      payload[`weekly_${alias}`],
      payload[`weekly${camelSuffix}`],
      payload?.seven_day?.[alias],
      payload?.sevenDay?.[alias],
      payload?.models?.[alias]?.seven_day,
      payload?.models?.[alias]?.sevenDay,
      payload?.models?.[alias]?.weekly,
      payload?.models?.[alias]
    ]
  }
  const candidates: any[] =
    family === 'fable'
      ? [
          ...directShapes('fable'),
          pickClaudeScopedLimitWindow(payload, 'fable'),
          ...directShapes('sonnet')
        ]
      : [...directShapes('opus'), pickClaudeScopedLimitWindow(payload, 'opus')]
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') return candidate
  }
  return null
}

/** Flatten a limits-entry `scope` (string, or object like
 * `{ label: "Fable" }`) into lowercase text for family matching. Only
 * string leaf values count (two levels deep) — so `{}` / `{ label: null }`
 * read as scope-less rather than as an unknown scope. */
function claudeLimitScopeText(scope: unknown): string {
  if (typeof scope === 'string') return scope.toLowerCase()
  if (!scope || typeof scope !== 'object') return ''
  const parts: string[] = []
  for (const value of Object.values(scope as Record<string, unknown>)) {
    if (typeof value === 'string') parts.push(value)
    else if (value && typeof value === 'object') {
      for (const nested of Object.values(value as Record<string, unknown>)) {
        if (typeof nested === 'string') parts.push(nested)
      }
    }
  }
  return parts.join(' ').toLowerCase()
}

/** Map a limits[] entry to the `{ utilization, reset_at }` shape
 * `claudeUsageWindow` consumes; null when it has no usable percent. */
function claudeLimitEntryWindow(entry: any): any {
  const utilization = entry.percent ?? entry.utilization
  if (utilization === undefined || utilization === null) return null
  return {
    utilization,
    reset_at: entry.resets_at ?? entry.reset_at ?? entry.resetAt
  }
}

/**
 * Find a per-family weekly window inside the payload's `limits[]` array
 * (the shape the OAuth usage endpoint moved to in mid-2026).
 *
 * Two passes, so array order can never let the wrong bucket win:
 *   1. an entry whose kind or scope text explicitly names the family;
 *   2. (Fable only, when pass 1 found nothing) a `kind: "weekly_scoped"`
 *      entry with NO scope at all — Limit Counter parity; some accounts
 *      omit the scope on the Fable bucket. An entry scoped to some OTHER
 *      bucket ("Opus", "OAuth apps", or a family that doesn't exist yet)
 *      never qualifies as Fable.
 */
function pickClaudeScopedLimitWindow(payload: any, family: 'fable' | 'opus'): any {
  const limits = payload?.limits
  if (!Array.isArray(limits)) return null
  const aliases = family === 'fable' ? ['fable', 'sonnet'] : ['opus']
  const weeklyEntries = limits.filter(
    (entry) =>
      entry && typeof entry === 'object' && String(entry.group ?? '').toLowerCase() === 'weekly'
  )
  for (const entry of weeklyEntries) {
    const kind = String(entry.kind ?? '').toLowerCase()
    const scopeText = claudeLimitScopeText(entry.scope)
    if (!aliases.some((alias) => kind.includes(alias) || scopeText.includes(alias))) continue
    const window = claudeLimitEntryWindow(entry)
    if (window) return window
  }
  if (family !== 'fable') return null
  for (const entry of weeklyEntries) {
    if (String(entry.kind ?? '').toLowerCase() !== 'weekly_scoped') continue
    if (claudeLimitScopeText(entry.scope) !== '') continue
    const window = claudeLimitEntryWindow(entry)
    if (window) return window
  }
  return null
}

/**
 * Aggregate (non-model-scoped) fallback from limits[]: if Anthropic
 * completes the migration and drops the top-level `five_hour` /
 * `seven_day` fields, the Session and Weekly meters keep working off
 * the aggregate limits entries. The live payload (captured 2026-07-01)
 * names the session bucket `group: "session"` / `kind: "session"`; the
 * weekly aggregate is `group: "weekly"` / `kind: "weekly_all"`. Scoped
 * per-family buckets never qualify.
 */
function pickClaudeAggregateLimitWindow(payload: any, group: 'five_hour' | 'weekly'): any {
  const limits = payload?.limits
  if (!Array.isArray(limits)) return null
  const groupNames = group === 'five_hour' ? ['five_hour', 'session'] : ['weekly']
  for (const entry of limits) {
    if (!entry || typeof entry !== 'object') continue
    if (!groupNames.includes(String(entry.group ?? '').toLowerCase())) continue
    if (
      String(entry.kind ?? '')
        .toLowerCase()
        .includes('scoped')
    )
      continue
    const window = claudeLimitEntryWindow(entry)
    if (window) return window
  }
  return null
}

/**
 * One-shot diagnostic. Fires when a Claude OAuth usage payload has the
 * top-level weekly window but neither Fable nor Opus per-family
 * windows survive normalisation — likely a field-shape drift we
 * haven't accounted for. Logs the payload's top-level keys (NOT
 * values — those may contain credentials/quota) so the user can
 * report what fields are actually present.
 *
 * `claudeUsageLoggedMissingFamilyFields` is the module-level latch so
 * we only log once per process boot — repeat fetches don't spam the
 * console.
 */
/**
 * Project a stale persisted snapshot's window reset timestamps forward.
 *
 * Use case (1.0.3): Kimi's CLI auth expires ~1h after activity, after
 * which the live `/coding/v1/usages` endpoint stops returning data and
 * TaskWraith falls back to the persisted on-disk snapshot. If the user
 * hasn't run Kimi for a few hours (or days), every window's `resetAt`
 * is in the past — the meter renders "9% used, reset 6am yesterday"
 * which is misleading. Same issue applies to any provider whose
 * persisted snapshot can outlive its window: a Codex 5h-session
 * meter from last week, a Claude 7-day weekly from two weeks ago.
 *
 * The projection: for each window with a known `limitWindowSeconds`
 * rollover duration, if `resetAt` is in the past, increment it by
 * whole window-durations until it lands in the future. Reset
 * `usedPercent` to 0 (and `remainingPercent` to 100, `limitLabel`
 * to "100% remaining") since the window has rolled over and we have
 * no fresh signal otherwise — best-guess assumption matching Limit
 * Counter's behaviour. Snapshot is flagged `projected: true` so
 * downstream code can dim the meter / show a "predicted" hint.
 *
 * Windows without `limitWindowSeconds` (we don't know the rollover
 * cadence) are left untouched — better to show stale-but-real than
 * project against an unknown clock. And once the whole snapshot is older
 * than STALE_PROJECTION_TRUST_MAX_AGE_MS, the reset clock is still rolled
 * forward but usage% is PRESERVED (not zeroed) — see that constant.
 */
/**
 * Beyond this staleness the "stale window rolled over, so usage is back to
 * 0%" assumption is no longer safe: if we've had no fresh data for over a
 * day, a heavy user could have burned quota we never saw — which is exactly
 * how a broken Codex usage token rendered a false 0% on every meter. Past
 * this age we still roll the reset clock forward (for a sane display) but
 * PRESERVE the last-known usage% instead of asserting 0.
 */
export const STALE_PROJECTION_TRUST_MAX_AGE_MS = 24 * 60 * 60 * 1000

export function projectStaleSnapshotForward(snapshot: any): any {
  if (!snapshot || typeof snapshot !== 'object') return snapshot
  if (!Array.isArray(snapshot.windows) || snapshot.windows.length === 0) return snapshot
  const now = Date.now()
  const fetchedAt = typeof snapshot.fetchedAt === 'string' ? Date.parse(snapshot.fetchedAt) : NaN
  // Only trust the rollover-to-0 guess when the snapshot is recent enough.
  const trustRollover =
    !Number.isFinite(fetchedAt) || now - fetchedAt <= STALE_PROJECTION_TRUST_MAX_AGE_MS
  let anyProjected = false
  let anyRenamed = false
  const projectedWindows = snapshot.windows.map((window: any) => {
    if (!window || typeof window !== 'object') return window
    const normalizedWindow = normalizeLegacyClaudeQuotaWindow(snapshot.provider, window)
    if (normalizedWindow !== window) anyRenamed = true
    const resetAt =
      typeof normalizedWindow.resetAt === 'string' ? Date.parse(normalizedWindow.resetAt) : NaN
    const windowSeconds = Number(normalizedWindow.limitWindowSeconds)
    if (!Number.isFinite(resetAt) || !Number.isFinite(windowSeconds) || windowSeconds <= 0) {
      return normalizedWindow
    }
    if (resetAt > now) return normalizedWindow
    const windowMs = windowSeconds * 1000
    let nextReset = resetAt
    // Advance by whole windows until we're in the future. Defensive
    // cap at 1000 iterations to prevent a malformed snapshot (e.g.
    // `resetAt` from 1970 with a 1-second window) from spin-looping.
    let guard = 0
    while (nextReset <= now && guard < 1000) {
      nextReset += windowMs
      guard += 1
    }
    if (nextReset <= now) return normalizedWindow
    anyProjected = true
    const rolled = { ...normalizedWindow, resetAt: new Date(nextReset).toISOString() }
    // Recent → assume a clean rollover (window is fresh at 0%). Too stale →
    // we don't know what's been used; keep last-known %, just fix the clock.
    if (!trustRollover) return rolled
    return {
      ...rolled,
      usedPercent: 0,
      remainingPercent: 100,
      limitLabel: '100% remaining'
    }
  })
  if (!anyProjected && !anyRenamed) return snapshot
  return { ...snapshot, windows: projectedWindows, ...(anyProjected ? { projected: true } : {}) }
}

function normalizeLegacyClaudeQuotaWindow(provider: unknown, window: any): any {
  const id = String(window?.id || '')
  const label = String(window?.label || '')
  const isLegacySonnetId = id.toLowerCase() === 'claude-weekly-sonnet'
  const isLegacySonnetLabel = provider === 'claude' && label.trim().toLowerCase() === 'sonnet'
  const isLegacySonnetWindow = isLegacySonnetId || isLegacySonnetLabel
  if (!isLegacySonnetWindow) return window
  return {
    ...window,
    id: id === 'claude-weekly-sonnet' ? 'claude-weekly-fable' : window.id,
    label: 'Fable'
  }
}

let claudeUsageLoggedMissingFamilyFields = false
function logClaudeUsageMissingFamilyWindowOnce(payload: any): void {
  if (claudeUsageLoggedMissingFamilyFields) return
  claudeUsageLoggedMissingFamilyFields = true
  try {
    const topLevelKeys = Object.keys(payload).sort()
    const sevenDayKeys =
      payload.seven_day && typeof payload.seven_day === 'object'
        ? Object.keys(payload.seven_day).sort()
        : payload.sevenDay && typeof payload.sevenDay === 'object'
          ? Object.keys(payload.sevenDay).sort()
          : null
    const modelsKeys =
      payload.models && typeof payload.models === 'object'
        ? Object.keys(payload.models).sort()
        : null
    // group/kind only — scope labels could name private model access.
    const limitsShapes = Array.isArray(payload.limits)
      ? payload.limits.map(
          (entry: any) => `${String(entry?.group ?? '?')}/${String(entry?.kind ?? '?')}`
        )
      : null

    console.warn(
      '[claudeUsage] per-family weekly windows (Fable / Opus) not found in OAuth payload — ' +
        `top-level keys: ${JSON.stringify(topLevelKeys)}` +
        (sevenDayKeys ? `, seven_day.* keys: ${JSON.stringify(sevenDayKeys)}` : '') +
        (modelsKeys ? `, models.* keys: ${JSON.stringify(modelsKeys)}` : '') +
        (limitsShapes ? `, limits[] group/kind: ${JSON.stringify(limitsShapes)}` : '')
    )
  } catch {
    // Best-effort diagnostic — don't let a logging failure crash the
    // normaliser.
  }
}
