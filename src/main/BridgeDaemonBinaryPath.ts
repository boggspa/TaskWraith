import { existsSync } from 'fs'
import { join, resolve } from 'path'

const BRIDGE_DAEMON_NAME = 'TaskWraithBridgeDaemon'
const BRIDGE_HELPER_APP_NAME = 'TaskWraith Bridge.app'

/**
 * Resolve the bridge daemon from a packaged macOS app.
 *
 * The current package uses a real nested app because macOS privacy services
 * require the helper's own Info.plist. Bare helper and resource locations are
 * read-only fallbacks for already-installed older builds.
 */
export function resolvePackagedBridgeDaemonPath(
  resourcesPath: string | undefined,
  pathExists: (candidate: string) => boolean = existsSync
): string | null {
  if (!resourcesPath) return null

  const bundledHelper = resolve(
    resourcesPath,
    '..',
    'Helpers',
    BRIDGE_HELPER_APP_NAME,
    'Contents',
    'MacOS',
    BRIDGE_DAEMON_NAME
  )
  if (pathExists(bundledHelper)) return bundledHelper

  const bareHelper = resolve(resourcesPath, '..', 'Helpers', BRIDGE_DAEMON_NAME)
  if (pathExists(bareHelper)) return bareHelper

  const legacyResource = join(resourcesPath, 'bridge', BRIDGE_DAEMON_NAME)
  return pathExists(legacyResource) ? legacyResource : null
}
