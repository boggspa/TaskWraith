/**
 * Meta Muse reasoning-effort vocabulary and model-specific availability.
 *
 * Muse Code 1.0.3 accepts both `max` and `ultra` on its exec argv. The Meta
 * provider catalog published 2026-09-04 exposes the new `max` tier only for
 * regular Muse Spark 1.3. The 2026-10-12 catalogue also publishes Max for
 * Wonder 1.0 and Wonder Full 1.0. TaskWraith already offers the CLI-compatible
 * `ultra` tier, so keep it available while adding Max to the Wonder routes.
 */

export const MUSE_META_REASONING_EFFORTS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
] as const

export type MuseMetaReasoningEffort = (typeof MUSE_META_REASONING_EFFORTS)[number]

export const MUSE_META_REASONING_EFFORT_LABELS: Readonly<Record<MuseMetaReasoningEffort, string>> =
  {
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra High',
    max: 'Max',
    ultra: 'Ultra'
  }

const MUSE_META_REASONING_EFFORTS_WITHOUT_MAX: readonly MuseMetaReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'ultra'
]

export const MUSE_MAX_REASONING_MODEL_IDS = [
  'muse-wonder-1.0',
  'muse-wonder-full-1.0',
  'muse-spark-1.3'
] as const

const MUSE_MAX_REASONING_MODEL_ID_SET: ReadonlySet<string> = new Set(MUSE_MAX_REASONING_MODEL_IDS)

export function museModelSupportsMaxReasoning(modelId: string | null | undefined): boolean {
  return (
    typeof modelId === 'string' && MUSE_MAX_REASONING_MODEL_ID_SET.has(modelId.trim().toLowerCase())
  )
}

export function museReasoningEffortsForModel(
  modelId: string | null | undefined
): readonly MuseMetaReasoningEffort[] {
  return museModelSupportsMaxReasoning(modelId)
    ? MUSE_META_REASONING_EFFORTS
    : MUSE_META_REASONING_EFFORTS_WITHOUT_MAX
}
