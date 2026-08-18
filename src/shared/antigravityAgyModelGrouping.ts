/**
 * AntiGravity picker grouping: the agy catalogue (live discovery AND the
 * static floor) prints one bare wire id per reasoning variant —
 * `gemini-3.6-flash-high/-medium/-low` — with labels equal to ids. The
 * composer picker instead lists each HOST model once with a human-readable
 * name and drives the variant through the shared reasoning slider.
 *
 * The grouping is PATTERN-based (an explicit `-high|-medium|-low` suffix),
 * not a static relabel table, so live-discovered future variants group the
 * same way and an unknown id degrades to a prettified passthrough row.
 * `-thinking` is deliberately NOT an effort suffix — it names a distinct
 * model. Dispatch, persistence, pricing and context-window accounting all
 * keep seeing the CONCRETE variant id: the grouped row's id simply follows
 * the currently-selected variant of its family (falling back to the
 * catalogue-first variant), so selecting a row or moving the slider only
 * ever swaps which concrete id is selected.
 */

import { ANTIGRAVITY_GEMINI_API_MODEL_ID_PREFIX } from './antigravityGeminiApiModelNaming'

export type AntigravityEffort = 'high' | 'medium' | 'low'
export type AntigravityReasoningEffort = AntigravityEffort | 'on'

/** Slider presentation order (matches the Grok/Cursor ladder, low → high). */
export const ANTIGRAVITY_EFFORT_ORDER: readonly AntigravityEffort[] = ['low', 'medium', 'high']

const VARIANT_EFFORT_SUFFIX = /-(high|medium|low)$/
export const FAST_MODEL_IDS = new Set(['flash-3.7', 'flash-3.6', 'flash-3.5'])

const FIXED_REASONING_MODELS: Record<string, AntigravityReasoningEffort> = {
  'claude-sonnet-4-6': 'on',
  'claude-sonnet-4-6-thinking': 'on',
  'claude-opus-4-6': 'on',
  'claude-opus-4-6-thinking': 'on',
  'gpt-oss-120b-medium': 'medium'
}

export function antigravityEffortForModelId(modelId: string): AntigravityReasoningEffort | null {
  const normalized = modelId.trim().toLowerCase()
  const match = VARIANT_EFFORT_SUFFIX.exec(normalized)
  if (match) {
    return match[1] as AntigravityEffort
  }
  if (normalized.endsWith('-thinking')) return 'on'
  return FIXED_REASONING_MODELS[normalized] ?? null
}

function collectDisplayNameTokens(modelId: string): string[] {
  const normalized = modelId.trim().toLowerCase()
  const fixedEffort = FIXED_REASONING_MODELS[normalized]
  const suffixToStrip =
    fixedEffort === 'on'
      ? '-thinking'
      : fixedEffort
        ? `-${fixedEffort}`
        : ''
  const baseId =
    suffixToStrip && normalized.endsWith(suffixToStrip)
      ? normalized.slice(0, -suffixToStrip.length)
      : normalized
  const tokens = baseId.split('-').filter(Boolean)
  const words: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const lower = token.toLowerCase()
    if (lower === 'gpt' && tokens[i + 1]?.toLowerCase() === 'oss') {
      words.push('GPT-OSS')
      i += 1
      continue
    }
    // Consecutive bare integers are a dotted version: sonnet-4-6 → 4.6.
    if (/^\d+$/.test(token)) {
      const parts = [token]
      while (/^\d+$/.test(tokens[i + 1] || '')) {
        parts.push(tokens[i + 1])
        i += 1
      }
      words.push(parts.join('.'))
      continue
    }
    // Parameter-size tokens keep their magnitude: 120b → 120B.
    const sizeMatch = /^(\d+(?:\.\d+)?)b$/.exec(lower)
    if (sizeMatch) {
      words.push(`${sizeMatch[1]}B`)
      continue
    }
    // Dotted versions pass through: 3.6 → 3.6.
    if (/^\d+(?:\.\d+)+$/.test(token)) {
      words.push(token)
      continue
    }
    words.push(token.charAt(0).toUpperCase() + token.slice(1))
  }
  if (FAST_MODEL_IDS.has(normalized)) {
    words.push('Fast')
  }
  return words
}

export interface AntigravityVariantGroup {
  baseId: string
  displayName: string
  /** Present variants in slider order (low → high). */
  variants: Array<{ effort: AntigravityEffort; id: string }>
  /** Catalogue-first variant — what a fresh click on the row selects. */
  defaultId: string
}

export interface AntigravityGroupedModelRow {
  id: string
  label: string
  /** Concrete wire-model variants retained for a consumer that needs to
   * switch the family through the reasoning ladder. */
  antigravityVariants?: AntigravityVariantGroup['variants']
}

interface CatalogueOptionLike {
  id: string
  label?: string
}

/** Human-readable name for a bare agy id ('gemini-3.6-flash' → 'Gemini 3.6
 * Flash', 'claude-sonnet-4-6' → 'Claude Sonnet 4.6', 'gpt-oss-120b' →
 * 'GPT-OSS 120B'). Generic word rules plus a tiny exception map; an unknown
 * id still comes out readable. */
export function antigravityDisplayName(baseId: string): string {
  const normalized = baseId.trim().toLowerCase()
  if (normalized === 'claude-sonnet-4-6' || normalized === 'claude-sonnet-4-6-thinking') return 'Sonnet 4.6'
  if (normalized === 'claude-opus-4-6' || normalized === 'claude-opus-4-6-thinking') return 'Opus 4.6'
  if (normalized.startsWith('gpt-oss-120b')) return 'GPT-OSS (120B Param)'
  return collectDisplayNameTokens(baseId).join(' ')
}

function collectGroups(options: ReadonlyArray<CatalogueOptionLike>): {
  groupsByBase: Map<string, AntigravityVariantGroup>
  orderedEntries: Array<
    { kind: 'group'; baseId: string } | { kind: 'single'; id: string; label?: string }
  >
} {
  const groupsByBase = new Map<string, AntigravityVariantGroup>()
  const orderedEntries: Array<
    { kind: 'group'; baseId: string } | { kind: 'single'; id: string; label?: string }
  > = []
  for (const option of options) {
    const id = option.id
    if (id === 'custom') continue
    // The Gemini API lane is a different namespace with its own CURATED
    // labels (antigravityGeminiApiModelNaming) and no effort-suffix
    // convention — those rows pass through completely untouched. Grouping
    // and prettifying apply to the agy CLI lane's bare ids only.
    if (id.startsWith(ANTIGRAVITY_GEMINI_API_MODEL_ID_PREFIX)) {
      orderedEntries.push({ kind: 'single', id, label: option.label })
      continue
    }
    const normalized = id.trim().toLowerCase()
    const effort =
      !FIXED_REASONING_MODELS[normalized] && VARIANT_EFFORT_SUFFIX.exec(normalized)
        ? (antigravityEffortForModelId(id) as AntigravityEffort)
        : null
    if (!effort) {
      // A curated label (differing from the id) is authored — keep it.
      const curated = option.label && option.label !== id ? option.label : undefined
      orderedEntries.push({ kind: 'single', id, label: curated })
      continue
    }
    const baseId = id.slice(0, id.length - effort.length - 1)
    let group = groupsByBase.get(baseId)
    if (!group) {
      group = {
        baseId,
        displayName: antigravityDisplayName(baseId),
        variants: [],
        defaultId: id
      }
      groupsByBase.set(baseId, group)
      orderedEntries.push({ kind: 'group', baseId })
    }
    if (!group.variants.some((variant) => variant.id === id)) {
      group.variants.push({ effort, id })
    }
  }
  for (const group of groupsByBase.values()) {
    group.variants.sort(
      (a, b) =>
        ANTIGRAVITY_EFFORT_ORDER.indexOf(a.effort) - ANTIGRAVITY_EFFORT_ORDER.indexOf(b.effort)
    )
  }
  return { groupsByBase, orderedEntries }
}

/** One picker row per host model, catalogue order preserved by first
 * appearance. A grouped row's id follows the selected variant of its family
 * so the picker's `id === selectedModelId` check works unchanged. */
export function groupAntigravityModelRows(
  options: ReadonlyArray<CatalogueOptionLike>,
  selectedModelId?: string
): AntigravityGroupedModelRow[] {
  const { groupsByBase, orderedEntries } = collectGroups(options)
  return orderedEntries.map((entry) => {
    if (entry.kind === 'single') {
      return { id: entry.id, label: entry.label ?? antigravityDisplayName(entry.id) }
    }
    const group = groupsByBase.get(entry.baseId)!
    const selected = selectedModelId
      ? group.variants.find((variant) => variant.id === selectedModelId)
      : undefined
    return {
      id: selected?.id ?? group.defaultId,
      label: group.displayName,
      antigravityVariants: group.variants
    }
  })
}

/** The variant family containing `modelId`, or null for suffix-less models. */
export function antigravityVariantGroupForModel(
  options: ReadonlyArray<CatalogueOptionLike>,
  modelId: string
): AntigravityVariantGroup | null {
  const { groupsByBase } = collectGroups(options)
  for (const group of groupsByBase.values()) {
    if (group.variants.some((variant) => variant.id === modelId)) return group
  }
  return null
}
