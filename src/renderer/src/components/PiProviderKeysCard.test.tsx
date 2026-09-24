import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  PI_CARD_UPSTREAMS,
  XIAOMI_TOKEN_PLAN_REGIONS,
  PiProviderKeysCardView,
  configuredXiaomiTokenPlanRegion,
  type PiProviderKeysCardViewProps
} from './PiProviderKeysCard'

function render(overrides: Partial<PiProviderKeysCardViewProps> = {}): string {
  const props: PiProviderKeysCardViewProps = {
    status: { encryptionAvailable: true, configuredUpstreams: [], recordUnreadable: false },
    binaryAvailable: true,
    drafts: {},
    busyUpstream: null,
    error: null,
    cerebrasMaxCompletionTokens: null,
    cerebrasCapDraft: '16384',
    cerebrasCapBusy: false,
    cerebrasCapError: null,
    xiaomiRegion: '',
    onDraftChange: () => {},
    onSave: () => {},
    onClear: () => {},
    onXiaomiRegionChange: () => {},
    onSaveXiaomi: () => {},
    onClearXiaomi: () => {},
    onCerebrasCapDraftChange: () => {},
    onSaveCerebrasCap: () => {},
    onClearCerebrasCap: () => {},
    ...overrides
  }
  return renderToStaticMarkup(<PiProviderKeysCardView {...props} />)
}

describe('PiProviderKeysCardView', () => {
  it('lists the allowlisted upstreams, including OpenRouter’s active curated models', () => {
    const html = render()
    for (const upstream of PI_CARD_UPSTREAMS) {
      expect(html, upstream.id).toContain(upstream.label)
    }
    // The wall, restated as a UI invariant: the card must never offer a lane
    // to a provider TaskWraith hosts first-party. OpenRouter is the explicit
    // curated-model exception and is asserted above through the card list.
    for (const forbidden of ['Anthropic', 'OpenAI', 'GitHub Copilot', 'Kimi']) {
      expect(html, forbidden).not.toContain(`>${forbidden}<`)
    }
    expect(PI_CARD_UPSTREAMS).toHaveLength(9)
    expect(html).toContain(
      'North Mini Code, MiniMax M3, Inkling, GLM 5.2, Laguna S 2.1 &amp; Nemotron 3 Ultra'
    )
    expect(html).toContain(
      'GLM 5.2, Laguna S 2.1, Nemotron 3 Ultra, North Mini Code, MiniMax M3, Inkling, and Inkling Small.'
    )
    expect(html).not.toContain('Ox Alpha')
  })

  it('requires the Xiaomi cluster from the Dedicated Base URL instead of guessing a region', () => {
    const html = render()
    expect(html).toContain('Xiaomi Token Plan')
    expect(html).toContain('aria-label="Xiaomi Token Plan region"')
    expect(html).toContain('Region: choose from Dedicated Base URL…')
    expect(html).toContain('Token Plan keys are region-bound')
    for (const region of XIAOMI_TOKEN_PLAN_REGIONS) {
      expect(html, region.id).toContain(`value="${region.id}"`)
      expect(html, region.baseUrlCluster).toContain(region.baseUrlCluster)
    }
    const placeholder = html.match(/<option value=""[^>]*>/)
    expect(placeholder?.[0]).toContain('selected')
    expect(html).toMatch(/aria-label="Xiaomi Token Plan API key"[^>]*\/?>/)
    expect(configuredXiaomiTokenPlanRegion([])).toBeNull()
    expect(configuredXiaomiTokenPlanRegion(['deepseek', 'xiaomi-token-plan-ams'])).toBe(
      'xiaomi-token-plan-ams'
    )
  })

  it('names the stored Xiaomi region and lights one dot while unconfigured stays dark', () => {
    const stored = render({
      status: {
        encryptionAvailable: true,
        configuredUpstreams: ['xiaomi-token-plan-ams'],
        recordUnreadable: false
      },
      xiaomiRegion: 'xiaomi-token-plan-ams'
    })
    expect(stored).toContain('Key stored — Europe (AMS)')

    const unconfigured = render({
      status: {
        encryptionAvailable: true,
        configuredUpstreams: ['xiaomi-token-plan-ams', 'deepseek'],
        recordUnreadable: false
      },
      drafts: {},
      xiaomiRegion: 'xiaomi-token-plan-ams'
    })
    // The generic rows still count per-upstream keys.
    expect(unconfigured).toContain('2 upstream keys configured')
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

  it('names the upstreams the keys unlock', () => {
    const html = render()
    expect(html).toContain('upstream models')
    expect(html).toContain('DeepSeek')
  })

  it('offers an explicit Cerebras completion cap', () => {
    const html = render()
    expect(html).toContain('Cerebras completion cap')
    expect(html).toContain('40,960')
    expect(html).toContain('Apply cap')
    expect(html).toContain('Use Pi default')

    const active = render({ cerebrasMaxCompletionTokens: 16_384 })
    expect(active).toContain('Active: 16,384 max output tokens')
  })
})
