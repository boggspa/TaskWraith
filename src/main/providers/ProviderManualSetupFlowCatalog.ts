import type { ProviderId } from '../store/types'

export type ProviderManualSetupAction = 'login' | 'logout' | 'upgrade'

/**
 * Bounded user-owned setup metadata. Commands, URLs, device codes, and
 * credentials stay in the Electron IPC adapter; Host setup sees only this
 * non-secret eligibility/notice projection.
 */
export interface ProviderManualSetupFlow {
  readonly provider: ProviderId
  readonly action: ProviderManualSetupAction
  readonly scope: 'user-owned-provider-setup'
  readonly managedRunReady: false
  readonly notice: string
}

const KIMI_USER_OWNED_SETUP_NOTICE =
  'This is a user-owned Kimi setup command outside TaskWraith managed-run containment. Success does not qualify this runtime for managed Kimi turns or compaction.'

const ANTIGRAVITY_USER_OWNED_SETUP_NOTICE =
  'This opens the official user-installed agy CLI for a user-owned sign-in. TaskWraith does not read, copy, or store Google or AntiGravity OAuth or keyring credentials. Completing sign-in does not make AntiGravity available for managed runs until its runtime support is available.'

const ANTIGRAVITY_USER_OWNED_UPGRADE_NOTICE =
  "This opens the official user-installed agy CLI's own updater. TaskWraith resolves and invokes that same CLI installation but does not download or repackage the update. Updating agy does not make AntiGravity ToS-approved or ban-safe."

const MISTRAL_USER_OWNED_SETUP_NOTICE =
  'This opens the official Mistral Vibe setup wizard for a user-owned plan or API-key sign-in. TaskWraith does not read, copy, or store Vibe credentials. After setup, managed Mistral runs use the separate `vibe-acp` runtime.'

const MUSE_USER_OWNED_SETUP_NOTICE =
  'This opens the official Muse Code CLI for a user-owned Meta Model API login (`muse login`) or credential clear (`muse logout`). TaskWraith does not permanently store Meta credentials; managed runs project the Muse-owned credential into a private seat-local home that is deleted at teardown.'

const MUSE_USER_OWNED_UPGRADE_NOTICE =
  'This invokes the resolved Muse launcher with its synchronous-update flag, so the CLI TaskWraith actually runs is updated in place. Meta owns the launcher, download, and account flow.'

const DEVIN_USER_OWNED_SETUP_NOTICE =
  'This opens the resolved Devin CLI for a user-owned `devin auth login` or credential clear (`devin auth logout`). TaskWraith does not write Devin credentials; managed runs read WINDSURF_API_KEY / DEVIN_API_KEY from the environment or the user-owned credentials.toml the CLI writes.'

const DEVIN_USER_OWNED_UPGRADE_NOTICE =
  'This runs the resolved Devin CLI’s own updater (`devin update`), or the official installer when no CLI is resolved. Cognition owns the download and account flow; TaskWraith does not repackage the update.'

const OLLAMA_USER_OWNED_SETUP_NOTICE =
  'This invokes the resolved official Ollama CLI for account sign-in or sign-out. Ollama owns the browser flow and credentials; TaskWraith stores neither. The same local Ollama daemon then authenticates Ollama Cloud model requests.'

const CODEX_USER_OWNED_SETUP_NOTICE =
  'This opens the resolved Codex CLI for a user-owned sign-in or sign-out. TaskWraith does not read, copy, or store Codex credentials.'

const CLAUDE_USER_OWNED_SETUP_NOTICE =
  'This opens the resolved Claude CLI account flow. TaskWraith does not read, copy, or store Claude credentials.'

const CURSOR_USER_OWNED_SETUP_NOTICE =
  'This opens the resolved Cursor Agent account flow. TaskWraith does not read, copy, or store Cursor credentials.'

const FLOWS: Readonly<Record<string, ProviderManualSetupFlow>> = {
  'codex:login': flow('codex', 'login', CODEX_USER_OWNED_SETUP_NOTICE),
  'codex:logout': flow('codex', 'logout', CODEX_USER_OWNED_SETUP_NOTICE),
  'claude:login': flow('claude', 'login', CLAUDE_USER_OWNED_SETUP_NOTICE),
  'claude:logout': flow('claude', 'logout', CLAUDE_USER_OWNED_SETUP_NOTICE),
  'kimi:login': flow('kimi', 'login', KIMI_USER_OWNED_SETUP_NOTICE),
  'kimi:upgrade': flow('kimi', 'upgrade', KIMI_USER_OWNED_SETUP_NOTICE),
  'antigravity:login': flow('antigravity', 'login', ANTIGRAVITY_USER_OWNED_SETUP_NOTICE),
  'antigravity:upgrade': flow('antigravity', 'upgrade', ANTIGRAVITY_USER_OWNED_UPGRADE_NOTICE),
  'ollama:login': flow('ollama', 'login', OLLAMA_USER_OWNED_SETUP_NOTICE),
  'ollama:logout': flow('ollama', 'logout', OLLAMA_USER_OWNED_SETUP_NOTICE),
  'cursor:login': flow('cursor', 'login', CURSOR_USER_OWNED_SETUP_NOTICE),
  'cursor:logout': flow('cursor', 'logout', CURSOR_USER_OWNED_SETUP_NOTICE),
  'mistral:login': flow('mistral', 'login', MISTRAL_USER_OWNED_SETUP_NOTICE),
  'mistral:upgrade': flow('mistral', 'upgrade', MISTRAL_USER_OWNED_SETUP_NOTICE),
  'muse:login': flow('muse', 'login', MUSE_USER_OWNED_SETUP_NOTICE),
  'muse:logout': flow('muse', 'logout', MUSE_USER_OWNED_SETUP_NOTICE),
  'muse:upgrade': flow('muse', 'upgrade', MUSE_USER_OWNED_UPGRADE_NOTICE),
  'devin:login': flow('devin', 'login', DEVIN_USER_OWNED_SETUP_NOTICE),
  'devin:logout': flow('devin', 'logout', DEVIN_USER_OWNED_SETUP_NOTICE),
  'devin:upgrade': flow('devin', 'upgrade', DEVIN_USER_OWNED_UPGRADE_NOTICE)
}

export function buildProviderManualSetupFlow(
  provider: ProviderId,
  action: ProviderManualSetupAction
): ProviderManualSetupFlow | null {
  return FLOWS[`${provider}:${action}`] || null
}

/** User-owned notice for a provider even when a requested action is unsupported. */
export function providerManualSetupNotice(provider: ProviderId): string | null {
  return (
    buildProviderManualSetupFlow(provider, 'login')?.notice ||
    buildProviderManualSetupFlow(provider, 'upgrade')?.notice ||
    null
  )
}

function flow(
  provider: ProviderId,
  action: ProviderManualSetupAction,
  notice: string
): ProviderManualSetupFlow {
  return Object.freeze({
    provider,
    action,
    scope: 'user-owned-provider-setup',
    managedRunReady: false,
    notice
  })
}
