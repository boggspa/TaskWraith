import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ExternalPathGrantPromptCard } from './ExternalPathGrantPromptCard'

describe('ExternalPathGrantPromptCard', () => {
  it('shows only the workspace path in the grant row', () => {
    const html = renderToStaticMarkup(
      <ExternalPathGrantPromptCard
        gaps={[
          {
            path: '/Users/example/secondary-workspace',
            access: 'write',
            missingProviders: ['gemini', 'ollama']
          }
        ]}
        trigger="attach"
        onGrant={() => {}}
        onDismiss={() => {}}
      />
    )

    expect(html).toContain('/Users/example/secondary-workspace')
    expect(html).toContain('Confirm access before attaching this workspace to the chat.')
    expect(html).toContain('Additional workspace')
    expect(html).not.toContain('Needs')
    expect(html).not.toContain('Gemini')
    expect(html).not.toContain('Ollama')
    expect(html).not.toContain('panelist')
  })
})
