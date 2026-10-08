/**
 * Anthropic Usage & Cost Admin API — the Console organisation's cost report.
 *
 *   GET https://api.anthropic.com/v1/organizations/cost_report
 *       ?starting_at=<RFC 3339>&ending_at=<RFC 3339>[&page=<cursor>]
 *   x-api-key: <Admin API key, sk-ant-admin01-…>
 *   anthropic-version: 2023-06-01
 *
 * From platform.claude.com/docs/en/manage-claude/usage-cost-api (read
 * 2026-10-08): costs are USD only, "reported as decimal strings in lowest
 * units (cents)", bucketed daily, paginated with `has_more` / `next_page`
 * (request `page=`), and the endpoint supports polling once a minute. It
 * needs an Admin API key or an org:admin credential — a workspace key, or a
 * seat's own key, is rejected with 401/403, which this module reports as
 * `unauthorized` so the Settings field can say so.
 *
 * Fail closed: an amount that cannot be read as a finite number makes the
 * whole report `parse`, never a zero. A fabricated $0.00 is the most dangerous
 * wrong answer a spend readout can give.
 */

export const ANTHROPIC_COST_REPORT_URL = 'https://api.anthropic.com/v1/organizations/cost_report'
export const ANTHROPIC_ADMIN_API_VERSION = '2023-06-01'
export const ANTHROPIC_COST_REPORT_MAX_PAGES = 8
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface AnthropicCostReport {
  /** Sum of every line item in the range, USD. */
  readonly totalUsd: number
  readonly currency: 'USD'
  readonly startingAt: string
  readonly endingAt: string
  readonly bucketCount: number
  readonly lineItemCount: number
}

export type AnthropicAdminUsageFailure =
  | 'no-key'
  | 'unauthorized'
  | 'rate-limited'
  | 'http'
  | 'network'
  | 'parse'

export type AnthropicCostReportOutcome =
  | { ok: true; report: AnthropicCostReport }
  | { ok: false; failure: AnthropicAdminUsageFailure; status?: number }

export interface FetchAnthropicCostReportInput {
  apiKey: string
  startingAt: string
  endingAt: string
  fetchImpl?: FetchLike
  maxPages?: number
  userAgent?: string
}

interface ParsedPage {
  cents: number
  bucketCount: number
  lineItemCount: number
  nextPage: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/** Decimal-string cents ("1234.5") or a number; null when not a finite value. */
function parseCents(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || !value.trim()) return null
  if (!/^-?\d+(?:\.\d+)?$/.test(value.trim())) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Pure page parser, exported so a captured body can be pinned in a test. */
export function parseAnthropicCostReportPage(body: unknown): ParsedPage | null {
  if (!isRecord(body) || !Array.isArray(body.data)) return null
  let cents = 0
  let lineItemCount = 0
  for (const bucket of body.data) {
    if (!isRecord(bucket)) return null
    const results = bucket.results
    if (results === undefined || results === null) continue
    if (!Array.isArray(results)) return null
    for (const result of results) {
      if (!isRecord(result)) return null
      const amount = parseCents(result.amount)
      if (amount === null) return null
      if (typeof result.currency === 'string' && result.currency.toUpperCase() !== 'USD') {
        return null
      }
      cents += amount
      lineItemCount += 1
    }
  }
  const nextPage =
    body.has_more === true && typeof body.next_page === 'string' && body.next_page
      ? body.next_page
      : null
  return { cents, bucketCount: body.data.length, lineItemCount, nextPage }
}

export async function fetchAnthropicCostReport(
  input: FetchAnthropicCostReportInput
): Promise<AnthropicCostReportOutcome> {
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
  if (!apiKey) return { ok: false, failure: 'no-key' }
  const fetchImpl = input.fetchImpl ?? (globalThis.fetch as FetchLike | undefined)
  if (!fetchImpl) return { ok: false, failure: 'network' }
  const maxPages = Math.max(1, input.maxPages ?? ANTHROPIC_COST_REPORT_MAX_PAGES)

  let cents = 0
  let bucketCount = 0
  let lineItemCount = 0
  let page: string | null = null
  for (let index = 0; index < maxPages; index += 1) {
    const url = new URL(ANTHROPIC_COST_REPORT_URL)
    url.searchParams.set('starting_at', input.startingAt)
    url.searchParams.set('ending_at', input.endingAt)
    if (page) url.searchParams.set('page', page)
    let response: Response
    try {
      response = await fetchImpl(url.toString(), {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_ADMIN_API_VERSION,
          accept: 'application/json',
          'user-agent': input.userAgent ?? 'TaskWraith (https://taskwraith.dev)'
        }
      })
    } catch {
      return { ok: false, failure: 'network' }
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, failure: 'unauthorized', status: response.status }
    }
    if (response.status === 429) return { ok: false, failure: 'rate-limited', status: 429 }
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, failure: 'http', status: response.status }
    }
    let text: string
    try {
      text = await response.text()
    } catch {
      return { ok: false, failure: 'network' }
    }
    if (text.length > MAX_RESPONSE_BYTES) return { ok: false, failure: 'parse' }
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return { ok: false, failure: 'parse' }
    }
    const parsed = parseAnthropicCostReportPage(body)
    if (!parsed) return { ok: false, failure: 'parse' }
    cents += parsed.cents
    bucketCount += parsed.bucketCount
    lineItemCount += parsed.lineItemCount
    page = parsed.nextPage
    if (!page) break
  }
  return {
    ok: true,
    report: {
      totalUsd: Math.round(cents) / 100,
      currency: 'USD',
      startingAt: input.startingAt,
      endingAt: input.endingAt,
      bucketCount,
      lineItemCount
    }
  }
}
