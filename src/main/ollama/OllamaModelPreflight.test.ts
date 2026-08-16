import { describe, expect, it } from 'vitest'
import {
  estimateOllamaModelRamGb,
  evaluateOllamaModelPreflight,
  ollamaModelPreflightKey,
  parseOllamaParameterBillions,
  resolveOllamaModelFamily,
  shouldRunOllamaModelPreflight
} from './OllamaModelPreflight'

const GB = 1024 ** 3

describe('resolveOllamaModelFamily', () => {
  it('maps curated TaskWraith model tags to families', () => {
    expect(resolveOllamaModelFamily('qwen3.5:9b')).toBe('qwen3_5_9b')
    expect(resolveOllamaModelFamily('qwen3.6:35b')).toBe('qwen3_6_35b')
    expect(resolveOllamaModelFamily('qwen3.8:27b-mlx')).toBe('qwen3_8_27b')
    expect(resolveOllamaModelFamily('qwen3:4b-instruct')).toBe('qwen3_4b')
    expect(resolveOllamaModelFamily('minicpm-v4.5:8b')).toBe('minicpm_v45_8b')
    expect(resolveOllamaModelFamily('gemma4:12b-it-q4_K_M')).toBe('gemma4_12b')
    expect(resolveOllamaModelFamily('ornith')).toBe('ornith_9b')
    expect(resolveOllamaModelFamily('ornith:latest')).toBe('ornith_9b')
    expect(resolveOllamaModelFamily('ornith:9b')).toBe('ornith_9b')
    expect(resolveOllamaModelFamily('ornith:35b')).toBe('ornith_35b')
    expect(resolveOllamaModelFamily('ornith:35b-q4_K_M')).toBe('ornith_35b')
    expect(resolveOllamaModelFamily('laguna-xs-2.1:q8_0')).toBe('laguna_xs_2_1')
    expect(resolveOllamaModelFamily('lfm2.5')).toBe('lfm2_5_8b')
    expect(resolveOllamaModelFamily('lfm2.5:8b')).toBe('lfm2_5_8b')
    expect(resolveOllamaModelFamily('lfm2.5:8b-q4_K_M')).toBe('lfm2_5_8b')
    expect(resolveOllamaModelFamily('granite4.1:3b')).toBe('granite4_1_3b')
    expect(resolveOllamaModelFamily('granite4.1:30b')).toBe('granite4_1_30b')
    expect(resolveOllamaModelFamily('nemotron3:33b')).toBe('nemotron3_33b')
    expect(resolveOllamaModelFamily('nemotron-3.5-lightning:30b-mlx')).toBe(
      'nemotron3_5_lightning_30b'
    )
    expect(resolveOllamaModelFamily('gpt-oss:latest')).toBe('gpt_oss_20b')
    expect(resolveOllamaModelFamily('qwen3.5:4b')).toBe('qwen3_5_4b')
    expect(resolveOllamaModelFamily('devstral-small-2:24b')).toBe('devstral_small_2_24b')
    expect(resolveOllamaModelFamily('ministral-3:14b')).toBe('ministral_3_14b')
    expect(resolveOllamaModelFamily('muse-glimmer:30b-mlx')).toBe('muse_glimmer_30b')
    expect(resolveOllamaModelFamily('llama3.1:8b')).toBe('llama3_1_8b')
    expect(resolveOllamaModelFamily('deepseek-r1:8b')).toBe('deepseek_r1_8b')
    expect(resolveOllamaModelFamily('rnj-1')).toBe('rnj_1_8b')
    expect(resolveOllamaModelFamily('rnj-1:latest')).toBe('rnj_1_8b')
    expect(resolveOllamaModelFamily('glm-4.7-flash:q4_K_M')).toBe('glm_4_7_flash')
    expect(resolveOllamaModelFamily('north-mini-code-1.0:q4_K_M')).toBe(
      'north_mini_code_1_0'
    )
    expect(resolveOllamaModelFamily('llama3.2:3b')).toBe('llama3_2_3b')
    expect(resolveOllamaModelFamily('qwen3.5:2b')).toBe('qwen3_5_2b')
    expect(resolveOllamaModelFamily('gemma3:4b')).toBe('gemma3_4b')
    expect(resolveOllamaModelFamily('gemma3')).toBe('gemma3_4b')
    expect(resolveOllamaModelFamily('gemma3:latest')).toBe('gemma3_4b')
    expect(resolveOllamaModelFamily('lfm2.5-thinking:1.2b')).toBe('lfm2_5_thinking_1_2b')
    expect(resolveOllamaModelFamily('lfm2.5-thinking')).toBe('lfm2_5_thinking_1_2b')
    expect(resolveOllamaModelFamily('lfm2.5-thinking:latest')).toBe(
      'lfm2_5_thinking_1_2b'
    )
    expect(resolveOllamaModelFamily('granite4:3b')).toBe('granite4_3b')
    expect(resolveOllamaModelFamily('nemotron-3-nano:4b')).toBe('nemotron3_nano_4b')
    expect(resolveOllamaModelFamily('ministral-3:3b')).toBe('ministral_3_3b')
    expect(resolveOllamaModelFamily('deepseek-r1:1.5b')).toBe('deepseek_r1_1_5b')
  })

  it('recognizes live daemon architectures for the new families', () => {
    expect(
      resolveOllamaModelFamily('custom-glm:latest', {
        id: 'custom-glm:latest',
        label: 'Custom GLM',
        family: 'glm4moelite',
        parameterSize: '29.9B'
      })
    ).toBe('glm_4_7_flash')
    expect(
      resolveOllamaModelFamily('custom-north:latest', {
        id: 'custom-north:latest',
        label: 'Custom North',
        family: 'cohere2moe',
        parameterSize: '30.5B'
      })
    ).toBe('north_mini_code_1_0')
    expect(
      resolveOllamaModelFamily('custom-llama:latest', {
        id: 'custom-llama:latest',
        label: 'Custom Llama',
        family: 'llama',
        parameterSize: '3.2B',
        show: { model_info: { 'general.basename': 'Llama-3.2' } }
      })
    ).toBe('llama3_2_3b')
    expect(
      resolveOllamaModelFamily('custom-glimmer:latest', {
        id: 'custom-glimmer:latest',
        label: 'Custom Glimmer',
        family: 'muse_glimmer',
        parameterSize: '30B',
        show: { model_info: { 'general.architecture': 'MuseGlimmerForConditionalGeneration' } }
      })
    ).toBe('muse_glimmer_30b')
    expect(
      resolveOllamaModelFamily('custom-lightning:latest', {
        id: 'custom-lightning:latest',
        label: 'Custom Lightning',
        family: 'nemotron_h',
        parameterSize: '30B',
        show: { model_info: { 'general.basename': 'Nemotron-3.5-Lightning' } }
      })
    ).toBe('nemotron3_5_lightning_30b')
    expect(
      resolveOllamaModelFamily('custom-qwen:latest', {
        id: 'custom-qwen:latest',
        label: 'Custom Qwen',
        family: 'qwen3.8',
        parameterSize: '27B'
      })
    ).toBe('qwen3_8_27b')
    expect(
      resolveOllamaModelFamily('custom-legacy-llama:latest', {
        id: 'custom-legacy-llama:latest',
        label: 'Custom legacy Llama',
        family: 'llama',
        parameterSize: '7B'
      })
    ).toBe('unknown')
  })

  it('keeps the two 3.5 sizes on separate families', () => {
    // `qwen3.5:4b` matches NEITHER the `qwen3:4b` nor the `qwen3.5:9b` prefix
    // (dot vs colon), so without its own arm it fell through to the metadata
    // heuristics and resolved 'unknown' whenever /api/tags was unavailable —
    // which drops the tag out of ensemble context sharing entirely.
    expect(resolveOllamaModelFamily('qwen3.5:4b')).toBe('qwen3_5_4b')
    expect(resolveOllamaModelFamily('qwen3.5:4b-instruct-q4_K_M')).toBe('qwen3_5_4b')
    expect(resolveOllamaModelFamily('qwen3.5:9b')).toBe('qwen3_5_9b')
  })

  it('splits the shared mistral3 architecture by parameter size', () => {
    // The live daemon reports `family: 'mistral3'` for BOTH local Mistral tags
    // (verified 2026-07-30), so the architecture alone cannot pick the family —
    // an earlier pass guessed 'devstral'/'ministral' family strings that Ollama
    // never emits, which left a custom-named tag resolving 'unknown'.
    expect(
      resolveOllamaModelFamily('local-custom:latest', {
        id: 'local-custom:latest',
        label: 'Local Custom',
        family: 'mistral3',
        parameterSize: '24.0B'
      })
    ).toBe('devstral_small_2_24b')
    expect(
      resolveOllamaModelFamily('local-custom:latest', {
        id: 'local-custom:latest',
        label: 'Local Custom',
        family: 'mistral3',
        parameterSize: '13.9B'
      })
    ).toBe('ministral_3_14b')
    expect(
      resolveOllamaModelFamily('local-custom:latest', {
        id: 'local-custom:latest',
        label: 'Local Custom',
        family: 'mistral3',
        parameterSize: '3.4B'
      })
    ).toBe('ministral_3_3b')
    // An explicit brand word in a custom tag's own metadata still wins.
    expect(
      resolveOllamaModelFamily('local-custom:latest', {
        id: 'local-custom:latest',
        label: 'Local Custom',
        family: 'ministral',
        parameterSize: '13.9B'
      })
    ).toBe('ministral_3_14b')
  })

  it('splits the shared qwen35 architecture by parameter size', () => {
    // `qwen35` is what the daemon reports for all three dense 3.5 sizes. Before
    // this arm the generic `qwen3` fallback sent every 3.5 tag to the 4B
    // profile — the 9B included, because its real "9.7B" never matched the
    // `9b` needle.
    expect(
      resolveOllamaModelFamily('local-custom:latest', {
        id: 'local-custom:latest',
        label: 'Local Custom',
        family: 'qwen35',
        parameterSize: '2.2B'
      })
    ).toBe('qwen3_5_2b')
    expect(
      resolveOllamaModelFamily('local-custom:latest', {
        id: 'local-custom:latest',
        label: 'Local Custom',
        family: 'qwen35',
        parameterSize: '4.7B'
      })
    ).toBe('qwen3_5_4b')
    expect(
      resolveOllamaModelFamily('local-custom:latest', {
        id: 'local-custom:latest',
        label: 'Local Custom',
        family: 'qwen35',
        parameterSize: '9.7B'
      })
    ).toBe('qwen3_5_9b')
    // The 35B MoE tags report `qwen35moe` and must keep resolving to 3.6.
    expect(
      resolveOllamaModelFamily('local-custom:latest', {
        id: 'local-custom:latest',
        label: 'Local Custom',
        family: 'qwen35moe',
        parameterSize: '36.0B'
      })
    ).toBe('qwen3_6_35b')
  })

  it('splits small DeepSeek and Nemotron metadata from their larger siblings', () => {
    expect(
      resolveOllamaModelFamily('local-deepseek:latest', {
        id: 'local-deepseek:latest',
        label: 'DeepSeek R1 local',
        family: 'deepseek-r1',
        parameterSize: '1.8B'
      })
    ).toBe('deepseek_r1_1_5b')
    expect(
      resolveOllamaModelFamily('local-nemotron:latest', {
        id: 'local-nemotron:latest',
        label: 'Nemotron local',
        family: 'nemotron_h',
        parameterSize: '4.0B'
      })
    ).toBe('nemotron3_nano_4b')
  })

  it('preserves a retagged LFM 2.5 Thinking model from its model basename', () => {
    expect(
      resolveOllamaModelFamily('private-local:latest', {
        id: 'private-local:latest',
        label: 'Private local model',
        family: 'lfm2',
        parameterSize: '1.17B',
        show: { model_info: { 'general.basename': 'LFM2.5-1.2B-Thinking' } }
      })
    ).toBe('lfm2_5_thinking_1_2b')
  })

  it('uses exact tags before architecture metadata that could be ambiguous', () => {
    expect(
      resolveOllamaModelFamily('minicpm-v4.5:8b', {
        id: 'minicpm-v4.5:8b',
        label: 'MiniCPM-V 4.5',
        family: 'qwen3',
        parameterSize: '8.2B'
      })
    ).toBe('minicpm_v45_8b')
  })

  it('detects GPT-OSS from Ollama metadata before tag heuristics', () => {
    expect(
      resolveOllamaModelFamily('local-custom:latest', {
        id: 'local-custom:latest',
        label: 'Local Custom',
        family: 'gptoss',
        families: ['gptoss']
      })
    ).toBe('gpt_oss_20b')
  })

  it('detects Ornith from Ollama metadata', () => {
    expect(
      resolveOllamaModelFamily('local-custom:latest', {
        id: 'local-custom:latest',
        label: 'Local Custom',
        family: 'ornith',
        parameterSize: '35B'
      })
    ).toBe('ornith_35b')
  })

  it('detects LFM 2.5 from Ollama metadata', () => {
    expect(
      resolveOllamaModelFamily('local-custom:latest', {
        id: 'local-custom:latest',
        label: 'Local Custom',
        family: 'lfm2',
        parameterSize: '8B'
      })
    ).toBe('lfm2_5_8b')
  })

  it('detects Laguna from Ollama metadata', () => {
    expect(
      resolveOllamaModelFamily('local-custom:latest', {
        id: 'local-custom:latest',
        label: 'Laguna XS 2.1',
        family: 'laguna',
        parameterSize: '33B'
      })
    ).toBe('laguna_xs_2_1')
  })
})

describe('estimateOllamaModelRamGb', () => {
  it('estimates quantised resident RAM from parameter size', () => {
    expect(parseOllamaParameterBillions('9B')).toBe(9)
    expect(
      estimateOllamaModelRamGb({ parameterBillions: 9, quantizationLevel: 'Q4_K_M' })
    ).toBeGreaterThan(5)
    expect(
      estimateOllamaModelRamGb({ parameterBillions: 20, quantizationLevel: 'Q4_K_M' })
    ).toBeGreaterThan(12)
    expect(
      estimateOllamaModelRamGb({ parameterBillions: 20.9, quantizationLevel: 'MXFP4' })
    ).toBeLessThan(14)
    expect(
      estimateOllamaModelRamGb({ parameterBillions: 27, quantizationLevel: 'NVFP4' })
    ).toBeLessThan(19)
    expect(
      estimateOllamaModelRamGb({ sizeBytes: 14_000_000_000, quantizationLevel: 'MXFP4' })
    ).toBe(17.5)
  })
})

describe('evaluateOllamaModelPreflight', () => {
  it('keeps every lightweight tag on its small family and RAM estimate', () => {
    const cases = new Map([
      ['ministral-3:3b', 'ministral_3_3b'],
      ['granite4:3b', 'granite4_3b'],
      ['qwen3.5:2b', 'qwen3_5_2b'],
      ['deepseek-r1:1.5b', 'deepseek_r1_1_5b'],
      ['nemotron-3-nano:4b', 'nemotron3_nano_4b'],
      ['lfm2.5-thinking:1.2b', 'lfm2_5_thinking_1_2b'],
      ['gemma3:4b', 'gemma3_4b']
    ])
    for (const [modelId, family] of cases) {
      const result = evaluateOllamaModelPreflight({
        modelId,
        modelLabel: modelId,
        installedModelIds: [modelId],
        totalMemoryBytes: 8 * GB
      })
      expect(result.family).toBe(family)
      expect(result.guidance).not.toContain('is a local model. Match the selected tier')
      expect(result.warnings.some((entry) => entry.id === 'ollama-ram-tight')).toBe(false)
    }
  })

  it('surfaces honest Qwen 3.5 guidance and scope hint', () => {
    const result = evaluateOllamaModelPreflight({
      modelId: 'qwen3.5:9b',
      modelLabel: 'Qwen 3.5 (9B Param)',
      modelInfo: {
        id: 'qwen3.5:9b',
        label: 'Qwen 3.5 (9B Param)',
        parameterSize: '9B',
        quantizationLevel: 'Q4_K_M',
        capabilities: ['completion', 'tools']
      },
      installedModelIds: ['qwen3.5:9b', 'gpt-oss:latest'],
      totalMemoryBytes: 32 * GB
    })

    expect(result.family).toBe('qwen3_5_9b')
    expect(result.checks.find((c) => c.id === 'installed')?.ok).toBe(true)
    expect(result.checks.find((c) => c.id === 'tools')?.ok).toBe(true)
    expect(result.guidance).toContain('scoped tasks')
    expect(result.delegateHint).toContain('confirm the needed Ollama tier')
    expect(result.delegateHint).not.toContain('Codex or Claude')
    expect(result.warnings[0].id).toBe('ollama-model-guidance')
  })

  it('surfaces Qwen 3.8 multimodal thinking guidance and its Ollama version floor', () => {
    const result = evaluateOllamaModelPreflight({
      modelId: 'qwen3.8:27b-mlx',
      modelLabel: 'Qwen 3.8 (27B-MLX)',
      modelInfo: {
        id: 'qwen3.8:27b-mlx',
        label: 'Qwen 3.8 (27B-MLX)',
        parameterSize: '27B',
        quantizationLevel: 'NVFP4',
        sizeBytes: 18_000_000_000,
        capabilities: ['completion', 'vision', 'tools', 'thinking']
      },
      installedModelIds: ['qwen3.8:27b-mlx'],
      totalMemoryBytes: 64 * GB
    })

    expect(result.family).toBe('qwen3_8_27b')
    expect(result.guidance).toContain('multimodal long-context agent model')
    expect(result.delegateHint).toContain('Ollama 0.32.12 or newer')
    expect(result.checks.find((check) => check.id === 'tools')?.ok).toBe(true)
  })

  it('surfaces new large local model guidance without treating it as unknown', () => {
    const result = evaluateOllamaModelPreflight({
      modelId: 'nemotron3:33b',
      modelLabel: 'Nemotron 3 Nano Omni (33B Param)',
      modelInfo: {
        id: 'nemotron3:33b',
        label: 'Nemotron 3 Nano Omni (33B Param)',
        parameterSize: '33B',
        quantizationLevel: 'Q4_K_M',
        capabilities: ['completion', 'vision', 'tools', 'thinking']
      },
      installedModelIds: ['nemotron3:33b'],
      totalMemoryBytes: 96 * GB
    })
    expect(result.family).toBe('nemotron3_33b')
    expect(result.guidance).toContain('multimodal')
    expect(result.checks.find((c) => c.id === 'tools')?.ok).toBe(true)
  })

  it('surfaces Muse Glimmer as a Meta agentic tools/thinking model', () => {
    const result = evaluateOllamaModelPreflight({
      modelId: 'muse-glimmer:30b-mlx',
      modelLabel: 'Muse Glimmer (30B-MLX)',
      modelInfo: {
        id: 'muse-glimmer:30b-mlx',
        label: 'Muse Glimmer (30B-MLX)',
        parameterSize: '30B',
        quantizationLevel: 'NVFP4',
        sizeBytes: 21_000_000_000,
        capabilities: ['completion', 'vision', 'tools', 'thinking']
      },
      installedModelIds: ['muse-glimmer:30b-mlx'],
      totalMemoryBytes: 64 * GB
    })
    expect(result.family).toBe('muse_glimmer_30b')
    expect(result.guidance).toContain("Meta's 30B multimodal agentic model")
    expect(result.checks.find((check) => check.id === 'tools')?.ok).toBe(true)
  })

  it('surfaces Nemotron 3.5 Lightning as an always-on NVIDIA agent model', () => {
    const result = evaluateOllamaModelPreflight({
      modelId: 'nemotron-3.5-lightning:30b-mlx',
      modelLabel: 'Nemotron 3.5 Lightning (30B-MLX)',
      modelInfo: {
        id: 'nemotron-3.5-lightning:30b-mlx',
        label: 'Nemotron 3.5 Lightning (30B-MLX)',
        parameterSize: '30B',
        quantizationLevel: 'NVFP4',
        sizeBytes: 23_000_000_000,
        capabilities: ['completion', 'tools', 'thinking']
      },
      installedModelIds: ['nemotron-3.5-lightning:30b-mlx'],
      totalMemoryBytes: 64 * GB
    })
    expect(result.family).toBe('nemotron3_5_lightning_30b')
    expect(result.guidance).toContain('always-on agents')
    expect(result.guidance).toContain('262K context window')
    expect(result.checks.find((check) => check.id === 'tools')?.ok).toBe(true)
  })

  it('surfaces LFM 2.5 as a known tool-capable long-context local model', () => {
    const result = evaluateOllamaModelPreflight({
      modelId: 'lfm2.5:8b',
      modelLabel: 'LFM 2.5 (8B-A1B)',
      modelInfo: {
        id: 'lfm2.5:8b',
        label: 'LFM 2.5 (8B-A1B)',
        parameterSize: '8B',
        quantizationLevel: 'Q4_K_M',
        capabilities: ['completion', 'tools']
      },
      installedModelIds: ['lfm2.5:8b'],
      totalMemoryBytes: 32 * GB
    })
    expect(result.family).toBe('lfm2_5_8b')
    expect(result.guidance).toContain('long context')
    expect(result.checks.find((c) => c.id === 'tools')?.ok).toBe(true)
  })

  it('surfaces Laguna XS as a known long-context tools/thinking model', () => {
    const result = evaluateOllamaModelPreflight({
      modelId: 'laguna-xs-2.1:q8_0',
      modelLabel: 'Laguna XS 2.1 (33B-A3B Q8)',
      modelInfo: {
        id: 'laguna-xs-2.1:q8_0',
        label: 'Laguna XS 2.1 (33B-A3B Q8)',
        parameterSize: '33B',
        quantizationLevel: 'Q8_0',
        capabilities: ['completion', 'tools', 'thinking']
      },
      installedModelIds: ['laguna-xs-2.1:q8_0'],
      totalMemoryBytes: 96 * GB
    })
    expect(result.family).toBe('laguna_xs_2_1')
    expect(result.guidance).toContain('long-context')
    expect(result.guidance).toContain('macOS/Metal')
    expect(result.checks.find((c) => c.id === 'tools')?.ok).toBe(true)
  })

  it('surfaces verified version and capability guidance for Rnj, GLM, and North', () => {
    const cases = [
      {
        modelId: 'rnj-1',
        modelLabel: 'Rnj-1 (8B Param)',
        parameterSize: '8.3B',
        capabilities: ['completion', 'tools'],
        family: 'rnj_1_8b',
        guidance: 'Ollama 0.13.3'
      },
      {
        modelId: 'glm-4.7-flash:q4_K_M',
        modelLabel: 'GLM-4.7-Flash (30B-A3B Q4)',
        parameterSize: '29.9B',
        capabilities: ['completion', 'tools', 'thinking'],
        family: 'glm_4_7_flash',
        guidance: 'Ollama 0.15.0'
      },
      {
        modelId: 'north-mini-code-1.0:q4_K_M',
        modelLabel: 'North Mini Code 1.0 (30B-A3B Q4)',
        parameterSize: '30.5B',
        capabilities: ['completion', 'tools', 'thinking'],
        family: 'north_mini_code_1_0',
        guidance: 'Ollama 0.30.10'
      }
    ] as const

    for (const entry of cases) {
      const result = evaluateOllamaModelPreflight({
        modelId: entry.modelId,
        modelLabel: entry.modelLabel,
        modelInfo: {
          id: entry.modelId,
          label: entry.modelLabel,
          parameterSize: entry.parameterSize,
          quantizationLevel: 'Q4_K_M',
          capabilities: [...entry.capabilities]
        },
        installedModelIds: [entry.modelId === 'rnj-1' ? 'rnj-1:latest' : entry.modelId],
        totalMemoryBytes: 96 * GB
      })
      expect(result.family).toBe(entry.family)
      expect(result.guidance).toContain(entry.guidance)
      expect(result.checks.find((check) => check.id === 'installed')?.ok).toBe(true)
      expect(result.checks.find((check) => check.id === 'tools')?.ok).toBe(true)
    }
  })

  it('warns when the model tag is missing or RAM is tight', () => {
    const missing = evaluateOllamaModelPreflight({
      modelId: 'qwen3.5:9b',
      modelLabel: 'Qwen 3.5 (9B Param)',
      installedModelIds: ['gpt-oss:latest'],
      totalMemoryBytes: 8 * GB
    })
    expect(missing.checks.find((c) => c.id === 'installed')?.ok).toBe(false)
    expect(missing.warnings.some((w) => w.id === 'ollama-model-missing')).toBe(true)
    expect(missing.warnings.some((w) => w.id === 'ollama-ram-tight')).toBe(true)
  })

  it('treats Ollama Cloud models as remote instead of missing local weights', () => {
    const result = evaluateOllamaModelPreflight({
      modelId: 'glm-5.2:cloud',
      modelLabel: 'GLM 5.2',
      modelInfo: {
        id: 'glm-5.2:cloud',
        label: 'GLM 5.2',
        source: 'cloud',
        isCloud: true,
        contextLength: 1_000_000,
        capabilities: ['completion', 'tools']
      },
      installedModelIds: [],
      totalMemoryBytes: 8 * GB
    })

    expect(result.checks.find((check) => check.id === 'installed')).toMatchObject({
      ok: true,
      detail: expect.stringMatching(/remotely|no local model weights/i)
    })
    expect(result.checks.find((check) => check.id === 'ram')).toMatchObject({
      ok: true,
      detail: expect.stringMatching(/cloud|does not apply/i)
    })
    expect(result.warnings.some((entry) => entry.id === 'ollama-model-missing')).toBe(false)
    expect(result.warnings.some((entry) => entry.id === 'ollama-ram-tight')).toBe(false)
    expect(result.warnings[0]?.title).toContain('cloud expectations')
    expect(result.guidance).toContain('signed-in local Ollama daemon')
  })

  it('flags models that do not advertise native tools', () => {
    const result = evaluateOllamaModelPreflight({
      modelId: 'gpt-oss:latest',
      modelLabel: 'GPT OSS (20B Param)',
      modelInfo: {
        id: 'gpt-oss:latest',
        label: 'GPT OSS (20B Param)',
        parameterSize: '20B',
        capabilities: ['completion']
      },
      installedModelIds: ['gpt-oss:latest'],
      totalMemoryBytes: 64 * GB
    })
    expect(result.checks.find((c) => c.id === 'tools')?.ok).toBe(false)
    expect(result.warnings.some((w) => w.id === 'ollama-tools-unadvertised')).toBe(true)
    expect(result.guidance).toContain('finicky with tool calls')
  })

  it('treats gpt-oss aliases as installed when an exact tag is present', () => {
    const result = evaluateOllamaModelPreflight({
      modelId: 'gpt-oss',
      modelLabel: 'GPT OSS (20B Param)',
      installedModelIds: ['gpt-oss:latest'],
      totalMemoryBytes: 64 * GB
    })
    expect(result.checks.find((c) => c.id === 'installed')?.ok).toBe(true)
  })

  it('treats official lightweight aliases as the installed catalog tags', () => {
    for (const [modelId, installedModelId] of [
      ['gemma3:4b', 'gemma3:latest'],
      ['gemma3', 'gemma3:4b'],
      ['lfm2.5-thinking:1.2b', 'lfm2.5-thinking:latest'],
      ['lfm2.5-thinking', 'lfm2.5-thinking:1.2b']
    ]) {
      const result = evaluateOllamaModelPreflight({
        modelId,
        modelLabel: modelId,
        installedModelIds: [installedModelId],
        totalMemoryBytes: 8 * GB
      })
      expect(result.checks.find((check) => check.id === 'installed')?.ok).toBe(true)
    }
  })
})

describe('shouldRunOllamaModelPreflight', () => {
  it('runs once per model id', () => {
    expect(shouldRunOllamaModelPreflight(undefined, 'qwen3.5:9b')).toBe(true)
    expect(shouldRunOllamaModelPreflight({ 'qwen3.5:9b': Date.now() }, 'qwen3.5:9b')).toBe(
      false
    )
    expect(shouldRunOllamaModelPreflight({ 'qwen3.5:9b': Date.now() }, 'gpt-oss:latest')).toBe(
      true
    )
    expect(ollamaModelPreflightKey('gpt-oss:latest', { digest: 'sha256:abc' })).toBe(
      'gpt-oss:latest@sha256:abc'
    )
  })
})
