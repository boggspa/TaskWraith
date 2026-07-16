import { basename } from 'node:path'
import { scrubCliEnv } from '../CliEnvSecurity'

const DISABLED_GIT_PATH = process.platform === 'win32' ? 'NUL' : '/dev/null'

// `include.path` cannot reuse DISABLED_GIT_PATH: git refuses RELATIVE include
// paths in command-line config ("relative config includes must come from
// files" -> "fatal: unable to parse command-line config"), and `NUL` is a
// relative path under Windows rules (no drive prefix or leading separator),
// which broke every hardened git invocation on Windows. Git for Windows
// treats the literal "/dev/null" as absolute (win32_offset_1st_component
// returns 1) and maps it to the NUL device in its compat layer (mingw_fopen /
// mingw_access), so this one spelling is an absolute, empty include target on
// every platform.
const DISABLED_GIT_INCLUDE_PATH = '/dev/null'

const SAFE_GIT_CONFIG_OVERRIDES = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  `core.hooksPath=${DISABLED_GIT_PATH}`,
  '-c',
  `core.attributesFile=${DISABLED_GIT_PATH}`,
  '-c',
  `include.path=${DISABLED_GIT_INCLUDE_PATH}`,
  '-c',
  'diff.external=',
  '-c',
  'credential.helper=',
  '-c',
  'credential.interactive=never',
  '-c',
  'core.sshCommand=ssh',
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'commit.gpgSign=false',
  '-c',
  'tag.gpgSign=false',
  '-c',
  'push.gpgSign=false'
] as const

export const LOCAL_GIT_FILTER_CONFIG_QUERY_ARGS = [
  'config',
  '--local',
  '--includes',
  '--name-only',
  '--get-regexp',
  '^filter\\..*\\.(clean|smudge|process)$'
] as const

export const LOCAL_GIT_CONFIG_KEY_QUERY_ARGS = [
  'config',
  '--local',
  '--includes',
  '--name-only',
  '--list'
] as const

function commandBasename(command: string): string {
  return basename(command).toLowerCase().replace(/\.exe$/, '')
}

/**
 * Repository-local config is untrusted for externally granted repositories.
 * Apply command-scope overrides before every Git subcommand so hooks, monitors,
 * diff helpers, credentials, SSH wrappers, and signing helpers cannot be
 * selected by that config.
 */
export function hardenedGitCommandArgs(command: string, args: readonly string[]): string[] {
  return commandBasename(command) === 'git' ? [...SAFE_GIT_CONFIG_OVERRIDES, ...args] : [...args]
}

/** Build the environment used by Git/GitHub CLI subprocesses. */
export function gitCommandEnvironment(
  command: string,
  commandEnv: Record<string, string> | undefined,
  inheritedEnv: Record<string, string | undefined> = process.env
): Record<string, string> {
  const env = scrubCliEnv({ ...inheritedEnv, ...commandEnv })
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('GIT_')) delete env[key]
    if (key.toUpperCase() === 'SSH_ASKPASS' || key.toUpperCase() === 'SSH_ASKPASS_REQUIRE') {
      delete env[key]
    }
  }
  const executable = commandBasename(command)
  if (executable === 'git') env.GIT_TERMINAL_PROMPT = '0'
  if (executable === 'gh') env.GH_PROMPT_DISABLED = '1'
  return env
}

export function repositoryLocalGitFilterKeys(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

export function repositoryLocalGitFilterError(keys: readonly string[]): string {
  return `Repository-local Git filter commands are not executed by TaskWraith (${keys.join(', ')}).`
}

export function unsafeRepositoryPushConfigKeys(keys: readonly string[]): string[] {
  return keys.filter((key) => {
    const normalized = key.trim().toLowerCase()
    return (
      /^remote\..+\.(receivepack|uploadpack|proxy|vcs)$/.test(normalized) ||
      /^url\..+\.(insteadof|pushinsteadof)$/.test(normalized)
    )
  })
}

export function repositoryLocalPushConfigError(keys: readonly string[]): string {
  return `Repository-local Git transport commands and URL rewrites are not executed by TaskWraith (${keys.join(', ')}).`
}

export function isSafeGitRemoteName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value) && !value.includes('..')
}

/** External repositories may publish only through an explicit network URL. */
export function isSafeExternalGitPushUrl(value: string): boolean {
  const candidate = value.trim()
  if (!candidate || /[\0\r\n]/.test(candidate)) return false
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(candidate)) return true
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') return false
    if (!parsed.hostname || parsed.hostname.startsWith('-')) return false
    if (parsed.password) return false
    return true
  } catch {
    return false
  }
}
