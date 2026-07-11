import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ModelUsageAggregate } from '../lib/usageAggregateTypes'
import { SettingsModelComparisonsTable } from './SettingsModelComparisonsTable'

function entry(overrides: Partial<ModelUsageAggregate>): ModelUsageAggregate {
  return {
    provider: 'codex',
    model: 'gpt-5.5',
    runs: 1,
    inputTokens: 750,
    outputTokens: 0,
    totalTokens: 750,
    durationMs: 0,
    ...overrides
  }
}

describe('SettingsModelComparisonsTable', () => {
  it('uses compact settings table chrome rather than dashboard meter cards', () => {
    const html = renderToStaticMarkup(
      <SettingsModelComparisonsTable
        entries={[
          entry({}),
          entry({
            provider: 'claude',
            model: 'claude-opus-4-8',
            inputTokens: 200,
            outputTokens: 50,
            totalTokens: 250
          })
        ]}
      />
    )

    expect(html).toContain('model-usage-table model-usage-table--comparisons')
    expect(html).toContain('<th scope="col">Input</th>')
    expect(html).toContain('<th scope="col">Output</th>')
    expect(html).toContain('GPT-5.5')
    expect(html).toContain('Claude Opus 4.8')
    expect(html).toContain('75.0%')
    expect(html).toContain('25.0%')
    expect(html).not.toContain('settings-model-comparison-row')
    expect(html).not.toContain('welcome-usage-model-meter')
  })

  it('renders nothing when there are no comparison entries', () => {
    expect(renderToStaticMarkup(<SettingsModelComparisonsTable entries={[]} />)).toBe('')
  })

  it('uses upstream brand hues for local Ollama models', () => {
    const html = renderToStaticMarkup(
      <SettingsModelComparisonsTable
        entries={[
          entry({
            provider: 'ollama',
            model: 'qwen3.5:9b',
            inputTokens: 100,
            totalTokens: 100
          })
        ]}
      />
    )

    expect(html).toContain('provider-alibaba')
    expect(html).toContain('Qwen 3.5 (9B Param)')
  })
})
