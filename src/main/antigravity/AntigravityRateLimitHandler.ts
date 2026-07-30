import type { AppSettings, ProviderId } from '../store/types'
import type {
  ConfiguredProviderDiscoveryStatus,
  ConfiguredProviderModel
} from '../ProviderConfiguration'
import {
  isAuthenticatedAgyRateLimitConnection,
  type AntigravityCombinedCatalogModel
} from './AntigravityCombinedModelCatalog'
import {
  readAgyDiscoveryProvenance,
  type AgyDiscoveryProvenance
} from './AntigravityAgyDiscoveryProvenance'

export interface AntigravityRateLimitHandlerDependencies<T> {
  readonly getSettings: () => AppSettings
  readonly statusSnapshot: (settings: AppSettings) => ConfiguredProviderDiscoveryStatus
  readonly modelsSnapshot: (settings: AppSettings) => ReadonlyMap<ProviderId, ConfiguredProviderModel[]>
  readonly fetchQuota: (
    settings: AppSettings,
    authenticatedConnection: boolean,
    options: Record<string, never>
  ) => Promise<T>
  readonly fetchAuthenticatedQuota: (settings: AppSettings, force: boolean) => Promise<T>
  /**
   * Where the last agy discovery got its rows. Consulted instead of inferring
   * authentication from row shape — the hardcoded floor's bare ids satisfied
   * the old shape test, so the gate was open on machines that had never signed
   * in. Test seam; production reads the main-process single slot.
   */
  readonly readProvenance?: () => AgyDiscoveryProvenance | null
  /** Test seam for the cached-evidence TTL comparison. */
  readonly nowMs?: () => number
}

export function createAntigravityRateLimitHandler<T>(
  dependencies: AntigravityRateLimitHandlerDependencies<T>
): (options?: { force?: unknown }) => Promise<T> {
  return async (options = {}): Promise<T> => {
    const settings = dependencies.getSettings()
    const configuredSnapshot = dependencies.statusSnapshot(settings)
    const configuredModels = dependencies.modelsSnapshot(settings).get('antigravity') as
      | AntigravityCombinedCatalogModel[]
      | undefined
    const authenticatedConnection = isAuthenticatedAgyRateLimitConnection(
      configuredSnapshot,
      configuredModels,
      (dependencies.readProvenance ?? readAgyDiscoveryProvenance)(),
      (dependencies.nowMs ?? Date.now)()
    )
    if (!authenticatedConnection) {
      return dependencies.fetchQuota(settings, false, {})
    }
    return dependencies.fetchAuthenticatedQuota(settings, options.force === true)
  }
}

export function registerAntigravityRateLimitHandler<T>(
  ipcMain: {
    handle: (
      channel: 'get-agent-rate-limits',
      listener: (event: unknown, provider: unknown, options?: { force?: unknown }) => Promise<T>
    ) => void
  },
  handler: (options?: { force?: unknown }) => Promise<T>,
  handleOtherProvider: (
    event: unknown,
    provider: unknown,
    options?: { force?: unknown }
  ) => Promise<T>
): void {
  ipcMain.handle('get-agent-rate-limits', async (event, provider, options) => {
    if (provider !== 'antigravity') return handleOtherProvider(event, provider, options)
    return handler(options)
  })
}
