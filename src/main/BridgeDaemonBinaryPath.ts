import { existsSync } from 'fs'
import { join, resolve } from 'path'

const BRIDGE_DAEMON_NAME = 'TaskWraithBridgeDaemon'

/**
 * Resolve the bridge daemon from a packaged macOS app.
 *
 * Mach-O helper tools belong in Contents/Helpers, where macOS can preserve
 * the parent app's responsible-code chain for privacy services. The resource
 * location remains a read-only fallback for already-installed older builds.
 */
export function resolvePackagedBridgeDaemonPath(
  resourcesPath: string | undefined,
  pathExists: (candidate: string) => boolean = existsSync
): string | null {
  if (!resourcesPath) return null

  const helper = resolve(resourcesPath, '..', 'Helpers', BRIDGE_DAEMON_NAME)
  if (pathExists(helper)) return helper

  const legacyResource = join(resourcesPath, 'bridge', BRIDGE_DAEMON_NAME)
  return pathExists(legacyResource) ? legacyResource : null
}
