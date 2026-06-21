import { describe, expect, it } from 'vitest'
import {
  OLLAMA_RUN_PROFILE_OPTIONS,
  OLLAMA_TOOL_CONTROL_TIERS
} from './ollamaTierTables'

describe('ollamaTierTables', () => {
  it('lists the four tool-control tiers in cumulative ladder order', () => {
    expect(OLLAMA_TOOL_CONTROL_TIERS.map((t) => t.value)).toEqual([
      'read_only',
      'approved_edits',
      'approved_shell',
      'provider_parity'
    ])
  })

  it('gives every tier a Tier-N label and a non-empty helper', () => {
    OLLAMA_TOOL_CONTROL_TIERS.forEach((tier, index) => {
      expect(tier.label).toContain(`Tier ${index + 1}`)
      expect(tier.helper.length).toBeGreaterThan(0)
    })
  })

  it('maps every run profile onto a known tier (child pane is a dependent view)', () => {
    const tierValues = new Set(OLLAMA_TOOL_CONTROL_TIERS.map((t) => t.value))
    for (const profile of OLLAMA_RUN_PROFILE_OPTIONS) {
      expect(tierValues.has(profile.tier)).toBe(true)
      expect(profile.label.length).toBeGreaterThan(0)
      expect(profile.helper.length).toBeGreaterThan(0)
    }
  })

  it('covers each tier with exactly one run profile today (1:1 mapping)', () => {
    const byTier = new Map<string, number>()
    for (const profile of OLLAMA_RUN_PROFILE_OPTIONS) {
      byTier.set(profile.tier, (byTier.get(profile.tier) || 0) + 1)
    }
    for (const tier of OLLAMA_TOOL_CONTROL_TIERS) {
      expect(byTier.get(tier.value)).toBe(1)
    }
  })
})
