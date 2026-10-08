/**
 * OpenAI organisation costs — the Codex / OpenAI API bill for a period.
 *
 *   GET https://api.openai.com/v1/organization/costs
 *       ?start_time=<unix s>&end_time=<unix s>&bucket_width=1d&limit=31
 *       [&project_ids=<proj_…>][&page=<cursor>]
 *   Authorization: Bearer <admin API key>
 *
 * Shape as decoded live by Limit Counter's OpenAIUsageProviderClient
 * (App/Providers/ProviderClient.swift, `OpenAICostBucketPage`): a page object
 * with `data[]` buckets (`start_time`, `end_time`, `results[]`), each result
 * carrying `amount: { value, currency }`, `line_item` and `project_id`, plus
 * `has_more` / `next_page`. `value` is in whole currency units (dollars), not
 * cents — the opposite of Anthropic's report, hence two modules rather than
 * one parameterised fetcher.
 *
 * An admin key is required; a project key returns 401/403, surfaced as
 * `unauthorized`. The optional project id narrows the bill to one project,
 * which is how a user whose org also runs production traffic keeps the Codex
 * figure honest.
 *
 * Fail closed on unreadable amounts, as the Anthropic module does.
 */

export const OPENAI_COSTS_URL = 'https://api.openai.com/v1/organization/costs'
export const OPENAI_COSTS_MAX_PAGES = 4
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface OpenAiCostReport {
  readonly total: number
  /** ISO-4217 as reported (upper-cased); 'USD' when the API omits it. */
  readonly currency: string
  readonly startTime: string
  readonly endTime: string
  readonly bucketCount: number
  readonly lineItemCount: number
  readonly projectId: string | null
}

export type OpenAiAdminUsageFailure =
  | 'no-key'
  | 'unauthorized'
  | 'rate-limited'
  | 'http'
  | 'network'
  | 'parse'

export type OpenAiCostReportOutcome =
  | { ok: true; report: OpenAiCostReport }
  | { ok: false; failure: OpenAiAdminUsageFailure; status?: number }

export interface FetchOpenAiCostReportInput {
  apiKey: string
  /** Inclusive range start, epoch milliseconds. */
  startTimeMs: number
  /** Exclusive range end, epoch milliseconds. */
  endTimeMs: number
  projectId?: string | null
  fetchImpl?: FetchLike
  maxPages?: number
  userAgent?: string
}

interface ParsedPage {
  total: number
  currency: string | null
  bucketCount: number
  lineItemCount: number
  nextPage: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function parseAmountValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** Pure page parser, exported so a captured body can be pinned in a test. */
export function parseOpenAiCostPage(body: unknown): ParsedPage | null {
  if (!isRecord(body) || !Array.isArray(body.data)) return null
  let total = 0
  let currency: string | null = null
  let lineItemCount = 0
  for (const bucket of body.data) {
    if (!isRecord(bucket)) return null
    const results = bucket.results
    if (results === undefined || results === null) continue
    if (!Array.isArray(results)) return null
    for (const result of results) {
      if (!isRecord(result) || !isRecord(result.amount)) return null
      const value = parseAmountValue(result.amount.value)
      if (value === null) return null
      const unit =
        typeof result.amount.currency === 'string' && result.amount.currency.trim()
          ? result.amount.currency.trim().toUpperCase()
          : null
      if (unit) {
        if (currency && currency !== unit) return null
        currency = unit
      }
      total += value
      lineItemCount += 1
    }
  }
  const nextPage =
    body.has_more === true && typeof body.next_page === 'string' && body.next_page
      ? body.next_page
      : null
  return { total, currency, bucketCount: body.data.length, lineItemCount, nextPage }
}

export async function fetchOpenAiCostReport(
  input: FetchOpenAiCostReportInput
): Promise<OpenAiCostReportOutcome> {
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
  if (!apiKey) return { ok: false, failure: 'no-key' }
  const fetchImpl = input.fetchImpl ?? (globalThis.fetch as FetchLike | undefined)
  if (!fetchImpl) return { ok: false, failure: 'network' }
  const maxPages = Math.max(1, input.maxPages ?? OPENAI_COSTS_MAX_PAGES)
  const projectId =
    typeof input.projectId === 'string' && input.projectId.trim() ? input.projectId.trim() : null

  let total = 0
  let currency: string | null = null
  let bucketCount = 0
  let lineItemCount = 0
  let page: string | null = null
  for (let index = 0; index < maxPages; index += 1) {
    const url = new URL(OPENAI_COSTS_URL)
    url.searchParams.set('start_time', String(Math.floor(input.startTimeMs / 1000)))
    url.searchParams.set('end_time', String(Math.floor(input.endTimeMs / 1000)))
    url.searchParams.set('bucket_width', '1d')
    url.searchParams.set('limit', '31')
    if (projectId) url.searchParams.set('project_ids', projectId)
    if (page) url.searchParams.set('page', page)
    let response: Response
    try {
      response = await fetchImpl(url.toString(), {
        method: 'GET',
        headers: {
          authorization: `Bearer ${apiKey}`,
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
    const parsed = parseOpenAiCostPage(body)
    if (!parsed) return { ok: false, failure: 'parse' }
    if (parsed.currency) {
      if (currency && currency !== parsed.currency) return { ok: false, failure: 'parse' }
      currency = parsed.currency
    }
    total += parsed.total
    bucketCount += parsed.bucketCount
    lineItemCount += parsed.lineItemCount
    page = parsed.nextPage
    if (!page) break
  }
  return {
    ok: true,
    report: {
      total: Math.round(total * 100) / 100,
      currency: currency ?? 'USD',
      startTime: new Date(input.startTimeMs).toISOString(),
      endTime: new Date(input.endTimeMs).toISOString(),
      bucketCount,
      lineItemCount,
      projectId
    }
  }
}
