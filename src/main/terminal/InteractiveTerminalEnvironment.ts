import { delimiter, join } from 'path'
import { getCliSearchDirs } from '../providers/CliSearchDirs'

export interface InteractiveTerminalEnvironmentOptions {
  /** The private, workspace-specific HOME used by the terminal session. */
  home: string
  /** The private, workspace-specific temporary directory. */
  tmpDir: string
  inheritedEnv?: Readonly<Record<string, string | undefined>>
}

/**
 * Build the environment for a Thread Home terminal.
 *
 * HOME remains intentionally isolated per workspace so opening a native CLI
 * does not silently expose another workspace's provider config or shell state.
 * PATH is the exception: it is an executable-discovery surface, so it is
 * rebuilt from the same user-configured and common CLI directories used by
 * provider resolution. This fixes Finder-launched Electron processes whose
 * launchd PATH omits Homebrew and user CLI installs.
 */
export function createInteractiveTerminalEnvironment(
  options: InteractiveTerminalEnvironmentOptions
): Record<string, string> {
  const inheritedEnv = options.inheritedEnv ?? process.env
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(inheritedEnv)) {
    if (typeof value === 'string') env[key] = value
  }

  env.HOME = options.home
  env.TMPDIR = options.tmpDir
  env.XDG_CONFIG_HOME = join(options.home, '.config')
  env.XDG_DATA_HOME = join(options.home, '.local', 'share')
  env.XDG_CACHE_HOME = join(options.home, '.cache')
  env.PATH = getCliSearchDirs(null, inheritedEnv).join(delimiter)
  env.TERM = env.TERM || 'xterm-256color'
  env.COLORTERM = env.COLORTERM || 'truecolor'

  return env
}
