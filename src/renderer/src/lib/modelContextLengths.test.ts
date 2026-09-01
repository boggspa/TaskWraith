import { describe, expect, it } from 'vitest'
import { buildModelContextLengthGroups } from './modelContextLengths'
import { MODEL_USAGE_PROVIDER_ORDER } from './modelUsageTable'

describe('buildModelContextLengthGroups', () => {
  it('claude group contains a row for claude-opus-4-8-1m with formatted 1.0M', () => {
    const groups = buildModelContextLengthGroups()
    const claudeGroup = groups.find((g) => g.provider === 'claude')
    expect(claudeGroup).toBeDefined()
    const row = claudeGroup!.models.find((m) => m.modelId === 'claude-opus-4-8-1m')
    expect(row).toBeDefined()
    expect(row!.contextWindow).toBe(1_000_000)
    expect(row!.formatted).toBe('1.0M')
  })

  it('claude group includes Sonnet 5 at 1.0M and Sonnet 4.6 Legacy at 200k', () => {
    const groups = buildModelContextLengthGroups()
    const claudeGroup = groups.find((g) => g.provider === 'claude')
    expect(claudeGroup).toBeDefined()
    const sonnet5 = claudeGroup!.models.find((m) => m.modelId === 'claude-sonnet-5')
    const legacySonnet = claudeGroup!.models.find((m) => m.modelId === 'claude-sonnet-4-6')
    expect(sonnet5).toMatchObject({
      label: 'Sonnet 5',
      contextWindow: 1_000_000,
      formatted: '1.0M'
    })
    expect(legacySonnet).toMatchObject({
      label: 'Sonnet 4.6 Legacy',
      contextWindow: 200_000,
      formatted: '200k'
    })
  })

  it('claude group omits non-1M Opus rows from the default catalog', () => {
    const groups = buildModelContextLengthGroups()
    const claudeGroup = groups.find((g) => g.provider === 'claude')
    expect(claudeGroup).toBeDefined()
    const ids = claudeGroup!.models.map((m) => m.modelId)
    expect(ids).not.toContain('claude-opus-4-8')
    expect(ids).not.toContain('claude-opus-4-7')
    expect(ids).not.toContain('claude-opus-4-6')
    // Opus 5 is 1M on its base id, so it IS a picker row.
    const opus5 = claudeGroup!.models.find((m) => m.modelId === 'claude-opus-5')
    expect(opus5).toMatchObject({
      label: 'Opus 5',
      contextWindow: 1_000_000,
      formatted: '1.0M'
    })
  })

  it('codex gpt-5.5 resolves to 1.1M (1_050_000)', () => {
    const groups = buildModelContextLengthGroups()
    const codexGroup = groups.find((g) => g.provider === 'codex')
    expect(codexGroup).toBeDefined()
    const row = codexGroup!.models.find((m) => m.modelId === 'gpt-5.5')
    expect(row).toBeDefined()
    expect(row!.contextWindow).toBe(1_050_000)
    expect(row!.formatted).toBe('1.1M')
  })

  it('codex gpt-5.4-mini resolves to 400k', () => {
    const groups = buildModelContextLengthGroups()
    const codexGroup = groups.find((g) => g.provider === 'codex')
    expect(codexGroup).toBeDefined()
    const row = codexGroup!.models.find((m) => m.modelId === 'gpt-5.4-mini')
    expect(row).toBeDefined()
    expect(row!.contextWindow).toBe(400_000)
    expect(row!.formatted).toBe('400k')
  })

  it('cursor composer-2.5 resolves via provider fallback to contextWindow 200000 / formatted 200k', () => {
    const groups = buildModelContextLengthGroups()
    const cursorGroup = groups.find((g) => g.provider === 'cursor')
    expect(cursorGroup).toBeDefined()
    const row = cursorGroup!.models.find((m) => m.modelId === 'composer-2.5')
    expect(row).toBeDefined()
    // composer-2.5 has no entry in CONTEXT_WINDOWS_BY_MODEL, so it falls back to
    // the cursor provider fallback of 200_000 — proving resolveContextWindow is used.
    expect(row!.contextWindow).toBe(200_000)
    expect(row!.formatted).toBe('200k')
  })

  it('kimi kimi-k2.7-code resolves to 256k', () => {
    const groups = buildModelContextLengthGroups()
    const kimiGroup = groups.find((g) => g.provider === 'kimi')
    expect(kimiGroup).toBeDefined()
    const row = kimiGroup!.models.find((m) => m.modelId === 'kimi-k2.7-code')
    expect(row).toBeDefined()
    expect(row!.contextWindow).toBe(262_144)
    expect(row!.formatted).toBe('256k')
  })

  it('shows the long-context K3 route as an official fixed 1.0M window', () => {
    // Since the K3 split (d19931eb8) each route is a concrete catalog row, so
    // the old plan-dependent '256k–1.0M' range display is retired: 'kimi-k3'
    // IS the 1M route (f661ac2a1 moved its official window to 1_048_576).
    const groups = buildModelContextLengthGroups()
    const row = groups
      .find((group) => group.provider === 'kimi')
      ?.models.find((model) => model.modelId === 'kimi-k3')

    expect(row).toMatchObject({
      contextWindow: 1_048_576,
      formatted: '1.0M'
    })
    expect(row && 'maxContextWindow' in row).toBe(false)
  })

  it('shows the quota-efficient K3 route as an exact fixed 256k window', () => {
    const groups = buildModelContextLengthGroups()
    const row = groups
      .find((group) => group.provider === 'kimi')
      ?.models.find((model) => model.modelId === 'kimi-k3-256k')

    expect(row).toMatchObject({
      contextWindow: 262_144,
      formatted: '256k'
    })
  })

  it('gemini flash-lite resolves to 200k', () => {
    const groups = buildModelContextLengthGroups()
    const geminiGroup = groups.find((g) => g.provider === 'gemini')
    expect(geminiGroup).toBeDefined()
    const row = geminiGroup!.models.find((m) => m.modelId === 'flash-lite')
    expect(row).toBeDefined()
    expect(row!.contextWindow).toBe(200_000)
    expect(row!.formatted).toBe('200k')
  })

  it('gemini pro resolves to 1.0M (1_048_576)', () => {
    const groups = buildModelContextLengthGroups()
    const geminiGroup = groups.find((g) => g.provider === 'gemini')
    expect(geminiGroup).toBeDefined()
    const row = geminiGroup!.models.find((m) => m.modelId === 'pro')
    expect(row).toBeDefined()
    expect(row!.contextWindow).toBe(1_048_576)
    expect(row!.formatted).toBe('1.0M')
  })

  it("excludes the gemini 'auto' router alias (not a concrete model) while keeping real models", () => {
    const groups = buildModelContextLengthGroups()
    const geminiGroup = groups.find((g) => g.provider === 'gemini')
    expect(geminiGroup).toBeDefined()
    const ids = geminiGroup!.models.map((m) => m.modelId)
    expect(ids).not.toContain('auto')
    // The real Gemini models still render.
    expect(ids).toEqual(expect.arrayContaining(['pro', 'flash', 'flash-lite']))
  })

  it('default (no opts): provider order equals MODEL_USAGE_PROVIDER_ORDER and no ollama group', () => {
    const groups = buildModelContextLengthGroups()
    const providerIds = groups.map((g) => g.provider)
    // Every group's provider should appear in MODEL_USAGE_PROVIDER_ORDER order.
    const filteredOrder = MODEL_USAGE_PROVIDER_ORDER.filter((p) => providerIds.includes(p))
    expect(providerIds).toEqual(filteredOrder)
    // No ollama by default.
    expect(providerIds).not.toContain('ollama')
  })

  it('{ includeOllama: true }: an ollama group IS present and appears last', () => {
    const groups = buildModelContextLengthGroups({ includeOllama: true })
    const providerIds = groups.map((g) => g.provider)
    expect(providerIds).toContain('ollama')
    expect(providerIds[providerIds.length - 1]).toBe('ollama')
  })

  it('ollama group carries real model windows (qwen3:4b-instruct → 262k)', () => {
    const groups = buildModelContextLengthGroups({ includeOllama: true })
    const ollamaGroup = groups.find((g) => g.provider === 'ollama')
    expect(ollamaGroup).toBeDefined()
    const row = ollamaGroup!.models.find((m) => m.modelId === 'qwen3:4b-instruct')
    expect(row).toBeDefined()
    expect(row!.contextWindow).toBe(262_144)
    expect(row!.formatted).toBe('262k')
  })

  it('ollama group carries the Liquid LFM 2.5 128K window', () => {
    const groups = buildModelContextLengthGroups({ includeOllama: true })
    const ollamaGroup = groups.find((g) => g.provider === 'ollama')
    expect(ollamaGroup).toBeDefined()
    const row = ollamaGroup!.models.find((m) => m.modelId === 'lfm2.5:8b')
    expect(row).toBeDefined()
    // The test NAME already said 128K while the assertion said 131_072 — the name
    // had the daemon's value and the table was the outlier. Corrected 2026-07-30.
    expect(row!.contextWindow).toBe(128_000)
    expect(row!.formatted).toBe('128k')
  })

  it('ollama group carries all six verified labels and daemon windows', () => {
    const ollama = buildModelContextLengthGroups({ includeOllama: true }).find(
      (group) => group.provider === 'ollama'
    )
    const byId = new Map(ollama?.models.map((model) => [model.modelId, model]))

    expect(byId.get('llama3.1:8b')).toMatchObject({
      label: 'Llama 3.1 (8B Param)',
      contextWindow: 131_072
    })
    expect(byId.get('deepseek-r1:8b')).toMatchObject({
      label: 'R1 (8B Param)',
      contextWindow: 131_072
    })
    expect(byId.get('rnj-1')).toMatchObject({ contextWindow: 32_768, formatted: '33k' })
    expect(byId.get('glm-4.7-flash:q4_K_M')).toMatchObject({
      contextWindow: 202_752,
      formatted: '203k'
    })
    expect(byId.get('north-mini-code-1.0:q4_K_M')).toMatchObject({
      contextWindow: 500_000,
      formatted: '500k'
    })
    expect(byId.get('muse-glimmer:30b-mlx')).toMatchObject({
      label: 'Muse Glimmer (30B-MLX)',
      contextWindow: 131_072
    })
    expect(byId.get('nemotron-3.5-lightning:30b-mlx')).toMatchObject({
      label: 'Nemotron 3.5 Lightning (30B-MLX)',
      contextWindow: 262_144
    })
    expect(byId.get('qwen3.8:27b-mlx')).toMatchObject({
      label: 'Qwen 3.8 (27B-MLX)',
      contextWindow: 262_144
    })
    expect(byId.get('qwen3.8-flash-next:125b-mlx')).toMatchObject({
      label: 'Qwen 3.8 Flash Next (125B-MLX)',
      contextWindow: 262_144
    })
    expect(byId.get('mistral-medium-3.5:128b')).toMatchObject({
      label: 'Mistral Medium 3.5 (128B Param)',
      contextWindow: 262_144
    })
    expect(byId.get('granite4.2:3b')).toMatchObject({ contextWindow: 131_072 })
    expect(byId.get('granite4.2:8b')).toMatchObject({ contextWindow: 131_072 })
    expect(byId.get('granite4.2:30b')).toMatchObject({ contextWindow: 131_072 })
    expect(byId.get('llama3.2:3b')).toMatchObject({ contextWindow: 131_072 })
  })

  it("{ excludeProviders: ['gemini'] }: drops the gemini group, keeps the rest", () => {
    const groups = buildModelContextLengthGroups({ excludeProviders: ['gemini'] })
    const providerIds = groups.map((g) => g.provider)
    expect(providerIds).not.toContain('gemini')
    expect(providerIds).toContain('codex')
    expect(providerIds).toContain('claude')
  })

  it('sidebar config { includeOllama: true, excludeProviders: [gemini] }: ollama present, no gemini', () => {
    const groups = buildModelContextLengthGroups({
      includeOllama: true,
      excludeProviders: ['gemini']
    })
    const providerIds = groups.map((g) => g.provider)
    expect(providerIds).not.toContain('gemini')
    expect(providerIds).toContain('ollama')
    expect(providerIds[providerIds.length - 1]).toBe('ollama')
  })

  it('every row.formatted is a non-empty string and every row.contextWindow > 0', () => {
    const groups = buildModelContextLengthGroups({ includeOllama: true })
    for (const group of groups) {
      for (const row of group.models) {
        expect(typeof row.formatted).toBe('string')
        expect(row.formatted.length).toBeGreaterThan(0)
        expect(row.contextWindow).toBeGreaterThan(0)
      }
    }
  })
})
