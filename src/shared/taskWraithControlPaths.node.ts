import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'

/**
 * Join using the SEMANTICS OF THE REQUESTED PLATFORM, not the host's.
 *
 * These helpers take a `platform` argument, which promises a caller can
 * derive another platform's path. `node:path`'s bare `join` always uses the
 * host's separator, so asking for a darwin path on Windows returned
 * `\\Users\\example\\...` and the promise was false. Production always passes
 * the host platform, so this is behaviour-preserving there; it only makes the
 * cross-platform case — which the signature already advertised — actually work.
 */
function joinFor(platform: NodeJS.Platform, ...parts: string[]): string {
  return platform === 'win32' ? win32.join(...parts) : posix.join(...parts)
}

export const TASKWRAITH_CONTROL_DISCOVERY_FILE = 'taskwraith-control-v1.json'
export const TASKWRAITH_CONTROL_TOKEN_FILE = 'taskwraith-control-v1.token'
export const TASKWRAITH_CONTROL_SOCKET_FILE = 'taskwraith-control-v1.sock'

export function defaultTaskWraithUserDataPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir()
): string {
  const explicit = String(env.TASKWRAITH_USER_DATA || '').trim()
  if (explicit) return explicit
  if (platform === 'darwin')
    return joinFor(platform, home, 'Library', 'Application Support', 'taskwraith')
  if (platform === 'win32') {
    const appData = String(env.APPDATA || '').trim()
    return joinFor(platform, appData || joinFor(platform, home, 'AppData', 'Roaming'), 'taskwraith')
  }
  const configHome = String(env.XDG_CONFIG_HOME || '').trim()
  return joinFor(platform, configHome || joinFor(platform, home, '.config'), 'taskwraith')
}

export function defaultTaskWraithDevUserDataPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir()
): string {
  const explicit = String(env.TASKWRAITH_USER_DATA || '').trim()
  if (explicit) return explicit
  const instanceId = String(env.TASKWRAITH_INSTANCE_ID || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 16)
  const name = instanceId ? `TaskWraith Dev ${instanceId}` : 'TaskWraith Dev'
  if (platform === 'darwin') return joinFor(platform, home, 'Library', 'Application Support', name)
  if (platform === 'win32') {
    const appData = String(env.APPDATA || '').trim()
    return joinFor(platform, appData || joinFor(platform, home, 'AppData', 'Roaming'), name)
  }
  const configHome = String(env.XDG_CONFIG_HOME || '').trim()
  return joinFor(platform, configHome || joinFor(platform, home, '.config'), name)
}

export function taskWraithControlDiscoveryPath(userDataPath: string): string {
  return join(userDataPath, TASKWRAITH_CONTROL_DISCOVERY_FILE)
}

export function taskWraithControlTokenPath(userDataPath: string): string {
  return join(userDataPath, TASKWRAITH_CONTROL_TOKEN_FILE)
}

export function taskWraithControlSocketPath(
  userDataPath: string,
  platform: NodeJS.Platform = process.platform
): string {
  const suffix = createHash('sha256').update(userDataPath).digest('hex').slice(0, 16)
  if (platform === 'win32') {
    return `\\\\.\\pipe\\taskwraith-control-${suffix}`
  }
  // macOS caps sockaddr_un paths at roughly 104 bytes. Electron userData and
  // test paths can exceed that before the filename is appended, so keep the
  // socket in a short, per-user private temp directory. Discovery + token stay
  // in userData and remain the only client entry point.
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user'
  return join(tmpdir(), `tw-${uid}-${suffix}`, TASKWRAITH_CONTROL_SOCKET_FILE)
}
