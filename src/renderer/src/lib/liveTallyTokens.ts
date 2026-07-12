/**
 * Reconciles the composer footer's live token figures from three sources:
 *
 *  - `base*` — sealed `ChatRun.stats`, i.e. completed turns only.
 *  - `estimatedOutputTokens` — the renderer's `chars ÷ 4` fallback for the
 *    in-flight turn (aggregated across every active lane's streamed text).
 *  - `snapshot*` — the provider's authoritative live usage for the active run,
 *    delivered over the `participant-working-telemetry` lane (ensemble seats
 *    always; solo runs since `SoloWorkingTokenTelemetry`).
 *
 * The char estimate can only see visible text, so it undercounts reasoning +
 * tool-call output and then "snaps" upward when the run seals. Preferring the
 * authoritative snapshot fixes that, while `Math.max` with the estimate keeps
 * the number from ever regressing below the multi-lane text aggregate (the
 * snapshot only covers the single active run passed to the footer).
 *
 * Input has no char estimate, so live input rides entirely on the snapshot —
 * the in-flight turn's prompt tokens are otherwise absent from `base` until the
 * run seals.
 */

export interface LiveTallyTokenInputs {
  running: boolean
  baseInputTokens: number
  baseOutputTokens: number
  /** Renderer `chars ÷ 4` estimate for the in-flight turn's output. */
  estimatedOutputTokens: number
  /** Authoritative provider snapshot for the active run (0 / undefined = none). */
  snapshotInputTokens?: number
  snapshotOutputTokens?: number
}

export interface LiveTallyTokens {
  /** Displayed "in" figure: sealed input plus the active run's live input. */
  inputTokens: number
  /** Animation target for the "out" figure: sealed output plus live output. */
  outputTokensTarget: number
  /** Live input beyond `base` (for pricing the in-flight turn's input). */
  liveInputExtra: number
  /** Live output beyond `base` (for pricing the in-flight turn's output). */
  liveOutputExtra: number
  /** True when the live "out" figure is backed by the provider snapshot rather
   * than the char estimate — drives the tooltip wording. */
  authoritative: boolean
}

function nonNegativeInteger(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.trunc(value as number) : 0
}

export function resolveLiveTallyTokens(inputs: LiveTallyTokenInputs): LiveTallyTokens {
  const baseInputTokens = nonNegativeInteger(inputs.baseInputTokens)
  const baseOutputTokens = nonNegativeInteger(inputs.baseOutputTokens)

  if (!inputs.running) {
    return {
      inputTokens: baseInputTokens,
      outputTokensTarget: baseOutputTokens,
      liveInputExtra: 0,
      liveOutputExtra: 0,
      authoritative: false
    }
  }

  const estimatedOutputTokens = nonNegativeInteger(inputs.estimatedOutputTokens)
  const snapshotOutputTokens = nonNegativeInteger(inputs.snapshotOutputTokens)
  const snapshotInputTokens = nonNegativeInteger(inputs.snapshotInputTokens)

  const liveOutputExtra = Math.max(estimatedOutputTokens, snapshotOutputTokens)
  const liveInputExtra = snapshotInputTokens
  // The snapshot "leads" the displayed number (and is therefore what the user
  // sees) only when it meets or beats the text aggregate. Early in a turn, or
  // across a multi-lane fan-out the single snapshot can't cover, the estimate
  // leads and the figure stays flagged as an estimate.
  const authoritative =
    snapshotOutputTokens > 0 && snapshotOutputTokens >= estimatedOutputTokens

  return {
    inputTokens: baseInputTokens + liveInputExtra,
    outputTokensTarget: baseOutputTokens + liveOutputExtra,
    liveInputExtra,
    liveOutputExtra,
    authoritative
  }
}
