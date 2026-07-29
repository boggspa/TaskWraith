import { delimiter, dirname, extname, join } from 'path'
import os from 'os'
import {
  expandCliPathDirectory,
  normalizeCliPathDirectories
} from '../../shared/cliPathDirectories'

/**
 * Pure PATH/candidate-dir helpers, extracted from CliProviderRuntime.
 *
 * These two functions only ever touched `path`, `os`, and the passed-in env —
 * but they lived in a module that transitively imports AppStore, which reads
 * `electron.app.getPath('userData')` at module scope. That made them unusable
 * from any electron-free module: importing them dragged in the whole store and
 * crashed outside a running app. HostToolResolver needs them, and
 * NativeCapabilities (which is deliberately pure and unit-tested without
 * electron) consumes that in turn.
 *
 * CliProviderRuntime re-exports both names, so its existing callers are
 * unaffected.
 */

/**
 * User-configured extra directories (AppSettings.cliPathDirectories), already
 * normalized and `~`-expanded.
 *
 * A module-level register rather than a parameter: this helper has ~40 call
 * sites across provider resolution, host-tool probing, and Git/gh spawning, and
 * threading a settings object through all of them would guarantee that some
 * lane silently kept the old behaviour. It is also what keeps this module
 * electron-free — MAIN publishes the value at startup and on every settings
 * write; nothing here reaches into the store.
 */
let userCliSearchDirs: string[] = []

/**
 * Publish the user's extra CLI directories. MAIN owns this call.
 *
 * Returns true when the effective list actually changed, so the caller can
 * invalidate resolution caches — without that, a tool probed as "missing"
 * before the user fixed their PATH stays missing until relaunch, which is
 * precisely the frustration this setting exists to remove.
 */
export function setUserCliSearchDirs(
  dirs: readonly string[] | null | undefined,
  homeDir: string = os.homedir()
): boolean {
  const next = normalizeCliPathDirectories(dirs ? [...dirs] : []).map((entry) =>
    expandCliPathDirectory(entry, homeDir)
  )
  const changed =
    next.length !== userCliSearchDirs.length ||
    next.some((entry, index) => entry !== userCliSearchDirs[index])
  userCliSearchDirs = next
  return changed
}

/** The currently published extra directories. Diagnostics + tests. */
export function getUserCliSearchDirs(): string[] {
  return [...userCliSearchDirs]
}

/**
 * Candidate directories to probe for a CLI binary, most-specific first.
 *
 * Finder-launched apps don't inherit the shell PATH — the default launchd PATH
 * has no /opt/homebrew/bin — so the well-known install roots are appended
 * explicitly rather than trusting PATH alone.
 *
 * User-configured directories come first (after the explicitly resolved binary's
 * own directory). They are an override: the user reaches for them precisely
 * because the default order picked the wrong copy, so they have to win.
 */
export function getCliSearchDirs(
  binaryPath?: string | null,
  inheritedEnv: Readonly<Record<string, string | undefined>> = process.env
): string[] {
  const windowsDirs =
    process.platform === 'win32'
      ? [
          inheritedEnv.APPDATA ? join(inheritedEnv.APPDATA, 'npm') : '',
          inheritedEnv.LOCALAPPDATA
            ? join(inheritedEnv.LOCALAPPDATA, 'Microsoft', 'WindowsApps')
            : '',
          inheritedEnv.LOCALAPPDATA ? join(inheritedEnv.LOCALAPPDATA, 'Programs') : '',
          inheritedEnv.USERPROFILE ? join(inheritedEnv.USERPROFILE, 'scoop', 'shims') : '',
          inheritedEnv.ProgramFiles ? join(inheritedEnv.ProgramFiles, 'nodejs') : '',
          inheritedEnv.ProgramData ? join(inheritedEnv.ProgramData, 'chocolatey', 'bin') : '',
          'C:\\Program Files\\nodejs',
          'C:\\ProgramData\\chocolatey\\bin'
        ]
      : []
  const dirs = [
    binaryPath ? dirname(binaryPath) : '',
    ...userCliSearchDirs,
    ...(inheritedEnv.PATH || '').split(delimiter),
    ...windowsDirs,
    join(os.homedir(), '.local', 'bin'),
    join(os.homedir(), '.npm-global', 'bin'),
    join(os.homedir(), '.bun', 'bin'),
    join(os.homedir(), '.cargo', 'bin'),
    '/opt/homebrew/opt/ripgrep/bin',
    '/opt/homebrew/bin',
    '/usr/local/opt/ripgrep/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ].filter(Boolean)

  return Array.from(new Set(dirs))
}

/** Binary name variants to try — appends Windows PATHEXT extensions. */
export function cliBinaryNameCandidates(binaryName: string): string[] {
  if (process.platform !== 'win32' || extname(binaryName)) {
    return [binaryName]
  }
  const pathExts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
  const candidates = [binaryName]
  for (const ext of pathExts) {
    candidates.push(`${binaryName}${ext}`)
  }
  return Array.from(new Set(candidates))
}
