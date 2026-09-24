import { isAbsolute, parse, resolve } from 'node:path'

/**
 * The small host-owned subset AppStore needs while its broader dependency graph
 * is still main-process shaped. Configure this before dynamically importing
 * AppStore from a pure Node Host.
 */
export interface HostStoreSecureStorage {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface HostStoreRuntime {
  readonly profilePath: string
  readonly secureStorage: HostStoreSecureStorage
  /** Desktop supplies this from Electron; a standalone Node Host may omit it. */
  readonly appVersion?: string
}

let installedRuntime: Readonly<HostStoreRuntime> | null = null

/**
 * Installs the one profile/store authority for this process. Reinstalling the
 * exact same runtime is harmless; any path or secure-storage substitution is
 * rejected so a late importer cannot silently split durable state or keys.
 */
export function configureHostStoreRuntime(runtime: HostStoreRuntime): Readonly<HostStoreRuntime> {
  const normalized = normalizeRuntime(runtime)
  if (installedRuntime) {
    if (
      installedRuntime.profilePath !== normalized.profilePath ||
      installedRuntime.secureStorage !== normalized.secureStorage
    ) {
      throw new Error('Host store runtime is already configured with an incompatible authority.')
    }
    return installedRuntime
  }
  installedRuntime = Object.freeze(normalized)
  return installedRuntime
}

/** Returns the configured Node Host runtime, if one was installed before store import. */
export function getConfiguredHostStoreRuntime(): Readonly<HostStoreRuntime> | null {
  return installedRuntime
}

/**
 * Core store modules must call this at import time. Electron compatibility is
 * intentionally outside this package, so an absent runtime is a startup error
 * rather than an invitation to resolve Electron from the Node Host.
 */
export function requireConfiguredHostStoreRuntime(): Readonly<HostStoreRuntime> {
  const runtime = getConfiguredHostStoreRuntime()
  if (!runtime) {
    throw new Error(
      'AppStore requires HostStoreRuntime to be configured before its core is imported.'
    )
  }
  return runtime
}

/** Test-only reset. Production lifecycle must configure once before importing AppStore. */
export function resetHostStoreRuntimeForTests(): void {
  installedRuntime = null
}

function normalizeRuntime(runtime: HostStoreRuntime): HostStoreRuntime {
  if (!runtime || typeof runtime !== 'object') {
    throw new TypeError('Host store runtime configuration is required.')
  }
  if (typeof runtime.profilePath !== 'string' || runtime.profilePath.trim().length === 0) {
    throw new TypeError('Host store runtime requires a profile path.')
  }
  if (!isAbsolute(runtime.profilePath)) {
    throw new TypeError('Host store runtime requires an absolute profile path.')
  }
  const profilePath = resolve(runtime.profilePath)
  if (profilePath === parse(profilePath).root) {
    throw new TypeError('Host store runtime refuses a filesystem-root profile path.')
  }
  const secureStorage = runtime.secureStorage
  if (!secureStorage || typeof secureStorage !== 'object') {
    throw new TypeError('Host store runtime requires a secure-storage port.')
  }
  if (
    typeof secureStorage.isEncryptionAvailable !== 'function' ||
    typeof secureStorage.encryptString !== 'function' ||
    typeof secureStorage.decryptString !== 'function'
  ) {
    throw new TypeError('Host store runtime secure-storage port is structurally invalid.')
  }
  const appVersion = runtime.appVersion
  if (appVersion !== undefined && (typeof appVersion !== 'string' || !appVersion.trim())) {
    throw new TypeError('Host store runtime app version must be a non-empty string when provided.')
  }
  return { profilePath, secureStorage, ...(appVersion ? { appVersion } : {}) }
}
