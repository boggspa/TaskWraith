import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  CombinedModelPicker,
  getCombinedModelPickerResetSignature,
  resolveCombinedModelPickerResetState
} from './CombinedModelPicker'

describe('CombinedModelPicker', () => {
  it('exposes Ultracode reasoning hooks for Claude composer styling', () => {
    const html = renderToStaticMarkup(
      <CombinedModelPicker
        provider="claude"
        composerStyle="claude"
        modelOptions={[{ id: 'claude-opus-4-8-1m', label: 'Claude Opus 4.8 1M' }]}
        selectedModelId="claude-opus-4-8-1m"
        onSelectModel={() => undefined}
        reasoningOptions={[{ value: 'ultracode', label: 'Ultracode' }]}
        selectedReasoning="ultracode"
        onSelectReasoning={() => undefined}
        claudeReasoningEffort="ultracode"
      />
    )

    expect(html).toContain('data-provider="claude"')
    expect(html).toContain('data-selected-reasoning="ultracode"')
    expect(html).toContain('Opus 4.8 1M')
    expect(html).toContain('Ultracode')
  })

  it('initializes the Ollama provider column from the selected model only', () => {
    const resetState = resolveCombinedModelPickerResetState({
      isOllamaProviderPicker: true,
      ollamaProviderGroups: [
        {
          id: 'alibaba',
          label: 'Alibaba',
          providerClass: 'alibaba',
          models: [
            { id: 'qwen3:4b-instruct', label: 'Qwen 3 (4B Param)' },
            { id: 'qwen3.5:9b', label: 'Qwen 3.5 (9B Param)' }
          ]
        },
        {
          id: 'ibm',
          label: 'IBM',
          providerClass: 'ibm',
          models: [
            { id: 'granite4.1:3b', label: 'Granite 4.1 (3B Param)' },
            { id: 'granite4.1:30b', label: 'Granite 4.1 (30B Param)' }
          ]
        }
      ],
      modelOptions: [
        { id: 'qwen3:4b-instruct', label: 'Qwen 3 (4B Param)' },
        { id: 'granite4.1:3b', label: 'Granite 4.1 (3B Param)' }
      ],
      selectedModelId: 'qwen3.5:9b',
      selectedOllamaProviderId: 'alibaba',
      reasoningOptions: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' }
      ],
      selectedReasoning: 'medium'
    })

    expect(resetState).toEqual({
      providerIndex: 0,
      activeOllamaProviderId: 'alibaba',
      modelIndex: 1,
      reasoningIndex: 1,
      focusedColumn: 'provider'
    })
  })

  it('does not include transient Ollama browsing state in the reset signature', () => {
    const beforeBrowse = getCombinedModelPickerResetSignature({
      provider: 'ollama',
      isOllamaProviderPicker: true,
      selectedModelId: 'qwen3:4b-instruct'
    })
    const afterCatalogRefreshOrProviderHover = getCombinedModelPickerResetSignature({
      provider: 'ollama',
      isOllamaProviderPicker: true,
      selectedModelId: 'qwen3:4b-instruct'
    })
    const afterCommittedModelChange = getCombinedModelPickerResetSignature({
      provider: 'ollama',
      isOllamaProviderPicker: true,
      selectedModelId: 'granite4.1:30b'
    })

    expect(afterCatalogRefreshOrProviderHover).toBe(beforeBrowse)
    expect(afterCommittedModelChange).not.toBe(beforeBrowse)
  })
})
