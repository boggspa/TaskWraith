import { describe, expect, it } from 'vitest'
import {
  CODEX_ASTRA_MODEL_ID,
  CODEX_RESERVE_MODEL_ID,
  codexReserveGrantActive,
  filterCodexDiscoverableModelRows,
  isCodexAstraModelId,
  isCodexDaybreakModelId,
  isCodexReserveLimitName,
  isCodexReserveModelId
} from './codexReserveModel'

// Shapes below are transcribed from a live `account/rateLimits/read` and
// `model/list { includeHidden: true }` against Codex CLI 0.153.0 on 2026-09-03.
const LIVE_ROWS = [
  { id: 'gpt-reserve', hidden: true },
  { id: 'gpt-5.6-sol', hidden: false },
  { id: 'gpt-5.6-terra', hidden: false },
  { id: 'gpt-5.6-luna', hidden: false },
  { id: 'codex-auto-review', hidden: true }
]

// The observed no-grant state: primary exhausted, no reserve bucket at all,
// and the generic pro banner rather than the reserve banner.
const NO_GRANT_PAYLOAD = {
  rateLimitsByLimitId: {
    codex: { limitId: 'codex', primary: { usedPercent: 100 }, secondary: null },
    codex_bengalfox: {
      limitId: 'codex_bengalfox',
      limitName: 'GPT-5.3-Codex-Spark',
      primary: { usedPercent: 0 },
      secondary: { usedPercent: 100 }
    }
  },
  rateLimitUpsell: { banner_type: 'pro_rate_limit_reached' }
}

describe('Codex reserve model identity', () => {
  it('recognises only the reserve slug', () => {
    expect(CODEX_RESERVE_MODEL_ID).toBe('gpt-reserve')
    expect(isCodexReserveModelId('gpt-reserve')).toBe(true)
    expect(isCodexReserveModelId('  GPT-Reserve  ')).toBe(true)
    expect(isCodexReserveModelId('gpt-5.6-luna')).toBe(false)
    expect(isCodexReserveModelId('codex-auto-review')).toBe(false)
    expect(isCodexReserveModelId('')).toBe(false)
    expect(isCodexReserveModelId(null)).toBe(false)
  })
})

describe('Codex reserve grant detection', () => {
  it('is false for unusable payloads rather than defaulting open', () => {
    expect(codexReserveGrantActive(null)).toBe(false)
    expect(codexReserveGrantActive(undefined)).toBe(false)
    expect(codexReserveGrantActive('nope')).toBe(false)
    expect(codexReserveGrantActive({})).toBe(false)
  })

  it('is false on the observed no-grant account state', () => {
    expect(codexReserveGrantActive(NO_GRANT_PAYLOAD)).toBe(false)
  })

  it('is true when a reserve bucket carries headroom', () => {
    expect(
      codexReserveGrantActive({
        rateLimitsByLimitId: {
          codex: { limitId: 'codex', primary: { usedPercent: 100 } },
          'gpt-reserve': { limitId: 'gpt-reserve', primary: { usedPercent: 0 } }
        }
      })
    ).toBe(true)
  })

  it('is false when the reserve bucket exists but is spent', () => {
    expect(
      codexReserveGrantActive({
        rateLimitsByLimitId: {
          'gpt-reserve': { limitId: 'gpt-reserve', primary: { usedPercent: 100 } }
        }
      })
    ).toBe(false)
  })

  it('reads the additional_rate_limits shape the ChatGPT surface uses', () => {
    expect(
      codexReserveGrantActive({
        additional_rate_limits: [
          { limit_name: 'gpt-reserve', rate_limit: { primary: { usedPercent: 12 } } }
        ]
      })
    ).toBe(true)
    expect(
      codexReserveGrantActive({
        additional_rate_limits: [
          { limit_name: 'spark', rate_limit: { primary: { usedPercent: 0 } } }
        ]
      })
    ).toBe(false)
  })

  it('accepts the luna_reserve banner as an explicit grant signal', () => {
    expect(codexReserveGrantActive({ rateLimitUpsell: { banner_type: 'luna_reserve' } })).toBe(true)
  })
})

describe('Codex discoverable model filtering', () => {
  it('drops the reserve row while no grant is live', () => {
    const kept = filterCodexDiscoverableModelRows(LIVE_ROWS, { reserveGrantActive: false })
    expect(kept.map((row) => row.id)).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])
  })

  it('reveals the reserve row the moment a grant lands', () => {
    const kept = filterCodexDiscoverableModelRows(LIVE_ROWS, { reserveGrantActive: true })
    expect(kept.map((row) => row.id)).toEqual([
      'gpt-reserve',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna'
    ])
  })

  it('never reveals other discovery-hidden rows, grant or no grant', () => {
    for (const reserveGrantActive of [true, false]) {
      const kept = filterCodexDiscoverableModelRows(LIVE_ROWS, { reserveGrantActive })
      expect(kept.map((row) => row.id)).not.toContain('codex-auto-review')
      expect(kept.length).toBeGreaterThan(0)
    }
  })

  it('ignores malformed rows without dropping good ones', () => {
    const kept = filterCodexDiscoverableModelRows(
      [null, { id: '' }, { id: 'gpt-5.5', hidden: false }, { hidden: false }] as any,
      { reserveGrantActive: false }
    )
    expect(kept.map((row) => row.id)).toEqual(['gpt-5.5'])
  })
})

describe('Codex reserve limit naming', () => {
  it('matches both the raw slug and the branded Luna Reserve name', () => {
    expect(isCodexReserveLimitName('gpt-reserve')).toBe(true)
    expect(isCodexReserveLimitName('Luna Reserve')).toBe(true)
    expect(isCodexReserveLimitName('luna_reserve')).toBe(true)
    expect(isCodexReserveLimitName('codex_bengalfox')).toBe(false)
    expect(isCodexReserveLimitName('GPT-5.3-Codex-Spark')).toBe(false)
    expect(isCodexReserveLimitName(undefined)).toBe(false)
  })
})

describe('Codex Daybreak cyber models', () => {
  // Released models behind a conditional account flag. Codex CLI 0.153.0 ships
  // both slugs; an unentitled account is served neither, so presence is the
  // entitlement check.
  const DAYBREAK_ROWS = [
    { id: 'gpt-daybreak-blue-latest', hidden: true },
    { id: 'gpt-daybreak-red-latest', hidden: true },
    { id: 'gpt-5.6-sol', hidden: false },
    { id: 'codex-auto-review', hidden: true }
  ]

  it('identifies both released slugs and pinned siblings', () => {
    expect(isCodexDaybreakModelId('gpt-daybreak-blue-latest')).toBe(true)
    expect(isCodexDaybreakModelId('gpt-daybreak-red-latest')).toBe(true)
    expect(isCodexDaybreakModelId('  GPT-Daybreak-Red-Latest  ')).toBe(true)
    expect(isCodexDaybreakModelId('gpt-daybreak-blue-2026-09-03')).toBe(true)
    expect(isCodexDaybreakModelId('gpt-5.6-sol')).toBe(false)
    expect(isCodexDaybreakModelId('gpt-reserve')).toBe(false)
    expect(isCodexDaybreakModelId('daybreak')).toBe(false)
    expect(isCodexDaybreakModelId(null)).toBe(false)
  })

  it('offers Daybreak rows whenever the account is served them', () => {
    for (const reserveGrantActive of [true, false]) {
      const kept = filterCodexDiscoverableModelRows(DAYBREAK_ROWS, { reserveGrantActive })
      expect(kept.map((row) => row.id)).toEqual([
        'gpt-daybreak-blue-latest',
        'gpt-daybreak-red-latest',
        'gpt-5.6-sol'
      ])
    }
  })

  it('still drops the internal review model alongside them', () => {
    const kept = filterCodexDiscoverableModelRows(DAYBREAK_ROWS, { reserveGrantActive: true })
    expect(kept.map((row) => row.id)).not.toContain('codex-auto-review')
    expect(kept.length).toBe(3)
  })

  it('offers nothing extra to an account the server did not serve them to', () => {
    const unentitled = [
      { id: 'gpt-5.6-sol', hidden: false },
      { id: 'codex-auto-review', hidden: true }
    ]
    expect(
      filterCodexDiscoverableModelRows(unentitled, { reserveGrantActive: false }).map((r) => r.id)
    ).toEqual(['gpt-5.6-sol'])
  })
})

describe('GPT-6 Astra reveal', () => {
  // Codex CLI 0.153.1 ships Astra with `visibility: "hide"`, which the
  // app-server surfaces as `hidden: true`. TaskWraith overrides that by
  // product decision, so the row must survive the filter.
  const ASTRA_ROWS = [
    { id: 'gpt-6-astra', hidden: true },
    { id: 'gpt-5.6-sol', hidden: false },
    { id: 'codex-auto-review', hidden: true }
  ]

  it('matches the slug and its Bedrock region-prefixed forms', () => {
    expect(CODEX_ASTRA_MODEL_ID).toBe('gpt-6-astra')
    expect(isCodexAstraModelId('gpt-6-astra')).toBe(true)
    expect(isCodexAstraModelId('  GPT-6-Astra  ')).toBe(true)
    expect(isCodexAstraModelId('openai.gpt-6-astra')).toBe(true)
    expect(isCodexAstraModelId('global.openai.gpt-6-astra')).toBe(true)
    expect(isCodexAstraModelId('us.openai.gpt-6-astra')).toBe(true)
  })

  it('does not sweep in a distinct sibling slug', () => {
    // A suffixed sibling is a DIFFERENT model, not a region form of this one.
    expect(isCodexAstraModelId('gpt-6-astra-aeon')).toBe(false)
    expect(isCodexAstraModelId('gpt-6-astra-pro')).toBe(false)
    expect(isCodexAstraModelId('notgpt-6-astra')).toBe(false)
    expect(isCodexAstraModelId('gpt-5.6-sol')).toBe(false)
    expect(isCodexAstraModelId(null)).toBe(false)
  })

  it('offers Astra despite upstream hiding it, with or without a reserve grant', () => {
    for (const reserveGrantActive of [true, false]) {
      const kept = filterCodexDiscoverableModelRows(ASTRA_ROWS, { reserveGrantActive })
      expect(kept.map((row) => row.id)).toEqual(['gpt-6-astra', 'gpt-5.6-sol'])
    }
  })

  it('still drops the internal review model alongside it', () => {
    const kept = filterCodexDiscoverableModelRows(ASTRA_ROWS, { reserveGrantActive: true })
    expect(kept.map((row) => row.id)).not.toContain('codex-auto-review')
    expect(kept.length).toBe(2)
  })
})
