import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PI_MODEL_LABELS, PI_UPSTREAM_BRANDS } from '../../../shared/piBrandTable'
import {
  CombinedModelPicker,
  CombinedModelPickerConfirmButton,
  emptyProviderModelsLabel,
  flattenUnifiedProviderModels,
  getCombinedModelPickerResetSignature,
  modelPickerHueClass,
  resolveCombinedModelPickerResetState,
  resolveCombinedPickerPosition
} from './CombinedModelPicker'
import { ModelApiKeyIndicator } from './ModelApiKeyIndicator'
import { API_KEY_MODEL_INDICATOR_LABEL } from '../../../shared/apiKeyModelIndicator'

describe('CombinedModelPicker', () => {
  it('uses shared compact primary chrome for confirmation actions', () => {
    const html = renderToStaticMarkup(
      <CombinedModelPickerConfirmButton
        action={{ label: 'Add participant', onConfirm: () => undefined }}
      />
    )

    expect(html).toContain(
      'class="segmented-control-action segmented-control-action--compact composer-combined-picker-confirm"'
    )
    expect(html).not.toContain('segmented-control-action--primary')
    expect(html).toContain('>Add participant</button>')

    const css = readFileSync(
      new URL('../assets/css/08-theme-picker-overrides.css', import.meta.url),
      'utf8'
    )
    const confirmLayoutRule = css.match(/\.composer-combined-picker-confirm\s*\{([^}]*)\}/)?.[1]
    expect(confirmLayoutRule).toBeDefined()
    expect(confirmLayoutRule).toContain('--segmented-action-foreground: var(--accent)')
    expect(confirmLayoutRule).toContain('var(--accent) 38%')
    expect(confirmLayoutRule).toContain('var(--accent) 10%')
    expect(confirmLayoutRule).toContain('var(--accent) 18%')
    expect(confirmLayoutRule).not.toMatch(
      /(?:^|\n)\s*(?:background|border|padding|min-height)\s*:/
    )
  })

  // Model labels no longer spell out their lane ("Gemini API: 2.5 Flash-Lite"
  // truncated to noise in a narrow picker), so this glyph is the only remaining
  // signal that a row bills per token.
  //
  // The picker's own rows are unreachable here: the popover mounts only behind
  // internal `open` state AND a measured anchor position, so renderToStaticMarkup
  // yields the trigger alone. Hence the mark lives in ModelApiKeyIndicator and is
  // covered directly; which rows receive it is covered by the predicate's own
  // suite in shared/apiKeyModelIndicator.test.ts.
  describe('API-key indicator', () => {
    it('renders the mark with its class hook and billing tooltip', () => {
      const html = renderToStaticMarkup(<ModelApiKeyIndicator />)

      expect(html).toContain('class="composer-combined-picker-api-indicator"')
      expect(html).toContain(`title="${API_KEY_MODEL_INDICATOR_LABEL}"`)
      expect(html).toContain(`aria-label="${API_KEY_MODEL_INDICATOR_LABEL}"`)
      expect(html).toContain('class="api-key-required-icon"')
      // Inherits row colour like the Fast bolt rather than hard-coding a fill.
      expect(html).toContain('stroke="currentColor"')
      expect(html).not.toMatch(/stroke="#|fill="#/)
    })

    // A wide, short glyph: forcing the Fast bolt's preserveAspectRatio="none"
    // would squash the circular key bow into an ellipse and read as a bug.
    it('scales proportionally, unlike the deliberately warped Fast bolt', () => {
      const html = renderToStaticMarkup(<ModelApiKeyIndicator />)
      expect(html).not.toContain('preserveAspectRatio="none"')
    })

    it('keeps the artwork identical to the shipped design asset', () => {
      const asset = readFileSync(
        new URL('../../../../design-assets/api-key-required/api-key-required.svg', import.meta.url),
        'utf8'
      )
      const html = renderToStaticMarkup(<ModelApiKeyIndicator />)
      const assetPaths = [...asset.matchAll(/ d="([^"]+)"/g)].map((match) => match[1])
      expect(assetPaths.length).toBeGreaterThan(0)
      for (const path of assetPaths) {
        expect(html).toContain(path)
      }
      // The bow is a circle element, not a path — check it survived the trace.
      expect(html).toContain('cx="17.5"')
    })

    it('keeps the glyph styled in lockstep with the Fast bolt', () => {
      const css = readFileSync(
        new URL('../assets/css/08-theme-picker-overrides.css', import.meta.url),
        'utf8'
      )
      expect(css).toContain('.composer-combined-picker-api-indicator {')
      expect(css).toContain('.api-key-required-icon {')
      // Both marks must brighten on the selected/highlighted row, or the API
      // glyph would visibly fade out exactly where the Fast bolt lights up.
      for (const state of ['is-selected', 'is-highlighted']) {
        expect(css).toContain(
          `.composer-combined-picker-row.${state} .composer-combined-picker-api-indicator`
        )
      }
    })
  })

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
    expect(html).toContain('sidebar-provider-icon provider-brand-logo-icon provider-codex')
    expect(html).toContain('data-provider-logo="codex"')
    expect(html).toContain('<img class="provider-brand-logo-image')
    expect(html).not.toContain('provider-glyph-codex')
    expect(html).toContain('>Codex<')
  })

  it('uses the selected Ollama model spoof hue without changing its runtime provider or mark', () => {
    const model = { id: 'qwen3.5:9b', label: 'Qwen 3.5 (9B Param)' }
    const html = renderToStaticMarkup(
      <CombinedModelPicker
        provider="ollama"
        composerStyle="default"
        modelOptions={[model]}
        providerGroups={[{ provider: 'ollama', label: 'Ollama', modelOptions: [model] }]}
        selectedModelId={model.id}
        onSelectModel={() => undefined}
        onSelectProviderModel={() => undefined}
        reasoningOptions={[]}
        selectedReasoning=""
        onSelectReasoning={() => undefined}
      />
    )

    expect(html).toContain('data-provider="ollama"')
    expect(html).toContain('data-provider-hue="alibaba"')
    expect(html).toContain('--chip-accent:var(--provider-alibaba-color, var(--accent))')
    expect(html).toContain('>Alibaba<')
    expect(html).toContain('data-provider-logo="ollama"')
    expect(html).toContain('<img class="provider-brand-logo-image')
    expect(html).not.toContain('provider-glyph-ollama')
    // The spoof hue remains on the surrounding chip; official artwork is not tinted.
    expect(html).not.toContain('--provider-accent:')
  })

  it('derives the AntiGravity reasoning hue hook from the concrete model id', () => {
    const model = { id: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash' }
    const html = renderToStaticMarkup(
      <CombinedModelPicker
        provider="antigravity"
        composerStyle="gemini"
        modelOptions={[model]}
        selectedModelId={model.id}
        onSelectModel={() => undefined}
        reasoningOptions={[]}
        selectedReasoning=""
        onSelectReasoning={() => undefined}
      />
    )

    // The effort is part of the agy wire id, so it remains accurate even
    // while the picker has no separate slider selection during a refresh.
    expect(html).toContain('data-provider="antigravity"')
    expect(html).toContain('data-provider-hue="antigravity"')
    expect(html).toContain('--chip-accent:var(--provider-antigravity-color, var(--accent))')
    expect(html).toContain('data-selected-reasoning="high"')
    expect(html).toContain('composer-combined-picker-trigger-suffix">High</span>')
  })

  it('uses every selected Pi model upstream hue without changing its runtime provider mark', () => {
    for (const [upstream, brand] of Object.entries(PI_UPSTREAM_BRANDS)) {
      const id = Object.keys(PI_MODEL_LABELS).find((model) =>
        model.startsWith(`${upstream}/`)
      )
      expect(id, `missing representative Pi model for ${upstream}`).toBeTruthy()
      const model = { id: id!, label: PI_MODEL_LABELS[id!] }
      const html = renderToStaticMarkup(
        <CombinedModelPicker
          provider="pi"
          composerStyle="default"
          modelOptions={[model]}
          providerGroups={[{ provider: 'pi', label: 'Pi', modelOptions: [model] }]}
          selectedModelId={model.id}
          onSelectModel={() => undefined}
          onSelectProviderModel={() => undefined}
          reasoningOptions={[]}
          selectedReasoning=""
          onSelectReasoning={() => undefined}
        />
      )

      expect(modelPickerHueClass('pi', model.id, model.label)).toBe(brand.hueClass)
      expect(html).toContain('data-provider="pi"')
      expect(html).toContain(`data-provider-hue="${brand.hueClass}"`)
      expect(html).toContain(
        `--chip-accent:var(--provider-${brand.hueClass}-color, var(--accent))`
      )
      expect(html).toContain('data-provider-logo="pi"')
    }
  })

  it('uses the model-row accent variable for row interactions and affordances', () => {
    const css = readFileSync(
      new URL('../assets/css/08-theme-picker-overrides.css', import.meta.url),
      'utf8'
    )
    const blocks = (selector: string): string[] =>
      [...css.matchAll(new RegExp(`${selector}\\s*\\{[\\s\\S]*?\\}`, 'g'))].map(
        (match) => match[0]
      )

    expect(css).toMatch(
      /\.composer-combined-picker-row:hover,\s*\.composer-combined-picker-row\.is-highlighted\s*\{[\s\S]*?var\(--model-row-accent, var\(--accent\)\)/
    )
    expect(
      blocks('\\.composer-combined-picker-check').some((block) =>
        block.includes('var(--model-row-accent, var(--accent))')
      )
    ).toBe(true)
    expect(
      blocks('\\.composer-combined-picker-fast-indicator').some((block) =>
        block.includes('var(--model-row-accent, var(--accent))')
      )
    ).toBe(true)
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

  it('opens below a high trigger and above a low trigger without leaving the viewport', () => {
    expect(
      resolveCombinedPickerPosition({
        triggerRect: { right: 500, top: 96, bottom: 124 },
        popoverWidth: 420,
        popoverHeight: 322,
        viewportWidth: 800,
        viewportHeight: 800
      })
    ).toEqual({ left: 80, top: 132 })

    expect(
      resolveCombinedPickerPosition({
        triggerRect: { right: 500, top: 700, bottom: 728 },
        popoverWidth: 420,
        popoverHeight: 322,
        viewportWidth: 800,
        viewportHeight: 800
      })
    ).toEqual({ left: 80, top: 370 })
  })

  it('clamps the picker when neither side has its full fixed height', () => {
    expect(
      resolveCombinedPickerPosition({
        triggerRect: { right: 390, top: 290, bottom: 318 },
        popoverWidth: 420,
        popoverHeight: 322,
        viewportWidth: 400,
        viewportHeight: 600
      })
    ).toEqual({ left: 8, top: 8 })
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

describe('emptyProviderModelsLabel', () => {
  it('never claims to be loading', () => {
    // The old text was "Loading models…" for every provider — the EMPTY state
    // wearing a pending one's clothes. It cost a real debugging session: an
    // empty Pi group read as "still fetching" rather than "there is nothing
    // here", so nobody looked for the missing wiring behind it.
    for (const provider of ['pi', 'ollama', 'codex', 'claude', undefined]) {
      expect(emptyProviderModelsLabel(provider)).not.toMatch(/loading/i)
    }
  })

  it('names the cause where the cause is actually knowable', () => {
    // Pi's catalog is filtered to upstreams with a stored key, so an empty
    // group means exactly one thing and the user can act on it.
    expect(emptyProviderModelsLabel('pi')).toMatch(/API key/i)
    expect(emptyProviderModelsLabel('pi')).toMatch(/Settings/)
    expect(emptyProviderModelsLabel('ollama')).toMatch(/local/i)
  })

  it('stays neutral for seats whose empty reason we do not know', () => {
    // Better a plain statement than an invented diagnosis.
    expect(emptyProviderModelsLabel('claude')).toBe('No models available')
    expect(emptyProviderModelsLabel(undefined)).toBe('No models available')
    expect(emptyProviderModelsLabel('PI')).toMatch(/API key/i)
  })
})
