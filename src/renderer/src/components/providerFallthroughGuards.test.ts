// Provider-agnostic guards against the silent-fallthrough bug CLASS.
//
// Adding a ProviderId to the union compiles cleanly and then quietly hands the
// new provider ANOTHER provider's data, because these lookups are `if` chains
// and `switch` statements with a terminal default rather than exhaustive
// Records. Nothing fails to compile and nothing fails to render — the wrong
// name or the wrong catalogue just appears in the UI.
//
// Both assertions below were RED when written. Adding `mistral` left:
//   * getProviderName('mistral') === 'Gemini' — rendered in composer picker
//     rows, participant chips and sidebar badges, while the row's own sub-label
//     correctly said "Mistral Vibe CLI".
//   * getEnsembleModelDefaults('mistral') returning modelOptions: [] and
//     defaultModelId: 'gpt-5.5' — so a Mistral ensemble participant offered
//     ZERO selectable models and was seeded with a Codex model id.
//
// These are deliberately written against LIVE_SELECTABLE_PROVIDER_IDS rather
// than a hardcoded list, so the NEXT provider added to the live set inherits
// the guard for free instead of repeating the same afternoon.

import { describe, expect, it } from 'vitest'
import { LIVE_SELECTABLE_PROVIDER_IDS } from '../../../shared/retiredProviders'
import { getProviderName } from './Sidebar'
import { getEnsembleModelDefaults } from '../lib/ensembleProviderDefaults'

describe('provider display-name fallthrough', () => {
  it('is not vacuous — the roster it iterates is real', () => {
    // Every assertion below is a for-loop over LIVE_SELECTABLE_PROVIDER_IDS, so
    // an empty or truncated roster would make this whole file pass while testing
    // nothing. Pin the floor and the membership that motivated it.
    expect(LIVE_SELECTABLE_PROVIDER_IDS.length).toBeGreaterThanOrEqual(8)
    expect(LIVE_SELECTABLE_PROVIDER_IDS).toContain('mistral')
  })

  it('gives every live-selectable provider its own name, never the Gemini fallback', () => {
    for (const provider of LIVE_SELECTABLE_PROVIDER_IDS) {
      const name = getProviderName(provider)
      expect(name, `${provider} has no getProviderName branch`).not.toBe('Gemini')
      expect(name.trim(), `${provider} resolved to an empty display name`).not.toBe('')
    }
  })

  it('never reuses one provider name for two providers', () => {
    // A copy-pasted branch that forgets to change the returned string is the
    // other half of this bug class, and it reads as correct at a glance.
    const names = LIVE_SELECTABLE_PROVIDER_IDS.map((provider) => getProviderName(provider))
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('ensemble model defaults fallthrough', () => {
  it('offers at least one model for every live-selectable provider', () => {
    for (const provider of LIVE_SELECTABLE_PROVIDER_IDS) {
      const defaults = getEnsembleModelDefaults(provider)
      expect(
        defaults.modelOptions.length,
        `${provider} falls through to the empty default catalogue, so its ensemble picker is empty`
      ).toBeGreaterThan(0)
    }
  })

  it("seeds each provider's default from its OWN catalogue", () => {
    // The sharper assertion: an empty catalogue is obvious once looked at, but a
    // default id borrowed from whichever provider the `default:` arm names is
    // not — it produces a participant configured with a model its own provider
    // cannot run.
    for (const provider of LIVE_SELECTABLE_PROVIDER_IDS) {
      const defaults = getEnsembleModelDefaults(provider)
      const ids = defaults.modelOptions.map((option) => option.id)
      expect(
        ids,
        `${provider} defaults to "${defaults.defaultModelId}", which is not one of its own models`
      ).toContain(defaults.defaultModelId)
    }
  })
})
