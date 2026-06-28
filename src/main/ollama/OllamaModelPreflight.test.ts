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
    expect(resolveOllamaModelFamily('granite4.1:3b')).toBe('granite4_1_3b')
    expect(resolveOllamaModelFamily('granite4.1:30b')).toBe('granite4_1_30b')
    expect(resolveOllamaModelFamily('nemotron3:33b')).toBe('nemotron3_33b')
    expect(resolveOllamaModelFamily('gpt-oss:latest')).toBe('gpt_oss_20b')
    expect(resolveOllamaModelFamily('llama3.2:3b')).toBe('unknown')
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
  it('surfaces honest Qwen 3.5 guidance and delegate hint', () => {
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
    expect(result.delegateHint).toContain('Codex or Claude')
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
