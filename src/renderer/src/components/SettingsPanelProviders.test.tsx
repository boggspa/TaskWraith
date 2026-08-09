import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import { describe, expect, it } from 'vitest'
import type { RuntimeProfile, UserMcpServerConfig } from '../../../main/store/types'
import {
  SettingsPanel,
  buildRuntimeProfileFromForm,
  formatUserMcpServerClaudeJsonSnippet,
  formatUserMcpServerCodexTomlSnippet,
  formatUserMcpServerCursorJsonSnippet,
  formatUserMcpServersClaudeJson,
  formatUserMcpServersCodexToml,
  formatUserMcpServersCursorJson,
  formatUserMcpServersAuditJson,
  buildUserMcpServerFromForm,
  hasUserMcpServerNameConflict,
  parseUserMcpServersImportJson,
  userMcpServerReadiness,
  userMcpServerProviderExportLabels,
  userMcpServerMatchesQuery,
  userMcpServerStatusLabel,
  uncategorizedMcpToolsForSettings
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
    diffStatColors: { additions: '#2DB777', deletions: '#EC3D35' },
    appIconVariant: 'regular',
    userBubbleColor: 'system',
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
        kimi: 60_000,
        grok: 120_000,
        cursor: 120_000,
        ollama: 120_000,
        antigravity: 120_000,
        pi: 120_000,
        mistral: 120_000,
      },
      mainAuthorityMs: 60_000
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

function makeRuntimeProfile(overrides: Partial<RuntimeProfile> = {}): RuntimeProfile {
  return {
    id: 'runtime-custom',
    name: 'Codex staging',
    provider: 'codex',
    scope: 'workspace',
    workspaceMode: 'local',
    env: {},
    networkPolicy: 'inherit',
    persistence: 'reusable',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

describe('SettingsPanel provider cards', () => {
  it('renders visual theme cards and adjustable diff colors on the Appearance tab', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel {...makeSettingsProps({ activeTab: 'appearance' })} />
    )

    expect(html).toContain('Diff stat colors')
    expect(html).toContain('Additions')
    expect(html).toContain('Deletions')
    expect(html).toContain('#2DB777')
    expect(html).toContain('#EC3D35')
    expect(html).toContain('HSL')
    expect(html).toContain('A perfectly normal “small cleanup”')
    expect(html).toContain('settings-diff-stat-preview-counts')
    expect(html).toContain('aria-label="Theme previews"')
    expect(html).toContain('data-theme-preview="system"')
    expect(html).toContain('data-theme-preview="forest"')
    expect(html).toContain('Theme-aware code diff')
    expect(html).toContain('--theme-preview-diff-additions:#2DB777')
    expect(html).toContain('--theme-preview-diff-deletions:#EC3D35')
    expect(html).not.toContain('settings-theme-option')
    expect(html).not.toContain('Tool-icon color')
  })

  it('binds the custom transcript-font input to the PERSISTED value (not appearance state)', () => {
    // Custom appearance value forces the <select> to "Custom…" so the
    // CommittedDraftField input renders; its initial value must mirror the
    // normalized PERSISTED setting so an in-progress draft is never clobbered.
    const html = renderToStaticMarkup(
      <SettingsPanel
        {...makeSettingsProps({
          activeTab: 'appearance',
          transcriptFontFamily: 'ZZCustomStack, sans-serif',
          persistedTranscriptFontFamily: 'ZZCustomStack, sans-serif'
        })}
      />
    )
    expect(html).toContain('settings-font-custom-input')
    expect(html).toContain('ZZCustomStack, sans-serif')
  })

  it('resets the custom-font input to the default stack when the persisted value is empty', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        {...makeSettingsProps({
          activeTab: 'appearance',
          transcriptFontFamily: 'ZZCustomStack, sans-serif',
          persistedTranscriptFontFamily: ''
        })}
      />
    )
    // normalizeFontFamily('', taskwraith) → the TaskWraith default stack.
    expect(html).toContain('Avenir Next')
  })

  it('uses shared segmented controls for appearance mode choices', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        {...makeSettingsProps({
          activeTab: 'appearance',
          mode: 'soft_glass',
          funFxMode: 'cinematic',
          advancedFx: {
            agentAura: false,
            livingWorkspace: false,
            dataViz: false,
            refraction: false,
            intensity: 'cinematic'
          }
        })}
      />
    )

    expect(html).toContain('class="segmented-control segmented-control--compact settings-option-list settings-option-list-inline"')
    expect(html).toContain('role="radiogroup" aria-label="Window material"')
    expect(html).toContain('role="radio" aria-checked="true"')
    expect(html).toContain('aria-label="Epic FX mode"')
    expect(html).toContain('aria-label="FX Labs intensity"')
  })

  it('offers an Install button beside Copy for provider, host-tool, and model commands', () => {
    const html = renderToStaticMarkup(<SettingsPanel {...makeSettingsProps({})} />)

    expect(html).toContain('Run the Codex install command in Terminal')
    const expectedHostCliPlatform =
      typeof navigator !== 'undefined' && /Win/i.test(navigator.platform || '')
        ? 'Windows'
        : 'macOS'
    expect(html).toContain(
      `Run the GitHub CLI (${expectedHostCliPlatform}) install command in Terminal`
    )
    expect(html).toContain('Run the Qwen 3 (4B Param) pull command in Terminal')
    expect(html).toContain('>Install<')
  })

  it('renders Cursor and Grok as CLI-login providers without raw env flags', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        {...makeSettingsProps({
          onProviderLogin: () => {},
          onProviderLogout: () => {},
          onProviderUpgrade: () => {}
        })}
      />
    )

    expect(html).toContain('settings-provider-auth-card-partial provider-cursor')
    expect(html).toContain('cursor-agent login')
    expect(html).toContain('Open Terminal to sign in')
    expect(html).toContain('settings-provider-auth-card-partial provider-grok')
    expect(html).toContain('Available · CLI sign-in')
    expect(html).toContain(
      'settings-provider-auth-status-dot settings-provider-auth-status-dot-signed-in'
    )
    expect(html).toContain('Provider tools')
    expect(html).not.toContain('TASKWRAITH_DISABLE_CURSOR')
    expect(html).not.toContain('TASKWRAITH_DISABLE_GROK')
    expect(html).not.toContain('Managed runs unavailable')
  })

  it('describes Kimi structural compatibility failures without a reviewed-roster gate', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        {...makeSettingsProps({
          kimiAuthStatus: {
            available: false,
            authState: 'oauth',
            apiKeyConfigured: false,
            encryptionAvailable: true,
            binaryPath: '/opt/kimi',
            transportSupported: false
          }
        })}
      />
    )

    expect(html).toContain('stable identity/startup/ACP compatibility checks failed')
    expect(html).toContain('Structural ACP admission is always enabled')
    expect(html).toContain('unattested-development')
    expect(html).toContain('Credentials do not bypass')
    expect(html).not.toContain('reviewed ACP runtime admission')
    expect(html).not.toContain('reviewed runtime admission')
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

  it('renders the Mistral Vibe plan setup card separately from Pi API keys', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        {...makeSettingsProps({
          providerStatusByProvider: {
            mistral: { available: true, authState: 'unknown' }
          },
          onProviderLogin: () => {},
          onProviderUpgrade: () => {}
        })}
      />
    )

    const mistralStart = html.indexOf('provider-mistral')
    expect(mistralStart).toBeGreaterThanOrEqual(0)
    const nextProviderCard = html.indexOf(
      '<article class="settings-provider-auth-card',
      mistralStart + 'provider-mistral'.length
    )
    const card = html.slice(mistralStart, nextProviderCard === -1 ? undefined : nextProviderCard)
    expect(card).toContain('Mistral Vibe over managed ACP')
    expect(card).toContain('vibe --setup')
    expect(card).toContain('Mistral plan')
    expect(card).toContain('Pi’s metered Mistral API-key route')
    expect(card).toContain('Open Terminal to sign in')
    expect(card).toContain('Upgrade CLI…')
    expect(card).not.toContain('Sign out')
  })

  it('buries the AntiGravity risk-consent card after Ollama', () => {
    const html = renderToStaticMarkup(<SettingsPanel {...makeSettingsProps()} />)

    const ollamaCard = html.indexOf('data-provider="ollama"')
    const antigravityCard = html.indexOf('data-provider="antigravity"')
    expect(ollamaCard).toBeGreaterThan(-1)
    expect(antigravityCard).toBeGreaterThan(ollamaCard)
    expect(html).toContain('Disabled — explicit consent required')
    expect(html).toContain('Antigravity Additional Terms')
    expect(html).toContain('February 2026')
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

  it('reports Pi and Mistral as first-class runtime availability, not delegated MCP seats', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        {...makeSettingsProps({
          activeTab: 'mcp',
          providerStatusByProvider: {
            pi: { available: true },
            mistral: { available: true }
          },
          providerCapabilitiesByProvider: {
            pi: {
              mcp: {
                state: 'gated',
                source: 'taskwraith',
                available: true,
                enabled: true,
                installed: true,
                tools: ['ensemble_yield'],
                message: 'Per-run Pi coordination extension.'
              }
            } as any,
            mistral: {
              mcp: {
                state: 'delegated',
                source: 'bridge',
                available: true,
                enabled: true,
                installed: true,
                tools: [],
                message: 'Per-run Vibe broker.'
              }
            } as any
          }
        })}
      />
    )
    const card = (provider: string) => {
      const marker = `settings-mcp-server-card provider-${provider}`
      const start = html.indexOf(marker)
      expect(start).toBeGreaterThanOrEqual(0)
      const end = html.indexOf('settings-mcp-server-card provider-', start + marker.length)
      return html.slice(start, end === -1 ? undefined : end)
    }

    const pi = card('pi')
    const mistral = card('mistral')
    for (const surface of [pi, mistral]) {
      expect(surface).toContain('<span class="settings-mcp-state-pill">available</span>')
      expect(surface).toContain('<span>first-class runtime</span>')
      expect(surface).not.toContain('>delegated</span>')
      expect(surface).not.toContain('>gated</span>')
      expect(surface).not.toContain('Provider-managed MCP')
    }
    expect(pi).toContain('Pi runtime')
    expect(pi).toContain('first-class TaskWraith provider')
    expect(mistral).toContain('Mistral Vibe ACP')
    expect(mistral).toContain('first-class Mistral Vibe ACP provider')
  })

  it('hides the AntiGravity connected-surface card until an admission lane is live', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel {...makeSettingsProps({ activeTab: 'mcp' })} />
    )

    // AntiGravity is offered CONDITIONALLY, so with neither the agy risk opt-in
    // nor a configured Gemini API key it must not appear as an offer surface —
    // and must not inflate the "providers reporting MCP/bridge status" total.
    expect(html).not.toContain('settings-mcp-server-card provider-antigravity')
    expect(html).toContain('settings-mcp-server-card provider-claude')
  })

  it('reports an opted-in AntiGravity as runtime availability, not a delegated or gated seat', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        {...makeSettingsProps({
          activeTab: 'mcp',
          antigravityEnabled: true,
          antigravityOptInAcceptedAt: 1_700_000_000_000,
          providerStatusByProvider: {
            antigravity: { available: true, authState: 'oauth' }
          }
        })}
      />
    )

    const marker = 'settings-mcp-server-card provider-antigravity'
    const start = html.indexOf(marker)
    expect(start).toBeGreaterThanOrEqual(0)
    const end = html.indexOf('settings-mcp-server-card provider-', start + marker.length)
    const card = html.slice(start, end === -1 ? undefined : end)

    // The capability contract hard-codes an `unsupported` MCP block for this
    // provider; the card must not inherit it as a permanent provider-managed
    // "unavailable" that ignores whether the lane actually works.
    expect(card).toContain('<span class="settings-mcp-state-pill">available</span>')
    expect(card).not.toContain('>delegated</span>')
    expect(card).not.toContain('>gated</span>')
    expect(card).not.toContain('Provider-managed MCP')
    expect(card).toContain('agy CLI')
    expect(card).toContain('official agy CLI in print mode')
    // The agy transport genuinely gets no host tool surface.
    expect(card).toContain('<span>No tools</span>')
  })

  it('reports an unavailable AntiGravity as unavailable rather than gated', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        {...makeSettingsProps({
          activeTab: 'mcp',
          antigravityEnabled: true,
          antigravityOptInAcceptedAt: 1_700_000_000_000,
          providerStatusByProvider: {
            antigravity: { available: false, authState: 'unknown' }
          }
        })}
      />
    )

    const marker = 'settings-mcp-server-card provider-antigravity'
    const start = html.indexOf(marker)
    expect(start).toBeGreaterThanOrEqual(0)
    const end = html.indexOf('settings-mcp-server-card provider-', start + marker.length)
    const card = html.slice(start, end === -1 ? undefined : end)

    expect(card).toContain('<span class="settings-mcp-state-pill">unavailable</span>')
    expect(card).not.toContain('>gated</span>')
    expect(card).toContain('not available')
    expect(card).toContain('admitted but not ready')
  })

  it('reports the AntiGravity Gemini API lane as a bridge-backed tool surface', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        {...makeSettingsProps({
          activeTab: 'mcp',
          antigravityEnabled: true,
          antigravityOptInAcceptedAt: 1_700_000_000_000,
          providerStatusByProvider: {
            antigravity: { available: true, authState: 'api-key', binarySource: 'gemini-api' }
          }
        })}
      />
    )

    const marker = 'settings-mcp-server-card provider-antigravity'
    const start = html.indexOf(marker)
    expect(start).toBeGreaterThanOrEqual(0)
    const end = html.indexOf('settings-mcp-server-card provider-', start + marker.length)
    const card = html.slice(start, end === -1 ? undefined : end)

    expect(card).toContain('<span class="settings-mcp-state-pill">available</span>')
    expect(card).toContain('Gemini API')
    expect(card).toContain('<span>bridge</span>')
    // The SDK lane really does receive the TaskWraith catalog as function
    // declarations and TaskWraith executes the calls, so it reports the catalog
    // size like every other bridge-backed seat.
    expect(card).toContain(`<span>${TASKWRAITH_MCP_TOOLS.length} tools</span>`)
    expect(card).not.toContain('Provider-managed MCP')
  })

  it('offers direct MCP server management actions from Provider Tools', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel {...makeSettingsProps({ activeTab: 'mcp' })} />
    )

    expect(html).toContain('Provider tools and TaskWraith bridge')
    expect(html).toContain('User-managed MCP servers live in the')
    expect(html).toContain('Import config')
    expect(html).toContain('Add server')
    expect(html).toContain('Open MCP Servers')
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

  it('renders dedicated Mesh Topology rows and icon references in Provider Tools', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel {...makeSettingsProps({ activeTab: 'mcp' })} />
    )

    expect(html).toContain('<strong>Mesh Topology Convert</strong>')
    expect(html).toContain('<strong>Mesh Topology Inspect</strong>')
    expect(html).toContain('<strong>Mesh Topology Edit</strong>')
    expect(html).toContain('<code>tool:mesh-convert</code>')
    expect(html).toContain('<code>tool:mesh-inspect</code>')
    expect(html).toContain('<code>tool:mesh-edit</code>')
  })

  it('renders every canonical TaskWraith MCP tool in Provider Tools', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel {...makeSettingsProps({ activeTab: 'mcp' })} />
    )

    expect(uncategorizedMcpToolsForSettings()).toEqual([])
    expect(html).toContain(`${TASKWRAITH_MCP_TOOLS.length} of ${TASKWRAITH_MCP_TOOLS.length} tools`)
    for (const tool of TASKWRAITH_MCP_TOOLS) {
      expect(html).toContain(`<code>TaskWraith__${tool}</code>`)
    }
  })

  it('groups recent MCP tool families under their product headers', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel {...makeSettingsProps({ activeTab: 'mcp' })} />
    )
    const groupSlice = (label: string, nextLabel: string) => {
      const start = html.indexOf(`<strong>${label}</strong>`)
      const end = html.indexOf(`<strong>${nextLabel}</strong>`, start + 1)
      expect(start).toBeGreaterThanOrEqual(0)
      expect(end).toBeGreaterThan(start)
      return html.slice(start, end)
    }

    expect(groupSlice('Canvas and launches', 'Ensemble and collaboration')).toContain(
      '<strong>Canvas Sketch Get</strong>'
    )
    expect(groupSlice('Ensemble and collaboration', 'Goals and evidence')).toContain(
      '<strong>Ensemble Fanout</strong>'
    )
    expect(groupSlice('Goals and evidence', 'Recall and wakeups')).toContain(
      '<strong>Workspace Board Snapshot</strong>'
    )
    expect(groupSlice('Recall and wakeups', 'Media tools')).toContain(
      '<strong>Tw Recall Find</strong>'
    )
    expect(groupSlice('Media tools', 'Creative apps')).toContain('<strong>Audio Mix</strong>')
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
    expect(mcpHtml).toContain('no manual Grok MCP install is required')
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
    expect(html).toContain('Search user MCP servers')
    expect(html).toContain('3 of 3 servers')
    expect(html).toContain('<span>enabled</span><span>stdio</span><span>npx</span>')
    expect(html).toContain('2 args')
    expect(html).toContain('1 env var')
    expect(html).toContain('1 header')
    expect(html).toContain('bearer env')
    expect(html).toContain('Import config')
    expect(html).toContain('Codex + Claude')
    expect(html).toContain('stdio/HTTP provider attachment')
    expect(html).toContain('<span>Active</span><strong>3</strong><small>active definitions</small>')
    expect(html).toContain(
      '<span>Ready</span><strong>3</strong><small>attachable on next launch</small>'
    )
    expect(html).toContain(
      '<span>Needs attention</span><strong>0</strong><small>enabled but incomplete</small>'
    )
    expect(html).toContain(
      '<span>Codex export</span><strong>2</strong><small>config-ready TOML entries</small>'
    )
    expect(html).toContain(
      '<span>Claude export</span><strong>3</strong><small>config-ready JSON entries</small>'
    )
    expect(html).toContain(
      '<span>Cursor export</span><strong>2</strong><small>mcp.json entries</small>'
    )
    expect(html).toContain('runtime: Codex + Claude')
    expect(html).toContain('runtime: Claude')
    expect(html).toContain('Ready for Codex + Claude')
    expect(html).toContain('Ready for Claude')
    expect(html).toContain(
      'Cursor JSON remains exportable; managed Path-B runs attach TaskWraith’s built-in broker separately and do not attach these user-server records'
    )
    expect(html).toContain('SSE attaches to Claude only')
    expect(html).toContain('Codex TOML')
    expect(html).toContain('Claude JSON')
    expect(html).toContain('Cursor mcp.json')
    expect(html).toContain(
      'Config previews redact stored values. Provider copy buttons use the saved config; audit JSON stays redacted for review.'
    )
    expect(html).toContain('Audit JSON')
    expect(html).toContain('Provider config snippets')
    expect(html).toContain('Previews redact stored values. Copy buttons use the saved config.')
    expect(html).toContain('Copy Claude')
    expect(html).toContain('Copy Cursor')
    expect(html).toContain('Copy Codex')
    expect(html).toContain('All servers audit JSON')
    expect(html).toContain('Copy audit JSON')
    expect(html).toContain('Copy Claude JSON')
    expect(html).toContain('Claude config JSON')
    expect(html).toContain('Copy Cursor JSON')
    expect(html).toContain('Cursor config JSON')
    expect(html).toContain('Copy Codex TOML')
    expect(html).toContain('Codex config TOML')
    expect(html).toContain('&quot;command&quot;: &quot;npx&quot;')
    expect(html).toContain('&quot;PROJECT_ROOT&quot;: &quot;[stored in TaskWraith settings]&quot;')
    expect(html).not.toContain('&quot;PROJECT_ROOT&quot;: &quot;/Users/chris/project&quot;')
    expect(html).toContain('&quot;Authorization&quot;: &quot;[stored in TaskWraith settings]&quot;')
    expect(html).toContain('&quot;bearer_token_env_var&quot;: &quot;DOCS_TOKEN&quot;')
    expect(html).not.toContain('Bearer ${DOCS_TOKEN}')
    expect(html).toContain('Add server')
  })

  it('shows why enabled MCP server definitions are not launch-ready', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        {...makeSettingsProps({
          activeTab: 'mcp-servers',
          userMcpServers: [
            {
              id: 'server-bad',
              name: 'bad remote',
              enabled: true,
              transport: 'http',
              url: 'ftp://example.test/mcp'
            }
          ]
        })}
      />
    )

    expect(html).toContain(
      '<span>Needs attention</span><strong>1</strong><small>enabled but incomplete</small>'
    )
    expect(html).toContain('Needs attention')
    expect(html).toContain('URL must use http:// or https://')
  })

  it('offers import from provider config in the empty MCP Servers state', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel {...makeSettingsProps({ activeTab: 'mcp-servers', userMcpServers: [] })} />
    )

    expect(html).toContain('No MCP servers added')
    expect(html).toContain('import existing Claude, Cursor, or Codex config')
    expect(html).toContain('Add server')
    expect(html).toContain('Import config')
  })

  it('surfaces user-managed MCP servers in Safety & Privacy', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        {...makeSettingsProps({
          activeTab: 'safety-privacy',
          userMcpServers: [
            {
              id: 'server-docs',
              name: 'docs',
              enabled: true,
              transport: 'http',
              url: 'https://example.test/mcp',
              headers: {
                Authorization: 'Bearer ${DOCS_TOKEN}'
              }
            },
            {
              id: 'server-disabled',
              name: 'disabled',
              enabled: false,
              transport: 'stdio',
              command: 'node'
            },
            {
              id: 'server-bad',
              name: 'bad',
              enabled: true,
              transport: 'http',
              url: 'ftp://example.test/mcp'
            }
          ]
        })}
      />
    )

    expect(html).toContain('User MCP servers')
    expect(html).toContain('1 active definitions')
    expect(html).toContain('Provider tool surfaces')
    expect(html).toContain('Open Provider Tools')
    expect(html).toContain('User-managed MCP servers')
    expect(html).toContain('External MCP server commands, URLs, env vars, and headers')
    expect(html).toContain('Open MCP Servers')
  })

  it('protects the suggested policy posture behind the override hatch', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel {...makeSettingsProps({ activeTab: 'safety-privacy' })} />
    )

    expect(html).toContain('Suggested defaults work with each seat')
    expect(html).toContain('Suggested defaults')
    expect(html).toContain('Override policies…')
    expect(html).toContain('data-policy-origin="suggested"')
    expect(html).not.toContain('aria-label="Shell commands policy"')
  })

  it('reports saved posture overrides before the hatch is opened', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        {...makeSettingsProps({
          activeTab: 'safety-privacy',
          agenticServices: {
            ...DEFAULT_AGENTIC_SERVICES,
            shellCommands: 'allow',
            fileChanges: 'allow'
          }
        })}
      />
    )

    expect(html).toContain('2 overrides')
    expect(html).toContain('Always allow')
    expect(html).toContain('>Override</span>')
  })

  it('gates the legacy Provider policy controls with the same hatch', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel {...makeSettingsProps({ activeTab: 'providers' })} />
    )

    expect(html).toContain('Unlocking either surface unlocks both')
    expect(html).toContain('Override policies…')
    expect(html).toMatch(
      /<label class="settings-service-row"><span>Shell commands<\/span><select class="settings-select" disabled="">/
    )
    expect(html).toMatch(
      /<label class="settings-service-row"><span>Network access<\/span><select class="settings-select" disabled="">/
    )
  })

  it('keeps update controls out of General and tucks maintenance behind a disclosure', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel {...makeSettingsProps({ activeTab: 'behavior' })} />
    )

    expect(html).toContain('Advanced troubleshooting &amp; audit data')
    expect(html).toContain('Updates are managed from the sidebar.')
    expect(html).toMatch(/<details class="settings-group span-all settings-user-mcp-config">/)
    expect(html).not.toContain('Enable Auto-Update')
    expect(html).not.toContain('Update channel')
    expect(html).not.toContain('Check for updates')
  })

  it('does not render Gemini checkpointing in General', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        {...makeSettingsProps({ activeTab: 'behavior', geminiCheckpointingEnabled: true })}
      />
    )

    expect(html).not.toContain('Gemini checkpointing')
    expect(html).not.toContain('--checkpointing')
  })

  it('renders managed-policy status when organization controls are active', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        {...makeSettingsProps({
          activeTab: 'behavior',
          managedPolicyStatus: {
            active: true,
            organizationName: 'Acme Corp',
            source: 'signed-mdm-preferences',
            lockedSettings: ['agenticServices', 'approvalTimeouts'],
            enforcedSettings: ['approvalTimeouts'],
            errors: []
          }
        })}
      />
    )

    expect(html).toContain('Managed by organization')
    expect(html).toContain('Acme Corp is enforcing TaskWraith settings from signed-mdm-preferences.')
    expect(html).toContain('Locked controls: agenticServices, approvalTimeouts')
  })

  it('locks audit retention controls when organization policy owns them', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        {...makeSettingsProps({
          activeTab: 'behavior',
          managedPolicyStatus: {
            active: true,
            organizationName: 'Acme Corp',
            source: 'signed-mdm-preferences',
            lockedSettings: ['auditRetention'],
            enforcedSettings: ['auditRetention'],
            errors: []
          }
        })}
      />
    )

    expect(html).toContain('Audit retention settings are managed by organization policy.')
    expect(html).toMatch(
      /<label class="settings-service-row"><span>Enable audit retention purge<\/span><input type="checkbox" disabled=""/
    )
    expect(html).toMatch(
      /<input class="settings-input" type="number" min="1" max="3650" disabled="" style="width:84px" value="365"/
    )
    expect(html).toContain('Dry-run retention')
    expect(html).toContain('Purge expired evidence')
  })

  it('renders the latest signed audit bundle verification result', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        {...makeSettingsProps({
          activeTab: 'behavior',
          auditBundleVerificationResult: {
            ok: true,
            path: '/tmp/taskwraith-audit.json',
            manifest: {
              generatedAt: '2026-07-03T10:11:12.000Z',
              redactionMode: 'default',
              filters: { workspaceId: 'workspace-1' },
              tamperEvidence: 'local_hashes_signed'
            },
            verification: {
              ok: true,
              signaturePresent: true,
              payloadHashValid: true,
              signatureValid: true,
              sectionHashesValid: true,
              countsValid: true,
              keyId: 'local-key-1'
            }
          }
        })}
      />
    )

    expect(html).toContain('Latest audit bundle verification: passed')
    expect(html).toContain('/tmp/taskwraith-audit.json')
    expect(html).toContain('signed local hashes')
    expect(html).toContain('Signature: valid')
    expect(html).toContain('local-key-1')
    expect(html).toContain('payload hash: pass')
    expect(html).toContain('section hashes: pass')
    expect(html).toContain('counts: pass')
  })

  it('renders audit bundle verification failure details', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        {...makeSettingsProps({
          activeTab: 'behavior',
          auditBundleVerificationResult: {
            ok: false,
            error: 'Bundle sections were modified after signing.',
            verification: {
              ok: false,
              signaturePresent: true,
              payloadHashValid: true,
              signatureValid: false,
              sectionHashesValid: false,
              countsValid: true,
              reason: 'section hash mismatch'
            }
          }
        })}
      />
    )

    expect(html).toContain('Latest audit bundle verification: failed')
    expect(html).toContain('Signature: invalid')
    expect(html).toContain('section hashes: fail')
    expect(html).toContain('Reason: section hash mismatch')
  })

  it('renders redacted local feedback receipt status in product operations', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        {...makeSettingsProps({
          activeTab: 'behavior',
          productOperationsStatus: {
            overallStatus: 'ok',
            recentCrashes: [],
            releaseAutomation: {
              status: 'ok',
              notarization: { message: 'notarization ready' }
            },
            counts: {
              queuedRuns: 0,
              activeRuns: 0
            },
            auditReceipts: {
              counts: {
                messageFeedback: 4,
                messageFeedbackCastingSignals: 2,
                auditBundleVerifications: 3
              },
              hashes: {
                messageFeedback: 'a'.repeat(64),
                messageFeedbackCastingSignals: 'b'.repeat(64),
                auditBundleVerifications: 'c'.repeat(64)
              },
              recent: {
                auditBundleVerifications: [
                  {
                    idHash: 'd'.repeat(64),
                    verifiedAt: '2026-07-03T10:11:12.000Z',
                    ok: true,
                    bundlePathHash: 'e'.repeat(64),
                    hasBundlePathBasename: true,
                    tamperEvidence: 'local_hashes_signed',
                    signaturePresent: true,
                    signatureValid: true,
                    payloadHashValid: true,
                    sectionHashesValid: true,
                    countsValid: true
                  }
                ]
              }
            }
          } as any
        })}
      />
    )

    expect(html).toContain('Local feedback receipts: 4 ratings, 2 casting aggregates.')
    expect(html).toContain('feedback aaaaaaaaaaaa')
    expect(html).toContain('casting bbbbbbbbbbbb')
    expect(html).toContain('Free-text notes stay redacted')
    expect(html).toContain('. Audit bundle verification receipts: 3 retained; hash cccccccccccc')
    expect(html).toContain('Recent retained verification receipts are redacted')
    expect(html).toContain('Passed · 2026-07-03T10:11:12.000Z')
    expect(html).toContain('signature valid')
    expect(html).toContain('receipt dddddddddddd')
    expect(html).toContain('path eeeeeeeeeeee')
    expect(html).not.toContain('/Users/alice/private')
  })

  it('locks approval timeout controls when organization policy owns them', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        {...makeSettingsProps({
          activeTab: 'behavior',
          managedPolicyStatus: {
            active: true,
            organizationName: 'Acme Corp',
            source: 'signed-mdm-preferences',
            lockedSettings: ['approvalTimeouts'],
            enforcedSettings: ['approvalTimeouts'],
            errors: []
          }
        })}
      />
    )

    expect(html).toContain('Approval timeout settings are managed by organization policy.')
    expect(html).toMatch(/Auto-deny approvals after a timeout/)
    expect(html).toMatch(/<input type="checkbox" disabled="" checked=""/)
    expect(html).toMatch(/class="approval-timeout-field-input" disabled="" value="120"/)
  })

  it('locks agentic service controls when organization policy owns them', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        {...makeSettingsProps({
          activeTab: 'providers',
          managedPolicyStatus: {
            active: true,
            organizationName: 'Acme Corp',
            source: 'signed-mdm-preferences',
            lockedSettings: ['agenticServices'],
            enforcedSettings: ['agenticServices'],
            errors: []
          }
        })}
      />
    )

    expect(html).toContain('Agentic service policy is managed by organization policy.')
    expect(html).toMatch(
      /<label class="settings-service-row"><span>Shell commands<\/span><select class="settings-select" disabled="">/
    )
    expect(html).toMatch(
      /<label class="settings-service-row"><span>Network access<\/span><select class="settings-select" disabled="">/
    )
  })

  it('locks Codex sandbox fallback when organization policy owns it', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        {...makeSettingsProps({
          activeTab: 'providers',
          managedPolicyStatus: {
            active: true,
            organizationName: 'Acme Corp',
            source: 'signed-mdm-preferences',
            lockedSettings: ['codexSandboxFallback'],
            enforcedSettings: ['codexSandboxFallback'],
            errors: []
          }
        })}
      />
    )

    expect(html).toContain('Codex sandbox fallback is managed by organization policy.')
    expect(html).toMatch(
      /<label class="settings-service-row"><span>Codex sandbox fallback<\/span><select class="settings-select" disabled="">/
    )
  })

  it('locks TaskWraith MCP bridge enablement when organization policy owns it', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        {...makeSettingsProps({
          activeTab: 'mcp',
          geminiMcpBridgeEnabled: true,
          managedPolicyStatus: {
            active: true,
            organizationName: 'Acme Corp',
            source: 'signed-mdm-preferences',
            lockedSettings: ['geminiMcpBridgeEnabled'],
            enforcedSettings: ['geminiMcpBridgeEnabled'],
            errors: []
          }
        })}
      />
    )

    expect(html).toContain('TaskWraith MCP bridge enablement is managed by organization policy.')
    expect(html).toMatch(/<input type="checkbox" disabled="" checked=""/)
    expect(html).toContain('Install / repair')
    expect(html).toContain('Test')
  })

  it('locks user MCP server mutation controls when organization policy owns the setting', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        {...makeSettingsProps({
          activeTab: 'mcp-servers',
          managedPolicyStatus: {
            active: true,
            organizationName: 'Acme Corp',
            source: 'signed-mdm-preferences',
            lockedSettings: ['userMcpServers'],
            enforcedSettings: [],
            errors: []
          },
          userMcpServers: [
            {
              id: 'server-docs',
              name: 'docs',
              enabled: true,
              transport: 'http',
              url: 'https://example.test/mcp'
            }
          ]
        })}
      />
    )

    expect(html).toContain('User MCP server editing is managed by organization policy.')
    expect(html).toContain('<span class="settings-editable-pill">Managed</span>')
    expect(html).toMatch(
      /<button type="button" class="segmented-control-action segmented-control-action--compact" disabled="">Import config<\/button>/
    )
    expect(html).toMatch(
      /<button type="button" class="segmented-control-action segmented-control-action--compact segmented-control-action--primary" disabled="">Add server<\/button>/
    )
    expect(html).toMatch(/<input type="checkbox" disabled="" checked=""/)
    expect(html).toMatch(/<button type="button" class="segmented-control-action segmented-control-action--compact" disabled="">Edit<\/button>/)
    expect(html).toMatch(
      /<button type="button" class="segmented-control-action segmented-control-action--compact segmented-control-action--danger" disabled="">Delete<\/button>/
    )
    expect(html).toContain('Copy audit JSON')
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

  it('imports obvious env secrets as encrypted refs instead of plaintext fields', () => {
    const result = parseUserMcpServersImportJson(
      JSON.stringify({
        mcpServers: {
          filesystem: {
            command: 'npx',
            env: {
              API_BASE_URL: 'http://127.0.0.1:3000',
              API_TOKEN: 'secret-token'
            }
          }
        }
      })
    )

    expect(result.error).toBeUndefined()
    const server = result.servers[0]
    expect(server.env).toEqual({ API_BASE_URL: 'http://127.0.0.1:3000' })
    expect(server.secretRefs).toEqual({ env: ['API_TOKEN'] })
    expect(result.secretValuesByServerId[server.id]).toEqual({
      env: { API_TOKEN: 'secret-token' },
      headers: {}
    })
  })

  it('imports obvious remote header secrets as encrypted refs instead of plaintext headers', () => {
    const result = parseUserMcpServersImportJson(
      JSON.stringify({
        mcpServers: {
          docs: {
            type: 'http',
            url: 'https://example.test/mcp',
            headers: {
              Authorization: 'Bearer secret-token',
              'X-Region': 'eu'
            }
          }
        }
      })
    )

    expect(result.error).toBeUndefined()
    const server = result.servers[0]
    expect(server.headers).toEqual({ 'X-Region': 'eu' })
    expect(server.secretRefs).toEqual({ headers: ['Authorization'] })
    expect(result.secretValuesByServerId[server.id]).toEqual({
      env: {},
      headers: { Authorization: 'Bearer secret-token' }
    })
  })

  it('skips imported remote MCP servers with non-http URLs', () => {
    const result = parseUserMcpServersImportJson(
      JSON.stringify({
        mcpServers: {
          good: {
            type: 'http',
            url: 'https://example.test/mcp'
          },
          bad: {
            type: 'http',
            url: 'ftp://example.test/mcp'
          }
        }
      })
    )

    expect(result.error).toBeUndefined()
    expect(result.skipped).toBe(1)
    expect(result.servers).toHaveLength(1)
    expect(result.servers[0]).toMatchObject({
      name: 'good',
      transport: 'http',
      url: 'https://example.test/mcp'
    })
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

describe('runtime profile secret helpers', () => {
  it('builds runtime profiles with encrypted env refs without storing secret values', () => {
    const result = buildRuntimeProfileFromForm({
      id: '',
      name: 'Codex staging',
      provider: 'codex',
      scope: 'workspace',
      workspaceMode: 'local',
      binaryPath: '/opt/homebrew/bin/codex',
      envText: 'API_BASE_URL=https://staging.example.test',
      envSecretText: 'API_TOKEN=secret-token',
      approvalMode: 'default',
      networkPolicy: 'inherit',
      persistence: 'reusable'
    })

    expect(result.error).toBeUndefined()
    expect(result.profile).toMatchObject({
      name: 'Codex staging',
      provider: 'codex',
      binaryPath: '/opt/homebrew/bin/codex',
      env: { API_BASE_URL: 'https://staging.example.test' },
      secretRefs: { env: ['API_TOKEN'] }
    })
    expect(result.profile?.env).not.toHaveProperty('API_TOKEN')
    expect(result.secretValues).toEqual({ env: { API_TOKEN: 'secret-token' } })
  })

  it('preserves blank existing encrypted env refs and reports removed refs', () => {
    const existing = makeRuntimeProfile({
      secretRefs: { env: ['API_TOKEN', 'OLD_TOKEN'] }
    })
    const result = buildRuntimeProfileFromForm(
      {
        id: existing.id,
        name: existing.name,
        provider: existing.provider,
        scope: existing.scope,
        workspaceMode: existing.workspaceMode,
        binaryPath: '',
        envText: '',
        envSecretText: 'API_TOKEN=',
        approvalMode: 'default',
        networkPolicy: 'inherit',
        persistence: 'reusable'
      },
      existing
    )

    expect(result.error).toBeUndefined()
    expect(result.profile?.secretRefs).toEqual({ env: ['API_TOKEN'] })
    expect(result.secretValues).toEqual({ env: {} })
    expect(result.removedSecretRefs).toEqual(['OLD_TOKEN'])
  })

  it('renders runtime profile encrypted env refs without exposing values', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        {...makeSettingsProps({
          activeTab: 'runtime-profiles',
          runtimeProfiles: [
            makeRuntimeProfile({
              env: { API_BASE_URL: 'https://staging.example.test' },
              secretRefs: { env: ['API_TOKEN'] }
            })
          ]
        })}
      />
    )

    expect(html).toContain('Runtime profiles')
    expect(html).toContain('Codex staging')
    expect(html).toContain('1 encrypted env var')
    expect(html).toContain('Encrypted env')
    expect(html).not.toContain('secret-token')
  })
})

describe('user MCP server name/audit helpers', () => {
  it('builds user MCP servers with encrypted env refs without storing secret values', () => {
    const result = buildUserMcpServerFromForm({
      name: 'filesystem',
      description: '',
      transport: 'stdio',
      command: 'npx',
      url: '',
      argsText: '@modelcontextprotocol/server-filesystem\n/repo',
      envText: 'API_BASE_URL=http://127.0.0.1:3000',
      envSecretText: 'API_TOKEN=secret-token',
      headersText: '',
      headerSecretText: '',
      bearerTokenEnvVar: '',
      enabled: true
    })

    expect(result.error).toBeUndefined()
    expect(result.server).toMatchObject({
      name: 'filesystem',
      transport: 'stdio',
      command: 'npx',
      env: { API_BASE_URL: 'http://127.0.0.1:3000' },
      secretRefs: { env: ['API_TOKEN'] }
    })
    expect(result.server?.env).not.toHaveProperty('API_TOKEN')
    expect(result.secretValues).toEqual({
      env: { API_TOKEN: 'secret-token' },
      headers: {}
    })
  })

  it('builds remote MCP servers with encrypted header refs without storing header secrets', () => {
    const result = buildUserMcpServerFromForm({
      name: 'docs',
      description: '',
      transport: 'http',
      command: '',
      url: 'https://example.test/mcp',
      argsText: '',
      envText: '',
      envSecretText: '',
      headersText: 'X-Region=eu',
      headerSecretText: 'Authorization=Bearer secret-token',
      bearerTokenEnvVar: '',
      enabled: true
    })

    expect(result.error).toBeUndefined()
    expect(result.server).toMatchObject({
      name: 'docs',
      transport: 'http',
      url: 'https://example.test/mcp',
      headers: { 'X-Region': 'eu' },
      secretRefs: { headers: ['Authorization'] }
    })
    expect(result.server?.headers).not.toHaveProperty('Authorization')
    expect(result.secretValues).toEqual({
      env: {},
      headers: { Authorization: 'Bearer secret-token' }
    })
  })

  it('rejects secret refs that also appear in plaintext MCP fields', () => {
    const result = buildUserMcpServerFromForm({
      name: 'filesystem',
      description: '',
      transport: 'stdio',
      command: 'npx',
      url: '',
      argsText: '',
      envText: 'API_TOKEN=plain',
      envSecretText: 'API_TOKEN=secret',
      headersText: '',
      headerSecretText: '',
      bearerTokenEnvVar: '',
      enabled: true
    })

    expect(result.error).toContain('API_TOKEN is listed as both')
    expect(result.server).toBeUndefined()
  })

  it('preserves existing encrypted refs when edited with blank secret values', () => {
    const existing: UserMcpServerConfig = {
      id: 'docs',
      name: 'docs',
      enabled: true,
      transport: 'http',
      url: 'https://example.test/mcp',
      secretRefs: { headers: ['Authorization'] }
    }
    const result = buildUserMcpServerFromForm(
      {
        name: 'docs',
        description: '',
        transport: 'http',
        command: '',
        url: 'https://example.test/mcp',
        argsText: '',
        envText: '',
        envSecretText: '',
        headersText: '',
        headerSecretText: 'Authorization=',
        bearerTokenEnvVar: '',
        enabled: true
      },
      existing
    )

    expect(result.error).toBeUndefined()
    expect(result.server?.secretRefs).toEqual({ headers: ['Authorization'] })
    expect(result.secretValues).toEqual({ env: {}, headers: {} })
  })

  it('labels user MCP server launch readiness', () => {
    expect(
      userMcpServerStatusLabel({
        enabled: true,
        transport: 'stdio',
        command: 'npx'
      })
    ).toBe('enabled')
    expect(
      userMcpServerStatusLabel({
        enabled: false,
        transport: 'http',
        url: 'https://example.test/mcp'
      })
    ).toBe('disabled')
    expect(
      userMcpServerStatusLabel({
        enabled: true,
        transport: 'stdio'
      })
    ).toBe('needs command')
    expect(
      userMcpServerStatusLabel({
        enabled: true,
        transport: 'sse'
      })
    ).toBe('needs URL')
    expect(
      userMcpServerStatusLabel({
        enabled: true,
        transport: 'http',
        url: 'ftp://example.test/mcp'
      })
    ).toBe('needs valid URL')
  })

  it('audits per-server readiness with provider compatibility and blockers', () => {
    expect(
      userMcpServerReadiness({
        id: 'filesystem',
        name: 'filesystem',
        enabled: true,
        transport: 'stdio',
        command: 'npx'
      })
    ).toMatchObject({
      state: 'ready',
      label: 'Ready for Codex + Claude',
      providers: ['Codex', 'Claude'],
      blockers: []
    })
    expect(
      userMcpServerReadiness({
        id: 'bad-remote',
        name: 'bad remote',
        enabled: true,
        transport: 'http',
        url: 'ftp://example.test/mcp'
      })
    ).toMatchObject({
      state: 'blocked',
      label: 'Needs attention',
      providers: [],
      blockers: ['URL must use http:// or https://']
    })
    expect(
      userMcpServerReadiness({
        id: 'legacy',
        name: 'legacy',
        enabled: false,
        transport: 'sse',
        url: 'https://example.test/sse'
      })
    ).toMatchObject({
      state: 'disabled',
      label: 'Disabled',
      providers: [],
      blockers: ['Enable this server before it attaches to provider launches'],
      notes: ['SSE attaches to Claude only']
    })
  })

  it('labels per-server provider export compatibility', () => {
    expect(
      userMcpServerProviderExportLabels({
        id: 'filesystem',
        name: 'filesystem',
        enabled: true,
        transport: 'stdio',
        command: 'npx'
      })
    ).toEqual(['Codex TOML', 'Claude JSON', 'Cursor mcp.json'])
    expect(
      userMcpServerProviderExportLabels({
        id: 'legacy',
        name: 'legacy',
        enabled: true,
        transport: 'sse',
        url: 'https://example.test/sse'
      })
    ).toEqual(['Claude JSON'])
    expect(
      userMcpServerProviderExportLabels({
        id: 'disabled',
        name: 'disabled',
        enabled: false,
        transport: 'http',
        url: 'https://example.test/mcp'
      })
    ).toEqual([])
    expect(
      userMcpServerProviderExportLabels({
        id: 'bad-remote',
        name: 'bad remote',
        enabled: true,
        transport: 'http',
        url: 'ftp://example.test/mcp'
      })
    ).toEqual([])
  })

  it('matches user MCP server searches against safe management fields', () => {
    const server = {
      id: 'server-docs',
      name: 'Docs Search',
      description: 'Project reference docs',
      enabled: true,
      transport: 'http' as const,
      url: 'https://example.test/mcp',
      headers: {
        Authorization: 'Bearer ${DOCS_TOKEN}'
      },
      bearerTokenEnvVar: 'DOCS_TOKEN'
    }
    const bearerOnlyServer = {
      ...server,
      headers: undefined,
      bearerTokenEnvVar: 'DOCS_TOKEN'
    }

    expect(userMcpServerMatchesQuery(server, 'docs search')).toBe(true)
    expect(userMcpServerMatchesQuery(server, 'http')).toBe(true)
    expect(userMcpServerMatchesQuery(server, 'example.test')).toBe(true)
    expect(userMcpServerMatchesQuery(server, 'authorization')).toBe(true)
    expect(userMcpServerMatchesQuery(bearerOnlyServer, 'authorization')).toBe(true)
    expect(userMcpServerMatchesQuery(server, 'DOCS_TOKEN')).toBe(true)
    expect(userMcpServerMatchesQuery(server, 'claude json')).toBe(true)
    expect(userMcpServerMatchesQuery(bearerOnlyServer, 'Bearer')).toBe(false)
    expect(userMcpServerMatchesQuery(server, 'Bearer')).toBe(false)
    expect(userMcpServerMatchesQuery(server, 'filesystem')).toBe(false)
  })

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

  it('skips invalid remote URLs from provider config exports', () => {
    const servers: UserMcpServerConfig[] = [
      {
        id: 'bad-remote',
        name: 'bad remote',
        enabled: true,
        transport: 'http',
        url: 'ftp://example.test/mcp'
      },
      {
        id: 'docs',
        name: 'docs',
        enabled: true,
        transport: 'http',
        url: 'https://example.test/mcp'
      }
    ]

    expect(formatUserMcpServersClaudeJson(servers)).toContain('"user_docs"')
    expect(formatUserMcpServersClaudeJson(servers)).not.toContain('bad_remote')
    expect(formatUserMcpServersCursorJson(servers)).toContain('"user_docs"')
    expect(formatUserMcpServersCursorJson(servers)).not.toContain('bad_remote')
    expect(formatUserMcpServersCodexToml(servers)).toContain('[mcp_servers.user_docs]')
    expect(formatUserMcpServersCodexToml(servers)).not.toContain('bad_remote')
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

    expect(toml).toContain('[mcp_servers.user_filesystem]')
    expect(toml).toContain('command = "npx"')
    expect(toml).toContain('args = ["@modelcontextprotocol/server-filesystem", "/repo"]')
    expect(toml).toContain('env = { PROJECT_ROOT = "/repo" }')
    expect(toml).toContain('[mcp_servers.user_docs_remote]')
    expect(toml).toContain('url = "https://example.test/mcp"')
    expect(toml).toContain('bearer_token_env_var = "DOCS_TOKEN"')
    expect(toml).toContain(
      'http_headers = { Authorization = "Bearer ${DOCS_TOKEN}", X-Region = "eu" }'
    )
    expect(toml).not.toContain('legacy')
    expect(toml).not.toContain('disabled')
  })

  it('formats enabled Claude-compatible servers as provider JSON including SSE', () => {
    const json = JSON.parse(
      formatUserMcpServersClaudeJson([
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
    )

    expect(json).toEqual({
      mcpServers: {
        user_filesystem: {
          type: 'stdio',
          command: 'npx',
          args: ['@modelcontextprotocol/server-filesystem', '/repo'],
          env: { PROJECT_ROOT: '/repo' }
        },
        user_docs: {
          type: 'http',
          url: 'https://example.test/mcp',
          headers: {
            Authorization: 'Bearer ${DOCS_TOKEN}'
          }
        },
        user_legacy: {
          type: 'sse',
          url: 'https://example.test/sse'
        }
      }
    })
  })

  it('derives Claude and Cursor Authorization headers from bearer token env vars', () => {
    const servers: UserMcpServerConfig[] = [
      {
        id: 'docs',
        name: 'docs',
        enabled: true,
        transport: 'http',
        url: 'https://example.test/mcp',
        bearerTokenEnvVar: 'DOCS_TOKEN'
      }
    ]

    expect(JSON.parse(formatUserMcpServersClaudeJson(servers))).toEqual({
      mcpServers: {
        user_docs: {
          type: 'http',
          url: 'https://example.test/mcp',
          headers: {
            Authorization: 'Bearer ${DOCS_TOKEN}'
          }
        }
      }
    })
    expect(JSON.parse(formatUserMcpServersCursorJson(servers))).toEqual({
      mcpServers: {
        user_docs: {
          url: 'https://example.test/mcp',
          headers: {
            Authorization: 'Bearer ${DOCS_TOKEN}'
          }
        }
      }
    })
    expect(formatUserMcpServersClaudeJson(servers, { redactValues: true })).toContain(
      '"Authorization": "[stored in TaskWraith settings]"'
    )
  })

  it('redacts values in Claude JSON preview mode', () => {
    const json = formatUserMcpServersClaudeJson(
      [
        {
          id: 'filesystem',
          name: 'filesystem',
          enabled: true,
          transport: 'stdio',
          command: 'npx',
          env: { PROJECT_ROOT: '/repo' }
        }
      ],
      { redactValues: true }
    )

    expect(json).toContain('"PROJECT_ROOT": "[stored in TaskWraith settings]"')
    expect(json).not.toContain('/repo')
  })

  it('formats enabled Cursor-compatible servers as mcp.json and skips SSE', () => {
    const json = JSON.parse(
      formatUserMcpServersCursorJson([
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
          id: 'legacy',
          name: 'legacy',
          enabled: true,
          transport: 'sse',
          url: 'https://example.test/sse'
        }
      ])
    )

    expect(json).toEqual({
      mcpServers: {
        user_filesystem: {
          command: 'npx',
          args: ['@modelcontextprotocol/server-filesystem', '/repo'],
          env: { PROJECT_ROOT: '/repo' }
        },
        user_docs: {
          url: 'https://example.test/mcp',
          headers: {
            Authorization: 'Bearer ${DOCS_TOKEN}'
          }
        }
      }
    })
    expect(json.mcpServers).not.toHaveProperty('legacy')
  })

  it('deduplicates provider export keys using runtime-style safe names', () => {
    const json = JSON.parse(
      formatUserMcpServersCursorJson([
        {
          id: 'a',
          name: 'Docs Search',
          enabled: true,
          transport: 'stdio',
          command: 'node'
        },
        {
          id: 'b',
          name: 'Docs Search',
          enabled: true,
          transport: 'http',
          url: 'https://example.test/mcp'
        }
      ])
    )

    expect(Object.keys(json.mcpServers)).toEqual(['user_docs_search', 'user_docs_search_2'])
  })

  it('keeps per-server provider snippets aligned with duplicate full-export names', () => {
    const servers: UserMcpServerConfig[] = [
      {
        id: 'server-docs-a',
        name: 'Docs Search',
        enabled: true,
        transport: 'stdio',
        command: 'node'
      },
      {
        id: 'server-docs-b',
        name: 'Docs Search',
        enabled: true,
        transport: 'http',
        url: 'https://example.test/mcp'
      }
    ]

    expect(formatUserMcpServersCursorJson(servers)).toContain('"user_docs_search_2"')
    expect(formatUserMcpServerClaudeJsonSnippet(servers, servers[1])).toContain(
      '"user_docs_search_2"'
    )
    expect(formatUserMcpServerCursorJsonSnippet(servers, servers[1])).toContain(
      '"user_docs_search_2"'
    )
    expect(formatUserMcpServerCodexTomlSnippet(servers, servers[1])).toContain(
      '[mcp_servers.user_docs_search_2]'
    )
  })

  it('supports redacted previews and unredacted per-server copy snippets', () => {
    const servers: UserMcpServerConfig[] = [
      {
        id: 'server-docs',
        name: 'Docs',
        enabled: true,
        transport: 'http',
        url: 'https://example.test/mcp',
        headers: {
          Authorization: 'Bearer ${DOCS_TOKEN}'
        },
        bearerTokenEnvVar: 'DOCS_TOKEN'
      }
    ]

    expect(
      formatUserMcpServerClaudeJsonSnippet(servers, servers[0], { redactValues: true })
    ).toContain('"Authorization": "[stored in TaskWraith settings]"')
    expect(formatUserMcpServerClaudeJsonSnippet(servers, servers[0])).toContain(
      '"Authorization": "Bearer ${DOCS_TOKEN}"'
    )
    expect(
      formatUserMcpServerCursorJsonSnippet(servers, servers[0], { redactValues: true })
    ).toContain('"Authorization": "[stored in TaskWraith settings]"')
    expect(formatUserMcpServerCursorJsonSnippet(servers, servers[0])).toContain(
      '"Authorization": "Bearer ${DOCS_TOKEN}"'
    )
    expect(
      formatUserMcpServerCodexTomlSnippet(servers, servers[0], { redactValues: true })
    ).toContain('Authorization = "[stored in TaskWraith settings]"')
    expect(formatUserMcpServerCodexTomlSnippet(servers, servers[0])).toContain(
      'Authorization = "Bearer ${DOCS_TOKEN}"'
    )
  })

  it('redacts values in Cursor JSON preview mode', () => {
    const json = formatUserMcpServersCursorJson(
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

    expect(json).toContain('"Authorization": "[stored in TaskWraith settings]"')
    expect(json).not.toContain('Bearer ${DOCS_TOKEN}')
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
