import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import { describe, expect, it } from 'vitest'
import {
  SettingsPanel,
  formatUserMcpServersCodexToml,
  formatUserMcpServersAuditJson,
  hasUserMcpServerNameConflict,
  parseUserMcpServersImportJson
} from './SettingsPanel'
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
            },
            {
              id: 'server-docs',
              name: 'docs',
              enabled: true,
              transport: 'http',
              url: 'https://example.test/mcp',
              headers: {
                Authorization: 'Bearer ${DOCS_TOKEN}'
              },
              bearerTokenEnvVar: 'DOCS_TOKEN'
            },
            {
              id: 'server-legacy',
              name: 'legacy',
              enabled: true,
              transport: 'sse',
              url: 'https://example.test/sse'
            }
          ]
        })}
      />
    )

    expect(html).toContain('MCP servers')
    expect(html).toContain('filesystem')
    expect(html).toContain('2 args')
    expect(html).toContain('1 env var')
    expect(html).toContain('1 header')
    expect(html).toContain('bearer env')
    expect(html).toContain('Import config')
    expect(html).toContain('Codex + Claude + Cursor')
    expect(html).toContain('stdio and HTTP launch support')
    expect(html).toContain('runtime: Codex + Claude + Cursor')
    expect(html).toContain('runtime: Claude')
    expect(html).toContain('Audit JSON')
    expect(html).toContain('All servers audit JSON')
    expect(html).toContain('Copy all JSON')
    expect(html).toContain('Copy Codex TOML')
    expect(html).toContain('Codex config TOML')
    expect(html).toContain('Copy JSON')
    expect(html).toContain('&quot;command&quot;: &quot;npx&quot;')
    expect(html).toContain('&quot;PROJECT_ROOT&quot;: &quot;[stored in TaskWraith settings]&quot;')
    expect(html).not.toContain('&quot;PROJECT_ROOT&quot;: &quot;/Users/chris/project&quot;')
    expect(html).toContain('&quot;Authorization&quot;: &quot;[stored in TaskWraith settings]&quot;')
    expect(html).toContain('&quot;bearer_token_env_var&quot;: &quot;DOCS_TOKEN&quot;')
    expect(html).not.toContain('Bearer ${DOCS_TOKEN}')
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

describe('parseUserMcpServersImportJson', () => {
  it('imports Claude/Cursor-style stdio MCP server definitions', () => {
    const result = parseUserMcpServersImportJson(
      JSON.stringify({
        mcpServers: {
          filesystem: {
            command: 'npx',
            args: ['@modelcontextprotocol/server-filesystem', '/repo'],
            env: {
              PROJECT_ROOT: '/repo',
              'bad-key': 'dropped'
            }
          }
        }
      })
    )

    expect(result.error).toBeUndefined()
    expect(result.skipped).toBe(0)
    expect(result.servers).toHaveLength(1)
    expect(result.servers[0]).toMatchObject({
      name: 'filesystem',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
      args: ['@modelcontextprotocol/server-filesystem', '/repo'],
      env: { PROJECT_ROOT: '/repo' }
    })
    expect(result.servers[0].env).not.toHaveProperty('bad-key')
  })

  it('imports remote MCP servers and de-duplicates names against existing records', () => {
    const result = parseUserMcpServersImportJson(
      JSON.stringify({
        mcpServers: {
          docs: {
            type: 'streamableHttp',
            url: 'https://example.test/mcp',
            http_headers: {
              Authorization: 'Bearer ${DOCS_TOKEN}',
              'bad header': 'dropped'
            },
            bearer_token_env_var: 'DOCS_TOKEN',
            disabled: true
          }
        }
      }),
      [
        {
          id: 'existing-docs',
          name: 'docs',
          enabled: true,
          transport: 'stdio',
          command: 'node'
        }
      ]
    )

    expect(result.error).toBeUndefined()
    expect(result.servers).toHaveLength(1)
    expect(result.servers[0]).toMatchObject({
      name: 'docs 2',
      enabled: false,
      transport: 'http',
      url: 'https://example.test/mcp',
      headers: {
        Authorization: 'Bearer ${DOCS_TOKEN}'
      },
      bearerTokenEnvVar: 'DOCS_TOKEN'
    })
    expect(result.servers[0].headers).not.toHaveProperty('bad header')
  })

  it('imports Codex-style TOML MCP server snippets', () => {
    const result = parseUserMcpServersImportJson(`
      [mcp_servers.filesystem]
      command = "npx"
      args = ["@modelcontextprotocol/server-filesystem", "/repo"]
      env = { PROJECT_ROOT = "/repo", "bad-key" = "dropped" }

      [mcp_servers."figma-remote"]
      url = "https://mcp.figma.com/mcp"
      bearer_token_env_var = "FIGMA_OAUTH_TOKEN"
      http_headers = { "X-Figma-Region" = "eu", Authorization = "Bearer \${FIGMA_OAUTH_TOKEN}" }
    `)

    expect(result.error).toBeUndefined()
    expect(result.skipped).toBe(0)
    expect(result.servers).toHaveLength(2)
    expect(result.servers[0]).toMatchObject({
      name: 'filesystem',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
      args: ['@modelcontextprotocol/server-filesystem', '/repo'],
      env: { PROJECT_ROOT: '/repo' }
    })
    expect(result.servers[0].env).not.toHaveProperty('bad-key')
    expect(result.servers[1]).toMatchObject({
      name: 'figma-remote',
      enabled: true,
      transport: 'http',
      url: 'https://mcp.figma.com/mcp',
      headers: {
        'X-Figma-Region': 'eu',
        Authorization: 'Bearer ${FIGMA_OAUTH_TOKEN}'
      },
      bearerTokenEnvVar: 'FIGMA_OAUTH_TOKEN'
    })
  })

  it('reports an error when no supported MCP server entries are present', () => {
    const result = parseUserMcpServersImportJson(
      JSON.stringify({ mcpServers: { empty: { args: ['missing-command'] } } })
    )

    expect(result.servers).toEqual([])
    expect(result.skipped).toBe(1)
    expect(result.error).toContain('No supported MCP servers found')
  })
})

describe('user MCP server name/audit helpers', () => {
  it('detects manual name conflicts case-insensitively while allowing the edited server', () => {
    const servers = [
      {
        id: 'server-docs',
        name: 'Docs',
        enabled: true,
        transport: 'http' as const,
        url: 'https://example.test/mcp'
      }
    ]

    expect(hasUserMcpServerNameConflict(servers, ' docs ')).toBe(true)
    expect(hasUserMcpServerNameConflict(servers, 'docs', 'server-docs')).toBe(false)
    expect(hasUserMcpServerNameConflict(servers, 'filesystem')).toBe(false)
  })

  it('keeps all entries in copy-all audit JSON when legacy duplicate names exist', () => {
    const audit = JSON.parse(
      formatUserMcpServersAuditJson([
        {
          id: 'server-docs-a',
          name: 'docs',
          enabled: true,
          transport: 'stdio',
          command: 'node'
        },
        {
          id: 'server-docs-b',
          name: 'docs',
          enabled: true,
          transport: 'http',
          url: 'https://example.test/mcp'
        }
      ])
    )

    expect(Object.keys(audit.mcpServers)).toEqual(['docs', 'docs 2'])
    expect(audit.mcpServers.docs.command).toBe('node')
    expect(audit.mcpServers['docs 2'].url).toBe('https://example.test/mcp')
    expect(audit.taskwraith.servers).toHaveLength(2)
  })

  it('formats enabled Codex-compatible servers as TOML and skips disabled or SSE entries', () => {
    const toml = formatUserMcpServersCodexToml([
      {
        id: 'filesystem',
        name: 'filesystem',
        enabled: true,
        transport: 'stdio',
        command: 'npx',
        args: ['@modelcontextprotocol/server-filesystem', '/repo'],
        env: { PROJECT_ROOT: '/repo' }
      },
      {
        id: 'docs',
        name: 'docs remote',
        enabled: true,
        transport: 'http',
        url: 'https://example.test/mcp',
        headers: {
          Authorization: 'Bearer ${DOCS_TOKEN}',
          'X-Region': 'eu'
        },
        bearerTokenEnvVar: 'DOCS_TOKEN'
      },
      {
        id: 'legacy',
        name: 'legacy',
        enabled: true,
        transport: 'sse',
        url: 'https://example.test/sse'
      },
      {
        id: 'disabled',
        name: 'disabled',
        enabled: false,
        transport: 'stdio',
        command: 'node'
      }
    ])

    expect(toml).toContain('[mcp_servers.filesystem]')
    expect(toml).toContain('command = "npx"')
    expect(toml).toContain('args = ["@modelcontextprotocol/server-filesystem", "/repo"]')
    expect(toml).toContain('env = { PROJECT_ROOT = "/repo" }')
    expect(toml).toContain('[mcp_servers."docs remote"]')
    expect(toml).toContain('url = "https://example.test/mcp"')
    expect(toml).toContain('bearer_token_env_var = "DOCS_TOKEN"')
    expect(toml).toContain(
      'http_headers = { Authorization = "Bearer ${DOCS_TOKEN}", X-Region = "eu" }'
    )
    expect(toml).not.toContain('legacy')
    expect(toml).not.toContain('disabled')
  })

  it('redacts values in Codex TOML preview mode', () => {
    const toml = formatUserMcpServersCodexToml(
      [
        {
          id: 'docs',
          name: 'docs',
          enabled: true,
          transport: 'http',
          url: 'https://example.test/mcp',
          headers: {
            Authorization: 'Bearer ${DOCS_TOKEN}'
          }
        }
      ],
      { redactValues: true }
    )

    expect(toml).toContain('Authorization = "[stored in TaskWraith settings]"')
    expect(toml).not.toContain('Bearer ${DOCS_TOKEN}')
  })
})
