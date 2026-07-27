/**
 * Mistral Admin API usage lane — the ONE path by which a real vendor spend
 * figure can reach the Mistral meter automatically.
 *
 * ENDPOINT (from docs.mistral.ai/admin/admin-api/usage-metrics):
 *
 *   GET https://api.mistral.ai/v1/admin/usage?month=<1-12>&year=<yyyy>
 *   x-api-key: <admin key>
 *
 * The response carries consumption "broken down by category (`chat`,
 * `completion`, `ocr`, `audio`, `connectors`, `libraries_api`, `fine_tuning`,
 * and `vibe_usage`), together with the period (`start_date`, `end_date`) and the
 * `currency`". `vibe_usage` is the Vibe CLI seat — exactly what this meter
 * wants.
 *
 * ELIGIBILITY, STATED UP FRONT. The Admin API is **Preview and Enterprise-only**
 * and needs a dedicated key created in backoffice.mistral.ai; Mistral's own docs
 * are explicit that "a user's standard API key never grants admin access". So on
 * Free, Pro and Team this lane is inert by construction and the meter falls back
 * to {@link MistralQuotaAnchor} (the user's own console reading) or the plan
 * seed. Nothing here is a substitute for those.
 *
 * ⚠️ NOT EXERCISED AGAINST A LIVE ENDPOINT. This module was written from the
 * documentation alone — the account it was built for is on Pro, so there is no
 * admin key to test with, and Mistral publish no example response body. The
 * per-category FIELD NAMES are therefore inferred, not observed. Everything
 * below is consequently built to FAIL CLOSED:
 *
 *   - the parser accepts a spread of plausible encodings for the same figure,
 *   - anything it cannot confidently identify yields `null`, never a zero or a
 *     guess (a fabricated 0 would read as "you've spent nothing" — the most
 *     dangerous possible wrong answer for a quota meter),
 *   - the caller treats `null` as "no report" and keeps the previous source.
 *
 * When someone does run this against a real Enterprise key, the right move is to
 * capture the actual body, pin it in a fixture test, and narrow the parser.
 */

/** Documented category keys. `vibe_usage` is the Vibe CLI seat's own line. */
export const MISTRAL_USAGE_CATEGORIES = [
  'chat',
  'completion',
  'ocr',
  'audio',
  'connectors',
  'libraries_api',
  'fine_tuning',
  'vibe_usage'
] as const

export type MistralUsageCategory = (typeof MISTRAL_USAGE_CATEGORIES)[number]

/** Field names a cost could plausibly arrive under, most specific first. */
const COST_FIELD_CANDIDATES = [
  'cost',
  'amount',
  'total_cost',
  'totalCost',
  'spend',
  'total',
  'cost_amount'
] as const

export interface MistralAdminUsageResult {
  /** Spend for the whole period, in the vendor's own currency. */
  readonly totalSpend: number
  /** The `vibe_usage` line alone, when the response separates it out. */
  readonly vibeSpend?: number
  /** ISO-4217 code as reported. Never assumed — absent means we could not tell. */
  readonly currency?: string
  readonly periodStart?: string
  readonly periodEnd?: string
  /** Per-category figures we were able to identify, for display/debugging. */
  readonly byCategory: Partial<Record<MistralUsageCategory, number>>
}

export type MistralAdminUsageFailure =
  /** No admin key configured — the normal state for a non-Enterprise seat. */
  | 'no-key'
  /** 401/403: the key is not an admin key, or the plan is not Enterprise. */
  | 'unauthorized'
  /** 429 from the admin surface itself. */
  | 'rate-limited'
  /** Any other non-2xx. */
  | 'http-error'
  /** Network/DNS/timeout. */
  | 'unreachable'
  /** 2xx whose body we could not confidently read — see the fail-closed note. */
  | 'unparseable'

export type MistralAdminUsageOutcome =
  | { readonly ok: true; readonly usage: MistralAdminUsageResult }
  | { readonly ok: false; readonly failure: MistralAdminUsageFailure; readonly status?: number }

const ADMIN_USAGE_URL = 'https://api.mistral.ai/v1/admin/usage'

/** Hard ceiling on the request. A meter refresh must never wedge a caller. */
export const MISTRAL_ADMIN_USAGE_TIMEOUT_MS = 10_000

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * Pull a cost out of one category's value.
 *
 * Accepts a bare number (`{"chat": 1.23}`) or an object carrying one of the
 * candidate field names (`{"chat": {"cost": 1.23}}`). Returns null rather than 0
 * when nothing is identifiable — see the fail-closed note in the header.
 */
export function readCategoryCost(value: unknown): number | null {
  if (finitePositive(value)) return value
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  for (const field of COST_FIELD_CANDIDATES) {
    if (finitePositive(record[field])) return record[field] as number
  }
  return null
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * Structurally decode an admin-usage body.
 *
 * Tolerates the categories sitting either at the top level or nested under a
 * `usage`/`data`/`categories` envelope, because the documentation does not say
 * which. Returns null when NO category could be read at all — a body we cannot
 * understand must not become a spend of zero.
 */
export function parseMistralAdminUsage(body: unknown): MistralAdminUsageResult | null {
  if (!body || typeof body !== 'object') return null
  const root = body as Record<string, unknown>

  // The categories may be one level down. Try the root first, then envelopes.
  const envelopes: Record<string, unknown>[] = [root]
  for (const key of ['usage', 'data', 'categories', 'breakdown']) {
    const nested = root[key]
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      envelopes.push(nested as Record<string, unknown>)
    }
  }

  const byCategory: Partial<Record<MistralUsageCategory, number>> = {}
  for (const envelope of envelopes) {
    for (const category of MISTRAL_USAGE_CATEGORIES) {
      if (byCategory[category] !== undefined) continue
      const cost = readCategoryCost(envelope[category])
      if (cost !== null) byCategory[category] = cost
    }
  }

  const identified = Object.values(byCategory)
  // An explicit period total, if the body offers one, outranks our summation —
  // it accounts for categories we may not know about.
  const declaredTotal =
    readCategoryCost(root.total) ??
    readCategoryCost(root.total_cost) ??
    readCategoryCost(root.totalCost)

  if (identified.length === 0 && declaredTotal === null) return null

  const totalSpend =
    declaredTotal !== null ? declaredTotal : identified.reduce((sum, value) => sum + value, 0)

  return {
    totalSpend,
    ...(byCategory.vibe_usage !== undefined ? { vibeSpend: byCategory.vibe_usage } : {}),
    ...(readString(root.currency) ? { currency: readString(root.currency) } : {}),
    ...(readString(root.start_date) ? { periodStart: readString(root.start_date) } : {}),
    ...(readString(root.end_date) ? { periodEnd: readString(root.end_date) } : {}),
    byCategory
  }
}

/** Injectable for tests; defaults to the global fetch in main. */
export type MistralAdminFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

export interface MistralAdminUsageOptions {
  readonly apiKey: string | null | undefined
  /** Defaults to the current UTC month — the period the meter is showing. */
  readonly month?: number
  readonly year?: number
  readonly now?: Date
  readonly fetchImpl?: MistralAdminFetch
  readonly timeoutMs?: number
}

/**
 * Fetch this month's admin usage.
 *
 * Never throws: every failure mode is a typed outcome, because this runs on a
 * meter-refresh path where an exception would be strictly worse than a stale
 * number.
 */
export async function fetchMistralAdminUsage(
  options: MistralAdminUsageOptions
): Promise<MistralAdminUsageOutcome> {
  const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : ''
  if (!apiKey) return { ok: false, failure: 'no-key' }

  const now = options.now ?? new Date()
  const month = options.month ?? now.getUTCMonth() + 1
  const year = options.year ?? now.getUTCFullYear()
  const url = `${ADMIN_USAGE_URL}?month=${encodeURIComponent(String(month))}&year=${encodeURIComponent(String(year))}`

  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as MistralAdminFetch)
  if (typeof fetchImpl !== 'function') return { ok: false, failure: 'unreachable' }

  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1_000, options.timeoutMs ?? MISTRAL_ADMIN_USAGE_TIMEOUT_MS)
  )
  try {
    const response = await fetchImpl(url, {
      // `x-api-key`, NOT `Authorization: Bearer` — the admin surface is
      // explicitly a different auth scheme from the inference API.
      headers: { 'x-api-key': apiKey, accept: 'application/json' },
      signal: controller.signal
    })
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return { ok: false, failure: 'unauthorized', status: response.status }
      }
      if (response.status === 429) {
        return { ok: false, failure: 'rate-limited', status: response.status }
      }
      return { ok: false, failure: 'http-error', status: response.status }
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      return { ok: false, failure: 'unparseable', status: response.status }
    }
    const usage = parseMistralAdminUsage(body)
    if (!usage) return { ok: false, failure: 'unparseable', status: response.status }
    return { ok: true, usage }
  } catch {
    return { ok: false, failure: 'unreachable' }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Which figure the meter should treat as "spend against the allowance".
 *
 * The PERIOD TOTAL, deliberately — not the `vibe_usage` line, even though this
 * meter is nominally about the Vibe seat. The console is explicit that the
 * included allowance is a shared pool: "This usage is included with your plan
 * and can be used for Studio, Vibe Code, or API." So Studio and raw-API spend
 * consume the same budget that stops the Vibe seat, and metering `vibe_usage`
 * alone would under-report the thing the user actually hits.
 *
 * `vibeSpend` stays on the result for display ("of which Vibe: …"), which is a
 * breakdown question, not a "how close am I to the wall" question.
 */
export function meterSpendFrom(usage: MistralAdminUsageResult): number {
  return usage.totalSpend
}

/**
 * Static USD-relative FX for converting a vendor figure into the USD the quota
 * model works in.
 *
 * Deliberately a small local table rather than an import: the live rates live in
 * the RENDERER (`lib/formatCost.ts`), and reaching for them from main would add
 * a main→renderer runtime edge that `guard:architecture` budgets to one. The
 * anchor path avoids this entirely by converting in the renderer before it
 * crosses IPC; only this Admin-API path, which starts in main, needs its own.
 *
 * Mistral bills the included allowance in EUR. A few percent of FX drift on an
 * advisory monthly meter is immaterial next to the character-count estimate it
 * replaces — but if this ever feeds anything billable, move the rates to
 * `src/shared` and share one table.
 */
const STATIC_UNITS_PER_USD: Readonly<Record<string, number>> = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79
}

/** Convert `amount` in `currency` to USD. An unknown or missing currency is
 *  passed through unchanged rather than scaled by a guessed rate. */
export function convertVendorAmountToUsd(amount: number, currency?: string): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0
  const code = typeof currency === 'string' ? currency.trim().toUpperCase() : ''
  const perUsd = code ? STATIC_UNITS_PER_USD[code] : undefined
  if (!perUsd || !Number.isFinite(perUsd) || perUsd <= 0) return amount
  return amount / perUsd
}
