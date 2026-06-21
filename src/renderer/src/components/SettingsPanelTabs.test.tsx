import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  SETTINGS_TABS,
  getVisibleSettingsTabs,
  isSettingsTabVisible,
  resolveVisibleSettingsTab,
  settingsTabMatchesQuery
} from './SettingsPanel'
import { SettingsSidebar } from './SettingsSidebar'

describe('Settings tabs', () => {
  it('hides dev/debug-only Channels while exposing Devices by default', () => {
    const visibleTabs = getVisibleSettingsTabs().map((tab) => tab.id)

    expect(visibleTabs).not.toContain('messages')
    expect(visibleTabs).toContain('pairing')
    expect(isSettingsTabVisible('messages')).toBe(false)
    expect(isSettingsTabVisible('pairing')).toBe(true)
    expect(resolveVisibleSettingsTab('messages')).toBe('behavior')
    expect(resolveVisibleSettingsTab('pairing')).toBe('pairing')
  })

  it('exposes the Roster tab in the canonical list and the sidebar', () => {
    expect(getVisibleSettingsTabs().map((tab) => tab.id)).toContain('roster')
    expect(isSettingsTabVisible('roster')).toBe(true)
    const html = renderToStaticMarkup(
      <SettingsSidebar
        activeTab="roster"
        onTabChange={vi.fn()}
        onBackToApp={vi.fn()}
        appVersion="1.1.0"
      />
    )
    expect(html).toContain('Ensemble roster')
    expect(html).toContain('AI &amp; Providers')
  })

  it('omits Channels from the Settings sidebar while showing Devices', () => {
    const html = renderToStaticMarkup(
      <SettingsSidebar
        activeTab="messages"
        onTabChange={vi.fn()}
        onBackToApp={vi.fn()}
        appVersion="1.1.0"
      />
    )

    expect(html).not.toContain('Channels')
    expect(html).toContain('Devices')
    expect(html).toContain('Search settings...')
    expect(html).toContain('aria-selected="true"')
  })

  it('uses clearer labels and search aliases for common settings terms', () => {
    const tabsById = Object.fromEntries(SETTINGS_TABS.map((tab) => [tab.id, tab]))

    expect(tabsById['key-commands']?.label).toBe('Keyboard shortcuts')
    expect(tabsById.mcp?.label).toBe('Tools & MCPs')
    expect(tabsById['approval-ledger']?.label).toBe('Approvals & Grants')

    expect(settingsTabMatchesQuery(tabsById['key-commands'], 'hotkeys')).toBe(true)
    expect(settingsTabMatchesQuery(tabsById.mcp, 'extensions')).toBe(true)
    expect(settingsTabMatchesQuery(tabsById.pairing, 'iphone')).toBe(true)
    expect(settingsTabMatchesQuery(tabsById['model-usage'], 'quota')).toBe(true)
    expect(settingsTabMatchesQuery(tabsById.appearance, 'billing')).toBe(false)
  })
})
