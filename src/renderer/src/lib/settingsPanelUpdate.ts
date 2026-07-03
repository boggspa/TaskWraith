import type {
  AppSettings,
  AgenticServicesSettings,
  NativeSubAgentRequestPolicy,
  CodexSandboxFallbackMode,
  ProductUpdateChannel
} from '../../../main/store/types'

export type SettingsPanelUpdate = {
  mode?: AppSettings['appearanceMode']
  visualEffectStyle?: AppSettings['visualEffectStyle']
  themeAppearance?: AppSettings['themeAppearance']
  themeCornerStyle?: AppSettings['themeCornerStyle']
  themeAccentStyle?: AppSettings['themeAccentStyle']
  toolIconAccent?: AppSettings['toolIconAccent']
  userBubbleColor?: AppSettings['userBubbleColor']
  appIconVariant?: AppSettings['appIconVariant']
  promptSurfaceStyle?: AppSettings['promptSurfaceStyle']
  composerStyle?: AppSettings['composerStyle']
  transcriptFontFamily?: AppSettings['transcriptFontFamily']
  composerFontFamily?: AppSettings['composerFontFamily']
  keyCommandBindings?: AppSettings['keyCommandBindings']
  funFxEnabled?: boolean
  funFxMode?: AppSettings['funFxMode']
  advancedFx?: AppSettings['advancedFx']
  reduceTransparency?: boolean
  reduceMotion?: boolean
  compactDensity?: boolean
  liveActivityViewport?: boolean
  sidebarOpacity?: AppSettings['sidebarOpacity']
  mainPaneOpacity?: AppSettings['mainPaneOpacity']
  sidebarOpacityOverride?: AppSettings['sidebarOpacityOverride']
  mainPaneOpacityOverride?: AppSettings['mainPaneOpacityOverride']
  geminiCheckpointingEnabled?: boolean
  chatContextTurns?: number
  /** Display name used to greet the user in New General Chat (blank = omit). */
  userName?: AppSettings['userName']
  /** 1.0.5-EW25 — Display currency for cost / token-spend chips. */
  currency?: AppSettings['currency']
  /** 1.0.5-EW34 — Conservative-overestimate bias percent (0–25). */
  currencyOverestimatePercent?: AppSettings['currencyOverestimatePercent']
  /** Settings → General toggle for Task Complete / Final Summary cards. */
  showRunCompleteSummary?: AppSettings['showRunCompleteSummary']
  hostAutoCompactEnabled?: AppSettings['hostAutoCompactEnabled']
  /** Settings → General toggle: collapse older Ensemble rounds into cards. */
  ensembleCollapseOlderRounds?: AppSettings['ensembleCollapseOlderRounds']
  /** Sidebar Model Usage card view ('plan' quota meters | 'spend' API cost). */
  modelUsagePanelView?: AppSettings['modelUsagePanelView']
  /** Settings → Model usage table "External Usage" toggle (provider-wide vs
   * TaskWraith-only). */
  modelUsageExternalUsage?: AppSettings['modelUsageExternalUsage']
  /**
   * 1.0.5-EW49 — Dashboard statistics preferences (per-stat
   * visibility map + global "reset all" timestamp). See
   * AppSettings.dashboardStatPrefs for the persisted shape.
   */
  dashboardStatPrefs?: AppSettings['dashboardStatPrefs']
  welcomeHeatmapPrefs?: AppSettings['welcomeHeatmapPrefs']
  providerRunPauses?: AppSettings['providerRunPauses']
  /** 1.0.5-EW26 — Kimi compatibility filter. */
  kimiSanitiserEnabled?: AppSettings['kimiSanitiserEnabled']
  kimiSanitiserCustomKeywords?: AppSettings['kimiSanitiserCustomKeywords']
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
  autoUpdateEnabled?: boolean
  updateChannel?: ProductUpdateChannel
  approvalTimeouts?: AppSettings['approvalTimeouts']
  auditRetention?: AppSettings['auditRetention']
}
