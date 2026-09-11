import { describe, it, expect } from 'vitest'
import {
  CODEX_EXPLICITLY_RUNNABLE_MODEL_IDS,
  CODEX_STAGED_ROLLOUT_MODEL_IDS,
  CODEX_WIRE_REASONING_EFFORTS,
  codexModelContextConfig,
  codexReasoningEffortsForModel,
  codexWireReasoningEffort,
  claudeModelSupportsFastMode,
  appendKimiModelArgs,
  kimiAcpModelConfigValue,
  kimiAcpThinkingConfigValue,
  getStaticProviderModels,
  KIMI_HIGHSPEED_CLI_MODEL,
  KIMI_K3_256K_CLI_MODEL,
  KIMI_K3_CLI_MODEL,
  KIMI_STANDARD_CLI_MODEL,
  mergeCodexLiveModelRows,
  normalizeCliProviderModel,
  normalizeKimiReasoningEffort
} from './StaticProviderModels'
import {
  concreteModelForPreviewPlaceholder,
  isPreviewCatalogModelId
} from '../../shared/previewModelCatalog'
import { normalizeMistralThinkingLevel } from '../mistral/MistralCliArgs'

describe('codexModelContextConfig', () => {
  const longContextConfig = {
    model_context_window: 1_050_000,
    model_auto_compact_token_limit: 850_000
  }

  it('returns the explicit 1M config for long-context Codex models', () => {
    expect(codexModelContextConfig('gpt-6-astra')).toEqual(longContextConfig)
    expect(codexModelContextConfig('gpt-5.5')).toEqual(longContextConfig)
    expect(codexModelContextConfig('gpt-5.4')).toEqual(longContextConfig)
    // GPT-5.6 trio (GA) — same long-context override as gpt-5.5 for parity.
    expect(codexModelContextConfig('gpt-5.6-sol')).toEqual(longContextConfig)
    expect(codexModelContextConfig('gpt-5.6-terra')).toEqual(longContextConfig)
    expect(codexModelContextConfig('gpt-5.6-luna')).toEqual(longContextConfig)
  })

  it('maps TaskWraith default aliases to GPT-5.5 context config', () => {
    expect(codexModelContextConfig(undefined)).toEqual(longContextConfig)
    expect(codexModelContextConfig('cli-default')).toEqual(longContextConfig)
    expect(codexModelContextConfig('auto')).toEqual(longContextConfig)
  })

  it('does not override short-context Codex models', () => {
    expect(codexModelContextConfig('gpt-5.4-mini')).toBeNull()
    expect(codexModelContextConfig('gpt-5.3-codex-spark')).toBeNull()
  })
})

describe('getStaticProviderModels (Mistral hosted GLM-5.2 thinking correlation)', () => {
  const glm = getStaticProviderModels('mistral').find((model) => model.id === 'glm-5-2') as
    | { defaultReasoningEffort?: string; supportedReasoningEfforts?: { reasoningEffort: string }[] }
    | undefined

  it('defaults the hosted GLM-5.2 to high, matching its Vibe-native default', () => {
    expect(glm?.defaultReasoningEffort).toBe('high')
  })

  it('maps every offered effort 1:1 onto the Vibe thinking ladder (no silent downgrade)', () => {
    // The seat sends `set_config_option { thinking }` computed by
    // normalizeMistralThinkingLevel(reasoningEffort); a null there is OMITTED,
    // silently leaving the run on the model default. So every effort TaskWraith
    // offers for this model (and its default) must map to a real Vibe level.
    const efforts = (glm?.supportedReasoningEfforts ?? []).map((effort) => effort.reasoningEffort)
    expect(efforts).toEqual(['off', 'low', 'medium', 'high', 'max'])
    for (const effort of efforts) {
      expect(normalizeMistralThinkingLevel(effort)).toBe(effort)
    }
    expect(normalizeMistralThinkingLevel(glm?.defaultReasoningEffort)).toBe('high')
  })
})

describe('getStaticProviderModels (Muse catalogue)', () => {
  it('offers both Spark 1.3 routes ahead of 1.2 while keeping Spark 1.2 the default', () => {
    expect(getStaticProviderModels('muse')).toEqual([
      {
        id: 'muse-spark-1.3',
        label: 'Muse Spark 1.3',
        description: '1M context - $1.25/$4.25 per Mtok',
        ultraTaskSupported: true
      },
      {
        id: 'muse-spark-1.3-contributor',
        label: 'Muse Contributor Spark 1.3',
        description:
          '1M context - $0.10/$0.20 per Mtok - content may be used for product improvement',
        ultraTaskSupported: true
      },
      {
        id: 'muse-spark-1.2',
        label: 'Muse Spark 1.2',
        description: '1M context - $1.25/$4.25 per Mtok',
        isDefault: true,
        ultraTaskSupported: true
      },
      {
        id: 'muse-spark-1.2-contributor',
        label: 'Muse Contributor Spark 1.2',
        description:
          '1M context - $0.10/$0.20 per Mtok - content may be used for product improvement',
        ultraTaskSupported: true
      }
    ])
  })
})

describe('getStaticProviderModels (Pi lifecycle)', () => {
  it('warns before Pi model sunsets and removes each model on its retirement date', () => {
    const before = getStaticProviderModels('pi', {
      now: new Date(2026, 7, 16, 23, 59)
    })
    expect(before.find((model) => model.id === 'cerebras/zai-glm-4.7')).toMatchObject({
      label: 'GLM-4.7 (Cerebras)',
      retiresAt: '2026-08-17'
    })
    expect(before.find((model) => model.id === 'openrouter/stealth/ox-alpha')).toMatchObject({
      label: 'Ox Alpha',
      retiresAt: '2026-08-28'
    })

    const cerebrasRetired = getStaticProviderModels('pi', {
      now: new Date(2026, 7, 17, 0, 0)
    })
    expect(cerebrasRetired.some((model) => model.id === 'cerebras/zai-glm-4.7')).toBe(false)
    expect(cerebrasRetired.some((model) => model.id === 'openrouter/stealth/ox-alpha')).toBe(
      true
    )

    const oxAlphaRetired = getStaticProviderModels('pi', {
      now: new Date(2026, 7, 28, 0, 0)
    })
    expect(oxAlphaRetired.some((model) => model.id === 'openrouter/stealth/ox-alpha')).toBe(
      false
    )
    expect(oxAlphaRetired.some((model) => model.id === 'zai/glm-4.7')).toBe(true)
    expect(oxAlphaRetired.some((model) => model.id === 'cerebras/gpt-oss-120b')).toBe(true)
    expect(oxAlphaRetired.some((model) => model.id === 'openrouter/z-ai/glm-5.2')).toBe(true)
    expect(
      oxAlphaRetired
        .filter((model) =>
          [
            'openrouter/cohere/north-mini-code:free',
            'openrouter/minimax/minimax-m3:free',
            'openrouter/thinkingmachines/inkling:free',
            'openrouter/thinkingmachines/inkling-small:free'
          ].includes(model.id)
        )
        .map((model) => [model.id, model.label])
    ).toEqual([
      ['openrouter/cohere/north-mini-code:free', 'North Mini Code'],
      ['openrouter/minimax/minimax-m3:free', 'M3 (OpenRouter)'],
      ['openrouter/thinkingmachines/inkling:free', 'Inkling'],
      ['openrouter/thinkingmachines/inkling-small:free', 'Inkling Small']
    ])
  })

  it('projects the new OpenRouter reasoning ladders and defaults into picker rows', () => {
    const models = new Map(
      getStaticProviderModels('pi', { now: new Date(2026, 7, 30) }).map((model) => [
        model.id,
        model
      ])
    )
    for (const modelId of [
      'openrouter/cohere/north-mini-code:free',
      'openrouter/minimax/minimax-m3:free'
    ]) {
      expect(models.get(modelId), modelId).toMatchObject({
        supportedReasoningEfforts: [{ reasoningEffort: 'off' }, { reasoningEffort: 'high' }],
        defaultReasoningEffort: 'high'
      })
    }
    for (const modelId of [
      'openrouter/thinkingmachines/inkling:free',
      'openrouter/thinkingmachines/inkling-small:free'
    ]) {
      expect(models.get(modelId), modelId).toMatchObject({
        supportedReasoningEfforts: [
          { reasoningEffort: 'off' },
          { reasoningEffort: 'minimal' },
          { reasoningEffort: 'low' },
          { reasoningEffort: 'medium' },
          { reasoningEffort: 'high' },
          { reasoningEffort: 'max' }
        ],
        defaultReasoningEffort: 'high'
      })
    }
  })
})

describe('normalizeCliProviderModel (muse)', () => {
  it('resolves every sentinel to the concrete catalogue default', () => {
    // 'cli-default' is TaskWraith-internal. Muse had no branch here, so it fell
    // through to the generic tail and became 'default' — a second sentinel that
    // is equally not a model id, and which the MSP lane put on the wire.
    for (const sentinel of ['cli-default', 'default', 'auto', '', '  ', 'CLI-DEFAULT']) {
      expect(normalizeCliProviderModel('muse', sentinel)).toBe('muse-spark-1.2')
    }
    expect(normalizeCliProviderModel('muse', null)).toBe('muse-spark-1.2')
    expect(normalizeCliProviderModel('muse', undefined)).toBe('muse-spark-1.2')
  })

  it('resolves to whichever catalogue row carries isDefault, not a hardcoded id', () => {
    const flagged = getStaticProviderModels('muse').find((model) => model.isDefault)
    expect(flagged?.id).toBe(normalizeCliProviderModel('muse', 'cli-default'))
  })

  it('passes a real Muse model id through untouched', () => {
    expect(normalizeCliProviderModel('muse', 'muse-spark-1.3')).toBe('muse-spark-1.3')
    expect(normalizeCliProviderModel('muse', 'muse-spark-1.2-contributor')).toBe(
      'muse-spark-1.2-contributor'
    )
  })
})

describe('normalizeCliProviderModel (claude)', () => {
  it('strips the TaskWraith-internal -1m marker so the CLI gets the base model id', () => {
    // The 1M window is entitlement-based on the base id.
    expect(normalizeCliProviderModel('claude', 'claude-opus-4-8-1m')).toBe('claude-opus-4-8')
    expect(normalizeCliProviderModel('claude', 'claude-opus-4-7-1m')).toBe('claude-opus-4-7')
    // Opus 5 ships 1M by default with no -1m picker row, but a stray suffixed
    // id (forged/persisted) still strips to the runnable base id.
    expect(normalizeCliProviderModel('claude', 'claude-opus-5-1m')).toBe('claude-opus-5')
  })

  it('passes through base claude ids and bare family aliases unchanged', () => {
    expect(normalizeCliProviderModel('claude', 'claude-opus-4-8')).toBe('claude-opus-4-8')
    expect(normalizeCliProviderModel('claude', 'claude-opus-5')).toBe('claude-opus-5')
    for (const alias of ['sonnet', 'opus', 'haiku']) {
      expect(normalizeCliProviderModel('claude', alias)).toBe(alias)
    }
  })

  it('keeps returned Fable and Mythos ids runnable', () => {
    expect(normalizeCliProviderModel('claude', 'fable')).toBe('claude-fable-5-1')
    expect(normalizeCliProviderModel('claude', 'claude-fable-5-1')).toBe('claude-fable-5-1')
    expect(normalizeCliProviderModel('claude', 'mythos')).toBe('claude-mythos-5')
    expect(normalizeCliProviderModel('claude', 'claude-fable-5')).toBe('claude-fable-5')
    expect(normalizeCliProviderModel('claude', 'claude-fable-5-1m')).toBe('claude-fable-5')
    expect(normalizeCliProviderModel('claude', 'claude-mythos-5')).toBe('claude-mythos-5')
  })

  it('maps non-runnable / stale Claude preview placeholders back to the concrete default', () => {
    // claude-sonnet-5 is GA, but a persisted preview-namespaced id from before
    // it shipped still maps to the concrete default rather than dispatching an
    // invalid `preview:` model name.
    expect(normalizeCliProviderModel('claude', 'preview:anthropic:claude-sonnet-5')).toBe(
      'claude-sonnet-5'
    )
    expect(normalizeCliProviderModel('claude', 'preview:anthropic:claude-fable-5')).toBe(
      'claude-sonnet-5'
    )
    expect(normalizeCliProviderModel('claude', 'preview:anthropic:claude-mythos-5')).toBe(
      'claude-sonnet-5'
    )
  })

  it('maps empty / sentinel ids to Sonnet 5', () => {
    expect(normalizeCliProviderModel('claude', '')).toBe('claude-sonnet-5')
    expect(normalizeCliProviderModel('claude', 'default')).toBe('claude-sonnet-5')
    expect(normalizeCliProviderModel('claude', 'cli-default')).toBe('claude-sonnet-5')
    expect(normalizeCliProviderModel('claude', 'custom')).toBe('claude-sonnet-5')
  })

  it('keeps the legacy Sonnet 4.6 id runnable for historical selections', () => {
    expect(normalizeCliProviderModel('claude', 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
  })
})

describe('claudeModelSupportsFastMode', () => {
  it('allows supported Opus variants but rejects Fable 5', () => {
    expect(claudeModelSupportsFastMode('claude-opus-5')).toBe(true)
    expect(claudeModelSupportsFastMode('claude-opus-4-8-1m')).toBe(true)
    expect(claudeModelSupportsFastMode('claude-opus-4-7')).toBe(true)
    expect(claudeModelSupportsFastMode('claude-fable-5')).toBe(false)
    expect(claudeModelSupportsFastMode('claude-fable-5-1m')).toBe(false)
  })
})

interface StaticModelShape {
  id: string
  label?: string
  description?: string
  isDefault?: boolean
  disabled?: boolean
  disabledReason?: string
  runnable?: boolean
  defaultReasoningEffort?: string | null
  additionalSpeedTiers?: string[]
  supportedReasoningEfforts?: Array<{
    reasoningEffort: string
    disabled?: boolean
    disabledReason?: string
  }>
}

describe('getStaticProviderModels (provider-specific catalogs)', () => {
  it('does not expose generic Default or CLI Default model rows', () => {
    for (const provider of [
      'codex',
      'claude',
      'antigravity',
      'gemini',
      'kimi',
      'grok',
      'cursor',
      'ollama'
    ] as const) {
      const models = getStaticProviderModels(provider)
      expect(models.map((model) => model.id)).not.toEqual(
        expect.arrayContaining(['default', 'cli-default'])
      )
      expect(models.map((model) => model.label)).not.toEqual(
        expect.arrayContaining(['Default', 'CLI Default'])
      )
    }
  })

  it('returns distinct model lists without borrowing Gemini rows for AntiGravity', () => {
    const antigravity = getStaticProviderModels('antigravity').map((m) => m.id)
    const gemini = getStaticProviderModels('gemini').map((m) => m.id)
    const grok = getStaticProviderModels('grok').map((m) => m.id)
    const cursor = getStaticProviderModels('cursor').map((m) => m.id)
    // AntiGravity owns a gemini-api: prefixed BYO-key floor (ensemble seats
    // must never be model-less) — but it still borrows NO retired-Gemini
    // alias rows (`pro`/`flash`/`cli-default`), and agy-CLI rows stay
    // discovery-owned.
    expect(antigravity).toEqual([
      'gemini-api:gemini-3.6-flash',
      'gemini-api:gemini-3.5-flash',
      'gemini-api:gemini-3.1-pro-preview',
      'gemini-api:gemini-3.1-flash-lite'
    ])
    // The floor must name only models that can still be dispatched. The 2.5
    // family was probed dead on 2026-07-26; a fallback row that 404s is worse
    // than a short list, because it lands on a user who had no other choice.
    expect(antigravity).not.toEqual(
      expect.arrayContaining([
        'gemini-api:gemini-2.5-flash',
        'gemini-api:gemini-2.5-flash-lite',
        'gemini-api:gemini-2.0-flash'
      ])
    )
    expect(antigravity.every((id) => id.startsWith('gemini-api:'))).toBe(true)
    expect(gemini).toContain('flash')
    expect(antigravity).not.toEqual(expect.arrayContaining(['flash', 'pro', 'cli-default']))
    expect(grok).toEqual(['grok-4.6', 'grok-4.5', 'grok-composer-2.5-fast'])
    // No grok-4.5: Cursor's catalogue retired the family, and offering an id
    // cursor-agent rejects costs the whole run (exit 1, "Cannot use this model").
    expect(cursor).toEqual(['composer-2.5-fast', 'composer-2.5', 'grok-4.6'])
  })

  it('publishes Grok 4.6 as the 500K Extra High-capable default', () => {
    const grok = getStaticProviderModels('grok') as StaticModelShape[]
    expect(grok.find((model) => model.id === 'grok-4.6')).toMatchObject({
      label: 'Grok 4.6 Fast',
      description: '500K context - low/medium/high/extra-high reasoning',
      isDefault: true,
      defaultReasoningEffort: 'high'
    })
    expect(
      grok
        .find((model) => model.id === 'grok-4.6')
        ?.supportedReasoningEfforts?.map((option) => option.reasoningEffort)
    ).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(grok.find((model) => model.id === 'grok-4.5')?.isDefault).not.toBe(true)
  })

  it('prefixes the resold Grok rows in Cursor model metadata', () => {
    // Keep in lockstep with CURSOR_DEFAULT_MODELS in the renderer: resale rows
    // carry the Cursor prefix so they cannot be confused with Grok-provider
    // rows in a flat picker scan.
    const cursor = getStaticProviderModels('cursor') as StaticModelShape[]
    expect(cursor.find((model) => model.id === 'grok-4.6')).toMatchObject({
      label: 'Cursor Grok 4.6',
      description: 'First-party Cursor model pool - 256K context',
      defaultReasoningEffort: 'high',
      additionalSpeedTiers: ['fast']
    })
    expect(
      cursor
        .find((model) => model.id === 'grok-4.6')
        ?.supportedReasoningEfforts?.map((option) => option.reasoningEffort)
    ).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(cursor.find((model) => model.id === 'grok-4.5')).toBeUndefined()
  })

  it('normalizes invalid cross-provider model ids back to provider defaults', () => {
    expect(normalizeCliProviderModel('grok', 'flash')).toBe('grok-4.6')
    expect(normalizeCliProviderModel('cursor', 'pro')).toBe('composer-2.5-fast')
    expect(normalizeCliProviderModel('gemini', 'flash')).toBe('flash')
    expect(normalizeCliProviderModel('gemini', 'cli-default')).toBe('flash-lite')
  })

  it('migrates the retired Qwen 3.8 preview wire id to the GA Pi model', () => {
    expect(normalizeCliProviderModel('pi', 'qwen-token-plan/qwen3.8-max-preview')).toBe(
      'qwen-token-plan/qwen3.8-max'
    )
    expect(normalizeCliProviderModel('pi', 'qwen-token-plan/qwen3.8-max')).toBe(
      'qwen-token-plan/qwen3.8-max'
    )
  })

  it('migrates every retired Cursor Grok 4.5 wire id onto Grok 4.6', () => {
    // Cursor dropped the 4.5 family from its catalogue, so a seat still pinned
    // to one of these fails hard at dispatch. Migrating to 4.6 keeps the user's
    // Grok intent (superset ladder) instead of silently becoming Composer.
    for (const retired of [
      'grok-4.5',
      'cursor-grok-4.5',
      'grok-4.5-medium',
      'grok-4.5-high',
      'grok-4.5-xhigh',
      'grok-4.5-fast-medium',
      'grok-4.5-fast-high',
      'grok-4.5-fast-xhigh'
    ]) {
      expect(normalizeCliProviderModel('cursor', retired)).toBe('grok-4.6')
    }
    // The standalone xAI provider is untouched — it still offers Grok 4.5.
    expect(normalizeCliProviderModel('grok', 'grok-4.5')).toBe('grok-4.5')
  })

  it('uses Grok 4.6 as the default while retaining Grok 4.5 and Composer', () => {
    expect(normalizeCliProviderModel('grok', undefined)).toBe('grok-4.6')
    expect(normalizeCliProviderModel('grok', 'cli-default')).toBe('grok-4.6')
    expect(normalizeCliProviderModel('grok', 'grok-4.6')).toBe('grok-4.6')
    expect(normalizeCliProviderModel('grok', 'grok-4.5')).toBe('grok-4.5')
    expect(normalizeCliProviderModel('grok', 'grok-composer-2.5-fast')).toBe(
      'grok-composer-2.5-fast'
    )
    expect(normalizeCliProviderModel('grok', 'composer-2.5-fast')).toBe('grok-4.6')
    expect(normalizeCliProviderModel('grok', 'grok-build')).toBe('grok-4.6')
    expect(normalizeCliProviderModel('cursor', 'grok-4.6')).toBe('grok-4.6')
    expect(normalizeCliProviderModel('cursor', 'cursor-grok-4.6-xhigh-fast')).toBe('grok-4.6')
  })

  it('exposes the curated optional Ollama model tags', () => {
    const ollama = getStaticProviderModels('ollama').map((m) => m.id)
    expect(ollama).toEqual([
      'qwen3:4b-instruct',
      'qwen3.5:2b',
      'qwen3.5:4b',
      'qwen3.5:9b',
      'qwen3.6:35b',
      'qwen3.8:27b-mlx',
      'qwen3.8-flash-next:125b-mlx',
      'gemma3:4b',
      'gemma4:12b',
      'gemma4:31b-mlx',
      'ornith:9b',
      'ornith:35b',
      'ornith-1.5:9b',
      'ornith-1.5:35b',
      'laguna-xs-2.1:q8_0',
      'gpt-oss:20b',
      'lfm2.5-thinking:1.2b',
      'lfm2.5:8b',
      'minicpm-v4.5:8b',
      'granite4:3b',
      'granite4.1:3b',
      'granite4.1:30b',
      'granite4.2:3b',
      'granite4.2:8b',
      'granite4.2:30b',
      'nemotron-3-nano:4b',
      'nemotron3:33b',
      'nemotron-3.5-lightning:30b-mlx',
      'devstral-small-2:24b',
      'mistral-medium-3.5:128b',
      'ministral-3:3b',
      'ministral-3:14b',
      'muse-glimmer:30b-mlx',
      'llama3.1:8b',
      'deepseek-r1:1.5b',
      'deepseek-r1:8b',
      'rnj-1',
      'glm-4.7-flash:q4_K_M',
      'north-mini-code-1.0:q4_K_M',
      'llama3.2:3b',
      'custom'
    ])
  })

  it('ships the GA GPT-5.6 trio as first-class rows regardless of the preview flag', () => {
    // Graduated 2026-07-09: the trio lives in CODEX_STATIC_MODELS itself, so it
    // is present WITHOUT includePreviewModels; 5.5 stays the default during the
    // staged account rollout.
    const models = getStaticProviderModels('codex') as StaticModelShape[]
    expect(models.find((model) => model.isDefault)?.id).toBe('gpt-5.5')
    const ids = models.map((model) => model.id)
    // GPT-6 Astra leads from 2026-09-03 but must NOT take the default: upstream
    // shipped it "without changing the default model".
    expect(ids.slice(0, 4)).toEqual([
      'gpt-6-astra',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna'
    ])
    expect(ids.indexOf('gpt-6-astra')).toBeLessThan(ids.indexOf('gpt-5.5'))
    expect(ids.indexOf('gpt-5.6-sol')).toBeLessThan(ids.indexOf('gpt-5.5'))
  })

  it('offers GPT-6 Astra with its official ladder without taking the default', () => {
    const models = getStaticProviderModels('codex') as StaticModelShape[]
    const astra = models.find((model) => model.id === 'gpt-6-astra')
    expect(astra).toBeDefined()
    expect(astra?.label).toBe('GPT-6-Astra')
    expect(astra?.defaultReasoningEffort).toBe('low')
    // Upstream ladder is low..max plus `ultra`, which TaskWraith carries as its
    // internal `ultracode` token — and the canonical ladder decides the order,
    // not the order the tiers happen to be appended in.
    expect(astra?.supportedReasoningEfforts?.map((e) => e.reasoningEffort)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode'
    ])
    expect(astra?.isDefault).toBeFalsy()
    expect(models.find((model) => model.isDefault)?.id).toBe('gpt-5.5')
    expect(CODEX_STAGED_ROLLOUT_MODEL_IDS.has('gpt-6-astra')).toBe(true)
  })

  it('advertises Light/low reasoning on GPT-5 Codex models', () => {
    const models = getStaticProviderModels('codex') as StaticModelShape[]
    for (const modelId of ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark']) {
      expect(
        models
          .find((model) => model.id === modelId)
          ?.supportedReasoningEfforts?.map((option) => option.reasoningEffort)
      ).toContain('low')
    }
  })

  it('fills missing Light/low reasoning from stale live Codex model metadata', () => {
    expect(
      codexReasoningEffortsForModel('gpt-5.5', [
        { reasoningEffort: 'medium' },
        { reasoningEffort: 'high' },
        { reasoningEffort: 'xhigh' }
      ]).map((option) => option.reasoningEffort)
    ).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it('repairs stale live Spark metadata to its full reasoning ladder', () => {
    expect(
      codexReasoningEffortsForModel('gpt-5.3-codex-spark', [
        { reasoningEffort: 'low' },
        { reasoningEffort: 'medium' }
      ]).map((option) => option.reasoningEffort)
    ).toEqual(['low', 'medium', 'high', 'xhigh'])

    const models = getStaticProviderModels('codex') as StaticModelShape[]
    expect(
      models
        .find((model) => model.id === 'gpt-5.3-codex-spark')
        ?.supportedReasoningEfforts?.map((option) => option.reasoningEffort)
    ).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(
      (
        models.find((model) => model.id === 'gpt-5.3-codex-spark') as {
          ultraTaskSupported?: boolean
        }
      )?.ultraTaskSupported
    ).toBe(true)
  })

  it('carries official GA metadata on the GPT-5.6 trio rows', () => {
    // Verified 2026-07-09 against the upstream Codex catalog
    // (codex-rs/models-manager/models.json): hyphenated display names, Sol
    // defaults to LOW, `max` on all three, `ultra` (internal 'ultracode') on
    // Sol + Terra only.
    const models = getStaticProviderModels('codex') as StaticModelShape[]
    const sol = models.find((model) => model.id === 'gpt-5.6-sol')
    const terra = models.find((model) => model.id === 'gpt-5.6-terra')
    const luna = models.find((model) => model.id === 'gpt-5.6-luna')
    expect(sol).toMatchObject({ label: 'GPT-5.6-Sol', defaultReasoningEffort: 'low' })
    expect(sol?.supportedReasoningEfforts?.map((option) => option.reasoningEffort)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode'
    ])
    expect(terra).toMatchObject({ label: 'GPT-5.6-Terra', defaultReasoningEffort: 'medium' })
    expect(terra?.supportedReasoningEfforts?.map((option) => option.reasoningEffort)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode'
    ])
    expect(luna).toMatchObject({ label: 'GPT-5.6-Luna', defaultReasoningEffort: 'medium' })
    expect(luna?.supportedReasoningEfforts?.map((option) => option.reasoningEffort)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ])
    for (const row of [sol, terra, luna]) {
      expect(row?.additionalSpeedTiers).toEqual(['fast'])
    }
  })

  it('retains the Fast tier on GPT-5.5 and GPT-5.4', () => {
    const models = getStaticProviderModels('codex') as StaticModelShape[]

    for (const modelId of ['gpt-5.5', 'gpt-5.4']) {
      expect(models.find((model) => model.id === modelId)?.additionalSpeedTiers).toEqual(['fast'])
    }
  })

  it('maps stale OpenAI preview placeholder IDs to their concrete GPT-5.6 slugs', () => {
    expect(normalizeCliProviderModel('codex', 'preview:openai:gpt-5.6:sol')).toBe('gpt-5.6-sol')
    expect(normalizeCliProviderModel('codex', 'preview:openai:gpt-5.6:terra')).toBe('gpt-5.6-terra')
    expect(normalizeCliProviderModel('codex', 'preview:openai:gpt-5.6:luna')).toBe('gpt-5.6-luna')
    expect(concreteModelForPreviewPlaceholder('preview:openai:gpt-5.6:sol')).toBe('gpt-5.6-sol')
    expect(concreteModelForPreviewPlaceholder('gpt-5.6-sol')).toBeNull()
  })

  it('marks the GA trio for the staged-rollout live-merge, not the preview catalog', () => {
    // The get-agent-models live-merge appends CODEX_STAGED_ROLLOUT_MODEL_IDS
    // rows while OpenAI's account ramp / the CLI's minimal_client_version gate
    // keep them out of a given account's model/list. The preview catalog is
    // empty post-graduation, so isPreviewCatalogModelId is false for the trio.
    expect(CODEX_STAGED_ROLLOUT_MODEL_IDS.has('gpt-5.6-sol')).toBe(true)
    expect(CODEX_STAGED_ROLLOUT_MODEL_IDS.has('gpt-5.6-terra')).toBe(true)
    expect(CODEX_STAGED_ROLLOUT_MODEL_IDS.has('gpt-5.6-luna')).toBe(true)
    expect(CODEX_STAGED_ROLLOUT_MODEL_IDS.has('gpt-5.5')).toBe(false)
    expect(isPreviewCatalogModelId('gpt-5.6-sol')).toBe(false)
    expect(isPreviewCatalogModelId('gpt-5.5')).toBe(false)
    expect(isPreviewCatalogModelId('preview:openai:gpt-5.6:sol')).toBe(false)
  })

  it('keeps explicitly runnable rows available when CLI discovery omits them', () => {
    // 5.4 / 5.4-mini dropped from model/list at CLI 0.144.0; the Spark
    // research-preview row was dropped by a later catalog update the same way.
    // None have a published sunset, so TaskWraith keeps offering them.
    expect(CODEX_EXPLICITLY_RUNNABLE_MODEL_IDS).toEqual(
      new Set(['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'])
    )
  })

  it('adds Max on the whole GPT-5.6 trio and Ultra(code) on Sol + Terra only', () => {
    const base = [
      { reasoningEffort: 'medium' },
      { reasoningEffort: 'high' },
      { reasoningEffort: 'xhigh' }
    ]
    expect(
      codexReasoningEffortsForModel('gpt-5.6-sol', base).map((option) => option.reasoningEffort)
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    expect(
      codexReasoningEffortsForModel('gpt-5.6-terra', base).map((option) => option.reasoningEffort)
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    expect(
      codexReasoningEffortsForModel('gpt-5.6-luna', base).map((option) => option.reasoningEffort)
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(
      codexReasoningEffortsForModel('gpt-5.5', base).map((option) => option.reasoningEffort)
    ).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it("normalizes the live catalog's official 'ultra' token onto internal 'ultracode'", () => {
    // The live model/list says 'ultra' (official tier id); TaskWraith's shared
    // internal token is 'ultracode'. Inbound rows normalize + dedupe.
    expect(
      codexReasoningEffortsForModel('gpt-5.6-sol', [
        { reasoningEffort: 'low' },
        { reasoningEffort: 'medium' },
        { reasoningEffort: 'high' },
        { reasoningEffort: 'xhigh' },
        { reasoningEffort: 'max' },
        { reasoningEffort: 'ultra' }
      ]).map((option) => option.reasoningEffort)
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
  })

  it('offers a free Devin plan only SWE-1.6 Slow, and every family otherwise', () => {
    const ungated = getStaticProviderModels('devin')
    const gated = getStaticProviderModels('devin', { devinFreePlan: true })
    const paid = getStaticProviderModels('devin', { devinFreePlan: false })
    expect(ungated.length).toBeGreaterThan(1)
    expect(ungated.map((m) => m.id)).toContain('claude-opus-5')
    expect(gated.map((m) => m.id)).toEqual(['swe-1-6-slow'])
    // Fail-open: an unknown plan must never narrow a paying seat's catalogue.
    expect(paid.length).toBe(ungated.length)
  })

  it('orders a live catalog onto the canonical ladder, not catalog order', () => {
    // A live `model/list` may list rungs in any order. `persistent` sits above
    // `ultracode` and below `ultratask`; catalog order must not decide that.
    const efforts = codexReasoningEffortsForModel('gpt-5.6-sol', [
      { reasoningEffort: 'persistent' },
      { reasoningEffort: 'low' },
      { reasoningEffort: 'ultra' },
      { reasoningEffort: 'high' }
    ])
    const order = efforts.map((option) => option.reasoningEffort)
    expect(order).toEqual(['low', 'high', 'max', 'ultracode', 'persistent'])
    expect(order.indexOf('persistent')).toBeGreaterThan(order.indexOf('ultracode'))
  })

  it("clamps above-xhigh tiers to 'xhigh' for the Codex wire (API enum ceiling)", () => {
    // The reasoning.effort enum is {none,minimal,low,medium,high,xhigh}; the API
    // 400s on 'max'/'ultra'/'ultracode' ("Codex failed · exit 1"), so each
    // clamps to 'xhigh' — the deepest reasoning the wire accepts.
    expect(codexWireReasoningEffort('ultracode')).toBe('xhigh')
    expect(codexWireReasoningEffort('Ultracode')).toBe('xhigh')
    expect(codexWireReasoningEffort('ultra')).toBe('xhigh')
    expect(codexWireReasoningEffort('max')).toBe('xhigh')
    // 'persistent' is Codex's tier above 'ultra' (CLI 0.153.0 effort enum) and
    // sits under 'ultratask' on TaskWraith's ladder. It is equally absent from
    // the API enum, so it clamps rather than falling back to the model default
    // — a fallback here would be a silent downgrade, not a safe no-op.
    expect(codexWireReasoningEffort('persistent')).toBe('xhigh')
    expect(codexWireReasoningEffort('Persistent')).toBe('xhigh')
    expect(codexWireReasoningEffort('ultratask')).toBe('xhigh')
    // Accepted tiers pass through untouched.
    expect(codexWireReasoningEffort('xhigh')).toBe('xhigh')
    expect(codexWireReasoningEffort('high')).toBe('high')
    expect(codexWireReasoningEffort('medium')).toBe('medium')
    expect(codexWireReasoningEffort('minimal')).toBe('minimal')
    expect(codexWireReasoningEffort('OFF')).toBe('none')
    expect(codexWireReasoningEffort('light')).toBe('low')
    expect(codexWireReasoningEffort('extra')).toBe('xhigh')
  })

  it('resolves unset and unknown effort to an explicit renderer-equivalent default', () => {
    // Never omit the wire value: omission would inherit CODEX_HOME/config.toml,
    // which can contain a tier (for example max) that the selected model rejects.
    expect(codexWireReasoningEffort('', 'gpt-5.5')).toBe('medium')
    expect(codexWireReasoningEffort('   ', 'gpt-5.5')).toBe('medium')
    expect(codexWireReasoningEffort(null, 'gpt-5.5')).toBe('medium')
    expect(codexWireReasoningEffort(undefined, 'gpt-5.5')).toBe('medium')
    expect(codexWireReasoningEffort('future-tier', 'gpt-5.5')).toBe('medium')
    expect(codexWireReasoningEffort(undefined, 'gpt-5.6-sol')).toBe('medium')
    expect(codexWireReasoningEffort(undefined, 'future-codex-model')).toBe('medium')
  })

  it('maps every advertised static tier onto the finite accepted wire enum', () => {
    const accepted = new Set<string>(CODEX_WIRE_REASONING_EFFORTS)
    const models = getStaticProviderModels('codex') as StaticModelShape[]
    for (const model of models) {
      expect(accepted.has(codexWireReasoningEffort(undefined, model.id))).toBe(true)
      for (const option of model.supportedReasoningEfforts || []) {
        expect(accepted.has(codexWireReasoningEffort(option.reasoningEffort, model.id))).toBe(true)
      }
    }
  })

  it('clamps above-xhigh tiers regardless of the target model', () => {
    // The enum ceiling is API-wide, so model identity no longer changes the wire
    // value. Regression: a stale 'max' effort leaked onto gpt-5.5 (which never
    // listed 'max') and 400'd the turn — it must clamp to 'xhigh'.
    expect(codexWireReasoningEffort('max', 'gpt-5.5')).toBe('xhigh')
    expect(codexWireReasoningEffort('ultracode', 'gpt-5.6-sol')).toBe('xhigh')
    expect(codexWireReasoningEffort('ultracode', 'gpt-5.6-terra')).toBe('xhigh')
    expect(codexWireReasoningEffort('ultracode', 'preview:openai:gpt-5.6:terra')).toBe('xhigh')
    expect(codexWireReasoningEffort('ultracode', 'gpt-5.6-luna')).toBe('xhigh')
    expect(codexWireReasoningEffort('ultracode', null)).toBe('xhigh')
    expect(codexWireReasoningEffort('xhigh', 'gpt-5.5')).toBe('xhigh')
  })
})

describe('mergeCodexLiveModelRows', () => {
  const staticFallback = getStaticProviderModels('codex') as Array<{
    id: string
    isDefault?: boolean
  }>

  it('returns null for an EMPTY live list so the caller falls back to the full static catalog', () => {
    // An empty/malformed model/list response (transient hiccup, CLI warm-up
    // race, zero-entitled account) must NOT produce an append-rows-only list
    // that drops gpt-5.5 and carries no default.
    expect(mergeCodexLiveModelRows([], staticFallback, { includePreviewAppends: true })).toBeNull()
    expect(mergeCodexLiveModelRows([], staticFallback, { includePreviewAppends: false })).toBeNull()
  })

  it('appends staged and explicitly runnable rows omitted from live discovery', () => {
    const live = [{ id: 'gpt-5.5', isDefault: true }]
    const merged = mergeCodexLiveModelRows(live, staticFallback, {
      includePreviewAppends: false
    })
    expect(merged?.map((model) => model.id)).toEqual([
      'gpt-5.5',
      'gpt-6-astra',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex-spark'
    ])
    // The live row object itself is preserved (not replaced by a static row).
    expect(merged?.[0]).toBe(live[0])
  })

  it("prefers the CLI's own row when the live list already returns a trio id", () => {
    const liveSol = { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol (live)' }
    const merged = mergeCodexLiveModelRows([{ id: 'gpt-5.5' }, liveSol], staticFallback, {
      includePreviewAppends: true
    })
    const solRows = merged?.filter((model) => model.id === 'gpt-5.6-sol')
    expect(solRows).toHaveLength(1)
    expect(solRows?.[0]).toBe(liveSol)
    // Terra + Luna still appended from static.
    expect(merged?.map((model) => model.id)).toEqual(
      expect.arrayContaining(['gpt-5.6-terra', 'gpt-5.6-luna'])
    )
  })

  it('appends nothing extra once live discovery carries every managed row', () => {
    const live = [
      { id: 'gpt-6-astra' },
      { id: 'gpt-5.6-sol' },
      { id: 'gpt-5.6-terra' },
      { id: 'gpt-5.6-luna' },
      { id: 'gpt-5.5', isDefault: true },
      { id: 'gpt-5.4' },
      { id: 'gpt-5.4-mini' },
      { id: 'gpt-5.3-codex-spark' }
    ]
    const merged = mergeCodexLiveModelRows(live, staticFallback, {
      includePreviewAppends: true
    })
    expect(merged).toHaveLength(8)
    expect(merged?.map((model) => model.id)).toEqual([
      'gpt-6-astra',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex-spark'
    ])
  })
})

describe('normalizeCliProviderModel (kimi)', () => {
  it('uses K2.8 Preview as the CLI default and maps legacy aliases to it', () => {
    expect(normalizeCliProviderModel('kimi', '')).toBe('kimi-k2.8-preview')
    expect(normalizeCliProviderModel('kimi', 'cli-default')).toBe('kimi-k2.8-preview')
    expect(normalizeCliProviderModel('kimi', 'kimi-k2.6')).toBe('kimi-k2.8-preview')
    expect(normalizeCliProviderModel('kimi', 'kimi-k2-thinking')).toBe('kimi-k2.8-preview')
    // The retired combined row. Its standard tier IS today's K2.8 route, so a
    // seat pinned to it keeps dispatching exactly what it always dispatched.
    expect(normalizeCliProviderModel('kimi', 'kimi-k2.7-code')).toBe('kimi-k2.8-preview')
  })

  it('resolves K3 ids to the canonical row instead of the default', () => {
    expect(normalizeCliProviderModel('kimi', 'kimi-k3')).toBe('kimi-k3')
    expect(normalizeCliProviderModel('kimi', 'k3')).toBe('kimi-k3')
    expect(normalizeCliProviderModel('kimi', KIMI_K3_CLI_MODEL)).toBe('kimi-k3')
    expect(normalizeCliProviderModel('kimi', 'kimi-k3-256k')).toBe('kimi-k3-256k')
    expect(normalizeCliProviderModel('kimi', 'k3-256k')).toBe('kimi-k3-256k')
    expect(normalizeCliProviderModel('kimi', KIMI_K3_256K_CLI_MODEL)).toBe('kimi-k3-256k')
  })

  it('resolves both managed upstream spellings onto their own picker rows', () => {
    // Highspeed has been a row rather than a speed tier since 2026-09-11, so an
    // upstream spelling must land on that row; leaving it to pass through gave
    // a selected model id with no row behind it.
    expect(normalizeCliProviderModel('kimi', KIMI_STANDARD_CLI_MODEL)).toBe('kimi-k2.8-preview')
    expect(normalizeCliProviderModel('kimi', KIMI_HIGHSPEED_CLI_MODEL)).toBe(
      'kimi-k2.7-code-highspeed'
    )
  })

  it('maps raw Kimi Code API ids onto their picker rows', () => {
    expect(normalizeCliProviderModel('kimi', 'kimi-for-coding')).toBe('kimi-k2.8-preview')
    expect(normalizeCliProviderModel('kimi', 'kimi-for-coding-highspeed')).toBe(
      'kimi-k2.7-code-highspeed'
    )
  })

  it('dispatches each managed route by its own row, ignoring a stale speed tier', () => {
    const k28Args: string[] = []
    const k28StaleFastArgs: string[] = []
    const highSpeedArgs: string[] = []

    appendKimiModelArgs(k28Args, 'kimi-k2.8-preview', 'standard')
    // The Fast toggle retired with the split. A seat still carrying the flag
    // must not be re-routed off the row its picker is showing.
    appendKimiModelArgs(k28StaleFastArgs, 'kimi-k2.8-preview', 'fast')
    appendKimiModelArgs(highSpeedArgs, 'kimi-k2.7-code-highspeed', 'standard')

    expect(k28Args).toEqual(['--model', 'kimi-code/kimi-for-coding'])
    expect(k28StaleFastArgs).toEqual(['--model', 'kimi-code/kimi-for-coding'])
    expect(highSpeedArgs).toEqual(['--model', 'kimi-code/kimi-for-coding-highspeed'])
    expect(kimiAcpModelConfigValue('kimi-k2.8-preview')).toBe('kimi-code/kimi-for-coding')
    expect(kimiAcpModelConfigValue('kimi-k2.7-code-highspeed')).toBe(
      'kimi-code/kimi-for-coding-highspeed'
    )
  })

  it('maps both K3 routes to their managed CLI aliases and ignores stale speed tiers', () => {
    const plainArgs: string[] = []
    const staleFastArgs: string[] = []
    const rawApiArgs: string[] = []
    const shortArgs: string[] = []
    const shortStaleFastArgs: string[] = []

    appendKimiModelArgs(plainArgs, 'kimi-k3')
    // K3 has no speed tiers — a stale/queued Fast flag must not reroute the
    // run onto the K2.7 HighSpeed alias.
    appendKimiModelArgs(staleFastArgs, 'kimi-k3', 'fast')
    appendKimiModelArgs(rawApiArgs, 'k3')
    appendKimiModelArgs(shortArgs, 'kimi-k3-256k')
    appendKimiModelArgs(shortStaleFastArgs, 'k3-256k', 'fast')

    expect(plainArgs).toEqual(['--model', KIMI_K3_CLI_MODEL])
    expect(staleFastArgs).toEqual(['--model', KIMI_K3_CLI_MODEL])
    expect(rawApiArgs).toEqual(['--model', KIMI_K3_CLI_MODEL])
    expect(shortArgs).toEqual(['--model', KIMI_K3_256K_CLI_MODEL])
    expect(shortStaleFastArgs).toEqual(['--model', KIMI_K3_256K_CLI_MODEL])
    expect(kimiAcpModelConfigValue('kimi-k3-256k')).toBe(KIMI_K3_256K_CLI_MODEL)
  })
})

describe('getStaticProviderModels (kimi)', () => {
  it('leads with K2.8 Preview and gives Highspeed its own row, not a Fast tier', () => {
    const models = getStaticProviderModels('kimi') as StaticModelShape[]

    expect(models).toHaveLength(4)
    expect(models[0]).toMatchObject({
      id: 'kimi-k2.8-preview',
      label: 'K2.8 Preview',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low' },
        { reasoningEffort: 'high' },
        { reasoningEffort: 'max' }
      ],
      defaultReasoningEffort: 'max'
    })
    expect(models[1]).toMatchObject({
      id: 'kimi-k2.7-code-highspeed',
      label: 'K2.7 Code Highspeed',
      supportedReasoningEfforts: [{ reasoningEffort: 'on' }],
      defaultReasoningEffort: 'on'
    })
    // No Kimi row carries a speed tier any more: a Fast toggle beside an
    // explicit Highspeed row would silently re-route the selected model.
    expect(models).not.toHaveLength(0)
    for (const model of models) {
      expect(model.additionalSpeedTiers).toBeUndefined()
    }
  })

  it('lists both K3 routes with Low, High, and Max thinking but no speed tiers', () => {
    const models = getStaticProviderModels('kimi') as StaticModelShape[]
    const k3 = models.find((model) => model.id === 'kimi-k3')
    const k3Short = models.find((model) => model.id === 'kimi-k3-256k')

    expect(k3).toMatchObject({
      id: 'kimi-k3',
      label: 'K3 (1M)',
      defaultReasoningEffort: 'max',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low' },
        { reasoningEffort: 'high' },
        { reasoningEffort: 'max' }
      ]
    })
    expect(k3?.isDefault).toBeUndefined()
    expect(k3?.additionalSpeedTiers).toBeUndefined()
    expect(k3?.description).toContain('256K on Moderato, up to 1M on Allegretto+')
    expect(k3Short).toMatchObject({
      id: 'kimi-k3-256k',
      label: 'K3 (256K)',
      defaultReasoningEffort: 'max',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low' },
        { reasoningEffort: 'high' },
        { reasoningEffort: 'max' }
      ]
    })
    expect(k3Short?.additionalSpeedTiers).toBeUndefined()
    expect(models[0]?.isDefault).toBe(true)
  })

  it('normalizes effort on every laddered route and only fixes Highspeed', () => {
    expect(normalizeKimiReasoningEffort('kimi-k3', 'low')).toBe('low')
    expect(normalizeKimiReasoningEffort('kimi-k3', 'off')).toBe('max')
    expect(normalizeKimiReasoningEffort('kimi-k3-256k', 'high')).toBe('high')
    expect(normalizeKimiReasoningEffort('k3-256k', 'off')).toBe('max')
    // K2.8 took K3's axis with it. Keyed on "is K3" this returned null and the
    // dispatch fell back to a fixed `thinking: on` under a live effort slider.
    expect(normalizeKimiReasoningEffort('kimi-k2.8-preview', 'low')).toBe('low')
    expect(normalizeKimiReasoningEffort('kimi-k2.7-code', 'high')).toBe('high')
    expect(normalizeKimiReasoningEffort('kimi-k2.7-code-highspeed', 'high')).toBeNull()
    expect(kimiAcpThinkingConfigValue('kimi-k3', 'high')).toBe('high')
    expect(kimiAcpThinkingConfigValue('kimi-k3-256k', 'low')).toBe('low')
    expect(kimiAcpThinkingConfigValue('kimi-k2.8-preview', 'low')).toBe('low')
    expect(kimiAcpThinkingConfigValue('kimi-k2.7-code-highspeed', 'off')).toBe('on')
  })
})

describe('getStaticProviderModels (claude)', () => {
  const models = getStaticProviderModels('claude') as StaticModelShape[]
  const byId = new Map(models.map((m) => [m.id, m]))

  it('hides Claude preview placeholders unless explicitly requested', () => {
    const ids = models.map((m) => m.id)
    expect(ids).not.toContain('default')
    expect(ids).toContain('claude-fable-5-1')
    expect(ids).toContain('claude-fable-5')
    expect(ids).not.toContain('claude-mythos-5')
    expect(ids).not.toContain('claude-fable-5-1m')
    expect(ids).not.toContain('preview:anthropic:claude-sonnet-5')
    expect(ids).not.toContain('preview:anthropic:claude-fable-5')
    expect(ids).not.toContain('preview:anthropic:claude-mythos-5')
    expect(ids).not.toContain('claude-opus-4-8')
    expect(ids).toContain('claude-opus-4-8-1m')
    // Opus 5 is 1M by default — the base id is the picker row.
    expect(ids).toContain('claude-opus-5')
    expect(ids).not.toContain('claude-opus-5-1m')
    // Sonnet 5 and Fable 5 are selectable rows; Mythos 5 stays runnable as a
    // historical/tombstoned model but is no longer offered in pickers.
    expect(ids).toContain('claude-sonnet-5')
  })

  it('keeps retired Claude preview placeholders out behind the preview catalog flag', () => {
    const previewModels = getStaticProviderModels('claude', {
      includePreviewModels: true
    }) as StaticModelShape[]
    const previewById = new Map(previewModels.map((m) => [m.id, m]))
    expect(previewById.get('preview:anthropic:claude-sonnet-5')).toBeUndefined()
    expect(previewById.get('preview:anthropic:claude-fable-5')).toBeUndefined()
    expect(previewById.get('preview:anthropic:claude-mythos-5')).toBeUndefined()
    expect(previewById.get('claude-fable-5')?.disabled).toBeFalsy()
    expect(previewById.get('claude-mythos-5')).toBeUndefined()
  })

  it('marks Claude Sonnet 5 as the default and keeps Sonnet 4.6 Legacy selectable', () => {
    expect(byId.get('claude-sonnet-5')).toMatchObject({
      isDefault: true,
      description: '1M context window — extended thinking'
    })
    expect(byId.get('claude-sonnet-4-6')).toMatchObject({
      // Prefix-free label: the picker's CLAUDE header / chip provider span
      // already carries "Claude".
      label: 'Sonnet 4.6 Legacy',
      description: '200K context window — legacy Sonnet'
    })
  })

  it('offers Fable 5.1 as the current Fable row and relabels Fable 5 as Legacy', () => {
    expect(byId.get('claude-fable-5-1')).toMatchObject({
      label: 'Fable 5.1',
      description: '1M context window — adaptive thinking'
    })
    expect(byId.get('claude-fable-5')).toMatchObject({
      label: 'Fable 5 Legacy',
      description: '1M context window — legacy Fable'
    })
    // Current models first, then the Legacy cluster — Fable 5 leads it.
    expect(models.map((m) => m.id)).toEqual([
      'claude-opus-5',
      'claude-fable-5-1',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-sonnet-4-6',
      'claude-opus-4-8-1m',
      'claude-opus-4-7-1m',
      'claude-haiku-4-5',
      'custom'
    ])
  })

  it('keeps the paid Fast tier on supported Opus rows but not Fable 5', () => {
    expect(byId.get('claude-opus-5')?.additionalSpeedTiers).toContain('fast')
    expect(byId.get('claude-opus-4-8-1m')?.additionalSpeedTiers).toContain('fast')
    expect(byId.get('claude-opus-4-7-1m')?.additionalSpeedTiers).toContain('fast')
    expect(byId.get('claude-fable-5')?.additionalSpeedTiers ?? []).not.toContain('fast')
    expect(byId.get('claude-fable-5-1')?.additionalSpeedTiers ?? []).not.toContain('fast')
  })

  it('offers family-specific Claude reasoning efforts', () => {
    const sonnetReasoning = byId.get('claude-sonnet-5')?.supportedReasoningEfforts ?? []
    const legacySonnetReasoning = byId.get('claude-sonnet-4-6')?.supportedReasoningEfforts ?? []
    const opusReasoning = byId.get('claude-opus-4-8-1m')?.supportedReasoningEfforts ?? []
    const fableReasoning = byId.get('claude-fable-5')?.supportedReasoningEfforts ?? []
    const haikuReasoning = byId.get('claude-haiku-4-5')?.supportedReasoningEfforts ?? []
    expect(sonnetReasoning.map((e) => e.reasoningEffort)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode'
    ])
    // Sonnet 5 unlocks the full Opus ladder — none of its efforts are disabled.
    expect(sonnetReasoning.filter((e) => e.disabled).map((e) => e.reasoningEffort)).toEqual([])
    expect(legacySonnetReasoning.filter((e) => e.disabled).map((e) => e.reasoningEffort)).toEqual([
      'xhigh',
      'ultracode'
    ])
    expect(opusReasoning.map((e) => e.reasoningEffort)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode'
    ])
    expect(opusReasoning.every((e) => !e.disabled)).toBe(true)
    expect(fableReasoning.every((e) => !e.disabled)).toBe(true)
    expect(haikuReasoning.map((e) => e.reasoningEffort)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode'
    ])
    expect(haikuReasoning.every((e) => e.disabled)).toBe(true)
  })
})
