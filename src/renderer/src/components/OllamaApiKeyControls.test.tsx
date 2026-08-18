import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  OllamaApiKeyControlsView,
  type OllamaApiKeyControlsViewProps
} from './OllamaApiKeyControls'

/** No jsdom in this repo, so only the pure view is exercised (SSR markup). */
function render(overrides: Partial<OllamaApiKeyControlsViewProps> = {}): string {
  const props: OllamaApiKeyControlsViewProps = {
    status: {
      apiKeyConfigured: false,
      encryptionAvailable: true,
      webSessionConfigured: false
    },
    draft: '',
    busy: false,
    error: null,
    onDraftChange: () => {},
    onSave: () => {},
    onClear: () => {},
    webSessionDraft: '',
    onWebSessionChange: () => {},
    onSaveWebSession: () => {},
    onImportWebSession: () => {},
    onClearWebSession: () => {},
    ...overrides
  }
  return renderToStaticMarkup(<OllamaApiKeyControlsView {...props} />)
}

describe('OllamaApiKeyControlsView', () => {
  it('shows encrypted direct-API storage separately from the web session', () => {
    const html = render({
      status: { apiKeyConfigured: true, encryptionAvailable: true, webSessionConfigured: false }
    })

    expect(html).toContain('Ollama Cloud API key')
    expect(html).toContain('Stored for direct Cloud requests')
    expect(html).toContain('Key stored — replace…')
    expect(html).toContain('Ollama web session')
    expect(html).toContain('Cloud usage dashboard')
    expect(html).toContain('__Secure-session')
  })

  it('reports the web session state through the dot, hint, and placeholder', () => {
    const before = render()
    expect(before).toContain('Needed to track Session (5H) and Weekly usage')
    expect(before).toContain('__Secure-session cookie…')

    const after = render({
      status: { apiKeyConfigured: false, encryptionAvailable: true, webSessionConfigured: true }
    })
    expect(after).toContain('Tracking Session (5H) and Weekly usage')
    expect(after).toContain('Session stored — replace…')
    // One dot per credential; only the web-session one is signed in here.
    expect(after.match(/status-dot-signed-in/g)?.length).toBe(1)
    expect(after.match(/status-dot-not-available/g)?.length).toBe(1)
  })

  it('arms Clear only once a session is actually stored', () => {
    // The first cut wired the session Clear to the API key's configured flag
    // (and its onClick to a no-op); the session state must drive it now.
    const before = render({
      status: { apiKeyConfigured: true, encryptionAvailable: true, webSessionConfigured: false }
    })
    expect((before.match(/disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(3)

    const after = render({
      status: { apiKeyConfigured: true, encryptionAvailable: true, webSessionConfigured: true },
      webSessionDraft: 'pasted'
    })
    expect((after.match(/disabled=""/g) ?? []).length).toBeLessThanOrEqual(1)
  })

  it('disables key entry when system encryption is unavailable', () => {
    const html = render({
      status: { apiKeyConfigured: false, encryptionAvailable: false, webSessionConfigured: false },
      draft: 'secret'
    })

    expect(html).toContain('System keychain encryption is unavailable')
    expect(html).toContain('disabled=""')
  })
})
