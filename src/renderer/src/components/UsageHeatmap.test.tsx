import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { UsageHeatmap } from './UsageHeatmap'

describe('UsageHeatmap', () => {
  it('renders provider isolation controls without changing the all-provider chips', () => {
    const html = renderToStaticMarkup(
      <UsageHeatmap title="TaskWraith Activity" dayCount={90} showProviderFilter />
    )

    for (const label of [
      'All',
      'Codex',
      'Claude',
      'Gemini',
      'Kimi',
      'Grok',
      'Cursor',
      'Ollama',
      'AntiGravity',
      'Pi'
    ]) {
      expect(html).toContain(`>${label}</button>`)
    }
    expect(html).toContain('TaskWraith Activity')
    expect(html).toContain('TaskWraith Activity all-provider totals')
    expect(html).toContain('90D')
  })
})
