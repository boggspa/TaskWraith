import {
  APP_NOTIFICATIONS,
  appNotificationTone,
  type AppNotification
} from '../shared/appNotifications'
import { isRetiredProvider } from '../shared/retiredProviders'
import {
  OLLAMA_MODEL_COMMANDS,
  PROVIDER_INSTALL_COMMANDS,
  type ProviderInstallEntry
} from '../shared/providerSetupCatalog'
import type { ProviderUsageSummary, ProviderUsageWindowSummary } from './ProviderUsageStatus'
import type { ProviderCapabilityContract, ProviderId } from './store/types'

export const REMOTE_FIRST_LAUNCH_SCHEMA_VERSION = 1 as const

export type RemoteFirstLaunchProviderStatusKind =
  | 'ready'
  | 'needsSignIn'
  | 'cliMissing'
  | 'localReady'
  | 'outOfUsage'
  | 'notObservable'
  | 'stale'

export interface RemoteFirstLaunchNotice {
  id: string
  kind: AppNotification['kind']
  title: string
  body: string
  tone: 'default' | 'danger'
  dismissible: boolean
}

export interface RemoteFirstLaunchUsageWindow {
  id: string
  label: string
  usedPercent?: number
  resetAt?: string
}

export interface RemoteFirstLaunchProviderCard {
  id: ProviderId
  label: string
  optional: boolean
  statusKind: RemoteFirstLaunchProviderStatusKind
  statusText: string
  detail: string
  setupHint: string
  setupCommands: Array<Pick<ProviderInstallEntry, 'id' | 'label' | 'command' | 'source' | 'platform'>>
  usageWindows: RemoteFirstLaunchUsageWindow[]
  usageGeneratedAt?: string
}

export interface RemoteFirstLaunchWorkspaceSummary {
  visibleCount: number
  totalCount: number
  runningCount: number
  hasVisibleWorkspaces: boolean
  capabilities: {
    monitor: boolean
    approve: boolean
    answer: boolean
    startTurn: boolean
    steer: boolean
    fileRead: boolean
    fileWrite: boolean
  }
}

export interface RemoteFirstLaunchState {
  schemaVersion: typeof REMOTE_FIRST_LAUNCH_SCHEMA_VERSION
  generatedAt: string
  notifications: RemoteFirstLaunchNotice[]
  workspace: RemoteFirstLaunchWorkspaceSummary
  providerCards: RemoteFirstLaunchProviderCard[]
  setupCommands: Array<Pick<ProviderInstallEntry, 'id' | 'label' | 'command' | 'source' | 'platform'>>
  ollamaModelCommands: Array<{ id: string; label: string; command: string }>
}

export interface RemoteFirstLaunchStateInput {
  generatedAt?: string
  providers: Partial<Record<ProviderId, ProviderCapabilityContract | null | undefined>>
  usage: Partial<Record<ProviderId, ProviderUsageSummary | null | undefined>>
  workspace: RemoteFirstLaunchWorkspaceSummary
  notifications?: readonly AppNotification[]
}

const PROVIDER_ORDER: ProviderId[] = ['codex', 'claude', 'kimi', 'cursor', 'grok', 'ollama']
const OPTIONAL_PROVIDERS = new Set<ProviderId>(['kimi', 'cursor', 'grok', 'ollama'])

const PROVIDER_DESCRIPTIONS: Record<ProviderId, string> = {
  gemini:
    'Gemini is retired for new runs. Existing Gemini chats remain visible in history.',
  codex:
    'OpenAI Codex CLI for fast agentic coding work. Sign-in happens on the Mac through the Codex CLI.',
  claude:
    'Anthropic Claude Code for careful reasoning and edits. OAuth or API-key setup happens on the Mac.',
  kimi:
    'Moonshot Kimi for structured tool-call runs. Use it when a Moonshot API key is configured on the Mac.',
  cursor:
    'Cursor Composer runs through the Cursor CLI. The CLI may still ask for sign-in on the Mac.',
  grok:
    'xAI Grok runs through its local CLI. TaskWraith does not read Grok credentials remotely.',
  ollama:
    'Local Ollama models run on the Mac with no cloud account required. Pull at least one local model on the Mac.'
}

const SETUP_HINTS: Record<ProviderId, string> = {
  gemini: 'Gemini is not offered for new runs.',
  codex: 'On your Mac, install Codex if needed, then run codex login in Terminal.',
  claude: 'On your Mac, open TaskWraith Settings or run the Claude auth flow.',
  kimi: 'On your Mac, add a Moonshot/Kimi API key in TaskWraith Settings.',
  cursor: 'On your Mac, install Cursor CLI and run cursor-agent login if prompted.',
  grok: 'On your Mac, install the Grok CLI and finish xAI/Grok sign-in there.',
  ollama: 'On your Mac, install Ollama, start the service, then pull a supported model.'
}

export function buildRemoteFirstLaunchState(
  input: RemoteFirstLaunchStateInput
): RemoteFirstLaunchState {
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const setupCommands = providerSetupCommands()
  return {
    schemaVersion: REMOTE_FIRST_LAUNCH_SCHEMA_VERSION,
    generatedAt,
    notifications: buildNotices(input.notifications ?? APP_NOTIFICATIONS),
    workspace: input.workspace,
    providerCards: PROVIDER_ORDER.filter((provider) => !isRetiredProvider(provider)).map(
      (provider) =>
        buildProviderCard({
          provider,
          contract: input.providers[provider] ?? null,
          usage: input.usage[provider] ?? null,
          generatedAt,
          setupCommands
        })
    ),
    setupCommands,
    ollamaModelCommands: OLLAMA_MODEL_COMMANDS.map((entry) => ({
      id: entry.id,
      label: entry.label,
      command: entry.command
    }))
  }
}

function buildNotices(notifications: readonly AppNotification[]): RemoteFirstLaunchNotice[] {
  const now = Date.now()
  return notifications
    .filter((notice) => typeof notice.expiresAt !== 'number' || notice.expiresAt > now)
    .map((notice) => ({
      id: notice.id,
      kind: notice.kind,
      title: notice.title,
      body: notice.body,
      tone: appNotificationTone(notice.kind),
      dismissible: notice.dismissible !== false
    }))
}

function providerSetupCommands() {
  return PROVIDER_INSTALL_COMMANDS.filter((entry) => !isRetiredProvider(entry.id)).map((entry) => ({
    id: entry.id,
    label: entry.label,
    command: entry.command,
    source: entry.source,
    ...(entry.platform ? { platform: entry.platform } : {})
  }))
}

function buildProviderCard(args: {
  provider: ProviderId
  contract: ProviderCapabilityContract | null
  usage: ProviderUsageSummary | null
  generatedAt: string
  setupCommands: ReturnType<typeof providerSetupCommands>
}): RemoteFirstLaunchProviderCard {
  const usageWindows = usageWindowsForCard(args.usage)
  const status = deriveProviderStatus(args.provider, args.contract, args.usage)
  return {
    id: args.provider,
    label: providerLabel(args.provider),
    optional: OPTIONAL_PROVIDERS.has(args.provider),
    statusKind: status.kind,
    statusText: status.text,
    detail: status.detail || PROVIDER_DESCRIPTIONS[args.provider],
    setupHint: SETUP_HINTS[args.provider],
    setupCommands: setupCommandsForProvider(args.provider, args.setupCommands),
    usageWindows,
    ...(args.usage?.fetchedAt ? { usageGeneratedAt: args.usage.fetchedAt } : {})
  }
}

function deriveProviderStatus(
  provider: ProviderId,
  contract: ProviderCapabilityContract | null,
  usage: ProviderUsageSummary | null
): { kind: RemoteFirstLaunchProviderStatusKind; text: string; detail?: string } {
  const exhausted = usage?.windows.some(
    (window) => typeof window.usedPercent === 'number' && window.usedPercent >= 99
  )
  if (exhausted) {
    return {
      kind: 'outOfUsage',
      text: 'Out of usage',
      detail: 'Signed in on the Mac, but the current quota window is exhausted.'
    }
  }
  if (usage?.stale) {
    return {
      kind: 'stale',
      text: 'Stale',
      detail: 'The last usage/readiness snapshot is cached. Open TaskWraith on the Mac to refresh it.'
    }
  }
  const availability = contract?.availability
  if (!availability) {
    return {
      kind: 'notObservable',
      text: 'Not loaded yet',
      detail: 'The Mac has not sent a readiness snapshot for this provider yet.'
    }
  }
  if (!availability.available || availability.setupRequired) {
    if (availability.binaryPath === null || availability.version === 'missing') {
      return {
        kind: provider === 'ollama' ? 'notObservable' : 'cliMissing',
        text: provider === 'ollama' ? 'Not observable' : 'CLI missing on Mac',
        detail:
          provider === 'ollama'
            ? 'Ollama was not reachable on the Mac, or no local model is ready yet.'
            : `${providerLabel(provider)} is not installed or was not found by TaskWraith on the Mac.`
      }
    }
    return {
      kind: 'needsSignIn',
      text: 'Needs sign-in on Mac',
      detail: `${providerLabel(provider)} is installed, but setup is not complete on the Mac.`
    }
  }
  if (provider === 'ollama') {
    return {
      kind: 'localReady',
      text: 'Local Ollama ready',
      detail: 'The Mac reports a reachable local Ollama runtime.'
    }
  }
  if (availability.authState === 'missing' || availability.authState === 'expired') {
    return {
      kind: 'needsSignIn',
      text: 'Needs sign-in on Mac',
      detail: `${providerLabel(provider)} needs credentials or a fresh sign-in on the Mac.`
    }
  }
  if (
    availability.authState === 'unknown' ||
    availability.authState === 'not-observable' ||
    availability.authState === 'not-queried' ||
    provider === 'cursor' ||
    provider === 'grok'
  ) {
    return {
      kind: 'notObservable',
      text: 'Not observable',
      detail:
        provider === 'cursor' || provider === 'grok'
          ? `${providerLabel(provider)} CLI is available on the Mac; the CLI may still ask for sign-in when a run starts.`
          : `${providerLabel(provider)} is available, but TaskWraith cannot prove account sign-in from the remote snapshot.`
    }
  }
  return {
    kind: 'ready',
    text: 'Ready on Mac',
    detail: `${providerLabel(provider)} is available for runs on the Mac.`
  }
}

function usageWindowsForCard(usage: ProviderUsageSummary | null): RemoteFirstLaunchUsageWindow[] {
  return (usage?.windows ?? []).slice(0, 3).map((window) => compactUsageWindow(window))
}

function compactUsageWindow(window: ProviderUsageWindowSummary): RemoteFirstLaunchUsageWindow {
  return {
    id: window.id,
    label: window.label,
    ...(typeof window.usedPercent === 'number'
      ? { usedPercent: Math.max(0, Math.min(100, Math.round(window.usedPercent))) }
      : {}),
    ...(window.resetAt ? { resetAt: window.resetAt } : {})
  }
}

function setupCommandsForProvider(
  provider: ProviderId,
  setupCommands: ReturnType<typeof providerSetupCommands>
) {
  return setupCommands.filter((entry) =>
    provider === 'ollama'
      ? entry.id === 'ollama' || entry.id === 'ollama-windows'
      : entry.id === provider
  )
}

function providerLabel(provider: ProviderId): string {
  switch (provider) {
    case 'codex':
      return 'Codex'
    case 'claude':
      return 'Claude'
    case 'kimi':
      return 'Kimi'
    case 'cursor':
      return 'Cursor'
    case 'grok':
      return 'Grok'
    case 'ollama':
      return 'Ollama'
    case 'gemini':
      return 'Gemini'
  }
}
