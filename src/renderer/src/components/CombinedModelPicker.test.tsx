import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CombinedModelPicker,
  flattenUnifiedProviderModels,
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

  it('does not surface stale Fast state for Fable 5', () => {
    const renderPicker = (selectedModelId: string) =>
      renderToStaticMarkup(
        <CombinedModelPicker
          provider="claude"
          composerStyle="claude"
          modelOptions={[
            { id: 'claude-opus-4-8-1m', label: 'Claude Opus 4.8 1M' },
            { id: 'claude-fable-5', label: 'Claude Fable 5' }
          ]}
          selectedModelId={selectedModelId}
          onSelectModel={() => undefined}
          reasoningOptions={[{ value: 'medium', label: 'Medium' }]}
          selectedReasoning="medium"
          onSelectReasoning={() => undefined}
          fastModeCapableModelIds={new Set(['claude-opus-4-8-1m'])}
          fastModeEnabled
          onToggleFastMode={() => undefined}
        />
      )

    expect(renderPicker('claude-fable-5')).toContain('data-fast-mode-active="false"')
    expect(renderPicker('claude-opus-4-8-1m')).toContain('data-fast-mode-active="true"')
  })

  it('places provider identity between the Fast glyph and model label', () => {
    const html = renderToStaticMarkup(
      <CombinedModelPicker
        provider="codex"
        composerStyle="default"
        modelOptions={[{ id: 'gpt-5.5', label: 'GPT-5.5' }]}
        providerGroups={[
          {
            provider: 'codex',
            label: 'Codex',
            modelOptions: [{ id: 'gpt-5.5', label: 'GPT-5.5' }],
            fastModeCapableModelIds: new Set(['gpt-5.5'])
          }
        ]}
        selectedModelId="gpt-5.5"
        onSelectModel={() => undefined}
        onSelectProviderModel={() => undefined}
        reasoningOptions={[{ value: 'medium', label: 'Medium' }]}
        selectedReasoning="medium"
        onSelectReasoning={() => undefined}
        fastModeCapableModelIds={new Set(['gpt-5.5'])}
        fastModeEnabled
        onToggleFastMode={() => undefined}
      />
    )

    const fastIndex = html.indexOf('composer-combined-picker-trigger-fast-bolt')
    const providerIndex = html.indexOf('composer-combined-picker-trigger-provider')
    const modelIndex = html.indexOf('composer-combined-picker-trigger-primary')
    expect(fastIndex).toBeGreaterThan(-1)
    expect(providerIndex).toBeGreaterThan(fastIndex)
    expect(modelIndex).toBeGreaterThan(providerIndex)
    expect(html).toContain('sidebar-provider-icon provider-codex')
    expect(html).toContain('>Codex<')
  })

  it('flattens provider groups without losing provider order or duplicate model ids', () => {
    const entries = flattenUnifiedProviderModels([
      {
        provider: 'codex',
        modelOptions: [
          { id: 'shared', label: 'Codex Shared' },
          { id: 'codex-only', label: 'Codex Only' }
        ]
      },
      {
        provider: 'claude',
        modelOptions: [{ id: 'shared', label: 'Claude Shared' }]
      }
    ])

    expect(entries.map((entry) => `${entry.provider}:${entry.option.id}`)).toEqual([
      'codex:shared',
      'codex:codex-only',
      'claude:shared'
    ])
  })

  it('keeps the unified model rail fixed-height and independently scrollable', () => {
    const css = readFileSync(
      new URL('../assets/css/08-theme-picker-overrides.css', import.meta.url),
      'utf8'
    )
    expect(css).toMatch(
      /\.composer-combined-picker-popover\.is-unified-provider-picker\s*\{[\s\S]*?height:\s*min\(322px, calc\(100vh - 24px\)\);/
    )
    expect(css).toMatch(
      /\.composer-combined-picker-models\.is-unified-model-list\s*\{[\s\S]*?overflow-y:\s*auto;/
    )
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
