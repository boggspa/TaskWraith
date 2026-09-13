import { describe, expect, it } from 'vitest'
import type { UsageWindowAggregate } from './usageAggregateTypes'
import { quotaSegmentCount } from './quotaSegments'

/*
 * Acceptance tests for the dash-marker mapper (`quotaSegmentCount`).
 *
 * Authored from the USER'S CANONICAL DASH SPEC and the pinned pass-1 slice
 * contract, and asserted against the REAL exported function above.
 *
 * DO NOT re-introduce a local re-implementation of the contract in this file.
 * The first revision defined an inline `defineContractBasedSegmentCount()`
 * mirror and pointed all 51 assertions at it; the suite never imported
 * `./quotaSegments` at all, so it passed no matter what the module did and
 * deleting the module outright would not have redded a single test. Every
 * assertion here must flow through the real export.
 *
 * User's canonical dash spec (acceptance target):
 * - Codex: 5H=5, Weekly=7, Spark 5H=5, Spark Weekly=7, Luna Reserve=7
 * - Claude: Session=5, Weekly=7, Fable=7
 * - Kimi: Session=5, Weekly=7, Monthly=4
 * - AntiGravity: Gemini Session=5, Weekly=7, Claude/GPT Session=5, Weekly=7
 * - Mistral: API Usage=4, Vibe Code=4
 * - Cursor: Plan=4, Auto=4, API=4
 * - Grok: Weekly=7
 * - Ollama: Session=5, Weekly=7
 * - Devin: Daily=6 (4-hour divisions), Weekly=7
 * - MiMo: Monthly=4
 * - Qwen: Session=5 (mapped but DISABLED at the call sites), Weekly=7
 * - Meta: Weekly=7, Credit Used=4, "Current usage"=null (period unknown)
 * - DeepSeek / Cerebras / OpenRouter: Credit Used=4
 */

type SegmentWindow = Pick<
  UsageWindowAggregate,
  'id' | 'label' | 'windowKind' | 'limitWindowSeconds' | 'trackingOnly'
>

/**
 * The default `id`/`label` here are deliberately REGEX-INERT: they match none
 * of the stage-2 fallback patterns. That is what gives the duration-band cases
 * their discriminating power — delete a band from the module and the case
 * falls through to a regex that cannot rescue it, so the test reds instead of
 * silently passing by another route. `fixture sanity` below pins that property.
 */
function makeTestWindow(overrides: Partial<SegmentWindow> = {}): SegmentWindow {
  return {
    id: 'test-window',
    label: 'Test',
    ...overrides
  }
}

describe('quotaSegmentCount — fixture sanity', () => {
  it('the default fixture matches no fallback regex, so duration bands are discriminating', () => {
    expect(quotaSegmentCount('codex', makeTestWindow())).toBeNull()
  })
})

describe('quotaSegmentCount — resolution order 0: trackingOnly', () => {
  it('returns null for trackingOnly=true when limitWindowSeconds is absent', () => {
    expect(quotaSegmentCount('any', makeTestWindow({ trackingOnly: true }))).toBeNull()
  })

  it('returns null for trackingOnly=true when limitWindowSeconds is explicitly null', () => {
    // `limitWindowSeconds` is typed `number | undefined`, but real producers
    // (e.g. GrokUsageSnapshot) carry `number | null`, so the module guards with
    // `== null`. Cast to exercise that runtime shape deliberately.
    const window = {
      id: 'test-window',
      label: 'Test',
      trackingOnly: true,
      limitWindowSeconds: null
    } as unknown as SegmentWindow
    expect(quotaSegmentCount('any', window)).toBeNull()
  })

  it('returns null for trackingOnly=true even when the label would match a regex', () => {
    expect(
      quotaSegmentCount('codex', makeTestWindow({ trackingOnly: true, label: 'Weekly' }))
    ).toBeNull()
  })

  it('still segments a trackingOnly window that carries a known real duration', () => {
    // CONTRACT RULING: trackingOnly only wins when the duration is UNKNOWN.
    // A tracking-only window with a real 7-day period still shows its
    // divisions — the bar is informational, but the divisions are true.
    expect(
      quotaSegmentCount('codex', makeTestWindow({ trackingOnly: true, limitWindowSeconds: 604800 }))
    ).toBe(7)
  })
})

describe('quotaSegmentCount — resolution order 1: explicit limitWindowSeconds bands', () => {
  it('returns 5 for a 5H duration (18000s)', () => {
    expect(quotaSegmentCount('codex', makeTestWindow({ limitWindowSeconds: 18000 }))).toBe(5)
  })

  it('returns 7 for a 7D duration (604800s)', () => {
    expect(quotaSegmentCount('claude', makeTestWindow({ limitWindowSeconds: 604800 }))).toBe(7)
  })

  it('returns 4 for a monthly duration (2592000s)', () => {
    expect(quotaSegmentCount('mistral', makeTestWindow({ limitWindowSeconds: 2592000 }))).toBe(4)
  })

  it('returns 6 for Devin at a 24H duration (86400s)', () => {
    expect(quotaSegmentCount('devin', makeTestWindow({ limitWindowSeconds: 86400 }))).toBe(6)
  })

  it('returns null for a non-Devin provider at a 24H duration', () => {
    expect(quotaSegmentCount('claude', makeTestWindow({ limitWindowSeconds: 86400 }))).toBeNull()
  })

  it('short-circuits a non-Devin 24H duration to null instead of falling through to the regex', () => {
    // CONTRACT RULING: the 24H band resolves to null for non-Devin providers.
    // It does NOT fall through — a regex-matching label must not rescue it.
    // Without the short-circuit this window would resolve to 7 via /week/.
    expect(
      quotaSegmentCount(
        'claude',
        makeTestWindow({ id: 'claude-weekly', label: 'Weekly', limitWindowSeconds: 86400 })
      )
    ).toBeNull()
  })

  it('lets the Devin 24H band win over a regex-matching label', () => {
    expect(
      quotaSegmentCount(
        'devin',
        makeTestWindow({ id: 'devin-weekly', label: 'Weekly', limitWindowSeconds: 86400 })
      )
    ).toBe(6)
  })

  it('matches Devin case-insensitively for the 24H band', () => {
    expect(quotaSegmentCount('Devin', makeTestWindow({ limitWindowSeconds: 86400 }))).toBe(6)
  })
})

describe('quotaSegmentCount — duration band boundaries', () => {
  it('accepts the lower bound of the 5H band (14400s)', () => {
    expect(quotaSegmentCount('codex', makeTestWindow({ limitWindowSeconds: 14400 }))).toBe(5)
  })

  it('accepts the upper bound of the 5H band (21600s)', () => {
    expect(quotaSegmentCount('codex', makeTestWindow({ limitWindowSeconds: 21600 }))).toBe(5)
  })

  it('rejects just below the 5H band (14399s)', () => {
    expect(quotaSegmentCount('codex', makeTestWindow({ limitWindowSeconds: 14399 }))).toBeNull()
  })

  it('rejects the gap between the 5H and 24H bands (21601s)', () => {
    expect(quotaSegmentCount('codex', makeTestWindow({ limitWindowSeconds: 21601 }))).toBeNull()
  })

  it('accepts the bounds of the Devin 24H band (82800s and 93600s)', () => {
    expect(quotaSegmentCount('devin', makeTestWindow({ limitWindowSeconds: 82800 }))).toBe(6)
    expect(quotaSegmentCount('devin', makeTestWindow({ limitWindowSeconds: 93600 }))).toBe(6)
  })

  it('accepts the bounds of the 7D band (561600s and 648000s)', () => {
    expect(quotaSegmentCount('claude', makeTestWindow({ limitWindowSeconds: 561600 }))).toBe(7)
    expect(quotaSegmentCount('claude', makeTestWindow({ limitWindowSeconds: 648000 }))).toBe(7)
  })

  it('accepts the lower bound of the monthly band (2073600s)', () => {
    expect(quotaSegmentCount('mistral', makeTestWindow({ limitWindowSeconds: 2073600 }))).toBe(4)
  })

  it('falls through to the regex for a non-finite duration', () => {
    expect(
      quotaSegmentCount('grok', makeTestWindow({ label: 'Weekly', limitWindowSeconds: NaN }))
    ).toBe(7)
  })

  it('falls through to the regex for a zero duration', () => {
    expect(
      quotaSegmentCount('grok', makeTestWindow({ label: 'Weekly', limitWindowSeconds: 0 }))
    ).toBe(7)
  })
})

describe('quotaSegmentCount — resolution order 2: label/id/windowKind regex', () => {
  describe('5 dashes — 5H / Session windows', () => {
    it('Codex 5H Session returns 5', () => {
      expect(
        quotaSegmentCount('codex', makeTestWindow({ id: 'codex-5h', label: '5H Session' }))
      ).toBe(5)
    })

    it('Codex Spark 5H returns 5', () => {
      expect(
        quotaSegmentCount('codex', makeTestWindow({ id: 'codex-spark-5h', label: 'Spark 5h' }))
      ).toBe(5)
    })

    it('Claude Session returns 5', () => {
      expect(
        quotaSegmentCount('claude', makeTestWindow({ id: 'claude-5h', label: 'Session' }))
      ).toBe(5)
    })

    it('Kimi Session returns 5', () => {
      expect(
        quotaSegmentCount('kimi', makeTestWindow({ id: 'kimi-session', label: 'Session' }))
      ).toBe(5)
    })

    it('AntiGravity Gemini Session returns 5', () => {
      expect(
        quotaSegmentCount(
          'antigravity',
          makeTestWindow({ id: 'antigravity-gemini-session', label: 'Gemini Session' })
        )
      ).toBe(5)
    })

    it('AntiGravity Claude/GPT Session returns 5', () => {
      expect(
        quotaSegmentCount(
          'antigravity',
          makeTestWindow({ id: 'antigravity-claude-gpt-session', label: 'Claude/GPT Session' })
        )
      ).toBe(5)
    })

    it('Ollama Session returns 5', () => {
      expect(
        quotaSegmentCount(
          'ollama',
          makeTestWindow({ id: 'ollama-session-5h', label: 'Session usage' })
        )
      ).toBe(5)
    })

    it('Qwen Session returns 5 (mapped even though the row stays disabled)', () => {
      expect(
        quotaSegmentCount('qwen', makeTestWindow({ id: 'qwen-session', label: 'Session' }))
      ).toBe(5)
    })
  })

  describe('7 dashes — Weekly / 7D windows', () => {
    it('Codex Weekly returns 7', () => {
      expect(
        quotaSegmentCount('codex', makeTestWindow({ id: 'codex-weekly', label: 'Weekly' }))
      ).toBe(7)
    })

    it('Codex Spark Weekly returns 7', () => {
      expect(
        quotaSegmentCount(
          'codex',
          makeTestWindow({ id: 'codex-spark-weekly', label: 'Spark Weekly' })
        )
      ).toBe(7)
    })

    it('Codex Luna Reserve returns 7', () => {
      expect(
        quotaSegmentCount('codex', makeTestWindow({ id: 'codex-luna', label: 'Luna Reserve' }))
      ).toBe(7)
    })

    it('Claude Weekly returns 7', () => {
      expect(
        quotaSegmentCount('claude', makeTestWindow({ id: 'claude-weekly', label: 'Weekly' }))
      ).toBe(7)
    })

    it('Claude Fable returns 7', () => {
      expect(
        quotaSegmentCount('claude', makeTestWindow({ id: 'claude-weekly-fable', label: 'Fable' }))
      ).toBe(7)
    })

    it('Kimi Weekly returns 7', () => {
      expect(
        quotaSegmentCount('kimi', makeTestWindow({ id: 'kimi-weekly', label: 'Weekly' }))
      ).toBe(7)
    })

    it('AntiGravity Gemini Weekly returns 7', () => {
      expect(
        quotaSegmentCount(
          'antigravity',
          makeTestWindow({ id: 'antigravity-gemini-weekly', label: 'Gemini Weekly' })
        )
      ).toBe(7)
    })

    it('Grok Weekly returns 7', () => {
      expect(
        quotaSegmentCount('grok', makeTestWindow({ id: 'grok-credits', label: 'Weekly' }))
      ).toBe(7)
    })

    it('Ollama Weekly returns 7', () => {
      expect(
        quotaSegmentCount('ollama', makeTestWindow({ id: 'ollama-weekly', label: 'Weekly usage' }))
      ).toBe(7)
    })

    it('Devin Weekly returns 7', () => {
      expect(
        quotaSegmentCount('devin', makeTestWindow({ id: 'devin-weekly', label: '7-Day' }))
      ).toBe(7)
    })

    it('Qwen Weekly returns 7', () => {
      expect(
        quotaSegmentCount('qwen', makeTestWindow({ id: 'qwen-weekly', label: '7-Day Quota' }))
      ).toBe(7)
    })

    it('Meta Weekly returns 7', () => {
      expect(
        quotaSegmentCount('meta', makeTestWindow({ id: 'meta-weekly', label: 'Weekly limit' }))
      ).toBe(7)
    })
  })

  describe('4 dashes — Monthly / Credit / Plan windows', () => {
    it('Kimi Monthly returns 4', () => {
      expect(
        quotaSegmentCount('kimi', makeTestWindow({ id: 'kimi-web-monthly', label: 'Monthly' }))
      ).toBe(4)
    })

    it('Mistral API Usage returns 4', () => {
      expect(
        quotaSegmentCount('mistral', makeTestWindow({ id: 'mistral-api', label: 'API Usage' }))
      ).toBe(4)
    })

    it('Mistral Vibe Code Usage returns 4', () => {
      expect(
        quotaSegmentCount(
          'mistral',
          makeTestWindow({ id: 'mistral-vibe', label: 'Vibe Code Usage' })
        )
      ).toBe(4)
    })

    it('Cursor Plan Usage returns 4', () => {
      expect(
        quotaSegmentCount('cursor', makeTestWindow({ id: 'cursor-plan', label: 'Plan Usage' }))
      ).toBe(4)
    })

    it('Cursor Auto Usage returns 4', () => {
      expect(
        quotaSegmentCount('cursor', makeTestWindow({ id: 'cursor-auto', label: 'Auto Usage' }))
      ).toBe(4)
    })

    it('Cursor API Usage returns 4', () => {
      expect(
        quotaSegmentCount('cursor', makeTestWindow({ id: 'cursor-api', label: 'API Usage' }))
      ).toBe(4)
    })

    it('MiMo Plan Quota returns 4', () => {
      expect(
        quotaSegmentCount('mimo', makeTestWindow({ id: 'mimo-plan', label: 'Plan Quota' }))
      ).toBe(4)
    })

    it('Meta Credit Used returns 4', () => {
      expect(
        quotaSegmentCount('meta', makeTestWindow({ id: 'meta-credit', label: 'Credit used' }))
      ).toBe(4)
    })

    it('DeepSeek Credit Used returns 4', () => {
      expect(
        quotaSegmentCount(
          'deepseek',
          makeTestWindow({ id: 'deepseek-credit', label: 'Credit used' })
        )
      ).toBe(4)
    })

    it('Cerebras Credit Used returns 4', () => {
      expect(
        quotaSegmentCount(
          'cerebras',
          makeTestWindow({ id: 'cerebras-credit', label: 'Credit used' })
        )
      ).toBe(4)
    })

    it('OpenRouter Credit Used returns 4', () => {
      expect(
        quotaSegmentCount(
          'openrouter',
          makeTestWindow({ id: 'openrouter-credit', label: 'Credit used' })
        )
      ).toBe(4)
    })
  })

  describe('6 dashes — Devin Daily only', () => {
    it('Devin Daily returns 6', () => {
      expect(
        quotaSegmentCount('devin', makeTestWindow({ id: 'devin-daily', label: 'Daily' }))
      ).toBe(6)
    })

    it('a non-Devin Daily window returns null', () => {
      expect(
        quotaSegmentCount('cursor', makeTestWindow({ id: 'some-daily', label: 'Daily' }))
      ).toBeNull()
    })
  })

  describe('windowKind participates in the regex haystack', () => {
    it('matches session from windowKind', () => {
      expect(
        quotaSegmentCount('claude', makeTestWindow({ label: 'Usage', windowKind: 'session' }))
      ).toBe(5)
    })

    it('matches monthly from windowKind', () => {
      expect(
        quotaSegmentCount('cursor', makeTestWindow({ label: 'Usage', windowKind: 'monthly' }))
      ).toBe(4)
    })

    it('matches weekly from id when label and windowKind are empty', () => {
      expect(quotaSegmentCount('claude', makeTestWindow({ id: 'weekly-usage', label: '' }))).toBe(7)
    })
  })

  describe('case and formatting variations', () => {
    it('matches a "5h" label', () => {
      expect(quotaSegmentCount('ollama', makeTestWindow({ id: 'x', label: '5h' }))).toBe(5)
    })

    it('matches a "7-day" label', () => {
      expect(quotaSegmentCount('grok', makeTestWindow({ id: 'x', label: '7-day' }))).toBe(7)
    })

    it('matches an uppercase "WEEKLY" label', () => {
      expect(quotaSegmentCount('grok', makeTestWindow({ id: 'x', label: 'WEEKLY' }))).toBe(7)
    })
  })
})

describe('quotaSegmentCount — windows that must NOT be segmented', () => {
  it('Meta/Muse "Current usage" returns null (period unresolved, research pending)', () => {
    // Guards the highest-risk false positive in the set: the id contains
    // "subscription", which does NOT contain "session", so this row must not
    // pick up 5 hourly ticks it has no basis for.
    expect(
      quotaSegmentCount(
        'muse',
        makeTestWindow({ id: 'muse-subscription-current', label: 'Current usage' })
      )
    ).toBeNull()
  })

  it('a balance-shaped window returns null', () => {
    expect(
      quotaSegmentCount(
        'deepseek',
        makeTestWindow({
          id: 'deepseek-available-balance',
          label: 'Available balance',
          windowKind: 'balance'
        })
      )
    ).toBeNull()
  })

  it('returns null for a completely unrecognised window', () => {
    expect(
      quotaSegmentCount('unknown', makeTestWindow({ id: 'unknown', label: 'Unknown Meter' }))
    ).toBeNull()
  })

  it('returns null for empty id and label', () => {
    expect(quotaSegmentCount('any', makeTestWindow({ id: '', label: '' }))).toBeNull()
  })
})

describe('quotaSegmentCount — precedence: explicit duration beats the regex', () => {
  it('a "5H" label with a 7-day duration resolves to 7', () => {
    expect(
      quotaSegmentCount(
        'codex',
        makeTestWindow({ id: 'codex-5h', label: '5H', limitWindowSeconds: 604800 })
      )
    ).toBe(7)
  })

  it('a "Session" label with a monthly duration resolves to 4', () => {
    expect(
      quotaSegmentCount(
        'kimi',
        makeTestWindow({ id: 'kimi-session', label: 'Session', limitWindowSeconds: 2592000 })
      )
    ).toBe(4)
  })
})

describe('quotaSegmentCount — return domain', () => {
  it('only ever returns 4, 5, 6, 7 or null', () => {
    const cases: Array<[string, SegmentWindow]> = [
      ['codex', makeTestWindow({ id: 'codex-5h', label: '5H Session' })],
      ['codex', makeTestWindow({ id: 'codex-weekly', label: 'Weekly' })],
      ['kimi', makeTestWindow({ id: 'kimi-web-monthly', label: 'Monthly' })],
      ['devin', makeTestWindow({ id: 'devin-daily', label: 'Daily' })],
      ['muse', makeTestWindow({ id: 'muse-subscription-current', label: 'Current usage' })]
    ]
    // Non-vacuous by construction: the fixture list is non-empty and its
    // expected resolutions are pinned individually above.
    expect(cases).toHaveLength(5)
    for (const [provider, window] of cases) {
      const result = quotaSegmentCount(provider, window)
      expect(result === null || [4, 5, 6, 7].includes(result)).toBe(true)
    }
  })
})
