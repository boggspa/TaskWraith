import type { IpcMainInvokeEvent } from 'electron'
import type {
  GeminiAuthProfile,
  GeminiAuthProfileSummary,
  GeminiAuthStatus,
  GeminiOAuthLoginStatus,
  ProviderApiKeyStatus
} from '../store/types'
import type { ResolvedProviderBinary } from '../providers/CliProviderRuntime'
import {
  rendererSafeGeminiAuthProfile,
  rendererSafeGeminiAuthStatus,
  rendererSafeProviderApiKeyStatus
} from '../RendererProviderProjection'
import type {
  UsageWebSessionImportOutcome,
  UsageWebSessionProviderId,
  UsageWebSessionReading,
  UsageWebSessionStatus
} from '../../shared/usageWebSession'
import { isUsageWebSessionProviderId } from '../../shared/usageWebSession'
import type {
  WebSessionCookieStore,
  WebSessionMutationResult,
  WebSessionStatus
} from '../providers/WebSessionCookieStore'
import type { CapturedWebSession, WebSessionImportOutcome } from '../providers/WebSessionBrowser'
import type { UsageWebSessionStore } from '../providers/UsageWebSessionStore'
import {
  ANTIGRAVITY_GEMINI_API_DISCOVERY_OUTCOME_STATUSES,
  MAX_ANTIGRAVITY_GEMINI_API_OUTCOME_MODEL_COUNT,
  type AntigravityGeminiApiDiscoveryOutcome
} from '../antigravity/AntigravityGeminiApiDiscoveryOutcome'

export {
  ANTIGRAVITY_GEMINI_API_DISCOVERY_OUTCOME_STATUSES,
  MAX_ANTIGRAVITY_GEMINI_API_OUTCOME_MODEL_COUNT
}

export interface SecretStatus {
  configured: boolean
  encryptionAvailable: boolean
  updatedAt?: string
}

export interface SecretMutationResult<Error extends string = string> {
  ok: boolean
  status: SecretStatus
  error?: Error
}

export interface SecretStore {
  getStatus(): unknown
  setApiKey(apiKey: string): unknown
  clear(): unknown
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/** Accepts only a canonical, round-trippable UTC instant. */
export function canonicalIsoTimestamp(
  value: unknown,
  {
    allowNoMillis = false,
    requireRoundTrip = false
  }: { allowNoMillis?: boolean; requireRoundTrip?: boolean } = {}
): string | null {
  if (typeof value !== 'string' || value.length > 64) return null
  const pattern = allowNoMillis
    ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
  if (!pattern.test(value)) return null
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return null
  if (requireRoundTrip && new Date(parsed).toISOString() !== value) return null
  return value
}

export interface StatusProjectionOptions {
  allowNoMillis?: boolean
  requireRoundTrip?: boolean
}

export function projectStatus(
  value: unknown,
  options: StatusProjectionOptions = { allowNoMillis: true }
): SecretStatus {
  if (!isRecord(value)) return { configured: false, encryptionAvailable: false }
  const status: SecretStatus = {
    configured: value.configured === true,
    encryptionAvailable: value.encryptionAvailable === true
  }
  const updatedAt = canonicalIsoTimestamp(value.updatedAt, options)
  if (updatedAt) status.updatedAt = updatedAt
  return status
}

export function projectMutation<Error extends string = string>(
  value: unknown,
  {
    recognizedErrors,
    defaultError,
    fallbackError,
    statusProjection
  }: {
    recognizedErrors: ReadonlySet<string>
    defaultError: Error
    fallbackError?: Error
    statusProjection?: StatusProjectionOptions
  }
): SecretMutationResult<Error> {
  if (!isRecord(value)) {
    return {
      ok: false,
      status: { configured: false, encryptionAvailable: false },
      error: defaultError
    }
  }
  const ok = value.ok === true
  const status = projectStatus(value.status, statusProjection)
  if (ok) return { ok: true, status }
  if (typeof value.error === 'string' && recognizedErrors.has(value.error)) {
    return { ok: false, status, error: value.error as Error }
  }
  if (fallbackError !== undefined) {
    return { ok: false, status, error: fallbackError }
  }
  return { ok: false, status }
}

export function webSessionStatusOf(
  store: Pick<WebSessionCookieStore, 'getStatus'> | null
): WebSessionStatus {
  if (!store) return { configured: false, encryptionAvailable: false }
  try {
    return store.getStatus()
  } catch {
    return { configured: false, encryptionAvailable: false }
  }
}

export function normalizeWebSessionInput(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  return value || null
}

export interface ProviderApiKeyConfig {
  providerName: string
  settingsKey: string
  getSettings: () => { apiKey?: string }
  updateSettings: (patch: { apiKey?: string }) => void
  isEncryptionAvailable: () => boolean
  encryptApiKey: (value: string) => string | null
  secureStorageUnavailableError: string
}

export interface ProviderApiKeyHandlers {
  storeKey: (
    event: unknown,
    rawKey: string
  ) => Promise<{
    stored: boolean
    encryptionAvailable: boolean
    error?: string
  }>
  clearKey: () => Promise<boolean>
}

export function createProviderApiKeyHandlers(config: ProviderApiKeyConfig): ProviderApiKeyHandlers {
  async function storeKey(_event: unknown, rawKey: string) {
    const key = String(rawKey || '').trim()
    if (!key) {
      config.updateSettings({ apiKey: undefined })
      return {
        stored: false,
        encryptionAvailable: config.isEncryptionAvailable()
      }
    }
    if (!config.isEncryptionAvailable()) {
      return {
        stored: false,
        encryptionAvailable: false,
        error: config.secureStorageUnavailableError
      }
    }
    const encrypted = config.encryptApiKey(key)
    config.updateSettings({ apiKey: encrypted || undefined })
    return {
      stored: Boolean(encrypted),
      encryptionAvailable: config.isEncryptionAvailable()
    }
  }

  async function clearKey() {
    config.updateSettings({ apiKey: undefined })
    return true
  }

  return { storeKey, clearKey }
}

export interface CliProviderAuthConfig<Provider extends string = string> {
  getSettings: () => { apiKey?: string }
  isEncryptionAvailable: () => boolean
  resolveCliProviderBinary: (provider: Provider) => Promise<ResolvedProviderBinary>
  isMainRendererSender: (event: IpcMainInvokeEvent) => boolean
  readStatus: (resolved: ResolvedProviderBinary) => Promise<ProviderApiKeyStatus>
  providerNameForCli: Provider
  missingBinaryAuthState?: string
}

export function createCliProviderAuthStatusHandler<Provider extends string = string>(
  config: CliProviderAuthConfig<Provider>
) {
  return async (event: IpcMainInvokeEvent): Promise<ProviderApiKeyStatus> => {
    const encryptionAvailable = config.isEncryptionAvailable()
    const resolved = await config.resolveCliProviderBinary(config.providerNameForCli)
    if (!resolved.binaryPath) {
      const apiKeyConfigured = Boolean(config.getSettings().apiKey)
      const status: ProviderApiKeyStatus = {
        available: false,
        authState: config.missingBinaryAuthState ?? 'missing',
        apiKeyConfigured,
        encryptionAvailable,
        binaryPath: null
      }
      return config.isMainRendererSender(event) ? status : rendererSafeProviderApiKeyStatus(status)
    }
    const status = await config.readStatus(resolved)
    return config.isMainRendererSender(event) ? status : rendererSafeProviderApiKeyStatus(status)
  }
}

export interface ProviderWebSessionConfig<Summary = unknown> {
  isMainRendererSender: (event: IpcMainInvokeEvent) => boolean
  webSessionStore?: () => Pick<WebSessionCookieStore, 'getStatus' | 'setCookie' | 'clear'> | null
  importWebSession?: () => Promise<CapturedWebSession<Summary> | null>
  onWebSessionImported?: (summary: Summary) => void
  normalizeInput?: (raw: unknown) => string | null
  /** When true, clearWebSession returns synchronously (e.g. Mistral). */
  syncClear?: boolean
}

export interface ProviderWebSessionHandlers {
  importWebSession: (event: IpcMainInvokeEvent) => Promise<WebSessionImportOutcome>
  setWebSession: (event: IpcMainInvokeEvent, raw: unknown) => Promise<WebSessionMutationResult>
  getWebSessionStatus: (event: IpcMainInvokeEvent) => WebSessionStatus
  clearWebSession: (
    event: IpcMainInvokeEvent
  ) => WebSessionMutationResult | Promise<WebSessionMutationResult>
}

export function createProviderWebSessionHandlers<Summary = unknown>(
  config: ProviderWebSessionConfig<Summary>
): ProviderWebSessionHandlers {
  const normalize = config.normalizeInput ?? normalizeWebSessionInput

  async function importWebSession(event: IpcMainInvokeEvent): Promise<WebSessionImportOutcome> {
    if (!config.isMainRendererSender(event)) return { ok: false, reason: 'unavailable' }
    const store = config.webSessionStore?.() ?? null
    if (!store) return { ok: false, reason: 'unavailable' }
    const captured = await (config.importWebSession ?? (async () => null))()
    if (!captured) return { ok: false, reason: 'cancelled' }
    const result = store.setCookie(captured.cookieHeader)
    if (!result.ok) return { ok: false, reason: 'storeFailed', status: result.status }
    try {
      config.onWebSessionImported?.(captured.summary as Summary)
    } catch {
      // ignore
    }
    return { ok: true, status: result.status }
  }

  async function setWebSession(
    event: IpcMainInvokeEvent,
    raw: unknown
  ): Promise<WebSessionMutationResult> {
    const unavailable: WebSessionMutationResult = {
      ok: false,
      status: { configured: false, encryptionAvailable: false },
      error: 'writeFailed'
    }
    if (!config.isMainRendererSender(event)) return unavailable
    const store = config.webSessionStore?.() ?? null
    if (!store) return unavailable
    const cookie = normalize(raw)
    if (!cookie) {
      return { ok: false, status: webSessionStatusOf(store), error: 'invalidCookie' }
    }
    return store.setCookie(cookie)
  }

  function getWebSessionStatus(event: IpcMainInvokeEvent): WebSessionStatus {
    if (!config.isMainRendererSender(event)) {
      return { configured: false, encryptionAvailable: false }
    }
    const store = config.webSessionStore?.() ?? null
    if (!store) return { configured: false, encryptionAvailable: false }
    return projectStatus(store.getStatus())
  }

  function clearWebSession(
    event: IpcMainInvokeEvent
  ): WebSessionMutationResult | Promise<WebSessionMutationResult> {
    const unavailable: WebSessionMutationResult = {
      ok: false,
      status: { configured: false, encryptionAvailable: false },
      error: 'clearFailed'
    }
    if (!config.isMainRendererSender(event)) return unavailable
    const store = config.webSessionStore?.() ?? null
    if (!store) return unavailable
    const result = store.clear()
    return config.syncClear ? result : Promise.resolve(result)
  }

  return { importWebSession, setWebSession, getWebSessionStatus, clearWebSession }
}

export interface ProviderSecretStoreConfig<Error extends string = string> {
  secretStore: Pick<SecretStore, 'getStatus' | 'setApiKey' | 'clear'>
  isMainRendererSender: (event: IpcMainInvokeEvent) => boolean
  onMutationSuccess?: () => void
  recognizedErrors: ReadonlySet<string>
  defaultError: Error
  fallbackError?: Error
  assertMainRenderer?: boolean
  assertMainRendererError?: string
  /** When set, unauthorized senders on set/clear return a failed mutation with the given error. */
  mutationGuard?: {
    setError: Error
    clearError: Error
  }
  /** Projection behavior for the status payload. */
  statusProjection?: StatusProjectionOptions
}

export interface ProviderSecretStoreHandlers<Error extends string = string> {
  getStatus: (event: IpcMainInvokeEvent) => SecretStatus
  setSecret: (event: IpcMainInvokeEvent, apiKey: string) => SecretMutationResult<Error>
  clearSecret: (event: IpcMainInvokeEvent) => SecretMutationResult<Error>
}

function assertMainRenderer(
  config: Pick<ProviderSecretStoreConfig, 'isMainRendererSender' | 'assertMainRendererError'>,
  event: IpcMainInvokeEvent
): void {
  if (config.assertMainRendererError && !config.isMainRendererSender(event)) {
    throw new Error(config.assertMainRendererError)
  }
}

export function createProviderSecretStoreHandlers<Error extends string = string>(
  config: ProviderSecretStoreConfig<Error>
): ProviderSecretStoreHandlers<Error> {
  function unauthorizedMutation(error: Error): SecretMutationResult<Error> {
    return {
      ok: false,
      status: { configured: false, encryptionAvailable: false },
      error
    }
  }

  function getStatus(event: IpcMainInvokeEvent): SecretStatus {
    assertMainRenderer(config, event)
    if (!config.isMainRendererSender(event)) {
      return { configured: false, encryptionAvailable: false }
    }
    return projectStatus(config.secretStore.getStatus(), config.statusProjection)
  }

  function setSecret(event: IpcMainInvokeEvent, apiKey: string): SecretMutationResult<Error> {
    if (config.mutationGuard && !config.isMainRendererSender(event)) {
      return unauthorizedMutation(config.mutationGuard.setError)
    }
    assertMainRenderer(config, event)
    const result = projectMutation<Error>(config.secretStore.setApiKey(apiKey), {
      recognizedErrors: config.recognizedErrors,
      defaultError: config.defaultError,
      fallbackError: config.fallbackError,
      statusProjection: config.statusProjection
    })
    if (result.ok) {
      try {
        config.onMutationSuccess?.()
      } catch {
        // ignore
      }
    }
    return result
  }

  function clearSecret(event: IpcMainInvokeEvent): SecretMutationResult<Error> {
    if (config.mutationGuard && !config.isMainRendererSender(event)) {
      return unauthorizedMutation(config.mutationGuard.clearError)
    }
    assertMainRenderer(config, event)
    const result = projectMutation<Error>(config.secretStore.clear(), {
      recognizedErrors: config.recognizedErrors,
      defaultError: config.defaultError,
      fallbackError: config.fallbackError,
      statusProjection: config.statusProjection
    })
    if (result.ok) {
      try {
        config.onMutationSuccess?.()
      } catch {
        // ignore
      }
    }
    return result
  }

  return { getStatus, setSecret, clearSecret }
}

export interface ProviderDiscoveryOutcomeConfig {
  getDiscoveryOutcome?: () => unknown
  isMainRendererSender: (event: IpcMainInvokeEvent) => boolean
  assertMainRendererError?: string
}

function boundedModelCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return 0
  return Math.min(value, MAX_ANTIGRAVITY_GEMINI_API_OUTCOME_MODEL_COUNT)
}

export function projectDiscoveryOutcome(
  value: unknown
): AntigravityGeminiApiDiscoveryOutcome | null {
  if (!isRecord(value)) return null
  if (
    typeof value.status !== 'string' ||
    !ANTIGRAVITY_GEMINI_API_DISCOVERY_OUTCOME_STATUSES.has(value.status)
  ) {
    return null
  }
  const checkedAt = canonicalIsoTimestamp(value.checkedAt, { requireRoundTrip: true })
  if (!checkedAt) return null
  const status = value.status as AntigravityGeminiApiDiscoveryOutcome['status']
  return {
    status,
    modelCount: status === 'ok' ? boundedModelCount(value.modelCount) : 0,
    checkedAt
  }
}

export function createDiscoveryOutcomeHandler(config: ProviderDiscoveryOutcomeConfig) {
  return (event: IpcMainInvokeEvent): AntigravityGeminiApiDiscoveryOutcome | null => {
    assertMainRenderer(
      {
        isMainRendererSender: config.isMainRendererSender,
        assertMainRendererError: config.assertMainRendererError
      },
      event
    )
    try {
      return projectDiscoveryOutcome(config.getDiscoveryOutcome?.() ?? null)
    } catch {
      return null
    }
  }
}

export interface UsageWebSessionConfig {
  isMainRendererSender: (event: IpcMainInvokeEvent) => boolean
  store: (
    provider: UsageWebSessionProviderId
  ) => Pick<UsageWebSessionStore, 'getStatus' | 'setSession' | 'clear'> | null
  importSession?: (
    provider: UsageWebSessionProviderId
  ) => Promise<CapturedWebSession<UsageWebSessionReading> | null>
  onSessionChanged?: (provider: UsageWebSessionProviderId) => void
}

function unavailableUsageStatus(): UsageWebSessionStatus {
  return { configured: false, encryptionAvailable: false }
}

function safelyNotifyUsage(
  callback: ((provider: UsageWebSessionProviderId) => void) | undefined,
  provider: UsageWebSessionProviderId
): void {
  try {
    callback?.(provider)
  } catch {
    // A refresh notification must never turn a completed credential write into an IPC failure.
  }
}

export function createUsageWebSessionHandlers(config: UsageWebSessionConfig) {
  function resolveProvider(value: unknown): UsageWebSessionProviderId | null {
    return isUsageWebSessionProviderId(value) ? value : null
  }

  return {
    getStatus: async (
      event: IpcMainInvokeEvent,
      rawProvider: unknown
    ): Promise<UsageWebSessionStatus> => {
      const provider = resolveProvider(rawProvider)
      if (!provider || !config.isMainRendererSender(event)) return unavailableUsageStatus()
      try {
        return config.store(provider)?.getStatus() ?? unavailableUsageStatus()
      } catch {
        return unavailableUsageStatus()
      }
    },
    importSession: async (
      event: IpcMainInvokeEvent,
      rawProvider: unknown
    ): Promise<UsageWebSessionImportOutcome> => {
      const provider = resolveProvider(rawProvider)
      if (!provider || !config.isMainRendererSender(event)) {
        return { ok: false, reason: 'unavailable' }
      }
      const store = config.store(provider)
      if (!store) return { ok: false, reason: 'unavailable' }
      let captured: CapturedWebSession<UsageWebSessionReading> | null
      try {
        captured = await (config.importSession ?? (async () => null))(provider)
      } catch {
        return { ok: false, reason: 'unavailable', status: store.getStatus() }
      }
      if (!captured) return { ok: false, reason: 'cancelled', status: store.getStatus() }
      const result = store.setSession({
        cookieHeader: captured.cookieHeader,
        reading: captured.summary
      })
      if (!result.ok) return { ok: false, reason: 'storeFailed', status: result.status }
      safelyNotifyUsage(config.onSessionChanged, provider)
      return { ok: true, status: result.status }
    },
    clear: async (event: IpcMainInvokeEvent, rawProvider: unknown) => {
      const provider = resolveProvider(rawProvider)
      if (!provider || !config.isMainRendererSender(event)) {
        return { ok: false, status: unavailableUsageStatus(), error: 'clearFailed' as const }
      }
      const store = config.store(provider)
      if (!store) {
        return { ok: false, status: unavailableUsageStatus(), error: 'clearFailed' as const }
      }
      const result = store.clear()
      if (result.ok) safelyNotifyUsage(config.onSessionChanged, provider)
      return result
    }
  }
}

export interface GeminiAuthHandlerConfig {
  getGeminiAuthStatusSnapshot: () => Promise<GeminiAuthStatus>
  getDefaultGeminiAuthProfileId: () => string | null
  getGeminiAuthProfiles: () => GeminiAuthProfile[]
  summarizeGeminiAuthProfile: (
    profile: GeminiAuthProfile,
    defaultProfileId: string | null
  ) => GeminiAuthProfileSummary
  saveGeminiAuthProfile: (profile: unknown) => GeminiAuthProfileSummary
  deleteGeminiAuthProfile: (profileId: unknown) => Promise<boolean>
  setDefaultGeminiAuthProfile: (profileId: unknown) => GeminiAuthProfileSummary | null
  startGeminiOAuthLogin: (input: unknown) => Promise<GeminiOAuthLoginStatus>
  getGeminiOAuthLoginStatus: (profileId: unknown) => GeminiOAuthLoginStatus | null
  cancelGeminiOAuthLogin: (profileId: unknown) => GeminiOAuthLoginStatus | null
  isMainRendererSender: (event: IpcMainInvokeEvent) => boolean
}

export function createGeminiAuthHandlers(config: GeminiAuthHandlerConfig) {
  return {
    getStatus: async (event: IpcMainInvokeEvent) => {
      const status = await config.getGeminiAuthStatusSnapshot()
      return config.isMainRendererSender(event) ? status : rendererSafeGeminiAuthStatus(status)
    },
    listProfiles: async (event: IpcMainInvokeEvent) => {
      const defaultProfileId = config.getDefaultGeminiAuthProfileId()
      const profiles = config
        .getGeminiAuthProfiles()
        .map((profile) => config.summarizeGeminiAuthProfile(profile, defaultProfileId))
      return config.isMainRendererSender(event)
        ? profiles
        : profiles.map(rendererSafeGeminiAuthProfile)
    },
    saveProfile: async (_event: unknown, profile: unknown) => config.saveGeminiAuthProfile(profile),
    deleteProfile: async (_event: unknown, profileId: unknown) =>
      config.deleteGeminiAuthProfile(profileId),
    setDefaultProfile: async (_event: unknown, profileId: unknown) =>
      config.setDefaultGeminiAuthProfile(profileId),
    startOAuthLogin: async (_event: unknown, input: unknown) => config.startGeminiOAuthLogin(input),
    getOAuthLoginStatus: async (_event: unknown, profileId: unknown) =>
      config.getGeminiOAuthLoginStatus(profileId),
    cancelOAuthLogin: async (_event: unknown, profileId: unknown) =>
      config.cancelGeminiOAuthLogin(profileId)
  }
}

export type ProviderSecretHandlerConfig =
  | { kind: 'apiKey'; config: ProviderApiKeyConfig }
  | { kind: 'cliAuth'; config: CliProviderAuthConfig<string> }
  | { kind: 'webSession'; config: ProviderWebSessionConfig<unknown> }
  | { kind: 'secretStore'; config: ProviderSecretStoreConfig<string> }
  | { kind: 'usageWebSession'; config: UsageWebSessionConfig }
  | { kind: 'geminiAuth'; config: GeminiAuthHandlerConfig }

export function createProviderSecretHandlers(
  config: ProviderSecretHandlerConfig
):
  | ProviderApiKeyHandlers
  | { getStatus: (event: IpcMainInvokeEvent) => Promise<ProviderApiKeyStatus> }
  | ProviderWebSessionHandlers
  | ProviderSecretStoreHandlers<string>
  | ReturnType<typeof createUsageWebSessionHandlers>
  | ReturnType<typeof createGeminiAuthHandlers> {
  switch (config.kind) {
    case 'apiKey':
      return createProviderApiKeyHandlers(config.config)
    case 'cliAuth':
      return { getStatus: createCliProviderAuthStatusHandler(config.config) }
    case 'webSession':
      return createProviderWebSessionHandlers(config.config)
    case 'secretStore':
      return createProviderSecretStoreHandlers(config.config)
    case 'usageWebSession':
      return createUsageWebSessionHandlers(config.config)
    case 'geminiAuth':
      return createGeminiAuthHandlers(config.config)
    default:
      throw new Error('Unknown provider secret handler kind')
  }
}
