import { describe, expect, it } from 'vitest'
import { mergeOllamaModelCatalog, ollamaModelCatalogKey } from './ollamaModelCatalog'

describe('mergeOllamaModelCatalog', () => {
  it('keeps curated human labels when live Ollama returns raw model tags', () => {
    const models = mergeOllamaModelCatalog([{ id: 'lfm2.5:8b', label: 'lfm2.5:8b' }])

    expect(models.find((model) => model.id === 'lfm2.5:8b')?.label).toBe(
      'LFM 2.5 (8B-A1B)'
    )
  })

  it('keeps the curated Laguna label when live Ollama returns the raw Q8 tag', () => {
    const models = mergeOllamaModelCatalog([
      { id: 'laguna-xs-2.1:q8_0', label: 'laguna-xs-2.1:q8_0' }
    ])

    expect(models.find((model) => model.id === 'laguna-xs-2.1:q8_0')?.label).toBe(
      'Laguna XS 2.1 (33B-A3B Q8)'
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

    expect(models.find((model) => model.id === 'llama3.1:8b')?.label).toBe(
      'Llama 3.1 (8B Param)'
    )
    expect(models.find((model) => model.id === 'deepseek-r1:8b')?.label).toBe(
      'DeepSeek R1 (8B Param)'
    )
    expect(models.filter((model) => ollamaModelCatalogKey(model.id) === 'rnj-1')).toHaveLength(1)
    expect(models.find((model) => model.id === 'glm-4.7-flash:q4_K_M')?.label).toBe(
      'GLM-4.7-Flash (30B-A3B Q4)'
    )
    expect(models.find((model) => model.id === 'north-mini-code-1.0:q4_K_M')?.label).toBe(
      'North Mini Code 1.0 (30B-A3B Q4)'
    )
    expect(models.find((model) => model.id === 'llama3.2:3b')?.label).toBe(
      'Llama 3.2 (3B Param)'
    )
  })
})
