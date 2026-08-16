import { describe, it, expect } from 'vitest'
import { CURSOR_GROK_46_BASE_MODEL_ID, GROK_46_MODEL_ID } from '../../../shared/grok45Models'
import {
  fastModeCapableModelIds,
  fastModeEnabledFor,
  fastModeToggleAvailable,
  nextFastModeToggle,
  providerSupportsFastModeToggle
} from './fastModeToggle'

const FAST_CAPABLE = [
  { id: 'gpt-5.6-codex', additionalSpeedTiers: ['fast'] },
  { id: 'gpt-5.6-codex-mini' }
]

describe('fastModeToggle', () => {
  describe('providerSupportsFastModeToggle', () => {
    it('covers exactly the providers whose Fast switch is wired', () => {
      expect(providerSupportsFastModeToggle('codex')).toBe(true)
      expect(providerSupportsFastModeToggle('claude')).toBe(true)
      expect(providerSupportsFastModeToggle('kimi')).toBe(true)
      expect(providerSupportsFastModeToggle('cursor')).toBe(true)
    })

    it('excludes grok, whose Fast variants are model ids with no wired switch', () => {
      // fastModeCapableModelIds lists grok ids for the picker's glyphs, but the
      // picker builds no onToggle for grok. /fast must not appear there.
      expect(fastModeCapableModelIds('grok').has(GROK_46_MODEL_ID)).toBe(true)
      expect(providerSupportsFastModeToggle('grok')).toBe(false)
    })

    it('excludes providers with no Fast concept at all', () => {
      expect(providerSupportsFastModeToggle('ollama')).toBe(false)
      expect(providerSupportsFastModeToggle('pi')).toBe(false)
      expect(providerSupportsFastModeToggle('mistral')).toBe(false)
      expect(providerSupportsFastModeToggle('antigravity')).toBe(false)
    })
  })

  describe('fastModeToggleAvailable', () => {
    it('is true only when the SELECTED model declares the fast tier', () => {
      expect(
        fastModeToggleAvailable({ provider: 'codex', selectedModel: 'gpt-5.6-codex' }, FAST_CAPABLE)
      ).toBe(true)
      expect(
        fastModeToggleAvailable(
          { provider: 'codex', selectedModel: 'gpt-5.6-codex-mini' },
          FAST_CAPABLE
        )
      ).toBe(false)
    })

    it('is false for grok even on a fast-capable model id', () => {
      expect(fastModeToggleAvailable({ provider: 'grok', selectedModel: GROK_46_MODEL_ID })).toBe(
        false
      )
    })

    it('recognises cursor’s fixed catalogue without model options', () => {
      expect(fastModeToggleAvailable({ provider: 'cursor', selectedModel: 'composer-2.5' })).toBe(
        true
      )
      expect(
        fastModeToggleAvailable({
          provider: 'cursor',
          selectedModel: CURSOR_GROK_46_BASE_MODEL_ID
        })
      ).toBe(true)
      expect(fastModeToggleAvailable({ provider: 'cursor', selectedModel: 'gpt-5.6' })).toBe(false)
    })
  })

  describe('fastModeEnabledFor', () => {
    it('reads codex from the service tier string, not a flag', () => {
      expect(
        fastModeEnabledFor({ provider: 'codex', selectedModel: 'x', codexServiceTier: 'fast' })
      ).toBe(true)
      expect(
        fastModeEnabledFor({ provider: 'codex', selectedModel: 'x', codexServiceTier: '' })
      ).toBe(false)
      expect(
        fastModeEnabledFor({ provider: 'codex', selectedModel: 'x', codexServiceTier: 'priority' })
      ).toBe(false)
    })

    it('reads claude and kimi from their own flags', () => {
      expect(
        fastModeEnabledFor({ provider: 'claude', selectedModel: 'x', claudeFastMode: true })
      ).toBe(true)
      expect(fastModeEnabledFor({ provider: 'kimi', selectedModel: 'x', kimiFastMode: true })).toBe(
        true
      )
      expect(fastModeEnabledFor({ provider: 'kimi', selectedModel: 'x' })).toBe(false)
    })

    it('reads cursor from the flag for grok models and from the MODEL for composer-2.5', () => {
      expect(
        fastModeEnabledFor({
          provider: 'cursor',
          selectedModel: CURSOR_GROK_46_BASE_MODEL_ID,
          cursorFastMode: true
        })
      ).toBe(true)
      // The composer-2.5 pair carries fastness in the model id, so the flag is
      // deliberately ignored there.
      expect(
        fastModeEnabledFor({
          provider: 'cursor',
          selectedModel: 'composer-2.5',
          cursorFastMode: true
        })
      ).toBe(false)
      expect(fastModeEnabledFor({ provider: 'cursor', selectedModel: 'composer-2.5-fast' })).toBe(
        true
      )
    })
  })

  describe('nextFastModeToggle', () => {
    it('moves codex between the fast tier and an empty tier', () => {
      expect(
        nextFastModeToggle({ provider: 'codex', selectedModel: 'x', codexServiceTier: '' })
      ).toEqual({ kind: 'codex-tier', serviceTier: 'fast', fastModeEnabled: true })
      expect(
        nextFastModeToggle({ provider: 'codex', selectedModel: 'x', codexServiceTier: 'fast' })
      ).toEqual({ kind: 'codex-tier', serviceTier: '', fastModeEnabled: false })
    })

    it('flips claude’s flag with no service tier', () => {
      expect(
        nextFastModeToggle({ provider: 'claude', selectedModel: 'x', claudeFastMode: false })
      ).toEqual({ kind: 'flag', provider: 'claude', fastModeEnabled: true })
    })

    it('mirrors kimi’s flag into a service tier', () => {
      expect(
        nextFastModeToggle({ provider: 'kimi', selectedModel: 'x', kimiFastMode: false })
      ).toEqual({ kind: 'flag', provider: 'kimi', fastModeEnabled: true, serviceTier: 'fast' })
      expect(
        nextFastModeToggle({ provider: 'kimi', selectedModel: 'x', kimiFastMode: true })
      ).toEqual({ kind: 'flag', provider: 'kimi', fastModeEnabled: false, serviceTier: 'standard' })
    })

    it('flips cursor’s flag on a grok model but SWAPS the model on composer-2.5', () => {
      expect(
        nextFastModeToggle({
          provider: 'cursor',
          selectedModel: CURSOR_GROK_46_BASE_MODEL_ID,
          cursorFastMode: false
        })
      ).toEqual({ kind: 'flag', provider: 'cursor', fastModeEnabled: true })
      expect(nextFastModeToggle({ provider: 'cursor', selectedModel: 'composer-2.5' })).toEqual({
        kind: 'model',
        model: 'composer-2.5-fast'
      })
      expect(
        nextFastModeToggle({ provider: 'cursor', selectedModel: 'composer-2.5-fast' })
      ).toEqual({ kind: 'model', model: 'composer-2.5' })
    })

    it('returns null for providers with no wired switch', () => {
      expect(nextFastModeToggle({ provider: 'grok', selectedModel: GROK_46_MODEL_ID })).toBeNull()
      expect(nextFastModeToggle({ provider: 'ollama', selectedModel: 'llama3' })).toBeNull()
    })

    it('round-trips: toggling twice returns to the starting state', () => {
      for (const selection of [
        { provider: 'codex' as const, selectedModel: 'x', codexServiceTier: '' },
        { provider: 'claude' as const, selectedModel: 'x', claudeFastMode: false },
        { provider: 'kimi' as const, selectedModel: 'x', kimiFastMode: false },
        { provider: 'cursor' as const, selectedModel: 'composer-2.5' }
      ]) {
        const before = fastModeEnabledFor(selection)
        const first = nextFastModeToggle(selection)
        expect(first).not.toBeNull()
        const flipped =
          first!.kind === 'codex-tier'
            ? { ...selection, codexServiceTier: first!.serviceTier }
            : first!.kind === 'model'
              ? { ...selection, selectedModel: first!.model }
              : first!.provider === 'claude'
                ? { ...selection, claudeFastMode: first!.fastModeEnabled }
                : first!.provider === 'kimi'
                  ? { ...selection, kimiFastMode: first!.fastModeEnabled }
                  : { ...selection, cursorFastMode: first!.fastModeEnabled }
        expect(fastModeEnabledFor(flipped)).toBe(!before)
      }
    })
  })
})
