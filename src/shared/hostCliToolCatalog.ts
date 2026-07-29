/**
 * Catalog of OPTIONAL, USER-INSTALLED host CLIs that TaskWraith shells out to
 * but does not own — today just GitHub's `gh`.
 *
 * WHY THIS IS NOT `providerSetupCatalog.ts`
 * -----------------------------------------
 * `PROVIDER_INSTALL_COMMANDS` is keyed by ProviderId and is filtered through
 * `isLiveSelectableProvider` at every render site; it is also projected to the
 * iOS/remote first-launch surface. `gh` is not a provider — it has no seat, no
 * model, no run posture — and the remote projection must stay provider-only
 * (installing a desktop CLI is meaningless on iOS). Keeping this list separate
 * is what makes both of those true by construction rather than by remembering
 * to add a filter.
 *
 * Node-builtin-free so the renderer, main, and tests can all import it.
 *
 * Keep the commands in sync with GitHub's own install page (cli.github.com):
 *   macOS   — brew install gh
 *   Windows — winget install --id GitHub.cli
 * Linux has too many distro-specific routes to guess at, so it gets the docs
 * link instead of a command that might be wrong for the user's package manager.
 */

export type HostCliToolId = 'gh'

export interface HostCliToolInstallCommand {
  /** Stable row id for copy-state tracking and test selection. */
  id: string
  command: string
  /** Which platform this command is correct for. Shown as the row qualifier. */
  platform: string
  /** NodeJS.Platform values this command applies to. */
  platforms: readonly string[]
}

export interface HostCliToolEntry {
  id: HostCliToolId
  /** Binary probed on PATH. */
  binaryName: string
  label: string
  /** What TaskWraith uses it for — shown to the user, not just the agent. */
  purpose: string
  /** What degrades while it is missing. */
  missingConsequence: string
  /** Vendor of the tool, for the "official command" affordance. */
  source: string
  docsUrl: string
  installCommands: readonly HostCliToolInstallCommand[]
  /** Homebrew formula/cask token, for channel-aware upgrades. */
  brewToken?: string
}

export const HOST_CLI_TOOLS: readonly HostCliToolEntry[] = [
  {
    id: 'gh',
    binaryName: 'gh',
    label: 'GitHub CLI',
    purpose:
      'Reads pull request and CI check status for the composer’s PR indicator, powers “Watch this PR” notifications, and backs Create PR in the composer’s Review changes menu.',
    missingConsequence:
      'Without it TaskWraith can still run every Git action, but PR status, CI checks, and PR watching stay unavailable.',
    source: 'GitHub',
    docsUrl: 'https://cli.github.com',
    brewToken: 'gh',
    installCommands: [
      {
        id: 'gh-macos',
        command: 'brew install gh',
        platform: 'macOS',
        platforms: ['darwin']
      },
      {
        id: 'gh-windows',
        command: 'winget install --id GitHub.cli',
        platform: 'Windows',
        platforms: ['win32']
      }
    ]
  }
]

const HOST_CLI_TOOLS_BY_ID = new Map<string, HostCliToolEntry>(
  HOST_CLI_TOOLS.map((entry) => [entry.id, entry])
)

export const HOST_CLI_TOOL_IDS: readonly HostCliToolId[] = HOST_CLI_TOOLS.map((entry) => entry.id)

/** Membership test for untrusted input (IPC payloads, persisted settings). */
export function isHostCliToolId(value: unknown): value is HostCliToolId {
  return typeof value === 'string' && HOST_CLI_TOOLS_BY_ID.has(value)
}

/** Catalog lookup. Returns null for anything not in the bounded set. */
export function hostCliTool(id: unknown): HostCliToolEntry | null {
  return typeof id === 'string' ? (HOST_CLI_TOOLS_BY_ID.get(id) ?? null) : null
}

/**
 * The install command for a platform, or null when we have none for it.
 *
 * Null is a real answer, not a gap to paper over: running a Debian command on
 * Fedora would fail confusingly, so the caller is expected to fall back to the
 * docs link rather than guess.
 */
export function hostCliToolInstallCommand(
  id: HostCliToolId,
  platform: string
): HostCliToolInstallCommand | null {
  const entry = hostCliTool(id)
  if (!entry) return null
  return entry.installCommands.find((command) => command.platforms.includes(platform)) ?? null
}

/** Message for a platform with no vetted install command. */
export function hostCliToolManualInstallMessage(id: HostCliToolId): string {
  const entry = hostCliTool(id)
  if (!entry) return 'This tool has no TaskWraith-managed install command.'
  return (
    `TaskWraith has no vetted ${entry.label} install command for this platform, so it will not ` +
    `guess at one. Install ${entry.binaryName} from ${entry.docsUrl} using your package manager, ` +
    `then reopen this panel.`
  )
}
