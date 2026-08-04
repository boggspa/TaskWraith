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

describe('ExternalPathGrantPromptCard — grant failure surface', () => {
  it('renders the missing-path remedy instead of the dead Grant action', () => {
    const html = renderToStaticMarkup(
      <ExternalPathGrantPromptCard
        gaps={[{ path: '/gone/workspace', access: 'read', missingProviders: ['codex'] }]}
        trigger="preflight"
        error={{ reason: 'missing-path', path: '/gone/workspace' }}
        onGrant={() => {}}
        onDismiss={() => {}}
        onRemoveMissingPath={() => {}}
      />
    )
    expect(html).toContain('no longer exists on disk')
    expect(html).toContain('Remove missing workspace')
    expect(html).not.toContain('Grant workspace access')
  })

  it('renders a generic failure line for non-missing reasons and keeps the Grant action', () => {
    const html = renderToStaticMarkup(
      <ExternalPathGrantPromptCard
        gaps={[{ path: '/tmp/extra', access: 'read', missingProviders: ['codex'] }]}
        trigger="preflight"
        error={{ reason: 'cancelled' }}
        onGrant={() => {}}
        onDismiss={() => {}}
      />
    )
    expect(html).toContain('grant access (cancelled)')
    expect(html).toContain('Grant workspace access')
  })
})
