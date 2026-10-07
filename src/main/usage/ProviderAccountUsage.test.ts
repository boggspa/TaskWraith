import { describe, expect, it, vi } from 'vitest'
import type { ProviderCliAccount } from '../store/types'
import type { NormalizedProviderUsageSnapshot } from '../ProviderQuotaSnapshots'
import {
  createProviderAccountUsageReader,
  projectProviderAccountSnapshot,
  type ProviderAccountUsageDeps
} from './ProviderAccountUsage'

const START = Date.parse('2026-10-07T12:00:00.000Z')

const claudeWork: ProviderCliAccount = {
  id: 'claude-work-abc123',
  provider: 'claude',
  label: 'Work',
  configDir: '/Users/tester/.claude-work',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z'
}

const codexSecond: ProviderCliAccount = {
  id: 'codex-second-def456',
  provider: 'codex',
  label: 'Second',
  configDir:
    '/Users/tester/Library/Application Support/taskwraith/codex-home-accounts/codex-second-def456',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z'
}

function claudeSnapshot(usedPercent = 23): NormalizedProviderUsageSnapshot {
  return {
    provider: 'claude',
    source: 'claude-oauth-usage',
    configured: true,
    subscriptionType: 'max',
    fetchedAt: '2026-10-07T11:59:00.000Z',
    windows: [
      {
        id: 'claude-5h',
        label: 'Session',
        runs: 0,
        totalTokens: 0,
        limitLabel: `${100 - usedPercent}% remaining`,
        resetAt: '2026-10-07T16:00:00.000Z',
        trackingOnly: false,
        usedPercent,
        remainingPercent: 100 - usedPercent,
        limitWindowSeconds: 18_000
      }
    ],
    balances: [{ label: 'Extra Usage', amount: 3.5, unit: 'USD', subtitle: '1.5 of 5 USD used' }]
  }
}

function codexSnapshot(): NormalizedProviderUsageSnapshot {
  return {
    provider: 'codex',
    source: 'chatgpt-wham',
    configured: true,
    planType: 'pro',
    fetchedAt: '2026-10-07T11:58:00.000Z',
    windows: [
      {
        id: 'primary-weekly',
        label: 'Weekly',
        runs: 0,
        totalTokens: 0,
        limitLabel: '12% remaining',
        trackingOnly: false,
        usedPercent: 88,
        remainingPercent: 12
      }
    ],
    balances: [{ label: 'Credits Remaining', amount: 0, unit: 'credits' }]
  }
}

function harness(overrides: Partial<ProviderAccountUsageDeps> = {}) {
  let clock = START
  const deps: ProviderAccountUsageDeps = {
    listAccounts: () => [claudeWork, codexSecond],
    readClaudeCredential: vi.fn(async () => ({ accessToken: 'claude-token' })),
    fetchClaudeUsage: vi.fn(async () => claudeSnapshot()),
    readCodexCredential: vi.fn(async () => ({
      accessToken: 'codex-token',
      accountId: 'acct',
      importedAt: '2026-10-07T00:00:00.000Z',
      source: 'chatgpt-auth-live'
    })),
    fetchCodexUsage: vi.fn(async () => codexSnapshot()),
    now: () => clock,
    freshTtlMs: 10 * 60_000,
    failureBackoffMs: 90_000,
    ...overrides
  }
  const read = createProviderAccountUsageReader(deps)
  return { deps, read, advance: (ms: number) => (clock += ms) }
}

describe('projectProviderAccountSnapshot', () => {
  it('stamps the account identity and keeps windows, balances and plan display-only', () => {
    const projected = projectProviderAccountSnapshot(claudeWork, claudeSnapshot(), { now: START })
    expect(projected).toMatchObject({
      provider: 'claude',
      source: 'claude-oauth-usage',
      accountId: 'claude-work-abc123',
      accountLabel: 'Work',
      configured: true,
      stale: false,
      planType: 'max',
      fetchedAt: '2026-10-07T11:59:00.000Z'
    })
    expect(projected.windows).toEqual([
      {
        id: 'claude-work-abc123:claude-5h',
        label: 'Session',
        usedPercent: 23,
        remainingPercent: 77,
        limitLabel: '77% remaining',
        resetAt: '2026-10-07T16:00:00.000Z',
        limitWindowSeconds: 18_000
      }
    ])
    expect(projected.balances).toEqual([
      {
        id: 'claude-work-abc123:balance-0',
        label: 'Extra Usage',
        amount: 3.5,
        unit: 'USD',
        subtitle: '1.5 of 5 USD used'
      }
    ])
    expect(JSON.stringify(projected)).not.toContain('token')
  })
})

describe('createProviderAccountUsageReader', () => {
  it('reads every registered account through its own credential and endpoint', async () => {
    const { read, deps } = harness()
    const snapshots = await read()
    expect(snapshots.map((snapshot) => [snapshot.provider, snapshot.accountLabel])).toEqual([
      ['claude', 'Work'],
      ['codex', 'Second']
    ])
    expect(deps.readClaudeCredential).toHaveBeenCalledWith(claudeWork)
    expect(deps.readCodexCredential).toHaveBeenCalledWith(codexSecond)
    expect(snapshots[1]).toMatchObject({ source: 'chatgpt-wham', planType: 'pro' })
    expect(snapshots[1].balances[0]).toMatchObject({ label: 'Credits Remaining', unit: 'credits' })
  })

  it('serves a fresh reading from cache within the TTL and refetches after it', async () => {
    const { read, deps, advance } = harness()
    await read()
    advance(5 * 60_000)
    await read()
    expect(deps.fetchClaudeUsage).toHaveBeenCalledTimes(1)
    advance(6 * 60_000)
    await read()
    expect(deps.fetchClaudeUsage).toHaveBeenCalledTimes(2)
  })

  it('returns a configured:false tombstone with a sign-in hint when the folder holds no credential', async () => {
    const { read, deps } = harness({ readClaudeCredential: vi.fn(async () => null) })
    const [claude] = await read()
    expect(claude).toMatchObject({ configured: false, accountId: claudeWork.id, windows: [] })
    expect(claude.error).toMatch(/Sign in to the "Work" Claude account/)
    expect(deps.fetchClaudeUsage).not.toHaveBeenCalled()
  })

  it('keeps the last-known reading as stale through a failure and backs off before retrying', async () => {
    const fetchClaudeUsage = vi
      .fn<ProviderAccountUsageDeps['fetchClaudeUsage']>()
      .mockResolvedValueOnce(claudeSnapshot(23))
      .mockRejectedValueOnce(new Error('Claude OAuth usage endpoint returned HTTP 429.'))
      .mockResolvedValue(claudeSnapshot(31))
    const { read, advance } = harness({ fetchClaudeUsage })
    await read()
    advance(11 * 60_000)
    const [afterFailure] = await read()
    expect(afterFailure).toMatchObject({ stale: true, configured: true })
    expect(afterFailure.error).toContain('HTTP 429')
    expect(afterFailure.windows[0].usedPercent).toBe(23)
    advance(30_000)
    const [backingOff] = await read()
    expect(backingOff.stale).toBe(true)
    expect(fetchClaudeUsage).toHaveBeenCalledTimes(2)
    advance(90_000)
    const [recovered] = await read()
    expect(recovered.stale).toBe(false)
    expect(recovered.windows[0].usedPercent).toBe(31)
    expect(fetchClaudeUsage).toHaveBeenCalledTimes(3)
  })

  it('joins concurrent reads of one account into a single fetch', async () => {
    const { read, deps } = harness()
    await Promise.all([read(), read(), read()])
    expect(deps.fetchClaudeUsage).toHaveBeenCalledTimes(1)
    expect(deps.fetchCodexUsage).toHaveBeenCalledTimes(1)
  })

  it('forgets a removed account and reads nothing when none are registered', async () => {
    let accounts: ProviderCliAccount[] = [claudeWork]
    const { read, deps } = harness({ listAccounts: () => accounts })
    await read()
    accounts = []
    await expect(read()).resolves.toEqual([])
    accounts = [claudeWork]
    await read()
    // The cache for the removed account was dropped, so it fetches again.
    expect(deps.fetchClaudeUsage).toHaveBeenCalledTimes(2)
  })
})
