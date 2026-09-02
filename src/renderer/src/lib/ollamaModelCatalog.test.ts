import { describe, expect, it } from 'vitest'
import { mergeOllamaModelCatalog, ollamaModelCatalogKey } from './ollamaModelCatalog'

describe('mergeOllamaModelCatalog', () => {
  it('humanises Cloud recommendations while preserving their exact wire ids', () => {
    const models = mergeOllamaModelCatalog([
      { id: 'glm-5.3-flash:cloud', label: 'glm-5.3-flash' },
      { id: 'glm-5.2:cloud', label: 'glm-5.2' },
      { id: 'minimax-m3:cloud', label: 'minimax-m3' },
      { id: 'deepseek-v4-pro:cloud', label: 'deepseek-v4-pro' },
      { id: 'deepseek-v4-flash:cloud', label: 'deepseek-v4-flash' },
      { id: 'gemma4:cloud', label: 'gemma4' }
    ])

    expect(models.find((model) => model.id === 'glm-5.3-flash:cloud')).toMatchObject({
      id: 'glm-5.3-flash:cloud',
      label: 'GLM 5.3 Flash'
    })
    expect(models.find((model) => model.id === 'glm-5.2:cloud')).toMatchObject({
      id: 'glm-5.2:cloud',
      label: 'GLM 5.2'
    })
    expect(models.find((model) => model.id === 'minimax-m3:cloud')).toMatchObject({
      id: 'minimax-m3:cloud',
      label: 'M3'
    })
    expect(models.find((model) => model.id === 'deepseek-v4-pro:cloud')?.label).toBe('V4 Pro')
    expect(models.find((model) => model.id === 'deepseek-v4-flash:cloud')?.label).toBe('V4 Flash')
    expect(models.find((model) => model.id === 'gemma4:cloud')?.label).toBe('Gemma 4')
  })

  it('humanises and deduplicates the newest installed local tags', () => {
    const models = mergeOllamaModelCatalog([
      { id: 'mistral-medium-3.5:latest', label: 'mistral-medium-3.5:latest' },
      { id: 'granite4.2:latest', label: 'granite4.2:latest' },
      { id: 'qwen3.8-flash-next:125b-mlx', label: 'qwen3.8-flash-next:125b-mlx' }
    ])

    expect(
      models.filter((model) => ollamaModelCatalogKey(model.id) === 'mistral-medium-3.5:128b')
    ).toHaveLength(1)
    expect(
      models.filter((model) => ollamaModelCatalogKey(model.id) === 'granite4.2:8b')
    ).toHaveLength(1)
    expect(models.find((model) => model.id === 'qwen3.8-flash-next:125b-mlx')?.label).toBe(
      'Qwen 3.8 Flash Next (125B-MLX)'
    )
  })

  it('keeps curated human labels when live Ollama returns raw model tags', () => {
    const models = mergeOllamaModelCatalog([{ id: 'lfm2.5:8b', label: 'lfm2.5:8b' }])

    expect(models.find((model) => model.id === 'lfm2.5:8b')?.label).toBe('LFM 2.5 (8B-A1B)')
  })

  it('keeps the curated Laguna label when live Ollama returns the raw Q8 tag', () => {
    const models = mergeOllamaModelCatalog([
      { id: 'laguna-xs-2.1:q8_0', label: 'laguna-xs-2.1:q8_0' }
    ])

    expect(models.find((model) => model.id === 'laguna-xs-2.1:q8_0')?.label).toBe(
      'Laguna XS 2.1 (33B-A3B Q8)'
    )
  })

  it('keeps the curated Qwen 3.8 MLX label when live Ollama returns the raw tag', () => {
    const models = mergeOllamaModelCatalog([{ id: 'qwen3.8:27b-mlx', label: 'qwen3.8:27b-mlx' }])

    expect(models.find((model) => model.id === 'qwen3.8:27b-mlx')?.label).toBe('Qwen 3.8 (27B-MLX)')
  })

  it('keeps the curated Muse Glimmer MLX label when live Ollama returns the raw tag', () => {
    const models = mergeOllamaModelCatalog([
      { id: 'muse-glimmer:30b-mlx', label: 'muse-glimmer:30b-mlx' }
    ])

    expect(models.find((model) => model.id === 'muse-glimmer:30b-mlx')?.label).toBe(
      'Muse Glimmer (30B-MLX)'
    )
  })

  it('keeps the curated Nemotron Lightning MLX label when live Ollama returns the raw tag', () => {
    const models = mergeOllamaModelCatalog([
      {
        id: 'nemotron-3.5-lightning:30b-mlx',
        label: 'nemotron-3.5-lightning:30b-mlx'
      }
    ])

    expect(models.find((model) => model.id === 'nemotron-3.5-lightning:30b-mlx')?.label).toBe(
      'Nemotron 3.5 Lightning (30B-MLX)'
    )
  })

  it('deduplicates GPT OSS aliases into one OpenAI picker row', () => {
    const models = mergeOllamaModelCatalog([
      { id: 'gpt-oss:latest', label: 'gpt-oss:latest' },
      { id: 'openai/gpt-oss-20b', label: 'openai/gpt-oss-20b' }
    ])

    const gptOssRows = models.filter((model) => ollamaModelCatalogKey(model.id) === 'gpt-oss:20b')
    expect(gptOssRows).toHaveLength(1)
    expect(gptOssRows[0]).toMatchObject({ label: 'GPT OSS (20B Param)' })
  })

  it('humanises all six verified live tags and deduplicates the Rnj alias', () => {
    const models = mergeOllamaModelCatalog([
      { id: 'llama3.1:8b', label: 'llama3.1:8b' },
      { id: 'deepseek-r1:8b', label: 'deepseek-r1:8b' },
      { id: 'rnj-1:latest', label: 'rnj-1:latest' },
      { id: 'glm-4.7-flash:q4_K_M', label: 'glm-4.7-flash:q4_K_M' },
      { id: 'north-mini-code-1.0:q4_K_M', label: 'north-mini-code-1.0:q4_K_M' },
      { id: 'llama3.2:3b', label: 'llama3.2:3b' }
    ])

    expect(models.find((model) => model.id === 'llama3.1:8b')?.label).toBe('Llama 3.1 (8B Param)')
    expect(models.find((model) => model.id === 'deepseek-r1:8b')?.label).toBe('R1 (8B Param)')
    expect(models.filter((model) => ollamaModelCatalogKey(model.id) === 'rnj-1')).toHaveLength(1)
    expect(models.find((model) => model.id === 'glm-4.7-flash:q4_K_M')?.label).toBe(
      'GLM-4.7-Flash (30B-A3B Q4)'
    )
    expect(models.find((model) => model.id === 'north-mini-code-1.0:q4_K_M')?.label).toBe(
      'North Mini Code 1.0 (30B-A3B Q4)'
    )
    expect(models.find((model) => model.id === 'llama3.2:3b')?.label).toBe('Llama 3.2 (3B Param)')
  })
})
