import type { UsageWindowAggregate } from './usageAggregateTypes'

/*
 * quotaSegments — pass 1 dash-marker mapper (Limit Counter parity).
 *
 * Port of Limit Counter's `QuotaWindow.segmentCount(for:)`
 * (`Shared/Models/QuotaModels.swift:762-811`): each usage meter gets
 * one dash per natural subdivision of its window, rendered as
 * `count - 1` divider ticks on the progress bar. Rendering lives in
 * `QuotaProgressBar.tsx` (`segmentCount` prop); this module is the
 * single source of truth for the count so every call site
 * (ModelUsageCard, GrokCreditsMeter, MistralQuotaMeter) agrees.
 *
 * USER'S CANONICAL DASH SPEC (acceptance target):
 *   Codex: 5H/Session (Plus/Free/Go) = 5 (1/hour); Weekly = 7 (1/day);
 *     Spark 5H (Pro) = 5; Spark Weekly (Pro) = 7; Luna Reserve = 7
 *     (weekly assumed from reset times).
 *   Claude: Session (5H) = 5; Weekly (7D) = 7; Fable (Weekly, Max
 *     x5 / Max x20 only) = 7.
 *   Kimi: Session (5H) = 5; Weekly (7D) = 7; Monthly (4W/31D) = 4
 *     (1 per week).
 *   AntiGravity: Gemini Session (5H) = 5; Gemini Weekly (7D) = 7;
 *     Claude/GPT Session (5H) = 5; Claude/GPT Weekly (7D) = 7.
 *   Mistral: API Usage (monthly) = 4; Vibe Code Usage (monthly) = 4.
 *   Cursor: Plan Usage (monthly) = 4; Auto Usage (monthly) = 4;
 *     API Usage (monthly) = 4.
 *   Grok: Weekly (7D) = 7.
 *   Ollama: Session (5H) = 5; Weekly (7D) = 7.
 *   Devin: Daily (24H) = 6 (1 per 4-hour division); Weekly (7D) = 7.
 *   MiMo Token Plan: Monthly (4W/31D) = 4.
 *   Qwen Token Plan: Session (5H) = 5 [CURRENTLY DISABLED — mapped
 *     here, never enable it at a call site]; Weekly (7D) = 7.
 *   Meta API: Weekly (7D) = 7; Credit Used (monthly on 1st) = 4;
 *     "Current usage" = null (period unknown, research pending).
 *   DeepSeek / Cerebras / OpenRouter: Credit Used (monthly on
 *     custom date) = 4.
 *
 * Resolution order (first match wins; unknown => null, never throw;
 * null = render NO ticks):
 *   0. trackingOnly === true && limitWindowSeconds == null -> null
 *   1. limitWindowSeconds present: 14400..21600 -> 5 | 82800..93600
 *      -> 6 if provider === 'devin' else null | 561600..648000 -> 7
 *      | >= 2073600 -> 4 (else fall through to regex)
 *   2. regex over `${id} ${label} ${windowKind ?? ''}`:
 *      /5\s?h|session/i -> 5; /week|weekly|7[-\s]?day|luna|fable/i
 *      -> 7; /month|credit|plan|vibe|auto|api\s?usage/i -> 4;
 *      /daily|24\s?h/i -> 6 if provider === 'devin' else null
 *   3. else null
 */

export type QuotaSegmentCount = 4 | 5 | 6 | 7

type QuotaSegmentWindow = Pick<
  UsageWindowAggregate,
  'id' | 'label' | 'windowKind' | 'limitWindowSeconds' | 'trackingOnly'
>

const FIVE_HOUR_MIN = 14400
const FIVE_HOUR_MAX = 21600
const DAILY_MIN = 82800
const DAILY_MAX = 93600
const WEEKLY_MIN = 561600
const WEEKLY_MAX = 648000
const MONTHLY_MIN = 2073600

export function quotaSegmentCount(
  provider: string,
  window: QuotaSegmentWindow
): QuotaSegmentCount | null {
  if (window.trackingOnly === true && window.limitWindowSeconds == null) {
    return null
  }

  const duration = window.limitWindowSeconds
  if (typeof duration === 'number' && Number.isFinite(duration)) {
    if (duration >= FIVE_HOUR_MIN && duration <= FIVE_HOUR_MAX) {
      return 5
    }
    if (duration >= DAILY_MIN && duration <= DAILY_MAX) {
      return provider.toLowerCase() === 'devin' ? 6 : null
    }
    if (duration >= WEEKLY_MIN && duration <= WEEKLY_MAX) {
      return 7
    }
    if (duration >= MONTHLY_MIN) {
      return 4
    }
  }

  const haystack = `${window.id ?? ''} ${window.label ?? ''} ${window.windowKind ?? ''}`
  if (/5\s?h|session/i.test(haystack)) {
    return 5
  }
  if (/week|weekly|7[-\s]?day|luna|fable/i.test(haystack)) {
    return 7
  }
  if (/month|credit|plan|vibe|auto|api\s?usage/i.test(haystack)) {
    return 4
  }
  if (/daily|24\s?h/i.test(haystack)) {
    return provider.toLowerCase() === 'devin' ? 6 : null
  }

  return null
}
