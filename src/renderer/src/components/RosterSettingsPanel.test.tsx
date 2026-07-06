import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// RosterSettingsPanel reads presets from localStorage during render, so install
// a Map-backed fake window before importing it (no jsdom in this suite).
const fake = vi.hoisted(() => {
  const store = new Map<string, string>()
  const localStorage = {
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    }
  }
  ;(globalThis as unknown as { window: unknown }).window = {
    localStorage,
    addEventListener: () => {},
    removeEventListener: () => {},
    // Sidebar.tsx (pulled in transitively via ComposerProviderPicker →
    // ProviderBadgeIcon) registers a module-load interval; stub it for node.
    setInterval: () => 0,
    clearInterval: () => {}
  }
  return { store }
})

import { RosterSettingsPanel } from './RosterSettingsPanel'
import { createEmptyEnsembleRosterPreset } from '../lib/ensembleRosterPresets'

beforeEach(() => {
  fake.store.clear()
})

describe('RosterSettingsPanel', () => {
  it('renders the empty state when there are no presets', () => {
    const html = renderToStaticMarkup(<RosterSettingsPanel />)
    expect(html).toContain('Roster presets')
    expect(html).toContain('No presets yet')
  })

  it('renders JSON import/export controls', () => {
    const html = renderToStaticMarkup(<RosterSettingsPanel />)
    expect(html).toContain('Import JSON')
    expect(html).toContain('Export JSON')
    expect(html).toContain('type="file"')
    expect(html).toContain('accept=".json,application/json"')
  })

  it('lists an existing preset in the left pane', () => {
    createEmptyEnsembleRosterPreset('Panel A')
    const html = renderToStaticMarkup(<RosterSettingsPanel />)
    expect(html).toContain('Panel A')
  })
})
