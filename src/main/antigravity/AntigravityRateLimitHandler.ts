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
  seedAgyDiscoveryProvenanceFromCache,
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
  /**
   * Reads the PERSISTED agy model cache so a refresh can recover provenance
   * that discovery has not established in this session. Optional: when absent
   * the handler behaves exactly as before, which keeps every existing test and
   * any caller that has no userData path unchanged.
   */
  readonly readCachedProvenanceRecord?: () => Promise<{
    models: unknown[]
    updatedAtMs: number | null
  } | null>
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
    // Discovery is the only writer of the in-memory provenance slot, and a
    // refresh does not run discovery — so on a freshly started app the slot is
    // still `none` even for a user who is signed in. Recover it from the
    // persisted cache first (a file read, not a backend round-trip), otherwise
    // the meter tells the user to sign in and refresh, and refreshing can never
    // clear it. Only seeds when provenance is `none`; live proof always wins.
    if (dependencies.readCachedProvenanceRecord) {
      await seedAgyDiscoveryProvenanceFromCache(dependencies.readCachedProvenanceRecord)
    }
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
