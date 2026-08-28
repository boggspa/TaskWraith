/**
 * Hardened argv and environment for Host-side git READS.
 *
 * "Read-only" describes what git does to the repo, not what the repo can do to
 * us. Repository-local config is attacker-controlled for any repository the user
 * opens, so a bare `git status` is arbitrary code execution without the -c
 * overrides below: core.hooksPath, an ext-diff helper, a credential helper or an
 * ssh wrapper all run a program of the repository's choosing. Anyone tempted to
 * trim that override list should read this paragraph first.
 *
 * Ported from the desktop donors — src/main/services/GitCommandSecurity.ts and
 * src/main/CliEnvSecurity.ts — because hostNodeBoundary.test.ts confines the Host
 * closure to node:* plus host-node/host-runtime/shared/host-shared. src/main is
 * not importable, so this is a deliberate port, not a re-derivation.
 */

const DISABLED_GIT_PATH = process.platform === 'win32' ? 'NUL' : '/dev/null'

/**
 * `include.path` cannot reuse DISABLED_GIT_PATH: git refuses RELATIVE include
 * paths in command-line config ("relative config includes must come from files"
 * -> "fatal: unable to parse command-line config"), and `NUL` is a relative path
 * under Windows rules (no drive prefix or leading separator), which broke every
 * hardened git invocation on Windows. Git for Windows treats the literal
 * "/dev/null" as absolute (win32_offset_1st_component returns 1) and maps it to
 * the NUL device in its compat layer (mingw_fopen / mingw_access), so this one
 * spelling is an absolute, empty include target on every platform.
 *
 * (Comment preserved verbatim from the donor — it records a real Windows
 * regression this exact spelling already caused once.)
 */
const DISABLED_GIT_INCLUDE_PATH = '/dev/null'

/** Every entry closes an arbitrary-code-execution or credential-exfiltration path. */
export const HOST_GIT_SAFE_CONFIG_OVERRIDES = [
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

/** Secret-bearing keys, ported from CliEnvSecurity. A git read never needs these. */
const SCRUBBED_ENV_KEYS = new Set([
  'APPLE_ID',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_KEYCHAIN_PROFILE',
  'APP_STORE_CONNECT_API_KEY',
  'APP_STORE_CONNECT_API_KEY_ID',
  'APP_STORE_CONNECT_API_ISSUER_ID',
  'ASC_KEY_ID',
  'ASC_ISSUER_ID',
  'ASC_PRIVATE_KEY',
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'CSC_NAME',
  'MACOS_CSC_LINK',
  'MACOS_CSC_KEY_PASSWORD',
  'WINDOWS_CSC_LINK',
  'WINDOWS_CSC_KEY_PASSWORD',
  'GH_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'HOMEBREW_GITHUB_API_TOKEN',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'YARN_NPM_AUTH_TOKEN',
  'FASTLANE_SESSION',
  'MATCH_PASSWORD',
  'TWINE_API_TOKEN',
  'CARGO_REGISTRY_TOKEN'
])

const SCRUBBED_ENV_PREFIXES = [
  'ASC_',
  'APP_STORE_CONNECT_',
  'CSC_',
  'MACOS_CSC_',
  'WINDOWS_CSC_',
  'CARGO_REGISTRY_'
] as const

export function shouldScrubHostGitEnvKey(key: string): boolean {
  const normalized = String(key || '')
    .trim()
    .toUpperCase()
  if (!normalized) return false
  if (SCRUBBED_ENV_KEYS.has(normalized)) return true
  if (SCRUBBED_ENV_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true
  // GIT_DIR / GIT_WORK_TREE / GIT_CONFIG / GIT_SSH_COMMAND can redirect or
  // re-target the read entirely, so the whole namespace goes.
  if (normalized.startsWith('GIT_')) return true
  // An askpass helper is arbitrary execution on any credential prompt.
  if (normalized === 'SSH_ASKPASS' || normalized === 'SSH_ASKPASS_REQUIRE') return true
  return false
}

/** Prepends the command-scope overrides. The caller supplies read-only argv. */
export function hardenedHostGitArgs(args: readonly string[]): string[] {
  return [...HOST_GIT_SAFE_CONFIG_OVERRIDES, ...args]
}

/**
 * Scrubbed environment with non-interactive prompting forced on.
 *
 * ORDER IS LOAD-BEARING. The scrub removes EVERY key beginning with GIT_, and
 * GIT_TERMINAL_PROMPT is one of them. Setting the flag before scrubbing deletes
 * it again, and the failure mode is a git process that BLOCKS waiting for
 * credentials — a hang, not an error, which no ordinary assertion catches. The
 * assignment must therefore come after the loop, never inside or before it.
 */
export function hostGitEnvironment(
  inherited: Record<string, string | undefined> = process.env
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(inherited)) {
    if (typeof value !== 'string') continue
    if (shouldScrubHostGitEnvKey(key)) continue
    env[key] = value
  }
  // AFTER the scrub. See the ordering note above.
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}

/**
 * Read-only subcommands this Host may run — an ALLOWLIST, not a denylist. An
 * unknown subcommand is refused rather than inspected for write-ness, because
 * the set of git subcommands that can mutate is open-ended.
 *
 * `show` and `blame` are deliberately absent (M5 scope decision).
 */
const READ_ONLY_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'branch', 'rev-parse'])

/**
 * Argv-level guard. Even with hardened config, an unexpected subcommand or a
 * flag that can execute or write must never reach spawn. `-c` is refused from
 * callers specifically: a caller-supplied override could undo the hardening
 * this module exists to apply.
 */
export function assertReadOnlyHostGitArgs(args: readonly string[]): void {
  for (const arg of args) {
    if (typeof arg !== 'string' || /[\0\r\n]/.test(arg)) {
      throw new HostGitRefusedError('Host git argv must not contain control characters.')
    }
  }
  // Forbidden ARGUMENTS are checked before the subcommand so `-c evil status`
  // reports the real reason. Checking the subcommand first would report the
  // config VALUE as an unknown subcommand — refused either way, but the
  // diagnostic would point at the wrong thing.
  for (const arg of args) {
    if (
      arg === '-c' ||
      arg.startsWith('--config-env') ||
      /^--exec\b/.test(arg) ||
      /^--exec-path/.test(arg) ||
      /^--(upload-pack|receive-pack|output|ext)\b/.test(arg)
    ) {
      throw new HostGitRefusedError(`Host git refuses the argument '${arg}'.`)
    }
  }
  const subcommand = args.find((arg) => !arg.startsWith('-'))
  if (!subcommand || !READ_ONLY_SUBCOMMANDS.has(subcommand)) {
    throw new HostGitRefusedError(
      `Host git refuses the subcommand ${subcommand ? `'${subcommand}'` : '(none)'}.`
    )
  }
}

/**
 * True when the resolved executable is git.
 *
 * Splits on BOTH separators rather than using node:path basename alone: on
 * POSIX, basename() does not treat '\' as a separator, so a Windows-style path
 * would be compared whole and classified as not-git. The Host runs on every
 * platform, so the check must not depend on the platform it runs on.
 */
export function isGitExecutable(command: string): boolean {
  const leaf =
    String(command || '')
      .split(/[\\/]/)
      .pop() ?? ''
  return leaf.toLowerCase().replace(/\.exe$/, '') === 'git'
}

export class HostGitError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'HostGitError'
  }
}

/** A fail-closed refusal: scope, argv, or repository shape was not acceptable. */
export class HostGitRefusedError extends HostGitError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'HostGitRefusedError'
  }
}
