import { describe, expect, it } from 'vitest'
import {
  CODEX_RESERVE_MODEL_ID,
  codexReserveGrantActive,
  filterCodexDiscoverableModelRows,
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
