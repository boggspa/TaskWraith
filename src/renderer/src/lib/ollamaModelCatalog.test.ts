import { describe, expect, it } from 'vitest'
import { mergeOllamaModelCatalog, ollamaModelCatalogKey } from './ollamaModelCatalog'

describe('mergeOllamaModelCatalog', () => {
  it('keeps curated human labels when live Ollama returns raw model tags', () => {
    const models = mergeOllamaModelCatalog([{ id: 'lfm2.5:8b', label: 'lfm2.5:8b' }])

    expect(models.find((model) => model.id === 'lfm2.5:8b')?.label).toBe(
      'LFM 2.5 (8B-1A)'
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
