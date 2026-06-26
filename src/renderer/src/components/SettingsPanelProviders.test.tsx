import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import { describe, expect, it } from 'vitest'
import { SettingsPanel } from './SettingsPanel'
import { DEFAULT_AGENTIC_SERVICES } from '../lib/agenticServicesDefaults'
import { TASKWRAITH_MCP_TOOLS } from '../../../main/TaskWraithMcpTools'

type SettingsPanelProps = ComponentProps<typeof SettingsPanel>

function makeSettingsProps(overrides: Partial<SettingsPanelProps> = {}): SettingsPanelProps {
  return {
    mode: 'solid',
    visualEffectStyle: 'auto',
    themeAppearance: 'dark',
    themeCornerStyle: 'rounded',
    themeAccentStyle: 'blue',
    toolIconAccent: 'system',
    appIconVariant: 'regular',
    userBubbleColor: 'system',
    promptSurfaceStyle: 'theme',
    composerStyle: 'default',
    transcriptFontFamily: 'system',
    composerFontFamily: 'system',
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
    autoResumeParentOnSubThreadCompletion: true,
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
      perProviderMs: {
        gemini: 120_000,
        codex: 30_000,
        claude: 120_000,
        kimi: 60_000
      },
      mainAuthorityMs: 60_000
    },
    productOperationsStatus: null,
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
    onRepairProductInstall: () => {},
    onChange: () => {},
    onClose: () => {},
    activeTab: 'providers',
    layout: 'takeover',
    ...overrides
  }
}

describe('SettingsPanel provider cards', () => {
  it('renders available Cursor and Grok cards without raw env flags and with ready LEDs', () => {
    const html = renderToStaticMarkup(<SettingsPanel {...makeSettingsProps()} />)

    expect(html).toContain('settings-provider-auth-card-partial provider-cursor')
    expect(html).toContain('settings-provider-auth-card-partial provider-grok')
    expect(html).toContain('Available · CLI sign-in')
    expect(html).toContain(
      'settings-provider-auth-status-dot settings-provider-auth-status-dot-signed-in'
    )
    expect(html).not.toContain('TASKWRAITH_DISABLE_CURSOR')
    expect(html).not.toContain('TASKWRAITH_DISABLE_GROK')
  })

  it('renders the Ollama cloud sign-in card in the Providers sign-in grid', () => {
    const html = renderToStaticMarkup(<SettingsPanel {...makeSettingsProps()} />)

    // Ollama now has a sign-in card (filling the retired-Gemini slot) offering the
    // optional ollama.com cloud auth — local models still need no account.
    expect(html).toContain('settings-provider-auth-card-partial provider-ollama')
    expect(html).toContain('ollama signin')
    expect(html).toContain('ollama signout')
    expect(html).toContain('Sign in to ollama.com to use Ollama Cloud')
    expect(html).toContain('Open Terminal to sign in')
  })

  it('does not render the retired Gemini sign-in card on the Providers tab', () => {
    const html = renderToStaticMarkup(<SettingsPanel {...makeSettingsProps()} />)

    // Gemini is RETIRED — its sign-in offer surface is gone (its chat history
    // and the deeper shared-bridge wiring stay preserved).
    expect(html).not.toContain('Google Gemini profiles for OAuth')
    // Live providers still render their sign-in cards.
    expect(html).toContain('Login with Claude')
  })

  it('does not render the retired Gemini card in the MCP connected surfaces', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel {...makeSettingsProps({ activeTab: 'mcp' })} />
    )

    // The connected-surfaces grid is an offer surface — no Gemini card, and it
    // drops out of the "providers reporting MCP/bridge status" denominator too.
    expect(html).not.toContain('settings-mcp-server-card provider-gemini')
    // Live providers still get their connected-surface cards.
    expect(html).toContain('settings-mcp-server-card provider-claude')
  })

  it('renders SVG tool icons in the MCP tool catalog instead of text badges', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel {...makeSettingsProps({ activeTab: 'mcp' })} />
    )

    expect(html).toContain('settings-mcp-tool-icon-svg')
    expect(html).not.toContain('>WO</span>')
    expect(html).not.toContain('>ID</span>')
    expect(html).toContain('<code>tool:workspace</code>')
  })

  it('shows Codex TaskWraith bridge tools separately from app-server MCP inventory', () => {
    const codexTools = Object.fromEntries(
      Array.from({ length: 215 }, (_, index) => [`codex_tool_${index}`, {}])
    )
    const serverTools = (start: number, end?: number) =>
      Object.fromEntries(Object.entries(codexTools).slice(start, end))
    const html = renderToStaticMarkup(
      <SettingsPanel
        {...makeSettingsProps({
          activeTab: 'mcp',
          providerCapabilitiesByProvider: {
            codex: {
              mcp: {
                state: 'available',
                source: 'provider',
                available: true,
                enabled: true,
                installed: true,
                serverName: 'TaskWraith',
                tools: Object.keys(codexTools),
                message: '5 Codex MCP servers reported by app-server.'
              }
            } as any
          },
          mcpStatusByProvider: {
            codex: {
              available: true,
              data: [
                { name: 'server-1', tools: serverTools(0, 43) },
                { name: 'server-2', tools: serverTools(43, 86) },
                { name: 'server-3', tools: serverTools(86, 129) },
                { name: 'server-4', tools: serverTools(129, 172) },
                { name: 'server-5', tools: serverTools(172) }
              ]
            }
          }
        })}
      />
    )

    expect(html).toContain(`<span>bridge</span><span>${TASKWRAITH_MCP_TOOLS.length} tools</span>`)
    expect(html).toContain('Codex app-server also reports 5 MCP servers with 215 total tools.')
  })

  it('does not render the retired deeper Gemini auth/runtime config, but keeps the shared MCP bridge', () => {
    const providersHtml = renderToStaticMarkup(<SettingsPanel {...makeSettingsProps()} />)

    // The deeper Gemini offer surface (auth profiles, API-key/Vertex inputs, the
    // runtime picker, and the duplicate bridge row) is gone now Gemini is retired.
    expect(providersHtml).not.toContain('Gemini auth profile')
    expect(providersHtml).not.toContain('GEMINI_API_KEY')
    expect(providersHtml).not.toContain('Gemini runtime')

    // The shared TaskWraith MCP bridge control still lives on the MCP tab and
    // should describe active-provider broker wiring rather than retired Gemini setup.
    const mcpHtml = renderToStaticMarkup(
      <SettingsPanel {...makeSettingsProps({ activeTab: 'mcp' })} />
    )
    expect(mcpHtml).toContain('Enables TaskWraith&#x27;s bundled MCP broker')
    expect(mcpHtml).toContain('no manual Cursor or Grok MCP install is required')
  })

  it('renders user-managed MCP servers on the dedicated MCP Servers page', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        {...makeSettingsProps({
          activeTab: 'mcp-servers',
          userMcpServers: [
            {
              id: 'server-filesystem',
              name: 'filesystem',
              enabled: true,
              transport: 'stdio',
              command: 'npx',
              args: ['@modelcontextprotocol/server-filesystem', '/Users/chris/project'],
              env: { PROJECT_ROOT: '/Users/chris/project' }
            }
          ]
        })}
      />
    )

    expect(html).toContain('MCP servers')
    expect(html).toContain('filesystem')
    expect(html).toContain('2 args')
    expect(html).toContain('1 env var')
    expect(html).toContain('Audit JSON')
    expect(html).toContain('&quot;command&quot;: &quot;npx&quot;')
    expect(html).toContain('&quot;PROJECT_ROOT&quot;: &quot;[stored in TaskWraith settings]&quot;')
    expect(html).not.toContain('&quot;PROJECT_ROOT&quot;: &quot;/Users/chris/project&quot;')
    expect(html).toContain('Add server')
  })

  it('renders the General auto-update checkbox enabled by default', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel {...makeSettingsProps({ activeTab: 'behavior' })} />
    )

    expect(html).toContain('Enable Auto-Update')
    expect(html).toMatch(
      /<label class="settings-service-row"><span>Enable Auto-Update<\/span><input type="checkbox" checked=""/
    )
  })

  it('renders the General auto-update checkbox unchecked when disabled', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        {...makeSettingsProps({ activeTab: 'behavior', autoUpdateEnabled: false })}
      />
    )

    expect(html).toMatch(
      /<label class="settings-service-row"><span>Enable Auto-Update<\/span><input type="checkbox"\/?>/
    )
  })
})
