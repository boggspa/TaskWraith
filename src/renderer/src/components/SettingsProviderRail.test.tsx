import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  SETTINGS_PROVIDER_RAIL_ORDER,
  SETTINGS_PROVIDER_RAIL_STORAGE_KEY,
  SettingsProviderRail,
  resolveInitialSettingsProviderRailSelection,
  resolveSettingsProviderRailKeySelection,
  settingsProviderRailDotVariant,
  type SettingsProviderRailEntry,
  type SettingsProviderRailId
} from './SettingsProviderRail'
import type { ProviderAuthSummary } from '../lib/providerAuthSummary'

function summary(overrides: Partial<ProviderAuthSummary> = {}): ProviderAuthSummary {
  return { variant: 'not-signed-in', statusText: 'Not checked yet', hint: '', ...overrides }
}

function makeEntries(): SettingsProviderRailEntry[] {
  return SETTINGS_PROVIDER_RAIL_ORDER.map(({ id, group }) => ({
    id,
    group,
    label: id === 'api-usage' ? 'API usage' : id.charAt(0).toUpperCase() + id.slice(1),
    summary:
      id === 'codex'
        ? summary({ variant: 'signed-in', statusText: 'Signed in' })
        : id === 'cursor'
          ? summary({ variant: 'partial', statusText: 'Available · CLI sign-in' })
          : id === 'kimi'
            ? summary({ variant: 'out-of-usage', statusText: 'Usage window full' })
            : summary()
  }))
}

function tabOrder(html: string): string[] {
  return [...html.matchAll(/role="tab"[^>]*data-provider="([^"]+)"/g)].map((match) => match[1])
}

describe('SETTINGS_PROVIDER_RAIL_ORDER', () => {
  it('lists subscription sign-ins, then API/local providers, then AntiGravity last — never Gemini', () => {
    const ids = SETTINGS_PROVIDER_RAIL_ORDER.map((entry) => entry.id)
    expect(ids).toEqual([
      'codex',
      'claude',
      'kimi',
      'cursor',
      'grok',
      'muse',
      'devin',
      'ollama',
      'pi',
      'mistral',
      'api-usage',
      'antigravity'
    ])
    expect(ids).not.toContain('gemini')
    expect(ids.indexOf('ollama')).toBeLessThan(ids.indexOf('antigravity'))
    expect(ids[ids.length - 1]).toBe('antigravity')
    const groups = SETTINGS_PROVIDER_RAIL_ORDER.map((entry) => entry.group)
    // Groups are contiguous, in Provider Hub order.
    expect([...new Set(groups)]).toEqual(['subscription', 'api', 'conditional'])
  })
})

describe('SettingsProviderRail', () => {
  it('renders a vertical tablist of logo tabs in rail order with status dots and tooltips', () => {
    const html = renderToStaticMarkup(
      <SettingsProviderRail entries={makeEntries()} selectedId="codex" onSelect={() => {}} />
    )

    expect(html).toContain('class="settings-provider-rail" role="tablist"')
    expect(html).toContain('aria-orientation="vertical"')
    expect(tabOrder(html)).toEqual(SETTINGS_PROVIDER_RAIL_ORDER.map((entry) => entry.id))
    expect(html).not.toContain('data-provider="gemini"')

    // Logo + status dot per tab, with the label · status tooltip.
    expect(html).toContain('title="Codex · Signed in"')
    expect(html).toContain('aria-label="Codex · Signed in"')
    expect(html).toContain('provider-brand-logo-icon provider-codex')
    expect(html).toContain(
      'settings-provider-auth-status-dot settings-provider-auth-status-dot-signed-in settings-provider-rail-dot'
    )
    // The cross-provider API usage tab uses the generic key glyph, not a brand.
    expect(html).toContain('settings-provider-rail-generic-icon')
    expect(html).toContain('title="API usage · Not checked yet"')
  })

  it('marks the selected tab, drives the pill from declarative counts, and sets aria-controls', () => {
    const html = renderToStaticMarkup(
      <SettingsProviderRail
        entries={makeEntries()}
        selectedId="pi"
        onSelect={() => {}}
        idPrefix="rail"
      />
    )

    const selected = html.match(/<button[^>]*data-provider="pi"[^>]*>/)?.[0] ?? ''
    expect(selected).toContain('aria-selected="true"')
    expect(selected).toContain('class="settings-provider-rail-tab is-active"')
    expect(selected).toContain('id="rail-tab-pi"')
    expect(selected).toContain('aria-controls="rail-pane-pi"')
    expect(selected).toContain('tabindex="0"')
    const codex = html.match(/<button[^>]*data-provider="codex"[^>]*>/)?.[0] ?? ''
    expect(codex).toContain('aria-selected="false"')
    expect(codex).toContain('tabindex="-1"')
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1)

    // pi is the 9th tab (index 8) and sits past one group divider.
    expect(html).toContain('--settings-provider-rail-active-index:8')
    expect(html).toContain('--settings-provider-rail-active-dividers:1')
    expect(html).toContain(
      '--settings-provider-rail-indicator-accent:var(--provider-pi-color, var(--accent))'
    )
    // A tab that OPENS a group sits below its own divider, so that divider
    // counts for it too: ollama (first API tab) → 1, antigravity → 2.
    const ollama = renderToStaticMarkup(
      <SettingsProviderRail entries={makeEntries()} selectedId="ollama" onSelect={() => {}} />
    )
    expect(ollama).toContain('--settings-provider-rail-active-index:7')
    expect(ollama).toContain('--settings-provider-rail-active-dividers:1')
    const antigravity = renderToStaticMarkup(
      <SettingsProviderRail entries={makeEntries()} selectedId="antigravity" onSelect={() => {}} />
    )
    expect(antigravity).toContain('--settings-provider-rail-active-index:11')
    expect(antigravity).toContain('--settings-provider-rail-active-dividers:2')
    const codexRail = renderToStaticMarkup(
      <SettingsProviderRail entries={makeEntries()} selectedId="codex" onSelect={() => {}} />
    )
    expect(codexRail).toContain('--settings-provider-rail-active-dividers:0')
    // Two group boundaries → two dividers.
    expect(html.match(/settings-provider-rail-divider/g)).toHaveLength(2)
    expect(html).toContain('data-rail-group="api"')
    expect(html).toContain('data-rail-group="conditional"')
  })

  it('maps the dot variant like the auth card: out-of-usage is amber, Cursor/Grok partial reads ready', () => {
    expect(settingsProviderRailDotVariant('kimi', 'out-of-usage')).toBe('partial')
    expect(settingsProviderRailDotVariant('cursor', 'partial')).toBe('signed-in')
    expect(settingsProviderRailDotVariant('grok', 'partial')).toBe('signed-in')
    expect(settingsProviderRailDotVariant('mistral', 'partial')).toBe('partial')
    expect(settingsProviderRailDotVariant('codex', 'signed-in')).toBe('signed-in')

    const html = renderToStaticMarkup(
      <SettingsProviderRail entries={makeEntries()} selectedId="codex" onSelect={() => {}} />
    )
    const kimi = html.match(/<button[^>]*data-provider="kimi"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? ''
    expect(kimi).toContain('settings-provider-auth-status-dot-partial')
    const cursor =
      html.match(/<button[^>]*data-provider="cursor"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? ''
    expect(cursor).toContain('settings-provider-auth-status-dot-signed-in')
  })
})

describe('resolveSettingsProviderRailKeySelection', () => {
  it('steps with wrap-around on the arrow keys and jumps on Home/End', () => {
    expect(resolveSettingsProviderRailKeySelection('ArrowDown', 0, 12)).toBe(1)
    expect(resolveSettingsProviderRailKeySelection('ArrowRight', 0, 12)).toBe(1)
    expect(resolveSettingsProviderRailKeySelection('ArrowDown', 11, 12)).toBe(0)
    expect(resolveSettingsProviderRailKeySelection('ArrowUp', 0, 12)).toBe(11)
    expect(resolveSettingsProviderRailKeySelection('ArrowLeft', 5, 12)).toBe(4)
    expect(resolveSettingsProviderRailKeySelection('Home', 7, 12)).toBe(0)
    expect(resolveSettingsProviderRailKeySelection('End', 7, 12)).toBe(11)
  })

  it('leaves keys it does not own, and empty rails, to bubble', () => {
    expect(resolveSettingsProviderRailKeySelection('Enter', 3, 12)).toBeNull()
    expect(resolveSettingsProviderRailKeySelection('Tab', 3, 12)).toBeNull()
    expect(resolveSettingsProviderRailKeySelection('a', 3, 12)).toBeNull()
    expect(resolveSettingsProviderRailKeySelection('ArrowDown', 0, 0)).toBeNull()
  })
})

describe('resolveInitialSettingsProviderRailSelection', () => {
  const ids: SettingsProviderRailId[] = SETTINGS_PROVIDER_RAIL_ORDER.map((entry) => entry.id)

  it('prefers an explicit valid selection, then the remembered one, then the first tab', () => {
    const remembered = {
      getItem: (key: string) => (key === SETTINGS_PROVIDER_RAIL_STORAGE_KEY ? 'mistral' : null)
    }
    expect(resolveInitialSettingsProviderRailSelection(ids, 'ollama', remembered)).toBe('ollama')
    expect(resolveInitialSettingsProviderRailSelection(ids, undefined, remembered)).toBe('mistral')
    expect(resolveInitialSettingsProviderRailSelection(ids, 'gemini', remembered)).toBe('mistral')
    expect(resolveInitialSettingsProviderRailSelection(ids, null, { getItem: () => null })).toBe(
      'codex'
    )
    expect(resolveInitialSettingsProviderRailSelection(ids)).toBe('codex')
  })

  it('ignores unknown remembered ids and a throwing store (SSR and private windows render the first tab)', () => {
    expect(
      resolveInitialSettingsProviderRailSelection(ids, undefined, { getItem: () => 'gemini' })
    ).toBe('codex')
    expect(
      resolveInitialSettingsProviderRailSelection(ids, undefined, {
        getItem: () => {
          throw new Error('blocked')
        }
      })
    ).toBe('codex')
  })
})
