/*
 * CursorUsage — Cursor (Composer 2.5) subscription usage snapshot.
 *
 * cursor-agent (the CLI) exposes NO usage command, so — exactly like the
 * standalone "Limit Counter" reference app does — we read the Cursor
 * *editor's* access token out of its local SQLite state DB and POST the
 * undocumented Connect-RPC dashboard endpoint to get the current billing
 * period's usage. This mirrors how TaskWraith already surfaces Kimi/Claude
 * usage windows (a `{ windows, balances, source, fetchedAt }` snapshot that
 * the renderer's `refreshUsageSummary` normalizes into the sidebar +
 * Settings "Model Usage" meters).
 *
 * Token source (read-only): the editor's
 *   ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
 * SQLite `ItemTable`, key `cursorAuth/accessToken`. We never read it
 * directly here — the host injects a `readAccessToken` dep (index.ts
 * shells out to the macOS `/usr/bin/sqlite3` CLI read-only) so this module
 * stays pure and unit-testable, and so we never bundle a native SQLite
 * dependency.
 *
 * RPC: POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage
 *   headers: Authorization: Bearer <token>, Content-Type: application/json,
 *            Connect-Protocol-Version: 1
 *   body:    {}
 *   → { billingCycleEnd(ms), planUsage:{ totalPercentUsed, autoPercentUsed,
 *       apiPercentUsed }, spendLimitUsage:{ individualLimit(cents),
 *       individualRemaining(cents) } }
 *
 * Safety: this only reads the local editor token + hits Cursor's own
 * dashboard API with it (the same call the editor's own usage UI makes).
 * It never mutates ~/.cursor, never writes the editor DB, and never runs a
 * cursor-agent process.
 */

export interface CursorUsageWindow {
  id: string
  label: string
  limitLabel: string
  /** 0..100 percent of this monthly bucket consumed. */
  usedPercent: number
  /** ISO timestamp of the billing-cycle reset. */
  resetAt?: string
  /** Cursor dashboard percentages are monthly billing-cycle buckets. */
  limitWindowSeconds?: number
}

export interface CursorUsageBalance {
  id: string
  label: string
  amount: number
  unit: string
  subtitle?: string
  resetAt?: string
}

export interface CursorUsageSnapshot {
  provider: 'cursor'
  source: string
  windows: CursorUsageWindow[]
  balances: CursorUsageBalance[]
  /** true once we have a usable editor token (auth observed). */
  configured: boolean
  error?: string
  stale?: boolean
  /** ISO timestamp the snapshot was produced. */
  fetchedAt: string
  /** Raw local membership identifier (for example `pro_plus`). */
  planType?: string
}

/** macOS path of the Cursor editor's global-storage SQLite DB. */
export const CURSOR_STATE_DB_RELATIVE =
  'Library/Application Support/Cursor/User/globalStorage/state.vscdb'

/** ItemTable key whose value is the editor's bearer access token. */
export const CURSOR_ACCESS_TOKEN_KEY = 'cursorAuth/accessToken'

export const CURSOR_USAGE_ENDPOINT =
  'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage'

export const CURSOR_USAGE_SOURCE = 'cursor-dashboard-usage'
export const CURSOR_BILLING_WINDOW_SECONDS = 30 * 24 * 60 * 60

/**
 * Candidate DB paths to try in order: the live DB then the editor's
 * `.backup` (the Limit Counter app falls back to the backup when the live
 * file is locked / mid-write).
 */
export function cursorStateDbCandidates(homeDir: string): string[] {
  const base = `${homeDir.replace(/\/+$/, '')}/${CURSOR_STATE_DB_RELATIVE}`
  return [base, `${base}.backup`]
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}

function toResetIso(billingCycleEnd: unknown): string | undefined {
  const ms = typeof billingCycleEnd === 'string' ? Number(billingCycleEnd) : Number(billingCycleEnd)
  if (!Number.isFinite(ms) || ms <= 0) return undefined
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

/**
 * Pure parser: turn a GetCurrentPeriodUsage JSON payload into normalized
 * windows + balances. Defensive — any missing/garbage field is skipped, so
 * a partial response still yields whatever it can.
 */
export function parseCursorUsageResponse(payload: unknown): {
  windows: CursorUsageWindow[]
  balances: CursorUsageBalance[]
} {
  const windows: CursorUsageWindow[] = []
  const balances: CursorUsageBalance[] = []
  if (!payload || typeof payload !== 'object') return { windows, balances }

  const obj = payload as Record<string, unknown>
  const resetAt = toResetIso(obj.billingCycleEnd)

  const planUsage =
    obj.planUsage && typeof obj.planUsage === 'object'
      ? (obj.planUsage as Record<string, unknown>)
      : null

  const pushWindow = (id: string, label: string, raw: unknown): void => {
    const value = Number(raw)
    if (!Number.isFinite(value)) return
    windows.push({
      id,
      label,
      limitLabel: 'This cycle',
      usedPercent: clampPercent(value),
      resetAt,
      limitWindowSeconds: CURSOR_BILLING_WINDOW_SECONDS
    })
  }

  if (planUsage) {
    pushWindow('cursor-included', 'Included in Pro', planUsage.totalPercentUsed)
    pushWindow('cursor-auto', 'Auto + Composer', planUsage.autoPercentUsed)
    pushWindow('cursor-api', 'API', planUsage.apiPercentUsed)
    // Healthy response with no recognizable percent fields → a single 0%
    // placeholder so the card shows the provider exists (matches the
    // reference app's behaviour).
    if (windows.length === 0) {
      windows.push({
        id: 'cursor-included',
        label: 'Included in Pro',
        limitLabel: 'This cycle',
        usedPercent: 0,
        resetAt,
        limitWindowSeconds: CURSOR_BILLING_WINDOW_SECONDS
      })
    }
  }

  const spend =
    obj.spendLimitUsage && typeof obj.spendLimitUsage === 'object'
      ? (obj.spendLimitUsage as Record<string, unknown>)
      : null
  if (spend) {
    const limit = Number(spend.individualLimit)
    const remaining = Number(spend.individualRemaining)
    if (Number.isFinite(limit) && limit > 0) {
      const used = Math.max(0, limit - (Number.isFinite(remaining) ? remaining : 0))
      balances.push({
        id: 'cursor-ondemand',
        label: 'On-Demand Spend',
        amount: Number.isFinite(remaining) ? remaining / 100 : 0,
        unit: 'USD',
        subtitle: `${dollars(used)} of ${dollars(limit)} on-demand used`,
        resetAt
      })
    }
  }

  return { windows, balances }
}

export function buildCursorUsageSnapshot(
  payload: unknown,
  fetchedAtIso: string,
  planType?: string | null
): CursorUsageSnapshot {
  const { windows, balances } = parseCursorUsageResponse(payload)
  return {
    provider: 'cursor',
    source: CURSOR_USAGE_SOURCE,
    windows,
    balances,
    configured: true,
    fetchedAt: fetchedAtIso,
    ...(planType?.trim() ? { planType: planType.trim() } : {})
  }
}

export function emptyCursorUsageSnapshot(
  fetchedAtIso: string,
  opts: { configured: boolean; error?: string; stale?: boolean } = { configured: false }
): CursorUsageSnapshot {
  return {
    provider: 'cursor',
    source: CURSOR_USAGE_SOURCE,
    windows: [],
    balances: [],
    configured: opts.configured,
    error: opts.error,
    stale: opts.stale,
    fetchedAt: fetchedAtIso
  }
}

export interface CursorUsageLoadDeps {
  /** Resolve the editor bearer token, or null if not signed in / unreadable. */
  readAccessToken: () => Promise<string | null>
  /** Read the editor's local Stripe membership type without exposing auth data. */
  readPlanType?: () => Promise<string | null>
  /** Perform the dashboard RPC and resolve the parsed JSON, or throw. */
  fetchUsageRpc: (token: string) => Promise<unknown>
  /** Injectable clock (defaults to Date.now). */
  now?: () => number
}

/**
 * Orchestrate a single usage fetch. Never throws: a missing token yields a
 * `configured:false` snapshot; an RPC failure yields a `configured:true`
 * snapshot carrying the error string (so the UI can show "authed but the
 * usage call failed").
 */
export async function loadCursorUsageSnapshot(
  deps: CursorUsageLoadDeps
): Promise<CursorUsageSnapshot> {
  const now = deps.now ?? (() => Date.now())
  const fetchedAtIso = new Date(now()).toISOString()

  let token: string | null = null
  try {
    token = await deps.readAccessToken()
  } catch {
    token = null
  }
  if (!token) {
    return emptyCursorUsageSnapshot(fetchedAtIso, {
      configured: false,
      error: 'Cursor editor sign-in was not found. Sign in to the Cursor app to see usage.'
    })
  }

  try {
    const [payload, planType] = await Promise.all([
      deps.fetchUsageRpc(token),
      deps.readPlanType?.().catch(() => null) ?? Promise.resolve(null)
    ])
    return buildCursorUsageSnapshot(payload, fetchedAtIso, planType)
  } catch (error) {
    return emptyCursorUsageSnapshot(fetchedAtIso, {
      configured: true,
      error: error instanceof Error ? error.message : 'Cursor usage fetch failed.'
    })
  }
}
