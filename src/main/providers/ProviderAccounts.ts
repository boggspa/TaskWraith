/**
 * Provider accounts — a second (or third) sign-in for the same provider,
 * tracked side by side with the primary one, the way Limit Counter and
 * Provider Hub model it.
 *
 * The primary account of every provider is the provider itself: everything a
 * single-account install already stores. Each additional account is an opaque
 * slot with a user-chosen label and the one thing that makes it a distinct
 * sign-in — a config folder its CLI signs in to:
 *
 *   - Claude: a `CLAUDE_CONFIG_DIR` the user chooses (e.g. `~/.claude-work`).
 *     Claude Code keeps that folder's OAuth credential in a Keychain item named
 *     `Claude Code-credentials-<first 8 hex of sha256(folder path)>`; the usage
 *     lane derives the same name and only ever READS it.
 *   - Codex: a second private `CODEX_HOME` under userData that TaskWraith
 *     creates, so `codex login` run for the account never touches `~/.codex`
 *     or the primary private home.
 *
 * No credential, token, or raw provider response lives here — only labels,
 * folders, and timestamps. This module is pure over a settings snapshot so it
 * can be unit-tested without Electron; the registry wrapper below binds it to
 * the store.
 */
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, normalize, resolve } from 'node:path'
import type { AppSettings, ProviderCliAccount, ProviderAccountProviderId } from '../store/types'

export const PROVIDER_ACCOUNT_PROVIDER_IDS = ['claude', 'codex'] as const
export const MAX_PROVIDER_ACCOUNTS_PER_PROVIDER = 8
export const PROVIDER_ACCOUNT_LABEL_MAX_LENGTH = 40
export const CODEX_ACCOUNT_HOMES_DIRECTORY = 'codex-home-accounts'

const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

export type ProviderAccountEnvKey = 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME'

export interface ProviderAccountSummary extends ProviderCliAccount {
  /** True when this slot is the one new seats launch with. */
  active: boolean
  envKey: ProviderAccountEnvKey
}

export class ProviderAccountError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderAccountError'
  }
}

export function isProviderAccountProvider(value: unknown): value is ProviderAccountProviderId {
  return value === 'claude' || value === 'codex'
}

export function providerAccountEnvKey(provider: ProviderAccountProviderId): ProviderAccountEnvKey {
  return provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'
}

/** The launch environment that makes a CLI use this account; `{}` for the primary. */
export function providerAccountEnvironment(
  account: ProviderCliAccount | null | undefined
): Record<string, string> {
  if (!account) return {}
  return { [providerAccountEnvKey(account.provider)]: account.configDir }
}

/** Expand a leading `~` and normalise; returns null for anything not absolute. */
export function normalizeAccountConfigDir(value: unknown, home: string = homedir()): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const expanded =
    trimmed === '~' ? home : trimmed.startsWith('~/') ? join(home, trimmed.slice(2)) : trimmed
  if (!isAbsolute(expanded)) return null
  const normalized = normalize(resolve(expanded))
  return normalized.length > 1 ? normalized.replace(/[\\/]+$/, '') : normalized
}

/** The default Claude config folder — the PRIMARY account, never a secondary slot. */
export function defaultClaudeConfigDir(home: string = homedir()): string {
  return join(home, '.claude')
}

/**
 * Keychain service name Claude Code uses for a non-default config folder:
 * `Claude Code-credentials-<first 8 hex of sha256(NFC path)>`. The default
 * folder keeps the bare `Claude Code-credentials` item.
 */
export function claudeAccountKeychainService(configDir: string, home: string = homedir()): string {
  const base = 'Claude Code-credentials'
  const normalized = normalizeAccountConfigDir(configDir, home) ?? configDir
  if (normalized === defaultClaudeConfigDir(home)) return base
  const digest = createHash('sha256').update(normalized.normalize('NFC'), 'utf8').digest('hex')
  return `${base}-${digest.slice(0, 8)}`
}

/** The private CODEX_HOME TaskWraith creates for a secondary Codex account. */
export function codexAccountHomePath(userDataPath: string, accountId: string): string {
  if (!isAbsolute(userDataPath)) {
    throw new ProviderAccountError('TaskWraith userData path must be absolute.')
  }
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new ProviderAccountError('Codex account id is not a safe directory name.')
  }
  return join(userDataPath, CODEX_ACCOUNT_HOMES_DIRECTORY, accountId)
}

function cleanLabel(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').slice(0, PROVIDER_ACCOUNT_LABEL_MAX_LENGTH)
    : ''
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  return Number.isNaN(Date.parse(value)) ? null : value
}

/** Load-time normalisation: drop anything that is not a well-formed account. */
export function sanitizeProviderAccounts(value: unknown): ProviderCliAccount[] {
  if (!Array.isArray(value)) return []
  const seenIds = new Set<string>()
  const perProvider = new Map<ProviderAccountProviderId, number>()
  const accounts: ProviderCliAccount[] = []
  for (const raw of value) {
    const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
    if (!record) continue
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    if (!ACCOUNT_ID_PATTERN.test(id) || seenIds.has(id)) continue
    if (!isProviderAccountProvider(record.provider)) continue
    const configDir = normalizeAccountConfigDir(record.configDir)
    if (!configDir) continue
    const count = perProvider.get(record.provider) ?? 0
    if (count >= MAX_PROVIDER_ACCOUNTS_PER_PROVIDER) continue
    const label = cleanLabel(record.label) || `Account ${count + 2}`
    const createdAt = isoOrNull(record.createdAt) ?? new Date(0).toISOString()
    const updatedAt = isoOrNull(record.updatedAt) ?? createdAt
    seenIds.add(id)
    perProvider.set(record.provider, count + 1)
    accounts.push({ id, provider: record.provider, label, configDir, createdAt, updatedAt })
  }
  return accounts
}

/** Load-time normalisation: an active id must name an account of that provider. */
export function sanitizeActiveProviderAccountIds(
  value: unknown,
  accounts: readonly ProviderCliAccount[]
): Partial<Record<ProviderAccountProviderId, string | null>> {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  const active: Partial<Record<ProviderAccountProviderId, string | null>> = {}
  if (!record) return active
  for (const provider of PROVIDER_ACCOUNT_PROVIDER_IDS) {
    const candidate = record[provider]
    if (
      typeof candidate === 'string' &&
      accounts.some((account) => account.provider === provider && account.id === candidate)
    ) {
      active[provider] = candidate
    }
  }
  return active
}

type AccountSettings = Pick<AppSettings, 'providerAccounts' | 'activeProviderAccountIds'>

export function listProviderAccounts(
  settings: AccountSettings,
  provider?: ProviderAccountProviderId
): ProviderCliAccount[] {
  const accounts = sanitizeProviderAccounts(settings.providerAccounts)
  return provider ? accounts.filter((account) => account.provider === provider) : accounts
}

/** The account new seats launch with, or null when the primary sign-in is active. */
export function resolveActiveProviderAccount(
  settings: AccountSettings,
  provider: ProviderAccountProviderId
): ProviderCliAccount | null {
  const accounts = listProviderAccounts(settings, provider)
  const activeId = sanitizeActiveProviderAccountIds(settings.activeProviderAccountIds, accounts)[
    provider
  ]
  return activeId ? (accounts.find((account) => account.id === activeId) ?? null) : null
}

export function summarizeProviderAccounts(
  settings: AccountSettings,
  provider?: ProviderAccountProviderId
): ProviderAccountSummary[] {
  const accounts = listProviderAccounts(settings, provider)
  const active = sanitizeActiveProviderAccountIds(settings.activeProviderAccountIds, accounts)
  return accounts.map((account) => ({
    ...account,
    active: active[account.provider] === account.id,
    envKey: providerAccountEnvKey(account.provider)
  }))
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
}

export interface ProviderAccountRegistryDeps {
  getSettings: () => AccountSettings
  updateSettings: (patch: AccountSettings) => void
  getUserDataPath: () => string
  now?: () => Date
  randomSuffix?: () => string
  homeDir?: () => string
}

export interface AddProviderAccountInput {
  provider: unknown
  label?: unknown
  /** Required for Claude (the CLAUDE_CONFIG_DIR); ignored for Codex. */
  configDir?: unknown
}

export interface UpdateProviderAccountInput {
  id: unknown
  label?: unknown
  /** Claude only; a Codex home is TaskWraith-owned and never moves. */
  configDir?: unknown
}

function defaultRandomSuffix(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0')
}

/**
 * Settings-backed registry. Every mutation re-reads settings so a concurrent
 * change elsewhere in main is never overwritten from a stale copy.
 */
export function createProviderAccountRegistry(deps: ProviderAccountRegistryDeps) {
  const now = deps.now ?? (() => new Date())
  const randomSuffix = deps.randomSuffix ?? defaultRandomSuffix
  const home = () => (deps.homeDir ? deps.homeDir() : homedir())

  const write = (
    accounts: ProviderCliAccount[],
    active?: Partial<Record<ProviderAccountProviderId, string | null>>
  ): void => {
    const settings = deps.getSettings()
    const activeIds = sanitizeActiveProviderAccountIds(
      { ...(settings.activeProviderAccountIds ?? {}), ...(active ?? {}) },
      accounts
    )
    deps.updateSettings({ providerAccounts: accounts, activeProviderAccountIds: activeIds })
  }

  const requireAccount = (id: unknown): ProviderCliAccount => {
    const accountId = typeof id === 'string' ? id.trim() : ''
    const account = listProviderAccounts(deps.getSettings()).find(
      (candidate) => candidate.id === accountId
    )
    if (!account) throw new ProviderAccountError('That provider account no longer exists.')
    return account
  }

  const requireClaudeConfigDir = (
    value: unknown,
    existing: readonly ProviderCliAccount[],
    exceptId?: string
  ): string => {
    const configDir = normalizeAccountConfigDir(value, home())
    if (!configDir) {
      throw new ProviderAccountError(
        'Choose an absolute folder for the account (for example ~/.claude-work).'
      )
    }
    if (configDir === defaultClaudeConfigDir(home())) {
      throw new ProviderAccountError(
        '~/.claude is the primary Claude sign-in; pick a different folder for a second account.'
      )
    }
    if (
      existing.some(
        (account) =>
          account.provider === 'claude' &&
          account.id !== exceptId &&
          account.configDir === configDir
      )
    ) {
      throw new ProviderAccountError('Another Claude account already uses that folder.')
    }
    return configDir
  }

  return {
    list: (provider?: ProviderAccountProviderId): ProviderAccountSummary[] =>
      summarizeProviderAccounts(deps.getSettings(), provider),

    active: (provider: ProviderAccountProviderId): ProviderCliAccount | null =>
      resolveActiveProviderAccount(deps.getSettings(), provider),

    add: (input: AddProviderAccountInput): ProviderAccountSummary => {
      if (!isProviderAccountProvider(input.provider)) {
        throw new ProviderAccountError('Secondary accounts are supported for Claude and Codex.')
      }
      const provider = input.provider
      const accounts = listProviderAccounts(deps.getSettings())
      const siblings = accounts.filter((account) => account.provider === provider)
      if (siblings.length >= MAX_PROVIDER_ACCOUNTS_PER_PROVIDER) {
        throw new ProviderAccountError(
          `At most ${MAX_PROVIDER_ACCOUNTS_PER_PROVIDER} extra accounts per provider.`
        )
      }
      const label = cleanLabel(input.label) || `Account ${siblings.length + 2}`
      if (siblings.some((account) => account.label.toLowerCase() === label.toLowerCase())) {
        throw new ProviderAccountError(`An account labelled "${label}" already exists.`)
      }
      let id = `${provider}-${slugify(label) || 'account'}-${randomSuffix()}`
      while (accounts.some((account) => account.id === id)) {
        id = `${provider}-${slugify(label) || 'account'}-${randomSuffix()}`
      }
      const configDir =
        provider === 'codex'
          ? codexAccountHomePath(deps.getUserDataPath(), id)
          : requireClaudeConfigDir(input.configDir, accounts)
      const stamp = now().toISOString()
      const account: ProviderCliAccount = {
        id,
        provider,
        label,
        configDir,
        createdAt: stamp,
        updatedAt: stamp
      }
      write([...accounts, account])
      return { ...account, active: false, envKey: providerAccountEnvKey(provider) }
    },

    update: (input: UpdateProviderAccountInput): ProviderAccountSummary => {
      const current = requireAccount(input.id)
      const accounts = listProviderAccounts(deps.getSettings())
      const label = input.label === undefined ? current.label : cleanLabel(input.label)
      if (!label) throw new ProviderAccountError('Give the account a label.')
      if (
        accounts.some(
          (account) =>
            account.provider === current.provider &&
            account.id !== current.id &&
            account.label.toLowerCase() === label.toLowerCase()
        )
      ) {
        throw new ProviderAccountError(`An account labelled "${label}" already exists.`)
      }
      const configDir =
        current.provider === 'claude' && input.configDir !== undefined
          ? requireClaudeConfigDir(input.configDir, accounts, current.id)
          : current.configDir
      const next: ProviderCliAccount = {
        ...current,
        label,
        configDir,
        updatedAt: now().toISOString()
      }
      write(accounts.map((account) => (account.id === current.id ? next : account)))
      const active = resolveActiveProviderAccount(deps.getSettings(), current.provider)
      return {
        ...next,
        active: active?.id === next.id,
        envKey: providerAccountEnvKey(current.provider)
      }
    },

    remove: (id: unknown): boolean => {
      const current = requireAccount(id)
      const accounts = listProviderAccounts(deps.getSettings())
      const remaining = accounts.filter((account) => account.id !== current.id)
      const settings = deps.getSettings()
      const activeIds = sanitizeActiveProviderAccountIds(
        settings.activeProviderAccountIds,
        accounts
      )
      write(
        remaining,
        activeIds[current.provider] === current.id ? { [current.provider]: null } : undefined
      )
      return true
    },

    setActive: (
      provider: unknown,
      accountId: unknown
    ): { provider: ProviderAccountProviderId; accountId: string | null } => {
      if (!isProviderAccountProvider(provider)) {
        throw new ProviderAccountError('Secondary accounts are supported for Claude and Codex.')
      }
      const accounts = listProviderAccounts(deps.getSettings())
      let nextId: string | null = null
      if (accountId !== null && accountId !== undefined && accountId !== '') {
        const account = requireAccount(accountId)
        if (account.provider !== provider) {
          throw new ProviderAccountError('That account belongs to a different provider.')
        }
        nextId = account.id
      }
      write(accounts, { [provider]: nextId })
      return { provider, accountId: nextId }
    }
  }
}

export type ProviderAccountRegistry = ReturnType<typeof createProviderAccountRegistry>
