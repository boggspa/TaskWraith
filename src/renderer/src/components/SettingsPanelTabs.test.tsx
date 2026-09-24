import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  SETTINGS_TABS,
  SettingsPanel,
  getVisibleSettingsTabs,
  isSettingsTabVisible,
  resolveVisibleSettingsTab,
  settingsTabMatchesQuery
} from './SettingsPanel'
import { SettingsSidebar } from './SettingsSidebar'
import { DEFAULT_AGENTIC_SERVICES } from '../lib/agenticServicesDefaults'
import { resolveSettingsTabFromSlashArg } from '../lib/resolveSettingsSlashTab'
import {
  DEFAULT_APPROVAL_TIMEOUTS_MS,
  DEFAULT_MAIN_AUTHORITY_APPROVAL_TIMEOUT_MS
} from '../../../shared/interactionTimeouts'

type SettingsPanelProps = ComponentProps<typeof SettingsPanel>

function makeSettingsProps(overrides: Partial<SettingsPanelProps> = {}): SettingsPanelProps {
  return {
    mode: 'solid',
    visualEffectStyle: 'auto',
    themeAppearance: 'dark',
    themeCornerStyle: 'rounded',
    themeAccentColor: '#5A8CFF',
    diffStatColors: { additions: '#2DB777', deletions: '#EC3D35' },
    appIconVariant: 'regular',
    promptSurfaceStyle: 'theme',
    composerStyle: 'default',
    transcriptFontFamily: 'system',
    composerFontFamily: 'system',
    persistedTranscriptFontFamily: 'system',
    persistedComposerFontFamily: 'system',
    keyCommandBindings: {},
    reduceTransparency: false,
    reduceMotion: false,
    compactDensity: false,
    liveActivityViewport: true,
    sidebarOpacity: 100,
    mainPaneOpacity: 100,
    geminiCheckpointingEnabled: false,
    chatContextTurns: 6,
    currency: 'USD',
    currencyOverestimatePercent: 0,
    dashboardStatPrefs: {},
    welcomeHeatmapPrefs: {},
    kimiSanitiserEnabled: false,
    kimiSanitiserCustomKeywords: '',
    claudeBinaryPath: '',
    kimiBinaryPath: '',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    ollamaDefaultModel: 'gpt-oss:20b',
    agenticServices: DEFAULT_AGENTIC_SERVICES,
    nativeSubAgentRequests: 'ask',
    agenticWorkspaceGrantCount: 0,
    agenticWorkspaceGrants: [],
    activeProvider: 'codex',
    providerCapabilities: null,
    providerCapabilitiesByProvider: {},
    mcpStatusByProvider: {},
    geminiMcpBridgeEnabled: false,
    codexSandboxFallback: 'ask_rerun',
    funFxEnabled: false,
    funFxMode: 'off',
    advancedFx: {
      agentAura: false,
      livingWorkspace: false,
      dataViz: false,
      refraction: false,
      intensity: 'subtle'
    },
    autoUpdateEnabled: true,
    updateChannel: 'stable',
    approvalTimeouts: {
      enabled: true,
      perProviderMs: { ...DEFAULT_APPROVAL_TIMEOUTS_MS },
      mainAuthorityMs: DEFAULT_MAIN_AUTHORITY_APPROVAL_TIMEOUT_MS
    },
    productOperationsStatus: null,
    auditRetention: {
      enabled: false,
      maxAgeDays: {
        approvalLedger: 365,
        runEvents: 180,
        workspaceChanges: 180,
        auditRuns: 365,
        messageFeedback: 365,
        externalPublish: 365,
        productCrashes: 90
      }
    },
    codexStatus: null,
    claudeAuthStatus: null,
    kimiAuthStatus: null,
    ollamaStatus: null,
    cursorProviderAvailable: true,
    grokProviderAvailable: true,
    providerCliUpgradeState: {},
    onInstallGeminiMcpBridge: () => {},
    onRefreshGeminiMcpBridgeStatus: () => {},
    onRefreshProductOperationsStatus: () => {},
    onExportProductDiagnostics: () => {},
    onExportProductAuditBundle: () => {},
    onVerifyProductAuditBundle: () => {},
    onDryRunAuditRetention: () => {},
    onPurgeAuditRetention: () => {},
    onRepairProductInstall: () => {},
    onChange: () => {},
    onClose: () => {},
    activeTab: 'providers',
    layout: 'takeover',
    ...overrides
  }
}

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

  it('surfaces Appearance in sidebar search for the transcript control terms', () => {
    // Mirrors the real consumer: SettingsSidebar.tsx:220-221 filters the visible tabs with
    // `settingsTabMatchesQuery`. Asserting the FILTERED LIST (rather than that a string sits
    // in `tab.aliases`) is what makes this a resolution guard: an alias that existed but was
    // matched by nothing would still fail here.
    const search = (query: string) =>
      getVisibleSettingsTabs()
        .filter((tab) => settingsTabMatchesQuery(tab, query))
        .map((tab) => tab.id)

    // Positive control: this filter has no default tab and CAN return nothing. An empty list
    // is exactly what every query below returned before the Appearance aliases were added,
    // so these assertions cannot be passing by way of a fallback.
    expect(search('zzzz no such settings tab')).toEqual([])

    for (const query of [
      'transcript',
      'transcript view',
      'transcript text size',
      'text size',
      'transcript width',
      'width',
      'view',
      'size'
    ]) {
      expect(search(query)).toContain('appearance')
    }

    // Widening only: the tabs that already answered these queries must still answer them.
    expect(search('transcript')).toContain('pinned-messages')
    expect(search('view')).toContain('local-servers')
    expect(search('text')).toContain('model-usage')
    // And the widening must not reach 'default', which belongs to Behavior. Appearance
    // carries the bare 'view' alias rather than 'default transcript view' precisely so a
    // one-word 'default' never lands here; see resolveSettingsSlashTab.test.ts for the
    // score arithmetic that makes the qualified form win it.
    expect(search('default')).not.toContain('appearance')
    expect(search('default')).toContain('behavior')
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

describe('TaskWraith Host tab', () => {
  const HOST_QUERIES = ['host', 'restart', 'pid', 'uptime', 'payload', 'clients', 'lease']

  it('sits in the App group just before About, visible without any flag', () => {
    const tabsById = Object.fromEntries(SETTINGS_TABS.map((tab) => [tab.id, tab]))
    expect(tabsById.host).toMatchObject({ label: 'TaskWraith Host', group: 'app', scope: 'global' })
    const appTabs = getVisibleSettingsTabs()
      .filter((tab) => tab.group === 'app')
      .map((tab) => tab.id)
    expect(appTabs.indexOf('host')).toBe(appTabs.indexOf('about') - 1)
    expect(isSettingsTabVisible('host')).toBe(true)
    expect(resolveVisibleSettingsTab('host')).toBe('host')
  })

  it('routes the Host queries to the host tab by MATCH, not by fallback', () => {
    // The disarming has to point AWAY from the tab under test: an unmatched
    // query returns `defaultTab`, so force it to 'appearance' and prove it,
    // or every line below could pass with no alias at all.
    const opts = { settingsTabs: SETTINGS_TABS, defaultTab: 'appearance' as const }
    expect(resolveSettingsTabFromSlashArg('zzzz no such settings tab', opts)).toBe('appearance')

    for (const query of HOST_QUERIES) {
      expect({ query, tab: resolveSettingsTabFromSlashArg(query, opts) }).toEqual({
        query,
        tab: 'host'
      })
    }
  })

  it('wins the Host queries on score, not on the alphabetical tie-break', () => {
    // Ties break by tab id ascending and 'host' already loses them to
    // 'behavior' and 'hooks'; a last-sorting id takes even that away.
    const relabelled = SETTINGS_TABS.map((tab) =>
      tab.id === 'host' ? { ...tab, id: 'zzzz-host' as typeof tab.id } : tab
    )
    const opts = { settingsTabs: relabelled, defaultTab: 'appearance' as const }
    expect(resolveSettingsTabFromSlashArg('zzzz no such settings tab', opts)).toBe('appearance')

    for (const query of HOST_QUERIES) {
      expect({ query, tab: resolveSettingsTabFromSlashArg(query, opts) }).toEqual({
        query,
        tab: 'zzzz-host'
      })
    }
  })

  it('surfaces the host tab in sidebar search', () => {
    const search = (query: string) =>
      getVisibleSettingsTabs()
        .filter((tab) => settingsTabMatchesQuery(tab, query))
        .map((tab) => tab.id)

    expect(search('zzzz no such settings tab')).toEqual([])
    for (const query of HOST_QUERIES) {
      expect(search(query)).toContain('host')
    }
  })

  it('gives the host tab the TaskWraith ghost in the settings sidebar', () => {
    const html = renderToStaticMarkup(
      <SettingsSidebar
        activeTab="host"
        onTabChange={vi.fn()}
        onBackToApp={vi.fn()}
        appVersion="1.1.0"
      />
    )
    const hostTab =
      /<button[^>]*title="The independent TaskWraith Host process[^"]*"[^>]*>(.*?)<\/button>/.exec(
        html
      )?.[1]

    expect(hostTab).toContain('<span class="settings-sidebar-tab-label">TaskWraith Host</span>')
    expect(hostTab).toContain('<svg class="mascot-ghost"')
    // Not the three-line glyph every unmapped tab falls back to.
    expect(hostTab).not.toContain('M3 4.4h10M3 8h10M3 11.6h10')
  })

  it('reaches the Host card from the host tab, and from no other tab', () => {
    const hostMarkup = renderToStaticMarkup(
      <SettingsPanel {...makeSettingsProps({ activeTab: 'host' })} />
    )
    expect(hostMarkup).toContain(
      '<h4 id="settings-host-title" class="sidebar-section-title">TaskWraith Host</h4>'
    )
    expect(hostMarkup).toContain('<dt>pid</dt>')

    const aboutMarkup = renderToStaticMarkup(
      <SettingsPanel {...makeSettingsProps({ activeTab: 'about' })} />
    )
    expect(aboutMarkup).not.toContain('settings-host-title')
  })
})
