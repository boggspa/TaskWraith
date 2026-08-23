import { describe, it, expect } from 'vitest'
import {
  CODEX_EXPLICITLY_RUNNABLE_MODEL_IDS,
  CODEX_STAGED_ROLLOUT_MODEL_IDS,
  CODEX_WIRE_REASONING_EFFORTS,
  codexReasoningEffortsForModel,
  codexModelContextConfig,
  codexWireReasoningEffort,
  claudeModelSupportsFastMode,
  appendKimiModelArgs,
  kimiAcpModelConfigValue,
  kimiAcpThinkingConfigValue,
  getStaticProviderModels,
  KIMI_HIGHSPEED_CLI_MODEL,
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

describe('codexModelContextConfig', () => {
  const longContextConfig = {
    model_context_window: 1_050_000,
    model_auto_compact_token_limit: 850_000
  }

  it('returns the explicit 1M config for long-context Codex models', () => {
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

describe('getStaticProviderModels (Pi lifecycle)', () => {
  it('warns before Cerebras GLM-4.7 retires and removes it on the date', () => {
    const before = getStaticProviderModels('pi', {
      now: new Date(2026, 7, 16, 23, 59)
    })
    expect(before.find((model) => model.id === 'cerebras/zai-glm-4.7')).toMatchObject({
      label: 'GLM-4.7 (Cerebras)',
      retiresAt: '2026-08-17'
    })

    const retired = getStaticProviderModels('pi', {
      now: new Date(2026, 7, 17, 0, 0)
    })
    expect(retired.some((model) => model.id === 'cerebras/zai-glm-4.7')).toBe(false)
    expect(retired.some((model) => model.id === 'zai/glm-4.7')).toBe(true)
    expect(retired.some((model) => model.id === 'cerebras/gpt-oss-120b')).toBe(true)
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
    expect(normalizeCliProviderModel('claude', 'fable')).toBe('claude-fable-5')
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
    expect(cursor).toEqual(['composer-2.5-fast', 'composer-2.5', 'grok-4.6', 'grok-4.5'])
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
    expect(cursor.find((model) => model.id === 'grok-4.5')).toMatchObject({
      label: 'Cursor Grok 4.5'
    })
  })

  it('normalizes invalid cross-provider model ids back to provider defaults', () => {
    expect(normalizeCliProviderModel('grok', 'flash')).toBe('grok-4.6')
    expect(normalizeCliProviderModel('cursor', 'pro')).toBe('composer-2.5-fast')
    expect(normalizeCliProviderModel('gemini', 'flash')).toBe('flash')
    expect(normalizeCliProviderModel('gemini', 'cli-default')).toBe('flash-lite')
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
    expect(normalizeCliProviderModel('cursor', 'grok-4.5-fast-xhigh')).toBe('grok-4.5')
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
      'nemotron-3-nano:4b',
      'nemotron3:33b',
      'nemotron-3.5-lightning:30b-mlx',
      'devstral-small-2:24b',
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
    expect(ids.slice(0, 3)).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])
    expect(ids.indexOf('gpt-5.6-sol')).toBeLessThan(ids.indexOf('gpt-5.5'))
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

  it("clamps above-xhigh tiers to 'xhigh' for the Codex wire (API enum ceiling)", () => {
    // The reasoning.effort enum is {none,minimal,low,medium,high,xhigh}; the API
    // 400s on 'max'/'ultra'/'ultracode' ("Codex failed · exit 1"), so each
    // clamps to 'xhigh' — the deepest reasoning the wire accepts.
    expect(codexWireReasoningEffort('ultracode')).toBe('xhigh')
    expect(codexWireReasoningEffort('Ultracode')).toBe('xhigh')
    expect(codexWireReasoningEffort('ultra')).toBe('xhigh')
    expect(codexWireReasoningEffort('max')).toBe('xhigh')
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
    expect(merged).toHaveLength(7)
    expect(merged?.map((model) => model.id)).toEqual([
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
  it('uses K2.7 Coding as the CLI default and maps legacy aliases to it', () => {
    expect(normalizeCliProviderModel('kimi', '')).toBe('kimi-k2.7-code')
    expect(normalizeCliProviderModel('kimi', 'cli-default')).toBe('kimi-k2.7-code')
    expect(normalizeCliProviderModel('kimi', 'kimi-k2.6')).toBe('kimi-k2.7-code')
    expect(normalizeCliProviderModel('kimi', 'kimi-k2-thinking')).toBe('kimi-k2.7-code')
  })

  it('resolves K3 ids to the canonical row instead of the default', () => {
    expect(normalizeCliProviderModel('kimi', 'kimi-k3')).toBe('kimi-k3')
    expect(normalizeCliProviderModel('kimi', 'k3')).toBe('kimi-k3')
    expect(normalizeCliProviderModel('kimi', KIMI_K3_CLI_MODEL)).toBe('kimi-k3')
  })

  it('preserves the managed Kimi CLI Standard and HighSpeed aliases', () => {
    expect(normalizeCliProviderModel('kimi', KIMI_STANDARD_CLI_MODEL)).toBe(
      KIMI_STANDARD_CLI_MODEL
    )
    expect(normalizeCliProviderModel('kimi', KIMI_HIGHSPEED_CLI_MODEL)).toBe(
      KIMI_HIGHSPEED_CLI_MODEL
    )
  })

  it('maps raw Kimi Code API ids onto the managed CLI aliases', () => {
    expect(normalizeCliProviderModel('kimi', 'kimi-for-coding')).toBe(
      KIMI_STANDARD_CLI_MODEL
    )
    expect(normalizeCliProviderModel('kimi', 'kimi-for-coding-highspeed')).toBe(
      KIMI_HIGHSPEED_CLI_MODEL
    )
  })

  it('routes K2.7 Coding Fast mode to the exact managed Kimi CLI alias', () => {
    const standardArgs: string[] = []
    const highSpeedArgs: string[] = []

    appendKimiModelArgs(standardArgs, 'kimi-k2.7-code', 'standard')
    appendKimiModelArgs(highSpeedArgs, 'kimi-k2.7-code', 'fast')

    expect(standardArgs).toEqual(['--model', 'kimi-code/kimi-for-coding'])
    expect(highSpeedArgs).toEqual(['--model', 'kimi-code/kimi-for-coding-highspeed'])
    expect(kimiAcpModelConfigValue('kimi-k2.7-code')).toBe('kimi-code/kimi-for-coding')
    expect(kimiAcpModelConfigValue('kimi-k2.7-code', 'fast')).toBe(
      'kimi-code/kimi-for-coding-highspeed'
    )
  })

  it('maps K3 to its managed CLI alias and ignores stale speed tiers', () => {
    const plainArgs: string[] = []
    const staleFastArgs: string[] = []
    const rawApiArgs: string[] = []

    appendKimiModelArgs(plainArgs, 'kimi-k3')
    // K3 has no speed tiers — a stale/queued Fast flag must not reroute the
    // run onto the K2.7 HighSpeed alias.
    appendKimiModelArgs(staleFastArgs, 'kimi-k3', 'fast')
    appendKimiModelArgs(rawApiArgs, 'k3')

    expect(plainArgs).toEqual(['--model', KIMI_K3_CLI_MODEL])
    expect(staleFastArgs).toEqual(['--model', KIMI_K3_CLI_MODEL])
    expect(rawApiArgs).toEqual(['--model', KIMI_K3_CLI_MODEL])
  })
})

describe('getStaticProviderModels (kimi)', () => {
  it('advertises K2.7 Coding as Fast-capable without adding a duplicate model row', () => {
    const models = getStaticProviderModels('kimi') as StaticModelShape[]

    expect(models).toHaveLength(2)
    expect(models[0]).toMatchObject({
      id: 'kimi-k2.7-code',
      label: 'K2.7 Coding',
      supportedReasoningEfforts: [{ reasoningEffort: 'on' }],
      defaultReasoningEffort: 'on',
      additionalSpeedTiers: ['fast']
    })
  })

  it('lists K3 with Low, High, and Max thinking but no speed tiers', () => {
    const models = getStaticProviderModels('kimi') as StaticModelShape[]
    const k3 = models.find((model) => model.id === 'kimi-k3')

    expect(k3).toMatchObject({
      id: 'kimi-k3',
      label: 'K3',
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
    expect(models[0]?.isDefault).toBe(true)
  })

  it('normalizes K3 effort and keeps K2.7 Coding on its fixed thinking setting', () => {
    expect(normalizeKimiReasoningEffort('kimi-k3', 'low')).toBe('low')
    expect(normalizeKimiReasoningEffort('kimi-k3', 'off')).toBe('max')
    expect(normalizeKimiReasoningEffort('kimi-k2.7-code', 'high')).toBeNull()
    expect(kimiAcpThinkingConfigValue('kimi-k3', 'high')).toBe('high')
    expect(kimiAcpThinkingConfigValue('kimi-k2.7-code', 'off')).toBe('on')
  })
})

describe('getStaticProviderModels (claude)', () => {
  const models = getStaticProviderModels('claude') as StaticModelShape[]
  const byId = new Map(models.map((m) => [m.id, m]))

  it('hides Claude preview placeholders unless explicitly requested', () => {
    const ids = models.map((m) => m.id)
    expect(ids).not.toContain('default')
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

  it('keeps the paid Fast tier on supported Opus rows but not Fable 5', () => {
    expect(byId.get('claude-opus-5')?.additionalSpeedTiers).toContain('fast')
    expect(byId.get('claude-opus-4-8-1m')?.additionalSpeedTiers).toContain('fast')
    expect(byId.get('claude-opus-4-7-1m')?.additionalSpeedTiers).toContain('fast')
    expect(byId.get('claude-fable-5')?.additionalSpeedTiers ?? []).not.toContain('fast')
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
