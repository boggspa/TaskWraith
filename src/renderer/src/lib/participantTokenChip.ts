import type { EnsembleParticipant } from '../../../main/store/types'

/**
 * 1.0.4-AV2 — compact per-participant token-spend chip.
 *
 * Originally rendered as a short numeric badge inside each
 * participant chip. 2026-07 chip polish moved the estimate off the
 * chip face and into the chip's 500ms hover tooltip
 * (`buildParticipantTokenChipTooltipLine` below) so the strip stays
 * lean and role names get the reclaimed width. Pre-AV2 token totals
 * lived only in the chat-level thread-token-tally pill at the bottom
 * of the composer — useful but didn't tell the user WHICH
 * participant was burning the budget.
 *
 * Compact format:
 *   < 1k         → omit (model returns empty label)
 *   1k–999k      → "Nk"   (e.g. "12k", "847k")
 *   ≥ 1,000k     → "N.Nm" (e.g. "1.2m", "14m")
 *
 * The tooltip line carries the precise breakdown (input / output /
 * total / duration) so power users still get unrounded numbers.
 *
 * Cost-in-dollars is deferred — accurate $-per-token rates differ
 * by model + provider tier, and we don't currently persist
 * per-message model rates. AV2 ships the token signal first; a
 * 1.0.5 follow-up can layer $-cost on top once we have a stable
 * model-rate registry.
 */

/**
 * 2026-07 chip polish — the full token-estimate line for the chip's
 * hover tooltip. Unlike the retired inline badge it has no 1k display
 * floor: any recorded spend gets a line (sub-1k shows the exact
 * count), and a participant with no spend gets an explicit
 * "No token usage yet" so the tooltip never renders a blank row.
 */
export function buildParticipantTokenChipTooltipLine(participant: EnsembleParticipant): string {
  const totals = participant.tokenTotals
  const total = typeof totals?.total_tokens === 'number' ? totals.total_tokens : 0
  if (!totals || !Number.isFinite(total) || total <= 0) {
    return 'No token usage yet'
  }
  const lead =
    total >= 1000 ? `≈ ${formatCompactTokens(total)} tokens` : `≈ ${total.toLocaleString()} tokens`
  const breakdown = formatTokenTooltip(totals)
  return breakdown ? `${lead} — ${breakdown}` : lead
}

function formatCompactTokens(total: number): string {
  if (total >= 1_000_000) {
    const millions = total / 1_000_000
    // 1.2m / 12m / 124m — one decimal under 10, integer above.
    return millions < 10 ? `${millions.toFixed(1)}m` : `${Math.round(millions)}m`
  }
  const thousands = total / 1000
  return `${Math.round(thousands)}k`
}

function formatTokenTooltip(totals: NonNullable<EnsembleParticipant['tokenTotals']>): string {
  const parts: string[] = []
  if (typeof totals.input_tokens === 'number' && totals.input_tokens > 0) {
    parts.push(`${totals.input_tokens.toLocaleString()} in`)
  }
  if (typeof totals.output_tokens === 'number' && totals.output_tokens > 0) {
    parts.push(`${totals.output_tokens.toLocaleString()} out`)
  }
  if (typeof totals.total_tokens === 'number' && totals.total_tokens > 0) {
    parts.push(`${totals.total_tokens.toLocaleString()} total`)
  }
  if (typeof totals.duration_ms === 'number' && totals.duration_ms > 0) {
    const seconds = totals.duration_ms / 1000
    parts.push(seconds >= 60 ? `${(seconds / 60).toFixed(1)}m` : `${seconds.toFixed(1)}s`)
  }
  return parts.join(' · ')
}
