import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PromptCacheSettingsSection } from './PromptCacheSettingsSection'

describe('PromptCacheSettingsSection (SSR)', () => {
  it('renders prompt caching section chrome', () => {
    const html = renderToStaticMarkup(<PromptCacheSettingsSection />)
    expect(html).toContain('Prompt caching')
    expect(html).toContain('prompt-cache-table-section')
    expect(html).toContain('Claude')
    expect(html).toContain('Codex')
    expect(html).not.toContain('Gemini')
  })
})