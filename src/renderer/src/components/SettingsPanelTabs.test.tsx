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
  it('retires the messages and Shares tabs while exposing Channels and Devices by default', () => {
    const visibleTabs = getVisibleSettingsTabs().map((tab) => tab.id)
    const allTabs = SETTINGS_TABS.map((tab) => tab.id)

    expect(allTabs).not.toContain('messages')
    expect(visibleTabs).not.toContain('messages')
    expect(allTabs).not.toContain('shares')
    expect(visibleTabs).not.toContain('shares')
    expect(visibleTabs).toContain('channels')
    expect(isSettingsTabVisible('channels')).toBe(true)
    expect(resolveVisibleSettingsTab('channels')).toBe('channels')
    expect(visibleTabs).toContain('pairing')
    expect(isSettingsTabVisible('pairing')).toBe(true)
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

  it('shows Devices in the Settings sidebar', () => {
    const html = renderToStaticMarkup(
      <SettingsSidebar
        activeTab="pairing"
        onTabChange={vi.fn()}
        onBackToApp={vi.fn()}
        appVersion="1.1.0"
      />
    )

    expect(html).toContain('Channels')
    expect(html).not.toContain('People')
    expect(html).not.toContain('sidebar-titlebar-fill')
    expect(html).toContain('Devices')
    expect(html).toContain('Search settings...')
    expect(html).toContain('aria-selected="true"')
  })

  it('uses clearer labels and search aliases for common settings terms', () => {
    const tabsById = Object.fromEntries(SETTINGS_TABS.map((tab) => [tab.id, tab]))

    expect(tabsById['key-commands']?.label).toBe('Keyboard shortcuts')
    expect(tabsById.mcp?.label).toBe('Provider Tools')
    expect(tabsById['mcp-servers']?.label).toBe('MCP Servers')
    expect(tabsById['approval-ledger']?.label).toBe('Approvals & Grants')
    expect(tabsById['safety-privacy']?.label).toBe('Safety & Privacy')
    expect(tabsById.archived?.label).toBe('Archived')

    expect(settingsTabMatchesQuery(tabsById['key-commands'], 'hotkeys')).toBe(true)
    expect(settingsTabMatchesQuery(tabsById.mcp, 'tool audit')).toBe(true)
    expect(settingsTabMatchesQuery(tabsById['mcp-servers'], 'extensions')).toBe(false)
    expect(settingsTabMatchesQuery(tabsById['mcp-servers'], 'custom mcp')).toBe(true)
    expect(settingsTabMatchesQuery(tabsById['mcp-servers'], 'codex toml')).toBe(true)
    expect(settingsTabMatchesQuery(tabsById['mcp-servers'], 'claude json')).toBe(true)
    expect(settingsTabMatchesQuery(tabsById['mcp-servers'], 'cursor mcp')).toBe(true)
    expect(settingsTabMatchesQuery(tabsById['mcp-servers'], 'import json')).toBe(true)
    expect(settingsTabMatchesQuery(tabsById['mcp-servers'], 'user-managed mcp')).toBe(true)
    expect(settingsTabMatchesQuery(tabsById['mcp-servers'], 'mcp.json')).toBe(true)
    expect(settingsTabMatchesQuery(tabsById['mcp-servers'], 'model context protocol')).toBe(true)
    expect(settingsTabMatchesQuery(tabsById['mcp-servers'], 'claude desktop')).toBe(true)
    expect(settingsTabMatchesQuery(tabsById['mcp-servers'], 'claude_desktop_config.json')).toBe(
      true
    )
    expect(settingsTabMatchesQuery(tabsById['mcp-servers'], 'cursor config')).toBe(true)
    expect(settingsTabMatchesQuery(tabsById['mcp-servers'], 'cursor mcp.json')).toBe(true)
    expect(settingsTabMatchesQuery(tabsById['mcp-servers'], 'codex config')).toBe(true)
    expect(settingsTabMatchesQuery(tabsById['mcp-servers'], 'codex config toml')).toBe(true)
    expect(settingsTabMatchesQuery(tabsById['mcp-servers'], 'streamable http')).toBe(true)
    expect(settingsTabMatchesQuery(tabsById['safety-privacy'], 'mobile visibility')).toBe(true)
    expect(settingsTabMatchesQuery(tabsById['safety-privacy'], 'screen watch')).toBe(true)
    expect(settingsTabMatchesQuery(tabsById.pairing, 'iphone')).toBe(true)
    expect(settingsTabMatchesQuery(tabsById['model-usage'], 'quota')).toBe(true)
    expect(settingsTabMatchesQuery(tabsById['model-usage'], 'rates')).toBe(true)
    expect(settingsTabMatchesQuery(tabsById['model-usage'], 'pricing')).toBe(true)
    expect(settingsTabMatchesQuery(tabsById['model-usage'], 'api cost')).toBe(true)
    expect(settingsTabMatchesQuery(tabsById.archived, 'unarchive')).toBe(true)
    expect(settingsTabMatchesQuery(tabsById.appearance, 'billing')).toBe(false)
  })

  it('surfaces Safety & Privacy in the Data group', () => {
    const html = renderToStaticMarkup(
      <SettingsSidebar
        activeTab="safety-privacy"
        onTabChange={vi.fn()}
        onBackToApp={vi.fn()}
        appVersion="1.1.0"
      />
    )

    expect(getVisibleSettingsTabs().map((tab) => tab.id)).toContain('safety-privacy')
    expect(html).toContain('Safety &amp; Privacy')
    expect(html).toContain('Data')
    expect(html).toContain('aria-selected="true"')
  })

  it('exposes Skills and Hooks tabs under Integrations', () => {
    const tabsById = Object.fromEntries(SETTINGS_TABS.map((tab) => [tab.id, tab]))
    const visibleIds = getVisibleSettingsTabs().map((tab) => tab.id)

    expect(visibleIds).toContain('skills')
    expect(visibleIds).toContain('hooks')
    expect(tabsById.skills?.group).toBe('integrations')
    expect(tabsById.hooks?.group).toBe('integrations')
    expect(settingsTabMatchesQuery(tabsById.skills, 'skill library')).toBe(true)
    expect(settingsTabMatchesQuery(tabsById.hooks, 'pre tool use')).toBe(true)

    const skillsHtml = renderToStaticMarkup(
      <SettingsSidebar
        activeTab="skills"
        onTabChange={vi.fn()}
        onBackToApp={vi.fn()}
        appVersion="1.1.0"
      />
    )
    expect(skillsHtml).toContain('Skills')
    expect(skillsHtml).toContain('Integrations')
    expect(skillsHtml).toContain('aria-selected="true"')

    const hooksHtml = renderToStaticMarkup(
      <SettingsSidebar
        activeTab="hooks"
        onTabChange={vi.fn()}
        onBackToApp={vi.fn()}
        appVersion="1.1.0"
      />
    )
    expect(hooksHtml).toContain('Hooks')
    expect(hooksHtml).toContain('aria-selected="true"')
  })
})
