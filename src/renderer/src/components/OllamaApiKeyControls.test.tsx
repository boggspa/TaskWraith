import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OllamaApiKeyControlsView } from './OllamaApiKeyControls'

describe('OllamaApiKeyControlsView', () => {
  it('shows encrypted direct-API storage separately from dashboard-only usage', () => {
    const html = renderToStaticMarkup(
      <OllamaApiKeyControlsView
        status={{ apiKeyConfigured: true, encryptionAvailable: true }}
        draft=""
        busy={false}
        error={null}
        onDraftChange={() => {}}
        onSave={() => {}}
        onClear={() => {}}
      />
    )

    expect(html).toContain('Ollama Cloud API key')
    expect(html).toContain('Stored for direct Cloud requests')
    expect(html).toContain('Key stored — replace…')
    expect(html).toContain('Cloud usage dashboard')
    expect(html).toContain('not through a supported API, CLI, or local-daemon quota endpoint')
    expect(html).toContain('TaskWraith does not import browser cookies')
  })

  it('disables key entry when system encryption is unavailable', () => {
    const html = renderToStaticMarkup(
      <OllamaApiKeyControlsView
        status={{ apiKeyConfigured: false, encryptionAvailable: false }}
        draft="secret"
        busy={false}
        error={null}
        onDraftChange={() => {}}
        onSave={() => {}}
        onClear={() => {}}
      />
    )

    expect(html).toContain('System keychain encryption is unavailable')
    expect(html).toContain('disabled=""')
  })
})
