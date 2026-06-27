import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CombinedModelPicker } from './CombinedModelPicker'

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
})
