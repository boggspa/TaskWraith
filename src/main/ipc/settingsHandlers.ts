import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { SettingsService } from '../services/SettingsService'
import type {
  ExtensionSecretMutationResult,
  ExtensionSecretRef,
  ExtensionSecretStatusSnapshot
} from '../ExtensionSecretStore'
import type {
  AppSettings,
  HandoffCard,
  HandoffCardFilter,
  PromptCacheCapability,
  PromptCacheSettings,
  ProviderId,
  RuntimeProfile
} from '../store/types'
import { canPersistPlaintextFieldValue } from '../PlaintextSecretPolicy'

export interface RuntimeProfileSecretValues {
  env?: Record<string, string>
}

export type HandoffCardSenderScope = { kind: 'all' } | { kind: 'chat'; chatId: string }
export type SettingsSenderScope =
  | { kind: 'main' }
  | { kind: 'chat'; workspacePath?: string }
  | { kind: 'utility' }

const runtimeProfileEnvNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/

function rendererSafeFieldMap(
  fields: Record<string, string> | undefined,
  secretRefs: readonly string[] | undefined,
  kind: 'env' | 'header'
): Record<string, string> | undefined {
  if (!fields) return undefined
  const declaredSecrets = new Set(secretRefs ?? [])
  const safeEntries = Object.entries(fields).filter(
    ([key, value]) =>
      !declaredSecrets.has(key) && canPersistPlaintextFieldValue({ key, value, kind })
  )
  return safeEntries.length > 0 ? Object.fromEntries(safeEntries) : undefined
}

/**
 * Renderer settings are a UI preference/status snapshot, not a credential
 * transport. Keep non-secret metadata that existing Settings surfaces use,
 * while credentials remain reachable only through their dedicated status and
 * mutation IPCs.
 */
export function rendererSafeSettings(settings: AppSettings): AppSettings {
  const {
    claudeApiKey: _claudeApiKey,
    kimiApiKey: _kimiApiKey,
    geminiAuthProfiles,
    codexUsageCredential,
    userMcpServers,
    apnsConfig,
    imageGeneration,
    tailscaleOAuth,
    ...safeSettings
  } = settings

  return {
    ...safeSettings,
    ...(geminiAuthProfiles
      ? {
          geminiAuthProfiles: geminiAuthProfiles.map((profile) => {
            const { encryptedApiKey: _encryptedApiKey, ...safeProfile } = profile
            return safeProfile
          })
        }
      : {}),
    ...(codexUsageCredential
      ? {
          codexUsageCredential: (() => {
            const { encryptedAccessToken: _encryptedAccessToken, ...status } =
              codexUsageCredential
            return status
          })()
        }
      : {}),
    ...(userMcpServers
      ? {
          userMcpServers: userMcpServers.map((server) => {
            const { env, headers, ...safeServer } = server
            const safeEnv = rendererSafeFieldMap(env, server.secretRefs?.env, 'env')
            const safeHeaders = rendererSafeFieldMap(
              headers,
              server.secretRefs?.headers,
              'header'
            )
            return {
              ...safeServer,
              ...(safeEnv ? { env: safeEnv } : {}),
              ...(safeHeaders ? { headers: safeHeaders } : {})
            }
          })
        }
      : {}),
    ...(apnsConfig
      ? {
          apnsConfig: (() => {
            const { encryptedAuthKey: _encryptedAuthKey, ...status } = apnsConfig
            return status
          })()
        }
      : {}),
    ...(imageGeneration
      ? {
          imageGeneration: (() => {
            const { encryptedKeys: _encryptedKeys, ...status } = imageGeneration
            return status
          })()
        }
      : {}),
    ...(tailscaleOAuth
      ? {
          tailscaleOAuth: (() => {
            const { encryptedClientSecret: _encryptedClientSecret, ...status } = tailscaleOAuth
            return status
          })()
        }
      : {})
  }
}

function rendererAppearanceSettings(settings: AppSettings): AppSettings {
  return {
    appearanceMode: settings.appearanceMode,
    visualEffectStyle: settings.visualEffectStyle,
    themeAppearance: settings.themeAppearance,
    themeCornerStyle: settings.themeCornerStyle,
    themeAccentStyle: settings.themeAccentStyle,
    toolIconAccent: settings.toolIconAccent,
    userBubbleColor: settings.userBubbleColor,
    diffStatColors: settings.diffStatColors,
    appIconVariant: settings.appIconVariant,
    promptSurfaceStyle: settings.promptSurfaceStyle,
    composerStyle: settings.composerStyle,
    transcriptFontFamily: settings.transcriptFontFamily,
    composerFontFamily: settings.composerFontFamily,
    funFxEnabled: settings.funFxEnabled,
    funFxMode: settings.funFxMode,
    advancedFx: settings.advancedFx,
    reduceTransparency: settings.reduceTransparency,
    reduceMotion: settings.reduceMotion,
    compactDensity: settings.compactDensity,
    liveActivityViewport: settings.liveActivityViewport,
    showInspector: false,
    inspectorWidth: settings.inspectorWidth,
    sidebarWidth: settings.sidebarWidth,
    sidebarOpacity: settings.sidebarOpacity,
    mainPaneOpacity: settings.mainPaneOpacity,
    sidebarOpacityOverride: settings.sidebarOpacityOverride,
    mainPaneOpacityOverride: settings.mainPaneOpacityOverride
  } as AppSettings
}

function rendererChatSettings(
  settings: AppSettings,
  workspacePath: string | undefined,
  workspacePathsEqual: (left: string, right: string) => boolean
): AppSettings {
  const matchingWorkspaceGrants = workspacePath
    ? (settings.agenticWorkspaceGrants || [])
        .filter((grant) => workspacePathsEqual(grant.workspacePath, workspacePath))
        .map((grant) => ({
          id: grant.id,
          workspacePath: grant.workspacePath,
          provider: grant.provider,
          service: grant.service,
          createdAt: grant.createdAt,
          updatedAt: grant.updatedAt,
          ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
          ...(grant.expiresOn ? { expiresOn: grant.expiresOn } : {})
        }))
    : []
  const matchingElevationAcknowledgements = workspacePath
    ? Object.fromEntries(
        Object.entries(settings.approvalModeElevationAcknowledgements || {}).filter(([key]) => {
          const separatorIndex = key.lastIndexOf('|')
          if (separatorIndex <= 0) return false
          return workspacePathsEqual(key.slice(0, separatorIndex), workspacePath)
        })
      )
    : {}
  const providerRunPauses = settings.providerRunPauses
    ? Object.fromEntries(
        Object.entries(settings.providerRunPauses).map(([provider, pause]) => [
          provider,
          pause
            ? {
                paused: pause.paused,
                ...(pause.until ? { until: pause.until } : {}),
                ...(pause.reason ? { reason: pause.reason } : {}),
                ...(pause.reroute?.provider
                  ? { reroute: { provider: pause.reroute.provider } }
                  : {}),
                ...(pause.updatedAt ? { updatedAt: pause.updatedAt } : {})
              }
            : pause
        ])
      )
    : undefined
  const services = settings.agenticServices

  return {
    ...rendererAppearanceSettings(settings),
    ...(settings.activeProvider ? { activeProvider: settings.activeProvider } : {}),
    ...(providerRunPauses ? { providerRunPauses } : {}),
    ...(settings.ollamaDefaultModel ? { ollamaDefaultModel: settings.ollamaDefaultModel } : {}),
    ensembleModeEnabled: settings.ensembleModeEnabled,
    geminiCheckpointingEnabled: settings.geminiCheckpointingEnabled,
    chatContextTurns: settings.chatContextTurns,
    ...(settings.keyCommandBindings ? { keyCommandBindings: settings.keyCommandBindings } : {}),
    currency: settings.currency,
    ...(settings.currencyOverestimatePercent !== undefined
      ? { currencyOverestimatePercent: settings.currencyOverestimatePercent }
      : {}),
    ...(settings.showRunCompleteSummary !== undefined
      ? { showRunCompleteSummary: settings.showRunCompleteSummary }
      : {}),
    ...(settings.closeoutAiSummaryEnabled !== undefined
      ? { closeoutAiSummaryEnabled: settings.closeoutAiSummaryEnabled }
      : {}),
    ...(settings.hostAutoCompactEnabled !== undefined
      ? { hostAutoCompactEnabled: settings.hostAutoCompactEnabled }
      : {}),
    ...(settings.ensembleCollapseOlderRounds !== undefined
      ? { ensembleCollapseOlderRounds: settings.ensembleCollapseOlderRounds }
      : {}),
    ...(settings.modelUsagePanelView
      ? { modelUsagePanelView: settings.modelUsagePanelView }
      : {}),
    ...(settings.dashboardStatPrefs ? { dashboardStatPrefs: settings.dashboardStatPrefs } : {}),
    ...(settings.welcomeHeatmapPrefs
      ? { welcomeHeatmapPrefs: settings.welcomeHeatmapPrefs }
      : {}),
    agenticServices: {
      shellCommands: services.shellCommands,
      fileChanges: services.fileChanges,
      ...(services.externalPublish ? { externalPublish: services.externalPublish } : {}),
      mcpTools: services.mcpTools,
      subThreadDelegation: services.subThreadDelegation,
      canvasInteraction: services.canvasInteraction,
      canvasEval: services.canvasEval,
      ...(services.crossThreadRead ? { crossThreadRead: services.crossThreadRead } : {}),
      ...(services.mediaEditing ? { mediaEditing: services.mediaEditing } : {}),
      ...(services.mediaRecording ? { mediaRecording: services.mediaRecording } : {}),
      networkAccess: services.networkAccess
    },
    ...(settings.nativeSubAgentRequests
      ? { nativeSubAgentRequests: settings.nativeSubAgentRequests }
      : {}),
    autoResumeParentOnSubThreadCompletion: settings.autoResumeParentOnSubThreadCompletion,
    ...(settings.approvalTimeouts
      ? {
          approvalTimeouts: {
            enabled: settings.approvalTimeouts.enabled,
            perProviderMs: { ...settings.approvalTimeouts.perProviderMs },
            mainAuthorityMs: settings.approvalTimeouts.mainAuthorityMs
          }
        }
      : {}),
    agenticWorkspaceGrants: matchingWorkspaceGrants,
    ...(Object.keys(matchingElevationAcknowledgements).length > 0
      ? { approvalModeElevationAcknowledgements: matchingElevationAcknowledgements }
      : {})
  } as AppSettings
}

export function rendererSettingsForSender(
  settings: AppSettings,
  scope: SettingsSenderScope,
  workspacePathsEqual: (left: string, right: string) => boolean
): AppSettings {
  if (scope.kind === 'main') return rendererSafeSettings(settings)
  if (scope.kind === 'utility') return rendererAppearanceSettings(settings)
  const workspacePath = scope.workspacePath?.trim()
  return rendererChatSettings(settings, workspacePath, workspacePathsEqual)
}

export function rendererSafeRuntimeProfile(
  profile: RuntimeProfile,
  detail: 'main' | 'metadata' = 'main'
): RuntimeProfile {
  if (detail === 'metadata') {
    return {
      id: profile.id,
      name: profile.name,
      provider: profile.provider,
      scope: profile.scope,
      workspaceMode: profile.workspaceMode,
      networkPolicy: profile.networkPolicy,
      persistence: profile.persistence,
      ...(profile.builtin !== undefined ? { builtin: profile.builtin } : {}),
      ...(profile.pluginProvenance ? { pluginProvenance: profile.pluginProvenance } : {}),
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt
    } as RuntimeProfile
  }
  return {
    ...profile,
    env: rendererSafeFieldMap(profile.env, profile.secretRefs?.env, 'env') ?? {}
  }
}

export interface SettingsHandlerDeps {
  settingsService: Pick<SettingsService, 'getSettings' | 'updateSettings'>
  getPromptCacheCapabilities?: () => PromptCacheCapability[]
  getPromptCacheDiagnostics?: () => unknown[]
  setBridgeDaemonEnabled: (enabled: boolean) => Promise<unknown>
  getRuntimeProfiles: (provider?: ProviderId) => RuntimeProfile[]
  saveRuntimeProfile: (
    profile: Partial<RuntimeProfile> & Pick<RuntimeProfile, 'name' | 'provider'>
  ) => RuntimeProfile
  deleteRuntimeProfile: (id: string) => unknown
  getExtensionSecretStatusSnapshot: () => ExtensionSecretStatusSnapshot
  setExtensionSecret: (ref: ExtensionSecretRef, value: string) => ExtensionSecretMutationResult
  clearExtensionSecret: (ref: ExtensionSecretRef) => ExtensionSecretMutationResult
  getManagedPolicyStatus: () => Record<string, unknown> | null | undefined
  resolveSenderSettingsScope: (event: IpcMainInvokeEvent) => SettingsSenderScope
  workspacePathsEqual: (left: string, right: string) => boolean
  resolveSenderHandoffCardScope: (event: IpcMainInvokeEvent) => HandoffCardSenderScope
  getHandoffCards: (filter?: HandoffCardFilter) => HandoffCard[]
  saveHandoffCard: (
    card: Partial<HandoffCard> &
      Pick<HandoffCard, 'sourceChatId' | 'sourceProvider' | 'summary' | 'finalPrompt'>
  ) => HandoffCard
  updateHandoffCard: (id: string, partial: Partial<HandoffCard>) => HandoffCard | null
  deleteHandoffCard: (id: string) => unknown
  assertProviderId: (provider: ProviderId) => ProviderId
  requireNonEmptyString: (value: string, label: string) => string
  sanitizeRuntimeProfileForSave: (
    profile: unknown
  ) => Partial<RuntimeProfile> & Pick<RuntimeProfile, 'name' | 'provider'>
  sanitizeHandoffCardForSave: (
    card: unknown
  ) => Partial<HandoffCard> &
    Pick<HandoffCard, 'sourceChatId' | 'sourceProvider' | 'summary' | 'finalPrompt'>
  sanitizeHandoffCardPatch: (partial: unknown) => Partial<HandoffCard>
  sanitizeHandoffCardFilter: (filter: unknown) => HandoffCardFilter
}

function normalizeRuntimeProfileSecretValues(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const env = (input as RuntimeProfileSecretValues).env
  if (!env || typeof env !== 'object' || Array.isArray(env)) return {}
  const output: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!runtimeProfileEnvNamePattern.test(key) || typeof value !== 'string' || !value.trim()) {
      continue
    }
    output[key] = value
  }
  return output
}

function runtimeProfileSecretRef(profileId: string, fieldName: string): ExtensionSecretRef {
  return {
    ownerKind: 'runtimeProfile',
    ownerId: profileId,
    fieldKind: 'env',
    fieldName
  }
}

function withRuntimeProfileSecretRefs(
  profile: Partial<RuntimeProfile> & Pick<RuntimeProfile, 'name' | 'provider'>,
  envNames: string[]
): Partial<RuntimeProfile> & Pick<RuntimeProfile, 'name' | 'provider'> {
  if (envNames.length === 0) return profile
  const env = Array.from(new Set([...(profile.secretRefs?.env ?? []), ...envNames])).filter(
    (name) => runtimeProfileEnvNamePattern.test(name)
  )
  return {
    ...profile,
    secretRefs: {
      ...(profile.secretRefs || {}),
      env
    }
  }
}

function saveRuntimeProfileWithSecrets(
  deps: SettingsHandlerDeps,
  profile: unknown,
  secretValues: unknown
): RuntimeProfile {
  const sanitized = deps.sanitizeRuntimeProfileForSave(profile)
  const envSecrets = normalizeRuntimeProfileSecretValues(secretValues)
  const envNames = Object.keys(envSecrets)
  if (envNames.length === 0) {
    return deps.saveRuntimeProfile(sanitized)
  }

  const existing =
    sanitized.id && !sanitized.id.startsWith('builtin:')
      ? deps.getRuntimeProfiles(sanitized.provider).find((item) => item.id === sanitized.id)
      : undefined
  const saved = deps.saveRuntimeProfile(withRuntimeProfileSecretRefs(sanitized, envNames))
  const writtenRefs: ExtensionSecretRef[] = []
  try {
    for (const [fieldName, rawValue] of Object.entries(envSecrets)) {
      const ref = runtimeProfileSecretRef(saved.id, fieldName)
      const value = deps.requireNonEmptyString(rawValue, `Runtime profile secret ${fieldName}`)
      const stored = deps.setExtensionSecret(ref, value)
      if (!stored.ok) {
        throw new Error(stored.error || `Could not store runtime profile secret ${fieldName}.`)
      }
      writtenRefs.push(ref)
    }
  } catch (error) {
    for (const ref of writtenRefs) deps.clearExtensionSecret(ref)
    if (existing) deps.saveRuntimeProfile(existing)
    else deps.deleteRuntimeProfile(saved.id)
    throw error
  }
  return saved
}

export function registerSettingsHandlers(deps: SettingsHandlerDeps): void {
  ipcMain.handle('get-settings', (event) =>
    rendererSettingsForSender(
      deps.settingsService.getSettings(),
      deps.resolveSenderSettingsScope(event),
      deps.workspacePathsEqual
    )
  )
  ipcMain.handle('update-settings', (_event, partial: Partial<AppSettings>) =>
    deps.settingsService.updateSettings(partial)
  )
  ipcMain.handle('prompt-cache:get-policy', () => {
    return deps.settingsService.getSettings().promptCache || { enabled: true, providers: {} }
  })
  ipcMain.handle('prompt-cache:save-policy', (_event, policy: PromptCacheSettings) => {
    deps.settingsService.updateSettings({ promptCache: policy })
    return { ok: true }
  })
  ipcMain.handle('prompt-cache:get-capabilities', () => deps.getPromptCacheCapabilities?.() || [])
  ipcMain.handle('prompt-cache:get-diagnostics', () => deps.getPromptCacheDiagnostics?.() || [])
  ipcMain.handle('set-bridge-daemon-enabled', (_event, enabled: boolean) =>
    deps.setBridgeDaemonEnabled(Boolean(enabled))
  )

  ipcMain.handle('get-runtime-profiles', (event, provider?: ProviderId) => {
    const detail =
      deps.resolveSenderSettingsScope(event).kind === 'main' ? ('main' as const) : ('metadata' as const)
    return deps
      .getRuntimeProfiles(provider ? deps.assertProviderId(provider) : undefined)
      .map((profile) => rendererSafeRuntimeProfile(profile, detail))
  })
  ipcMain.handle(
    'save-runtime-profile',
    (
      _event,
      profile: Partial<RuntimeProfile> & Pick<RuntimeProfile, 'name' | 'provider'>,
      secretValues?: RuntimeProfileSecretValues
    ) => {
      return rendererSafeRuntimeProfile(saveRuntimeProfileWithSecrets(deps, profile, secretValues))
    }
  )
  ipcMain.handle('delete-runtime-profile', (_event, id: string) =>
    deps.deleteRuntimeProfile(deps.requireNonEmptyString(id, 'Runtime profile id'))
  )
  ipcMain.handle('get-extension-secret-status', () => deps.getExtensionSecretStatusSnapshot())
  ipcMain.handle('set-extension-secret', (_event, ref: ExtensionSecretRef, value: unknown) =>
    deps.setExtensionSecret(ref, deps.requireNonEmptyString(typeof value === 'string' ? value : '', 'Secret value'))
  )
  ipcMain.handle('clear-extension-secret', (_event, ref: ExtensionSecretRef) =>
    deps.clearExtensionSecret(ref)
  )
  ipcMain.handle('get-managed-policy-status', () => deps.getManagedPolicyStatus() || null)

  ipcMain.handle('get-handoff-cards', (event, filter?: HandoffCardFilter) => {
    const sanitized = deps.sanitizeHandoffCardFilter(filter)
    const scope = deps.resolveSenderHandoffCardScope(event)
    if (scope.kind === 'all') return deps.getHandoffCards(sanitized)
    if (sanitized.sourceChatId && sanitized.sourceChatId !== scope.chatId) {
      throw new Error('Renderer cannot read handoff cards for another chat.')
    }
    return deps.getHandoffCards({ ...sanitized, sourceChatId: scope.chatId })
  })
  ipcMain.handle(
    'save-handoff-card',
    (
      _event,
      card: Partial<HandoffCard> &
        Pick<HandoffCard, 'sourceChatId' | 'sourceProvider' | 'summary' | 'finalPrompt'>
    ) => {
      return deps.saveHandoffCard(deps.sanitizeHandoffCardForSave(card))
    }
  )
  ipcMain.handle('update-handoff-card', (_event, id: string, partial: Partial<HandoffCard>) => {
    return deps.updateHandoffCard(
      deps.requireNonEmptyString(id, 'Handoff card id'),
      deps.sanitizeHandoffCardPatch(partial)
    )
  })
  ipcMain.handle('delete-handoff-card', (_event, id: string) =>
    deps.deleteHandoffCard(deps.requireNonEmptyString(id, 'Handoff card id'))
  )
}
