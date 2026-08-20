import { readFileSync } from 'node:fs'
import {
  readAppDistributionIdentity,
  type AppDistributionIdentity
} from './AppDistributionIdentity'
import {
  IdentityHandoffService,
  type IdentityHandoffFetcher,
  type IdentityHandoffLaunchResult,
  type IdentityHandoffArtifact
} from './IdentityHandoffService'

export interface IdentityHandoffBootstrapOptions {
  appPath: string
  currentVersion: string
  userDataPath: string
  fetcher: IdentityHandoffFetcher
  quit: () => void
  envOverride?: string
  platform?: string
  arch?: string
  manifest?: unknown
  manifestPath?: string
  launchInstaller?: (
    filePath: string,
    artifact: IdentityHandoffArtifact
  ) => IdentityHandoffLaunchResult
  readPackageText?: (filePath: string) => string
  readManifestText?: (filePath: string) => string
  log?: (line: string) => void
}

export interface IdentityHandoffBootstrap {
  distribution: AppDistributionIdentity
  service?: IdentityHandoffService
}

/** Build the handoff/update-identity seam without growing the composition root. */
export function createIdentityHandoffBootstrap(
  options: IdentityHandoffBootstrapOptions
): IdentityHandoffBootstrap {
  const distribution = readAppDistributionIdentity(options.appPath, options.readPackageText)
  const manifest =
    options.manifest !== undefined
      ? options.manifest
      : readOptionalManifest(options.manifestPath, options.readManifestText)
  const service =
    options.envOverride === 'off'
      ? undefined
      : new IdentityHandoffService({
          manifest,
          currentVersion: options.currentVersion,
          currentDistribution: distribution,
          userDataPath: options.userDataPath,
          fetcher: options.fetcher,
          quit: options.quit,
          platform: options.platform,
          arch: options.arch,
          launchInstaller: options.launchInstaller,
          log: options.log
        })
  return { distribution, service }
}

function readOptionalManifest(
  filePath: string | undefined,
  readText: (filePath: string) => string = (target) => readFileSync(target, 'utf8')
): unknown {
  if (!filePath) return undefined
  try {
    return JSON.parse(readText(filePath))
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined
    return {
      invalidIdentityHandoffManifest: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * Every public-identity profile uses the Release feed. This covers both a
 * completed beta handoff and a manual repair install whose receipt was lost;
 * neither may fall back to the historical beta feed. This is the only
 * persisted settings change in the identity bridge—user data itself stays in
 * the existing TaskWraith profile and no schema migration runs.
 */
export function reconcileReleaseIdentityUpdateChannel<T extends { updateChannel: string }>(
  bootstrap: IdentityHandoffBootstrap,
  current: T,
  updateChannel: (channel: 'stable') => void,
  reread: () => T
): T {
  if (bootstrap.distribution.series !== 'release' || current.updateChannel === 'stable') {
    return current
  }
  updateChannel('stable')
  return reread()
}
