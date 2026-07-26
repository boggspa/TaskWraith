/**
 * Which package manager owns a resolved CLI binary, and therefore which
 * command can actually upgrade it.
 *
 * WHY THIS EXISTS
 * ---------------
 * The in-app "Upgrade" buttons ran a hardcoded `npm install -g <pkg>@latest`
 * regardless of how the binary TaskWraith actually executes was installed. For
 * a Homebrew-cask install that is not a no-op — it is worse: npm cheerfully
 * installs a SECOND copy somewhere else, reports success, and the binary
 * TaskWraith resolves never moves. The user then sees "upgraded" and keeps
 * hitting version-gated failures like:
 *
 *   The 'gpt-5.6-terra' model requires a newer version of Codex.
 *
 * …with no way to tell that the upgrade went to a different install. Silently
 * upgrading something other than what we run is worse than refusing to upgrade.
 *
 * Pure and string-only so it unit-tests without a filesystem. Callers pass a
 * REALPATH — the interesting evidence lives past the symlink, since both
 * channels put a link in the same `bin` directory:
 *
 *   npm    /opt/homebrew/bin/codex -> ../lib/node_modules/@openai/codex/bin/codex.js
 *   cask   /opt/homebrew/bin/codex -> ../Caskroom/codex/0.144.0/codex-aarch64-apple-darwin
 */

export type CliInstallChannel = 'npm' | 'homebrew-cask' | 'homebrew-formula' | 'unknown'

/**
 * Classify from the resolved real path. Order matters: a Homebrew *cask* path
 * also lives under the Homebrew prefix, so Caskroom is tested before the
 * generic Cellar/formula shape, and `node_modules` before either — npm's
 * global prefix is frequently inside Homebrew's own tree, which is exactly the
 * case that made the naive "is it under /opt/homebrew?" guess wrong.
 */
export function detectCliInstallChannel(realPath: string | null | undefined): CliInstallChannel {
  const path = String(realPath || '').trim()
  if (!path) return 'unknown'
  const normalized = path.replace(/\\/g, '/')
  if (normalized.includes('/node_modules/')) return 'npm'
  if (normalized.includes('/Caskroom/')) return 'homebrew-cask'
  if (normalized.includes('/Cellar/')) return 'homebrew-formula'
  return 'unknown'
}

export interface CliUpgradeCommandInput {
  channel: CliInstallChannel
  /** Package name for the npm channel, e.g. `@openai/codex`. */
  npmPackage: string
  /** Formula/cask token for the Homebrew channels, e.g. `codex`. */
  brewToken?: string
}

/**
 * The command that upgrades THIS install, or null when we cannot tell.
 *
 * Returning null is the point: a caller that cannot identify the channel must
 * tell the user to upgrade via whatever installed it, rather than running a
 * command that appears to work and changes nothing.
 */
export function cliUpgradeCommand(input: CliUpgradeCommandInput): string[] | null {
  switch (input.channel) {
    case 'npm':
      return ['npm', 'install', '-g', `${input.npmPackage}@latest`]
    case 'homebrew-cask':
      return input.brewToken ? ['brew', 'upgrade', '--cask', input.brewToken] : null
    case 'homebrew-formula':
      return input.brewToken ? ['brew', 'upgrade', input.brewToken] : null
    default:
      return null
  }
}

/** Message for the unknown-channel case, naming the binary we actually run. */
export function unknownInstallChannelMessage(label: string, binaryPath: string): string {
  return (
    `TaskWraith could not tell how ${label} was installed, so it will not guess at an ` +
    `upgrade command — running the wrong one would upgrade a different copy and appear ` +
    `to succeed. Upgrade ${binaryPath} using whichever tool installed it, then retry.`
  )
}
