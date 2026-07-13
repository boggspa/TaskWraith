import { describe, expect, it } from 'vitest'
import { extractClaudeAccountPlanType, extractKimiPlanType } from './ProviderPlanMetadata'

describe('provider plan metadata extraction', () => {
  it('reads Kimi membership level before the purchase subtype fallback', () => {
    expect(
      extractKimiPlanType({
        user: { membership: { level: 'LEVEL_BASIC' } },
        subType: 'TYPE_PURCHASE'
      })
    ).toBe('LEVEL_BASIC')
  })

  it('falls back across observed Kimi subtype shapes without inventing a tier', () => {
    expect(extractKimiPlanType({ membership: { level: 'LEVEL_BALANCE' } })).toBe(
      'LEVEL_BALANCE'
    )
    expect(extractKimiPlanType({ user: { membership: { sub_type: 'TYPE_TEAM' } } })).toBe(
      'TYPE_TEAM'
    )
    expect(extractKimiPlanType({ subType: 'TYPE_PURCHASE' })).toBe('TYPE_PURCHASE')
    expect(extractKimiPlanType({ usage: { limit: 100 } })).toBeUndefined()
  })

  it('reads Claude exact organization tier before coarser account fields', () => {
    expect(
      extractClaudeAccountPlanType({
        oauthAccount: {
          organizationRateLimitTier: 'default_claude_max_20x',
          seatTier: 'max'
        }
      })
    ).toBe('default_claude_max_20x')
  })

  it('does not infer a Claude plan when account metadata has no tier', () => {
    expect(extractClaudeAccountPlanType({ oauthAccount: { organizationName: 'Example' } })).toBe(
      undefined
    )
  })
})
