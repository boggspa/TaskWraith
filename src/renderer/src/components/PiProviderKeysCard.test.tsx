import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  PI_CARD_UPSTREAMS,
  PiProviderKeysCardView,
  type PiProviderKeysCardViewProps
} from './PiProviderKeysCard'

function render(overrides: Partial<PiProviderKeysCardViewProps> = {}): string {
  const props: PiProviderKeysCardViewProps = {
    status: { encryptionAvailable: true, configuredUpstreams: [], recordUnreadable: false },
    binaryAvailable: true,
    drafts: {},
    busyUpstream: null,
    error: null,
    onDraftChange: () => {},
    onSave: () => {},
    onClear: () => {},
    ...overrides
  }
  return renderToStaticMarkup(<PiProviderKeysCardView {...props} />)
}

describe('PiProviderKeysCardView', () => {
  it('lists exactly the allowlisted upstreams and no hosted providers', () => {
    const html = render()
    for (const upstream of PI_CARD_UPSTREAMS) {
      expect(html, upstream.id).toContain(upstream.label)
    }
    // The wall, restated as a UI invariant: the card must never offer a lane
    // to a provider TaskWraith hosts first-party.
    for (const forbidden of ['Anthropic', 'OpenAI', 'OpenRouter', 'GitHub Copilot', 'Kimi']) {
      expect(html, forbidden).not.toContain(`>${forbidden}<`)
    }
    expect(PI_CARD_UPSTREAMS).toHaveLength(7)
  })

  it('reports the configured count and marks configured rows', () => {
    const html = render({
      status: {
        encryptionAvailable: true,
        configuredUpstreams: ['deepseek', 'groq'],
        recordUnreadable: false
      }
    })
    expect(html).toContain('2 upstream keys configured')
    expect(html).toContain('settings-provider-auth-card-signed-in')
    expect(html).toContain('Key stored — replace…')

    const single = render({
      status: {
        encryptionAvailable: true,
        configuredUpstreams: ['zai'],
        recordUnreadable: false
      }
    })
    expect(single).toContain('1 upstream key configured')
  })

  it('says no keys yet when nothing is stored', () => {
    const html = render()
    expect(html).toContain('No upstream keys yet')
    expect(html).toContain('settings-provider-auth-card-partial')
  })

  it('flags a missing CLI without claiming keys are usable', () => {
    const html = render({ binaryAvailable: false })
    expect(html).toContain('Pi CLI not installed')
    expect(html).toContain('settings-provider-auth-card-not-available')
    expect(html).toContain('npm install -g @earendil-works/pi-coding-agent')
  })

  it('surfaces the unreadable-record recovery path and encryption failures', () => {
    const unreadable = render({
      status: { encryptionAvailable: true, configuredUpstreams: [], recordUnreadable: true }
    })
    expect(unreadable).toContain('Clear all Pi keys to recover')

    const noEncryption = render({
      status: { encryptionAvailable: false, configuredUpstreams: [], recordUnreadable: false }
    })
    expect(noEncryption).toContain('keychain encryption is unavailable')
  })

  it('renders key inputs as password fields that never echo a stored value', () => {
    const html = render({
      status: {
        encryptionAvailable: true,
        configuredUpstreams: ['deepseek'],
        recordUnreadable: false
      },
      drafts: { deepseek: 'typed-draft' }
    })
    expect(html).toContain('type="password"')
    // Only the in-flight draft may appear; stored keys never reach the view.
    expect(html).toContain('value="typed-draft"')
  })

  it('states the first-party boundary in user-facing copy', () => {
    const html = render()
    expect(html).toContain('never reachable')
  })
})
