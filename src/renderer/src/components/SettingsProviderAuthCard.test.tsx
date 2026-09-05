import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ProviderAuthSummary } from '../lib/providerAuthSummary'
import { SettingsProviderAuthCard } from './SettingsProviderAuthCard'

function summary(variant: ProviderAuthSummary['variant']): ProviderAuthSummary {
  return { variant, statusText: 'Status text', hint: 'Hint text' }
}

describe('SettingsProviderAuthCard', () => {
  it('renders label, status, description, and hint with provider-scoped classes', () => {
    const html = renderToStaticMarkup(
      <SettingsProviderAuthCard
        provider="codex"
        label="Codex"
        summary={summary('signed-in')}
        description="Description text"
      />
    )

    expect(html).toContain(
      'settings-provider-auth-card settings-provider-auth-card-signed-in provider-codex'
    )
    expect(html).toContain('data-provider="codex"')
    expect(html).toContain('<strong>Codex</strong>')
    expect(html).toContain('Status text')
    expect(html).toContain('Description text')
    expect(html).toContain('settings-provider-auth-hint')
    expect(html).toContain('Hint text')
    expect(html).toContain('settings-provider-auth-status-dot-signed-in')
  })

  it('shows the Optional badge only when optional', () => {
    const withBadge = renderToStaticMarkup(
      <SettingsProviderAuthCard
        provider="muse"
        label="Muse"
        summary={summary('signed-in')}
        description="d"
        optional
      />
    )
    const withoutBadge = renderToStaticMarkup(
      <SettingsProviderAuthCard
        provider="muse"
        label="Muse"
        summary={summary('signed-in')}
        description="d"
      />
    )

    expect(withBadge).toContain('settings-provider-auth-optional')
    expect(withoutBadge).not.toContain('settings-provider-auth-optional')
  })

  it('wraps children in the actions row only when children exist', () => {
    const withChildren = renderToStaticMarkup(
      <SettingsProviderAuthCard
        provider="kimi"
        label="Kimi"
        summary={summary('not-available')}
        description="d"
      >
        <button>Connect</button>
      </SettingsProviderAuthCard>
    )
    const withoutChildren = renderToStaticMarkup(
      <SettingsProviderAuthCard
        provider="kimi"
        label="Kimi"
        summary={summary('not-available')}
        description="d"
      />
    )

    expect(withChildren).toContain('settings-provider-auth-actions')
    expect(withChildren).toContain('<button>Connect</button>')
    expect(withoutChildren).not.toContain('settings-provider-auth-actions')
  })

  it('maps out-of-usage to the amber partial dot', () => {
    const html = renderToStaticMarkup(
      <SettingsProviderAuthCard
        provider="codex"
        label="Codex"
        summary={summary('out-of-usage')}
        description="d"
      />
    )

    // The card keeps the true variant; only the dot borrows the warning styling.
    expect(html).toContain('settings-provider-auth-card-out-of-usage')
    expect(html).toContain('settings-provider-auth-status-dot-partial')
    expect(html).not.toContain('settings-provider-auth-status-dot-out-of-usage')
  })

  it('maps cursor and grok partial to the ready signed-in dot, but not other providers', () => {
    const cursor = renderToStaticMarkup(
      <SettingsProviderAuthCard
        provider="cursor"
        label="Cursor"
        summary={summary('partial')}
        description="d"
      />
    )
    const grok = renderToStaticMarkup(
      <SettingsProviderAuthCard
        provider="grok"
        label="Grok"
        summary={summary('partial')}
        description="d"
      />
    )
    const ollama = renderToStaticMarkup(
      <SettingsProviderAuthCard
        provider="ollama"
        label="Ollama"
        summary={summary('partial')}
        description="d"
      />
    )

    expect(cursor).toContain('settings-provider-auth-status-dot-signed-in')
    expect(grok).toContain('settings-provider-auth-status-dot-signed-in')
    expect(ollama).toContain('settings-provider-auth-status-dot-partial')
    expect(ollama).not.toContain('settings-provider-auth-status-dot-signed-in')
  })
})
