import { describe, it, expect } from 'vitest'
import {
  CODEX_STAGED_ROLLOUT_MODEL_IDS,
  codexReasoningEffortsForModel,
  codexModelContextConfig,
  codexWireReasoningEffort,
  claudeModelSupportsFastMode,
  appendKimiModelArgs,
  getStaticProviderModels,
  KIMI_HIGHSPEED_CLI_MODEL,
  KIMI_STANDARD_CLI_MODEL,
  mergeCodexLiveModelRows,
  normalizeCliProviderModel
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

describe('normalizeCliProviderModel (claude)', () => {
  it('strips the TaskWraith-internal -1m marker so the CLI gets the base model id', () => {
    // The 1M window is entitlement-based on the base id.
    expect(normalizeCliProviderModel('claude', 'claude-opus-4-8-1m')).toBe('claude-opus-4-8')
    expect(normalizeCliProviderModel('claude', 'claude-opus-4-7-1m')).toBe('claude-opus-4-7')
  })

  it('passes through base claude ids and bare family aliases unchanged', () => {
    expect(normalizeCliProviderModel('claude', 'claude-opus-4-8')).toBe('claude-opus-4-8')
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
    expect(claudeModelSupportsFastMode('claude-opus-4-8-1m')).toBe(true)
    expect(claudeModelSupportsFastMode('claude-opus-4-7')).toBe(true)
    expect(claudeModelSupportsFastMode('claude-fable-5')).toBe(false)
    expect(claudeModelSupportsFastMode('claude-fable-5-1m')).toBe(false)
  })
})

interface StaticModelShape {
  id: string
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

  it('returns distinct model lists for gemini, grok, and cursor', () => {
    const gemini = getStaticProviderModels('gemini').map((m) => m.id)
    const grok = getStaticProviderModels('grok').map((m) => m.id)
    const cursor = getStaticProviderModels('cursor').map((m) => m.id)
    expect(gemini).toContain('flash')
    expect(grok).toEqual(['grok-4.5', 'grok-composer-2.5-fast'])
    expect(cursor).toEqual(['composer-2.5-fast', 'composer-2.5', 'grok-4.5'])
  })

  it('normalizes invalid cross-provider model ids back to provider defaults', () => {
    expect(normalizeCliProviderModel('grok', 'flash')).toBe('grok-4.5')
    expect(normalizeCliProviderModel('cursor', 'pro')).toBe('composer-2.5-fast')
    expect(normalizeCliProviderModel('gemini', 'flash')).toBe('flash')
    expect(normalizeCliProviderModel('gemini', 'cli-default')).toBe('flash-lite')
  })

  it('uses Grok 4.5 as the default while keeping Grok Composer selectable', () => {
    expect(normalizeCliProviderModel('grok', undefined)).toBe('grok-4.5')
    expect(normalizeCliProviderModel('grok', 'cli-default')).toBe('grok-4.5')
    expect(normalizeCliProviderModel('grok', 'grok-composer-2.5-fast')).toBe(
      'grok-composer-2.5-fast'
    )
    expect(normalizeCliProviderModel('grok', 'composer-2.5-fast')).toBe('grok-4.5')
    expect(normalizeCliProviderModel('grok', 'grok-build')).toBe('grok-4.5')
    expect(normalizeCliProviderModel('cursor', 'grok-4.5-fast-xhigh')).toBe('grok-4.5')
  })

  it('exposes the curated optional Ollama model tags', () => {
    const ollama = getStaticProviderModels('ollama').map((m) => m.id)
    expect(ollama).toEqual([
      'qwen3:4b-instruct',
      'qwen3.5:9b',
      'qwen3.6:35b',
      'gemma4:12b',
      'ornith:9b',
      'ornith:35b',
      'laguna-xs-2.1:q8_0',
      'gpt-oss:20b',
      'minicpm-v4.5:8b',
      'granite4.1:3b',
      'granite4.1:30b',
      'nemotron3:33b',
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
    expect(codexWireReasoningEffort('')).toBeUndefined()
    expect(codexWireReasoningEffort(null)).toBeUndefined()
    expect(codexWireReasoningEffort(undefined)).toBeUndefined()
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

  it('appends the staged-rollout trio when the live list omits them (preview flag OFF too)', () => {
    const live = [{ id: 'gpt-5.5', isDefault: true }]
    const merged = mergeCodexLiveModelRows(live, staticFallback, {
      includePreviewAppends: false
    })
    expect(merged?.map((model) => model.id)).toEqual([
      'gpt-5.5',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna'
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

  it('appends nothing extra once the live list carries the whole trio', () => {
    const live = [
      { id: 'gpt-5.6-sol' },
      { id: 'gpt-5.6-terra' },
      { id: 'gpt-5.6-luna' },
      { id: 'gpt-5.5', isDefault: true }
    ]
    const merged = mergeCodexLiveModelRows(live, staticFallback, {
      includePreviewAppends: true
    })
    expect(merged).toHaveLength(4)
    expect(merged?.map((model) => model.id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5'
    ])
  })
})

describe('normalizeCliProviderModel (kimi)', () => {
  it('uses Kimi K2.7 Code as the CLI default and maps legacy aliases to it', () => {
    expect(normalizeCliProviderModel('kimi', '')).toBe('kimi-k2.7-code')
    expect(normalizeCliProviderModel('kimi', 'cli-default')).toBe('kimi-k2.7-code')
    expect(normalizeCliProviderModel('kimi', 'kimi-k2.6')).toBe('kimi-k2.7-code')
    expect(normalizeCliProviderModel('kimi', 'kimi-k2-thinking')).toBe('kimi-k2.7-code')
  })

  it('preserves the stable Kimi Code Standard and HighSpeed route ids', () => {
    expect(normalizeCliProviderModel('kimi', KIMI_STANDARD_CLI_MODEL)).toBe(
      KIMI_STANDARD_CLI_MODEL
    )
    expect(normalizeCliProviderModel('kimi', KIMI_HIGHSPEED_CLI_MODEL)).toBe(
      KIMI_HIGHSPEED_CLI_MODEL
    )
  })

  it('routes K2.7 Code Fast mode to the exact Kimi CLI model id', () => {
    const standardArgs: string[] = []
    const highSpeedArgs: string[] = []

    appendKimiModelArgs(standardArgs, 'kimi-k2.7-code', 'standard')
    appendKimiModelArgs(highSpeedArgs, 'kimi-k2.7-code', 'fast')

    expect(standardArgs).toEqual(['--model', KIMI_STANDARD_CLI_MODEL])
    expect(highSpeedArgs).toEqual(['--model', KIMI_HIGHSPEED_CLI_MODEL])
  })
})

describe('getStaticProviderModels (kimi)', () => {
  it('advertises K2.7 Code as Fast-capable without adding a duplicate model row', () => {
    const models = getStaticProviderModels('kimi') as StaticModelShape[]

    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
      id: 'kimi-k2.7-code',
      additionalSpeedTiers: ['fast']
    })
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
      label: 'Claude Sonnet 4.6 Legacy',
      description: '200K context window — legacy Sonnet'
    })
  })

  it('keeps the paid Fast tier on supported Opus rows but not Fable 5', () => {
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
