import { describe, expect, it } from 'vitest'
import {
  DEVIN_DEFAULT_MODEL_ID,
  DEVIN_MODEL_CATALOG,
  DEVIN_MODEL_IDS,
  DEVIN_MODEL_LABELS,
  DEVIN_REASONING_EFFORT_LADDER,
  devinDefaultReasoningEffort,
  devinModelDescription,
  devinReasoningEfforts,
  findDevinCatalogRow,
  findDevinVariant,
  isDevinCatalogModelId,
  normalizeDevinModelId,
  normalizeDevinReasoningEffort,
  resolveDevinVariantId
} from './devinModelCatalog'

describe('devinModelCatalog', () => {
  it('leads with the Cognition default and never offers a cli-default sentinel', () => {
    expect(DEVIN_DEFAULT_MODEL_ID).toBe('swe-1-6-slow')
    expect(DEVIN_MODEL_CATALOG[0]?.id).toBe(DEVIN_DEFAULT_MODEL_ID)
    expect(DEVIN_MODEL_CATALOG[0]?.vendor).toBe('Cognition')
    for (const sentinel of ['cli-default', 'default', 'custom', 'auto', 'best']) {
      expect(DEVIN_MODEL_IDS).not.toContain(sentinel)
    }
  })

  it('keeps every family and variant a unique humanised slug carrying the CLI label', () => {
    // Guard against a vacuous pass: the catalogue must actually have rows.
    expect(DEVIN_MODEL_CATALOG.length).toBeGreaterThan(20)
    expect(new Set(DEVIN_MODEL_IDS).size).toBe(DEVIN_MODEL_IDS.length)
    const uids = DEVIN_MODEL_CATALOG.flatMap((family) => family.variants.map((v) => v.uid))
    expect(uids.length).toBeGreaterThan(DEVIN_MODEL_CATALOG.length)
    expect(new Set(uids).size).toBe(uids.length)
    for (const family of DEVIN_MODEL_CATALOG) {
      expect(family.id, family.label).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      expect(family.label.trim().length, family.id).toBeGreaterThan(0)
      expect(family.variants.length, family.id).toBeGreaterThan(0)
      expect(family.defaultEffort, family.id).toBe(family.variants[0]?.effort ?? null)
      expect(family.pricing.output, family.id).toBeGreaterThan(0)
      expect(DEVIN_MODEL_LABELS[family.id]).toBe(family.label)
      for (const variant of family.variants) {
        expect(variant.uid, family.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        expect(variant.uid.startsWith(family.id.replace(/-1m$/, '')), variant.uid).toBe(true)
        // A family whose default variant shares its id (SWE-1.7's bare `swe-1-7`)
        // labels as the family; every other variant keeps the CLI's variant label.
        expect(DEVIN_MODEL_LABELS[variant.uid]).toBe(
          variant.uid === family.id ? family.label : variant.label
        )
      }
      // A multi-variant family is a reasoning ladder: every variant pins a level.
      if (family.variants.length > 1) {
        for (const variant of family.variants) expect(variant.effort, variant.uid).not.toBeNull()
      }
    }
    expect(DEVIN_MODEL_LABELS['claude-opus-5']).toBe('Claude Opus 5')
    expect(DEVIN_MODEL_LABELS['claude-opus-5-high']).toBe('Claude Opus 5 High')
  })

  it('omits speed-tier duplicates and opaque legacy uids', () => {
    const uids = DEVIN_MODEL_CATALOG.flatMap((family) => family.variants.map((v) => v.uid))
    for (const uid of uids) {
      expect(uid.endsWith('-priority'), uid).toBe(false)
      expect(uid.startsWith('model_'), uid).toBe(false)
    }
    // SWE-1.6 Fast is its own family, not a speed tier of another row.
    expect(uids.filter((uid) => uid.endsWith('-fast'))).toEqual(['swe-1-6-fast'])
    expect(DEVIN_MODEL_IDS).toContain('adaptive')
    expect(DEVIN_MODEL_IDS).toContain('glm-5-2-1m')
  })

  it('exposes each family ladder in ladder order with the CLI default level', () => {
    expect(devinReasoningEfforts('claude-opus-5')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ])
    expect(devinDefaultReasoningEffort('claude-opus-5')).toBe('medium')
    expect(devinReasoningEfforts('gpt-5-6-terra')).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ])
    expect(devinDefaultReasoningEffort('gpt-5-6-terra')).toBe('none')
    expect(devinReasoningEfforts('swe-1-7')).toEqual(['medium', 'max'])
    expect(devinDefaultReasoningEffort('swe-1-7')).toBe('max')
    // Single-variant families have no axis at all.
    expect(devinReasoningEfforts('adaptive')).toEqual([])
    expect(devinReasoningEfforts('swe-1-6-fast')).toEqual([])
    expect(devinDefaultReasoningEffort('adaptive')).toBeNull()
    expect(devinReasoningEfforts('not-a-family')).toEqual([])
    for (const effort of DEVIN_REASONING_EFFORT_LADDER) {
      expect(normalizeDevinReasoningEffort(effort.toUpperCase())).toBe(effort)
    }
    expect(normalizeDevinReasoningEffort('extra')).toBe('xhigh')
    expect(normalizeDevinReasoningEffort('off')).toBe('none')
    expect(normalizeDevinReasoningEffort('ultracode')).toBeNull()
  })

  it('normalises sentinels to the default, variants to their family, and custom ids verbatim', () => {
    for (const sentinel of [
      '',
      '  ',
      'default',
      'cli-default',
      'CLI-DEFAULT',
      'auto',
      'custom',
      'best'
    ]) {
      expect(normalizeDevinModelId(sentinel), JSON.stringify(sentinel)).toBe('swe-1-6-slow')
    }
    expect(normalizeDevinModelId(null)).toBe('swe-1-6-slow')
    expect(normalizeDevinModelId(undefined)).toBe('swe-1-6-slow')
    expect(normalizeDevinModelId(' Claude-Opus-5 ')).toBe('claude-opus-5')
    expect(normalizeDevinModelId('claude-opus-5-high')).toBe('claude-opus-5')
    expect(normalizeDevinModelId('glm-5-2-max-1m')).toBe('glm-5-2-1m')
    // Outside the catalogue: pass through trimmed, never substituted.
    expect(normalizeDevinModelId(' claude-opus-4-8-high ')).toBe('claude-opus-4-8-high')
    expect(isDevinCatalogModelId('adaptive')).toBe(true)
    expect(isDevinCatalogModelId('claude-opus-5-high')).toBe(false)
    expect(findDevinCatalogRow('gemini-3-7-flash')?.vendor).toBe('Google')
    expect(findDevinVariant('gemini-3-7-flash-high')?.family.id).toBe('gemini-3-7-flash')
    expect(findDevinCatalogRow('nope')).toBeNull()
  })

  it('folds family + effort into the exact CLI variant uid', () => {
    expect(resolveDevinVariantId('claude-opus-5', 'high')).toBe('claude-opus-5-high')
    expect(resolveDevinVariantId('claude-opus-5', 'EXTRA')).toBe('claude-opus-5-xhigh')
    // No effort, or one the family does not offer → the family default variant.
    expect(resolveDevinVariantId('claude-opus-5', null)).toBe('claude-opus-5-medium')
    expect(resolveDevinVariantId('gemini-3-7-flash', 'max')).toBe('gemini-3-7-flash-medium')
    // SWE-1.7 at Max is the bare uid; Medium is suffixed.
    expect(resolveDevinVariantId('swe-1-7', undefined)).toBe('swe-1-7')
    expect(resolveDevinVariantId('swe-1-7', 'medium')).toBe('swe-1-7-medium')
    // GLM-5.2's 1M context is a separate family with its own ladder.
    expect(resolveDevinVariantId('glm-5-2-1m', 'none')).toBe('glm-5-2-none-1m')
    // Single-variant families ignore the effort.
    expect(resolveDevinVariantId('adaptive', 'max')).toBe('adaptive')
    // Sentinels dispatch the default family's only variant; SWE-1.6 Slow has
    // no ladder, so a carried effort is ignored rather than mis-suffixed.
    expect(resolveDevinVariantId('cli-default', null)).toBe('swe-1-6-slow')
    expect(resolveDevinVariantId('', 'medium')).toBe('swe-1-6-slow')
    // A recorded variant keeps itself unless an offered effort overrides it.
    expect(resolveDevinVariantId('claude-opus-5-high', null)).toBe('claude-opus-5-high')
    expect(resolveDevinVariantId('claude-opus-5-high', 'low')).toBe('claude-opus-5-low')
    // Custom ids pass through verbatim.
    expect(resolveDevinVariantId(' claude-opus-4-8-high ', 'max')).toBe('claude-opus-4-8-high')
  })

  it('describes families with vendor and the CLI list price', () => {
    expect(devinModelDescription(findDevinCatalogRow('swe-1-6-slow')!)).toBe(
      'Cognition · $0.5 in / $2.5 out per 1M tokens'
    )
    expect(devinModelDescription(findDevinCatalogRow('claude-fable-5-1')!)).toBe(
      'Anthropic via Devin · $10 in / $50 out per 1M tokens · new'
    )
    expect(devinModelDescription(findDevinCatalogRow('grok-4-6')!)).toBe(
      'xAI via Devin · $2 in / $6 out per 1M tokens · new · beta'
    )
  })
})
