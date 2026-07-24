import { describe, expect, it } from 'vitest'
import { providerPlanName, providerPlanNameFromSnapshot } from './providerPlanName'

describe('providerPlanName', () => {
  it.each([
    ['codex', 'pro', 'Pro'],
    ['claude', 'default_claude_max_20x', 'Max x20'],
    ['claude', 'max_5x', 'Max x5'],
    ['claude', 'max', 'Max'],
    ['kimi', 'LEVEL_BASIC', 'Moderato'],
    ['kimi', 'LEVEL_BALANCE_ACCOUNT', 'Moderato'],
    ['kimi', 'Beginner', 'Moderato'],
    ['kimi', 'LEVEL_PRO', 'Allegretto'],
    ['kimi', 'Intermediate', 'Allegretto'],
    ['kimi', 'Advanced', 'Allegro'],
    ['kimi', 'Maximum', 'Vivace'],
    ['cursor', 'pro_plus', 'Pro +'],
    ['grok', 'Free credits with SuperGrok', 'SuperGrok'],
    ['grok', 'SuperGrok Heavy', 'SuperGrok Heavy']
  ] as const)('maps %s %s to %s', (provider, raw, expected) => {
    expect(providerPlanName(provider, raw)).toBe(expected)
  })

  it('uses the first plan-bearing snapshot field and omits missing metadata', () => {
    expect(providerPlanNameFromSnapshot('codex', { planType: 'pro' })).toBe('Pro')
    expect(providerPlanNameFromSnapshot('kimi', { windows: [] })).toBeUndefined()
  })
})
