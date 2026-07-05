import { ipcMain } from 'electron'
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

export interface RuntimeProfileSecretValues {
  env?: Record<string, string>
}

const runtimeProfileEnvNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/

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
  ipcMain.handle('get-settings', () => deps.settingsService.getSettings())
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

  ipcMain.handle('get-runtime-profiles', (_event, provider?: ProviderId) => {
    return deps.getRuntimeProfiles(provider ? deps.assertProviderId(provider) : undefined)
  })
  ipcMain.handle(
    'save-runtime-profile',
    (
      _event,
      profile: Partial<RuntimeProfile> & Pick<RuntimeProfile, 'name' | 'provider'>,
      secretValues?: RuntimeProfileSecretValues
    ) => {
      return saveRuntimeProfileWithSecrets(deps, profile, secretValues)
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

  ipcMain.handle('get-handoff-cards', (_event, filter?: HandoffCardFilter) =>
    deps.getHandoffCards(deps.sanitizeHandoffCardFilter(filter))
  )
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
