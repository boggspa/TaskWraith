import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { MascotGhost } from './AppChromeSymbols'
import { ComposerShellPreview } from './ComposerShellPreview'
import type {
  AgenticNetworkPolicy,
  AgenticServiceId,
  AgenticServicePolicy,
  AgenticServicesSettings,
  AgenticWorkspaceGrant,
  AppearanceMode,
  CodexSandboxFallbackMode,
  AppSettings,
  NativeSubAgentRequestPolicy,
  ProviderApiKeyStatus,
  ProviderCapabilityContract,
  ProviderId,
  ProviderReroutePlan,
  ProviderRunPauseState,
  ProductOperationsStatus,
  ProductUpdateChannel,
  PromptSurfaceStyle,
  ComposerStyle,
  ThemeAccentStyle,
  ThemeAppearance,
  ThemeCornerStyle,
  ToolIconAccent,
  UserBubbleColor,
  VisualEffectStyle,
  WorkspaceRecord,
  PinnedMessageGroup,
  UsageRecord,
  UserMcpServerConfig,
  UserMcpServerTransport
} from '../../../main/store/types'
import { humaniseModelId } from '../lib/modelDisplayName'
import { getDashboardStatsByGroup, isDashboardStatVisible } from '../lib/dashboardStatRegistry'
import {
  summariseCliProviderEnabled,
  summariseCodexStatus,
  summariseProviderApiKeyStatus,
  type ProviderAuthSummary
} from '../lib/providerAuthSummary'
import { isRetiredProvider } from '../../../shared/retiredProviders'
import { availableIconVariants, type AppIconVariant } from '../../../shared/iconVariants'
import {
  OLLAMA_RUN_PROFILE_OPTIONS,
  OLLAMA_TOOL_CONTROL_TIERS
} from '../../../shared/ollamaTierTables'
import appIconRegularThumb from '../assets/app-icons/regular.png'
import appIconWwdc26Thumb from '../assets/app-icons/wwdc26.png'
import appIconMonolineThumb from '../assets/app-icons/monoline.png'
import appIconGlassThumb from '../assets/app-icons/glass.png'
import {
  COMPOSER_FONT_MATCH_TRANSCRIPT,
  COMPOSER_FONT_OPTIONS,
  CUSTOM_FONT_FALLBACK,
  CUSTOM_FONT_SELECT_VALUE,
  FONT_STACKS,
  TRANSCRIPT_FONT_OPTIONS,
  getFontSelectValue,
  quoteInstalledFontFamily,
  type TypefaceOption
} from '../lib/typefaceOptions'
import { setFxRatesPerUsd } from '../lib/formatCost'
import { formatResetShort } from '../lib/UsageFormat'
import {
  KEY_COMMAND_DEFINITIONS,
  KEY_COMMAND_GROUPS,
  bindingFromKeyboardEvent,
  findKeyCommandConflict,
  formatKeyCommandBinding,
  hasCustomKeyCommandBinding,
  resolveKeyCommandBindings,
  sanitizeKeyCommandOverrides,
  type KeyCommandId
} from '../lib/keyCommands'
import { CHANNELS_GATEWAY_ENABLED, IOS_REMOTE_ENABLED } from '../lib/featureFlags'
// RemoteWorkspacesPanel was previously rendered here under the
// `remote-workspaces` tab. It now lives inside `PairingPage` (the
// "Devices" tab) so paired-device QR + workspace allowlist sit
// together as a single device-management page.
import { ApprovalLedgerPanel } from './ApprovalLedgerPanel'
// BridgeNetworkingPanel + ApnsConfigPanel were previously rendered
// under the "Bridge Networking" tab. They now live inside `PairingPage`
// (the "Devices" tab) so the iOS pair flow + workspace allowlist +
// daemon/APNs configuration sit together as a single device-management
// page.
import { PairingPage } from './PairingPage'
import { SharesPanel } from './SharesPanel'
import { CommittedDraftField } from './CommittedDraftField'
import { MessagesBridgePanel } from './MessagesBridgePanel'
import { ImageGenerationSettingsCard } from './ImageGenerationSettingsCard'
import { LocalServersSettingsPanel } from './LocalServersSettingsPanel'
import { RosterSettingsPanel } from './RosterSettingsPanel'
import { PinnedMessagesSettingsPage } from './PinnedMessagesSettingsPage'
import { UpdateStatusPane } from './UpdateStatusPane'
import { ModelUsageCard } from './ModelUsageCard'
import { ModelUsageSettingsTable, ProviderApiRatesSettingsTable, ModelContextLengthsSettingsTable } from './ModelUsageSettingsTable'
import { TokenUsageChart } from './TokenUsageChart'
import { UsageHeatmap } from './UsageHeatmap'
import { WorkspaceActivityHeatmap } from './WorkspaceActivityHeatmap'
import { WorkspaceRemoteAccessToggle } from './WorkspaceRemoteAccessToggle'
import type { RemoteWorkspaceEntry } from '../../../shared/remoteWorkspaceDefaults'
import type {
  TaskWraithPluginCatalogEntry,
  TaskWraithPluginCatalogSnapshot
} from '../../../shared/plugins/PluginTypes'
import { GrokTelemetryCard } from './GrokTelemetryCard'
import { ProviderLogoTile } from './ProviderLogoTile'
import { ProviderInstallCommands } from './ProviderInstallCommands'
import { ToolFamilyIcon, toolNameToFamily, type ToolFamily } from './icons/ToolFamilyIcon'
import type { ModelUsageAggregate } from '../lib/usageAggregateTypes'
import {
  MEDIA_EDITING_TOOLS,
  TASKWRAITH_MCP_TOOLS,
  type TaskWraithMcpToolName
} from '../../../main/TaskWraithMcpTools'

type ProviderCliUpgradeState = 'idle' | 'opening' | 'opened' | 'error'

interface SettingsPanelProps {
  mode: AppearanceMode
  visualEffectStyle: VisualEffectStyle
  themeAppearance: ThemeAppearance
  themeCornerStyle: ThemeCornerStyle
  themeAccentStyle: ThemeAccentStyle
  toolIconAccent: ToolIconAccent
  userBubbleColor: UserBubbleColor
  appIconVariant: AppIconVariant
  promptSurfaceStyle: PromptSurfaceStyle
  composerStyle: ComposerStyle
  transcriptFontFamily: string
  composerFontFamily: string
  keyCommandBindings?: AppSettings['keyCommandBindings']
  reduceTransparency: boolean
  reduceMotion: boolean
  compactDensity: boolean
  liveActivityViewport: boolean
  sidebarOpacity: number
  mainPaneOpacity: number
  geminiCheckpointingEnabled: boolean
  chatContextTurns: number
  /** 1.0.5-EW25 — User-selected display currency for cost / token-
   * spend chips. The underlying value still comes verbatim from
   * provider event payloads in USD; conversion is renderer-side
   * via `src/renderer/src/lib/formatCost.ts`. */
  currency: 'USD' | 'GBP' | 'EUR'
  /** 1.0.5-EW34 — Currency sub-slice (e): conservative-overestimate
   * bias percent (0–25). Slider in the General tab; applied in
   * `formatCost.ts` before FX conversion. Optional because older
   * settings files won't have the key. */
  currencyOverestimatePercent?: number
  /** Settings → General toggle for Task Complete / Final Summary cards. */
  showRunCompleteSummary?: AppSettings['showRunCompleteSummary']
  /** Settings → General toggle: collapse older Ensemble rounds into cards. */
  ensembleCollapseOlderRounds?: AppSettings['ensembleCollapseOlderRounds']
  /**
   * 1.0.5-EW49 — Dashboard statistics preferences. Per-stat
   * show/hide map + a global "reset all" timestamp. See
   * `src/renderer/src/lib/dashboardStatRegistry.ts` for the
   * canonical stat-key set.
   */
  dashboardStatPrefs?: AppSettings['dashboardStatPrefs']
  welcomeHeatmapPrefs?: AppSettings['welcomeHeatmapPrefs']
  providerRunPauses?: AppSettings['providerRunPauses']
  /** 1.0.5-EW26 — Kimi (Moonshot) compatibility filter toggle. */
  kimiSanitiserEnabled: boolean
  /** 1.0.5-EW26 — User's additional trigger keywords (newline-
   * separated; lines starting with `#` are treated as comments). */
  kimiSanitiserCustomKeywords: string
  userName?: string
  claudeBinaryPath: string
  kimiBinaryPath: string
  ollamaBaseUrl: string
  ollamaDefaultModel: string
  ollamaToolControlTier?: AppSettings['ollamaToolControlTier']
  ollamaDefaultRunProfile?: AppSettings['ollamaDefaultRunProfile']
  ollamaRunProfiles?: AppSettings['ollamaRunProfiles']
  ollamaProviderParityAcknowledgedAt?: string
  ollamaProviderParityWorkspaceGrants?: AppSettings['ollamaProviderParityWorkspaceGrants']
  auditOrchestration?: AppSettings['auditOrchestration']
  agenticServices: AgenticServicesSettings
  nativeSubAgentRequests?: NativeSubAgentRequestPolicy
  /** When true (default), TaskWraith auto-dispatches a continuation run
   * on the parent chat once a sub-thread the parent delegated to (with
   * `returnResultToParent: true`) finishes. See AutoResumeParent.ts. */
  autoResumeParentOnSubThreadCompletion: boolean
  agenticWorkspaceGrantCount: number
  agenticWorkspaceGrants: AgenticWorkspaceGrant[]
  activeProvider: ProviderId
  providerCapabilities?: ProviderCapabilityContract | null
  providerCapabilitiesByProvider?: Partial<Record<ProviderId, ProviderCapabilityContract | null>>
  mcpStatusByProvider?: Partial<Record<ProviderId, any>>
  userMcpServers?: AppSettings['userMcpServers']
  geminiMcpBridgeEnabled: boolean
  codexSandboxFallback: CodexSandboxFallbackMode
  funFxEnabled: boolean
  funFxMode: AppSettings['funFxMode']
  advancedFx: AppSettings['advancedFx']
  autoUpdateEnabled: boolean
  updateChannel: ProductUpdateChannel
  approvalTimeouts: AppSettings['approvalTimeouts']
  productOperationsStatus: ProductOperationsStatus | null
  codexStatus?: any
  claudeAuthStatus?: ProviderApiKeyStatus | null
  kimiAuthStatus?: ProviderApiKeyStatus | null
  ollamaStatus?: any
  /** Cursor / Grok adapter availability (enabled, not force-disabled). Both
   * are CLI-login providers — auth lives in their own CLI — so the cards
   * surface availability + a terminal-login instruction, no API-key field. */
  cursorProviderAvailable?: boolean
  grokProviderAvailable?: boolean
  claudeLoginState?: 'idle' | 'loading' | 'success' | 'error'
  providerCliUpgradeState?: Partial<Record<ProviderId, ProviderCliUpgradeState>>
  onImportCodexUsageCredential?: () => void
  onClearCodexUsageCredential?: () => void
  onTriggerClaudeLogin?: () => void
  onStoreClaudeApiKey?: (key: string) => void
  onClearClaudeApiKey?: () => void
  onStoreKimiApiKey?: (key: string) => void
  onClearKimiApiKey?: () => void
  onProviderUpgrade?: (provider: ProviderId) => void
  // 1.0.6-CRUX42 — open a Terminal running the provider's interactive CLI login
  // (Cursor / Grok). The host wires this to window.api.openProviderLoginTerminal.
  onProviderLogin?: (provider: ProviderId) => void
  onProviderLogout?: (provider: ProviderId) => void
  onRemoveAgenticWorkspaceGrant?: (
    provider: ProviderId,
    workspacePath: string,
    service: AgenticServiceId
  ) => Promise<void> | void
  onInstallGeminiMcpBridge: () => void
  onRefreshGeminiMcpBridgeStatus: () => void
  onRefreshProviderMcpStatus?: (provider: ProviderId) => void
  onRefreshProductOperationsStatus: () => void
  onExportProductDiagnostics: () => void
  onRepairProductInstall: () => void
  onDeleteAllChatHistory?: () => Promise<void> | void
  onChange: (partial: {
    mode?: AppearanceMode
    visualEffectStyle?: VisualEffectStyle
    themeAppearance?: ThemeAppearance
    themeCornerStyle?: ThemeCornerStyle
    themeAccentStyle?: ThemeAccentStyle
    toolIconAccent?: ToolIconAccent
    userBubbleColor?: UserBubbleColor
    appIconVariant?: AppIconVariant
    promptSurfaceStyle?: PromptSurfaceStyle
    composerStyle?: ComposerStyle
    transcriptFontFamily?: string
    composerFontFamily?: string
    keyCommandBindings?: AppSettings['keyCommandBindings']
    reduceTransparency?: boolean
    reduceMotion?: boolean
    compactDensity?: boolean
    liveActivityViewport?: boolean
    sidebarOpacity?: number
    mainPaneOpacity?: number
    sidebarOpacityOverride?: boolean
    mainPaneOpacityOverride?: boolean
    geminiCheckpointingEnabled?: boolean
    chatContextTurns?: number
    /** 1.0.5-EW25 — Display currency for cost / token-spend chips. */
    currency?: 'USD' | 'GBP' | 'EUR'
    /** 1.0.5-EW34 — Conservative-overestimate bias percent (0–25). */
    currencyOverestimatePercent?: number
    /** Settings → General toggle for Task Complete / Final Summary cards. */
    showRunCompleteSummary?: AppSettings['showRunCompleteSummary']
    /** Settings → General toggle: collapse older Ensemble rounds into cards. */
    ensembleCollapseOlderRounds?: AppSettings['ensembleCollapseOlderRounds']
    /**
     * 1.0.5-EW49 — Per-stat visibility map / global "reset all"
     * timestamp. Patches merge into AppSettings; passing a
     * partial visibility object replaces the whole map (the
     * persistence layer merges the rest from the existing
     * settings via the standard `update-settings` IPC).
     */
    dashboardStatPrefs?: AppSettings['dashboardStatPrefs']
    welcomeHeatmapPrefs?: AppSettings['welcomeHeatmapPrefs']
    providerRunPauses?: AppSettings['providerRunPauses']
    /** 1.0.5-EW26 — Kimi compatibility filter on/off. */
    kimiSanitiserEnabled?: boolean
    /** 1.0.5-EW26 — User additions to the trigger keyword list. */
    kimiSanitiserCustomKeywords?: string
    userName?: string
    claudeBinaryPath?: string
    kimiBinaryPath?: string
    ollamaBaseUrl?: string
    ollamaDefaultModel?: string
    ollamaToolControlTier?: AppSettings['ollamaToolControlTier']
    ollamaDefaultRunProfile?: AppSettings['ollamaDefaultRunProfile']
    ollamaRunProfiles?: AppSettings['ollamaRunProfiles']
    ollamaProviderParityAcknowledgedAt?: string
    ollamaProviderParityWorkspaceGrants?: AppSettings['ollamaProviderParityWorkspaceGrants']
    auditOrchestration?: AppSettings['auditOrchestration']
    agenticServices?: AgenticServicesSettings
    nativeSubAgentRequests?: NativeSubAgentRequestPolicy
    userMcpServers?: AppSettings['userMcpServers']
    autoResumeParentOnSubThreadCompletion?: boolean
    geminiMcpBridgeEnabled?: boolean
    codexSandboxFallback?: CodexSandboxFallbackMode
    funFxEnabled?: boolean
    funFxMode?: AppSettings['funFxMode']
    advancedFx?: AppSettings['advancedFx']
    autoUpdateEnabled?: boolean
    updateChannel?: ProductUpdateChannel
    approvalTimeouts?: AppSettings['approvalTimeouts']
  }) => void
  onClose: () => void
  /**
   * Optional controlled tab state. When `activeTab` + `onTabChange`
   * are both provided, the panel renders the content for the
   * caller's chosen tab and routes user clicks through `onTabChange`.
   * Without them the panel keeps its own internal state (back-compat
   * for the legacy sheet form-factor and unit-test mounts).
   */
  activeTab?: SettingsTab
  onTabChange?: (tab: SettingsTab) => void
  /**
   * Workspace-management hooks. Used by the new "Workspaces" tab
   * (Codex-Environments-style list of loaded workspaces with open /
   * pin / remove actions). Optional so any host that doesn't yet
   * surface the tab can leave them unset — the tab content just
   * renders an empty-state in that case.
   */
  workspaces?: WorkspaceRecord[]
  currentWorkspace?: WorkspaceRecord | null
  onSelectWorkspace?: (workspace: WorkspaceRecord) => void
  onSelectWorkspaceDialog?: () => void
  onRemoveWorkspace?: (workspaceId: string) => void
  onTogglePinWorkspace?: (workspaceId: string) => void
  /**
   * Cross-provider usage aggregate. Populated by App's
   * `refreshUsageSummary` from the `getUsage` IPC. Renders the new
   * "Model usage" tab via the existing `ModelUsageCard` plus a
   * headline-tiles strip above it. Optional so test mounts can omit.
   */
  usageSummary?: ModelUsageAggregate[]
  usageRecords?: UsageRecord[]
  pinnedMessageGroups?: PinnedMessageGroup[]
  onOpenPinnedMessage?: (chatId: string, messageId: string) => void
  /**
   * Layout shape. `'sheet'` (default) renders the inline tab bar +
   * "Done" button at the top — the historic modal-sheet treatment.
   * `'takeover'` suppresses that header entirely because the host
   * (App.tsx) renders a `SettingsSidebar` next to the panel that
   * carries the tab list and the back-to-app affordance instead.
   */
  layout?: 'sheet' | 'takeover'
}

type FxRateSnapshot = Awaited<ReturnType<typeof window.api.getFxRates>>

const CONTEXT_TURN_OPTIONS = [0, 2, 4, 6, 8, 10, 12, 16, 20]
const clampPaneOpacity = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.round(parsed))) : 100
}
const VISUAL_EFFECT_OPTIONS: Array<{ value: VisualEffectStyle; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'liquid_glass', label: 'LiquidGlass' },
  { value: 'thin_material', label: 'ultraThinMaterial' },
  { value: 'classic', label: 'PoorMansGlassBackground' }
]
const THEME_OPTIONS: Array<{ value: ThemeAppearance; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'midnight', label: 'Midnight' },
  { value: 'blue', label: 'Blue' },
  { value: 'purple', label: 'Purple' },
  { value: 'pink', label: 'Pink' },
  { value: 'red', label: 'Red' },
  { value: 'orange', label: 'Orange' },
  { value: 'yellow', label: 'Yellow' },
  { value: 'green', label: 'Green' },
  { value: 'graphite', label: 'Graphite' },
  { value: 'rainbow', label: 'Rainbow' },
  { value: 'nebula', label: 'Nebula' },
  { value: 'citrus', label: 'Citrus' },
  { value: 'twilight', label: 'Twilight' },
  { value: 'ocean', label: 'Ocean' },
  { value: 'sunset', label: 'Sunset' },
  { value: 'forest', label: 'Forest' },
  { value: 'cyber', label: 'Cyber' },
  { value: 'candy', label: 'Candy' },
  { value: 'mist', label: 'Mist' },
  { value: 'sage', label: 'Sage' },
  // 1.0.5-EW54 — "Obsidian": charcoal base + warm dusk halos +
  // crisp lit rim borders. The "premium postmodern" reading of
  // dark mode (vs Graphite's colder old-aqua palette).
  { value: 'obsidian', label: 'Obsidian' },
  // 1.0.5-EW61 — "Alabaster": polar inverse of obsidian. Cream
  // near-white base, cool lavender halos, crisp charcoal rim
  // borders, dark-translucent sidebar (the inverse bizarre
  // twin to obsidian's light-on-dark sidebar move).
  { value: 'alabaster', label: 'Alabaster' }
]
const ACCENT_OPTIONS: Array<{ value: ThemeAccentStyle; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'blue', label: 'Blue' },
  { value: 'purple', label: 'Purple' },
  { value: 'pink', label: 'Pink' },
  { value: 'orange', label: 'Orange' },
  { value: 'green', label: 'Green' },
  { value: 'red', label: 'Red' },
  { value: 'yellow', label: 'Yellow' }
]
/**
 * Tool-icon accent. `system` (default) keeps the icons on the
 * theme accent. Named overrides pin the icons to a dedicated
 * colour while leaving the rest of the UI on the user's accent
 * choice — useful for tester debug or for users who want the
 * tool-call ledger to read as a distinct surface.
 */
const APP_ICON_THUMBS: Record<AppIconVariant, string> = {
  regular: appIconRegularThumb,
  wwdc26: appIconWwdc26Thumb,
  monoline: appIconMonolineThumb,
  glass: appIconGlassThumb
}
const TOOL_ICON_ACCENT_OPTIONS: Array<{ value: ToolIconAccent; label: string }> = [
  { value: 'system', label: 'Match accent' },
  { value: 'blue', label: 'Blue' },
  { value: 'purple', label: 'Purple' },
  { value: 'pink', label: 'Pink' },
  { value: 'orange', label: 'Orange' },
  { value: 'green', label: 'Green' },
  { value: 'red', label: 'Red' },
  { value: 'yellow', label: 'Yellow' },
  { value: 'graphite', label: 'Graphite' },
  { value: 'amber', label: 'Amber' },
  { value: 'cyan', label: 'Cyan' },
  { value: 'violet', label: 'Violet' }
]
/**
 * User chat-bubble colour palette. `system` (default) keeps the
 * existing neutral elevated-surface look so users who don't care
 * never see a change. The named options mix the chosen hue into
 * the elevated surface for the bubble background AND apply the
 * same hue (saturated) to the matching "You" label — so the user-
 * side of the transcript reads with a single coherent theme colour
 * rather than diverging between label and bubble. CSS seam:
 * `--user-bubble-base` + `[data-user-bubble-color="X"]` rules in
 * `theme.css`; the swatch dots reuse the same `.accent-*` palette
 * via a dedicated `.user-bubble-color-*` class so the picker
 * preview matches the live result.
 */
const USER_BUBBLE_COLOR_OPTIONS: Array<{ value: UserBubbleColor; label: string }> = [
  { value: 'system', label: 'Default' },
  { value: 'blue', label: 'Blue' },
  { value: 'purple', label: 'Purple' },
  { value: 'pink', label: 'Pink' },
  { value: 'orange', label: 'Orange' },
  { value: 'green', label: 'Green' },
  { value: 'red', label: 'Red' },
  { value: 'yellow', label: 'Yellow' },
  { value: 'graphite', label: 'Graphite' }
]
const PROMPT_SURFACE_OPTIONS: Array<{ value: PromptSurfaceStyle; label: string }> = [
  { value: 'theme', label: 'Follow theme' },
  { value: 'liquid_glass', label: 'Liquid glass' },
  { value: 'classic', label: 'Poor man glass' },
  { value: 'solid', label: 'Solid' }
]
const COMPOSER_STYLE_OPTIONS: Array<{ value: ComposerStyle; label: string; helper: string }> = [
  {
    value: 'default',
    label: 'TaskWraith native',
    helper: 'Provider chrome off; keep the existing TaskWraith shell.'
  },
  {
    value: 'codex',
    label: 'Codex shell',
    helper: 'Codex-like sidebar, transcript, status bar, and composer hierarchy.'
  },
  {
    value: 'claude',
    label: 'Claude shell',
    helper: 'Claude-like sidebar, transcript, status bar, and composer hierarchy.'
  },
  {
    value: 'cursor',
    label: 'Cursor shell',
    helper:
      'Flat neutral-gray Gemini-style pill composer — no glass or gradient effects, theme-immune.'
  },
  {
    value: 'grok',
    label: 'Grok shell',
    helper:
      'Monochrome Grok-like shell with Gemini-style pill layout and no glass or gradient effects.'
  },
  {
    value: 'gemini',
    label: 'Gemini shell',
    helper: 'Gemini-like minimal pill composer, centered welcome, blue focus glow.'
  },
  {
    value: 'kimi',
    label: 'Kimi shell',
    helper: 'Kimi-like dark rounded composer, green-yellow accent, minimal sidebar.'
  },
  {
    value: 'modular',
    label: 'Modular',
    helper: 'Each composer element floats as its own pill — no grouped container.'
  },
  {
    value: 'terminal',
    label: 'Terminal',
    helper: 'Monospace command-line aesthetic with bracketed chips and a caret prompt.'
  },
  {
    value: 'stub',
    label: 'Ticket stub',
    helper: 'Paper-textured composer with a perforated separator above the textarea.'
  },
  {
    value: 'satellite',
    label: 'Satellite',
    helper: 'All containers invisible — every element floats freely on the page.'
  },
  /*
    1.0.5-EW55 — "Obsidian" composer style (renamed from EW54's
    `rimshine`). Pure black fill + crisp 1px white rim + slow rim
    chase animation + subtle white outer glow. Above-row siblings
    (Ensemble chip strip, queued messages, Create-PR, secondary
    workspace pill) inherit the same chrome + corner radius, so
    the composer area reads as one black-with-white-rim family.
    Pairs natively with the Obsidian theme.
  */
  {
    value: 'obsidian',
    label: 'Obsidian',
    helper:
      'Pure black fill with a crisp white rim highlight, slow rim shimmer chase, and matching chrome on the detached rows above. Pairs with the Obsidian theme.'
  },
  /*
    1.0.5-EW61 — "Alabaster" composer style. Polar inverse of
    obsidian: cream fill, charcoal 2px rim, slow black/charcoal
    rim-chase, warm-cream outer glow. Theme-immune subtree
    (locks light-mode tokens regardless of app theme). Pairs
    with the Alabaster theme.
  */
  {
    value: 'alabaster',
    label: 'Alabaster',
    helper:
      'Cream fill with a crisp charcoal rim, slow black rim shimmer chase, and matching chrome on the detached rows above. Pairs with the Alabaster theme.'
  }
]

const AGENTIC_SERVICE_POLICY_OPTIONS: Array<{ value: AgenticServicePolicy; label: string }> = [
  { value: 'workspace', label: 'Ask, then allow workspace' },
  { value: 'ask', label: 'Ask every time' },
  { value: 'allow', label: 'Always allow' },
  { value: 'deny', label: 'Block' }
]
const NETWORK_POLICY_OPTIONS: Array<{ value: AgenticNetworkPolicy; label: string }> = [
  { value: 'allow', label: 'Allow' },
  { value: 'deny', label: 'Block' }
]
const NATIVE_SUB_AGENT_REQUEST_OPTIONS: Array<{
  value: NativeSubAgentRequestPolicy
  label: string
  helper: string
}> = [
  {
    value: 'ask',
    label: 'Ask',
    helper: 'Prompt on the first observable native sub-agent request.'
  },
  {
    value: 'provider',
    label: 'Provider',
    helper: 'Allow provider-native Task / invoke_agent style sub-agents.'
  },
  {
    value: 'taskwraith',
    label: 'TaskWraith',
    helper: 'Redirect native sub-agent requests to durable TaskWraith sub-threads.'
  }
]
const CODEX_SANDBOX_FALLBACK_OPTIONS: Array<{ value: CodexSandboxFallbackMode; label: string }> = [
  { value: 'ask_rerun', label: 'Ask to rerun outside sandbox' },
  { value: 'off', label: 'Off' }
]
const PRODUCT_UPDATE_CHANNEL_OPTIONS: Array<{ value: ProductUpdateChannel; label: string }> = [
  { value: 'debug', label: 'Debug' },
  { value: 'stable', label: 'Stable' },
  { value: 'nightly', label: 'Nightly' }
]
const FUN_FX_MODES: Array<{ value: AppSettings['funFxMode']; label: string; helper: string }> = [
  { value: 'off', label: 'Off', helper: 'No cinematic effects.' },
  { value: 'subtle', label: 'Subtle', helper: 'One effect layer with gentle motion.' },
  { value: 'cinematic', label: 'Cinematic', helper: 'Sky + ghost in synchronized balance.' },
  { value: 'epic', label: 'Epic', helper: 'Adds additional ambient scene accents.' }
]

// OLLAMA_TOOL_CONTROL_TIERS + OLLAMA_RUN_PROFILE_OPTIONS now live in the shared
// table module (src/shared/ollamaTierTables.ts) so the composer's per-chat tier
// picker reuses the exact same labels/helpers. Imported at the top of the file.

// 1.0.6-CRUX41 — cursor + grok are first-class; surface them in the MCP tab's
// connected-surfaces grid (and the refresh-all loop) alongside the core four.
const SETTINGS_PROVIDER_ORDER: ProviderId[] = [
  'codex',
  'claude',
  'kimi',
  'cursor',
  'grok',
  'ollama'
]

const SETTINGS_PROVIDER_LABELS: Record<ProviderId, string> = {
  codex: 'Codex',
  claude: 'Claude',
  gemini: 'Gemini',
  kimi: 'Kimi',
  grok: 'Grok',
  cursor: 'Cursor',
  ollama: 'Ollama'
}

type UserMcpServerFormState = {
  name: string
  description: string
  transport: UserMcpServerTransport
  command: string
  url: string
  argsText: string
  envText: string
  headersText: string
  bearerTokenEnvVar: string
  enabled: boolean
}

const USER_MCP_TRANSPORT_OPTIONS: Array<{ value: UserMcpServerTransport; label: string }> = [
  { value: 'stdio', label: 'stdio' },
  { value: 'http', label: 'HTTP' },
  { value: 'sse', label: 'SSE' }
]
const USER_MCP_RUNTIME_PROVIDERS_BY_TRANSPORT: Record<UserMcpServerTransport, readonly string[]> = {
  stdio: ['Codex', 'Claude', 'Cursor write mode'],
  http: ['Codex', 'Claude', 'Cursor write mode'],
  sse: ['Claude']
}
const USER_MCP_STDIO_HTTP_RUNTIME_LABEL = USER_MCP_RUNTIME_PROVIDERS_BY_TRANSPORT.stdio.join(' + ')
const USER_MCP_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const USER_MCP_HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function emptyUserMcpServerForm(): UserMcpServerFormState {
  return {
    name: '',
    description: '',
    transport: 'stdio',
    command: '',
    url: '',
    argsText: '',
    envText: '',
    headersText: '',
    bearerTokenEnvVar: '',
    enabled: false
  }
}

function formatUserMcpServerArgs(args?: string[]): string {
  return Array.isArray(args) ? args.join('\n') : ''
}

function formatUserMcpServerEnv(env?: Record<string, string>): string {
  return env
    ? Object.entries(env)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')
    : ''
}

function formatUserMcpServerHeaders(headers?: Record<string, string>): string {
  return headers
    ? Object.entries(headers)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')
    : ''
}

function formFromUserMcpServer(server: UserMcpServerConfig): UserMcpServerFormState {
  return {
    name: server.name,
    description: server.description || '',
    transport: server.transport,
    command: server.command || '',
    url: server.url || '',
    argsText: formatUserMcpServerArgs(server.args),
    envText: formatUserMcpServerEnv(server.env),
    headersText: formatUserMcpServerHeaders(server.headers),
    bearerTokenEnvVar: server.bearerTokenEnvVar || '',
    enabled: server.enabled
  }
}

function parseUserMcpServerArgs(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 64)
}

function parseUserMcpServerEnv(value: string): { env: Record<string, string>; error?: string } {
  const env: Record<string, string> = {}
  for (const rawLine of value.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const separatorIndex = line.indexOf('=')
    if (separatorIndex <= 0) return { env, error: 'Environment lines must use KEY=value.' }
    const key = line.slice(0, separatorIndex).trim()
    const val = line.slice(separatorIndex + 1)
    if (!USER_MCP_ENV_NAME_RE.test(key)) {
      return { env, error: `Invalid environment variable name: ${key}` }
    }
    env[key] = val
  }
  return { env }
}

function parseUserMcpServerHeaders(value: string): {
  headers: Record<string, string>
  error?: string
} {
  const headers: Record<string, string> = {}
  for (const rawLine of value.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const separatorIndex = line.indexOf('=')
    if (separatorIndex <= 0) return { headers, error: 'Header lines must use Name=value.' }
    const key = line.slice(0, separatorIndex).trim()
    const val = line.slice(separatorIndex + 1)
    if (!USER_MCP_HEADER_NAME_RE.test(key)) {
      return { headers, error: `Invalid HTTP header name: ${key}` }
    }
    headers[key] = val
  }
  return { headers }
}

function isValidUserMcpRemoteUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function hasRunnableUserMcpEndpoint(
  server: Pick<UserMcpServerConfig, 'transport' | 'command' | 'url'>
): boolean {
  if (server.transport === 'stdio') return Boolean(server.command?.trim())
  const url = server.url?.trim()
  return Boolean(url && isValidUserMcpRemoteUrl(url))
}

function userMcpServerRuntimeLabel(server: Pick<UserMcpServerConfig, 'transport'>): string {
  const providers = USER_MCP_RUNTIME_PROVIDERS_BY_TRANSPORT[server.transport]
  return providers.length > 0 ? `runtime: ${providers.join(' + ')}` : 'saved only'
}

type UserMcpServerReadinessState = 'ready' | 'disabled' | 'blocked'

export interface UserMcpServerReadiness {
  state: UserMcpServerReadinessState
  label: string
  providers: string[]
  blockers: string[]
  notes: string[]
}

export function userMcpServerStatusLabel(
  server: Pick<UserMcpServerConfig, 'enabled' | 'transport' | 'command' | 'url'>
): string {
  if (!hasRunnableUserMcpEndpoint(server)) {
    if (server.transport === 'stdio') return 'needs command'
    return server.url?.trim() ? 'needs valid URL' : 'needs URL'
  }
  return server.enabled ? 'enabled' : 'disabled'
}

export function userMcpServerReadiness(server: UserMcpServerConfig): UserMcpServerReadiness {
  const providers = [...USER_MCP_RUNTIME_PROVIDERS_BY_TRANSPORT[server.transport]]
  const blockers: string[] = []
  const notes: string[] = []
  if (server.transport === 'stdio') {
    if (!server.command?.trim()) blockers.push('Missing command')
  } else {
    const url = server.url?.trim()
    if (!url) blockers.push('Missing URL')
    else if (!isValidUserMcpRemoteUrl(url)) blockers.push('URL must use http:// or https://')
  }
  if (server.transport === 'sse') {
    notes.push('SSE attaches to Claude only')
  } else {
    notes.push('Cursor support is limited to contained write-mode runs')
  }
  if (!server.enabled) {
    return {
      state: 'disabled',
      label: 'Disabled',
      providers: [],
      blockers: ['Enable this server before it attaches to provider launches'],
      notes
    }
  }
  if (blockers.length > 0) {
    return {
      state: 'blocked',
      label: 'Needs attention',
      providers: [],
      blockers,
      notes
    }
  }
  return {
    state: 'ready',
    label: `Ready for ${providers.join(' + ')}`,
    providers,
    blockers: [],
    notes
  }
}

export function userMcpServerMatchesQuery(
  server: UserMcpServerConfig,
  query: string
): boolean {
  const search = query.trim().toLowerCase()
  if (!search) return true
  const haystack = [
    server.name,
    server.description || '',
    server.transport,
    userMcpServerStatusLabel(server),
    userMcpServerReadiness(server).label,
    ...userMcpServerReadiness(server).blockers,
    ...userMcpServerReadiness(server).notes,
    server.command || '',
    server.url || '',
    ...(server.args ?? []),
    ...Object.keys(server.env ?? {}),
    ...Object.keys(userMcpServerRemoteHeaders(server, { redactValues: true }) ?? {}),
    server.bearerTokenEnvVar || '',
    userMcpServerRuntimeLabel(server),
    ...userMcpServerProviderExportLabels(server)
  ]
    .join(' ')
    .toLowerCase()
  return haystack.includes(search)
}

function makeUserMcpServerId(name: string): string {
  const slug =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'server'
  return `user-mcp-${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function uniqueImportedUserMcpName(name: string, usedNames: Set<string>): string {
  const base = name.trim() || 'Imported MCP server'
  let candidate = base
  let suffix = 2
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${base} ${suffix}`
    suffix += 1
  }
  usedNames.add(candidate.toLowerCase())
  return candidate
}

function normalizeUserMcpServerName(value: string): string {
  return value.trim().toLowerCase()
}

export function hasUserMcpServerNameConflict(
  servers: readonly UserMcpServerConfig[],
  candidateName: string,
  candidateId?: string
): boolean {
  const normalized = normalizeUserMcpServerName(candidateName)
  if (!normalized) return false
  return servers.some(
    (server) =>
      server.id !== candidateId && normalizeUserMcpServerName(server.name) === normalized
  )
}

function buildUserMcpServerFromForm(
  form: UserMcpServerFormState,
  existing?: UserMcpServerConfig
): { server?: UserMcpServerConfig; error?: string } {
  const name = form.name.trim()
  if (!name) return { error: 'Server name is required.' }
  const args = form.transport === 'stdio' ? parseUserMcpServerArgs(form.argsText) : []
  const parsedEnv: { env: Record<string, string>; error?: string } =
    form.transport === 'stdio' ? parseUserMcpServerEnv(form.envText) : { env: {} }
  if (parsedEnv.error) return { error: parsedEnv.error }
  const parsedHeaders: { headers: Record<string, string>; error?: string } =
    form.transport === 'stdio' ? { headers: {} } : parseUserMcpServerHeaders(form.headersText)
  if (parsedHeaders.error) return { error: parsedHeaders.error }
  const command = form.command.trim()
  const url = form.url.trim()
  const bearerTokenEnvVar = form.bearerTokenEnvVar.trim()
  if (
    form.transport !== 'stdio' &&
    bearerTokenEnvVar &&
    !USER_MCP_ENV_NAME_RE.test(bearerTokenEnvVar)
  ) {
    return { error: 'Bearer token environment variable must be a valid environment variable name.' }
  }
  if (form.transport === 'stdio' && form.enabled && !command) {
    return { error: 'A stdio server needs a command before it can be enabled.' }
  }
  if (form.transport !== 'stdio' && form.enabled && !url) {
    return { error: 'HTTP and SSE servers need a URL before they can be enabled.' }
  }
  if (form.transport !== 'stdio' && url) {
    if (!isValidUserMcpRemoteUrl(url)) {
      return { error: 'MCP server URL is not valid.' }
    }
  }
  const now = new Date().toISOString()
  const server: UserMcpServerConfig = {
    id: existing?.id || makeUserMcpServerId(name),
    name,
    enabled: form.enabled,
    transport: form.transport,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  }
  const description = form.description.trim()
  if (description) server.description = description
  if (form.transport === 'stdio') {
    if (command) server.command = command
    if (args.length > 0) server.args = args
    if (Object.keys(parsedEnv.env).length > 0) server.env = parsedEnv.env
  } else {
    if (url) server.url = url
    if (Object.keys(parsedHeaders.headers).length > 0) server.headers = parsedHeaders.headers
    if (bearerTokenEnvVar) server.bearerTokenEnvVar = bearerTokenEnvVar
  }
  return { server }
}

function normalizeImportedUserMcpEnv(value: unknown): Record<string, string> | undefined {
  if (!isPlainRecord(value)) return undefined
  const env: Record<string, string> = {}
  for (const [key, rawValue] of Object.entries(value)) {
    if (!USER_MCP_ENV_NAME_RE.test(key) || typeof rawValue !== 'string') continue
    env[key] = rawValue
  }
  return Object.keys(env).length > 0 ? env : undefined
}

function normalizeImportedUserMcpHeaders(value: unknown): Record<string, string> | undefined {
  if (!isPlainRecord(value)) return undefined
  const headers: Record<string, string> = {}
  for (const [key, rawValue] of Object.entries(value)) {
    if (!USER_MCP_HEADER_NAME_RE.test(key) || typeof rawValue !== 'string') continue
    headers[key] = rawValue
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

function normalizeImportedBearerTokenEnvVar(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed && USER_MCP_ENV_NAME_RE.test(trimmed) ? trimmed : undefined
}

function normalizeImportedUserMcpArgs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const args = value
    .map((arg) => (typeof arg === 'string' ? arg.trim() : String(arg).trim()))
    .filter(Boolean)
    .slice(0, 64)
  return args.length > 0 ? args : undefined
}

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote === '"') {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') quote = null
      continue
    }
    if (quote === "'") {
      if (char === "'") quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#') return line.slice(0, index)
  }
  return line
}

function splitTomlTopLevel(value: string, separator: ',' | '.' = ','): string[] {
  const parts: string[] = []
  let start = 0
  let quote: '"' | "'" | null = null
  let escaped = false
  let squareDepth = 0
  let braceDepth = 0
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quote === '"') {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') quote = null
      continue
    }
    if (quote === "'") {
      if (char === "'") quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '[') squareDepth += 1
    else if (char === ']') squareDepth = Math.max(0, squareDepth - 1)
    else if (char === '{') braceDepth += 1
    else if (char === '}') braceDepth = Math.max(0, braceDepth - 1)
    else if (char === separator && squareDepth === 0 && braceDepth === 0) {
      parts.push(value.slice(start, index).trim())
      start = index + 1
    }
  }
  const tail = value.slice(start).trim()
  if (tail) parts.push(tail)
  return parts
}

function findTomlTopLevelEquals(value: string): number {
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quote === '"') {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') quote = null
      continue
    }
    if (quote === "'") {
      if (char === "'") quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '=') return index
  }
  return -1
}

function parseTomlString(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return undefined
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1)
  }
  return undefined
}

function formatTomlBasicString(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`
}

function parseTomlKey(value: string): string | undefined {
  const trimmed = value.trim()
  const quoted = parseTomlString(trimmed)
  if (quoted !== undefined) return quoted
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : undefined
}

function formatTomlKeyComponent(value: string): string {
  const trimmed = value.trim()
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : formatTomlBasicString(trimmed)
}

function parseTomlDottedPath(value: string): string[] | undefined {
  const parts = splitTomlTopLevel(value, '.').map(parseTomlKey)
  return parts.every((part): part is string => typeof part === 'string') ? parts : undefined
}

function parseTomlStringArray(value: string): string[] | undefined {
  const trimmed = value.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return undefined
  const inner = trimmed.slice(1, -1).trim()
  if (!inner) return []
  const values = splitTomlTopLevel(inner).map(parseTomlString)
  return values.every((entry): entry is string => typeof entry === 'string') ? values : undefined
}

function formatTomlStringArray(values: readonly string[]): string {
  return `[${values.map(formatTomlBasicString).join(', ')}]`
}

function parseTomlStringInlineTable(value: string): Record<string, string> | undefined {
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined
  const inner = trimmed.slice(1, -1).trim()
  if (!inner) return {}
  const table: Record<string, string> = {}
  for (const pair of splitTomlTopLevel(inner)) {
    const separatorIndex = findTomlTopLevelEquals(pair)
    if (separatorIndex <= 0) return undefined
    const key = parseTomlKey(pair.slice(0, separatorIndex))
    const val = parseTomlString(pair.slice(separatorIndex + 1))
    if (key === undefined || val === undefined) return undefined
    table[key] = val
  }
  return table
}

function formatTomlStringInlineTable(
  value: Record<string, string>,
  options: { redactValues?: boolean } = {}
): string {
  const entries = Object.keys(value)
    .sort()
    .map((key) => {
      const rawValue = options.redactValues ? '[stored in TaskWraith settings]' : value[key]
      return `${formatTomlKeyComponent(key)} = ${formatTomlBasicString(rawValue ?? '')}`
    })
  return `{ ${entries.join(', ')} }`
}

function parseTomlBoolean(value: string): boolean | undefined {
  const trimmed = value.trim().toLowerCase()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  return undefined
}

function parseCodexMcpServersToml(text: string): Record<string, Record<string, unknown>> | null {
  const servers: Record<string, Record<string, unknown>> = {}
  let currentServerName: string | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim()
    if (!line) continue
    const tableMatch = line.match(/^\[(.+)]$/)
    if (tableMatch) {
      const path = parseTomlDottedPath(tableMatch[1])
      currentServerName =
        path && path.length === 2 && path[0] === 'mcp_servers' ? path[1] : null
      if (currentServerName && !servers[currentServerName]) servers[currentServerName] = {}
      continue
    }
    if (!currentServerName) continue
    const separatorIndex = findTomlTopLevelEquals(line)
    if (separatorIndex <= 0) continue
    const key = parseTomlKey(line.slice(0, separatorIndex))
    if (!key) continue
    const rawValue = line.slice(separatorIndex + 1).trim()
    const entry = servers[currentServerName]
    if (key === 'args') {
      const args = parseTomlStringArray(rawValue)
      if (args) entry.args = args
    } else if (key === 'env' || key === 'headers' || key === 'http_headers') {
      const table = parseTomlStringInlineTable(rawValue)
      if (table) entry[key] = table
    } else if (key === 'enabled' || key === 'disabled') {
      const boolValue = parseTomlBoolean(rawValue)
      if (boolValue !== undefined) entry[key] = boolValue
    } else {
      const stringValue = parseTomlString(rawValue)
      if (stringValue !== undefined) entry[key] = stringValue
    }
  }
  return Object.keys(servers).length > 0 ? servers : null
}

function normalizeImportedUserMcpTransport(entry: Record<string, unknown>): UserMcpServerTransport {
  const raw = String(entry.type || entry.transport || '').trim().toLowerCase()
  if (raw === 'sse') return 'sse'
  if (
    raw === 'http' ||
    raw === 'streamable_http' ||
    raw === 'streamable-http' ||
    raw === 'streamablehttp'
  ) {
    return 'http'
  }
  return typeof entry.url === 'string' && entry.url.trim() ? 'http' : 'stdio'
}

function buildImportedUserMcpServer(
  name: string,
  value: unknown,
  usedNames: Set<string>
): UserMcpServerConfig | null {
  if (!isPlainRecord(value)) return null
  const transport = normalizeImportedUserMcpTransport(value)
  const command = typeof value.command === 'string' ? value.command.trim() : ''
  const url = typeof value.url === 'string' ? value.url.trim() : ''
  if (transport === 'stdio' && !command) return null
  if (transport !== 'stdio' && !url) return null
  if (transport !== 'stdio' && !isValidUserMcpRemoteUrl(url)) return null
  const serverName = uniqueImportedUserMcpName(name, usedNames)
  const now = new Date().toISOString()
  const server: UserMcpServerConfig = {
    id: makeUserMcpServerId(serverName),
    name: serverName,
    enabled:
      typeof value.enabled === 'boolean'
        ? value.enabled
        : typeof value.disabled === 'boolean'
          ? !value.disabled
          : true,
    transport,
    createdAt: now,
    updatedAt: now
  }
  if (typeof value.description === 'string' && value.description.trim()) {
    server.description = value.description.trim()
  }
  if (command) server.command = command
  if (url) server.url = url
  const args = normalizeImportedUserMcpArgs(value.args)
  if (args) server.args = args
  const env = normalizeImportedUserMcpEnv(value.env)
  if (env) server.env = env
  if (transport !== 'stdio') {
    const headers =
      normalizeImportedUserMcpHeaders(value.headers) ??
      normalizeImportedUserMcpHeaders(value.http_headers)
    if (headers) server.headers = headers
    const bearerTokenEnvVar =
      normalizeImportedBearerTokenEnvVar(value.bearerTokenEnvVar) ??
      normalizeImportedBearerTokenEnvVar(value.bearer_token_env_var)
    if (bearerTokenEnvVar) server.bearerTokenEnvVar = bearerTokenEnvVar
  }
  return server
}

export function parseUserMcpServersImportJson(
  text: string,
  existingServers: readonly UserMcpServerConfig[] = []
): { servers: UserMcpServerConfig[]; skipped: number; error?: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    const tomlServers = parseCodexMcpServersToml(text)
    if (tomlServers) {
      parsed = { mcpServers: tomlServers }
    } else {
      return {
        servers: [],
        skipped: 0,
        error: 'Paste valid JSON or Codex MCP TOML before importing.'
      }
    }
  }
  if (!isPlainRecord(parsed)) {
    return { servers: [], skipped: 0, error: 'MCP import config must be an object.' }
  }
  const rawServers = isPlainRecord(parsed.mcpServers) ? parsed.mcpServers : parsed
  const usedNames = new Set(existingServers.map((server) => server.name.trim().toLowerCase()))
  const servers: UserMcpServerConfig[] = []
  let skipped = 0
  for (const [name, value] of Object.entries(rawServers)) {
    const server = buildImportedUserMcpServer(name, value, usedNames)
    if (server) servers.push(server)
    else skipped += 1
  }
  if (servers.length === 0) {
    return {
      servers,
      skipped,
      error: 'No supported MCP servers found. Import entries need either command or url.'
    }
  }
  return { servers, skipped }
}

function userMcpServerAuditKey(server: UserMcpServerConfig): string {
  return server.name.trim() || server.id
}

function uniqueUserMcpServerAuditKey(
  server: UserMcpServerConfig,
  usedKeys: Set<string>
): string {
  const base = userMcpServerAuditKey(server)
  let candidate = base
  let suffix = 2
  while (usedKeys.has(candidate.toLowerCase())) {
    candidate = `${base} ${suffix}`
    suffix += 1
  }
  usedKeys.add(candidate.toLowerCase())
  return candidate
}

function slugForUserMcpProviderName(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'server'
  )
}

function userMcpServerProviderKey(
  server: Pick<UserMcpServerConfig, 'id' | 'name'>,
  usedKeys: Set<string>
): string {
  const base = `user_${slugForUserMcpProviderName(server.name || server.id)}`
  let candidate = base
  let suffix = 2
  while (usedKeys.has(candidate) || candidate === 'TaskWraith') {
    candidate = `${base}_${suffix}`
    suffix += 1
  }
  usedKeys.add(candidate)
  return candidate
}

function userMcpServerAuditEntry(server: UserMcpServerConfig): Record<string, unknown> {
  const env =
    server.env && Object.keys(server.env).length > 0
      ? Object.fromEntries(
          Object.keys(server.env)
            .sort()
            .map((key) => [key, '[stored in TaskWraith settings]'])
        )
      : undefined
  const headers =
    server.headers && Object.keys(server.headers).length > 0
      ? Object.fromEntries(
          Object.keys(server.headers)
            .sort()
            .map((key) => [key, '[stored in TaskWraith settings]'])
        )
      : undefined
  const entry =
    server.transport === 'stdio'
      ? {
          type: 'stdio',
          command: server.command || '',
          ...(server.args && server.args.length > 0 ? { args: server.args } : {}),
          ...(env ? { env } : {})
        }
      : {
          type: server.transport,
          url: server.url || '',
          ...(headers ? { headers } : {}),
          ...(server.bearerTokenEnvVar ? { bearer_token_env_var: server.bearerTokenEnvVar } : {}),
          ...(env ? { env } : {})
        }
  return entry
}

function formatUserMcpServerAuditJson(server: UserMcpServerConfig): string {
  return JSON.stringify(
    {
      mcpServers: {
        [userMcpServerAuditKey(server)]: userMcpServerAuditEntry(server)
      },
      taskwraith: {
        id: server.id,
        enabled: server.enabled,
        ...(server.pluginProvenance ? { pluginProvenance: server.pluginProvenance } : {})
      }
    },
    null,
    2
  )
}

export function formatUserMcpServersAuditJson(servers: readonly UserMcpServerConfig[]): string {
  const usedKeys = new Set<string>()
  return JSON.stringify(
    {
      mcpServers: Object.fromEntries(
        servers.map((server) => [
          uniqueUserMcpServerAuditKey(server, usedKeys),
          userMcpServerAuditEntry(server)
        ])
      ),
      taskwraith: {
        servers: servers.map((server) => ({
          id: server.id,
          name: server.name,
          enabled: server.enabled,
          ...(server.pluginProvenance ? { pluginProvenance: server.pluginProvenance } : {})
        }))
      }
    },
    null,
    2
  )
}

function isCodexExportableUserMcpServer(server: UserMcpServerConfig): boolean {
  return server.enabled && server.transport !== 'sse' && hasRunnableUserMcpEndpoint(server)
}

function isClaudeExportableUserMcpServer(server: UserMcpServerConfig): boolean {
  return server.enabled && hasRunnableUserMcpEndpoint(server)
}

function isCursorExportableUserMcpServer(server: UserMcpServerConfig): boolean {
  return server.enabled && server.transport !== 'sse' && hasRunnableUserMcpEndpoint(server)
}

export function userMcpServerProviderExportLabels(server: UserMcpServerConfig): string[] {
  const labels: string[] = []
  if (isCodexExportableUserMcpServer(server)) labels.push('Codex TOML')
  if (isClaudeExportableUserMcpServer(server)) labels.push('Claude JSON')
  if (isCursorExportableUserMcpServer(server)) labels.push('Cursor mcp.json')
  return labels
}

function hasUserMcpAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === 'authorization')
}

function userMcpServerRemoteHeaders(
  server: UserMcpServerConfig,
  options: { redactValues?: boolean } = {}
): Record<string, string> | undefined {
  const headers: Record<string, string> =
    server.headers && Object.keys(server.headers).length > 0
      ? Object.fromEntries(
          Object.keys(server.headers)
            .sort()
            .map((key) => [
              key,
              options.redactValues ? '[stored in TaskWraith settings]' : server.headers?.[key] || ''
            ])
        )
      : {}
  const bearerTokenEnvVar = server.bearerTokenEnvVar?.trim()
  if (bearerTokenEnvVar && !hasUserMcpAuthorizationHeader(server.headers)) {
    headers.Authorization = options.redactValues
      ? '[stored in TaskWraith settings]'
      : `Bearer \${${bearerTokenEnvVar}}`
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

function userMcpServerProviderEntry(
  server: UserMcpServerConfig,
  options: { redactValues?: boolean } = {}
): Record<string, unknown> {
  if (server.transport === 'stdio') {
    const env =
      server.env && Object.keys(server.env).length > 0
        ? Object.fromEntries(
            Object.keys(server.env)
              .sort()
              .map((key) => [
                key,
                options.redactValues ? '[stored in TaskWraith settings]' : server.env?.[key] || ''
              ])
          )
        : undefined
    return {
      type: 'stdio',
      command: server.command?.trim() || '',
      ...(server.args && server.args.length > 0 ? { args: server.args } : {}),
      ...(env ? { env } : {})
    }
  }
  const headers = userMcpServerRemoteHeaders(server, options)
  return {
    type: server.transport,
    url: server.url?.trim() || '',
    ...(headers ? { headers } : {})
  }
}

function findUserMcpServerProviderKey(
  servers: readonly UserMcpServerConfig[],
  targetServer: UserMcpServerConfig,
  isExportable: (server: UserMcpServerConfig) => boolean
): string | null {
  const usedKeys = new Set<string>()
  for (const server of servers) {
    if (!isExportable(server)) continue
    const key = userMcpServerProviderKey(server, usedKeys)
    if (server.id === targetServer.id) return key
  }
  return null
}

export function formatUserMcpServersClaudeJson(
  servers: readonly UserMcpServerConfig[],
  options: { redactValues?: boolean } = {}
): string {
  const usedKeys = new Set<string>()
  const mcpServers = Object.fromEntries(
    servers
      .filter(isClaudeExportableUserMcpServer)
      .map((server) => [
        userMcpServerProviderKey(server, usedKeys),
        userMcpServerProviderEntry(server, options)
      ])
  )
  return JSON.stringify({ mcpServers }, null, 2)
}

export function formatUserMcpServerClaudeJsonSnippet(
  servers: readonly UserMcpServerConfig[],
  server: UserMcpServerConfig,
  options: { redactValues?: boolean } = {}
): string {
  const providerKey = findUserMcpServerProviderKey(
    servers,
    server,
    isClaudeExportableUserMcpServer
  )
  if (!providerKey) return ''
  return JSON.stringify(
    { mcpServers: { [providerKey]: userMcpServerProviderEntry(server, options) } },
    null,
    2
  )
}

function userMcpServerCursorEntry(
  server: UserMcpServerConfig,
  options: { redactValues?: boolean } = {}
): Record<string, unknown> {
  if (server.transport === 'stdio') {
    const env =
      server.env && Object.keys(server.env).length > 0
        ? Object.fromEntries(
            Object.keys(server.env)
              .sort()
              .map((key) => [
                key,
                options.redactValues ? '[stored in TaskWraith settings]' : server.env?.[key] || ''
              ])
          )
        : undefined
    return {
      command: server.command?.trim() || '',
      args: [...(server.args ?? [])],
      ...(env ? { env } : {})
    }
  }
  const headers = userMcpServerRemoteHeaders(server, options)
  return {
    url: server.url?.trim() || '',
    ...(headers ? { headers } : {})
  }
}

export function formatUserMcpServersCursorJson(
  servers: readonly UserMcpServerConfig[],
  options: { redactValues?: boolean } = {}
): string {
  const usedKeys = new Set<string>()
  const mcpServers = Object.fromEntries(
    servers
      .filter(isCursorExportableUserMcpServer)
      .map((server) => [
        userMcpServerProviderKey(server, usedKeys),
        userMcpServerCursorEntry(server, options)
      ])
  )
  return JSON.stringify({ mcpServers }, null, 2)
}

export function formatUserMcpServerCursorJsonSnippet(
  servers: readonly UserMcpServerConfig[],
  server: UserMcpServerConfig,
  options: { redactValues?: boolean } = {}
): string {
  const providerKey = findUserMcpServerProviderKey(
    servers,
    server,
    isCursorExportableUserMcpServer
  )
  if (!providerKey) return ''
  return JSON.stringify(
    { mcpServers: { [providerKey]: userMcpServerCursorEntry(server, options) } },
    null,
    2
  )
}

function formatUserMcpServerCodexTomlEntry(
  server: UserMcpServerConfig,
  providerKey: string,
  options: { redactValues?: boolean } = {}
): string {
  const tableKey = formatTomlKeyComponent(providerKey)
  const lines = [`[mcp_servers.${tableKey}]`]
  if (server.transport === 'stdio') {
    lines.push(`command = ${formatTomlBasicString(server.command?.trim() || '')}`)
    if (server.args && server.args.length > 0) {
      lines.push(`args = ${formatTomlStringArray(server.args)}`)
    }
    if (server.env && Object.keys(server.env).length > 0) {
      lines.push(`env = ${formatTomlStringInlineTable(server.env, options)}`)
    }
  } else {
    lines.push(`url = ${formatTomlBasicString(server.url?.trim() || '')}`)
    if (server.bearerTokenEnvVar) {
      lines.push(`bearer_token_env_var = ${formatTomlBasicString(server.bearerTokenEnvVar)}`)
    }
    if (server.headers && Object.keys(server.headers).length > 0) {
      lines.push(`http_headers = ${formatTomlStringInlineTable(server.headers, options)}`)
    }
  }
  return lines.join('\n')
}

export function formatUserMcpServersCodexToml(
  servers: readonly UserMcpServerConfig[],
  options: { redactValues?: boolean } = {}
): string {
  const usedKeys = new Set<string>()
  const entries: string[] = []
  for (const server of servers) {
    if (!isCodexExportableUserMcpServer(server)) continue
    entries.push(
      formatUserMcpServerCodexTomlEntry(
        server,
        userMcpServerProviderKey(server, usedKeys),
        options
      )
    )
  }
  return entries.length > 0
    ? entries.join('\n\n')
    : '# No enabled Codex-compatible MCP servers.'
}

export function formatUserMcpServerCodexTomlSnippet(
  servers: readonly UserMcpServerConfig[],
  server: UserMcpServerConfig,
  options: { redactValues?: boolean } = {}
): string {
  const providerKey = findUserMcpServerProviderKey(
    servers,
    server,
    isCodexExportableUserMcpServer
  )
  return providerKey ? formatUserMcpServerCodexTomlEntry(server, providerKey, options) : ''
}

const AUDIT_ARTIFACT_PROVIDER_OPTIONS: Array<{
  value: ProviderId
  label: string
  helper: string
}> = [
  {
    value: 'claude',
    label: 'Claude',
    helper: 'Artifact-backed role runs when Claude is configured.'
  },
  {
    value: 'kimi',
    label: 'Kimi',
    helper: 'Artifact-backed role runs when a Kimi API key is configured.'
  }
]

type McpToolGroup =
  | 'workspace'
  | 'files'
  | 'git'
  | 'runtime'
  | 'subthreads'
  | 'web'
  | 'browser'
  | 'appwatch'
  | 'creative'
  | 'ide'
  | 'auth'
  | 'ensemble'
  | 'diagnostics'

type McpToolPolicyKey = keyof AgenticServicesSettings

const MCP_TOOL_GROUP_LABELS: Record<McpToolGroup, string> = {
  workspace: 'Workspace intelligence',
  files: 'Files and diffs',
  git: 'Git',
  runtime: 'Runtime and tasks',
  subthreads: 'Sub-threads',
  web: 'Web',
  browser: 'Browser and screenshots',
  appwatch: 'Appwatch',
  creative: 'Creative apps',
  ide: 'IDE handoff',
  auth: 'Auth and approvals',
  ensemble: 'Ensemble',
  diagnostics: 'Diagnostics'
}

const MCP_TOOL_GROUP_ORDER: McpToolGroup[] = [
  'workspace',
  'files',
  'git',
  'runtime',
  'subthreads',
  'web',
  'browser',
  'appwatch',
  'creative',
  'ide',
  'auth',
  'ensemble',
  'diagnostics'
]

const MCP_TOOL_OVERRIDES: Partial<
  Record<
    TaskWraithMcpToolName,
    {
      label: string
      transcript: string
      group: McpToolGroup
      iconRef: string
      policyKey: McpToolPolicyKey
      description: string
    }
  >
> = {
  run_shell_command: {
    label: 'Run shell command',
    transcript: 'Ran shell command',
    group: 'runtime',
    iconRef: 'tool:terminal',
    policyKey: 'shellCommands',
    description: 'Executes workspace-scoped shell commands with approval and audit capture.'
  },
  write_file: {
    label: 'Write file',
    transcript: 'Wrote file',
    group: 'files',
    iconRef: 'tool:file-write',
    policyKey: 'fileChanges',
    description: 'Writes a workspace file and records the resulting change summary.'
  },
  replace: {
    label: 'Replace text',
    transcript: 'Edited file',
    group: 'files',
    iconRef: 'tool:replace',
    policyKey: 'fileChanges',
    description: 'Applies a targeted replacement inside a workspace file.'
  },
  read_file: {
    label: 'Read file',
    transcript: 'Read file',
    group: 'files',
    iconRef: 'tool:file-read',
    policyKey: 'mcpTools',
    description: 'Reads a workspace file for provider context.'
  },
  list_directory: {
    label: 'List directory',
    transcript: 'Listed directory',
    group: 'workspace',
    iconRef: 'tool:folder',
    policyKey: 'mcpTools',
    description: 'Lists workspace folders without leaving the project boundary.'
  },
  workspace_search: {
    label: 'Workspace search',
    transcript: 'Searched workspace',
    group: 'workspace',
    iconRef: 'tool:search',
    policyKey: 'mcpTools',
    description: 'Searches project text and file names for provider grounding.'
  },
  web_search: {
    label: 'Web search',
    transcript: 'Searched web',
    group: 'web',
    iconRef: 'tool:search',
    policyKey: 'mcpTools',
    description: 'Searches the web for current information through TaskWraith policy.'
  },
  web_fetch: {
    label: 'Web fetch',
    transcript: 'Fetched web page',
    group: 'web',
    iconRef: 'tool:browser',
    policyKey: 'mcpTools',
    description: 'Fetches a live web page as read-only text through TaskWraith policy.'
  },
  apply_patch: {
    label: 'Apply patch',
    transcript: 'Applied patch',
    group: 'files',
    iconRef: 'tool:patch',
    policyKey: 'fileChanges',
    description: 'Applies a structured patch with file-change audit output.'
  },
  delegate_to_subthread: {
    label: 'Delegate to sub-thread',
    transcript: 'Delegated sub-thread',
    group: 'subthreads',
    iconRef: 'tool:delegate',
    policyKey: 'subThreadDelegation',
    description: 'Starts or continues a linked provider sub-thread after policy checks.'
  },
  ensemble_yield: {
    label: 'Yield ensemble turn',
    transcript: 'Yielded ensemble turn',
    group: 'ensemble',
    iconRef: 'tool:yield',
    policyKey: 'mcpTools',
    description: 'Lets an Ensemble participant pass control to the next speaker.'
  },
  appwatch_latest_frame: {
    label: 'Latest Appwatch frame',
    transcript: 'Captured latest frame',
    group: 'appwatch',
    iconRef: 'tool:image',
    policyKey: 'mcpTools',
    description: 'Returns metadata plus the newest attached-window image frame.'
  },
  appwatch_frames: {
    label: 'Appwatch frame batch',
    transcript: 'Captured frame batch',
    group: 'appwatch',
    iconRef: 'tool:frames',
    policyKey: 'mcpTools',
    description: 'Returns a bounded batch of recent attached-window frames.'
  }
}

function titleFromSnake(value: string): string {
  return value
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/** "1 tool" / "2 tools" — naive count + singular/plural noun. */
function pluralizeCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function inferMcpToolGroup(tool: TaskWraithMcpToolName): McpToolGroup {
  if (tool.startsWith('git_')) return 'git'
  if (
    tool.includes('file') ||
    tool === 'replace' ||
    tool === 'apply_patch' ||
    tool === 'open_workspace_file'
  ) {
    return 'files'
  }
  if (tool.startsWith('workspace_') || tool === 'list_directory') return 'workspace'
  if (tool.startsWith('web_')) return 'web'
  if (tool.includes('subthread') || tool === 'delegate_to_subthread') return 'subthreads'
  if (tool.startsWith('browser_') || tool.startsWith('attached_window_')) return 'browser'
  if (tool.startsWith('appwatch_')) return 'appwatch'
  if (tool.startsWith('creative_')) return 'creative'
  if (tool.includes('ide') || tool === 'reveal_in_finder' || tool === 'create_handoff_card') {
    return 'ide'
  }
  if (tool.includes('auth') || tool.startsWith('approval_') || tool === 'agent_delegation_role') {
    return 'auth'
  }
  if (tool.startsWith('run_') || tool.includes('timeline') || tool.includes('events')) {
    return 'runtime'
  }
  if (tool.includes('summary') || tool.includes('status') || tool.includes('capabilities')) {
    return 'diagnostics'
  }
  return 'workspace'
}

function inferMcpPolicyKey(tool: TaskWraithMcpToolName): McpToolPolicyKey {
  if (tool === 'run_shell_command' || tool === 'run_task') return 'shellCommands'
  // Audio/video media tools share the dedicated mediaEditing policy bucket
  // (parity with the runtime classifier). Checked before the creative_/fileChanges
  // branches so the per-tool Settings policy chip reflects the real gate.
  if (MEDIA_EDITING_TOOLS.has(tool)) return 'mediaEditing'
  if (tool.startsWith('creative_')) return 'mcpTools'
  if (
    tool === 'write_file' ||
    tool === 'replace' ||
    tool === 'apply_patch' ||
    tool.includes('import') ||
    tool.includes('dispatch')
  ) {
    return 'fileChanges'
  }
  if (tool.includes('subthread') || tool === 'delegate_to_subthread') return 'subThreadDelegation'
  if (tool === 'canvas_click' || tool === 'canvas_fill') return 'canvasInteraction'
  return 'mcpTools'
}

function getMcpToolMeta(tool: TaskWraithMcpToolName): {
  label: string
  transcript: string
  group: McpToolGroup
  iconRef: string
  policyKey: McpToolPolicyKey
  description: string
} {
  const override = MCP_TOOL_OVERRIDES[tool]
  if (override) return override
  const group = inferMcpToolGroup(tool)
  return {
    label: titleFromSnake(tool),
    transcript: titleFromSnake(tool.replace(/^creative_/, '').replace(/^appwatch_/, 'Appwatch ')),
    group,
    iconRef: `tool:${group}`,
    policyKey: inferMcpPolicyKey(tool),
    description: `${MCP_TOOL_GROUP_LABELS[group]} tool exposed through the TaskWraith MCP bridge.`
  }
}

const MCP_ICON_REF_FAMILIES: Record<string, ToolFamily> = {
  'tool:auth': 'diagnostic',
  'tool:browser': 'browser',
  'tool:creative': 'diagnostic',
  'tool:delegate': 'delegate',
  'tool:diagnostics': 'diagnostic',
  'tool:ensemble': 'yield',
  'tool:file-read': 'file',
  'tool:file-write': 'edit',
  'tool:files': 'edit',
  'tool:folder': 'file',
  'tool:frames': 'window-context',
  'tool:git': 'git',
  'tool:ide': 'handoff',
  'tool:image': 'window-context',
  'tool:patch': 'edit',
  'tool:replace': 'edit',
  'tool:runtime': 'task',
  'tool:search': 'search',
  'tool:subthreads': 'subthread',
  'tool:terminal': 'shell',
  'tool:web': 'browser',
  'tool:workspace': 'task',
  'tool:yield': 'yield'
}

function resolveMcpToolIconFamily(tool: {
  name: TaskWraithMcpToolName
  iconRef: string
}): ToolFamily {
  return toolNameToFamily(tool.name) ?? MCP_ICON_REF_FAMILIES[tool.iconRef] ?? 'mcp'
}

function formatMcpInvocation(provider: ProviderId, tool: TaskWraithMcpToolName): string {
  if (provider === 'claude') return `mcp__TaskWraith__${tool}`
  return `TaskWraith__${tool}`
}

function getMcpPolicyLabel(
  agenticServices: AgenticServicesSettings,
  policyKey: McpToolPolicyKey
): string {
  const value = agenticServices[policyKey] ?? ''
  if (policyKey === 'networkAccess') {
    return NETWORK_POLICY_OPTIONS.find((option) => option.value === value)?.label ?? value
  }
  return AGENTIC_SERVICE_POLICY_OPTIONS.find((option) => option.value === value)?.label ?? value
}

function countMcpStatusTools(status: any): number {
  if (!status) return 0
  if (Array.isArray(status.tools)) return status.tools.length
  if (status.tools && typeof status.tools === 'object') return Object.keys(status.tools).length
  if (Array.isArray(status.data)) {
    return status.data.reduce((total: number, server: any) => {
      if (Array.isArray(server?.tools)) return total + server.tools.length
      if (server?.tools && typeof server.tools === 'object')
        return total + Object.keys(server.tools).length
      return total
    }, 0)
  }
  return 0
}

function countMcpStatusServers(status: any): number {
  return Array.isArray(status?.data) ? status.data.length : 0
}

const MCP_TOOL_CATALOG = TASKWRAITH_MCP_TOOLS.map((name) => ({
  name,
  ...getMcpToolMeta(name)
})).sort((a, b) => {
  const groupDelta = MCP_TOOL_GROUP_ORDER.indexOf(a.group) - MCP_TOOL_GROUP_ORDER.indexOf(b.group)
  return groupDelta === 0 ? a.label.localeCompare(b.label) : groupDelta
})

export type SettingsTab =
  | 'appearance'
  | 'behavior'
  | 'providers'
  | 'roster'
  | 'mcp'
  | 'mcp-servers'
  | 'plugins'
  | 'key-commands'
  | 'approval-ledger'
  | 'safety-privacy'
  | 'messages'
  | 'pairing'
  | 'shares'
  | 'workspaces'
  | 'pinned-messages'
  | 'model-usage'
  | 'local-servers'

/**
 * Tab grouping discriminator. The settings sidebar renders user-facing
 * group labels so the takeover scales beyond a flat list while the
 * underlying tab ids remain stable for persisted state.
 */
export type SettingsTabGroup =
  | 'app'
  | 'ai-providers'
  | 'automation'
  | 'workspaces'
  | 'integrations'
  | 'data'

export const SETTINGS_TAB_GROUP_LABELS: Record<SettingsTabGroup, string> = {
  app: 'App',
  'ai-providers': 'AI & Providers',
  automation: 'Automation',
  workspaces: 'Workspaces',
  integrations: 'Integrations',
  data: 'Data'
}

export type SettingsScope = 'global' | 'provider' | 'workspace' | 'device'

export interface SettingsTabDefinition {
  id: SettingsTab
  label: string
  group: SettingsTabGroup
  description: string
  aliases: string[]
  scope: SettingsScope
}

/**
 * Canonical settings-tab list. Exported so `SettingsSidebar` (used in
 * full-app takeover layout) can render the same list of tabs as the
 * inline tab bar inside this panel — keeping both render sites in
 * lockstep when tabs are added / renamed.
 *
 * Order matters: the sidebar renders tabs in this order and inserts
 * a divider whenever the `group` field changes from the previous
 * tab. The TestFlight-gated Devices tab remains last in the canonical
 * list, but `getVisibleSettingsTabs` hides it while the iOS remote
 * feature flag is off.
 */
export const SETTINGS_TABS: SettingsTabDefinition[] = [
  {
    id: 'behavior',
    label: 'General',
    group: 'app',
    description: 'Core app behavior, dashboard defaults, updates, approval timeouts, and desktop operations.',
    aliases: ['behavior', 'system', 'updates', 'timeouts', 'currency', 'dashboard', 'desktop'],
    scope: 'global'
  },
  {
    id: 'appearance',
    label: 'Appearance',
    group: 'app',
    description: 'Themes, composer shells, fonts, density, motion, transparency, and visual effects.',
    aliases: ['theme', 'font', 'motion', 'transparency', 'density', 'accessibility', 'composer'],
    scope: 'global'
  },
  {
    id: 'key-commands',
    label: 'Keyboard shortcuts',
    group: 'app',
    description: 'Editable app keybindings and command shortcuts.',
    aliases: ['key commands', 'hotkeys', 'keybindings', 'commands', 'record shortcut'],
    scope: 'global'
  },
  {
    id: 'providers',
    label: 'Providers',
    group: 'ai-providers',
    description: 'Provider sign-in, runtime health, CLI/API setup, and agentic service policies.',
    aliases: ['models', 'auth', 'login', 'codex', 'claude', 'kimi', 'cursor', 'grok', 'ollama', 'gemini'],
    scope: 'provider'
  },
  {
    id: 'roster',
    label: 'Ensemble roster',
    group: 'ai-providers',
    description: 'Saved Ensemble participant presets, roles, provider chains, and orchestration defaults.',
    aliases: ['roster', 'ensemble', 'participants', 'roles', 'multi-provider', 'panel'],
    scope: 'provider'
  },
  {
    id: 'approval-ledger',
    label: 'Approvals & Grants',
    group: 'automation',
    description: 'Approval history, durable audit entries, and saved workspace grants.',
    aliases: ['approvals', 'audit', 'ledger', 'grants', 'permissions', 'risk', 'safety'],
    scope: 'workspace'
  },
  {
    id: 'workspaces',
    label: 'Workspaces',
    group: 'workspaces',
    description: 'Registered workspaces, launch targets, pinning, removal, and paired-device access shortcuts.',
    aliases: ['projects', 'folders', 'environments', 'remote access', 'workspace list'],
    scope: 'workspace'
  },
  {
    id: 'mcp',
    label: 'Provider Tools',
    group: 'integrations',
    description: 'TaskWraith MCP bridge status, built-in tool catalog, provider surfaces, and policy audit.',
    aliases: [
      'provider tools',
      'taskwraith tools',
      'tools',
      'tools mcp',
      'tools and mcps',
      'tool audit',
      'bridge',
      'mcp bridge'
    ],
    scope: 'provider'
  },
  {
    id: 'mcp-servers',
    label: 'MCP Servers',
    group: 'integrations',
    description: 'User-managed MCP server definitions, enablement, transport, commands, URLs, and env vars.',
    aliases: [
      'mcp',
      'servers',
      'mcp servers',
      'custom mcp',
      'external tools',
      'connectors',
      'codex mcp',
      'codex toml',
      'claude mcp',
      'claude json',
      'cursor mcp',
      'cursor json',
      'cursor mcp.json',
      'cursor mcp json',
      'mcp json',
      'mcp.json',
      'model context protocol',
      'claude desktop',
      'claude desktop config',
      'claude_desktop_config.json',
      'cursor config',
      'codex config',
      'codex config toml',
      'connect mcp',
      'manage mcp',
      'stdio mcp',
      'http mcp',
      'streamable http',
      'sse server',
      'user mcp',
      'user-managed mcp',
      'toml',
      'import mcp',
      'import json'
    ],
    scope: 'global'
  },
  {
    id: 'plugins',
    label: 'Plugins',
    group: 'integrations',
    description: 'Declarative capability bundles, installed state, marketplace metadata, and preflight status.',
    aliases: [
      'plugins',
      'extensions',
      'skills',
      'connectors',
      'marketplace',
      'installed',
      'bundles',
      'capability bundles'
    ],
    scope: 'global'
  },
  {
    id: 'local-servers',
    label: 'Local servers',
    group: 'integrations',
    description: 'Dev servers and watchers running under workspaces, with stop and lifecycle controls.',
    aliases: ['localhost', 'ports', 'preview', 'vite', 'next', 'watchers', 'browser'],
    scope: 'workspace'
  },
  {
    id: 'pairing',
    label: 'Devices',
    group: 'integrations',
    description: 'iPhone and iPad pairing, remote workspace access, Tailscale, bridge networking, and push wake.',
    aliases: ['ios', 'iphone', 'ipad', 'remote', 'pairing', 'tailscale', 'apns', 'mobile', 'bridge'],
    scope: 'device'
  },
  {
    id: 'shares',
    label: 'Shares',
    group: 'integrations',
    description: 'Chats shared with human collaborators — participants, access mode, and per-share revoke.',
    aliases: ['share', 'shares', 'shared chats', 'collaborators', 'people', 'collaboration', 'guests', 'invite'],
    scope: 'global'
  },
  {
    id: 'messages',
    label: 'Channels',
    group: 'integrations',
    description: 'Local and self-hosted message channel gateway controls.',
    aliases: ['imessage', 'sms', 'gateway', 'channel', 'messages bridge'],
    scope: 'device'
  },
  {
    id: 'safety-privacy',
    label: 'Safety & Privacy',
    group: 'data',
    description: 'Risk posture, local history, provider data flow, mobile visibility, and grant status.',
    aliases: [
      'privacy',
      'safety',
      'security',
      'risk',
      'data',
      'history',
      'grants',
      'permissions',
      'mobile visibility',
      'screen watch',
      'canvas'
    ],
    scope: 'global'
  },
  {
    id: 'pinned-messages',
    label: 'Pinned messages',
    group: 'data',
    description: 'Pinned transcript snippets and saved context across chats.',
    aliases: ['pins', 'messages', 'saved context', 'notes'],
    scope: 'global'
  },
  {
    id: 'model-usage',
    label: 'Model usage',
    group: 'data',
    description: 'Cross-provider quota, token, usage, cost, and context snapshots.',
    aliases: [
      'usage',
      'quota',
      'tokens',
      'cost',
      'credits',
      'billing',
      'context',
      'rates',
      'pricing',
      'api cost'
    ],
    scope: 'provider'
  }
]

const FEATURE_GATED_SETTINGS_TABS = new Set<SettingsTab>([
  ...(IOS_REMOTE_ENABLED ? [] : (['pairing'] as SettingsTab[])),
  ...(CHANNELS_GATEWAY_ENABLED ? [] : (['messages'] as SettingsTab[]))
])

export function isSettingsTabVisible(tab: SettingsTab): boolean {
  return !FEATURE_GATED_SETTINGS_TABS.has(tab)
}

export function getVisibleSettingsTabs(): SettingsTabDefinition[] {
  return SETTINGS_TABS.filter((tab) => isSettingsTabVisible(tab.id))
}

export function resolveVisibleSettingsTab(tab: SettingsTab): SettingsTab {
  return isSettingsTabVisible(tab) ? tab : 'behavior'
}

export function settingsTabMatchesQuery(tab: SettingsTabDefinition, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  const haystack = [
    tab.label,
    tab.id,
    tab.description,
    tab.scope,
    SETTINGS_TAB_GROUP_LABELS[tab.group],
    ...tab.aliases
  ]
    .join(' ')
    .toLowerCase()
  return haystack.includes(normalized)
}

export function pluginMcpPresetServerId(pluginId: string, presetId: string): string {
  return `plugin:${pluginId}:mcp:${presetId}`
}

export function pluginSettingsEntryMatchesQuery(
  entry: TaskWraithPluginCatalogEntry,
  query: string
): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  const haystack = [
    entry.manifest.id,
    entry.manifest.publisher,
    entry.manifest.name,
    entry.manifest.description,
    entry.manifest.marketplace?.category || '',
    ...(entry.manifest.marketplace?.tags || []),
    entry.source,
    entry.namespace,
    entry.trust.status,
    entry.trust.reason,
    entry.preflight.status,
    entry.installed ? 'installed' : 'available',
    entry.enabled ? 'enabled' : 'disabled',
    ...(entry.update?.status === 'available' ? ['update available'] : []),
    ...entry.manifest.capabilities.flatMap((capability) => [
      capability.kind,
      capability.id,
      capability.label,
      capability.description || ''
    ])
  ]
    .join(' ')
    .toLowerCase()
  return haystack.includes(normalized)
}

export function pluginSettingsProvenancePayload(entry: TaskWraithPluginCatalogEntry): {
  pluginId: string
  publisher: string
  version: string
  source: string
  namespace: string
  manifestHash: string
  trust: TaskWraithPluginCatalogEntry['trust']
  installed: boolean
  enabled: boolean
  preflight: TaskWraithPluginCatalogEntry['preflight']
  capabilities: Array<{
    id: string
    kind: string
    agenticServices: string[]
    fileScopes: string[]
    networkScopes: string[]
    remoteCapabilities: string[]
  }>
} {
  return {
    pluginId: entry.manifest.id,
    publisher: entry.manifest.publisher,
    version: entry.manifest.version,
    source: entry.source,
    namespace: entry.namespace,
    manifestHash: entry.manifestHash,
    trust: entry.trust,
    installed: entry.installed,
    enabled: entry.enabled,
    preflight: entry.preflight,
    capabilities: entry.manifest.capabilities.map((capability) => ({
      id: capability.id,
      kind: capability.kind,
      agenticServices: capability.agenticServices || [],
      fileScopes: capability.fileScopes || [],
      networkScopes: capability.networkScopes || [],
      remoteCapabilities: capability.remoteCapabilities || []
    }))
  }
}

export interface PluginSettingsMcpPresetActionState {
  serverId: string
  busy: boolean
  materialized: boolean
  disabled: boolean
}

export interface PluginSettingsActionState {
  busy: boolean
  updateAvailable: boolean
  installDisabled: boolean
  enableDisabled: boolean
  updateDisabled: boolean
  uninstallDisabled: boolean
  mcpPresets: Record<string, PluginSettingsMcpPresetActionState>
}

export function pluginSettingsActionState(
  entry: TaskWraithPluginCatalogEntry,
  userMcpServers: Pick<UserMcpServerConfig, 'id'>[],
  pluginBusyId: string | null
): PluginSettingsActionState {
  const pluginId = entry.manifest.id
  const busy = pluginBusyId === pluginId
  const updateAvailable = entry.update?.status === 'available'
  const blocked = entry.preflight.status === 'blocked'
  const trusted = entry.trust.status === 'trusted'
  const userMcpServerIds = new Set(userMcpServers.map((server) => server.id))
  const mcpPresets = Object.fromEntries(
    (entry.manifest.mcpServers || []).map((preset) => {
      const serverId = pluginMcpPresetServerId(pluginId, preset.id)
      const presetBusy = pluginBusyId === `mcp:${pluginId}:${preset.id}`
      const materialized = userMcpServerIds.has(serverId)
      return [
        preset.id,
        {
          serverId,
          busy: presetBusy,
          materialized,
          disabled:
            presetBusy || materialized || !entry.installed || updateAvailable || blocked || !trusted
        }
      ]
    })
  )

  return {
    busy,
    updateAvailable,
    installDisabled: busy || blocked,
    enableDisabled: busy || blocked || updateAvailable || !trusted,
    updateDisabled: busy,
    uninstallDisabled: busy,
    mcpPresets
  }
}

type LocalFontData = {
  family?: string
  fullName?: string
  postscriptName?: string
}

type LocalFontWindow = Window & {
  queryLocalFonts?: () => Promise<LocalFontData[]>
}

function SettingsProviderAuthCard({
  provider,
  label,
  summary,
  description,
  optional,
  children
}: {
  provider: ProviderId
  label: string
  summary: ProviderAuthSummary
  description: string
  optional?: boolean
  children?: React.ReactNode
}): React.JSX.Element {
  // The status dot has CSS for signed-in / partial / not-available only.
  // "out-of-usage" (signed in but rate-limited) reads as a warning, so
  // borrow the amber `partial` dot styling rather than fall back to the
  // neutral base dot. Cursor/Grok are CLI-owned auth surfaces: when the
  // adapter is available, the card should read as ready/connected even
  // though TaskWraith cannot inspect the provider's private login state.
  const dotVariant =
    summary.variant === 'out-of-usage'
      ? 'partial'
      : (provider === 'cursor' || provider === 'grok') && summary.variant === 'partial'
        ? 'signed-in'
        : summary.variant
  return (
    <article
      className={`settings-provider-auth-card settings-provider-auth-card-${summary.variant} provider-${provider}`}
      data-provider={provider}
    >
      <div className="settings-provider-auth-card-header">
        <ProviderLogoTile provider={provider} />
        <strong>{label}</strong>
        {optional && <span className="settings-provider-auth-optional">Optional</span>}
      </div>
      <div className="settings-provider-auth-status">
        <span
          className={`settings-provider-auth-status-dot settings-provider-auth-status-dot-${dotVariant}`}
          aria-hidden
        />
        <span>{summary.statusText}</span>
      </div>
      <p>{description}</p>
      <p className="settings-provider-auth-hint">{summary.hint}</p>
      {children && <div className="settings-provider-auth-actions">{children}</div>}
    </article>
  )
}

function SettingsProviderPauseControls({
  provider,
  providerRunPauses,
  onChange
}: {
  provider: ProviderId
  providerRunPauses?: AppSettings['providerRunPauses']
  onChange: (partial: { providerRunPauses?: AppSettings['providerRunPauses'] }) => void
}): React.JSX.Element {
  const state = providerRunPauses?.[provider]
  const isPaused = Boolean(state?.paused)
  const activePause = isPaused && isProviderPauseStillActive(state)
  const rerouteProvider = state?.reroute?.provider || ''

  const commitState = (nextState: ProviderRunPauseState | null): void => {
    const nextPauses: NonNullable<AppSettings['providerRunPauses']> = {
      ...(providerRunPauses || {})
    }
    if (nextState) {
      nextPauses[provider] = {
        ...nextState,
        updatedAt: new Date().toISOString()
      }
    } else {
      delete nextPauses[provider]
    }
    onChange({ providerRunPauses: nextPauses })
  }

  const updateState = (patch: Partial<ProviderRunPauseState>): void => {
    const nextState: ProviderRunPauseState = {
      paused: false,
      ...(state || {}),
      ...patch
    }
    if (
      !nextState.paused &&
      !nextState.until &&
      !nextState.reason?.trim() &&
      !nextState.reroute
    ) {
      commitState(null)
      return
    }
    commitState(nextState)
  }

  const updateReroute = (patch: Partial<ProviderReroutePlan> | null): void => {
    if (!patch) {
      updateState({ reroute: null })
      return
    }
    const current = state?.reroute || ({ provider: SETTINGS_PROVIDER_ORDER[0] } as ProviderReroutePlan)
    const nextReroute = {
      ...current,
      ...patch
    }
    if (!nextReroute.provider || nextReroute.provider === provider) {
      updateState({ reroute: null })
      return
    }
    updateState({ reroute: nextReroute })
  }

  const statusText = isPaused
    ? activePause
      ? state?.until
        ? `Paused until ${new Date(state.until).toLocaleString()}`
        : 'Paused'
      : 'Pause expired'
    : 'New runs allowed'
  const rerouteLabel =
    state?.reroute?.provider && state.reroute.provider !== provider
      ? `Rerouting to ${SETTINGS_PROVIDER_LABELS[state.reroute.provider]}`
      : 'No automatic reroute'

  return (
    <div className={`settings-provider-pause ${isPaused ? 'is-paused' : ''}`}>
      <label className="settings-provider-pause-toggle">
        <span>
          <strong>Pause new runs</strong>
          <small>Keep sign-in and active runs intact, but stop new dispatches.</small>
        </span>
        <input
          type="checkbox"
          checked={isPaused}
          onChange={(event) => updateState({ paused: event.target.checked })}
        />
      </label>
      <div className="settings-provider-pause-status">
        <span>{statusText}</span>
        <span>{rerouteLabel}</span>
      </div>
      {isPaused && (
        <div className="settings-provider-pause-grid">
          <label>
            <span>Until</span>
            <input
              className="settings-select"
              type="datetime-local"
              value={toPauseDateTimeLocal(state?.until)}
              onChange={(event) => updateState({ until: fromPauseDateTimeLocal(event.target.value) })}
            />
          </label>
          <label>
            <span>Reason</span>
            <input
              className="settings-select"
              value={state?.reason || ''}
              onChange={(event) => updateState({ reason: event.target.value })}
              placeholder="Outstanding bill, service outage, quota wall..."
            />
          </label>
          <label>
            <span>Reroute while paused</span>
            <select
              className="settings-select"
              value={rerouteProvider}
              onChange={(event) => {
                const nextProvider = event.target.value as ProviderId
                updateReroute(nextProvider ? { provider: nextProvider } : null)
              }}
            >
              <option value="">Choose on each run</option>
              {SETTINGS_PROVIDER_ORDER.filter((candidate) => candidate !== provider).map(
                (candidate) => (
                  <option key={candidate} value={candidate}>
                    {SETTINGS_PROVIDER_LABELS[candidate]}
                  </option>
                )
              )}
            </select>
          </label>
          {rerouteProvider && (
            <>
              <label>
                <span>Fallback model</span>
                <input
                  className="settings-select"
                  value={state?.reroute?.customModel || state?.reroute?.selectedModelType || ''}
                  onChange={(event) =>
                    updateReroute({
                      selectedModelType: event.target.value,
                      customModel: ''
                    })
                  }
                  placeholder="Provider default"
                />
              </label>
              <label>
                <span>Fallback approvals</span>
                <select
                  className="settings-select"
                  value={state?.reroute?.approvalMode || ''}
                  onChange={(event) =>
                    updateReroute({ approvalMode: event.target.value || undefined })
                  }
                >
                  <option value="">Use chat default</option>
                  <option value="default">Default Approval</option>
                  <option value="plan">Plan</option>
                  <option value="auto_edit">Auto Edit</option>
                  <option value="full_access">Full Access</option>
                </select>
              </label>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function isProviderPauseStillActive(state?: ProviderRunPauseState): boolean {
  if (!state?.paused) return false
  if (!state.until) return true
  const until = Date.parse(state.until)
  return Number.isFinite(until) && until > Date.now()
}

function toPauseDateTimeLocal(value?: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function fromPauseDateTimeLocal(value: string): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

function fxConfidenceLabel(source?: FxRateSnapshot['source']): string {
  if (source === 'live') return 'Live'
  if (source === 'cached') return 'Cached'
  if (source === 'fallback') return 'Fallback'
  return 'Unknown'
}

function formatFxUpdatedAt(snapshot: FxRateSnapshot | null): string {
  if (!snapshot) return 'Not loaded yet'
  const time = Date.parse(snapshot.fetchedAt)
  if (!Number.isFinite(time)) return 'Unknown'
  return new Date(time).toLocaleString()
}

function formatFxRate(snapshot: FxRateSnapshot | null, currency: 'GBP' | 'EUR'): string {
  const rate = snapshot?.rates?.[currency]
  return typeof rate === 'number' && Number.isFinite(rate) ? rate.toFixed(4) : 'n/a'
}

/** A provider's worst quota window is at ~100% (0.999 absorbs float
 * noise from `usedPercent / 100`) so its card must read "out of usage"
 * instead of a bare "signed in". Mirrors FirstLaunchSheet. */
const OUT_OF_USAGE_FRACTION = 0.999

/**
 * Worst (most-consumed) quota window for a provider, derived from the
 * same `usageSummary` the Model Usage tab reads. Prefers the honest
 * `usedPercent`, falls back to `1 - remainingPercent`. Returns null when
 * the provider has no quota data (Cursor/Grok never do; the others only
 * after a usage probe). Replicates FirstLaunchSheet's `worstProviderUsage`
 * locally — the duplication is a few lines and avoids a cross-component
 * import.
 */
function worstProviderUsage(
  usageSummary: ModelUsageAggregate[] | undefined,
  providerId: ProviderId
): { fraction: number; resetAt?: string } | null {
  if (!usageSummary || usageSummary.length === 0) return null
  const entry = usageSummary.find(
    (e) => e.provider === providerId && e.model === 'usage limits' && (e.windows?.length || 0) > 0
  )
  if (!entry?.windows) return null
  let worst: { fraction: number; resetAt?: string } | null = null
  for (const w of entry.windows) {
    const used = Number.isFinite(w.usedPercent)
      ? Math.max(0, Math.min(1, (w.usedPercent as number) / 100))
      : Number.isFinite(w.remainingPercent)
        ? Math.max(0, Math.min(1, 1 - (w.remainingPercent as number) / 100))
        : 0
    if (!worst || used > worst.fraction) worst = { fraction: used, resetAt: w.resetAt }
  }
  return worst
}

/**
 * Flip a signed-in provider summary to the "out of usage" state when its
 * worst quota window is at ~100%. No-op for every other variant (you
 * can't be "out of usage" if you were never signed in) and when there's
 * no quota data — so hosts/tests that omit `usageSummary` are unchanged.
 */
function applyOutOfUsage(
  provider: ProviderId,
  summary: ProviderAuthSummary,
  usageSummary: ModelUsageAggregate[] | undefined
): ProviderAuthSummary {
  if (summary.variant !== 'signed-in') return summary
  const worst = worstProviderUsage(usageSummary, provider)
  if (!worst || worst.fraction < OUT_OF_USAGE_FRACTION) return summary
  const reset = formatResetShort({ resetAt: worst.resetAt })
  return {
    variant: 'out-of-usage',
    statusText: reset ? `100% used · resets ${reset}` : '100% used',
    hint: 'Signed in, but rate-limited right now — wait for the reset, switch provider, or switch model. This is a quota wall, not a bug.'
  }
}

export function SettingsPanel({
  mode,
  visualEffectStyle,
  themeAppearance,
  themeCornerStyle,
  themeAccentStyle,
  toolIconAccent,
  appIconVariant,
  userBubbleColor,
  promptSurfaceStyle,
  composerStyle,
  transcriptFontFamily,
  composerFontFamily,
  keyCommandBindings,
  reduceTransparency,
  reduceMotion,
  compactDensity,
  liveActivityViewport,
  sidebarOpacity,
  mainPaneOpacity,
  geminiCheckpointingEnabled,
  chatContextTurns,
  currency,
  currencyOverestimatePercent,
  showRunCompleteSummary,
  ensembleCollapseOlderRounds,
  dashboardStatPrefs,
  welcomeHeatmapPrefs,
  providerRunPauses,
  kimiSanitiserEnabled,
  kimiSanitiserCustomKeywords,
  userName = '',
  claudeBinaryPath,
  kimiBinaryPath,
  ollamaBaseUrl,
  ollamaDefaultModel,
  ollamaToolControlTier = 'read_only',
  ollamaDefaultRunProfile = 'local_scout',
  ollamaRunProfiles,
  ollamaProviderParityAcknowledgedAt,
  ollamaProviderParityWorkspaceGrants,
  auditOrchestration,
  agenticServices,
  nativeSubAgentRequests = 'ask',
  autoResumeParentOnSubThreadCompletion,
  agenticWorkspaceGrantCount,
  agenticWorkspaceGrants,
  activeProvider,
  providerCapabilities,
  providerCapabilitiesByProvider,
  mcpStatusByProvider,
  userMcpServers = [],
  geminiMcpBridgeEnabled,
  codexSandboxFallback,
  funFxEnabled,
  funFxMode,
  advancedFx,
  autoUpdateEnabled,
  updateChannel,
  approvalTimeouts,
  productOperationsStatus,
  codexStatus,
  claudeAuthStatus,
  kimiAuthStatus,
  ollamaStatus,
  cursorProviderAvailable = false,
  grokProviderAvailable = false,
  claudeLoginState = 'idle',
  providerCliUpgradeState = {},
  onImportCodexUsageCredential,
  onClearCodexUsageCredential,
  onTriggerClaudeLogin,
  onStoreClaudeApiKey,
  onClearClaudeApiKey,
  onStoreKimiApiKey,
  onClearKimiApiKey,
  onProviderUpgrade,
  onProviderLogin,
  onProviderLogout,
  onRemoveAgenticWorkspaceGrant,
  onInstallGeminiMcpBridge,
  onRefreshGeminiMcpBridgeStatus,
  onRefreshProviderMcpStatus,
  onRefreshProductOperationsStatus,
  onExportProductDiagnostics,
  onRepairProductInstall,
  onDeleteAllChatHistory,
  onChange,
  onClose,
  activeTab: activeTabProp,
  onTabChange,
  layout = 'sheet',
  workspaces = [],
  currentWorkspace,
  onSelectWorkspace,
  onSelectWorkspaceDialog,
  onRemoveWorkspace,
  onTogglePinWorkspace,
  usageSummary = [],
  usageRecords = [],
  pinnedMessageGroups = [],
  onOpenPinnedMessage
}: SettingsPanelProps): React.JSX.Element {
  const [claudeKeyInput, setClaudeKeyInput] = useState('')
  const [kimiKeyInput, setKimiKeyInput] = useState('')
  // Uncontrolled fallback state. Used only when the caller doesn't
  // pass `activeTab`/`onTabChange` — i.e. when SettingsPanel is mounted
  // without the surrounding sidebar takeover (legacy / future tests).
  const [internalActiveTab, setInternalActiveTab] = useState<SettingsTab>('appearance')
  // Hoist a SINGLE iOS-allowlist fetch and feed every workspace card's remote
  // toggle (controlled mode), instead of N cards each self-fetching. Starts as
  // [] so the toggles are controlled from the first render; the real list lands
  // a tick later. `refreshRemoteAllowlist` re-syncs all cards after any toggle.
  const [remoteAllowlist, setRemoteAllowlist] = useState<RemoteWorkspaceEntry[]>([])
  const refreshRemoteAllowlist = (): void => {
    void window.api
      .bridgeAllowlistList()
      .then((list) => setRemoteAllowlist((list ?? []) as RemoteWorkspaceEntry[]))
      .catch(() => undefined)
  }
  useEffect(() => {
    void window.api
      .bridgeAllowlistList()
      .then((list) => setRemoteAllowlist((list ?? []) as RemoteWorkspaceEntry[]))
      .catch(() => undefined)
  }, [])
  const requestedActiveTab = activeTabProp ?? internalActiveTab
  const activeTab = resolveVisibleSettingsTab(requestedActiveTab)
  const visibleSettingsTabs = getVisibleSettingsTabs()
  const setActiveTab = (next: SettingsTab): void => {
    if (!isSettingsTabVisible(next)) return
    if (onTabChange) onTabChange(next)
    else setInternalActiveTab(next)
  }
  const [installedFontOptions, setInstalledFontOptions] = useState<TypefaceOption[]>([])
  const [installedFontStatus, setInstalledFontStatus] = useState('')
  const [composerPreviewText, setComposerPreviewText] = useState('')
  const [mcpToolQuery, setMcpToolQuery] = useState('')
  const [mcpServerQuery, setMcpServerQuery] = useState('')
  const [pluginQuery, setPluginQuery] = useState('')
  const [pluginCatalog, setPluginCatalog] = useState<TaskWraithPluginCatalogSnapshot | null>(null)
  const [pluginCatalogError, setPluginCatalogError] = useState('')
  const [pluginBusyId, setPluginBusyId] = useState<string | null>(null)
  const [mcpServerFormMode, setMcpServerFormMode] = useState<'hidden' | 'create' | 'edit'>(
    'hidden'
  )
  const [editingMcpServerId, setEditingMcpServerId] = useState<string | null>(null)
  const [mcpServerForm, setMcpServerForm] = useState<UserMcpServerFormState>(
    emptyUserMcpServerForm
  )
  const [mcpServerFormError, setMcpServerFormError] = useState('')
  const [mcpImportOpen, setMcpImportOpen] = useState(false)
  const [mcpImportText, setMcpImportText] = useState('')
  const [mcpImportError, setMcpImportError] = useState('')
  const [copiedMcpServerId, setCopiedMcpServerId] = useState<string | null>(null)
  const [copiedMcpServerSnippetKey, setCopiedMcpServerSnippetKey] = useState<string | null>(null)
  const [copiedMcpServersJson, setCopiedMcpServersJson] = useState(false)
  const [copiedMcpServersClaudeJson, setCopiedMcpServersClaudeJson] = useState(false)
  const [copiedMcpServersCursorJson, setCopiedMcpServersCursorJson] = useState(false)
  const [copiedMcpServersCodexToml, setCopiedMcpServersCodexToml] = useState(false)
  const [keyCommandQuery, setKeyCommandQuery] = useState('')
  const [recordingKeyCommandId, setRecordingKeyCommandId] = useState<KeyCommandId | null>(null)
  const [keyCommandRecordError, setKeyCommandRecordError] = useState('')
  const [kimiClassifierEnabled, setKimiClassifierEnabled] = useState(false)
  const [kimiClassifierStatus, setKimiClassifierStatus] = useState('disabled')
  const [fxSnapshot, setFxSnapshot] = useState<FxRateSnapshot | null>(null)
  const [fxRefreshing, setFxRefreshing] = useState(false)
  const [fxError, setFxError] = useState<string | null>(null)
  const [showOllamaParityAck, setShowOllamaParityAck] = useState(false)
  const [showDeleteHistoryConfirm, setShowDeleteHistoryConfirm] = useState(false)
  const [deleteHistoryPending, setDeleteHistoryPending] = useState(false)
  const [deleteHistoryError, setDeleteHistoryError] = useState('')

  useEffect(() => {
    if (activeTab !== 'plugins') return
    let cancelled = false
    if (typeof window === 'undefined' || typeof window.api?.getPluginCatalog !== 'function') {
      setPluginCatalogError('Plugin catalog unavailable.')
      return
    }
    setPluginCatalogError('')
    void window.api
      .getPluginCatalog()
      .then((snapshot) => {
        if (!cancelled) setPluginCatalog(snapshot)
      })
      .catch((error) => {
        if (!cancelled) setPluginCatalogError(String(error))
      })
    return () => {
      cancelled = true
    }
  }, [activeTab])

  useEffect(() => {
    let cancelled = false
    if (typeof window === 'undefined' || typeof window.api?.getSettings !== 'function') return
    void window.api
      .getSettings()
      .then((settings) => {
        if (cancelled) return
        const enabled = Boolean(settings.kimiClassifierEnabled)
        setKimiClassifierEnabled(enabled)
        setKimiClassifierStatus(enabled ? 'enabled' : 'disabled')
      })
      .catch(() => {
        if (!cancelled) setKimiClassifierStatus('unavailable')
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    if (typeof window === 'undefined' || typeof window.api?.getFxRates !== 'function') return
    void window.api
      .getFxRates()
      .then((snapshot) => {
        if (cancelled) return
        setFxSnapshot(snapshot)
        setFxRatesPerUsd(snapshot.rates)
        setFxError(snapshot.errorMessage ?? null)
      })
      .catch((err) => {
        if (!cancelled) setFxError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const sidebarOpacityValue = clampPaneOpacity(sidebarOpacity)
  const mainPaneOpacityValue = clampPaneOpacity(mainPaneOpacity)

  const updateKimiClassifierEnabled = (enabled: boolean): void => {
    setKimiClassifierEnabled(enabled)
    setKimiClassifierStatus(enabled ? 'enabled' : 'disabled')
    if (typeof window === 'undefined' || typeof window.api?.updateSettings !== 'function') {
      setKimiClassifierStatus('unavailable')
      return
    }
    void window.api.updateSettings({ kimiClassifierEnabled: enabled }).catch(() => {
      setKimiClassifierEnabled(!enabled)
      setKimiClassifierStatus('unavailable')
    })
  }

  const runPluginMutation = (
    pluginId: string,
    mutate: () => Promise<TaskWraithPluginCatalogSnapshot>
  ): void => {
    setPluginBusyId(pluginId)
    setPluginCatalogError('')
    void mutate()
      .then((snapshot) => setPluginCatalog(snapshot))
      .catch((error) => setPluginCatalogError(String(error)))
      .finally(() => {
        setPluginBusyId((current) => (current === pluginId ? null : current))
      })
  }

  const installPlugin = (pluginId: string): void => {
    if (typeof window === 'undefined' || typeof window.api?.installPlugin !== 'function') {
      setPluginCatalogError('Plugin install unavailable.')
      return
    }
    runPluginMutation(pluginId, () => window.api.installPlugin(pluginId))
  }

  const setPluginEnabled = (pluginId: string, enabled: boolean): void => {
    if (typeof window === 'undefined' || typeof window.api?.setPluginEnabled !== 'function') {
      setPluginCatalogError('Plugin enablement unavailable.')
      return
    }
    runPluginMutation(pluginId, () => window.api.setPluginEnabled(pluginId, enabled))
  }

  const uninstallPlugin = (pluginId: string): void => {
    if (typeof window === 'undefined' || typeof window.api?.uninstallPlugin !== 'function') {
      setPluginCatalogError('Plugin uninstall unavailable.')
      return
    }
    runPluginMutation(pluginId, () => window.api.uninstallPlugin(pluginId))
  }

  const updatePlugin = (pluginId: string): void => {
    if (typeof window === 'undefined' || typeof window.api?.updatePlugin !== 'function') {
      setPluginCatalogError('Plugin update unavailable.')
      return
    }
    runPluginMutation(pluginId, () => window.api.updatePlugin(pluginId))
  }

  const addPluginMcpPreset = (pluginId: string, presetId: string): void => {
    if (
      typeof window === 'undefined' ||
      typeof window.api?.materializePluginMcpPreset !== 'function'
    ) {
      setPluginCatalogError('Plugin MCP preset materialization unavailable.')
      return
    }
    const busyKey = `mcp:${pluginId}:${presetId}`
    setPluginBusyId(busyKey)
    setPluginCatalogError('')
    void window.api
      .materializePluginMcpPreset(pluginId, presetId)
      .then((result) => {
        const server = result.userMcpServerConfig as UserMcpServerConfig
        if (userMcpServers.some((existing) => existing.id === server.id)) return
        if (hasUserMcpServerNameConflict(userMcpServers, server.name, server.id)) {
          setPluginCatalogError('Another MCP server already uses that plugin preset name.')
          return
        }
        persistUserMcpServers([...userMcpServers, server])
      })
      .catch((error) => setPluginCatalogError(String(error)))
      .finally(() => {
        setPluginBusyId((current) => (current === busyKey ? null : current))
      })
  }

  const resetMcpServerForm = (): void => {
    setMcpServerFormMode('hidden')
    setEditingMcpServerId(null)
    setMcpServerForm(emptyUserMcpServerForm())
    setMcpServerFormError('')
  }

  const startCreateMcpServer = (): void => {
    setMcpImportOpen(false)
    setMcpImportError('')
    setMcpServerFormMode('create')
    setEditingMcpServerId(null)
    setMcpServerForm(emptyUserMcpServerForm())
    setMcpServerFormError('')
  }

  const startImportMcpServers = (): void => {
    resetMcpServerForm()
    setMcpImportOpen(true)
    setMcpImportError('')
  }

  const openCreateMcpServerPage = (): void => {
    startCreateMcpServer()
    setActiveTab('mcp-servers')
  }

  const openImportMcpServersPage = (): void => {
    startImportMcpServers()
    setActiveTab('mcp-servers')
  }

  const cancelImportMcpServers = (): void => {
    setMcpImportOpen(false)
    setMcpImportText('')
    setMcpImportError('')
  }

  const startEditMcpServer = (server: UserMcpServerConfig): void => {
    setMcpServerFormMode('edit')
    setEditingMcpServerId(server.id)
    setMcpServerForm(formFromUserMcpServer(server))
    setMcpServerFormError('')
  }

  const persistUserMcpServers = (servers: UserMcpServerConfig[]): void => {
    onChange({ userMcpServers: servers })
  }

  const saveMcpServerForm = (): void => {
    const existing =
      editingMcpServerId && mcpServerFormMode === 'edit'
        ? userMcpServers.find((server) => server.id === editingMcpServerId)
        : undefined
    const result = buildUserMcpServerFromForm(mcpServerForm, existing)
    if (!result.server) {
      setMcpServerFormError(result.error || 'Could not save this MCP server.')
      return
    }
    if (hasUserMcpServerNameConflict(userMcpServers, result.server.name, result.server.id)) {
      setMcpServerFormError('Another MCP server already uses that name.')
      return
    }
    const next =
      existing && editingMcpServerId
        ? userMcpServers.map((server) =>
            server.id === editingMcpServerId ? (result.server as UserMcpServerConfig) : server
          )
        : [...userMcpServers, result.server]
    persistUserMcpServers(next)
    resetMcpServerForm()
  }

  const importMcpServersFromConfig = (): void => {
    const result = parseUserMcpServersImportJson(mcpImportText, userMcpServers)
    if (result.error) {
      setMcpImportError(result.error)
      return
    }
    persistUserMcpServers([...userMcpServers, ...result.servers])
    setMcpImportOpen(false)
    setMcpImportText('')
    setMcpImportError('')
  }

  const copyMcpServerAuditJson = (server: UserMcpServerConfig): void => {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return
    void navigator.clipboard
      .writeText(formatUserMcpServerAuditJson(server))
      .then(() => {
        setCopiedMcpServerId(server.id)
        window.setTimeout(() => {
          setCopiedMcpServerId((current) => (current === server.id ? null : current))
        }, 1600)
      })
      .catch(() => undefined)
  }

  const copyMcpServerProviderSnippet = (
    serverId: string,
    provider: 'claude' | 'cursor' | 'codex',
    text: string
  ): void => {
    if (!text || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return
    const copyKey = `${serverId}:${provider}`
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopiedMcpServerSnippetKey(copyKey)
        window.setTimeout(() => {
          setCopiedMcpServerSnippetKey((current) => (current === copyKey ? null : current))
        }, 1600)
      })
      .catch(() => undefined)
  }

  const copyAllMcpServersAuditJson = (): void => {
    if (
      userMcpServers.length === 0 ||
      typeof navigator === 'undefined' ||
      !navigator.clipboard?.writeText
    ) {
      return
    }
    void navigator.clipboard
      .writeText(formatUserMcpServersAuditJson(userMcpServers))
      .then(() => {
        setCopiedMcpServersJson(true)
        window.setTimeout(() => setCopiedMcpServersJson(false), 1600)
      })
      .catch(() => undefined)
  }

  const copyAllMcpServersCodexToml = (): void => {
    if (
      !userMcpServers.some(isCodexExportableUserMcpServer) ||
      typeof navigator === 'undefined' ||
      !navigator.clipboard?.writeText
    ) {
      return
    }
    void navigator.clipboard
      .writeText(formatUserMcpServersCodexToml(userMcpServers))
      .then(() => {
        setCopiedMcpServersCodexToml(true)
        window.setTimeout(() => setCopiedMcpServersCodexToml(false), 1600)
      })
      .catch(() => undefined)
  }

  const copyAllMcpServersClaudeJson = (): void => {
    if (
      !userMcpServers.some(isClaudeExportableUserMcpServer) ||
      typeof navigator === 'undefined' ||
      !navigator.clipboard?.writeText
    ) {
      return
    }
    void navigator.clipboard
      .writeText(formatUserMcpServersClaudeJson(userMcpServers))
      .then(() => {
        setCopiedMcpServersClaudeJson(true)
        window.setTimeout(() => setCopiedMcpServersClaudeJson(false), 1600)
      })
      .catch(() => undefined)
  }

  const copyAllMcpServersCursorJson = (): void => {
    if (
      !userMcpServers.some(isCursorExportableUserMcpServer) ||
      typeof navigator === 'undefined' ||
      !navigator.clipboard?.writeText
    ) {
      return
    }
    void navigator.clipboard
      .writeText(formatUserMcpServersCursorJson(userMcpServers))
      .then(() => {
        setCopiedMcpServersCursorJson(true)
        window.setTimeout(() => setCopiedMcpServersCursorJson(false), 1600)
      })
      .catch(() => undefined)
  }

  const toggleUserMcpServer = (server: UserMcpServerConfig, enabled: boolean): void => {
    if (enabled && !hasRunnableUserMcpEndpoint(server)) {
      startEditMcpServer(server)
      setMcpServerFormError(
        server.transport === 'stdio'
          ? 'Add a command before enabling this stdio MCP server.'
          : server.url?.trim()
            ? 'Use an http:// or https:// URL before enabling this MCP server.'
            : 'Add a URL before enabling this MCP server.'
      )
      return
    }
    persistUserMcpServers(
      userMcpServers.map((entry) =>
        entry.id === server.id
          ? { ...entry, enabled, updatedAt: new Date().toISOString() }
          : entry
      )
    )
  }

  const deleteUserMcpServer = (serverId: string): void => {
    persistUserMcpServers(userMcpServers.filter((server) => server.id !== serverId))
    if (editingMcpServerId === serverId) resetMcpServerForm()
  }

  const refreshExchangeRates = async (): Promise<void> => {
    if (typeof window === 'undefined' || typeof window.api?.refreshFxRates !== 'function') {
      setFxError('Exchange-rate refresh is unavailable in this renderer.')
      return
    }
    setFxRefreshing(true)
    setFxError(null)
    try {
      const snapshot = await window.api.refreshFxRates(true)
      setFxSnapshot(snapshot)
      setFxRatesPerUsd(snapshot.rates)
      setFxError(snapshot.errorMessage ?? null)
    } catch (err) {
      setFxError(err instanceof Error ? err.message : String(err))
    } finally {
      setFxRefreshing(false)
    }
  }

  const safeTurns = Number.isFinite(chatContextTurns)
    ? Math.max(0, Math.trunc(chatContextTurns))
    : 6
  const boundedTurns = Math.min(20, safeTurns)
  const transcriptFontOptions = [...TRANSCRIPT_FONT_OPTIONS, ...installedFontOptions]
  const composerFontOptions = [...COMPOSER_FONT_OPTIONS, ...installedFontOptions]
  const transcriptFontSelectValue = getFontSelectValue(
    transcriptFontOptions,
    transcriptFontFamily || FONT_STACKS.taskwraith
  )
  const composerFontSelectValue = getFontSelectValue(
    composerFontOptions,
    composerFontFamily || COMPOSER_FONT_MATCH_TRANSCRIPT
  )
  const canLoadInstalledFonts =
    typeof window !== 'undefined' &&
    typeof (window as LocalFontWindow).queryLocalFonts === 'function'
  const updateAgenticService = <K extends keyof AgenticServicesSettings>(
    key: K,
    value: AgenticServicesSettings[K]
  ): void => {
    onChange({ agenticServices: { ...agenticServices, [key]: value } })
  }
  const auditProviderAllowlist = auditOrchestration?.providerAllowlist ?? []
  const updateAuditOrchestration = (
    patch: Partial<NonNullable<AppSettings['auditOrchestration']>>
  ): void => {
    onChange({
      auditOrchestration: {
        ...(auditOrchestration ?? {}),
        providerAllowlist: auditProviderAllowlist,
        ...patch
      }
    })
  }
  const toggleAuditProvider = (provider: ProviderId, enabled: boolean): void => {
    const nextAllowlist = enabled
      ? Array.from(new Set([...auditProviderAllowlist, provider]))
      : auditProviderAllowlist.filter((item) => item !== provider)
    updateAuditOrchestration({ providerAllowlist: nextAllowlist })
  }
  // Flip any signed-in provider whose worst quota window is at ~100% to
  // an honest "out of usage" state — otherwise a rate-limited provider
  // still reads "Signed in" and looks broken. Mirrors FirstLaunchSheet.
  const codexAuthSummary = applyOutOfUsage('codex', summariseCodexStatus(codexStatus), usageSummary)
  const claudeAuthSummary = applyOutOfUsage(
    'claude',
    summariseProviderApiKeyStatus(claudeAuthStatus ?? null, 'Claude'),
    usageSummary
  )
  const kimiSetupSummary = applyOutOfUsage(
    'kimi',
    summariseProviderApiKeyStatus(kimiAuthStatus ?? null, 'Kimi'),
    usageSummary
  )
  const claudeApiKeyStorageUnavailable = claudeAuthStatus
    ? !claudeAuthStatus.encryptionAvailable
    : false
  const kimiApiKeyStorageUnavailable = kimiAuthStatus ? !kimiAuthStatus.encryptionAvailable : false
  const cursorAuthSummary = summariseCliProviderEnabled(
    cursorProviderAvailable,
    'Cursor',
    'Sign in once with `cursor-agent login` in your shell; runs are diff-reviewed in write mode.'
  )
  const grokAuthSummary = summariseCliProviderEnabled(
    grokProviderAvailable,
    'Grok',
    'Authenticate the Grok CLI (in `~/.grok/bin`) in your shell, then launch Grok runs.'
  )
  // Ollama's status reflects the LOCAL runtime; the card's sign-in is the
  // OPTIONAL ollama.com cloud auth (`ollama signin`), which local models don't
  // need. Custom summary (not summariseCliProviderEnabled) so "ready" reads as a
  // green local-runtime dot rather than the CLI-provider "Available · sign-in".
  const ollamaAuthSummary: ProviderAuthSummary = ollamaStatus?.available
    ? {
        variant: 'signed-in',
        statusText: 'Local runtime ready',
        hint: 'Local models need no account. Sign in to ollama.com only for Ollama Cloud / Turbo.'
      }
    : {
        variant: 'partial',
        statusText: 'Local setup optional',
        hint: 'Install Ollama and pull a model, or sign in to ollama.com to use cloud models.'
      }
  const providerUpgradeState = (provider: ProviderId): ProviderCliUpgradeState =>
    providerCliUpgradeState[provider] || 'idle'
  const renderProviderUpgradeButton = (provider: ProviderId) => {
    const state = providerUpgradeState(provider)
    return (
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        onClick={() => onProviderUpgrade?.(provider)}
        disabled={!onProviderUpgrade || state === 'opening'}
      >
        {state === 'opening' ? 'Opening…' : 'Upgrade CLI…'}
      </button>
    )
  }
  const renderProviderUpgradeHint = (provider: ProviderId) => {
    const state = providerUpgradeState(provider)
    if (state === 'opened') {
      return ' Upgrade terminal opened; TaskWraith will refresh detected CLI status shortly.'
    }
    if (state === 'error') return ' Could not open the upgrade terminal.'
    return ''
  }
  const renderProviderPauseControls = (provider: ProviderId): React.JSX.Element => (
    <SettingsProviderPauseControls
      provider={provider}
      providerRunPauses={providerRunPauses}
      onChange={onChange}
    />
  )
  // Retired providers are excluded from SETTINGS_PROVIDER_ORDER above; this
  // filter is a defensive backstop so a future retirement never surfaces an
  // offer card or counts toward the "providers reporting MCP/bridge status" stat.
  const providerMcpSummaries = SETTINGS_PROVIDER_ORDER.filter(
    (provider) => !isRetiredProvider(provider)
  ).map((provider) => {
    const contract =
      providerCapabilitiesByProvider?.[provider] ??
      (provider === activeProvider ? providerCapabilities : null)
    const status = mcpStatusByProvider?.[provider]
    // Cursor + Grok get the brokered TaskWraith MCP bridge through their
    // provider-native MCP surfaces. The accurate per-provider state/source/tools
    // message comes from the capability contract; these blocks only seed the card
    // BEFORE the contract has loaded so it doesn't flash stale delegated copy.
    const provisionalFallback =
      contract?.mcp
        ? null
        : provider === 'cursor'
          ? {
              state: 'available' as const,
              source: 'bridge',
              serverName: 'taskwraith',
              toolCount: TASKWRAITH_MCP_TOOLS.length,
              providerManaged: false,
              message:
                'TaskWraith registers a brokered MCP server for Cursor write-mode runs. Native Cursor shell/write tools are constrained so workspace side effects go through TaskWraith approvals.'
            }
          : provider === 'grok'
            ? {
                state: 'available' as const,
                source: 'bridge',
                serverName: 'TaskWraith',
                toolCount: TASKWRAITH_MCP_TOOLS.length,
                providerManaged: false,
                message:
                  'TaskWraith registers a brokered MCP server for Grok ACP runs. Mutating MCP tools are executed by TaskWraith after approval and workspace/path checks.'
              }
            : null
    const mcp = contract?.mcp
    // Provider-managed fallback surfaces are not installable TaskWraith MCP
    // servers, so they must never read as an error ("unsupported" /
    // "not installed"). Cursor/Grok now report `bridge` when their TaskWraith
    // MCP registrations are enabled.
    const providerManaged =
      mcp?.source === 'provider-managed' ||
      mcp?.source === 'taskwraith web bridge' ||
      mcp?.source === 'unsupported' ||
      Boolean(provisionalFallback?.providerManaged)
    const available = Boolean(mcp?.available ?? status?.available)
    const enabled = Boolean(mcp?.enabled ?? available)
    // HARD RULE: never fabricate "installed" from mere availability for a
    // provider-managed fallback surface. Bridge-backed providers report installed
    // from their capability contract.
    const installed = providerManaged
      ? Boolean(mcp?.installed)
      : Boolean(mcp?.installed ?? available)
    const state = mcp?.state ?? provisionalFallback?.state ?? (available ? 'available' : 'gated')
    const rawToolCount = countMcpStatusTools(status)
    const rawServerCount = countMcpStatusServers(status)
    const taskwraithBridgeToolCount =
      provider === 'codex' && enabled ? TASKWRAITH_MCP_TOOLS.length : 0
    const toolCount = Math.max(
      taskwraithBridgeToolCount,
      provider === 'codex' ? 0 : rawToolCount,
      Array.isArray(mcp?.tools) && provider !== 'codex' ? mcp.tools.length : 0,
      provisionalFallback?.toolCount ?? 0
    )
    const source =
      provider === 'codex' && enabled
        ? 'bridge'
        : mcp?.source ||
          provisionalFallback?.source ||
          (provider === 'codex' ? 'provider' : 'taskwraith')
    const codexInventoryNote =
      provider === 'codex' && rawToolCount > toolCount
        ? ` Codex app-server also reports ${rawServerCount} MCP server${rawServerCount === 1 ? '' : 's'} with ${pluralizeCount(rawToolCount, 'total tool')}.`
        : ''
    const messageBase =
      provider === 'codex' && enabled
        ? 'TaskWraith registers the MCP bridge for Codex runs.'
        : mcp?.message ||
          provisionalFallback?.message ||
          status?.message ||
          status?.error ||
          (available
            ? 'MCP surface is available for this provider.'
            : 'MCP status is not available yet.')
    return {
      provider,
      label: SETTINGS_PROVIDER_LABELS[provider],
      available,
      enabled,
      installed,
      providerManaged,
      state,
      source,
      serverName:
        mcp?.serverName ||
        provisionalFallback?.serverName ||
        (available ? 'TaskWraith' : 'not connected'),
      toolCount,
      message: messageBase + codexInventoryNote
    }
  })
  const connectedMcpProviderCount = providerMcpSummaries.filter(
    (entry) => entry.available || entry.enabled
  ).length
  const activeUserMcpServerCount = userMcpServers.filter(
    (server) => server.enabled && hasRunnableUserMcpEndpoint(server)
  ).length
  const userMcpServerReadinessRows = userMcpServers.map((server) => ({
    server,
    readiness: userMcpServerReadiness(server)
  }))
  const readyUserMcpServerCount = userMcpServerReadinessRows.filter(
    (entry) => entry.readiness.state === 'ready'
  ).length
  const blockedUserMcpServerCount = userMcpServerReadinessRows.filter(
    (entry) => entry.readiness.state === 'blocked'
  ).length
  const userMcpTransportCount = new Set(userMcpServers.map((server) => server.transport)).size
  const codexExportableUserMcpServerCount = userMcpServers.filter(
    isCodexExportableUserMcpServer
  ).length
  const claudeExportableUserMcpServerCount = userMcpServers.filter(
    isClaudeExportableUserMcpServer
  ).length
  const cursorExportableUserMcpServerCount = userMcpServers.filter(
    isCursorExportableUserMcpServer
  ).length
  const mcpServerSearch = mcpServerQuery.trim().toLowerCase()
  const filteredUserMcpServers = userMcpServerReadinessRows.filter(({ server }) =>
    userMcpServerMatchesQuery(server, mcpServerSearch)
  )
  const pluginEntries = pluginCatalog?.plugins ?? []
  const pluginSearch = pluginQuery.trim().toLowerCase()
  const filteredPluginEntries = pluginEntries.filter((entry) =>
    pluginSettingsEntryMatchesQuery(entry, pluginSearch)
  )
  const installedPluginCount =
    pluginCatalog?.counts.installed ?? pluginEntries.filter((entry) => entry.installed).length
  const enabledPluginCount =
    pluginCatalog?.counts.enabled ?? pluginEntries.filter((entry) => entry.enabled).length
  const blockedPluginCount =
    pluginCatalog?.counts.blocked ??
    pluginEntries.filter((entry) => entry.preflight.status === 'blocked').length
  const repairablePluginCount =
    pluginCatalog?.counts.repairable ??
    pluginEntries.filter((entry) => entry.preflight.status === 'repairable').length
  const pluginUpdateCount = pluginEntries.filter(
    (entry) => entry.update?.status === 'available'
  ).length
  const mcpToolSearch = mcpToolQuery.trim().toLowerCase()
  const filteredMcpToolCatalog = MCP_TOOL_CATALOG.filter((tool) => {
    if (!mcpToolSearch) return true
    const haystack = [
      tool.name,
      tool.label,
      tool.transcript,
      tool.description,
      tool.iconRef,
      tool.group,
      MCP_TOOL_GROUP_LABELS[tool.group],
      getMcpPolicyLabel(agenticServices, tool.policyKey),
      formatMcpInvocation('codex', tool.name),
      formatMcpInvocation('claude', tool.name)
    ]
      .join(' ')
      .toLowerCase()
    return haystack.includes(mcpToolSearch)
  })
  const resolvedKeyCommandBindings = resolveKeyCommandBindings(keyCommandBindings)
  const sanitizedKeyCommandOverrides = sanitizeKeyCommandOverrides(keyCommandBindings)
  const keyCommandSearch = keyCommandQuery.trim().toLowerCase()
  const keyCommandRows = KEY_COMMAND_DEFINITIONS.map((definition) => {
    const binding = resolvedKeyCommandBindings[definition.id]
    const conflict = binding
      ? findKeyCommandConflict(definition.id, binding, resolvedKeyCommandBindings)
      : null
    return {
      ...definition,
      binding,
      keys: formatKeyCommandBinding(binding),
      conflict,
      customized: hasCustomKeyCommandBinding(definition.id, keyCommandBindings)
    }
  })
  const filteredKeyCommands = keyCommandRows.filter((command) => {
    if (!keyCommandSearch) return true
    const haystack = [
      command.group,
      command.command,
      command.description,
      command.keys.join(' '),
      command.conflict?.command || '',
      command.customized ? 'custom' : 'default'
    ]
      .join(' ')
      .toLowerCase()
    return haystack.includes(keyCommandSearch)
  })
  const activeKeyCommandCount = keyCommandRows.filter((command) => command.binding !== null).length
  const customizedKeyCommandCount = keyCommandRows.filter((command) => command.customized).length
  const conflictKeyCommandCount = keyCommandRows.filter((command) => command.conflict).length
  const policyTone = (value: AgenticServicePolicy | AgenticNetworkPolicy): 'ok' | 'watch' | 'risk' => {
    if (value === 'allow') return 'risk'
    if (value === 'workspace') return 'watch'
    return 'ok'
  }
  const agenticPolicyLabel = (value: AgenticServicePolicy): string =>
    AGENTIC_SERVICE_POLICY_OPTIONS.find((option) => option.value === value)?.label ?? value
  const networkPolicyLabel = (value: AgenticNetworkPolicy): string =>
    NETWORK_POLICY_OPTIONS.find((option) => option.value === value)?.label ?? value
  const canvasInteractionPolicy = agenticServices.canvasInteraction ?? 'ask'
  const mediaEditingPolicy = agenticServices.mediaEditing ?? 'ask'
  const safetyPolicyRows = [
    {
      id: 'shell',
      label: 'Shell commands',
      scope: 'Workspace',
      value: agenticServices.shellCommands,
      display: agenticPolicyLabel(agenticServices.shellCommands),
      tone: policyTone(agenticServices.shellCommands),
      description: 'Provider runs can request terminal commands inside the active workspace.'
    },
    {
      id: 'files',
      label: 'File changes',
      scope: 'Workspace',
      value: agenticServices.fileChanges,
      display: agenticPolicyLabel(agenticServices.fileChanges),
      tone: policyTone(agenticServices.fileChanges),
      description: 'Write, replace, and patch tools stay inside the workspace boundary.'
    },
    {
      id: 'mcp',
      label: 'Provider tools',
      scope: 'Provider',
      value: agenticServices.mcpTools,
      display: agenticPolicyLabel(agenticServices.mcpTools),
      tone: policyTone(agenticServices.mcpTools),
      description:
        'TaskWraith provider tools expose workspace, audit, editor, and app-control surfaces.'
    },
    {
      id: 'subthread',
      label: 'Sub-thread delegation',
      scope: 'Provider',
      value: agenticServices.subThreadDelegation,
      display: agenticPolicyLabel(agenticServices.subThreadDelegation),
      tone: policyTone(agenticServices.subThreadDelegation),
      description: 'Agents can spawn or resume provider sub-threads under the current workspace.'
    },
    {
      id: 'canvas',
      label: 'Canvas interaction',
      scope: 'Workspace',
      value: canvasInteractionPolicy,
      display: agenticPolicyLabel(canvasInteractionPolicy),
      tone: policyTone(canvasInteractionPolicy),
      description: 'Agents can click and fill preview UI when the workspace policy permits it.'
    },
    {
      id: 'media',
      label: 'Media editing',
      scope: 'Workspace',
      value: mediaEditingPolicy,
      display: agenticPolicyLabel(mediaEditingPolicy),
      tone: policyTone(mediaEditingPolicy),
      description:
        'Transcode, encode, probe, and mix workspace audio/video files. Denied under read-only.'
    },
    {
      id: 'network',
      label: 'Network access',
      scope: 'Provider',
      value: agenticServices.networkAccess,
      display: networkPolicyLabel(agenticServices.networkAccess),
      tone: policyTone(agenticServices.networkAccess),
      description: 'Provider tool loops may fetch from the network when this is allowed.'
    }
  ]
  const riskyPolicyCount = safetyPolicyRows.filter((row) => row.tone === 'risk').length
  const watchPolicyCount = safetyPolicyRows.filter((row) => row.tone === 'watch').length
  const providerPrivacyRows = [
    { label: 'Codex', summary: codexAuthSummary },
    { label: 'Claude', summary: claudeAuthSummary },
    { label: 'Kimi', summary: kimiSetupSummary },
    { label: 'Cursor', summary: cursorAuthSummary },
    { label: 'Grok', summary: grokAuthSummary },
    { label: 'Ollama', summary: ollamaAuthSummary }
  ]
  const visibleProviderSurfaceCount = providerPrivacyRows.filter((row) =>
    ['signed-in', 'partial', 'out-of-usage'].includes(row.summary.variant)
  ).length
  type SafetySurfaceRow = {
    id: string
    label: string
    scope: string
    detail: string
    action: string
    tab: SettingsTab
  }
  const safetySurfaceRows = ([
    {
      id: 'history',
      label: 'Local history and audit records',
      scope: 'Global',
      detail:
        'Chats, run events, approval decisions, usage snapshots, and pinned messages are kept in TaskWraith storage on this Mac unless you delete them.',
      action: 'Open General',
      tab: 'behavior'
    },
    {
      id: 'providers',
      label: 'Provider accounts and usage visibility',
      scope: 'Provider',
      detail:
        'TaskWraith shows provider availability and usage state, but provider sign-in remains in each provider CLI, OAuth profile, or API-key flow.',
      action: 'Open Providers',
      tab: 'providers'
    },
    {
      id: 'mcp',
      label: 'Provider tool surfaces',
      scope: 'Provider',
      detail:
        'The TaskWraith MCP bridge exposes workspace, audit, editor, and orchestration tools according to the active service policies.',
      action: 'Open Provider Tools',
      tab: 'mcp'
    },
    {
      id: 'mcp-servers',
      label: 'User-managed MCP servers',
      scope: 'Global',
      detail:
        'External MCP server commands, URLs, env vars, and headers are stored in TaskWraith settings and attached to supported provider launches.',
      action: 'Open MCP Servers',
      tab: 'mcp-servers'
    },
    {
      id: 'devices',
      label: 'Paired iOS device visibility',
      scope: 'Device',
      detail:
        remoteAllowlist.length > 0
          ? `${pluralizeCount(remoteAllowlist.length, 'workspace')} can be projected to paired devices. Remote write attempts still flow through desktop policy and approval gates.`
          : 'No remote workspace allowlist entries are currently loaded for paired devices.',
      action: 'Open Devices',
      tab: 'pairing'
    },
    {
      id: 'capture',
      label: 'Window capture, browser previews, and Canvas control',
      scope: 'Workspace',
      detail:
        'Screen Watch frames, browser previews, and Canvas clicks are transient tool inputs; interaction is governed by the Canvas and MCP policy rows.',
      action: 'Open Approvals',
      tab: 'approval-ledger'
    }
  ] satisfies SafetySurfaceRow[]).filter((row) => isSettingsTabVisible(row.tab))
  const updateKeyCommandOverrides = (next: AppSettings['keyCommandBindings']): void => {
    onChange({ keyCommandBindings: sanitizeKeyCommandOverrides(next) })
  }
  const resetKeyCommand = (commandId: KeyCommandId): void => {
    const next = { ...sanitizedKeyCommandOverrides }
    delete next[commandId]
    updateKeyCommandOverrides(next)
    setKeyCommandRecordError('')
    if (recordingKeyCommandId === commandId) setRecordingKeyCommandId(null)
  }
  const unassignKeyCommand = (commandId: KeyCommandId): void => {
    updateKeyCommandOverrides({ ...sanitizedKeyCommandOverrides, [commandId]: null })
    setKeyCommandRecordError('')
    if (recordingKeyCommandId === commandId) setRecordingKeyCommandId(null)
  }
  useEffect(() => {
    if (!recordingKeyCommandId) return
    const handleRecordingKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
        event.preventDefault()
        event.stopPropagation()
        setRecordingKeyCommandId(null)
        setKeyCommandRecordError('')
        return
      }
      const binding = bindingFromKeyboardEvent(event)
      if (!binding) return
      event.preventDefault()
      event.stopPropagation()
      const nextResolved = {
        ...resolveKeyCommandBindings(sanitizedKeyCommandOverrides),
        [recordingKeyCommandId]: binding
      }
      const conflict = findKeyCommandConflict(recordingKeyCommandId, binding, nextResolved)
      if (conflict) {
        setKeyCommandRecordError(`Already used by ${conflict.command}.`)
        return
      }
      updateKeyCommandOverrides({
        ...sanitizedKeyCommandOverrides,
        [recordingKeyCommandId]: binding
      })
      setRecordingKeyCommandId(null)
      setKeyCommandRecordError('')
    }
    window.addEventListener('keydown', handleRecordingKeyDown, true)
    return () => window.removeEventListener('keydown', handleRecordingKeyDown, true)
  }, [recordingKeyCommandId, sanitizedKeyCommandOverrides])
  const codexUsage = codexStatus?.codexUsage
  const codexUsageConfigured = Boolean(
    codexUsage?.configured ||
    codexUsage?.planType ||
    codexUsage?.userId ||
    (Array.isArray(codexUsage?.windows) && codexUsage.windows.length > 0) ||
    (Array.isArray(codexUsage?.balances) && codexUsage.balances.length > 0)
  )
  const handleLoadInstalledFonts = async (): Promise<void> => {
    const queryLocalFonts = (window as LocalFontWindow).queryLocalFonts
    if (!queryLocalFonts) {
      setInstalledFontStatus('Installed font discovery is not available in this runtime.')
      return
    }

    setInstalledFontStatus('Requesting local font access...')
    try {
      const fonts = await queryLocalFonts()
      const families = Array.from(
        new Set(
          fonts
            .map((font) => font.family || font.fullName || font.postscriptName || '')
            .map((name) => name.trim())
            .filter(Boolean)
        )
      )
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 160)

      setInstalledFontOptions(
        families.map((family) => ({
          label: family,
          value: quoteInstalledFontFamily(family)
        }))
      )
      setInstalledFontStatus(
        families.length > 0
          ? `${families.length} installed font families loaded.`
          : 'No installed font families were returned.'
      )
    } catch {
      setInstalledFontStatus('Local font access was denied or unavailable.')
    }
  }
  const updateAdvancedFx = (partial: Partial<AppSettings['advancedFx']>): void => {
    onChange({ advancedFx: { ...advancedFx, ...partial } })
  }
  const resolvedOllamaToolControlTier =
    ollamaToolControlTier === 'approved_edits' ||
    ollamaToolControlTier === 'approved_shell' ||
    ollamaToolControlTier === 'provider_parity'
      ? ollamaToolControlTier
      : 'read_only'
  const currentWorkspacePath = currentWorkspace?.path || ''
  const ollamaParityWorkspaceGrants = ollamaProviderParityWorkspaceGrants || {}
  const currentWorkspaceParityGranted = Boolean(
    currentWorkspacePath && ollamaParityWorkspaceGrants[currentWorkspacePath]
  )
  const currentWorkspaceLabel = currentWorkspace?.displayName || currentWorkspacePath || 'workspace'
  const ollamaCustomProfileCount = Object.keys(ollamaRunProfiles || {}).length
  const selectOllamaToolControlTier = (
    tier: NonNullable<AppSettings['ollamaToolControlTier']>
  ): void => {
    if (tier === 'provider_parity' && !currentWorkspaceParityGranted) {
      setShowOllamaParityAck(true)
      return
    }
    if (tier === resolvedOllamaToolControlTier) return
    onChange({ ollamaToolControlTier: tier })
  }
  const resolvedOllamaRunProfile =
    ollamaDefaultRunProfile === 'approved_patcher' ||
    ollamaDefaultRunProfile === 'verify_with_shell' ||
    ollamaDefaultRunProfile === 'provider_parity' ||
    ollamaDefaultRunProfile === 'custom'
      ? ollamaDefaultRunProfile
      : 'local_scout'
  const selectOllamaRunProfile = (
    profile: (typeof OLLAMA_RUN_PROFILE_OPTIONS)[number]
  ): void => {
    if (profile.tier === 'provider_parity' && !currentWorkspaceParityGranted) {
      setShowOllamaParityAck(true)
      return
    }
    onChange({
      ollamaDefaultRunProfile: profile.value,
      ollamaToolControlTier: profile.tier
    })
  }
  const confirmOllamaProviderParity = (): void => {
    if (!currentWorkspacePath) return
    const grantedAt = new Date().toISOString()
    setShowOllamaParityAck(false)
    onChange({
      ollamaDefaultRunProfile: 'provider_parity',
      ollamaToolControlTier: 'provider_parity',
      ollamaProviderParityAcknowledgedAt: ollamaProviderParityAcknowledgedAt || grantedAt,
      ollamaProviderParityWorkspaceGrants: {
        ...ollamaParityWorkspaceGrants,
        [currentWorkspacePath]: grantedAt
      }
    })
  }
  const revokeOllamaProviderParityForCurrentWorkspace = (): void => {
    if (!currentWorkspacePath) return
    const nextGrants = { ...ollamaParityWorkspaceGrants }
    delete nextGrants[currentWorkspacePath]
    onChange({
      ollamaToolControlTier:
        resolvedOllamaToolControlTier === 'provider_parity' ? 'read_only' : resolvedOllamaToolControlTier,
      ollamaProviderParityWorkspaceGrants: nextGrants
    })
  }
  const confirmDeleteAllChatHistory = async (): Promise<void> => {
    if (!onDeleteAllChatHistory || deleteHistoryPending) return
    setDeleteHistoryPending(true)
    setDeleteHistoryError('')
    try {
      await onDeleteAllChatHistory()
      setShowDeleteHistoryConfirm(false)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setDeleteHistoryError(message || 'Delete failed.')
    } finally {
      setDeleteHistoryPending(false)
    }
  }

  return (
    <div className={`settings-panel settings-panel-${layout}`}>
      {showOllamaParityAck &&
        createPortal(
          <div
            className="creative-approval-backdrop"
            role="presentation"
            onMouseDown={() => setShowOllamaParityAck(false)}
          >
            <div
              className="creative-approval-modal approval-elevation-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="ollama-parity-ack-title"
              data-elevation-tier="2"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <header className="creative-approval-modal-header">
                <span className="creative-approval-modal-eyebrow" aria-hidden>
                  Ollama provider parity
                </span>
                <h2 id="ollama-parity-ack-title" className="creative-approval-modal-title">
                  Enable full TaskWraith tools for Ollama?
                </h2>
              </header>
              <p className="creative-approval-modal-description">
                Tier 4 lets local Ollama models request the full TaskWraith tool surface for{' '}
                <strong>{currentWorkspaceLabel}</strong>. TaskWraith still enforces workspace
                boundaries, path checks, approval policy, and audit events, but local models can
                make poor or prompt-injected tool requests.
              </p>
              <p className="creative-approval-modal-description approval-elevation-caution">
                Use at your own risk. Keep this to test workspaces you can recover, and revoke it
                here per workspace.
              </p>
              {!currentWorkspacePath && (
                <p className="creative-approval-modal-description approval-elevation-caution">
                  Open a workspace before enabling provider parity for Ollama.
                </p>
              )}
              <footer className="creative-approval-modal-actions">
                <button
                  type="button"
                  className="creative-approval-modal-reject"
                  onClick={() => setShowOllamaParityAck(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="creative-approval-modal-approve-once"
                  onClick={confirmOllamaProviderParity}
                  disabled={!currentWorkspacePath}
                >
                  I understand, enable for this workspace
                </button>
              </footer>
            </div>
          </div>,
          document.body
        )}
      {showDeleteHistoryConfirm &&
        createPortal(
          <div
            className="creative-approval-backdrop"
            role="presentation"
            onMouseDown={() => {
              if (!deleteHistoryPending) setShowDeleteHistoryConfirm(false)
            }}
          >
            <div
              className="creative-approval-modal settings-delete-history-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="delete-history-title"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <header className="creative-approval-modal-header">
                <h2 id="delete-history-title" className="creative-approval-modal-title">
                  Are You Sure?
                </h2>
              </header>
              {deleteHistoryError && (
                <p className="creative-approval-modal-description approval-elevation-caution">
                  {deleteHistoryError}
                </p>
              )}
              <footer className="creative-approval-modal-actions">
                <button
                  type="button"
                  className="creative-approval-modal-reject"
                  onClick={() => setShowDeleteHistoryConfirm(false)}
                  disabled={deleteHistoryPending}
                >
                  No
                </button>
                <button
                  type="button"
                  className="creative-approval-modal-approve-once settings-delete-history-confirm"
                  onClick={() => void confirmDeleteAllChatHistory()}
                  disabled={deleteHistoryPending}
                >
                  {deleteHistoryPending ? 'Deleting...' : 'Yes'}
                </button>
              </footer>
            </div>
          </div>,
          document.body
        )}
      {/*
        Sticky header with inline tab bar + "Done" button. Suppressed
        in `takeover` layout because the host renders a SettingsSidebar
        next to this panel that carries the tab list AND the back-to-app
        affordance — duplicating it here would just clutter the chrome.
      */}
      {layout === 'sheet' && (
        <div className="settings-panel-header">
          <div className="settings-tab-bar">
            {visibleSettingsTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`settings-tab ${activeTab === tab.id ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <button className="btn btn-sm btn-ghost" onClick={onClose}>
            Done
          </button>
        </div>
      )}

      <div className="settings-panel-content">
        {/*
          Page title — only rendered in the full-app takeover layout
          (the legacy modal-sheet kept its tab bar with the active
          label highlighted, which served the same purpose). Big
          left-aligned heading at the top of the content area so the
          takeover reads as a real settings page rather than a sheet
          stretched into a sidebar. The label is sourced from
          `SETTINGS_TABS` so renaming a tab updates both the sidebar
          and the page title in lockstep.
        */}
        {layout === 'takeover' && (
          <h1 className="settings-takeover-title">
            {visibleSettingsTabs.find((tab) => tab.id === activeTab)?.label ?? 'Settings'}
          </h1>
        )}
        {/* ── Appearance ─────────────────────────────────── */}
        {
          activeTab === 'appearance' && (
            <>
              <div className="settings-group">
                <label className="settings-label">App icon</label>
                <div className="settings-option-grid settings-app-icon-grid">
                  {availableIconVariants(Date.now()).map((variant) => (
                    <button
                      key={variant.id}
                      type="button"
                      className={`settings-radio-option settings-app-icon-option ${appIconVariant === variant.id ? 'active' : ''}`}
                      onClick={() => onChange({ appIconVariant: variant.id })}
                      title={variant.description}
                    >
                      <img
                        className="settings-app-icon-swatch"
                        src={APP_ICON_THUMBS[variant.id]}
                        alt=""
                        draggable={false}
                      />
                      <span>{variant.label}</span>
                    </button>
                  ))}
                </div>
                <p className="settings-hint">
                  Swaps the icon in your Dock/taskbar while TaskWraith is running. The installed app
                  icon (Finder/Launchpad) is set when the app is built.
                </p>
              </div>

              <div className="settings-group">
                <label className="settings-label">System theme</label>
                <div className="settings-option-grid">
                  {THEME_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      className={`settings-radio-option settings-theme-option ${themeAppearance === option.value ? 'active' : ''}`}
                      onClick={() => onChange({ themeAppearance: option.value })}
                    >
                      <span className={`settings-radio-dot theme-dot theme-${option.value}`} />
                      <span>{option.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="settings-group">
                <label className="settings-label">Corners</label>
                <div className="settings-option-list settings-option-list-inline">
                  {(['rounded', 'hard'] as ThemeCornerStyle[]).map((option) => (
                    <button
                      key={option}
                      className={`settings-radio-option ${themeCornerStyle === option ? 'active' : ''}`}
                      onClick={() => onChange({ themeCornerStyle: option })}
                    >
                      <span className="settings-radio-dot" />
                      <span>{option === 'rounded' ? 'Rounded' : 'Hard'}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="settings-group">
                <label className="settings-label">Accent color</label>
                <div className="settings-option-grid">
                  {ACCENT_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      className={`settings-radio-option ${themeAccentStyle === option.value ? 'active' : ''}`}
                      onClick={() => onChange({ themeAccentStyle: option.value })}
                    >
                      <span className={`settings-radio-dot accent-dot accent-${option.value}`} />
                      <span>{option.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="settings-group">
                <label className="settings-label">Tool-icon color</label>
                <div className="settings-option-grid">
                  {TOOL_ICON_ACCENT_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      className={`settings-radio-option ${toolIconAccent === option.value ? 'active' : ''}`}
                      onClick={() => onChange({ toolIconAccent: option.value })}
                    >
                      <span
                        className={`settings-radio-dot tool-icon-accent-dot tool-icon-accent-${option.value}`}
                      />
                      <span>{option.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="settings-group">
                <label className="settings-label">Your chat bubble</label>
                <div className="settings-option-grid">
                  {USER_BUBBLE_COLOR_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      className={`settings-radio-option ${userBubbleColor === option.value ? 'active' : ''}`}
                      onClick={() => onChange({ userBubbleColor: option.value })}
                    >
                      <span
                        className={`settings-radio-dot user-bubble-color-dot user-bubble-color-${option.value}`}
                      />
                      <span>{option.label}</span>
                    </button>
                  ))}
                </div>
                <p className="settings-hint">
                  Tints your message bubble and the &quot;You&quot; label with the same hue.
                </p>
              </div>

              <div className="settings-group settings-composer-preview-group">
                <label className="settings-label">Composer Preview</label>
                <div className="settings-composer-preview-controls">
                  <div className="settings-field">
                    <span className="settings-field-label">Interface shell</span>
                    <select
                      className="settings-select"
                      value={composerStyle}
                      onChange={(e) => onChange({ composerStyle: e.target.value as ComposerStyle })}
                    >
                      {COMPOSER_STYLE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <p className="settings-hint">
                      {
                        COMPOSER_STYLE_OPTIONS.find((option) => option.value === composerStyle)
                          ?.helper
                      }
                    </p>
                  </div>

                  <div className="settings-field">
                    <span className="settings-field-label">Transcript font</span>
                    <select
                      className="settings-select"
                      value={transcriptFontSelectValue}
                      onChange={(e) => {
                        const value = e.target.value
                        onChange({
                          transcriptFontFamily:
                            value === CUSTOM_FONT_SELECT_VALUE
                              ? transcriptFontSelectValue === CUSTOM_FONT_SELECT_VALUE
                                ? transcriptFontFamily
                                : CUSTOM_FONT_FALLBACK
                              : value
                        })
                      }}
                    >
                      {TRANSCRIPT_FONT_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                      <option value={CUSTOM_FONT_SELECT_VALUE}>Custom...</option>
                      {installedFontOptions.length > 0 && (
                        <optgroup label="Installed fonts">
                          {installedFontOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                    {transcriptFontSelectValue === CUSTOM_FONT_SELECT_VALUE && (
                      <input
                        className="settings-input settings-font-custom-input"
                        value={transcriptFontFamily}
                        onChange={(e) => onChange({ transcriptFontFamily: e.target.value })}
                        placeholder='"Avenir Next", system-ui, sans-serif'
                      />
                    )}
                  </div>

                  <div className="settings-field">
                    <span className="settings-field-label">Composer font</span>
                    <select
                      className="settings-select"
                      value={composerFontSelectValue}
                      onChange={(e) => {
                        const value = e.target.value
                        onChange({
                          composerFontFamily:
                            value === CUSTOM_FONT_SELECT_VALUE
                              ? composerFontSelectValue === CUSTOM_FONT_SELECT_VALUE
                                ? composerFontFamily
                                : CUSTOM_FONT_FALLBACK
                              : value
                        })
                      }}
                    >
                      {COMPOSER_FONT_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                      <option value={CUSTOM_FONT_SELECT_VALUE}>Custom...</option>
                      {installedFontOptions.length > 0 && (
                        <optgroup label="Installed fonts">
                          {installedFontOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                    {composerFontSelectValue === CUSTOM_FONT_SELECT_VALUE && (
                      <input
                        className="settings-input settings-font-custom-input"
                        value={composerFontFamily}
                        onChange={(e) => onChange({ composerFontFamily: e.target.value })}
                        placeholder='"Avenir Next", system-ui, sans-serif'
                      />
                    )}
                  </div>
                </div>
                <div className="settings-font-actions">
                  <button
                    className="btn btn-sm btn-ghost"
                    type="button"
                    disabled={!canLoadInstalledFonts}
                    onClick={() => void handleLoadInstalledFonts()}
                  >
                    Load installed fonts
                  </button>
                  <span className="settings-font-status">
                    {installedFontStatus ||
                      (canLoadInstalledFonts
                        ? 'Optional local font permission.'
                        : 'Installed font discovery unavailable; custom CSS font-family still works.')}
                  </span>
                </div>

                <ComposerShellPreview
                  composerStyle={composerStyle}
                  themeAppearance={themeAppearance}
                  transcriptFontFamily={transcriptFontFamily}
                  composerFontFamily={composerFontFamily}
                  editable
                  value={composerPreviewText}
                  onValueChange={setComposerPreviewText}
                />
              </div>

              <div className="settings-group settings-effects-material span-all">
                <label className="settings-label">Effects &amp; Material</label>
                <div className="settings-effects-grid">
                  <section className="settings-effects-card">
                    <span className="settings-field-label">Window material</span>
                    <div className="settings-option-list settings-option-list-inline">
                      {(['solid', 'soft_glass', 'native_glass'] as AppearanceMode[]).map((m) => (
                        <button
                          key={m}
                          className={`btn btn-sm ${mode === m ? '' : 'btn-ghost'}`}
                          onClick={() => onChange({ mode: m })}
                        >
                          {m === 'soft_glass'
                            ? 'Soft Glass'
                            : m === 'native_glass'
                              ? 'Native Glass'
                              : 'Solid'}
                        </button>
                      ))}
                    </div>
                  </section>

                  <section className="settings-effects-card">
                    <span className="settings-field-label">Pane opacity</span>
                    <label className="settings-effects-field">
                      <span className="settings-field-label">
                        Sidebar
                        <span style={{ marginLeft: 'var(--space-sm)', opacity: 0.7 }}>
                          {sidebarOpacityValue}%
                        </span>
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={sidebarOpacityValue}
                        onChange={(e) =>
                          onChange({
                            sidebarOpacity: clampPaneOpacity(e.target.value),
                            sidebarOpacityOverride: true
                          })
                        }
                        style={{ width: '100%' }}
                      />
                    </label>
                    <label className="settings-effects-field">
                      <span className="settings-field-label">
                        Main pane
                        <span style={{ marginLeft: 'var(--space-sm)', opacity: 0.7 }}>
                          {mainPaneOpacityValue}%
                        </span>
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={mainPaneOpacityValue}
                        onChange={(e) =>
                          onChange({
                            mainPaneOpacity: clampPaneOpacity(e.target.value),
                            mainPaneOpacityOverride: true
                          })
                        }
                        style={{ width: '100%' }}
                      />
                    </label>
                  </section>

                  <section className="settings-effects-card">
                    <span className="settings-field-label">Glass style</span>
                    <div className="settings-option-list settings-effects-radio-list">
                      {VISUAL_EFFECT_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          className={`settings-radio-option ${visualEffectStyle === option.value ? 'active' : ''}`}
                          onClick={() => onChange({ visualEffectStyle: option.value })}
                        >
                          <span className="settings-radio-dot" />
                          <span>{option.label}</span>
                        </button>
                      ))}
                    </div>
                  </section>

                  <section className="settings-effects-card">
                    <span className="settings-field-label">Accessibility</span>
                    <div className="settings-effects-toggle-list">
                      <label className="settings-effects-check-row">
                        <input
                          type="checkbox"
                          checked={reduceTransparency}
                          onChange={(e) => onChange({ reduceTransparency: e.target.checked })}
                        />
                        <span>
                          Reduce transparency
                          <small>
                            Disables glass effects for better readability and battery life.
                          </small>
                        </span>
                      </label>
                      <label className="settings-effects-check-row">
                        <input
                          type="checkbox"
                          checked={reduceMotion}
                          onChange={(e) => onChange({ reduceMotion: e.target.checked })}
                        />
                        <span>
                          Reduce motion
                          <small>Minimizes animations for accessibility.</small>
                        </span>
                      </label>
                    </div>
                  </section>

                  <section className="settings-effects-card">
                    <span className="settings-field-label">Density</span>
                    <label className="settings-effects-check-row">
                      <input
                        type="checkbox"
                        checked={compactDensity}
                        onChange={(e) => onChange({ compactDensity: e.target.checked })}
                      />
                      <span>
                        Compact density
                        <small>Tighter spacing throughout the interface.</small>
                      </span>
                    </label>
                    <label className="settings-effects-check-row">
                      <input
                        type="checkbox"
                        checked={liveActivityViewport}
                        onChange={(e) => onChange({ liveActivityViewport: e.target.checked })}
                      />
                      <span>
                        Live activity viewport
                        <small>
                          Stream thinking &amp; tool activity in a compact auto-scrolling panel
                          while the agent works.
                        </small>
                      </span>
                    </label>
                    <label className="settings-effects-field">
                      <span className="settings-field-label">Prompt bubble</span>
                      <select
                        className="settings-select"
                        value={promptSurfaceStyle}
                        onChange={(e) =>
                          onChange({ promptSurfaceStyle: e.target.value as PromptSurfaceStyle })
                        }
                      >
                        {PROMPT_SURFACE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </section>

                  <section className="settings-effects-card">
                    <label className="settings-effects-check-row settings-effects-primary-toggle">
                      <input
                        type="checkbox"
                        checked={funFxEnabled}
                        onChange={(e) => onChange({ funFxEnabled: e.target.checked })}
                      />
                      <span>
                        Epic FX
                        <small>
                          {funFxMode === 'off'
                            ? 'Epic FX disabled.'
                            : FUN_FX_MODES.find((option) => option.value === funFxMode)?.helper ||
                              FUN_FX_MODES[2].helper}
                        </small>
                      </span>
                    </label>
                    <div className="settings-option-list settings-option-list-inline">
                      {FUN_FX_MODES.map((option) => (
                        <button
                          key={option.value}
                          className={`btn btn-sm ${funFxMode === option.value ? '' : 'btn-ghost'}`}
                          onClick={() => onChange({ funFxMode: option.value })}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </section>

                  <section className="settings-effects-card settings-fx-labs settings-effects-labs">
                    <div className="settings-effects-section-header">
                      <span className="settings-field-label">FX Labs</span>
                      <p className="settings-hint">
                        Opt-in visual layers for agent ambience, workspace atmosphere, and live run
                        telemetry. Disabled automatically when Reduce motion is enabled.
                      </p>
                    </div>
                    <div className="settings-effects-labs-grid">
                      <label className="settings-service-row settings-fx-toggle">
                        <span>
                          Agent Aura
                          <small>
                            Composer rims, inspector edges, sidebar highlights, and run-state
                            bursts.
                          </small>
                        </span>
                        <input
                          type="checkbox"
                          checked={!reduceMotion && funFxEnabled && advancedFx.agentAura}
                          disabled={reduceMotion || !funFxEnabled}
                          onChange={(e) => updateAdvancedFx({ agentAura: e.target.checked })}
                        />
                      </label>
                      <label className="settings-service-row settings-fx-toggle">
                        <span>
                          Living Workspace
                          <small>
                            Extends Sky/Weather with neutral parallax depth, floating motes, and
                            weather particles.
                          </small>
                        </span>
                        <input
                          type="checkbox"
                          checked={!reduceMotion && funFxEnabled && advancedFx.livingWorkspace}
                          disabled={reduceMotion || !funFxEnabled}
                          onChange={(e) => updateAdvancedFx({ livingWorkspace: e.target.checked })}
                        />
                      </label>
                      <label className="settings-service-row settings-fx-toggle">
                        <span>
                          Data Viz FX
                          <small>
                            Lightweight SVG overlays for token flow, queue lanes, tool pulses,
                            approvals, and progress.
                          </small>
                        </span>
                        <input
                          type="checkbox"
                          checked={!reduceMotion && funFxEnabled && advancedFx.dataViz}
                          disabled={reduceMotion || !funFxEnabled}
                          onChange={(e) => updateAdvancedFx({ dataViz: e.target.checked })}
                        />
                      </label>
                      <label className="settings-service-row settings-fx-toggle">
                        <span>
                          Refractive glass (experimental)
                          <small>
                            Refractive liquid-glass material on the composer, pickers and
                            panels — replaces flat frost with a light-bending sheen + rim.
                            Independent of Advanced FX; respects Reduce Transparency.
                          </small>
                        </span>
                        <input
                          type="checkbox"
                          checked={!reduceTransparency && advancedFx.refraction}
                          disabled={reduceTransparency}
                          onChange={(e) => updateAdvancedFx({ refraction: e.target.checked })}
                        />
                      </label>
                    </div>
                    <div className="settings-option-list settings-option-list-inline">
                      {FUN_FX_MODES.filter((option) => option.value !== 'off').map((option) => (
                        <button
                          key={option.value}
                          className={`btn btn-sm ${advancedFx.intensity === option.value ? '' : 'btn-ghost'}`}
                          disabled={reduceMotion || !funFxEnabled}
                          onClick={() =>
                            updateAdvancedFx({
                              intensity: option.value as AppSettings['advancedFx']['intensity']
                            })
                          }
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                    <p className="settings-hint">
                      {reduceMotion
                        ? 'Reduce motion is active, so FX Labs animations stay off.'
                        : funFxEnabled
                          ? `${advancedFx.intensity} intensity; subtle favors CSS-only ambience, epic adds denser particles and telemetry.`
                          : 'Turn on Epic FX to enable FX Labs layers.'}
                    </p>
                  </section>
                </div>
              </div>
            </>
          ) /* end appearance */
        }

        {/* ── Behavior ─────────────────────────────────── */}
        {
          activeTab === 'behavior' && (
            <>
              <div className="settings-group">
                <label className="settings-label">Your name</label>
                <CommittedDraftField
                  className="settings-select"
                  committed={userName}
                  onCommit={(value) => onChange({ userName: value })}
                  placeholder="e.g. Chris — used to greet you in General chats"
                />
                <p className="settings-hint">
                  Shown in the New General Chat greeting. Leave blank to omit.
                </p>
              </div>
              <div className="settings-group">
                <label
                  className="settings-label"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-sm)',
                    cursor: 'pointer'
                  }}
                >
                  <input
                    type="checkbox"
                    checked={geminiCheckpointingEnabled}
                    onChange={(e) => onChange({ geminiCheckpointingEnabled: e.target.checked })}
                  />
                  Gemini checkpointing
                </label>
                <p className="settings-hint">
                  Starts new Gemini CLI runs and persistent sessions with --checkpointing. Restart
                  an active persistent session to apply changes.
                </p>
              </div>

              <div className="settings-group">
                <label className="settings-label">Conversation context turns</label>
                <select
                  className="settings-select"
                  value={boundedTurns}
                  onChange={(e) => onChange({ chatContextTurns: Number(e.target.value) })}
                >
                  {CONTEXT_TURN_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
                <p className="settings-hint">
                  Max recent user/assistant turns to include with each prompt for continuity. 0
                  sends only the current message.
                </p>
              </div>

              {/*
                1.0.5-EW25 — Display currency for cost / token-spend
                chips. Providers report cost in USD; the renderer
                converts to the user's chosen currency via
                `formatCost.ts`. Rates are static approximations —
                live FX lookup is deferred to 1.0.6 sub-slice c.
              */}
              <div className="settings-group">
                <label className="settings-label">Display currency</label>
                <select
                  className="settings-select"
                  value={currency ?? 'USD'}
                  onChange={(e) => onChange({ currency: e.target.value as 'USD' | 'GBP' | 'EUR' })}
                >
                  <option value="USD">US Dollar (USD)</option>
                  <option value="GBP">British Pound (GBP)</option>
                  <option value="EUR">Euro (EUR)</option>
                </select>
                <p className="settings-hint">
                  Used for cost displays on per-participant chips and the chat-level cumulative
                  tally. Provider pricing is sampled in USD and converted at display time.
                </p>
              </div>

              <div className="settings-group">
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 'var(--space-sm)'
                  }}
                >
                  <label className="settings-label">Exchange rates</label>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => void refreshExchangeRates()}
                    disabled={fxRefreshing}
                  >
                    {fxRefreshing ? 'Refreshing...' : 'Refresh exchange rates'}
                  </button>
                </div>
                <p className="settings-hint">
                  Confidence: {fxConfidenceLabel(fxSnapshot?.source)}. Last updated:{' '}
                  {formatFxUpdatedAt(fxSnapshot)}. GBP {formatFxRate(fxSnapshot, 'GBP')}; EUR{' '}
                  {formatFxRate(fxSnapshot, 'EUR')}.
                </p>
                {fxError && (
                  <p className="settings-error" style={{ margin: 0 }}>
                    Refresh failed: {fxError}
                  </p>
                )}
              </div>

              {/*
                1.0.5-EW34 — Currency sub-slice (e): conservative-
                overestimate bias. Slider 0–25%. When non-zero, every
                cost display is multiplied by `1 + percent/100` BEFORE
                FX conversion, so displayed cost over-shoots the real
                bill by exactly that bias. Useful for users who want
                their on-screen running total to be a safe upper
                bound rather than the literal billed amount. Slider
                bounds match `OVERESTIMATE_PERCENT_MAX` in formatCost.
              */}
              <div className="settings-group">
                <label className="settings-label">
                  Conservative overestimate
                  <span style={{ marginLeft: 'var(--space-sm)', opacity: 0.7 }}>
                    {`+${Math.max(0, Math.min(25, currencyOverestimatePercent ?? 0))}%`}
                  </span>
                </label>
                <input
                  type="range"
                  min={0}
                  max={25}
                  step={1}
                  value={Math.max(0, Math.min(25, currencyOverestimatePercent ?? 0))}
                  onChange={(e) =>
                    onChange({
                      currencyOverestimatePercent: Math.max(
                        0,
                        Math.min(25, Number(e.target.value) || 0)
                      )
                    })
                  }
                  style={{ width: '100%' }}
                />
                <p className="settings-hint">
                  {(currencyOverestimatePercent ?? 0) > 0
                    ? `+${currencyOverestimatePercent ?? 0}% safety bias applied to all cost displays. Useful when you want the on-screen running total to safely over-shoot the real bill.`
                    : 'Optional. Multiplies every cost display by 1 + your chosen percent (0–25%) so the displayed running total is a safe upper bound rather than the literal billed amount. Defaults to 0 (no bias).'}
                </p>
              </div>

              <div className="settings-group">
                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={showRunCompleteSummary !== false}
                    onChange={(e) => onChange({ showRunCompleteSummary: e.target.checked })}
                  />
                  <span>Show Task Complete summary cards</span>
                </label>
                <p className="settings-hint">
                  Controls the Final Summary / Task Complete section after a run finishes. Turning
                  this off hides the completion card while keeping the transcript and run telemetry.
                </p>
              </div>

              <div className="settings-group">
                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={ensembleCollapseOlderRounds !== false}
                    onChange={(e) => onChange({ ensembleCollapseOlderRounds: e.target.checked })}
                  />
                  <span>Collapse older Ensemble rounds</span>
                </label>
                <p className="settings-hint">
                  In Ensemble chats, fold completed rounds into compact, expandable round cards (the
                  most recent and any in-progress round stay open). Click a round card to reveal its
                  full transcript. Turn this off to always show every round expanded, like the
                  classic flat transcript.
                </p>
              </div>

              {/*
                Welcome standalone heatmaps. Defaults are visible
                for all three; each toggle only controls the
                new-chat welcome-screen heatmap stack under the
                composer, not sidebar model usage.
              */}
              <div className="settings-group settings-dashboard-stats">
                <label className="settings-label">Welcome activity heatmaps</label>
                <p className="settings-hint">
                  Toggle the standalone 90-day heatmaps shown underneath the composer on new chat
                  welcome screens. The welcome screen cycles through enabled panels one at a time;
                  sidebar activity stays unchanged.
                </p>
                <ul className="settings-dashboard-stats-list">
                  {[
                    {
                      key: 'workspaceActivityEnabled' as const,
                      label: 'Workspace Activity',
                      description: 'Git and filesystem activity for the selected workspace.'
                    },
                    {
                      key: 'taskwraithActivityEnabled' as const,
                      label: 'TaskWraith Activity',
                      description: 'Usage recorded inside TaskWraith chats.'
                    },
                    {
                      key: 'externalActivityEnabled' as const,
                      label: 'External Activity',
                      description: 'Usage imported from local provider telemetry.'
                    }
                  ].map((heatmap) => {
                    const enabled = welcomeHeatmapPrefs?.[heatmap.key] !== false
                    return (
                      <li key={heatmap.key} className="settings-dashboard-stats-row">
                        <span className="settings-dashboard-stats-name">
                          {heatmap.label}
                          <small>{heatmap.description}</small>
                        </span>
                        <label className="settings-toggle">
                          <input
                            type="checkbox"
                            checked={enabled}
                            onChange={(e) => {
                              onChange({
                                welcomeHeatmapPrefs: {
                                  ...(welcomeHeatmapPrefs || {}),
                                  [heatmap.key]: e.target.checked
                                }
                              })
                            }}
                          />
                          <span className="settings-toggle-label">
                            {enabled ? 'Visible' : 'Hidden'}
                          </span>
                        </label>
                      </li>
                    )
                  })}
                </ul>
              </div>

              {/*
                1.0.5-EW49 — Dashboard statistics controls. Lists
                every chip in the welcome dashboard's dense stat
                grid (12 total, grouped by family) with a per-
                stat show/hide toggle, plus a single "Reset all
                dashboard stats" action at the bottom. Per-stat
                reset deferred to a future EW49b — the global
                reset covers the main user intent ("zero my
                dashboard back to today") without the invasive
                builder threading per-stat reset would need.
              */}
              <div className="settings-group settings-dashboard-stats">
                <label className="settings-label">Dashboard statistics</label>
                <p className="settings-hint">
                  Toggle which chips appear in the welcome dashboard&apos;s stat grid. Hidden chips
                  stay tracked in the background — re-enable any time to see their data again.
                </p>
                <ul className="settings-dashboard-stats-list">
                  <li className="settings-dashboard-stats-row">
                    <span className="settings-dashboard-stats-name">
                      Show welcome dashboard
                      <small>
                        Hide the entire Statistics card on the new-chat welcome screen. The
                        standalone heatmaps are unaffected.
                      </small>
                    </span>
                    <label className="settings-toggle">
                      <input
                        type="checkbox"
                        checked={dashboardStatPrefs?.dashboardEnabled !== false}
                        onChange={(e) =>
                          onChange({
                            dashboardStatPrefs: {
                              ...(dashboardStatPrefs || {}),
                              dashboardEnabled: e.target.checked
                            }
                          })
                        }
                      />
                      <span className="settings-toggle-label">
                        {dashboardStatPrefs?.dashboardEnabled !== false ? 'Visible' : 'Hidden'}
                      </span>
                    </label>
                  </li>
                </ul>
                {(['calendar', 'duration', 'volume', 'spend'] as const).map((group) => {
                  const stats = getDashboardStatsByGroup(group)
                  if (stats.length === 0) return null
                  const groupLabel =
                    group === 'calendar'
                      ? 'Calendar'
                      : group === 'duration'
                        ? 'Duration'
                        : group === 'volume'
                          ? 'Volume'
                          : 'Spend'
                  return (
                    <div key={group} className="settings-dashboard-stats-group">
                      <div className="settings-dashboard-stats-group-label">{groupLabel}</div>
                      <ul className="settings-dashboard-stats-list">
                        {stats.map((stat) => {
                          const visible = isDashboardStatVisible(
                            dashboardStatPrefs?.visibility,
                            stat.key
                          )
                          return (
                            <li key={stat.key} className="settings-dashboard-stats-row">
                              <span className="settings-dashboard-stats-name">{stat.label}</span>
                              <label className="settings-toggle">
                                <input
                                  type="checkbox"
                                  checked={visible}
                                  onChange={(e) => {
                                    const nextVisibility = {
                                      ...(dashboardStatPrefs?.visibility || {}),
                                      [stat.key]: e.target.checked
                                    }
                                    onChange({
                                      dashboardStatPrefs: {
                                        ...(dashboardStatPrefs || {}),
                                        visibility: nextVisibility
                                      }
                                    })
                                  }}
                                />
                                <span className="settings-toggle-label">
                                  {visible ? 'Visible' : 'Hidden'}
                                </span>
                              </label>
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  )
                })}
                <div className="settings-dashboard-stats-reset">
                  <button
                    type="button"
                    className="settings-button settings-button-danger"
                    onClick={() => {
                      if (
                        typeof window !== 'undefined' &&
                        typeof window.confirm === 'function' &&
                        !window.confirm(
                          'Reset all dashboard stats? This zeroes every chip back to today — older history is filtered out of future computations. Visibility is unchanged.'
                        )
                      ) {
                        return
                      }
                      onChange({
                        dashboardStatPrefs: {
                          ...(dashboardStatPrefs || {}),
                          resetAt: Date.now()
                        }
                      })
                    }}
                  >
                    Reset all dashboard stats
                  </button>
                  {dashboardStatPrefs?.resetAt && dashboardStatPrefs.resetAt > 0 && (
                    <span className="settings-hint settings-dashboard-stats-reset-hint">
                      Stats currently filtered to records on or after{' '}
                      {new Date(dashboardStatPrefs.resetAt).toLocaleString()}.{' '}
                      <button
                        type="button"
                        className="settings-button settings-button-link"
                        onClick={() => {
                          onChange({
                            dashboardStatPrefs: {
                              ...(dashboardStatPrefs || {}),
                              resetAt: 0
                            }
                          })
                        }}
                      >
                        Clear reset
                      </button>
                    </span>
                  )}
                </div>
                {/*
                  EW49b roadmap note: per-stat reset (one button
                  per stat) would replace the single timestamp
                  with a `Record<string, number>`. Defer until
                  the builder supports per-stat filtering — see
                  the EW49 CHANGELOG entry for the deferral
                  rationale.
                */}
                {/*
                  1.0.5-EW51 — Workspaces tab controls. The
                  third dashboard tab gets a visibility toggle +
                  max-cards-shown slider here so the user can
                  hide it entirely or trim the scroll list when
                  they have lots of workspaces. Defaults: tab
                  visible (`undefined`/`true`), 8 cards.
                */}
                <div className="settings-dashboard-stats-group settings-dashboard-workspaces-group">
                  <div className="settings-dashboard-stats-group-label">Workspaces tab</div>
                  <ul className="settings-dashboard-stats-list">
                    <li className="settings-dashboard-stats-row">
                      <span className="settings-dashboard-stats-name">Show Workspaces tab</span>
                      <label className="settings-toggle">
                        <input
                          type="checkbox"
                          checked={dashboardStatPrefs?.workspacesTabEnabled !== false}
                          onChange={(e) => {
                            onChange({
                              dashboardStatPrefs: {
                                ...(dashboardStatPrefs || {}),
                                workspacesTabEnabled: e.target.checked
                              }
                            })
                          }}
                        />
                        <span className="settings-toggle-label">
                          {dashboardStatPrefs?.workspacesTabEnabled !== false
                            ? 'Visible'
                            : 'Hidden'}
                        </span>
                      </label>
                    </li>
                  </ul>
                  <label className="settings-label settings-dashboard-workspaces-shown-label">
                    Workspaces shown
                    <span style={{ marginLeft: 'var(--space-sm)', opacity: 0.7 }}>
                      {Math.max(
                        4,
                        Math.min(20, Number(dashboardStatPrefs?.workspacesShown ?? 8) || 8)
                      )}
                    </span>
                  </label>
                  <input
                    type="range"
                    min={4}
                    max={20}
                    step={1}
                    value={Math.max(
                      4,
                      Math.min(20, Number(dashboardStatPrefs?.workspacesShown ?? 8) || 8)
                    )}
                    onChange={(e) => {
                      const next = Math.max(4, Math.min(20, Number(e.target.value) || 8))
                      onChange({
                        dashboardStatPrefs: {
                          ...(dashboardStatPrefs || {}),
                          workspacesShown: next
                        }
                      })
                    }}
                    style={{ width: '100%' }}
                    aria-label="Maximum workspace cards shown on the Workspaces tab"
                  />
                  <p className="settings-hint">
                    The Workspaces tab shows up to this many workspace cost cards (scrollable when
                    there are more). Defaults to 8; clamped 4–20.
                  </p>
                </div>
                {/*
                  1.0.5-EW52 — Providers tab + auto-cycle controls.
                  The fourth dashboard tab (per-provider token /
                  cost cards + giant 24H wall-time timecode) gets
                  the same visibility toggle as Workspaces. Below
                  it, an auto-cycle slider rotates through enabled
                  tabs every N seconds while a welcome screen is
                  mounted. Defaults: Providers visible, auto-cycle
                  on at 180s (3 min). Auto-cycle 0 disables the
                  loop entirely.
                */}
                <div className="settings-dashboard-stats-group settings-dashboard-providers-group">
                  <div className="settings-dashboard-stats-group-label">Providers tab</div>
                  <ul className="settings-dashboard-stats-list">
                    <li className="settings-dashboard-stats-row">
                      <span className="settings-dashboard-stats-name">Show Providers tab</span>
                      <label className="settings-toggle">
                        <input
                          type="checkbox"
                          checked={dashboardStatPrefs?.providersTabEnabled !== false}
                          onChange={(e) => {
                            onChange({
                              dashboardStatPrefs: {
                                ...(dashboardStatPrefs || {}),
                                providersTabEnabled: e.target.checked
                              }
                            })
                          }}
                        />
                        <span className="settings-toggle-label">
                          {dashboardStatPrefs?.providersTabEnabled !== false ? 'Visible' : 'Hidden'}
                        </span>
                      </label>
                    </li>
                  </ul>
                  {(() => {
                    // Auto-cycle resolved value: undefined → 180s default.
                    // 0 → user explicitly disabled. Anything else clamps
                    // to 30–600 for the slider (the dashboard side
                    // accepts up to 3600 if the user edits settings
                    // JSON directly, but the slider UI tops out at
                    // 10 minutes — auto-cycling slower than that
                    // feels indistinguishable from manual).
                    const raw = dashboardStatPrefs?.autoCycleSeconds
                    const resolved = raw === undefined ? 180 : Math.max(0, Number(raw) || 0)
                    const cycleEnabled = resolved > 0
                    const sliderValue = cycleEnabled ? Math.max(30, Math.min(600, resolved)) : 180
                    return (
                      <>
                        <ul className="settings-dashboard-stats-list">
                          <li className="settings-dashboard-stats-row">
                            <span className="settings-dashboard-stats-name">
                              Auto-cycle dashboard tabs
                            </span>
                            <label className="settings-toggle">
                              <input
                                type="checkbox"
                                checked={cycleEnabled}
                                onChange={(e) => {
                                  onChange({
                                    dashboardStatPrefs: {
                                      ...(dashboardStatPrefs || {}),
                                      autoCycleSeconds: e.target.checked ? sliderValue : 0
                                    }
                                  })
                                }}
                              />
                              <span className="settings-toggle-label">
                                {cycleEnabled ? 'On' : 'Off'}
                              </span>
                            </label>
                          </li>
                        </ul>
                        {cycleEnabled && (
                          <>
                            <label className="settings-label settings-dashboard-providers-cycle-label">
                              Cycle every
                              <span style={{ marginLeft: 'var(--space-sm)', opacity: 0.7 }}>
                                {sliderValue >= 60
                                  ? `${Math.floor(sliderValue / 60)}m${
                                      sliderValue % 60 > 0 ? ` ${sliderValue % 60}s` : ''
                                    }`
                                  : `${sliderValue}s`}
                              </span>
                            </label>
                            <input
                              type="range"
                              min={30}
                              max={600}
                              step={30}
                              value={sliderValue}
                              onChange={(e) => {
                                const next = Math.max(
                                  30,
                                  Math.min(600, Number(e.target.value) || 180)
                                )
                                onChange({
                                  dashboardStatPrefs: {
                                    ...(dashboardStatPrefs || {}),
                                    autoCycleSeconds: next
                                  }
                                })
                              }}
                              style={{ width: '100%' }}
                              aria-label="Dashboard tab auto-cycle interval in seconds"
                            />
                          </>
                        )}
                      </>
                    )
                  })()}
                  <p className="settings-hint">
                    While a welcome screen is open, the dashboard rotates through visible tabs at
                    this cadence. Background chats don&apos;t cycle. Defaults to 3 minutes; range 30
                    seconds – 10 minutes.
                  </p>
                </div>
              </div>

              {/*
                1.0.5-EW26 — Kimi (Moonshot) compatibility filter.
                On by default. Ensemble-mode Kimi
                participants get their prompt context scanned by
                `src/main/lib/kimiSanitiser.ts` before spawn:
                sentences containing curated trigger keywords
                (Tiananmen, Xinjiang, Hong Kong protests, US-China
                relations, etc.) are replaced with a redacted
                placeholder so Kimi can still participate without
                triggering Moonshot's content_filter rejection.
                Other participants always see the unfiltered prompt.
              */}
              <div className="settings-group">
                <label
                  className="settings-label"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-sm)',
                    cursor: 'pointer'
                  }}
                >
                  <input
                    type="checkbox"
                    checked={Boolean(kimiSanitiserEnabled)}
                    onChange={(e) => onChange({ kimiSanitiserEnabled: e.target.checked })}
                  />
                  Kimi compatibility filter (Moonshot)
                </label>
                <p className="settings-hint">
                  When enabled, prompts dispatched to Kimi participants in ensemble chats are
                  pre-scanned and any sentence containing a known Moonshot-rejected topic
                  (Tiananmen, Xinjiang, Hong Kong protests, Tibet sovereignty, Taiwan independence,
                  Falun Gong, US-China relations summaries, etc.) is replaced with a redacted
                  placeholder so Kimi can still participate. Other panelists always see the
                  unfiltered prompt. Your transcript is never modified — only Kimi&apos;s view. A
                  diagnostic note appears whenever the filter fires.
                </p>
                <label
                  className="settings-label"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-sm)',
                    cursor: 'pointer',
                    marginTop: 'var(--space-sm)'
                  }}
                >
                  <input
                    type="checkbox"
                    checked={kimiClassifierEnabled}
                    onChange={(e) => updateKimiClassifierEnabled(e.target.checked)}
                  />
                  Kimi classifier retry pass
                </label>
                <p className="settings-hint">
                  When enabled, Kimi content-filter retries can escalate from keyword redaction to a
                  local sentence classifier. Current state: {kimiClassifierStatus}. If disabled or
                  unavailable, retries stay keyword-only and the failure diagnostic says so.
                </p>
                <label className="settings-label" style={{ marginTop: 'var(--space-sm)' }}>
                  Custom triggers (one per line)
                </label>
                <CommittedDraftField
                  as="textarea"
                  className="settings-textarea"
                  committed={kimiSanitiserCustomKeywords ?? ''}
                  onCommit={(value) => onChange({ kimiSanitiserCustomKeywords: value })}
                  placeholder={
                    '# Add phrases you have seen trigger Moonshot rejection.\n# Lines starting with # are comments.\n# Example:\nSouth China Sea\nNine Dash Line'
                  }
                  rows={4}
                  disabled={!kimiSanitiserEnabled}
                  style={{
                    width: '100%',
                    resize: 'vertical',
                    fontFamily: 'var(--font-mono, monospace)',
                    fontSize: 'var(--font-size-xs)'
                  }}
                />
                <p className="settings-hint">
                  Added on top of the curated default list. Case-insensitive substring match, one
                  phrase per line. Lines starting with <code>#</code> are comments.
                </p>
              </div>

              {/* ── Approval timeouts (Phase E1.1) ────────────────────────── */}
              <div className="settings-group">
                <label
                  className="settings-label"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-sm)',
                    cursor: 'pointer'
                  }}
                >
                  <input
                    type="checkbox"
                    checked={approvalTimeouts.enabled}
                    onChange={(e) =>
                      onChange({
                        approvalTimeouts: { ...approvalTimeouts, enabled: e.target.checked }
                      })
                    }
                  />
                  Auto-deny approvals after a timeout
                </label>
                <p className="settings-hint">
                  When enabled, approvals sitting unanswered (in the desktop modal or on a paired
                  iPhone) are automatically declined after the per-provider window below. Disable
                  for hands-off testing, where the run should block indefinitely.
                </p>
              </div>

              <div className="settings-group">
                <label className="settings-label">Timeout windows (seconds)</label>
                <div className="approval-timeout-grid">
                  <ApprovalTimeoutField
                    label="Gemini"
                    valueMs={approvalTimeouts.perProviderMs.gemini}
                    disabled={!approvalTimeouts.enabled}
                    onChange={(ms) =>
                      onChange({
                        approvalTimeouts: {
                          ...approvalTimeouts,
                          perProviderMs: { ...approvalTimeouts.perProviderMs, gemini: ms }
                        }
                      })
                    }
                  />
                  <ApprovalTimeoutField
                    label="Codex"
                    valueMs={approvalTimeouts.perProviderMs.codex}
                    disabled={!approvalTimeouts.enabled}
                    onChange={(ms) =>
                      onChange({
                        approvalTimeouts: {
                          ...approvalTimeouts,
                          perProviderMs: { ...approvalTimeouts.perProviderMs, codex: ms }
                        }
                      })
                    }
                  />
                  <ApprovalTimeoutField
                    label="Claude"
                    valueMs={approvalTimeouts.perProviderMs.claude}
                    disabled={!approvalTimeouts.enabled}
                    onChange={(ms) =>
                      onChange({
                        approvalTimeouts: {
                          ...approvalTimeouts,
                          perProviderMs: { ...approvalTimeouts.perProviderMs, claude: ms }
                        }
                      })
                    }
                  />
                  <ApprovalTimeoutField
                    label="Kimi"
                    valueMs={approvalTimeouts.perProviderMs.kimi}
                    disabled={!approvalTimeouts.enabled}
                    onChange={(ms) =>
                      onChange({
                        approvalTimeouts: {
                          ...approvalTimeouts,
                          perProviderMs: { ...approvalTimeouts.perProviderMs, kimi: ms }
                        }
                      })
                    }
                  />
                  <ApprovalTimeoutField
                    label="Main authority"
                    valueMs={approvalTimeouts.mainAuthorityMs}
                    disabled={!approvalTimeouts.enabled}
                    onChange={(ms) =>
                      onChange({ approvalTimeouts: { ...approvalTimeouts, mainAuthorityMs: ms } })
                    }
                  />
                </div>
                <p className="settings-hint">
                  Per-provider deadline before an unanswered approval is auto-denied. Defaults
                  (Codex 30s, Claude/Gemini 120s, Kimi 60s, Main 60s) reflect how tolerant each
                  runtime is of paused tool calls — Codex sandbox commands hang faster than
                  long-think Claude prompts.
                </p>
              </div>
            </>
          ) /* end behavior */
        }

        {/* ── Providers ─────────────────────────────────── */}
        {
          activeTab === 'providers' && (
            <>
              <div className="settings-group settings-provider-auth-overview span-all">
                <div className="settings-provider-auth-overview-header">
                  <div>
                    <h4 className="sidebar-section-title" style={{ margin: 0 }}>
                      Provider sign-in
                    </h4>
                    <p className="settings-hint">
                      Same provider checklist as first launch. Runtime auth stays with each
                      provider; TaskWraith stores only explicit API keys or usage sessions you add
                      here.
                    </p>
                  </div>
                </div>
                <details className="settings-provider-install">
                  <summary>Need to install a CLI? Official commands</summary>
                  <p className="settings-hint">
                    Run one in your terminal, then sign in below. (npm commands need Node 20+; the
                    curl installers are self-contained.)
                  </p>
                  <ProviderInstallCommands />
                </details>
                <div className="settings-provider-auth-grid">
                  <SettingsProviderAuthCard
                    provider="codex"
                    label="Codex"
                    summary={codexAuthSummary}
                    description="OpenAI Codex CLI for fast shell and agentic work."
                  >
                    <div className="settings-provider-auth-command">
                      <code>codex login</code>
                      <span>Run once in Terminal for official Codex CLI runtime auth.</span>
                    </div>
                    <div className="settings-provider-auth-action-row">
                      {onProviderLogin && (
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          onClick={() => onProviderLogin('codex')}
                        >
                          Open Terminal to sign in
                        </button>
                      )}
                      {onProviderLogout && (
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => onProviderLogout('codex')}
                        >
                          Open Terminal to sign out
                        </button>
                      )}
                      {renderProviderUpgradeButton('codex')}
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={onImportCodexUsageCredential}
                      >
                        Import usage session
                      </button>
                      {codexUsageConfigured && (
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={onClearCodexUsageCredential}
                        >
                          Clear usage session
                        </button>
                      )}
                    </div>
                    <p className="settings-provider-auth-footnote">
                      Usage import powers quota and credit meters only; Codex runs still use the
                      official CLI login.
                      {renderProviderUpgradeHint('codex')}
                    </p>
                    {renderProviderPauseControls('codex')}
                  </SettingsProviderAuthCard>

                  <SettingsProviderAuthCard
                    provider="claude"
                    label="Claude"
                    summary={claudeAuthSummary}
                    description="Claude Code / Anthropic API for careful edits and long reasoning."
                  >
                    <div className="settings-provider-auth-action-row">
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={claudeLoginState === 'loading'}
                        onClick={onTriggerClaudeLogin}
                      >
                        {claudeLoginState === 'loading'
                          ? 'Opening browser...'
                          : 'Login with Claude'}
                      </button>
                      {onProviderLogout && (
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => onProviderLogout('claude')}
                        >
                          Sign out
                        </button>
                      )}
                      {renderProviderUpgradeButton('claude')}
                      {claudeAuthStatus?.apiKeyConfigured && onClearClaudeApiKey && (
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={onClearClaudeApiKey}
                        >
                          Clear API key
                        </button>
                      )}
                    </div>
                    <p className="settings-provider-auth-footnote">
                      API key and CLI path controls are below.
                      {renderProviderUpgradeHint('claude')}
                    </p>
                    {renderProviderPauseControls('claude')}
                  </SettingsProviderAuthCard>

                  <SettingsProviderAuthCard
                    provider="kimi"
                    label="Kimi"
                    summary={kimiSetupSummary}
                    description="Moonshot Kimi for wire-protocol runs and structured tool calls."
                    optional
                  >
                    <div className="settings-provider-auth-action-row">
                      {onProviderLogin && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => onProviderLogin('kimi')}
                        >
                          Open Terminal to sign in
                        </button>
                      )}
                      {onProviderLogout && (
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => onProviderLogout('kimi')}
                        >
                          Sign out
                        </button>
                      )}
                      {renderProviderUpgradeButton('kimi')}
                      {kimiAuthStatus?.apiKeyConfigured && onClearKimiApiKey && (
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={onClearKimiApiKey}
                        >
                          Clear API key
                        </button>
                      )}
                    </div>
                    <p className="settings-provider-auth-footnote">
                      Paste a Moonshot API key in the Kimi section below.
                      {renderProviderUpgradeHint('kimi')}
                    </p>
                    {renderProviderPauseControls('kimi')}
                  </SettingsProviderAuthCard>
                  <SettingsProviderAuthCard
                    provider="cursor"
                    label="Cursor"
                    summary={cursorAuthSummary}
                    description="Cursor Composer 2.5 for write-capable agentic runs via the Cursor CLI."
                    optional
                  >
                    <div className="settings-provider-auth-command">
                      <code>cursor-agent login</code>
                      <span>Run once in Terminal for official Cursor CLI runtime auth.</span>
                    </div>
                    <div className="settings-provider-auth-action-row">
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() => onProviderLogin?.('cursor')}
                        disabled={!onProviderLogin}
                      >
                        Open Terminal to sign in
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => onProviderLogout?.('cursor')}
                        disabled={!onProviderLogout}
                      >
                        Open Terminal to sign out
                      </button>
                      {renderProviderUpgradeButton('cursor')}
                    </div>
                    <p className="settings-provider-auth-footnote">
                      Write-mode runs are contained by a workspace-local deny-list and surfaced
                      through Review changes. TaskWraith stores no Cursor credential; auth stays
                      inside the Cursor CLI.
                      {renderProviderUpgradeHint('cursor')}
                    </p>
                    {renderProviderPauseControls('cursor')}
                  </SettingsProviderAuthCard>
                  <SettingsProviderAuthCard
                    provider="grok"
                    label="Grok"
                    summary={grokAuthSummary}
                    description="xAI Grok via its agent CLI (bidirectional ACP runs)."
                    optional
                  >
                    <div className="settings-provider-auth-command">
                      <code>grok</code>
                      <span>
                        Run the Grok CLI in Terminal and sign in (installs under ~/.grok/bin).
                      </span>
                    </div>
                    <div className="settings-provider-auth-action-row">
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() => onProviderLogin?.('grok')}
                        disabled={!onProviderLogin}
                      >
                        Open Terminal to sign in
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => onProviderLogout?.('grok')}
                        disabled={!onProviderLogout}
                      >
                        Open Terminal to sign out
                      </button>
                      {renderProviderUpgradeButton('grok')}
                    </div>
                    <p className="settings-provider-auth-footnote">
                      TaskWraith stores no Grok credential; auth stays inside the Grok CLI.
                      {renderProviderUpgradeHint('grok')}
                    </p>
                    {renderProviderPauseControls('grok')}
                  </SettingsProviderAuthCard>
                  <SettingsProviderAuthCard
                    provider="ollama"
                    label="Ollama"
                    summary={ollamaAuthSummary}
                    description="Local Ollama models run with no account. Sign in to ollama.com to use Ollama Cloud / Turbo and pull private models."
                    optional
                  >
                    <div className="settings-provider-auth-command">
                      <code>ollama signin</code>
                      <span>
                        Run once in Terminal to authorize this machine with ollama.com (opens a
                        browser). Use <code>ollama signout</code> to revoke it.
                      </span>
                    </div>
                    <div className="settings-provider-auth-action-row">
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() => onProviderLogin?.('ollama')}
                        disabled={!onProviderLogin}
                      >
                        Open Terminal to sign in
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => onProviderLogout?.('ollama')}
                        disabled={!onProviderLogout}
                      >
                        Open Terminal to sign out
                      </button>
                    </div>
                    <p className="settings-provider-auth-footnote">
                      Local models (configured in the Ollama section below) work without signing in
                      — cloud sign-in only unlocks ollama.com-hosted models. TaskWraith stores no
                      Ollama credential; auth stays inside the Ollama CLI.
                    </p>
                    {renderProviderPauseControls('ollama')}
                  </SettingsProviderAuthCard>
                </div>
              </div>

              <div className="settings-group span-all">
                <h4 className="sidebar-section-title" style={{ margin: 0 }}>
                  Agentic services
                </h4>
                <div className="settings-service-list">
                  <label className="settings-service-row">
                    <span>Shell commands</span>
                    <select
                      className="settings-select"
                      value={agenticServices.shellCommands}
                      onChange={(e) =>
                        updateAgenticService(
                          'shellCommands',
                          e.target.value as AgenticServicePolicy
                        )
                      }
                    >
                      {AGENTIC_SERVICE_POLICY_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="settings-service-row">
                    <span>File changes</span>
                    <select
                      className="settings-select"
                      value={agenticServices.fileChanges}
                      onChange={(e) =>
                        updateAgenticService('fileChanges', e.target.value as AgenticServicePolicy)
                      }
                    >
                      {AGENTIC_SERVICE_POLICY_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="settings-service-row">
                    <span>Provider tools</span>
                    <select
                      className="settings-select"
                      value={agenticServices.mcpTools}
                      onChange={(e) =>
                        updateAgenticService('mcpTools', e.target.value as AgenticServicePolicy)
                      }
                    >
                      {AGENTIC_SERVICE_POLICY_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="settings-service-row">
                    <span>
                      Sub-thread delegation
                      <small>
                        Whether agents on this workspace can delegate to sub-threads on other
                        providers. Default &apos;ask&apos; prompts you before each delegation;
                        &apos;Always allow&apos; lets agents spawn without prompting (use only for
                        trusted workflows).
                      </small>
                    </span>
                    <select
                      className="settings-select"
                      value={agenticServices.subThreadDelegation}
                      onChange={(e) =>
                        updateAgenticService(
                          'subThreadDelegation',
                          e.target.value as AgenticServicePolicy
                        )
                      }
                    >
                      {AGENTIC_SERVICE_POLICY_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="settings-service-row">
                    <span>
                      Canvas interaction
                      <small>
                        Whether agents can click and fill elements in a Canvas preview. Default
                        &apos;ask&apos; prompts before each interaction; &apos;Always allow&apos;
                        lets agents drive the preview without prompting. Denied under read-only.
                      </small>
                    </span>
                    <select
                      className="settings-select"
                      value={agenticServices.canvasInteraction ?? 'ask'}
                      onChange={(e) =>
                        updateAgenticService(
                          'canvasInteraction',
                          e.target.value as AgenticServicePolicy
                        )
                      }
                    >
                      {AGENTIC_SERVICE_POLICY_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="settings-service-row">
                    <span>
                      Media editing
                      <small>
                        Whether agents can transcode, encode, probe, decode, and mix workspace
                        audio/video files. Default &apos;ask&apos; prompts before each operation;
                        &apos;Always allow&apos; lets agents process media without prompting. Denied
                        under read-only.
                      </small>
                    </span>
                    <select
                      className="settings-select"
                      value={agenticServices.mediaEditing ?? 'ask'}
                      onChange={(e) =>
                        updateAgenticService('mediaEditing', e.target.value as AgenticServicePolicy)
                      }
                    >
                      {AGENTIC_SERVICE_POLICY_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="settings-service-row">
                    <span>
                      Media recording
                      <small>
                        Microphone / camera capture. Default-denied and cannot be pre-authorised —
                        every capture will prompt when these tools ship. Coming soon.
                      </small>
                    </span>
                    <select className="settings-select" value="deny" disabled>
                      <option value="deny">Denied (coming soon)</option>
                    </select>
                  </label>

                  <label className="settings-service-row">
                    <span>
                      Auto-resume parent when sub-thread completes
                      <small>
                        When a sub-thread you delegated to finishes, automatically continue the
                        parent agent so it can read the result without a manual nudge.
                      </small>
                    </span>
                    <input
                      type="checkbox"
                      checked={autoResumeParentOnSubThreadCompletion}
                      onChange={(e) =>
                        onChange({ autoResumeParentOnSubThreadCompletion: e.target.checked })
                      }
                    />
                  </label>

                  <label className="settings-service-row">
                    <span>Network access</span>
                    <select
                      className="settings-select"
                      value={agenticServices.networkAccess}
                      onChange={(e) =>
                        updateAgenticService(
                          'networkAccess',
                          e.target.value as AgenticNetworkPolicy
                        )
                      }
                    >
                      {NETWORK_POLICY_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <p className="settings-hint">
                  {agenticWorkspaceGrantCount} workspace permission{' '}
                  {agenticWorkspaceGrantCount === 1 ? 'grant' : 'grants'} saved.
                </p>

                {providerCapabilities && (
                  <div className="settings-hint">
                    Active provider contract: {providerCapabilities.label} shell is{' '}
                    {providerCapabilities.tools.shellCommands.state}, files are{' '}
                    {providerCapabilities.tools.fileChanges.state}, MCP is{' '}
                    {providerCapabilities.mcp.state}, creative apps are{' '}
                    {providerCapabilities.tools.creativeApps.state};{' '}
                    {
                      [
                        providerCapabilities.tools.shellCommands,
                        providerCapabilities.tools.fileChanges,
                        providerCapabilities.tools.mcpTools,
                        providerCapabilities.tools.creativeApps,
                        providerCapabilities.tools.networkAccess
                      ].filter((tool) => tool.enforcedByTaskWraith).length
                    }
                    /5 controls are TaskWraith-enforced.
                  </div>
                )}
                {!providerCapabilities && (
                  <div className="settings-hint">
                    Active provider contract for {activeProvider} will appear after the next
                    capability refresh.
                  </div>
                )}

                <label className="settings-service-row">
                  <span>Codex sandbox fallback</span>
                  <select
                    className="settings-select"
                    value={codexSandboxFallback}
                    onChange={(e) =>
                      onChange({ codexSandboxFallback: e.target.value as CodexSandboxFallbackMode })
                    }
                  >
                    {CODEX_SANDBOX_FALLBACK_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="settings-hint">
                  When Codex hits a Swift/Xcode sandbox/tooling collision, TaskWraith can ask to rerun
                  that exact command once from the host process.
                </p>

                <div className="settings-service-row" style={{ alignItems: 'flex-start' }}>
                  <span>
                    Audit role providers
                    <small>
                      Empty keeps /audit on the parent chat provider. Select providers only when
                      you want cross-provider audit fallback.
                    </small>
                  </span>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 'var(--space-xs)',
                      minWidth: 0
                    }}
                  >
                    {AUDIT_ARTIFACT_PROVIDER_OPTIONS.map((option) => (
                      <label
                        key={option.value}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 'var(--space-xs)',
                          fontWeight: 600
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={auditProviderAllowlist.includes(option.value)}
                          onChange={(event) =>
                            toggleAuditProvider(option.value, event.target.checked)
                          }
                        />
                        <span>
                          {option.label}
                          <small>{option.helper}</small>
                        </span>
                      </label>
                    ))}
                    <button
                      className="btn btn-sm"
                      type="button"
                      disabled={auditProviderAllowlist.length === 0}
                      onClick={() => updateAuditOrchestration({ providerAllowlist: [] })}
                    >
                      Use parent provider only
                    </button>
                  </div>
                </div>

                <div className="settings-service-row" style={{ alignItems: 'flex-start' }}>
                  <span>
                    Audit budget
                    <small>
                      Agent cap overrides the default per-mode budget. Token cap is optional.
                    </small>
                  </span>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                      gap: 'var(--space-xs)'
                    }}
                  >
                    <CommittedDraftField
                      className="settings-select"
                      type="number"
                      min={1}
                      max={200}
                      placeholder="Agents auto"
                      committed={String(auditOrchestration?.budgetMaxAgents ?? '')}
                      onCommit={(value) =>
                        updateAuditOrchestration({
                          budgetMaxAgents: value.trim() ? Number(value) : undefined
                        })
                      }
                      aria-label="Audit max agents"
                    />
                    <CommittedDraftField
                      className="settings-select"
                      type="number"
                      min={1}
                      step={1000}
                      placeholder="Tokens auto"
                      committed={String(auditOrchestration?.budgetMaxTokens ?? '')}
                      onCommit={(value) =>
                        updateAuditOrchestration({
                          budgetMaxTokens: value.trim() ? Number(value) : undefined
                        })
                      }
                      aria-label="Audit max tokens"
                    />
                  </div>
                </div>

                <label className="settings-service-row">
                  <span>
                    Ollama local audit roles
                    <small>
                      Reserved: v1 audit artifacts are currently recorded only through Claude/Kimi
                      role runs.
                    </small>
                  </span>
                  <input
                    type="checkbox"
                    checked={Boolean(auditOrchestration?.ollamaEnabled)}
                    disabled
                  />
                </label>

              </div>

              <div className="settings-group">
                <h4 className="sidebar-section-title" style={{ margin: 0 }}>
                  Claude
                </h4>

                {claudeAuthStatus && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-sm)',
                      marginBottom: 'var(--space-xs)'
                    }}
                  >
                    {!claudeAuthStatus.available ? (
                      <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                        ● Binary not found
                      </span>
                    ) : claudeAuthStatus.apiKeyConfigured ? (
                      <span style={{ fontSize: '0.78rem', color: 'var(--accent)' }}>
                        ● API key configured
                      </span>
                    ) : claudeAuthStatus.authState &&
                      !['not logged in', 'not authenticated', 'unauthenticated', 'error'].some(
                        (p) => claudeAuthStatus.authState.toLowerCase().includes(p)
                      ) ? (
                      <span style={{ fontSize: '0.78rem', color: 'var(--color-success, #3fb950)' }}>
                        ● Authenticated
                      </span>
                    ) : (
                      <span style={{ fontSize: '0.78rem', color: 'var(--color-warning, #d29922)' }}>
                        ● Not authenticated
                      </span>
                    )}
                    {claudeAuthStatus.version && (
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                        {claudeAuthStatus.version}
                      </span>
                    )}
                  </div>
                )}

                {/* Sign-in lives in the "Provider sign-in" checklist above; this
                    section keeps the API-key / CLI-path controls plus the shared
                    login-state feedback (which reflects that single Login button). */}
                {(claudeLoginState === 'success' || claudeLoginState === 'error') && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-sm)',
                      flexWrap: 'wrap',
                      marginBottom: 'var(--space-xs)'
                    }}
                  >
                    {claudeLoginState === 'success' && (
                      <span
                        className="settings-hint"
                        style={{ margin: 0, color: 'var(--color-success, #3fb950)' }}
                      >
                        Browser opened
                      </span>
                    )}
                    {claudeLoginState === 'error' && (
                      <span
                        className="settings-hint"
                        style={{ margin: 0, color: 'var(--color-danger, #f85149)' }}
                      >
                        Login failed — check CLI is installed
                      </span>
                    )}
                  </div>
                )}
                <p className="settings-hint">
                  Claude runs inside TaskWraith use Agent SDK / <code>claude -p</code> programmatic
                  paths. From 2026-06-15 Anthropic says these use separate Agent SDK credit, not
                  normal interactive Claude Code subscription limits. Use Claude in an interactive
                  terminal when you specifically need native Claude Code subscription-limit
                  behavior.
                </p>

                <label className="settings-label">Anthropic API key</label>
                <div
                  style={{
                    display: 'flex',
                    gap: 'var(--space-sm)',
                    marginBottom: 'var(--space-xs)'
                  }}
                >
                  <input
                    className="settings-select"
                    type="password"
                    value={claudeKeyInput}
                    disabled={claudeApiKeyStorageUnavailable}
                    onChange={(e) => setClaudeKeyInput(e.target.value)}
                    placeholder={
                      claudeAuthStatus?.apiKeyConfigured ? '••••••••••• (saved)' : 'sk-ant-...'
                    }
                    style={{ flex: 1 }}
                  />
                  <button
                    className="btn btn-sm"
                    disabled={!claudeKeyInput.trim() || claudeApiKeyStorageUnavailable}
                    onClick={() => {
                      onStoreClaudeApiKey?.(claudeKeyInput)
                      setClaudeKeyInput('')
                    }}
                  >
                    Save
                  </button>
                  {claudeAuthStatus?.apiKeyConfigured && (
                    <button className="btn btn-sm btn-ghost" onClick={onClearClaudeApiKey}>
                      Clear
                    </button>
                  )}
                </div>
                <p className="settings-hint">
                  {claudeApiKeyStorageUnavailable
                    ? 'Secure storage is unavailable on this system, so API keys cannot be saved here.'
                    : 'API key takes priority over the Claude Code login session and uses API/PAYG billing. Stored encrypted on-device.'}
                </p>

                <label className="settings-label">Claude CLI binary</label>
                <CommittedDraftField
                  className="settings-select"
                  committed={claudeBinaryPath}
                  onCommit={(value) => onChange({ claudeBinaryPath: value })}
                  placeholder="Auto-detect, or /Users/you/.local/bin/claude"
                />
                <p className="settings-hint">Optional path override.</p>
              </div>

              <div className="settings-group">
                <h4 className="sidebar-section-title" style={{ margin: 0 }}>
                  Kimi
                </h4>

                {kimiAuthStatus && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-sm)',
                      marginBottom: 'var(--space-xs)'
                    }}
                  >
                    {!kimiAuthStatus.available ? (
                      <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                        ● Binary not found
                      </span>
                    ) : kimiAuthStatus.apiKeyConfigured ? (
                      <span style={{ fontSize: '0.78rem', color: 'var(--accent)' }}>
                        ● API key configured
                      </span>
                    ) : (
                      <span style={{ fontSize: '0.78rem', color: 'var(--color-warning, #d29922)' }}>
                        ● No API key
                      </span>
                    )}
                  </div>
                )}

                <label className="settings-label">Moonshot API key</label>
                <div
                  style={{
                    display: 'flex',
                    gap: 'var(--space-sm)',
                    marginBottom: 'var(--space-xs)'
                  }}
                >
                  <input
                    className="settings-select"
                    type="password"
                    value={kimiKeyInput}
                    disabled={kimiApiKeyStorageUnavailable}
                    onChange={(e) => setKimiKeyInput(e.target.value)}
                    placeholder={
                      kimiAuthStatus?.apiKeyConfigured ? '••••••••••• (saved)' : 'moonshot-...'
                    }
                    style={{ flex: 1 }}
                  />
                  <button
                    className="btn btn-sm"
                    disabled={!kimiKeyInput.trim() || kimiApiKeyStorageUnavailable}
                    onClick={() => {
                      onStoreKimiApiKey?.(kimiKeyInput)
                      setKimiKeyInput('')
                    }}
                  >
                    Save
                  </button>
                  {kimiAuthStatus?.apiKeyConfigured && (
                    <button className="btn btn-sm btn-ghost" onClick={onClearKimiApiKey}>
                      Clear
                    </button>
                  )}
                </div>
                <p className="settings-hint">
                  {kimiApiKeyStorageUnavailable
                    ? 'Secure storage is unavailable on this system, so API keys cannot be saved here.'
                    : 'Your Moonshot API key (MOONSHOT_API_KEY). Stored encrypted on-device.'}
                </p>

                <label className="settings-label">Kimi CLI binary</label>
                <input
                  className="settings-select"
                  value={kimiBinaryPath}
                  onChange={(e) => onChange({ kimiBinaryPath: e.target.value })}
                  placeholder="Auto-detect, or /path/to/kimi"
                />
                <p className="settings-hint">
                  Optional path override for Kimi Code CLI.
                  {kimiAuthStatus?.version ? ` Current: ${kimiAuthStatus.version}.` : ''}
                </p>
              </div>

              <div className="settings-group">
                <h4 className="sidebar-section-title" style={{ margin: 0 }}>
                  Local / Ollama
                </h4>

                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-sm)',
                    marginBottom: 'var(--space-xs)',
                    flexWrap: 'wrap'
                  }}
                >
                  {ollamaStatus?.available ? (
                    <span style={{ fontSize: '0.78rem', color: 'var(--color-success, #3fb950)' }}>
                      ● Service reachable
                    </span>
                  ) : (
                    <span style={{ fontSize: '0.78rem', color: 'var(--color-warning, #d29922)' }}>
                      ● Service not reachable
                    </span>
                  )}
                  {typeof ollamaStatus?.modelCount === 'number' && (
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                      {ollamaStatus.modelCount} local model
                      {ollamaStatus.modelCount === 1 ? '' : 's'}
                    </span>
                  )}
                  <button
                    className="btn btn-sm btn-ghost"
                    type="button"
                    onClick={() => onRefreshProviderMcpStatus?.('ollama')}
                  >
                    Refresh
                  </button>
                </div>
                {renderProviderPauseControls('ollama')}

                <label className="settings-label">Ollama endpoint</label>
                <input
                  className="settings-select"
                  value={ollamaBaseUrl}
                  onChange={(e) => onChange({ ollamaBaseUrl: e.target.value })}
                  placeholder="http://127.0.0.1:11434"
                />
                <p className="settings-hint">
                  TaskWraith talks to the local Ollama HTTP service. No cloud API key is required.
                </p>

                <label className="settings-label">Default local model</label>
                {Array.isArray(ollamaStatus?.models) && ollamaStatus.models.length > 0 ? (
                  <div className="settings-option-list">
                    {ollamaStatus.models.map((model: any) => {
                      const modelId = String(model.id || '')
                      const selected = ollamaDefaultModel
                        ? modelId === ollamaDefaultModel
                        : model.isDefault === true
                      const chips = [
                        model.parameterSize,
                        model.quantizationLevel,
                        typeof model.contextLength === 'number'
                          ? `${Math.round(model.contextLength / 1000)}k ctx`
                          : '',
                        Array.isArray(model.capabilities) && model.capabilities.includes('tools')
                          ? 'tools'
                          : '',
                        Array.isArray(model.capabilities) && model.capabilities.includes('thinking')
                          ? 'thinking'
                          : '',
                        model.family || model.format
                      ].filter(Boolean)
                      return (
                        <button
                          key={modelId || model.label}
                          type="button"
                          className={`settings-radio-option ${selected ? 'active' : ''}`}
                          onClick={() => onChange({ ollamaDefaultModel: modelId })}
                          aria-pressed={selected}
                          title={model.digest ? `${modelId}\n${model.digest}` : modelId}
                        >
                          <span className="settings-radio-dot" />
                          <span>
                            <strong>{model.label || modelId}</strong>
                            <span>{modelId}</span>
                            {chips.length > 0 && (
                              <span
                                style={{
                                  display: 'flex',
                                  flexWrap: 'wrap',
                                  gap: 'var(--space-2xs)',
                                  marginTop: '4px'
                                }}
                              >
                                {chips.slice(0, 6).map((chip: string) => (
                                  <span
                                    key={chip}
                                    style={{
                                      border: '1px solid var(--border-subtle)',
                                      borderRadius: '999px',
                                      padding: '1px 6px',
                                      color: 'var(--text-tertiary)'
                                    }}
                                  >
                                    {chip}
                                  </span>
                                ))}
                              </span>
                            )}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                ) : (
                  <input
                    className="settings-select"
                    value={ollamaDefaultModel}
                    onChange={(e) => onChange({ ollamaDefaultModel: e.target.value })}
                    placeholder={ollamaStatus?.defaultModel || 'qwen3:4b-instruct'}
                  />
                )}
                <p className="settings-hint">
                  Select an exact installed tag. Leave blank only when no installed model list is
                  available.
                </p>

                <label className="settings-label">Ollama coding profile</label>
                <div className="settings-option-list">
                  {OLLAMA_RUN_PROFILE_OPTIONS.map((option) => {
                    const checked = resolvedOllamaRunProfile === option.value
                    return (
                      <button
                        key={option.value}
                        type="button"
                        className={`settings-radio-option ${checked ? 'active' : ''}`}
                        onClick={() => selectOllamaRunProfile(option)}
                        aria-pressed={checked}
                      >
                        <span className="settings-radio-dot" />
                        <span>
                          <strong>{option.label}</strong>
                          <span>{option.helper}</span>
                        </span>
                      </button>
                    )
                  })}
                </div>
                {ollamaCustomProfileCount > 0 && (
                  <p className="settings-hint">
                    {ollamaCustomProfileCount} custom Ollama profile override
                    {ollamaCustomProfileCount === 1 ? '' : 's'} configured.
                  </p>
                )}

                <label className="settings-label">Local model tool control</label>
                <div className="settings-option-list">
                  {OLLAMA_TOOL_CONTROL_TIERS.map((option) => {
                    const checked = resolvedOllamaToolControlTier === option.value
                    return (
                      <button
                        key={option.value}
                        type="button"
                        className={`settings-radio-option ${checked ? 'active' : ''}`}
                        onClick={() => selectOllamaToolControlTier(option.value)}
                        aria-pressed={checked}
                      >
                        <span className="settings-radio-dot" />
                        <span>
                          <strong>{option.label}</strong>
                          <span>{option.helper}</span>
                        </span>
                      </button>
                    )
                  })}
                </div>
                <p className="settings-hint">
                  Ollama never receives raw filesystem access. Every tier is still mediated by
                  TaskWraith workspace checks; Tier 2 and Tier 3 force a modal approval before each
                  mutation.
                </p>
                {resolvedOllamaToolControlTier === 'provider_parity' && (
                  <div
                    className="settings-hint"
                    style={{
                      color: currentWorkspaceParityGranted
                        ? 'var(--color-success, #3fb950)'
                        : 'var(--color-warning, #d29922)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-xs)',
                      flexWrap: 'wrap'
                    }}
                  >
                    <span>
                      {currentWorkspaceParityGranted
                        ? `Provider parity is enabled for ${currentWorkspaceLabel}.`
                        : currentWorkspacePath
                          ? `Tier 4 is selected, but ${currentWorkspaceLabel} has no parity grant yet; Ollama is read-only here.`
                          : 'Tier 4 is selected, but Ollama stays read-only until a workspace is open and granted.'}
                    </span>
                    {currentWorkspaceParityGranted && (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={revokeOllamaProviderParityForCurrentWorkspace}
                      >
                        Revoke this workspace
                      </button>
                    )}
                  </div>
                )}
                {ollamaStatus?.error && (
                  <p className="settings-hint" style={{ color: 'var(--color-warning, #d29922)' }}>
                    {String(ollamaStatus.error)}
                  </p>
                )}
              </div>
            </>
          ) /* end providers */
        }

        {/* ── Provider Tools ─────────────────────────────── */}
        {activeTab === 'mcp' && (
          <div className="settings-mcp-page">
            <div className="settings-group span-all settings-mcp-overview">
              <div className="settings-mcp-header">
                <div>
                  <div className="settings-section-title-row">
                    <h4 className="sidebar-section-title" style={{ margin: 0 }}>
                      Provider tools and TaskWraith bridge
                    </h4>
                  </div>
                  <p className="settings-hint">
                    Audit the tool surface agents can see, the transcript labels users see, and the
                    policy gate attached to each capability. User-managed MCP servers live in the
                    MCP Servers page.
                  </p>
                </div>
                <div className="settings-mcp-header-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      SETTINGS_PROVIDER_ORDER.forEach((provider) =>
                        onRefreshProviderMcpStatus?.(provider)
                      )
                      onRefreshGeminiMcpBridgeStatus()
                    }}
                  >
                    Refresh
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={openImportMcpServersPage}
                  >
                    Import config
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={openCreateMcpServerPage}
                  >
                    Add server
                  </button>
                </div>
              </div>

              <div className="settings-mcp-summary-grid">
                <article className="settings-mcp-summary-card">
                  <span>TaskWraith tools</span>
                  <strong>{TASKWRAITH_MCP_TOOLS.length}</strong>
                  <small>TaskWraith MCP bridge catalog</small>
                </article>
                <article className="settings-mcp-summary-card">
                  <span>Providers</span>
                  <strong>
                    {connectedMcpProviderCount}/{providerMcpSummaries.length}
                  </strong>
                  <small>report MCP or bridge status</small>
                </article>
                <article className="settings-mcp-summary-card">
                  <span>Primary policy</span>
                  <strong>{getMcpPolicyLabel(agenticServices, 'mcpTools')}</strong>
                  <small>provider tool gate</small>
                </article>
                <article className="settings-mcp-summary-card">
                  <span>Visible now</span>
                  <strong>{filteredMcpToolCatalog.length}</strong>
                  <small>
                    {mcpToolSearch ? 'matching the current filter' : 'tools in the audit table'}
                  </small>
                </article>
              </div>
            </div>

            <div className="settings-group span-all">
              <div className="settings-mcp-section-title">
                <h4 className="sidebar-section-title" style={{ margin: 0 }}>
                  Native sub-agent requests
                </h4>
                <p className="settings-hint">
                  Choose whether provider-native Task / invoke_agent calls continue natively or are
                  redirected to TaskWraith sub-threads for durable sidebar, iOS, recall, and audit
                  visibility.
                </p>
              </div>
              <label className="settings-service-row">
                <span>
                  Native Sub-Agent Requests
                  <small>
                    {NATIVE_SUB_AGENT_REQUEST_OPTIONS.find(
                      (option) => option.value === nativeSubAgentRequests
                    )?.helper || NATIVE_SUB_AGENT_REQUEST_OPTIONS[0].helper}
                  </small>
                </span>
                <select
                  className="settings-select"
                  value={nativeSubAgentRequests}
                  onChange={(event) =>
                    onChange({
                      nativeSubAgentRequests: event.target.value as NativeSubAgentRequestPolicy
                    })
                  }
                >
                  {NATIVE_SUB_AGENT_REQUEST_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="settings-group span-all">
              <div className="settings-mcp-section-title">
                <h4 className="sidebar-section-title" style={{ margin: 0 }}>
                  Connected surfaces
                </h4>
                <p className="settings-hint">
                  Provider status comes from existing runtime discovery. The shared TaskWraith
                  MCP bridge is registered for supported provider runtimes.
                </p>
              </div>
              <div className="settings-mcp-server-grid">
                {providerMcpSummaries.map((entry) => (
                  <article
                    key={entry.provider}
                    className={`settings-mcp-server-card provider-${entry.provider}`}
                    data-state={entry.state}
                  >
                    <div className="settings-mcp-server-header">
                      <ProviderLogoTile provider={entry.provider} />
                      <div>
                        <strong>{entry.label}</strong>
                        <span>{entry.serverName}</span>
                      </div>
                      <span className="settings-mcp-state-pill">{entry.state}</span>
                    </div>
                    <div className="settings-mcp-server-meta">
                      <span>{entry.source}</span>
                      <span>
                        {entry.toolCount > 0
                          ? pluralizeCount(entry.toolCount, 'tool')
                          : entry.providerManaged
                            ? 'host tools not injected'
                            : 'No tools'}
                      </span>
                      {/* Provider-managed surfaces (Grok CLI, Cursor host web
                          bridge) are not installable TaskWraith MCP servers, so
                          "not installed" would read as an error. Show a calm tag
                          instead; only the actual bridges report installed state. */}
                      <span>
                        {entry.providerManaged
                          ? 'Provider-managed MCP'
                          : entry.installed
                            ? 'installed'
                            : 'not installed'}
                      </span>
                    </div>
                    <p className="settings-hint">{entry.message}</p>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => onRefreshProviderMcpStatus?.(entry.provider)}
                      disabled={!onRefreshProviderMcpStatus}
                    >
                      Refresh provider
                    </button>
                  </article>
                ))}
              </div>

              <div className="settings-mcp-bridge-card">
                <label className="settings-effects-check-row">
                  <input
                    type="checkbox"
                    checked={geminiMcpBridgeEnabled}
                    onChange={(e) => onChange({ geminiMcpBridgeEnabled: e.target.checked })}
                  />
                  <span>
                    TaskWraith MCP bridge
                    <small>
                      Enables TaskWraith's bundled MCP broker, including image_edit,
                      svg_rasterize, and image_generate. Write-capable Cursor and Grok runs
                      auto-inject a scoped broker when they need TaskWraith-owned tools; no
                      manual Cursor or Grok MCP install is required. image_generate additionally
                      needs to be enabled with an API key.
                    </small>
                  </span>
                </label>
                <div className="settings-mcp-bridge-actions">
                  <button type="button" className="btn btn-sm" onClick={onInstallGeminiMcpBridge}>
                    Install / repair
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={onRefreshGeminiMcpBridgeStatus}
                  >
                    Test
                  </button>
                </div>
              </div>

              <ImageGenerationSettingsCard />
            </div>

            <div className="settings-group span-all">
              <div className="settings-mcp-section-title">
                <h4 className="sidebar-section-title" style={{ margin: 0 }}>
                  TaskWraith environment tools
                </h4>
                <p className="settings-hint">
                  Each row shows the transcript-facing label, icon reference, provider invocation
                  names, and the current approval policy.
                </p>
              </div>
              <div className="settings-audit-toolbar">
                <label className="settings-audit-search">
                  <span className="sr-only">Search MCP tools</span>
                  <input
                    className="settings-select"
                    value={mcpToolQuery}
                    onChange={(event) => setMcpToolQuery(event.target.value)}
                    aria-label="Search MCP tools"
                    placeholder="Search tools, aliases, policies"
                  />
                </label>
                <div className="settings-audit-toolbar-meta">
                  <span>
                    {filteredMcpToolCatalog.length} of {MCP_TOOL_CATALOG.length} tools
                  </span>
                  {mcpToolSearch && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => setMcpToolQuery('')}
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
              <div className="settings-mcp-tool-groups">
                {MCP_TOOL_GROUP_ORDER.map((group) => {
                  const tools = filteredMcpToolCatalog.filter((tool) => tool.group === group)
                  if (tools.length === 0) return null
                  return (
                    <section key={group} className="settings-mcp-tool-group">
                      <div className="settings-mcp-tool-group-title">
                        <strong>{MCP_TOOL_GROUP_LABELS[group]}</strong>
                        <span>{pluralizeCount(tools.length, 'tool')}</span>
                      </div>
                      <div className="settings-mcp-tool-list">
                        {tools.map((tool) => (
                          <article key={tool.name} className="settings-mcp-tool-row">
                            <div className="settings-mcp-tool-main">
                              <span
                                className="settings-mcp-tool-icon"
                                title={`Icon ref: ${tool.iconRef}`}
                                aria-hidden
                              >
                                <ToolFamilyIcon
                                  family={resolveMcpToolIconFamily(tool)}
                                  size={18}
                                  className="settings-mcp-tool-icon-svg"
                                />
                              </span>
                              <div>
                                <strong>{tool.label}</strong>
                                <p>{tool.description}</p>
                              </div>
                            </div>
                            <div className="settings-mcp-tool-detail-grid">
                              <span>
                                Transcript
                                <code>{tool.transcript}</code>
                              </span>
                              <span>
                                Icon ref
                                <code>{tool.iconRef}</code>
                              </span>
                              <span>
                                Codex / Gemini / Kimi
                                <code>{formatMcpInvocation('codex', tool.name)}</code>
                              </span>
                              <span>
                                Claude
                                <code>{formatMcpInvocation('claude', tool.name)}</code>
                              </span>
                              <span>
                                Policy
                                <code>{getMcpPolicyLabel(agenticServices, tool.policyKey)}</code>
                              </span>
                            </div>
                          </article>
                        ))}
                      </div>
                    </section>
                  )
                })}
                {filteredMcpToolCatalog.length === 0 && (
                  <div className="settings-audit-empty">No MCP tools match that search.</div>
                )}
              </div>
            </div>

            <div className="settings-group span-all">
              <div className="settings-mcp-section-title">
                <h4 className="sidebar-section-title" style={{ margin: 0 }}>
                  Extensions, skills, and connectors
                </h4>
                <p className="settings-hint">
                  These surfaces are intentionally audit-first here. Add/remove needs a separate
                  config-writing slice so TaskWraith never mutates provider MCP files by accident.
                </p>
              </div>
              <div className="settings-mcp-management-grid">
                <article className="settings-mcp-management-card">
                  <strong>User MCP servers</strong>
                  <p>
                    Add, edit, enable, and remove app-managed external MCP server definitions.
                  </p>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => setActiveTab('mcp-servers')}
                  >
                    Open MCP Servers
                  </button>
                </article>
                <article className="settings-mcp-management-card">
                  <strong>Skills</strong>
                  <p>
                    Provider-owned skills should be visible here with their enabled state and tool
                    names.
                  </p>
                  <button type="button" className="btn btn-sm btn-ghost" disabled>
                    Audit surface planned
                  </button>
                </article>
                <article className="settings-mcp-management-card">
                  <strong>Connectors</strong>
                  <p>Connector availability should be listed beside the MCP tools they expose.</p>
                  <button type="button" className="btn btn-sm btn-ghost" disabled>
                    Connector registry planned
                  </button>
                </article>
              </div>
            </div>
          </div>
        )}

        {/* ── MCP Servers ───────────────────────────────── */}
        {activeTab === 'mcp-servers' && (
          <div className="settings-mcp-page settings-user-mcp-page">
            <div className="settings-group span-all settings-mcp-overview">
              <div className="settings-mcp-header">
                <div>
                  <div className="settings-section-title-row">
                    <h4 className="sidebar-section-title" style={{ margin: 0 }}>
                      MCP servers
                    </h4>
                    <span className="settings-editable-pill">Editable</span>
                  </div>
                  <p className="settings-hint">
                    Manage external MCP server definitions TaskWraith owns. Enabled stdio and HTTP
                    servers attach to Codex and Claude launches; Cursor-compatible entries attach
                    during contained Cursor write-mode runs. SSE attaches to Claude. Remote headers
                    are stored locally and redacted in audit JSON. Cursor uses temporary
                    workspace-local MCP config that TaskWraith restores after the run.
                  </p>
                </div>
                <div className="settings-mcp-header-actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={copyAllMcpServersAuditJson}
                    disabled={userMcpServers.length === 0}
                  >
                    {copiedMcpServersJson ? 'Copied audit' : 'Copy audit JSON'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={copyAllMcpServersClaudeJson}
                    disabled={claudeExportableUserMcpServerCount === 0}
                  >
                    {copiedMcpServersClaudeJson ? 'Copied Claude' : 'Copy Claude JSON'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={copyAllMcpServersCursorJson}
                    disabled={cursorExportableUserMcpServerCount === 0}
                  >
                    {copiedMcpServersCursorJson ? 'Copied Cursor' : 'Copy Cursor JSON'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={copyAllMcpServersCodexToml}
                    disabled={codexExportableUserMcpServerCount === 0}
                  >
                    {copiedMcpServersCodexToml ? 'Copied TOML' : 'Copy Codex TOML'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={startImportMcpServers}
                  >
                    Import config
                  </button>
                  <button type="button" className="btn btn-sm" onClick={startCreateMcpServer}>
                    Add server
                  </button>
                </div>
              </div>

              <div className="settings-mcp-summary-grid">
                <article className="settings-mcp-summary-card">
                  <span>Servers</span>
                  <strong>{userMcpServers.length}</strong>
                  <small>user-managed definitions</small>
                </article>
                <article className="settings-mcp-summary-card">
                  <span>Active</span>
                  <strong>{activeUserMcpServerCount}</strong>
                  <small>active definitions</small>
                </article>
                <article className="settings-mcp-summary-card">
                  <span>Ready</span>
                  <strong>{readyUserMcpServerCount}</strong>
                  <small>attachable on next launch</small>
                </article>
                <article className="settings-mcp-summary-card">
                  <span>Needs attention</span>
                  <strong>{blockedUserMcpServerCount}</strong>
                  <small>enabled but incomplete</small>
                </article>
                <article className="settings-mcp-summary-card">
                  <span>Transports</span>
                  <strong>{userMcpTransportCount}</strong>
                  <small>stdio, HTTP, or SSE</small>
                </article>
                <article className="settings-mcp-summary-card">
                  <span>Runtime</span>
                  <strong>{USER_MCP_STDIO_HTTP_RUNTIME_LABEL}</strong>
                  <small>stdio/HTTP; Cursor write-mode support</small>
                </article>
                <article className="settings-mcp-summary-card">
                  <span>Codex export</span>
                  <strong>{codexExportableUserMcpServerCount}</strong>
                  <small>config-ready TOML entries</small>
                </article>
                <article className="settings-mcp-summary-card">
                  <span>Claude export</span>
                  <strong>{claudeExportableUserMcpServerCount}</strong>
                  <small>config-ready JSON entries</small>
                </article>
                <article className="settings-mcp-summary-card">
                  <span>Cursor export</span>
                  <strong>{cursorExportableUserMcpServerCount}</strong>
                  <small>mcp.json entries</small>
                </article>
                <article className="settings-mcp-summary-card">
                  <span>TaskWraith bridge</span>
                  <strong>{geminiMcpBridgeEnabled ? 'On' : 'Off'}</strong>
                  <small>built-in provider tools stay separate</small>
                </article>
              </div>

              {userMcpServers.length > 0 && (
                <p className="settings-user-mcp-config-note">
                  Config previews redact stored values. Provider copy buttons use the saved config;
                  audit JSON stays redacted for review.
                </p>
              )}
              {userMcpServers.length > 0 && (
                <details className="settings-user-mcp-config settings-user-mcp-config-all">
                  <summary>All servers audit JSON</summary>
                  <pre>
                    <code>{formatUserMcpServersAuditJson(userMcpServers)}</code>
                  </pre>
                </details>
              )}
              {claudeExportableUserMcpServerCount > 0 && (
                <details className="settings-user-mcp-config settings-user-mcp-config-all">
                  <summary>Claude config JSON</summary>
                  <pre>
                    <code>
                      {formatUserMcpServersClaudeJson(userMcpServers, { redactValues: true })}
                    </code>
                  </pre>
                </details>
              )}
              {cursorExportableUserMcpServerCount > 0 && (
                <details className="settings-user-mcp-config settings-user-mcp-config-all">
                  <summary>Cursor config JSON</summary>
                  <pre>
                    <code>
                      {formatUserMcpServersCursorJson(userMcpServers, { redactValues: true })}
                    </code>
                  </pre>
                </details>
              )}
              {codexExportableUserMcpServerCount > 0 && (
                <details className="settings-user-mcp-config settings-user-mcp-config-all">
                  <summary>Codex config TOML</summary>
                  <pre>
                    <code>{formatUserMcpServersCodexToml(userMcpServers, { redactValues: true })}</code>
                  </pre>
                </details>
              )}
            </div>

            {mcpImportOpen && (
              <div className="settings-group span-all settings-user-mcp-importer">
                <div className="settings-mcp-section-title">
                  <h4 className="sidebar-section-title" style={{ margin: 0 }}>
                    Import MCP config
                  </h4>
                  <p className="settings-hint">
                    Paste a Claude or Cursor JSON object with a top-level mcpServers map, or a
                    Codex TOML snippet with mcp_servers tables. Imported servers are stored as
                    TaskWraith-owned definitions.
                  </p>
                </div>
                <textarea
                  className="settings-user-mcp-textarea settings-user-mcp-import-textarea"
                  value={mcpImportText}
                  onChange={(event) => {
                    setMcpImportText(event.target.value)
                    setMcpImportError('')
                  }}
                  rows={8}
                  placeholder={`{\n  "mcpServers": {\n    "docs": {\n      "type": "http",\n      "url": "https://example.test/mcp",\n      "headers": { "X-Region": "eu" }\n    }\n  }\n}\n\n[mcp_servers.docs]\nurl = "https://example.test/mcp"\nhttp_headers = { "X-Region" = "eu" }`}
                />
                <div className="settings-user-mcp-footer">
                  <span className="settings-hint">
                    Existing definitions are kept; imported names are de-duplicated.
                  </span>
                  <div className="settings-mcp-header-actions">
                    {mcpImportError && (
                      <span className="settings-user-mcp-error">{mcpImportError}</span>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={importMcpServersFromConfig}
                    >
                      Import
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={cancelImportMcpServers}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className="settings-group span-all">
              <div className="settings-mcp-section-title">
                <h4 className="sidebar-section-title" style={{ margin: 0 }}>
                  User MCP servers
                </h4>
                <p className="settings-hint">
                  These records are stored by TaskWraith. Stdio and HTTP servers are available to
                  Codex and Claude provider launch paths, plus contained Cursor write-mode runs; SSE
                  is available to Claude.
                </p>
              </div>
              {userMcpServers.length > 0 && (
                <div className="settings-audit-toolbar">
                  <label className="settings-audit-search">
                    <span className="sr-only">Search user MCP servers</span>
                    <input
                      className="settings-select"
                      value={mcpServerQuery}
                      onChange={(event) => setMcpServerQuery(event.target.value)}
                      aria-label="Search user MCP servers"
                      placeholder="Search names, transports, commands, URLs"
                    />
                  </label>
                  <div className="settings-audit-toolbar-meta">
                    <span>
                      {filteredUserMcpServers.length} of {userMcpServers.length} servers
                    </span>
                    {mcpServerSearch && (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => setMcpServerQuery('')}
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
              )}

              {userMcpServers.length === 0 ? (
                <div className="settings-user-mcp-empty">
                  <strong>No MCP servers added</strong>
                  <p>
                    Add a local stdio server, remote HTTP/SSE endpoint, or import existing Claude,
                    Cursor, or Codex config.
                  </p>
                  <button type="button" className="btn btn-sm" onClick={startCreateMcpServer}>
                    Add server
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={startImportMcpServers}
                  >
                    Import config
                  </button>
                </div>
              ) : filteredUserMcpServers.length === 0 ? (
                <div className="settings-audit-empty">No MCP servers match that search.</div>
              ) : (
                <div className="settings-user-mcp-list">
                  {filteredUserMcpServers.map(({ server, readiness }) => {
                    const endpoint =
                      server.transport === 'stdio'
                        ? server.command || 'No command'
                        : server.url || 'No URL'
                    const exportLabels = userMcpServerProviderExportLabels(server)
                    const claudeSnippetPreview = isClaudeExportableUserMcpServer(server)
                      ? formatUserMcpServerClaudeJsonSnippet(userMcpServers, server, {
                          redactValues: true
                        })
                      : ''
                    const claudeSnippetCopy = claudeSnippetPreview
                      ? formatUserMcpServerClaudeJsonSnippet(userMcpServers, server)
                      : ''
                    const cursorSnippetPreview = isCursorExportableUserMcpServer(server)
                      ? formatUserMcpServerCursorJsonSnippet(userMcpServers, server, {
                          redactValues: true
                        })
                      : ''
                    const cursorSnippetCopy = cursorSnippetPreview
                      ? formatUserMcpServerCursorJsonSnippet(userMcpServers, server)
                      : ''
                    const codexSnippetPreview = isCodexExportableUserMcpServer(server)
                      ? formatUserMcpServerCodexTomlSnippet(userMcpServers, server, {
                          redactValues: true
                        })
                      : ''
                    const codexSnippetCopy = codexSnippetPreview
                      ? formatUserMcpServerCodexTomlSnippet(userMcpServers, server)
                      : ''
                    return (
                      <article key={server.id} className="settings-user-mcp-row">
                        <div className="settings-user-mcp-main">
                          <strong>{server.name}</strong>
                          <span>{server.description || endpoint}</span>
                          <div className="settings-mcp-server-meta">
                            <span>{userMcpServerStatusLabel(server)}</span>
                            <span>{server.transport}</span>
                            <span>{endpoint}</span>
                            {server.args && server.args.length > 0 && (
                              <span>{pluralizeCount(server.args.length, 'arg')}</span>
                            )}
                            {server.env && Object.keys(server.env).length > 0 && (
                              <span>{pluralizeCount(Object.keys(server.env).length, 'env var')}</span>
                            )}
                            {server.headers && Object.keys(server.headers).length > 0 && (
                              <span>{pluralizeCount(Object.keys(server.headers).length, 'header')}</span>
                            )}
                            {server.bearerTokenEnvVar && <span>bearer env</span>}
                            <span>{userMcpServerRuntimeLabel(server)}</span>
                            {exportLabels.map((label) => (
                              <span key={label}>{label}</span>
                            ))}
                          </div>
                          <div
                            className={`settings-user-mcp-readiness settings-user-mcp-readiness-${readiness.state}`}
                          >
                            <strong>{readiness.label}</strong>
                            {readiness.blockers.length > 0 && (
                              <span>{readiness.blockers.join('; ')}</span>
                            )}
                            {readiness.notes.length > 0 && (
                              <span>{readiness.notes.join('; ')}</span>
                            )}
                          </div>
                          <details className="settings-user-mcp-config">
                            <summary>Audit JSON</summary>
                            <pre>
                              <code>{formatUserMcpServerAuditJson(server)}</code>
                            </pre>
                          </details>
                          {exportLabels.length > 0 && (
                            <details className="settings-user-mcp-config">
                              <summary>Provider config snippets</summary>
                              <div className="settings-user-mcp-snippet-list">
                                <p className="settings-user-mcp-snippet-note">
                                  Previews redact stored values. Copy buttons use the saved config.
                                </p>
                                {claudeSnippetPreview && (
                                  <section>
                                    <div className="settings-user-mcp-snippet-heading">
                                      <strong>Claude JSON</strong>
                                      <button
                                        type="button"
                                        className="btn btn-sm btn-ghost"
                                        onClick={() =>
                                          copyMcpServerProviderSnippet(
                                            server.id,
                                            'claude',
                                            claudeSnippetCopy
                                          )
                                        }
                                      >
                                        {copiedMcpServerSnippetKey === `${server.id}:claude`
                                          ? 'Copied Claude'
                                          : 'Copy Claude'}
                                      </button>
                                    </div>
                                    <pre>
                                      <code>{claudeSnippetPreview}</code>
                                    </pre>
                                  </section>
                                )}
                                {cursorSnippetPreview && (
                                  <section>
                                    <div className="settings-user-mcp-snippet-heading">
                                      <strong>Cursor mcp.json</strong>
                                      <button
                                        type="button"
                                        className="btn btn-sm btn-ghost"
                                        onClick={() =>
                                          copyMcpServerProviderSnippet(
                                            server.id,
                                            'cursor',
                                            cursorSnippetCopy
                                          )
                                        }
                                      >
                                        {copiedMcpServerSnippetKey === `${server.id}:cursor`
                                          ? 'Copied Cursor'
                                          : 'Copy Cursor'}
                                      </button>
                                    </div>
                                    <pre>
                                      <code>{cursorSnippetPreview}</code>
                                    </pre>
                                  </section>
                                )}
                                {codexSnippetPreview && (
                                  <section>
                                    <div className="settings-user-mcp-snippet-heading">
                                      <strong>Codex TOML</strong>
                                      <button
                                        type="button"
                                        className="btn btn-sm btn-ghost"
                                        onClick={() =>
                                          copyMcpServerProviderSnippet(
                                            server.id,
                                            'codex',
                                            codexSnippetCopy
                                          )
                                        }
                                      >
                                        {copiedMcpServerSnippetKey === `${server.id}:codex`
                                          ? 'Copied Codex'
                                          : 'Copy Codex'}
                                      </button>
                                    </div>
                                    <pre>
                                      <code>{codexSnippetPreview}</code>
                                    </pre>
                                  </section>
                                )}
                              </div>
                            </details>
                          )}
                        </div>
                        <div className="settings-user-mcp-actions">
                          <label className="settings-user-mcp-toggle">
                            <span className="sr-only">Enable {server.name}</span>
                            <input
                              type="checkbox"
                              checked={server.enabled}
                              onChange={(event) =>
                                toggleUserMcpServer(server, event.target.checked)
                              }
                            />
                          </label>
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => copyMcpServerAuditJson(server)}
                          >
                            {copiedMcpServerId === server.id ? 'Copied audit' : 'Copy audit JSON'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => startEditMcpServer(server)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => deleteUserMcpServer(server.id)}
                          >
                            Delete
                          </button>
                        </div>
                      </article>
                    )
                  })}
                </div>
              )}
            </div>

            {mcpServerFormMode !== 'hidden' && (
              <div className="settings-group span-all settings-user-mcp-editor">
                <div className="settings-mcp-section-title">
                  <h4 className="sidebar-section-title" style={{ margin: 0 }}>
                    {mcpServerFormMode === 'edit' ? 'Edit MCP server' : 'Add MCP server'}
                  </h4>
                  <p className="settings-hint">
                    Environment and header values are stored in local app settings. Prefer
                    shell-level environment for secrets until encrypted MCP secrets land.
                  </p>
                </div>

                <div className="settings-user-mcp-form-grid">
                  <label className="settings-field">
                    <span>Name</span>
                    <input
                      className="settings-select"
                      value={mcpServerForm.name}
                      onChange={(event) =>
                        setMcpServerForm((prev) => ({ ...prev, name: event.target.value }))
                      }
                      placeholder="filesystem"
                    />
                  </label>
                  <label className="settings-field">
                    <span>Transport</span>
                    <select
                      className="settings-select"
                      value={mcpServerForm.transport}
                      onChange={(event) =>
                        setMcpServerForm((prev) => ({
                          ...prev,
                          transport: event.target.value as UserMcpServerTransport
                        }))
                      }
                    >
                      {USER_MCP_TRANSPORT_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="settings-field settings-user-mcp-field-wide">
                    <span>Description</span>
                    <input
                      className="settings-select"
                      value={mcpServerForm.description}
                      onChange={(event) =>
                        setMcpServerForm((prev) => ({
                          ...prev,
                          description: event.target.value
                        }))
                      }
                      placeholder="Project filesystem tools"
                    />
                  </label>
                  {mcpServerForm.transport === 'stdio' ? (
                    <label className="settings-field settings-user-mcp-field-wide">
                      <span>Command</span>
                      <input
                        className="settings-select"
                        value={mcpServerForm.command}
                        onChange={(event) =>
                          setMcpServerForm((prev) => ({ ...prev, command: event.target.value }))
                        }
                        placeholder="npx"
                      />
                    </label>
                  ) : (
                    <label className="settings-field settings-user-mcp-field-wide">
                      <span>URL</span>
                      <input
                        className="settings-select"
                        value={mcpServerForm.url}
                        onChange={(event) =>
                          setMcpServerForm((prev) => ({ ...prev, url: event.target.value }))
                        }
                        placeholder="http://127.0.0.1:3000/mcp"
                      />
                    </label>
                  )}
                  <label className="settings-field">
                    <span>Arguments</span>
                    <textarea
                      className="settings-user-mcp-textarea"
                      value={mcpServerForm.argsText}
                      onChange={(event) =>
                        setMcpServerForm((prev) => ({ ...prev, argsText: event.target.value }))
                      }
                      rows={4}
                      placeholder="@modelcontextprotocol/server-filesystem&#10;/Users/chris/project"
                      disabled={mcpServerForm.transport !== 'stdio'}
                    />
                  </label>
                  <label className="settings-field">
                    <span>Environment</span>
                    <textarea
                      className="settings-user-mcp-textarea"
                      value={mcpServerForm.envText}
                      onChange={(event) =>
                        setMcpServerForm((prev) => ({ ...prev, envText: event.target.value }))
                      }
                      rows={4}
                      placeholder="API_BASE_URL=http://127.0.0.1:3000"
                      disabled={mcpServerForm.transport !== 'stdio'}
                    />
                  </label>
                  {mcpServerForm.transport !== 'stdio' && (
                    <>
                      <label className="settings-field">
                        <span>Headers</span>
                        <textarea
                          className="settings-user-mcp-textarea"
                          value={mcpServerForm.headersText}
                          onChange={(event) =>
                            setMcpServerForm((prev) => ({
                              ...prev,
                              headersText: event.target.value
                            }))
                          }
                          rows={4}
                          placeholder="Authorization=Bearer ${TOKEN}&#10;X-Region=eu"
                        />
                      </label>
                      <label className="settings-field">
                        <span>Bearer token env var</span>
                        <input
                          className="settings-select"
                          value={mcpServerForm.bearerTokenEnvVar}
                          onChange={(event) =>
                            setMcpServerForm((prev) => ({
                              ...prev,
                              bearerTokenEnvVar: event.target.value
                            }))
                          }
                          placeholder="FIGMA_OAUTH_TOKEN"
                        />
                      </label>
                    </>
                  )}
                </div>

                <div className="settings-user-mcp-footer">
                  <label className="settings-effects-check-row">
                    <input
                      type="checkbox"
                      checked={mcpServerForm.enabled}
                      onChange={(event) =>
                        setMcpServerForm((prev) => ({ ...prev, enabled: event.target.checked }))
                      }
                    />
                    <span>
                      Enabled
                      <small>Disabled servers stay saved but are not offered to provider runs.</small>
                    </span>
                  </label>
                  <div className="settings-mcp-header-actions">
                    {mcpServerFormError && (
                      <span className="settings-user-mcp-error">{mcpServerFormError}</span>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={resetMcpServerForm}
                    >
                      Cancel
                    </button>
                    <button type="button" className="btn btn-sm" onClick={saveMcpServerForm}>
                      Save server
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'plugins' && (
          <div className="settings-mcp-page settings-plugins-page">
            <div className="settings-group span-all settings-mcp-overview">
              <div className="settings-mcp-header">
                <div>
                  <div className="settings-section-title-row">
                    <h4 className="sidebar-section-title" style={{ margin: 0 }}>
                      Plugins
                    </h4>
                    <span className="settings-editable-pill">Declarative</span>
                  </div>
                  <p className="settings-hint">
                    Capability bundles declare TaskWraith-owned presets, templates, metadata, and
                    permission requests. Install and enable state is stored separately from app
                    settings.
                  </p>
                </div>
              </div>

              <div className="settings-mcp-summary-grid">
                <article className="settings-mcp-summary-card">
                  <span>Available</span>
                  <strong>{pluginCatalog?.counts.available ?? pluginEntries.length}</strong>
                  <small>catalog entries</small>
                </article>
                <article className="settings-mcp-summary-card">
                  <span>Installed</span>
                  <strong>{installedPluginCount}</strong>
                  <small>state records</small>
                </article>
                <article className="settings-mcp-summary-card">
                  <span>Enabled</span>
                  <strong>{enabledPluginCount}</strong>
                  <small>still inert in V1</small>
                </article>
                <article className="settings-mcp-summary-card">
                  <span>Repairable</span>
                  <strong>{repairablePluginCount}</strong>
                  <small>needs setup input</small>
                </article>
                <article className="settings-mcp-summary-card">
                  <span>Updates</span>
                  <strong>{pluginUpdateCount}</strong>
                  <small>need review</small>
                </article>
                <article className="settings-mcp-summary-card">
                  <span>Blocked</span>
                  <strong>{blockedPluginCount}</strong>
                  <small>cannot enable</small>
                </article>
                <article className="settings-mcp-summary-card">
                  <span>Schema</span>
                  <strong>{pluginCatalog?.schemaVersion ?? 1}</strong>
                  <small>manifest V1</small>
                </article>
              </div>
            </div>

            <div className="settings-group span-all">
              <div className="settings-mcp-section-title">
                <h4 className="sidebar-section-title" style={{ margin: 0 }}>
                  Catalog
                </h4>
                <p className="settings-hint">
                  V1 plugins never run install scripts, register Electron code, or mutate provider
                  configuration directly.
                </p>
              </div>
              <div className="settings-audit-toolbar">
                <label className="settings-audit-search">
                  <span className="sr-only">Search plugins</span>
                  <input
                    className="settings-select"
                    value={pluginQuery}
                    onChange={(event) => setPluginQuery(event.target.value)}
                    aria-label="Search plugins"
                    placeholder="Search plugins, publishers, capabilities, categories"
                  />
                </label>
                <div className="settings-audit-toolbar-meta">
                  <span>
                    {filteredPluginEntries.length} of {pluginEntries.length} plugins
                  </span>
                  {pluginSearch && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => setPluginQuery('')}
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              {!pluginCatalog && !pluginCatalogError ? (
                <div className="settings-audit-empty">Loading plugin catalog...</div>
              ) : pluginCatalogError ? (
                <div className="settings-user-mcp-empty">
                  <strong>Plugin catalog unavailable</strong>
                  <p>{pluginCatalogError}</p>
                </div>
              ) : filteredPluginEntries.length === 0 ? (
                <div className="settings-audit-empty">No plugins match that search.</div>
              ) : (
                <div className="settings-user-mcp-list">
                  {filteredPluginEntries.map((entry: TaskWraithPluginCatalogEntry) => {
                    const pluginId = entry.manifest.id
                    const actionState = pluginSettingsActionState(
                      entry,
                      userMcpServers,
                      pluginBusyId
                    )
                    const busy = actionState.busy
                    const capabilities = entry.manifest.capabilities || []
                    const mcpPresets = entry.manifest.mcpServers || []
                    const category = entry.manifest.marketplace?.category || 'Uncategorized'
                    const tags = entry.manifest.marketplace?.tags || []
                    const updateAvailable = actionState.updateAvailable
                    const capabilityDiff = entry.update?.capabilityDiff
                    const provenance = pluginSettingsProvenancePayload(entry)
                    return (
                      <article key={pluginId} className="settings-user-mcp-row">
                        <div className="settings-user-mcp-main">
                          <strong>{entry.manifest.name}</strong>
                          <span>{entry.manifest.description}</span>
                          <div className="settings-mcp-server-meta">
                            <span>{entry.installed ? 'installed' : 'available'}</span>
                            <span>{entry.enabled ? 'enabled' : 'disabled'}</span>
                            {updateAvailable && <span>update available</span>}
                            <span>trust: {entry.trust.status}</span>
                            <span>{entry.source}</span>
                            <span>{entry.manifest.publisher}</span>
                            <span>{entry.manifest.version}</span>
                            <span>{category}</span>
                            <span>{entry.namespace}</span>
                            <span>{pluralizeCount(capabilities.length, 'capability')}</span>
                            {tags.slice(0, 4).map((tag) => (
                              <span key={tag}>{tag}</span>
                            ))}
                          </div>
                          <div
                            className={`settings-user-mcp-readiness settings-user-mcp-readiness-${entry.preflight.status}`}
                          >
                            <strong>{entry.preflight.status}</strong>
                            {updateAvailable && (
                              <span>
                                Update {entry.update?.installedVersion || 'installed'} to{' '}
                                {entry.update?.availableVersion}
                              </span>
                            )}
                            {entry.preflight.issues.length > 0 && (
                              <span>
                                {entry.preflight.issues
                                  .slice(0, 3)
                                  .map((issue) => issue.message)
                                  .join('; ')}
                              </span>
                            )}
                          </div>
                          {capabilities.length > 0 && (
                            <div className="settings-mcp-server-meta">
                              {capabilities.map((capability) => (
                                <span key={capability.id}>
                                  {capability.kind}: {capability.label}
                                </span>
                              ))}
                            </div>
                          )}
                          {mcpPresets.length > 0 && (
                            <div className="settings-mcp-server-meta">
                              {mcpPresets.map((preset) => {
                                const presetState = actionState.mcpPresets[preset.id]
                                return (
                                  <button
                                    key={preset.id}
                                    type="button"
                                    className="btn btn-sm btn-ghost"
                                    disabled={presetState?.disabled ?? true}
                                    onClick={() => addPluginMcpPreset(pluginId, preset.id)}
                                    title={`${preset.transport} MCP preset`}
                                  >
                                    {presetState?.materialized
                                      ? `Added ${preset.name}`
                                      : presetState?.busy
                                        ? `Adding ${preset.name}`
                                        : `Add MCP preset: ${preset.name}`}
                                  </button>
                                )
                              })}
                            </div>
                          )}
                          {updateAvailable && capabilityDiff && (
                            <details className="settings-user-mcp-config">
                              <summary>Capability changes</summary>
                              <pre>
                                <code>
                                  {JSON.stringify(
                                    {
                                      added: capabilityDiff.added,
                                      removed: capabilityDiff.removed,
                                      changed: capabilityDiff.changed
                                    },
                                    null,
                                    2
                                  )}
                                </code>
                              </pre>
                            </details>
                          )}
                          <details className="settings-user-mcp-config">
                            <summary>Provenance JSON</summary>
                            <pre>
                              <code>{JSON.stringify(provenance, null, 2)}</code>
                            </pre>
                          </details>
                        </div>
                        <div className="settings-user-mcp-actions">
                          {entry.installed && (
                            <label className="settings-user-mcp-toggle">
                              <span className="sr-only">Enable {entry.manifest.name}</span>
                              <input
                                type="checkbox"
                                checked={entry.enabled}
                                disabled={actionState.enableDisabled}
                                onChange={(event) =>
                                  setPluginEnabled(pluginId, event.target.checked)
                                }
                              />
                            </label>
                          )}
                          {!entry.installed ? (
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={actionState.installDisabled}
                              onClick={() => installPlugin(pluginId)}
                            >
                              {busy ? 'Installing' : 'Install'}
                            </button>
                          ) : (
                            <>
                              {updateAvailable && (
                                <button
                                  type="button"
                                  className="btn btn-sm"
                                  disabled={actionState.updateDisabled}
                                  onClick={() => updatePlugin(pluginId)}
                                >
                                  {busy ? 'Updating' : 'Update'}
                                </button>
                              )}
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                disabled={actionState.uninstallDisabled}
                                onClick={() => uninstallPlugin(pluginId)}
                              >
                                {busy ? 'Updating' : 'Uninstall'}
                              </button>
                            </>
                          )}
                        </div>
                      </article>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Key Commands ─────────────────────────────── */}
        {activeTab === 'key-commands' && (
          <div className="settings-key-commands-page">
            <div className="settings-group span-all settings-key-commands-overview">
              <div className="settings-key-commands-header">
                <div>
                  <div className="settings-section-title-row">
                    <h4 className="sidebar-section-title" style={{ margin: 0 }}>
                      Keyboard shortcuts
                    </h4>
                    <span className="settings-editable-pill">Editable</span>
                  </div>
                  <p className="settings-hint">
                    User-editable bindings for the app commands TaskWraith currently dispatches.
                    Conflicting shortcuts are blocked while recording.
                  </p>
                </div>
              </div>

              <div className="settings-key-commands-summary-grid">
                <article className="settings-key-commands-summary-card">
                  <span>Active bindings</span>
                  <strong>{activeKeyCommandCount}</strong>
                  <small>available now</small>
                </article>
                <article className="settings-key-commands-summary-card">
                  <span>Command groups</span>
                  <strong>{KEY_COMMAND_GROUPS.length}</strong>
                  <small>{KEY_COMMAND_GROUPS.map((group) => group.toLowerCase()).join(', ')}</small>
                </article>
                <article className="settings-key-commands-summary-card">
                  <span>Visible now</span>
                  <strong>{filteredKeyCommands.length}</strong>
                  <small>
                    {keyCommandSearch ? 'matching the current filter' : 'commands in the table'}
                  </small>
                </article>
                <article className="settings-key-commands-summary-card">
                  <span>Customization</span>
                  <strong>{customizedKeyCommandCount}</strong>
                  <small>
                    {conflictKeyCommandCount > 0
                      ? `${conflictKeyCommandCount} conflict${conflictKeyCommandCount === 1 ? '' : 's'}`
                      : 'custom bindings'}
                  </small>
                </article>
              </div>

              <div className="settings-audit-toolbar">
                <label className="settings-audit-search">
                  <span className="sr-only">Search key commands</span>
                  <input
                    className="settings-select"
                    value={keyCommandQuery}
                    onChange={(event) => setKeyCommandQuery(event.target.value)}
                    aria-label="Search key commands"
                    placeholder="Search commands, groups, keys"
                  />
                </label>
                <div className="settings-audit-toolbar-meta">
                  <span>
                    {filteredKeyCommands.length} of {KEY_COMMAND_DEFINITIONS.length} commands
                  </span>
                  {customizedKeyCommandCount > 0 && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => updateKeyCommandOverrides({})}
                    >
                      Reset all
                    </button>
                  )}
                  {keyCommandSearch && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => setKeyCommandQuery('')}
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="settings-group span-all">
              <div className="settings-key-command-groups">
                {KEY_COMMAND_GROUPS.map((group) => {
                  const groupCommands = filteredKeyCommands.filter(
                    (command) => command.group === group
                  )
                  if (groupCommands.length === 0) return null
                  return (
                    <section key={group} className="settings-key-command-group">
                      <div className="settings-key-command-group-title">
                        <strong>{group}</strong>
                        <span>{pluralizeCount(groupCommands.length, 'command')}</span>
                      </div>
                      <div className="settings-key-command-list">
                        {groupCommands.map((command) => (
                          <article key={command.id} className="settings-key-command-row">
                            <div className="settings-key-command-main">
                              <strong>{command.command}</strong>
                              <p>{command.description}</p>
                            </div>
                            <div
                              className="settings-key-command-keys"
                              aria-label={`${command.command} shortcut`}
                            >
                              {command.keys.map((key) => (
                                <kbd key={key} className="settings-key-command-keycap">
                                  {key}
                                </kbd>
                              ))}
                            </div>
                            <div className="settings-key-command-actions">
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                onClick={() => {
                                  setRecordingKeyCommandId(command.id)
                                  setKeyCommandRecordError('')
                                }}
                              >
                                {recordingKeyCommandId === command.id ? 'Press keys' : 'Record'}
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                onClick={() => resetKeyCommand(command.id)}
                                disabled={!command.customized}
                              >
                                Reset
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                onClick={() => unassignKeyCommand(command.id)}
                                disabled={command.binding === null}
                              >
                                Unassign
                              </button>
                            </div>
                            <span
                              className={`settings-key-command-status ${
                                command.conflict
                                  ? 'settings-key-command-status-conflict'
                                  : command.customized
                                    ? 'settings-key-command-status-custom'
                                    : 'settings-key-command-status-default'
                              }`}
                            >
                              {command.conflict
                                ? 'Conflict'
                                : command.customized
                                  ? 'Custom'
                                  : 'Default'}
                            </span>
                            {recordingKeyCommandId === command.id && (
                              <div className="settings-key-command-recording" role="status">
                                <span>
                                  {keyCommandRecordError || 'Press a new shortcut, or Esc to cancel.'}
                                </span>
                              </div>
                            )}
                            {command.conflict && (
                              <div className="settings-key-command-recording" role="status">
                                <span>Conflicts with {command.conflict.command}.</span>
                              </div>
                            )}
                          </article>
                        ))}
                      </div>
                    </section>
                  )
                })}
                {filteredKeyCommands.length === 0 && (
                  <div className="settings-audit-empty">No shortcuts match that search.</div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Safety & Privacy ─────────────────────────────── */}
        {activeTab === 'safety-privacy' && (
          <div className="settings-safety-page">
            <div className="settings-group span-all settings-safety-overview">
              <div className="settings-safety-header">
                <div>
                  <div className="settings-section-title-row">
                    <h4 className="sidebar-section-title" style={{ margin: 0 }}>
                      Safety & Privacy
                    </h4>
                    <span className="settings-scope-pill">Overview</span>
                  </div>
                  <p className="settings-hint">
                    A single read of TaskWraith&apos;s policy posture, provider data flow, saved
                    grants, mobile visibility, and local history controls.
                  </p>
                </div>
                <div className="settings-safety-header-actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => setActiveTab('approval-ledger')}
                  >
                    Open grants
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => setActiveTab('providers')}
                  >
                    Edit policies
                  </button>
                </div>
              </div>

              <div className="settings-safety-summary-grid">
                <article className="settings-safety-summary-card">
                  <span>Always-allow policies</span>
                  <strong>{riskyPolicyCount}</strong>
                  <small>{watchPolicyCount} workspace-granted policy rows</small>
                </article>
                <article className="settings-safety-summary-card">
                  <span>Saved workspace grants</span>
                  <strong>{agenticWorkspaceGrantCount}</strong>
                  <small>revoke in Approvals & Grants</small>
                </article>
                <article className="settings-safety-summary-card">
                  <span>Provider surfaces</span>
                  <strong>
                    {visibleProviderSurfaceCount}/{providerPrivacyRows.length}
                  </strong>
                  <small>available, signed in, or usage-visible</small>
                </article>
                <article className="settings-safety-summary-card">
                  <span>MCP bridge</span>
                  <strong>{geminiMcpBridgeEnabled ? connectedMcpProviderCount : 0}</strong>
                  <small>
                    {geminiMcpBridgeEnabled
                      ? `of ${providerMcpSummaries.length} provider surfaces reporting`
                      : 'disabled'}
                  </small>
                </article>
                <article className="settings-safety-summary-card">
                  <span>User MCP servers</span>
                  <strong>{userMcpServers.length}</strong>
                  <small>{activeUserMcpServerCount} active definitions</small>
                </article>
                {isSettingsTabVisible('pairing') && (
                  <article className="settings-safety-summary-card">
                    <span>Remote workspaces</span>
                    <strong>{remoteAllowlist.length}</strong>
                    <small>visible to paired devices when the bridge is active</small>
                  </article>
                )}
              </div>
            </div>

            <div className="settings-group span-all">
              <div className="settings-safety-section-title">
                <h4 className="sidebar-section-title" style={{ margin: 0 }}>
                  Policy posture
                </h4>
                <p className="settings-hint">
                  Scope badges show where each policy applies. Warning rows are the settings most
                  likely to surprise a user during autonomous runs.
                </p>
              </div>
              <div className="settings-safety-policy-list">
                {safetyPolicyRows.map((row) => (
                  <article
                    key={row.id}
                    className={`settings-safety-policy-row tone-${row.tone}`}
                  >
                    <div className="settings-safety-policy-main">
                      <strong>{row.label}</strong>
                      <p>{row.description}</p>
                    </div>
                    <div className="settings-safety-policy-meta">
                      <span className="settings-scope-pill">{row.scope}</span>
                      <span className="settings-risk-pill">{row.display}</span>
                    </div>
                  </article>
                ))}
              </div>
            </div>

            <div className="settings-group span-all">
              <div className="settings-safety-section-title">
                <h4 className="sidebar-section-title" style={{ margin: 0 }}>
                  Data surfaces
                </h4>
                <p className="settings-hint">
                  The overview does not duplicate every setting; it points to the page that owns
                  each surface.
                </p>
              </div>
              <div className="settings-safety-surface-grid">
                {safetySurfaceRows.map((row) => (
                  <article key={row.id} className="settings-safety-surface-card">
                    <div className="settings-safety-surface-card-header">
                      <strong>{row.label}</strong>
                      <span className="settings-scope-pill">{row.scope}</span>
                    </div>
                    <p>{row.detail}</p>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => setActiveTab(row.tab)}
                    >
                      {row.action}
                    </button>
                  </article>
                ))}
              </div>
            </div>

            <div className="settings-group span-all">
              <div className="settings-safety-section-title">
                <h4 className="sidebar-section-title" style={{ margin: 0 }}>
                  Provider data flow
                </h4>
                <p className="settings-hint">
                  Provider cards report local availability and sign-in state. Transcript content
                  still goes to whichever provider runtime you choose for a run.
                </p>
              </div>
              <div className="settings-safety-provider-grid">
                {providerPrivacyRows.map((row) => (
                  <article
                    key={row.label}
                    className={`settings-safety-provider-card variant-${row.summary.variant}`}
                  >
                    <strong>{row.label}</strong>
                    <span>{row.summary.statusText}</span>
                    <p>{row.summary.hint}</p>
                  </article>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── System (merged into the General tab — same `behavior` id) ── */}
        {/*
          Renders alongside the Behavior content above. The original
          standalone "System" tab carried just one settings group
          ("Product operations" — update channel, diagnostics, repair)
          which never warranted a tab of its own; folding it under
          General keeps the operational defaults in one place.
        */}
        {
          activeTab === 'behavior' && (
            <>
              <div className="settings-group settings-danger-zone span-all">
                <div className="settings-danger-zone-header">
                  <div className="settings-danger-zone-copy">
                    <h4 className="sidebar-section-title" style={{ margin: 0 }}>
                      Delete all chat history
                    </h4>
                    <p className="settings-hint">
                      Permanently remove local chat transcripts and run history from this Mac.
                      Workspaces and settings are left intact.
                    </p>
                  </div>
                  <div className="settings-danger-zone-actions">
                    <button
                      type="button"
                      className="settings-button settings-button-danger"
                      onClick={() => {
                        setDeleteHistoryError('')
                        setShowDeleteHistoryConfirm(true)
                      }}
                      disabled={!onDeleteAllChatHistory || deleteHistoryPending}
                    >
                      Delete chat history
                    </button>
                  </div>
                </div>
                {deleteHistoryError && (
                  <p className="settings-error" style={{ margin: 0 }}>
                    {deleteHistoryError}
                  </p>
                )}
              </div>

              <div className="settings-group span-all">
                <h4 className="sidebar-section-title" style={{ margin: 0 }}>
                  Product operations
                </h4>
                <label className="settings-service-row">
                  <span>Enable Auto-Update</span>
                  <input
                    type="checkbox"
                    checked={autoUpdateEnabled}
                    onChange={(e) => onChange({ autoUpdateEnabled: e.target.checked })}
                  />
                </label>
                <label className="settings-service-row">
                  <span>Update channel</span>
                  <select
                    className="settings-select"
                    value={updateChannel}
                    onChange={(e) =>
                      onChange({ updateChannel: e.target.value as ProductUpdateChannel })
                    }
                  >
                    {PRODUCT_UPDATE_CHANNEL_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="settings-option-list settings-option-list-inline">
                  <button
                    className="btn btn-sm"
                    type="button"
                    onClick={onRefreshProductOperationsStatus}
                  >
                    Refresh health
                  </button>
                  <button
                    className="btn btn-sm btn-ghost"
                    type="button"
                    onClick={onExportProductDiagnostics}
                  >
                    Export diagnostics
                  </button>
                  <button
                    className="btn btn-sm btn-ghost"
                    type="button"
                    onClick={onRepairProductInstall}
                  >
                    Repair install
                  </button>
                </div>
                {/* Phase G2: auto-update status pane. Self-contained so the
            SettingsPanel doesn't need to plumb the snapshot through —
            it reads it via the api binding on mount + listens for live
            updates. */}
                <UpdateStatusPane autoUpdateEnabled={autoUpdateEnabled} />

                <p className="settings-hint">
                  {productOperationsStatus
                    ? `Health is ${productOperationsStatus.overallStatus}; ${productOperationsStatus.counts.queuedRuns} queued, ${productOperationsStatus.counts.activeRuns} active, ${productOperationsStatus.recentCrashes.length} recent crash ${productOperationsStatus.recentCrashes.length === 1 ? 'record' : 'records'}.`
                    : 'Product operations health has not been checked yet.'}
                </p>
                {productOperationsStatus && (
                  <p className="settings-hint">
                    Release automation: {productOperationsStatus.releaseAutomation.status};{' '}
                    {productOperationsStatus.releaseAutomation.notarization.message}
                  </p>
                )}
              </div>
            </>
          ) /* end system */
        }

        {/* ── Remote Workspaces (Phase C4) ─────────────────────────────── */}
        {/*
          Remote Workspaces moved into the Devices tab below — it was
          a paired-device allowlist all along, so it lives next to the
          QR pair flow now. Activating the `remote-workspaces` tab id
          (legacy bookmark / restore path) falls through to no render
          here; the sidebar no longer surfaces the tab so this branch
          is effectively dead, but kept defensively until the type
          union sheds the id.
        */}

        {/* ── Workspaces (Codex Environments-style list) ───────────────── */}
        {activeTab === 'workspaces' && (
          <div className="settings-workspaces">
            <div className="settings-workspaces-header">
              <div className="settings-workspaces-header-copy">
                <h3 className="settings-workspaces-subtitle">Loaded workspaces</h3>
                <p className="settings-workspaces-description">
                  Every project folder you&apos;ve pointed TaskWraith at. Click a row to switch the
                  chat surface to that workspace; pin to keep it at the top of the sidebar; remove
                  to drop it from the list (chats inside the workspace stay on disk).
                </p>
              </div>
              {onSelectWorkspaceDialog && (
                <button
                  type="button"
                  className="btn btn-sm settings-workspaces-add"
                  onClick={onSelectWorkspaceDialog}
                  title="Add a new workspace folder"
                >
                  Add workspace
                </button>
              )}
            </div>
            {workspaces.length === 0 ? (
              <div className="settings-workspaces-empty" role="note">
                <MascotGhost size={30} />
                <strong>No workspaces yet.</strong>
                <span>
                  Use <em>Add workspace</em> above to point TaskWraith at your first project folder.
                </span>
              </div>
            ) : (
              <ul className="settings-workspaces-list">
                {workspaces.map((workspace) => {
                  const isActive = currentWorkspace?.id === workspace.id
                  const pathParts = workspace.path.split(/[\\/]/).filter(Boolean)
                  const compactPath =
                    pathParts.length > 3 ? `…/${pathParts.slice(-3).join('/')}` : workspace.path
                  return (
                    <li
                      key={workspace.id}
                      className={`settings-workspace-row ${isActive ? 'is-active' : ''} ${workspace.pinned ? 'is-pinned' : ''}`}
                    >
                      <button
                        type="button"
                        className="settings-workspace-tile"
                        onClick={() => {
                          if (!onSelectWorkspace) return
                          onSelectWorkspace(workspace)
                          onClose()
                        }}
                        title={`Open ${workspace.displayName} in the chat surface`}
                      >
                        <span className="settings-workspace-folder" aria-hidden>
                          <svg
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.3"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M2.8 4.4h4.1L7.3 5.6h6.5c.6 0 1.1.4 1.1 1v6.2c0 .6-.5 1-1.1 1H2.8C2.2 13.8 1.7 13.4 1.7 12.8V5.5c0-.6.5-1.1 1.1-1.1z" />
                          </svg>
                        </span>
                        <span className="settings-workspace-copy">
                          <span className="settings-workspace-name">{workspace.displayName}</span>
                          <span className="settings-workspace-path">{compactPath}</span>
                          {workspace.branch && (
                            <span className="settings-workspace-branch">
                              branch · {workspace.branch}
                            </span>
                          )}
                        </span>
                      </button>
                      <div className="settings-workspace-actions">
                        <WorkspaceRemoteAccessToggle
                          workspace={workspace}
                          entries={remoteAllowlist}
                          onChanged={refreshRemoteAllowlist}
                        />
                        {onTogglePinWorkspace && (
                          <button
                            type="button"
                            className={`btn btn-sm btn-ghost ${workspace.pinned ? 'is-pinned' : ''}`}
                            onClick={() => onTogglePinWorkspace(workspace.id)}
                            title={workspace.pinned ? 'Unpin workspace' : 'Pin workspace'}
                          >
                            {workspace.pinned ? 'Unpin' : 'Pin'}
                          </button>
                        )}
                        {onRemoveWorkspace && (
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => onRemoveWorkspace(workspace.id)}
                            title="Remove this workspace from the list"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )}

        {/* ── Pinned Messages ──────────────────────────────────────────── */}
        {activeTab === 'pinned-messages' && (
          <PinnedMessagesSettingsPage
            groups={pinnedMessageGroups}
            onOpenPinnedMessage={onOpenPinnedMessage}
          />
        )}

        {/* ── Channels (local/self-hosted message gateway) ─────────────── */}
        {activeTab === 'messages' && <MessagesBridgePanel />}

        {/* ── Roster (ensemble roster presets + per-participant editor) ──── */}
        {activeTab === 'roster' && (
          <RosterSettingsPanel
            composerStyle={composerStyle}
            agenticServices={agenticServices}
            grokAvailable={grokProviderAvailable}
            cursorAvailable={cursorProviderAvailable}
          />
        )}

        {/* ── Local servers (dev servers under workspaces) ─────────────── */}
        {activeTab === 'local-servers' && <LocalServersSettingsPanel />}

        {/* ── Model usage (cross-provider) ──────────────────────────────── */}
        {activeTab === 'model-usage' &&
          (() => {
            // Roll up cross-provider headline stats. We compute these inline
            // (vs. memoising) because the Settings takeover renders are
            // infrequent and the aggregate set is small (<20 entries).
            const allRunEntries = usageSummary.filter(
              (entry) => entry.model && entry.model !== 'usage limits'
            )
            const totalTokens = allRunEntries.reduce(
              (sum, entry) => sum + (entry.totalTokens || 0),
              0
            )
            const totalInputTokens = allRunEntries.reduce(
              (sum, entry) => sum + (entry.inputTokens || 0),
              0
            )
            const totalOutputTokens = allRunEntries.reduce(
              (sum, entry) => sum + (entry.outputTokens || 0),
              0
            )
            const totalRuns = allRunEntries.reduce((sum, entry) => sum + (entry.runs || 0), 0)
            const providerCount = new Set(allRunEntries.map((entry) => entry.provider)).size
            const modelCount = allRunEntries.length
            const comparisonEntries = [...allRunEntries].sort(
              (a, b) => b.totalTokens - a.totalTokens || b.runs - a.runs
            )
            const comparisonTokenTotal = comparisonEntries.reduce(
              (sum, entry) => sum + (entry.totalTokens || 0),
              0
            )
            const quotaEntries = usageSummary.filter((entry) => entry.model === 'usage limits')
            const telemetryEntries = quotaEntries.filter(
              (entry) => (entry.windows?.length || 0) > 0 || (entry.balances?.length || 0) > 0
            )
            const providerLabel = (provider: ProviderId): string => {
              if (provider === 'codex') return 'Codex'
              if (provider === 'claude') return 'Claude'
              if (provider === 'kimi') return 'Kimi'
              if (provider === 'grok') return 'Grok'
              if (provider === 'cursor') return 'Cursor'
              return 'Gemini'
            }
            // Rough cost estimate gated on whether the per-row stats
            // carried explicit cost data. Skipped for v1 — keep the
            // tile set focused on counts the user can verify against
            // their provider dashboards.
            const formatLargeNumber = (value: number): string => {
              if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`
              if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
              if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
              return String(Math.round(value))
            }
            const formatBalanceValue = (amount: number, unit: string | undefined): string => {
              const cleanUnit = String(unit || '').trim()
              if (cleanUnit === '$' || cleanUnit.toLowerCase() === 'usd') {
                return `$${amount.toLocaleString(undefined, {
                  minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
                  maximumFractionDigits: 2
                })}`
              }
              const value =
                Math.abs(amount) >= 1000
                  ? formatLargeNumber(amount)
                  : amount.toLocaleString(undefined, {
                      maximumFractionDigits: amount % 1 === 0 ? 0 : 2
                    })
              return cleanUnit ? `${value} ${cleanUnit}` : value
            }
            const formatQuotaSource = (source: string | undefined): string =>
              source ? source.replace(/[-_]/g, ' ') : 'live snapshot'
            const formatFetchedAt = (timestamp: string | undefined): string => {
              if (!timestamp) return ''
              const date = new Date(timestamp)
              if (!Number.isFinite(date.getTime())) return ''
              return date.toLocaleString([], {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
              })
            }
            return (
              <div className="settings-model-usage">
                <p className="settings-model-usage-description">
                  Cross-provider token + quota dashboard. Pulled from the same aggregate the welcome
                  screen + sidebar consume. To view invoices or change payment methods, visit each
                  provider&apos;s billing surface directly — TaskWraith never proxies credentials.
                </p>

                {/* Headline tiles — at-a-glance numbers above the meters. */}
                <div className="settings-model-usage-tiles">
                  <div className="settings-model-usage-tile">
                    <span className="settings-model-usage-tile-label">Total tokens</span>
                    <span className="settings-model-usage-tile-value">
                      {formatLargeNumber(totalTokens)}
                    </span>
                    <span className="settings-model-usage-tile-meta">
                      {formatLargeNumber(totalInputTokens)} in ·{' '}
                      {formatLargeNumber(totalOutputTokens)} out
                    </span>
                  </div>
                  <div className="settings-model-usage-tile">
                    <span className="settings-model-usage-tile-label">Runs</span>
                    <span className="settings-model-usage-tile-value">
                      {formatLargeNumber(totalRuns)}
                    </span>
                    <span className="settings-model-usage-tile-meta">across all chats</span>
                  </div>
                  <div className="settings-model-usage-tile">
                    <span className="settings-model-usage-tile-label">Providers</span>
                    <span className="settings-model-usage-tile-value">{providerCount}</span>
                    <span className="settings-model-usage-tile-meta">
                      {modelCount} model{modelCount === 1 ? '' : 's'} tracked
                    </span>
                  </div>
                </div>

                {/* Existing sidebar card — quota meters per provider + the
                  30-day usage heatmap baked in. Wrapped in a max-width
                  container so it inherits the same legibility budget as
                  the rest of the takeover content. */}
                <div className="settings-model-usage-card">
                  <ModelUsageCard usageSummary={usageSummary} />
                </div>

                {/* Comprehensive per-provider / per-model table: token +
                  estimated-cost columns across 1H / 24H / 7D / 30D / 90D, with
                  an "External Usage" toggle to fold in provider activity
                  tracked outside TaskWraith. Self-fetches its records + rates
                  and self-persists the toggle; currency/overestimate come from
                  the same settings the sidebar card uses. */}
                <ModelUsageSettingsTable
                  currency={currency}
                  overestimatePercent={currencyOverestimatePercent}
                />

                {comparisonEntries.length > 0 && (
                  <section className="settings-model-comparisons" aria-label="Model comparisons">
                    <div className="settings-model-comparisons-header">
                      <span>Model Comparisons</span>
                      <span>Last 30 days</span>
                    </div>
                    <div className="settings-model-comparison-list">
                      {comparisonEntries.map((entry) => {
                        const percent =
                          comparisonTokenTotal > 0
                            ? Math.max(
                                0,
                                Math.min(100, (entry.totalTokens / comparisonTokenTotal) * 100)
                              )
                            : 0
                        const fillWidth = `${Math.max(2, percent)}%`
                        return (
                          <div
                            key={`${entry.provider}-${entry.model}`}
                            className={`settings-model-comparison-row provider-${entry.provider}`}
                          >
                            <div className="settings-model-comparison-header">
                              <span
                                className={`settings-model-comparison-dot provider-${entry.provider}`}
                                aria-hidden
                              />
                              {/*
                              1.0.5-EW50 — Humanise the CLI/API model id via
                              the shared `humaniseModelId` resolver so the
                              Settings → Model Usage list reads as
                              "Gemini 3 Flash Preview" instead of
                              "gemini-3-flash-preview". Tooltip keeps the
                              raw id for power-users who want the canonical
                              CLI name. Falls back to the raw id when no
                              mapping exists (e.g. brand-new models the
                              table hasn't been extended for yet).
                            */}
                              <span className="settings-model-comparison-name" title={entry.model}>
                                {humaniseModelId(entry.provider, entry.model)}
                              </span>
                              <span className="settings-model-comparison-tokens">
                                {formatLargeNumber(entry.inputTokens)} in ·{' '}
                                {formatLargeNumber(entry.outputTokens)} out
                              </span>
                              <strong className="settings-model-comparison-percent">
                                {percent.toFixed(1)}%
                              </strong>
                            </div>
                            <div
                              className="settings-model-comparison-track"
                              role="progressbar"
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-valuenow={percent}
                              aria-label={`${humaniseModelId(entry.provider, entry.model)} accounts for ${percent.toFixed(1)}% of model usage in the last 30 days`}
                            >
                              <span
                                className={`settings-model-comparison-fill provider-${entry.provider}`}
                                style={{ width: fillWidth }}
                              />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </section>
                )}

                {(telemetryEntries.length > 0 || grokProviderAvailable) && (
                  <section
                    className="settings-provider-telemetry"
                    aria-label="Provider quota and balance telemetry"
                  >
                    <div className="settings-provider-telemetry-header">
                      <span>Provider Telemetry</span>
                      <span>Quota windows · balances</span>
                    </div>
                    <div className="settings-provider-telemetry-grid">
                      {telemetryEntries.map((entry) => {
                        const fetchedAt = formatFetchedAt(entry.quotaFetchedAt)
                        return (
                          <article
                            key={`${entry.provider}-telemetry`}
                            className={`settings-provider-telemetry-card provider-${entry.provider}`}
                          >
                            <div className="settings-provider-telemetry-title">
                              <span
                                className={`settings-model-comparison-dot provider-${entry.provider}`}
                                aria-hidden
                              />
                              <strong>{providerLabel(entry.provider)}</strong>
                              {entry.quotaStale && <span>Stale</span>}
                            </div>
                            <div className="settings-provider-telemetry-meta">
                              <span>
                                {pluralizeCount(entry.windows?.length || 0, 'quota window')}
                              </span>
                              <span>{formatQuotaSource(entry.quotaSource)}</span>
                              {fetchedAt && <span>{fetchedAt}</span>}
                            </div>
                            {(entry.balances?.length || 0) > 0 ? (
                              <div className="settings-provider-balance-list">
                                {entry.balances?.map((balance) => (
                                  <div key={balance.id} className="settings-provider-balance">
                                    <span>{balance.label}</span>
                                    <strong>
                                      {formatBalanceValue(balance.amount, balance.unit)}
                                    </strong>
                                    {balance.subtitle && <small>{balance.subtitle}</small>}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="settings-provider-balance settings-provider-balance-empty">
                                <span>Balance</span>
                                <strong>Unavailable</strong>
                              </div>
                            )}
                          </article>
                        )
                      })}
                      {/* Grok credits come from the PTY probe, not usageSummary,
                       * so render a probe-driven card as a sibling of the
                       * quota-window cards (CRUX15). */}
                      {grokProviderAvailable && <GrokTelemetryCard />}
                    </div>
                  </section>
                )}

                {usageSummary.length === 0 && (
                  <div className="settings-model-usage-empty" role="note">
                    <strong>No usage data yet.</strong>
                    <span>
                      Start a chat with any provider to populate the meters — TaskWraith begins
                      tracking on the first completed run.
                    </span>
                  </div>
                )}

                <section
                  className="settings-model-usage-activity-stack"
                  aria-label="90-day activity and token usage"
                >
                  <div className="settings-model-usage-activity-header">
                    <span>90-day activity</span>
                    <span>Workspace · TaskWraith · External</span>
                  </div>
                  <div className="settings-model-usage-activity-list">
                    {currentWorkspace?.path && (
                      <WorkspaceActivityHeatmap
                        workspacePath={currentWorkspace.path}
                        dayCount={90}
                        className="usage-heatmap--settings-activity"
                      />
                    )}
                    <UsageHeatmap
                      dayCount={90}
                      title="TaskWraith Activity"
                      showProviderFilter
                      className="usage-heatmap--settings-activity"
                    />
                    <UsageHeatmap
                      dayCount={90}
                      usageSource="external"
                      title="External Activity"
                      showProviderFilter
                      className="usage-heatmap--settings-activity"
                    />
                    <TokenUsageChart
                      title="TaskWraith Tokens"
                      records={usageRecords}
                      dayCount={90}
                      showProviderFilter
                      className="token-usage-chart--settings"
                    />
                    <TokenUsageChart
                      title="External Tokens"
                      source="external"
                      dayCount={90}
                      showProviderFilter
                      className="token-usage-chart--settings"
                    />
                  </div>
                </section>

                <ProviderApiRatesSettingsTable />
                <ModelContextLengthsSettingsTable />
              </div>
            )
          })()}

        {/* ── Approvals (Phase E2 + admin grants) ──────────────────────── */}
        {activeTab === 'approval-ledger' && (
          <ApprovalLedgerPanel
            workspaceGrants={agenticWorkspaceGrants}
            onRevokeWorkspaceGrant={(grant) =>
              onRemoveAgenticWorkspaceGrant?.(grant.provider, grant.workspacePath, grant.service)
            }
            currentWorkspacePath={currentWorkspace?.path ?? null}
          />
        )}

        {/* ── Pairing (post-1.0.2: folded in from the legacy modal sheet) ── */}
        {activeTab === 'pairing' && <PairingPage />}

        {/* ── Shares (human collaboration lifecycle) ─────────────────────── */}
        {activeTab === 'shares' && <SharesPanel />}
      </div>
      {/* end settings-panel-content */}
    </div>
  )
}

interface ApprovalTimeoutFieldProps {
  label: string
  valueMs: number
  disabled?: boolean
  onChange: (ms: number) => void
}

/**
 * ApprovalTimeoutField — labeled seconds input for the per-provider
 * timeout settings. Displays seconds (more readable than ms) but
 * persists ms in the underlying setting.
 */
function ApprovalTimeoutField({
  label,
  valueMs,
  disabled,
  onChange
}: ApprovalTimeoutFieldProps): React.JSX.Element {
  const [draftSec, setDraftSec] = useState<string>(String(Math.round(valueMs / 1000)))

  // Sync local draft when the upstream value changes (e.g. parent
  // re-renders with a fresh settings snapshot). Defer to microtask so
  // React's cascading-render lint guard treats the setState as a
  // detached update rather than a synchronous one.
  useEffect(() => {
    void Promise.resolve().then(() => setDraftSec(String(Math.round(valueMs / 1000))))
  }, [valueMs])

  const commit = (raw: string): void => {
    const parsed = Math.round(Number(raw))
    if (!Number.isFinite(parsed) || parsed <= 0) {
      // Reset to last valid value rather than persisting a bad number.
      setDraftSec(String(Math.round(valueMs / 1000)))
      return
    }
    // Floor + ceil bounds — keep timeouts in a sensible range.
    const clamped = Math.max(5, Math.min(parsed, 3600))
    setDraftSec(String(clamped))
    onChange(clamped * 1000)
  }

  return (
    <label className="approval-timeout-field">
      <span className="approval-timeout-field-label">{label}</span>
      <span className="approval-timeout-field-input-wrap">
        <input
          type="number"
          min={5}
          max={3600}
          step={5}
          className="approval-timeout-field-input"
          value={draftSec}
          disabled={disabled}
          onChange={(e) => setDraftSec(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commit((e.target as HTMLInputElement).value)
            }
          }}
        />
        <span className="approval-timeout-field-unit">s</span>
      </span>
    </label>
  )
}
