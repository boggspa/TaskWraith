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
    expect(resolveOllamaModelFamily('gpt-oss:latest')).toBe('gpt_oss_20b')
    expect(resolveOllamaModelFamily('qwen3.5:4b')).toBe('qwen3_5_4b')
    expect(resolveOllamaModelFamily('devstral-small-2:24b')).toBe('devstral_small_2_24b')
    expect(resolveOllamaModelFamily('ministral-3:14b')).toBe('ministral_3_14b')
    expect(resolveOllamaModelFamily('llama3.2:3b')).toBe('unknown')
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
    // `qwen35` is what the daemon reports for BOTH 3.5 sizes. Before this arm
    // the generic `qwen3` fallback sent every 3.5 tag to the 4B profile — the
    // 9B included, because its real "9.7B" never matched the `9b` needle.
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
      estimateOllamaModelRamGb({ sizeBytes: 14_000_000_000, quantizationLevel: 'MXFP4' })
    ).toBe(17.5)
  })
})

describe('evaluateOllamaModelPreflight', () => {
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
