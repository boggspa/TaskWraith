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
  themeAccentColor?: AppSettings['themeAccentColor']
  diffStatColors?: AppSettings['diffStatColors']
  appIconVariant?: AppSettings['appIconVariant']
  promptSurfaceStyle?: AppSettings['promptSurfaceStyle']
  fanoutLaneLayout?: AppSettings['fanoutLaneLayout']
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
  /** Extra directories searched first when resolving any external CLI. */
  cliPathDirectories?: AppSettings['cliPathDirectories']
  /** 1.0.5-EW25 — Display currency for cost / token-spend chips. */
  currency?: AppSettings['currency']
  /** 1.0.5-EW34 — Conservative-overestimate bias percent (0–25). */
  currencyOverestimatePercent?: AppSettings['currencyOverestimatePercent']
  /** Settings → General toggle for Task Complete / Final Summary cards. */
  showRunCompleteSummary?: AppSettings['showRunCompleteSummary']
  /** Settings → General toggle for on-device AI close-out summaries. */
  closeoutAiSummaryEnabled?: AppSettings['closeoutAiSummaryEnabled']
  /** Settings → General toggle for the bounded on-device continuation ranker. */
  composerContinuationAiEnabled?: AppSettings['composerContinuationAiEnabled']
  hostAutoCompactEnabled?: AppSettings['hostAutoCompactEnabled']
  /** Settings → General toggle: collapse older Ensemble rounds into cards. */
  ensembleCollapseOlderRounds?: AppSettings['ensembleCollapseOlderRounds']
  /** Settings → General: max workers accepted by `delegate_wave` (2–64, default 8). */
  maxWaveAgents?: AppSettings['maxWaveAgents']
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
  /** Explicit, informed-risk opt-in for the buried AntiGravity setup card. */
  antigravityEnabled?: AppSettings['antigravityEnabled']
  antigravityOptInAcceptedAt?: AppSettings['antigravityOptInAcceptedAt']
  antigravityGeminiApiDisclosureAcceptedAt?: AppSettings['antigravityGeminiApiDisclosureAcceptedAt']
  antigravityGeminiApiMonthlySpendCapUsd?: AppSettings['antigravityGeminiApiMonthlySpendCapUsd']
  claudeBinaryPath?: string
  kimiBinaryPath?: string
  ollamaBaseUrl?: string
  ollamaDefaultModel?: string
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
