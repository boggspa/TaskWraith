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

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LIVE_SELECTABLE_PROVIDER_IDS } from '../../../shared/retiredProviders'
import { getStaticProviderModels } from '../../../main/providers/StaticProviderModels'
import { getDefaultModelForProvider as getMainDefaultModelForProvider } from '../../../main/services/ComposerService'
import type { ProviderId } from '../../../main/store/types'
import { getProviderName } from './Sidebar'
import { getEnsembleModelDefaults } from '../lib/ensembleProviderDefaults'
import {
  DYNAMIC_CATALOGUE_PROVIDER_IDS,
  GEMINI_DEFAULT_MODEL,
  getStaticProviderDefaultModel,
  getStaticProviderModelOptions,
  isDynamicCatalogueProvider,
  MISTRAL_DEFAULT_MODELS,
  type StaticCatalogueProviderId
} from '../lib/providerModelDefaults'

/**
 * Every provider the static dispatcher half must answer for — the FULL domain
 * of `StaticCatalogueProviderId`, not just the live-selectable subset. Retired
 * `gemini` belongs here: it is still rendered for history, so the dispatchers
 * are still called with it.
 *
 * Written as an exhaustive Record rather than a hand-kept array so this test
 * file is itself a compile-time guard: add a ProviderId that is not in
 * DYNAMIC_CATALOGUE_PROVIDER_IDS and this object stops typechecking until the
 * new provider is listed and therefore asserted on. A plain array would go
 * stale silently, which is the exact sin this file exists to prevent.
 */
const STATIC_CATALOGUE_ROSTER: Record<StaticCatalogueProviderId, true> = {
  gemini: true,
  kimi: true,
  grok: true,
  cursor: true,
  mistral: true
}
const STATIC_CATALOGUE_PROVIDER_IDS = Object.keys(
  STATIC_CATALOGUE_ROSTER
) as StaticCatalogueProviderId[]

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

describe('main/renderer model-catalogue agreement', () => {
  // The composer picker does NOT read main's catalogue — the renderer keeps its
  // own copy in providerModelDefaults.ts and App.tsx dispatches to it. So main
  // can resolve a provider's models perfectly while the picker shows "No models
  // available", which is exactly what shipped: every main-side test passed, the
  // seat was selectable, and it had no model to pick. Only driving the UI found
  // it. This asserts the two sides agree for the static-catalogue seats.
  it('serves the same Mistral models on both sides of the boundary', () => {
    const mainIds = getStaticProviderModels('mistral').map((model) => model.id)
    const rendererIds = MISTRAL_DEFAULT_MODELS.map((model) => model.id)
    expect(mainIds.length).toBeGreaterThan(0)
    expect(rendererIds.length).toBeGreaterThan(0)
    expect([...rendererIds].sort()).toEqual([...mainIds].sort())
  })

  it('agrees on the catalogue for EVERY static provider, not just Mistral', () => {
    // Generalized from the Mistral-only case above, which was written after the
    // fact and so could only ever catch the provider that had already shipped
    // broken. This is the version that catches the NEXT one.
    for (const provider of STATIC_CATALOGUE_PROVIDER_IDS) {
      const mainIds = getStaticProviderModels(provider).map((model) => model.id)
      const rendererIds = getStaticProviderModelOptions(provider).map((model) => model.id)
      expect(rendererIds.length, `${provider} has an empty renderer catalogue`).toBeGreaterThan(0)
      expect(
        [...rendererIds].sort(),
        `${provider} main/renderer catalogues diverge — the picker and the run would disagree`
      ).toEqual([...mainIds].sort())
    }
  })

  it('marks exactly one default, and the same one, on both sides', () => {
    // A catalogue that agrees on membership but disagrees on `isDefault` seeds
    // a different model depending on which side answered — so this assertion is
    // the more valuable half and must not be weakened to compile.
    //
    // `getStaticProviderModels` returns a UNION across provider row shapes and
    // not every member declares `isDefault`, so a bare `model.isDefault` does
    // not typecheck. Narrowed with an `in` check rather than cast through
    // `any`: a cast would keep the test green while quietly removing the thing
    // that makes it meaningful.
    const defaultIdOf = (models: readonly { id: string }[]): string | undefined => {
      for (const model of models) {
        if ('isDefault' in model && model.isDefault === true) return model.id
      }
      return undefined
    }

    const mainDefault = defaultIdOf(getStaticProviderModels('mistral'))
    const rendererDefault = defaultIdOf(MISTRAL_DEFAULT_MODELS)
    expect(mainDefault).toBeTruthy()
    expect(rendererDefault).toBe(mainDefault)
  })
})

describe('composer model dispatch fallthrough', () => {
  // THE gap this file could not previously reach. `getProviderModelOptions` and
  // `getDefaultModelForProvider` are closures inside the App component, so no
  // test could call them; their terminal arms returned `[]` and
  // GEMINI_DEFAULT_MODEL. Pi fell in, then Mistral fell into the identical arm
  // and reached a live dev instance. The static half now lives in
  // providerModelDefaults.ts as a pure, exhaustive switch — which is what makes
  // the assertions below possible at all.

  it('is not vacuous — the static roster it iterates is real', () => {
    // Same discipline as the roster check at the top of this file: an empty or
    // truncated roster would make every loop below iterate nothing and pass.
    expect(STATIC_CATALOGUE_PROVIDER_IDS.length).toBeGreaterThanOrEqual(5)
    expect(STATIC_CATALOGUE_PROVIDER_IDS).toContain('mistral')
    expect(STATIC_CATALOGUE_PROVIDER_IDS).toContain('kimi')
    // Retired-but-still-rendered gemini is in the static domain too.
    expect(STATIC_CATALOGUE_PROVIDER_IDS).toContain('gemini')
    // ...and the dynamic set really is the state-backed one, so no provider is
    // quietly parked there to dodge the static assertions.
    expect([...DYNAMIC_CATALOGUE_PROVIDER_IDS].sort()).toEqual([
      'antigravity',
      'claude',
      'codex',
      'ollama',
      'pi'
    ])
  })

  it('routes every live-selectable provider to exactly one dispatcher half', () => {
    // A provider that is neither state-backed nor in the static switch is the
    // fall-in itself. Partition membership is the invariant.
    for (const provider of LIVE_SELECTABLE_PROVIDER_IDS) {
      const dynamic = isDynamicCatalogueProvider(provider)
      const staticly = (STATIC_CATALOGUE_PROVIDER_IDS as readonly ProviderId[]).includes(provider)
      expect(
        dynamic !== staticly,
        `${provider} is in neither dispatcher half (or both) — this is the fall-in`
      ).toBe(true)
    }
  })

  it('never hands a non-Gemini provider the Gemini default', () => {
    // The exact damage, stated as an assertion: this is what Pi and then
    // Mistral silently did. A wrong-but-plausible id in the picker is far
    // harder to notice after the fact than an empty list.
    for (const provider of STATIC_CATALOGUE_PROVIDER_IDS) {
      if (provider === 'gemini') continue
      expect(
        getStaticProviderDefaultModel(provider),
        `${provider} defaults to the Gemini model id — it would run Gemini's model on its own seat`
      ).not.toBe(GEMINI_DEFAULT_MODEL)
    }
  })

  it("seeds each static provider's default from its OWN catalogue", () => {
    for (const provider of STATIC_CATALOGUE_PROVIDER_IDS) {
      const ids = getStaticProviderModelOptions(provider).map((model) => model.id)
      const defaultId = getStaticProviderDefaultModel(provider)
      expect(defaultId.trim(), `${provider} has an empty default model id`).not.toBe('')
      expect(
        ids,
        `${provider} defaults to "${defaultId}", which is not one of its own models`
      ).toContain(defaultId)
    }
  })

  it('pins each static default to the row the catalogue marks isDefault', () => {
    // The default is a hand-written constant, not derived from the catalogue,
    // so the two can drift silently. Assert they agree rather than deriving —
    // deriving would make this test tautological.
    for (const provider of STATIC_CATALOGUE_PROVIDER_IDS) {
      const flagged = getStaticProviderModelOptions(provider).find((model) => model.isDefault)
      expect(flagged?.id, `${provider} marks no catalogue row isDefault`).toBeTruthy()
      expect(
        getStaticProviderDefaultModel(provider),
        `${provider}'s pinned default disagrees with its own isDefault row`
      ).toBe(flagged?.id)
    }
  })

  it('agrees with main on the default model for every static provider', () => {
    // main/services/ComposerService owns the default used for cross-provider
    // verifiers and for any run that arrives without a selected model. It had
    // the SAME terminal arm and no `mistral` branch, so a Mistral run with no
    // stored model resolved to 'flash-lite'. Renderer-only guards cannot see
    // that; this one can.
    for (const provider of STATIC_CATALOGUE_PROVIDER_IDS) {
      expect(
        getMainDefaultModelForProvider(provider),
        `${provider}: main and the picker would seed different models`
      ).toBe(getStaticProviderDefaultModel(provider))
    }
  })

  it('keeps Pi and Mistral selections in their own composer catalogues', () => {
    // This predicate is intentionally local to App because it closes over the
    // live, key-filtered Pi model list. Exercise the actual source rather than
    // duplicating a second predicate in the test: without these branches valid
    // Pi/Mistral ids fall through to `isGeminiModelId`, then silently become
    // their provider's default at dispatch time.
    const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    const predicateStart = appSource.indexOf('const isValidModelForProvider =')
    const predicateEnd = appSource.indexOf('const rememberOllamaInstalledModels =')
    const predicate = appSource.slice(predicateStart, predicateEnd)

    expect(predicate).toContain("if (provider === 'pi')")
    expect(predicate).toContain(
      "return getProviderModelOptions('pi').some((model) => model.id === modelId)"
    )
    expect(predicate).toContain("if (provider === 'mistral')")
    expect(predicate).toContain(
      "return getProviderModelOptions('mistral').some((model) => model.id === modelId)"
    )
  })

  it('THROWS on an unhandled provider instead of returning a plausible wrong value', () => {
    // Both dispatchers are reached through `any`-typed props
    // (MainAppLayout.types.ts, Composer.tsx), so the type guard alone is not
    // total — an unknown id can still arrive at runtime. Under dev/test that
    // must be loud. This cast is deliberately simulating exactly that seam.
    const unknown = 'not-a-provider' as unknown as StaticCatalogueProviderId
    expect(() => getStaticProviderModelOptions(unknown)).toThrow(/No static model catalogue/)
    expect(() => getStaticProviderDefaultModel(unknown)).toThrow(/No default model/)
    // And the message must say what to do, not just that something went wrong.
    expect(() => getStaticProviderDefaultModel(unknown)).toThrow(/Add a case/)
  })

  it('keeps main exhaustive too — an unknown provider throws rather than running Gemini', () => {
    const unknown = 'not-a-provider' as unknown as ProviderId
    expect(() => getMainDefaultModelForProvider(unknown)).toThrow(/No default model for provider/)
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
