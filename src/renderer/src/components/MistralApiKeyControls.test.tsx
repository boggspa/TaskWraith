import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MistralApiKeyControlsView } from './MistralApiKeyControls'

describe('MistralApiKeyControlsView', () => {
  it('renders configured state with stored indicator', () => {
    const html = renderToStaticMarkup(
      <MistralApiKeyControlsView
        status={{ configured: true, encryptionAvailable: true }}
        draft=""
        busy={false}
        error={null}
        onDraftChange={() => {}}
        onSave={() => {}}
        onClear={() => {}}
      />
    )

    expect(html).toContain('Mistral API key (BYOK)')
    expect(html).toContain('Stored for metered API runs')
    expect(html).toContain('Key stored — replace…')
    expect(html).toContain('settings-provider-auth-status-dot-signed-in')
    expect(html).toContain('Mistral Large 3, GLM 5.2, Codestral, Devstral 2, and Ministral models')
  })

  it('renders unconfigured state with input prompt', () => {
    const html = renderToStaticMarkup(
      <MistralApiKeyControlsView
        status={{ configured: false, encryptionAvailable: true }}
        draft="test-key"
        busy={false}
        error={null}
        onDraftChange={() => {}}
        onSave={() => {}}
        onClear={() => {}}
      />
    )

    expect(html).toContain('Optional alternative to Vibe subscription')
    expect(html).toContain('api.mistral.ai key…')
    expect(html).toContain('settings-provider-auth-status-dot-not-available')
  })

  it('shows footnote when keychain encryption is unavailable and disables input', () => {
    const html = renderToStaticMarkup(
      <MistralApiKeyControlsView
        status={{ configured: false, encryptionAvailable: false }}
        draft=""
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

  it('renders error message when present', () => {
    const html = renderToStaticMarkup(
      <MistralApiKeyControlsView
        status={{ configured: true, encryptionAvailable: true }}
        draft=""
        busy={false}
        error="Could not store the Mistral API key."
        onDraftChange={() => {}}
        onSave={() => {}}
        onClear={() => {}}
      />
    )

    expect(html).toContain('Could not store the Mistral API key.')
  })
})
