import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AGENT_THEME_TOKENS,
  AGENT_THEME_TOKEN_NAMES,
  isAgentWritableThemeToken,
  normalizeAgentThemeTokenOverrides,
  validateAgentThemeToken
} from './agentThemeTokens'

const THEME_CSS = join(process.cwd(), 'src/renderer/src/styles/theme.css')

describe('the writable allowlist itself', () => {
  it('only names tokens that actually exist in theme.css', () => {
    // A token nobody declares would apply silently and do nothing, which reads
    // to the model as a successful restyle.
    const css = readFileSync(THEME_CSS, 'utf8')
    const missing = AGENT_THEME_TOKEN_NAMES.filter((t) => !css.includes(`--${t}:`))
    expect(missing).toEqual([])
  })

  it('has no duplicate entries', () => {
    expect(new Set(AGENT_THEME_TOKEN_NAMES).size).toBe(AGENT_THEME_TOKEN_NAMES.length)
  })

  it('gives every numeric token real bounds', () => {
    for (const spec of AGENT_THEME_TOKENS) {
      if (spec.kind === 'color') continue
      expect(spec.min, `${spec.token} min`).toBeTypeOf('number')
      expect(spec.max, `${spec.token} max`).toBeTypeOf('number')
      expect(spec.max as number).toBeGreaterThan(spec.min as number)
    }
  })

  // The security shape of the whole feature, asserted rather than assumed.
  it('exposes no provider colour, focus ring, or approval-chrome geometry', () => {
    for (const token of AGENT_THEME_TOKEN_NAMES) {
      // Provider colours double as run PROVENANCE — recolouring Claude to look
      // like Codex misattributes whose output the human is reading.
      expect(token.startsWith('provider-'), `${token} is provider identity`).toBe(false)
      // Focus visibility is an accessibility floor, not decoration.
      expect(token).not.toMatch(/^(focus-ring|accent)$/)
      // Geometry the approval sheet and composer are laid out against.
      expect(token).not.toMatch(/^(header-height|composer-min-height)$/)
    }
  })

  it('refuses to widen into free-form CSS function syntax', () => {
    // shadows/gradients/filters take arbitrary CSS function text; accepting them
    // would reintroduce the parser surface this module exists to avoid.
    for (const token of AGENT_THEME_TOKEN_NAMES) {
      expect(token).not.toMatch(/shadow|gradient|filter|glass|chroma/)
    }
  })
})

describe('validateAgentThemeToken — colours', () => {
  it('accepts shorthand and canonicalises case', () => {
    expect(validateAgentThemeToken('scrollbar-thumb', '#abc')).toEqual({
      ok: true,
      token: 'scrollbar-thumb',
      cssValue: '#AABBCC'
    })
    expect(validateAgentThemeToken('scrollbar-thumb', '4d6bfe')).toMatchObject({
      ok: true,
      cssValue: '#4D6BFE'
    })
  })

  it('tolerates a leading -- on the token name', () => {
    expect(validateAgentThemeToken('--scrollbar-track', '#000')).toMatchObject({ ok: true })
  })

  it.each([
    ['rgb(0,0,0)', 'a CSS function'],
    ['red', 'a named colour'],
    ['var(--accent)', 'an indirection'],
    ['url(x)', 'a fetch'],
    ['#12345', 'a wrong-length hex'],
    ['#ggg', 'non-hex digits']
  ])('rejects %s (%s)', (value) => {
    expect(validateAgentThemeToken('scrollbar-thumb', value)).toMatchObject({
      ok: false,
      reason: 'malformed-value'
    })
  })
})

describe('validateAgentThemeToken — numbers', () => {
  it('accepts a bare number or an explicit px, since a model produces both', () => {
    expect(validateAgentThemeToken('radius-md', 12)).toMatchObject({ cssValue: '12px' })
    expect(validateAgentThemeToken('radius-md', '12')).toMatchObject({ cssValue: '12px' })
    expect(validateAgentThemeToken('radius-md', '12px')).toMatchObject({ cssValue: '12px' })
    expect(validateAgentThemeToken('radius-md', ' 12PX ')).toMatchObject({ cssValue: '12px' })
  })

  it.each(['calc(1px + 2px)', '1em', '50%', 'var(--space-md)', '', 'twelve'])(
    'rejects %o rather than passing CSS text through',
    (value) => {
      expect(validateAgentThemeToken('radius-md', value)).toMatchObject({
        ok: false,
        reason: 'malformed-value'
      })
    }
  )

  it('reports out-of-range instead of silently clamping', () => {
    // Silent clamping would tell a model its write landed as asked. Bounds are
    // intent, so disagreement is reported.
    expect(validateAgentThemeToken('radius-md', 9999)).toMatchObject({
      ok: false,
      reason: 'out-of-range'
    })
    expect(validateAgentThemeToken('radius-md', -1)).toMatchObject({ reason: 'out-of-range' })
  })

  it('will not let an agent collapse the sidebar out of reach', () => {
    // The sidebar is how a human reaches Settings and approval history.
    expect(validateAgentThemeToken('sidebar-width', 0)).toMatchObject({
      ok: false,
      reason: 'out-of-range'
    })
    expect(validateAgentThemeToken('sidebar-width', 260)).toMatchObject({ ok: true })
  })

  it('rejects unknown tokens outright', () => {
    expect(validateAgentThemeToken('provider-claude-color', '#FFFFFF')).toMatchObject({
      ok: false,
      reason: 'unknown-token'
    })
    expect(validateAgentThemeToken('totally-made-up', 1)).toMatchObject({ reason: 'unknown-token' })
    expect(isAgentWritableThemeToken('provider-claude-color')).toBe(false)
  })

  it('rejects non-scalar values', () => {
    expect(validateAgentThemeToken('radius-md', {})).toMatchObject({ reason: 'not-a-string' })
    expect(validateAgentThemeToken('scrollbar-thumb', 12)).toMatchObject({ reason: 'not-a-string' })
  })
})

describe('normalizeAgentThemeTokenOverrides', () => {
  it('keeps valid entries and drops everything else', () => {
    expect(
      normalizeAgentThemeTokenOverrides({
        'radius-md': 14,
        'scrollbar-thumb': '#abc',
        'provider-claude-color': '#000000',
        'radius-lg': 'calc(1px)',
        'sidebar-width': 5
      })
    ).toEqual({ 'radius-md': '14px', 'scrollbar-thumb': '#AABBCC' })
  })

  it('re-validates on LOAD so an older build cannot smuggle a value through', () => {
    // Same reasoning as re-clamping an unsigned run posture: a map persisted
    // before a token was removed, or before a bound tightened, must not bypass
    // today's rules just because it is already on disk.
    expect(normalizeAgentThemeTokenOverrides({ 'sidebar-width': 10 })).toEqual({})
  })

  it.each([null, undefined, 'string', 42, []])('returns {} for %o', (input) => {
    expect(normalizeAgentThemeTokenOverrides(input)).toEqual({})
  })
})
