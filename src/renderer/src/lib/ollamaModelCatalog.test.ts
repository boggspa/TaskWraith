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
})
