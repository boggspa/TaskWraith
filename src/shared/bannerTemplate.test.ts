import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_ARCHETYPES,
  ACTIVITY_ARCHETYPE_PRESETS,
  BANNER_TEMPLATE_VERSION,
  DEFAULT_ACTIVITY_ARCHETYPE,
  sanitizeActivityAppearance,
  DEFAULT_BANNER_TEMPLATE,
  extractTokens,
  renderBannerPreview,
  sanitizeBannerTemplate,
  validateBannerTemplate,
  type BannerRenderInput,
  type BannerStatus,
  type BannerTemplate
} from './bannerTemplate'
// The shared corpus. Swift asserts the SAME file — see TWBannerFixtureTests.
import fixtures from './bannerTemplateFixtures.json'

const clone = (): BannerTemplate => JSON.parse(JSON.stringify(DEFAULT_BANNER_TEMPLATE))

describe('sanitizeBannerTemplate', () => {
  it('passes the default through unchanged', () => {
    expect(sanitizeBannerTemplate(DEFAULT_BANNER_TEMPLATE)).toEqual(DEFAULT_BANNER_TEMPLATE)
  })

  it('returns the default for junk input', () => {
    expect(sanitizeBannerTemplate(undefined)).toEqual(DEFAULT_BANNER_TEMPLATE)
    expect(sanitizeBannerTemplate(null)).toEqual(DEFAULT_BANNER_TEMPLATE)
    expect(sanitizeBannerTemplate({})).toEqual(DEFAULT_BANNER_TEMPLATE)
    expect(sanitizeBannerTemplate('nope')).toEqual(DEFAULT_BANNER_TEMPLATE)
  })

  it('clamps pathological values to the same bounds as the Swift sanitizer', () => {
    const t = sanitizeBannerTemplate({
      ...clone(),
      previewSentences: 9999,
      previewCap: 100000,
      titleFormat: 't'.repeat(900),
      bodyLines: Array.from({ length: 40 }, () => 'x'.repeat(900)),
      diffSeparator: '-'.repeat(50)
    })
    expect(t.previewSentences).toBe(6)
    expect(t.previewCap).toBe(400)
    expect(t.titleFormat).toHaveLength(120)
    expect(t.bodyLines).toHaveLength(4)
    expect(t.bodyLines.every((l) => l.length === 200)).toBe(true)
    expect(t.diffSeparator).toHaveLength(8)
  })

  it('raises values that are below the floor', () => {
    const t = sanitizeBannerTemplate({ ...clone(), previewSentences: 0, previewCap: 1 })
    expect(t.previewSentences).toBe(1)
    expect(t.previewCap).toBe(20)
  })

  it('forces the current version so a forged version cannot be persisted', () => {
    const t = sanitizeBannerTemplate({ ...clone(), version: 99 })
    expect(t.version).toBe(BANNER_TEMPLATE_VERSION)
  })

  it('drops diff segments with an unknown field', () => {
    const t = sanitizeBannerTemplate({
      ...clone(),
      diffSegments: [
        { field: 'additions', format: '+{value}' },
        { field: 'wat', format: 'x' } as never
      ]
    })
    expect(t.diffSegments).toEqual([{ field: 'additions', format: '+{value}' }])
  })

  it('falls back rather than emitting an empty diff or body', () => {
    const t = sanitizeBannerTemplate({ ...clone(), diffSegments: [], bodyLines: [] })
    expect(t.diffSegments).toEqual(DEFAULT_BANNER_TEMPLATE.diffSegments)
    expect(t.bodyLines).toEqual(DEFAULT_BANNER_TEMPLATE.bodyLines)
  })

  it('keeps only allowlisted status keys and backfills missing ones', () => {
    const t = sanitizeBannerTemplate({
      ...clone(),
      statusEmoji: { success: '🚀', bogus: '💀' } as Record<string, string>
    })
    expect(t.statusEmoji.success).toBe('🚀')
    expect(t.statusEmoji).not.toHaveProperty('bogus')
    // A key the user did not override must still be present — the device does a
    // dictionary lookup and renders "" for a miss.
    expect(t.statusEmoji.quota).toBe(DEFAULT_BANNER_TEMPLATE.statusEmoji.quota)
  })
})

describe('extractTokens', () => {
  it('finds tokens in order', () => {
    expect(extractTokens('{a} x {b}')).toEqual(['a', 'b'])
  })

  it('ignores an unclosed brace', () => {
    expect(extractTokens('{a} {b')).toEqual(['a'])
  })

  it('returns nothing for a plain string', () => {
    expect(extractTokens('no tokens here')).toEqual([])
  })
})

describe('validateBannerTemplate', () => {
  it('accepts the default', () => {
    expect(validateBannerTemplate(DEFAULT_BANNER_TEMPLATE)).toEqual([])
  })

  it('rejects an unknown token in the title', () => {
    const problems = validateBannerTemplate({ ...clone(), titleFormat: '{agent} {nope}' })
    expect(problems).toHaveLength(1)
    expect(problems[0].field).toBe('titleFormat')
    expect(problems[0].message).toContain('{nope}')
  })

  it('reports the offending body line by index', () => {
    const problems = validateBannerTemplate({
      ...clone(),
      bodyLines: ['{summary}', '{fils}']
    })
    expect(problems).toHaveLength(1)
    expect(problems[0].field).toBe('bodyLines.1')
  })

  it('rejects body tokens used inside a diff segment', () => {
    // {agent} is valid in a body line but meaningless in a segment — the segment
    // substitution dictionary only carries {value} and {s}.
    const problems = validateBannerTemplate({
      ...clone(),
      diffSegments: [{ field: 'files', format: '{agent} {value}' }]
    })
    expect(problems).toHaveLength(1)
    expect(problems[0].field).toBe('diffSegments.0')
  })

  it('accepts {value} and {s} inside a diff segment', () => {
    expect(
      validateBannerTemplate({
        ...clone(),
        diffSegments: [{ field: 'files', format: '{value} file{s}' }]
      })
    ).toEqual([])
  })

  it('rejects an empty title', () => {
    const problems = validateBannerTemplate({ ...clone(), titleFormat: '   ' })
    expect(problems.some((p) => p.field === 'titleFormat')).toBe(true)
  })
})

describe('shared fixture corpus (TS side)', () => {
  it.each(fixtures.cases.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    const template = testCase.template
      ? sanitizeBannerTemplate(testCase.template)
      : DEFAULT_BANNER_TEMPLATE
    const input: BannerRenderInput = {
      ...testCase.input,
      status: testCase.input.status as BannerStatus
    }
    const rendered = renderBannerPreview(input, template)
    expect(rendered.title).toBe(testCase.expectedTitle)
    expect(rendered.body).toBe(testCase.expectedBody)
  })
})

describe('activity appearance', () => {
  it('defaults an absent enabled flag to ON, not off', () => {
    // Absence must mean "the Mac did not say", never "the user turned it off" —
    // a Mac too old to send the block would otherwise silently kill the
    // feature on every phone paired to it.
    expect(sanitizeActivityAppearance({}).enabled).toBe(true)
    expect(sanitizeActivityAppearance({ enabled: false }).enabled).toBe(false)
  })

  it('falls back on an archetype this build does not know', () => {
    expect(sanitizeActivityAppearance({ archetype: 'holographic' }).archetype).toBe(
      DEFAULT_ACTIVITY_ARCHETYPE
    )
    expect(sanitizeActivityAppearance({ archetype: 'ensemble' }).archetype).toBe('ensemble')
  })

  it('normalises colours and refuses junk rather than passing it through', () => {
    const appearance = sanitizeActivityAppearance({
      successColor: '0f0',
      failureColor: 'rgb(255,0,0)'
    })
    expect(appearance.successColor).toBe('#00FF00')
    // Junk falls back to the stock diff red — the widget cannot parse CSS
    // functions, and an unparsed string there would render as black.
    expect(appearance.failureColor).toBe('#EC3D35')
  })

  it('every archetype id has a picker entry, and vice versa', () => {
    // The picker is generated from ACTIVITY_ARCHETYPE_PRESETS while the wire
    // contract is ACTIVITY_ARCHETYPES; a new layout added to one and not the
    // other is either an unpickable feature or a dead radio button.
    expect(ACTIVITY_ARCHETYPE_PRESETS.map((p) => p.id).sort()).toEqual(
      [...ACTIVITY_ARCHETYPES].sort()
    )
  })
})
