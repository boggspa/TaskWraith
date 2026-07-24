import { describe, expect, it, vi } from 'vitest'

import type { WatchedPrDescriptor } from '../../shared/watchedPrNotify'
import type { WatchPollProgress } from '../../shared/watchPrPollCycle'
import type { GitCiStatusSummary, GitPrSummary, GitResult } from './GitService'
import {
  createWatchPrPoller,
  WATCH_PR_NOTIFY_CHANNEL,
  WATCH_PR_PROGRESS_CHANNEL,
  type WatchPrNotifyPayload,
  type WatchPrPoller
} from './WatchPrPoller'

const DESCRIPTOR: WatchedPrDescriptor = {
  chatId: 'chat-1',
  workspacePath: '/tmp/workspace',
  owner: 'boggspa',
  repo: 'TaskWraith',
  prNumber: 42
}

function makePr(overrides: Partial<GitPrSummary> = {}): GitPrSummary {
  return {
    number: 42,
    url: 'https://github.com/boggspa/TaskWraith/pull/42',
    state: 'OPEN',
    headRefOid: 'abc123',
    mergeStateStatus: 'CLEAN',
    ...overrides
  }
}

function makeSummary(
  overrides: {
    status?: GitCiStatusSummary['status']
    pr?: GitPrSummary
    warnings?: string[]
  } = {}
): GitCiStatusSummary {
  return {
    status: overrides.status ?? 'failed',
    binding: { pr: overrides.pr ?? makePr() },
    checks: [],
    runs: [],
    failedLogs: [],
    localVerification: { recommendedCommands: [], source: 'generic' },
    repairLoop: {
      repairAttempt: 0,
      maxRepairPushes: 3,
      shouldStop: false,
      requireLocalVerification: false,
      nextSuggestedAction: 'done'
    },
    warnings: overrides.warnings ?? []
  } as GitCiStatusSummary
}

/** ciStatus reports gh auth/availability problems as ok:true + 'blocked' + no pr + a warning. */
function blockedAuthSummary(warning: string): GitCiStatusSummary {
  return {
    ...makeSummary({ status: 'blocked' }),
    binding: {},
    warnings: [warning]
  } as GitCiStatusSummary
}

interface Harness {
  poller: WatchPrPoller
  sent: Array<{ channel: string; payload: unknown }>
  progress: WatchPollProgress[]
  fetchCiSummary: ReturnType<typeof vi.fn>
  watched: WatchedPrDescriptor[]
  /** Mutable ack behavior read by the send fake on every notify. */
  ack: { mode: 'ok' | 'fail' | 'silent'; error?: string }
}

function makeHarness(options: {
  summary?: GitCiStatusSummary
  result?: GitResult<GitCiStatusSummary>
  ackTimeoutMs?: number
  watched?: WatchedPrDescriptor[]
  headSummary?: GitCiStatusSummary
}): Harness {
  const sent: Array<{ channel: string; payload: unknown }> = []
  const progress: WatchPollProgress[] = []
  const watched = options.watched ?? [DESCRIPTOR]
  const stateSummary = options.summary ?? makeSummary()
  const headSummary = options.headSummary ?? stateSummary
  const fetchCiSummary = vi.fn(
    (_descriptor: WatchedPrDescriptor, fetchOptions: { maxRuns: number }) => {
      if (options.result) return Promise.resolve(options.result)
      return Promise.resolve({
        ok: true as const,
        data: fetchOptions.maxRuns === 1 ? headSummary : stateSummary
      })
    }
  )

  const harness: Harness = {
    poller: undefined as unknown as WatchPrPoller,
    sent,
    progress,
    fetchCiSummary,
    watched,
    ack: { mode: 'ok' }
  }

  harness.poller = createWatchPrPoller({
    listWatchedChats: () => harness.watched,
    fetchCiSummary,
    ackTimeoutMs: options.ackTimeoutMs ?? 1_000,
    send: (channel, payload) => {
      sent.push({ channel, payload })
      if (channel === WATCH_PR_PROGRESS_CHANNEL) progress.push(payload as WatchPollProgress)
      if (channel === WATCH_PR_NOTIFY_CHANNEL && harness.ack.mode !== 'silent') {
        const notify = payload as WatchPrNotifyPayload
        queueMicrotask(() =>
          harness.poller.resolveAck(
            notify.descriptor.chatId,
            notify.signature,
            harness.ack.mode === 'ok',
            harness.ack.error
          )
        )
      }
    }
  })
  return harness
}

function notifyPayloads(harness: Harness): WatchPrNotifyPayload[] {
  return harness.sent
    .filter((entry) => entry.channel === WATCH_PR_NOTIFY_CHANNEL)
    .map((entry) => entry.payload as WatchPrNotifyPayload)
}

function lastProgress(harness: Harness): WatchPollProgress | undefined {
  return harness.progress[harness.progress.length - 1]
}

describe('WatchPrPoller', () => {
  it('notifies on a fresh notify-worthy event, then dedupes the same signature', async () => {
    const harness = makeHarness({})
    await harness.poller.tick()

    const notified = notifyPayloads(harness)
    expect(notified).toHaveLength(1)
    expect(notified[0].descriptor).toEqual(DESCRIPTOR)
    expect(notified[0].signature).toBe('42@abc123:failed')
    expect(notified[0].pr?.number).toBe(42)
    expect(notified[0].ci?.status).toBe('failed')
    expect(harness.poller.lastSignatureFor(DESCRIPTOR.chatId)).toBe('42@abc123:failed')
    expect(lastProgress(harness)?.phase).toBe('notified')

    // Same polled state on the next tick ⇒ duplicate suppressed, no second notify.
    await harness.poller.tick()
    expect(notifyPayloads(harness)).toHaveLength(1)
    expect(lastProgress(harness)?.phase).toBe('skipped')
    expect(lastProgress(harness)?.decision?.reason).toBe('skip-duplicate')
  })

  it('re-notifies when a NEW head sha changes the signature', async () => {
    const harness = makeHarness({})
    await harness.poller.tick()
    expect(notifyPayloads(harness)).toHaveLength(1)

    harness.fetchCiSummary.mockImplementation(() =>
      Promise.resolve({
        ok: true as const,
        data: makeSummary({ pr: makePr({ headRefOid: 'def456' }) })
      })
    )
    await harness.poller.tick()
    const notified = notifyPayloads(harness)
    expect(notified).toHaveLength(2)
    expect(notified[1].signature).toBe('42@def456:failed')
  })

  it('polls only chats returned by listWatchedChats', async () => {
    const harness = makeHarness({ watched: [] })
    await harness.poller.tick()
    expect(harness.fetchCiSummary).not.toHaveBeenCalled()
    expect(harness.sent).toHaveLength(0)
  })

  it('surfaces gh auth failure as a specific unavailable progress, never a silent skip', async () => {
    const harness = makeHarness({})
    harness.fetchCiSummary.mockImplementation(() =>
      Promise.resolve({
        ok: true as const,
        data: blockedAuthSummary('GitHub CLI is not authenticated or is unavailable.')
      })
    )
    await harness.poller.tick()
    expect(notifyPayloads(harness)).toHaveLength(0)
    const terminal = lastProgress(harness)
    expect(terminal?.phase).toBe('unavailable')
    expect(terminal?.failure?.kind).toBe('gh-unauthenticated')
    expect(terminal?.failure?.message).toContain('gh auth login')
  })

  it('surfaces a missing gh binary as gh-not-installed', async () => {
    const harness = makeHarness({})
    harness.fetchCiSummary.mockImplementation(() =>
      Promise.resolve({
        ok: true as const,
        data: blockedAuthSummary('gh is not installed or not on PATH.')
      })
    )
    await harness.poller.tick()
    expect(lastProgress(harness)?.failure?.kind).toBe('gh-not-installed')
  })

  it('skips when the polled PR number differs from the opted-in PR', async () => {
    const harness = makeHarness({
      summary: makeSummary({ pr: makePr({ number: 99 }) })
    })
    await harness.poller.tick()
    expect(notifyPayloads(harness)).toHaveLength(0)
    expect(lastProgress(harness)?.phase).toBe('skipped')
    expect(lastProgress(harness)?.decision?.reason).toBe('skip-pr-changed')
  })

  it('skips when the live head moved under a stale poll (re-validation)', async () => {
    const harness = makeHarness({
      summary: makeSummary({ pr: makePr({ headRefOid: 'stale-sha' }) }),
      headSummary: makeSummary({ pr: makePr({ headRefOid: 'live-sha' }) })
    })
    await harness.poller.tick()
    expect(notifyPayloads(harness)).toHaveLength(0)
    expect(lastProgress(harness)?.decision?.reason).toBe('skip-stale-head')
  })

  it('does NOT advance the dedupe cursor when the renderer never acks (retry next tick)', async () => {
    const harness = makeHarness({ ackTimeoutMs: 5 })
    harness.ack.mode = 'silent'
    await harness.poller.tick()

    expect(notifyPayloads(harness)).toHaveLength(1)
    expect(harness.poller.lastSignatureFor(DESCRIPTOR.chatId)).toBeUndefined()
    const terminal = lastProgress(harness)
    expect(terminal?.phase).toBe('unavailable')
    expect(terminal?.failure?.kind).toBe('notify-error')

    // Next tick retries the same event (no destructive rollback, no lost event).
    await harness.poller.tick()
    expect(notifyPayloads(harness)).toHaveLength(2)
  })

  it('a failed notify ack preserves the PREVIOUS delivered signature', async () => {
    const harness = makeHarness({})
    await harness.poller.tick()
    expect(harness.poller.lastSignatureFor(DESCRIPTOR.chatId)).toBe('42@abc123:failed')

    // New head arrives, but the renderer reports the notify failed.
    harness.fetchCiSummary.mockImplementation(() =>
      Promise.resolve({
        ok: true as const,
        data: makeSummary({ pr: makePr({ headRefOid: 'def456' }) })
      })
    )
    harness.ack = { mode: 'fail', error: 'boom' }
    await harness.poller.tick()

    // Neither advanced to the new signature NOR rolled back to undefined.
    expect(harness.poller.lastSignatureFor(DESCRIPTOR.chatId)).toBe('42@abc123:failed')
    expect(lastProgress(harness)?.failure?.kind).toBe('notify-error')

    // A working ack next tick delivers the pending new-head event exactly once.
    harness.ack = { mode: 'ok' }
    await harness.poller.tick()
    expect(harness.poller.lastSignatureFor(DESCRIPTOR.chatId)).toBe('42@def456:failed')
    expect(notifyPayloads(harness)).toHaveLength(3)
  })

  it('forget(chatId) clears the dedupe cursor so a re-watch notifies again', async () => {
    const harness = makeHarness({})
    await harness.poller.tick()
    expect(notifyPayloads(harness)).toHaveLength(1)

    harness.poller.forget(DESCRIPTOR.chatId)
    await harness.poller.tick()
    expect(notifyPayloads(harness)).toHaveLength(2)
  })
})
