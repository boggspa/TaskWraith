import { describe, expect, it, vi } from 'vitest'
import {
  REMOTE_WELCOME_DASHBOARD_RANGE,
  buildRemoteWelcomeDashboard,
  createRemoteWelcomeDashboardThrottle,
  remoteWelcomeDashboardActivityRequest,
  type RemoteWelcomeDashboard
} from './WelcomeDashboardRemote'
import { buildWelcomeUsageDashboardData } from '../renderer/src/lib/welcomeUsageDashboard'
import {
  emptyMessageActivity,
  messageActivityFromChats,
  type MessageActivityAggregate
} from '../shared/messageActivityAggregate'
import type { ChatRecord, UsageRecord } from './store/types'

const NOW = new Date(2026, 4, 22, 12, 0).getTime()
const DAY = 86_400_000
const HOUR = 3_600_000
const ago = (ms: number): string => new Date(NOW - ms).toISOString()
const chat = (appChatId: string, timestamps: string[]): ChatRecord =>
  ({
    appChatId,
    title: appChatId,
    scope: 'workspace',
    provider: 'codex',
    workspaceId: 'ws-1',
    workspacePath: '/tmp/ws-1',
    createdAt: NOW - 100 * DAY,
    updatedAt: NOW,
    archived: false,
    messages: timestamps.map((timestamp, index) => ({
      id: `${appChatId}-${index}`,
      role: index % 2 ? 'assistant' : 'user',
      content: 'm',
      timestamp
    })),
    runs: []
  }) as unknown as ChatRecord
const record = (id: string, timestamp: number, chatId: string): UsageRecord =>
  ({
    id,
    provider: 'codex',
    timestamp,
    workspaceId: 'ws-1',
    chatId,
    runId: `${id}-run`,
    model: 'gpt-5-codex',
    inputTokens: 100,
    outputTokens: 200,
    totalTokens: 300,
    durationMs: 1000,
    usageKind: 'run'
  }) as UsageRecord

const CHATS = [
  chat('alpha', [ago(40 * DAY), ago(29 * DAY), ago(2 * HOUR), 'not a date']),
  chat('beta', [ago(6 * DAY), ago(25 * HOUR)]),
  chat('gamma', [ago(100 * DAY)]),
  chat('zeta', [ago(DAY), ago(0)])
]
const RECORDS = [
  record('r1', NOW - 3 * DAY, 'beta'),
  record('r2', NOW - 3 * DAY + HOUR, 'eta'),
  record('r3', NOW - 45 * DAY, 'theta'),
  record('r4', NOW - 30 * 60_000, 'zeta')
]
const WORKSPACES = [{ id: 'ws-1', displayName: 'Alpha' }]

describe('buildRemoteWelcomeDashboard', () => {
  it('projects the same figures from an aggregate as the full-record aggregator', () => {
    for (const statResetAt of [0, NOW - 50 * DAY, NOW - 26 * HOUR]) {
      const activity = messageActivityFromChats(
        CHATS,
        remoteWelcomeDashboardActivityRequest(NOW, statResetAt)
      )
      const remote = buildRemoteWelcomeDashboard(RECORDS, activity, WORKSPACES, NOW, statResetAt)
      const full = buildWelcomeUsageDashboardData(
        RECORDS,
        CHATS,
        REMOTE_WELCOME_DASHBOARD_RANGE,
        NOW,
        WORKSPACES,
        statResetAt
      )
      expect(remote, String(statResetAt)).toMatchObject({
        hasActivity: full.hasActivity,
        lifetimeHasActivity: full.lifetimeHasActivity,
        sessions: full.sessions,
        messages: full.messages,
        activeDays: full.activeDays,
        currentStreak: full.currentStreak,
        longestStreak: full.longestStreak,
        avgSessionMs: full.avgSessionMs,
        tokensPerSession: full.tokensPerSession,
        comparisonText: full.comparisonText,
        favoriteModel: full.favoriteModel,
        favoriteProject: full.favoriteProject
      })
    }
  })

  it('asks the provider for the 30-day window and the settings reset', () => {
    expect(remoteWelcomeDashboardActivityRequest(NOW, 4242)).toEqual({
      resetAt: 4242,
      rangeStart: NOW - 30 * DAY
    })
    expect(remoteWelcomeDashboardActivityRequest(NOW, 0)).toEqual({
      resetAt: 0,
      rangeStart: NOW - 30 * DAY
    })
  })
})

describe('createRemoteWelcomeDashboardThrottle', () => {
  const ACTIVITY: MessageActivityAggregate = messageActivityFromChats(
    CHATS,
    remoteWelcomeDashboardActivityRequest(NOW, 0)
  )
  const deferred = (): {
    promise: Promise<MessageActivityAggregate>
    resolve: (value: MessageActivityAggregate) => void
    reject: (error: Error) => void
  } => {
    let resolve!: (value: MessageActivityAggregate) => void
    let reject!: (error: Error) => void
    const promise = new Promise<MessageActivityAggregate>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }
  const depsWith = (
    getMessageActivity: (
      request: ReturnType<typeof remoteWelcomeDashboardActivityRequest>
    ) => Promise<MessageActivityAggregate>
  ) => ({ getMessageActivity, getWorkspaces: () => WORKSPACES, getStatResetAt: () => 0 })

  it('serves the cache while the record count is unchanged and fresh', async () => {
    const provider = vi.fn(async () => ACTIVITY)
    const throttle = createRemoteWelcomeDashboardThrottle()
    const first = await throttle.build(RECORDS, NOW, depsWith(provider))
    const second = await throttle.build(RECORDS, NOW + 60_000, depsWith(provider))
    expect(provider).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
    expect(first).toEqual(buildRemoteWelcomeDashboard(RECORDS, ACTIVITY, WORKSPACES, NOW, 0))
  })

  it('rebuilds when the record count changes or the cache goes stale', async () => {
    const provider = vi.fn(async () => ACTIVITY)
    const throttle = createRemoteWelcomeDashboardThrottle(5 * 60_000)
    await throttle.build(RECORDS, NOW, depsWith(provider))
    await throttle.build([...RECORDS, record('r5', NOW, 'omega')], NOW + 1000, depsWith(provider))
    expect(provider).toHaveBeenCalledTimes(2)
    await throttle.build(
      [...RECORDS, record('r5', NOW, 'omega')],
      NOW + 5 * 60_000 + 1000,
      depsWith(provider)
    )
    expect(provider).toHaveBeenCalledTimes(3)
  })

  it('joins callers onto an in-flight rebuild instead of stacking provider queries', async () => {
    const pending = deferred()
    const provider = vi.fn(() => pending.promise)
    const throttle = createRemoteWelcomeDashboardThrottle()
    const first = throttle.build(RECORDS, NOW, depsWith(provider))
    const second = throttle.build(RECORDS, NOW + 1000, depsWith(provider))
    expect(provider).toHaveBeenCalledTimes(1)
    pending.resolve(ACTIVITY)
    const [a, b] = await Promise.all([first, second])
    expect(b).toBe(a)
    // The settled build is cached: a third caller gets it without a query.
    expect(await throttle.build(RECORDS, NOW + 2000, depsWith(provider))).toBe(a)
    expect(provider).toHaveBeenCalledTimes(1)
  })

  it('never lets an older build overwrite a newer answer', async () => {
    const older = deferred()
    const newer = deferred()
    const answers = [older.promise, newer.promise]
    const provider = vi.fn(() => answers.shift() as Promise<MessageActivityAggregate>)
    const throttle = createRemoteWelcomeDashboardThrottle()
    const more = [...RECORDS, record('r5', NOW, 'omega')]
    const first = throttle.build(RECORDS, NOW, depsWith(provider))
    const second = throttle.build(more, NOW + 1000, depsWith(provider))
    newer.resolve(ACTIVITY)
    const newest = await second
    older.resolve(emptyMessageActivity())
    await first
    // The cache still holds the newer build: a fresh call for the newer
    // records returns it without another query.
    expect(await throttle.build(more, NOW + 2000, depsWith(provider))).toBe(newest)
    expect(provider).toHaveBeenCalledTimes(2)
  })

  it('propagates a provider failure and keeps the previous cache', async () => {
    const answers: Array<() => Promise<MessageActivityAggregate>> = [
      async () => ACTIVITY,
      async () => {
        throw new Error('catalogue unavailable')
      }
    ]
    const provider = vi.fn(() => (answers.shift() as () => Promise<MessageActivityAggregate>)())
    const throttle = createRemoteWelcomeDashboardThrottle()
    const cached: RemoteWelcomeDashboard = await throttle.build(RECORDS, NOW, depsWith(provider))
    const more = [...RECORDS, record('r5', NOW, 'omega')]
    await expect(throttle.build(more, NOW + 1000, depsWith(provider))).rejects.toThrow(
      'catalogue unavailable'
    )
    expect(await throttle.build(RECORDS, NOW + 2000, depsWith(provider))).toBe(cached)
    expect(provider).toHaveBeenCalledTimes(2)
  })
})
