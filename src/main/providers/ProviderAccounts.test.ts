import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { AppSettings, ProviderCliAccount } from '../store/types'
import {
  MAX_PROVIDER_ACCOUNTS_PER_PROVIDER,
  ProviderAccountError,
  claudeAccountKeychainService,
  codexAccountHomePath,
  createProviderAccountRegistry,
  normalizeAccountConfigDir,
  providerAccountEnvironment,
  resolveActiveProviderAccount,
  sanitizeActiveProviderAccountIds,
  sanitizeProviderAccounts
} from './ProviderAccounts'

const HOME = '/Users/tester'
const USER_DATA = '/Users/tester/Library/Application Support/taskwraith'

function account(overrides: Partial<ProviderCliAccount> = {}): ProviderCliAccount {
  return {
    id: 'claude-work-abc123',
    provider: 'claude',
    label: 'Work',
    configDir: '/Users/tester/.claude-work',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides
  }
}

function harness(initial: Partial<AppSettings> = {}) {
  let settings: Partial<AppSettings> = {
    providerAccounts: [],
    activeProviderAccountIds: {},
    ...initial
  }
  let counter = 0
  const registry = createProviderAccountRegistry({
    getSettings: () => settings,
    updateSettings: (patch) => {
      settings = { ...settings, ...patch }
    },
    getUserDataPath: () => USER_DATA,
    now: () => new Date('2026-10-07T12:00:00.000Z'),
    randomSuffix: () => `s${(counter += 1)}`.padEnd(6, '0'),
    homeDir: () => HOME
  })
  return { registry, settings: () => settings }
}

describe('normalizeAccountConfigDir', () => {
  it('expands ~ against the given home and strips a trailing slash', () => {
    expect(normalizeAccountConfigDir('~/.claude-work/', HOME)).toBe('/Users/tester/.claude-work')
    expect(normalizeAccountConfigDir('~', HOME)).toBe(HOME)
  })

  it('rejects relative, blank and non-string input', () => {
    expect(normalizeAccountConfigDir('work', HOME)).toBeNull()
    expect(normalizeAccountConfigDir('   ', HOME)).toBeNull()
    expect(normalizeAccountConfigDir(42, HOME)).toBeNull()
  })
})

describe('claudeAccountKeychainService', () => {
  it('derives Claude Code’s per-folder Keychain item name from the sha256 of the path', () => {
    // sha256("/Users/tester/.claude-work") = 1e0a9e8b… — the first 8 hex chars.
    expect(claudeAccountKeychainService('/Users/tester/.claude-work', HOME)).toMatch(
      /^Claude Code-credentials-[0-9a-f]{8}$/
    )
    expect(claudeAccountKeychainService('~/.claude-work', HOME)).toBe(
      claudeAccountKeychainService('/Users/tester/.claude-work/', HOME)
    )
  })

  it('keeps the bare item name for the default ~/.claude folder', () => {
    expect(claudeAccountKeychainService('~/.claude', HOME)).toBe('Claude Code-credentials')
  })
})

describe('codexAccountHomePath', () => {
  it('places each Codex account home under userData and refuses unsafe ids', () => {
    expect(codexAccountHomePath(USER_DATA, 'codex-work-abc123')).toBe(
      join(USER_DATA, 'codex-home-accounts', 'codex-work-abc123')
    )
    expect(() => codexAccountHomePath(USER_DATA, '../escape')).toThrow(ProviderAccountError)
    expect(() => codexAccountHomePath('relative', 'codex-work')).toThrow(ProviderAccountError)
  })
})

describe('sanitizeProviderAccounts', () => {
  it('drops malformed, duplicate, unknown-provider and relative-folder entries', () => {
    const accounts = sanitizeProviderAccounts([
      account(),
      account({ id: 'claude-work-abc123', label: 'Duplicate id' }),
      account({ id: 'Bad Id!' }),
      account({ id: 'kimi-x', provider: 'kimi' as 'claude' }),
      account({ id: 'claude-rel', configDir: 'relative/dir' }),
      null,
      'nonsense'
    ])
    expect(accounts.map((entry) => entry.id)).toEqual(['claude-work-abc123'])
  })

  it('caps each provider at the slot limit and backfills a blank label', () => {
    const many = Array.from({ length: MAX_PROVIDER_ACCOUNTS_PER_PROVIDER + 2 }, (_, index) =>
      account({ id: `claude-${index}`, label: '', configDir: `/Users/tester/.claude-${index}` })
    )
    const accounts = sanitizeProviderAccounts(many)
    expect(accounts).toHaveLength(MAX_PROVIDER_ACCOUNTS_PER_PROVIDER)
    expect(accounts[0].label).toBe('Account 2')
  })

  it('only keeps an active id that names an account of the same provider', () => {
    const accounts = [account()]
    expect(
      sanitizeActiveProviderAccountIds(
        { claude: 'claude-work-abc123', codex: 'claude-work-abc123' },
        accounts
      )
    ).toEqual({ claude: 'claude-work-abc123' })
    expect(sanitizeActiveProviderAccountIds('nope', accounts)).toEqual({})
  })
})

describe('createProviderAccountRegistry', () => {
  it('adds a Claude account from a ~ folder and reports it inactive until chosen', () => {
    const { registry, settings } = harness()
    const added = registry.add({
      provider: 'claude',
      label: '  Work  ',
      configDir: '~/.claude-work'
    })
    expect(added).toMatchObject({
      id: 'claude-work-s10000',
      provider: 'claude',
      label: 'Work',
      configDir: '/Users/tester/.claude-work',
      active: false,
      envKey: 'CLAUDE_CONFIG_DIR'
    })
    expect(settings().providerAccounts).toHaveLength(1)
    expect(resolveActiveProviderAccount(settings(), 'claude')).toBeNull()
    expect(providerAccountEnvironment(added)).toEqual({
      CLAUDE_CONFIG_DIR: '/Users/tester/.claude-work'
    })
  })

  it('creates a private TaskWraith home for a Codex account instead of taking a folder', () => {
    const { registry } = harness()
    const added = registry.add({ provider: 'codex', label: 'Boggspa', configDir: '/ignored' })
    expect(added.configDir).toBe(join(USER_DATA, 'codex-home-accounts', 'codex-boggspa-s10000'))
    expect(providerAccountEnvironment(added)).toEqual({ CODEX_HOME: added.configDir })
  })

  it('refuses the primary ~/.claude folder, a reused folder, a reused label and unknown providers', () => {
    const { registry } = harness()
    registry.add({ provider: 'claude', label: 'Work', configDir: '~/.claude-work' })
    expect(() =>
      registry.add({ provider: 'claude', label: 'Home', configDir: '~/.claude' })
    ).toThrow(/primary Claude sign-in/)
    expect(() =>
      registry.add({ provider: 'claude', label: 'Again', configDir: '~/.claude-work/' })
    ).toThrow(/already uses that folder/)
    expect(() =>
      registry.add({ provider: 'claude', label: 'work', configDir: '~/.claude-other' })
    ).toThrow(/already exists/)
    expect(() => registry.add({ provider: 'kimi', label: 'x' })).toThrow(ProviderAccountError)
    expect(() => registry.add({ provider: 'claude', label: 'NoDir' })).toThrow(/absolute folder/)
  })

  it('switches, renames and removes accounts, clearing the active slot on removal', () => {
    const { registry, settings } = harness()
    const work = registry.add({ provider: 'claude', label: 'Work', configDir: '~/.claude-work' })
    expect(registry.setActive('claude', work.id)).toEqual({
      provider: 'claude',
      accountId: work.id
    })
    expect(resolveActiveProviderAccount(settings(), 'claude')?.id).toBe(work.id)
    expect(registry.list('claude')[0].active).toBe(true)

    const renamed = registry.update({ id: work.id, label: 'Work (Boggspa)' })
    expect(renamed.label).toBe('Work (Boggspa)')
    expect(renamed.active).toBe(true)
    expect(renamed.updatedAt).toBe('2026-10-07T12:00:00.000Z')

    expect(() => registry.setActive('codex', work.id)).toThrow(/different provider/)
    expect(registry.setActive('claude', null)).toEqual({ provider: 'claude', accountId: null })
    registry.setActive('claude', work.id)
    expect(registry.remove(work.id)).toBe(true)
    expect(settings().providerAccounts).toEqual([])
    expect(resolveActiveProviderAccount(settings(), 'claude')).toBeNull()
    expect(() => registry.remove(work.id)).toThrow(/no longer exists/)
  })

  it('never moves a Codex home on update', () => {
    const { registry } = harness()
    const added = registry.add({ provider: 'codex', label: 'Second' })
    const updated = registry.update({ id: added.id, label: 'Renamed', configDir: '/elsewhere' })
    expect(updated.configDir).toBe(added.configDir)
  })

  it('caps the registry at the per-provider limit', () => {
    const { registry } = harness()
    for (let index = 0; index < MAX_PROVIDER_ACCOUNTS_PER_PROVIDER; index += 1) {
      registry.add({ provider: 'claude', label: `Slot ${index}`, configDir: `~/.claude-${index}` })
    }
    expect(() =>
      registry.add({ provider: 'claude', label: 'One more', configDir: '~/.claude-more' })
    ).toThrow(/At most/)
  })
})
