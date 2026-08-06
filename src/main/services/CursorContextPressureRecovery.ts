/**
 * Cursor Path-B mid-turn context pressure recovery.
 *
 * Path-B has no host compact RPC and no resume token. When a Cursor seat sits
 * at critical occupancy without token growth, the harness cancels the hung
 * child, persists an extractive host summary (prunable transcript prefix),
 * and re-dispatches the same seat as a fresh Path-B turn. User-facing UX is
 * the ordinary compaction card — not a failed-participant coda.
 */
import type { ChatMessage } from '../store/types'
import {
  CONTEXT_PRESSURE_CRITICAL_PERCENT,
  type ContextCompactionProvenance
} from '../../shared/contextCompaction'

/** Quiet window at critical occupancy before recovery fires (longer than the
 * renderer’s 20s “likely compacting” hint so we do not thrash on brief stalls). */
export const CURSOR_CONTEXT_PRESSURE_QUIET_MS = 45_000

/** Trailing transcript rows kept verbatim after a host prune. */
export const CURSOR_CONTEXT_RECOVERY_RETAIN_MESSAGES = 12

/** Summary body hard cap (matches seat summary injection budget). */
const SUMMARY_TEXT_MAX_CHARS = 6_000

export type CursorContextPressureRecoveryDecision =
  | { readonly kind: 'wait' }
  | { readonly kind: 'recover'; readonly reason: string }

export function decideCursorContextPressureRecovery(input: {
  readonly transportLiveness: 'alive' | 'exited' | 'unknown'
  readonly hasActiveToolOrApproval: boolean
  readonly contextPressurePercent: number | null | undefined
  readonly nowMs: number
  readonly lastTokenGrowthAt: number | null | undefined
  readonly quietMs?: number
  readonly criticalPercent?: number
}): CursorContextPressureRecoveryDecision {
  if (input.hasActiveToolOrApproval) return { kind: 'wait' }
  if (input.transportLiveness !== 'alive') return { kind: 'wait' }
  const percent = input.contextPressurePercent
  const critical = input.criticalPercent ?? CONTEXT_PRESSURE_CRITICAL_PERCENT
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < critical) {
    return { kind: 'wait' }
  }
  const lastGrowth = input.lastTokenGrowthAt
  if (typeof lastGrowth !== 'number' || !Number.isFinite(lastGrowth)) {
    return { kind: 'wait' }
  }
  const quietMs = input.quietMs ?? CURSOR_CONTEXT_PRESSURE_QUIET_MS
  if (input.nowMs - lastGrowth < quietMs) return { kind: 'wait' }
  return {
    kind: 'recover',
    reason:
      `Cursor context occupancy reached ${Math.round(percent)}% with no token growth ` +
      `for ${Math.round(quietMs / 1000)}s; recovering with a fresh Path-B turn.`
  }
}

export interface CursorPathBCompactionSummary {
  text: string
  createdAt: string
  provider: 'cursor'
  preTokens?: number
  provenance: ContextCompactionProvenance
}

/**
 * Build an extractive host summary covering a contiguous transcript prefix so
 * the next Ensemble prompt can prune those rows and inject the summary block.
 * Recent trailing messages stay in the live window.
 */
export function buildCursorPathBCompactionSummary(input: {
  messages: readonly ChatMessage[]
  roundPrompt: string
  nowIso: string
  preTokens?: number
  retainRecentMessages?: number
}): CursorPathBCompactionSummary | null {
  const messages = input.messages.filter((message) => message && typeof message.id === 'string')
  if (messages.length === 0) return null
  const retain = Math.max(
    1,
    Math.trunc(input.retainRecentMessages ?? CURSOR_CONTEXT_RECOVERY_RETAIN_MESSAGES)
  )
  const cutIndex = Math.max(0, messages.length - retain)
  if (cutIndex <= 0) {
    // Nothing safe to prune — still stamp a short recovery note so the next
    // Path-B turn gets a harder char budget via the summary injection path.
    const prompt = sanitizeSummaryText(input.roundPrompt).slice(0, 800)
    return {
      text: [
        'Host recovered a Cursor Path-B seat at full context.',
        prompt ? `Round objective: ${prompt}` : null,
        'Continue from the live trailing transcript; prior context was already short.'
      ]
        .filter(Boolean)
        .join('\n'),
      createdAt: input.nowIso,
      provider: 'cursor',
      ...(typeof input.preTokens === 'number' && Number.isFinite(input.preTokens)
        ? { preTokens: input.preTokens }
        : {}),
      provenance: {
        kind: 'bounded_prompt_window',
        suppliedMessageIds: messages.map((message) => message.id),
        carriedForwardMessageIds: []
      }
    }
  }

  const covered = messages.slice(0, cutIndex)
  const coveredMessageIds = covered.map((message) => message.id)
  const throughMessageId = coveredMessageIds[coveredMessageIds.length - 1]!
  const lines: string[] = [
    'Host recovered a Cursor Path-B seat at full context by summarizing an earlier transcript prefix.',
    `Round objective: ${sanitizeSummaryText(input.roundPrompt).slice(0, 800) || '(none)'}`
  ]
  let used = lines.join('\n').length
  for (const message of covered) {
    const role =
      message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : 'System'
    const body = sanitizeSummaryText(message.content).slice(0, 280)
    if (!body) continue
    const line = `- ${role}: ${body}`
    if (used + line.length + 1 > SUMMARY_TEXT_MAX_CHARS) {
      lines.push('[earlier transcript truncated in host summary]')
      break
    }
    lines.push(line)
    used += line.length + 1
  }

  return {
    text: lines.join('\n'),
    createdAt: input.nowIso,
    provider: 'cursor',
    ...(typeof input.preTokens === 'number' && Number.isFinite(input.preTokens)
      ? { preTokens: input.preTokens }
      : {}),
    provenance: {
      kind: 'contiguous_prompt_prefix',
      throughMessageId,
      coveredMessageIds
    }
  }
}

function sanitizeSummaryText(value: string | undefined): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
}
