import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { runConcurrentReplayLanes } = require('./concurrentReplayLanes.cjs')
const { runT2PairedReplay } = require('./t2PairedRuns.cjs')
const { createReplayRevisionState } = require('./replayRevisionState.cjs')

function chat(appChatId = 'light') {
  return {
    appChatId,
    scope: 'global',
    updatedAt: 1,
    persistenceRevision: 1,
    messages: ['one', 'two'].map((content, index) => ({
      id: `${appChatId}-${index}`,
      role: 'assistant',
      content
    }))
  }
}
function schedule(appChatId = 'light') {
  return [
    { seq: 1, kind: 'seed_chat', appChatId },
    { seq: 2, kind: 'append_assistant', appChatId, messageId: `${appChatId}-0` },
    { seq: 3, kind: 'append_assistant', appChatId, messageId: `${appChatId}-1` }
  ]
}
function casApi(chats = [chat()]) {
  const records = new Map(chats.map((record) => [record.appChatId, structuredClone(record)]))
  return {
    records,
    getChat: vi.fn(async (id: string) => structuredClone(records.get(id) ?? null)),
    saveChat: vi.fn(async (record: ReturnType<typeof chat>) => {
      const previous = records.get(record.appChatId)
      if (!previous) throw new Error('unowned fixture identity')
      const accepted = previous.persistenceRevision === record.persistenceRevision
      const canonical = accepted
        ? { ...structuredClone(record), persistenceRevision: previous.persistenceRevision + 1 }
        : previous
      records.set(record.appChatId, canonical)
      return {
        accepted,
        appChatId: canonical.appChatId,
        persistenceRevision: canonical.persistenceRevision
      }
    })
  }
}
function options(api = casApi()) {
  return {
    api,
    seed: 42,
    lanes: [{ role: 'light', chatId: 'light', chats: [chat()], schedule: schedule() }],
    nowMs: () => Date.now()
  }
}
async function finish<T>(pending: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync()
  return pending
}

afterEach(() => vi.useRealTimers())

describe('owned replay revision continuity', () => {
  it('acknowledges a fresh fixture reset at the last accepted revision in every repetition', async () => {
    vi.useFakeTimers()
    const api = casApi()
    const result = await finish(runConcurrentReplayLanes(options(api)))
    expect(result.run.evidence.windows).toHaveLength(3)
    expect(result.run.failed).toBe(false)
    expect(api.saveChat.mock.calls.map(([record]) => record.persistenceRevision)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9
    ])
    expect(api.saveChat.mock.calls.map(([record]) => record.messages.length)).toEqual([
      2, 1, 2, 2, 1, 2, 2, 1, 2
    ])
    expect(api.records.get('light')).toMatchObject({
      persistenceRevision: 10,
      messages: chat().messages
    })
    expect(api.getChat).not.toHaveBeenCalled()
  })

  it('shares accepted light revisions between alone and beside without sharing them with heavy', async () => {
    vi.useFakeTimers()
    const fixture = {
      chats: [chat(), chat('heavy')],
      replaySchedule: [...schedule(), ...schedule('heavy')]
    }
    const api = casApi(fixture.chats)
    const result = await finish(
      runT2PairedReplay({ api, fixture, seed: 42, nowMs: () => Date.now() })
    )
    expect(result.alone.run.failed).toBe(false)
    expect(result.beside.run.failed).toBe(false)
    for (const [id, count] of [
      ['light', 18],
      ['heavy', 9]
    ] as const) {
      expect(
        api.saveChat.mock.calls
          .filter(([record]) => record.appChatId === id)
          .map(([record]) => record.persistenceRevision)
      ).toEqual(Array.from({ length: count }, (_, index) => index + 1))
    }
  })

  it.each([85, 167])(
    'does not learn a refused higher revision %s or continue after the refused seed',
    async (revision) => {
      vi.useFakeTimers()
      const api = casApi()
      api.records.get('light')!.persistenceRevision = revision
      const result = await finish(runConcurrentReplayLanes(options(api)))
      expect(api.saveChat).toHaveBeenCalledTimes(1)
      expect(result.lanes[0]).toMatchObject({ eventsApplied: 0, eventFailures: 1 })
      expect(result.run.evidence.windows).toHaveLength(1)
      expect(result.run.evidence.windows[0].lanes[0].failureDetails[0].reason).toBe(
        'replay_save_rejected'
      )
      expect(api.records.get('light')!.persistenceRevision).toBe(revision)
      expect(api.getChat).not.toHaveBeenCalled()
    }
  )

  it('keeps uncertain state invalid even when a failed save actually changed canonical', async () => {
    vi.useFakeTimers()
    const api = casApi()
    const save = api.saveChat.getMockImplementation()!
    api.saveChat.mockImplementationOnce(async (record) => {
      await save(record)
      throw new Error('reply lost after save')
    })
    const replayRevisionState = createReplayRevisionState(api)
    const first = await finish(runConcurrentReplayLanes({ ...options(api), replayRevisionState }))
    const second = await finish(runConcurrentReplayLanes({ ...options(api), replayRevisionState }))
    expect(first.run.failed).toBe(true)
    expect(second.run.failed).toBe(true)
    expect(api.saveChat).toHaveBeenCalledTimes(1)
    expect(api.records.get('light')!.persistenceRevision).toBe(2)
  })

  it('rejects a changed seed scope or content before using a retained canonical revision', async () => {
    vi.useFakeTimers()
    const api = casApi()
    const replayRevisionState = createReplayRevisionState(api)
    await finish(runConcurrentReplayLanes({ ...options(api), replayRevisionState }))
    const changed = options(api)
    changed.lanes[0].chats[0].messages[0].content = 'different seed'
    await expect(runConcurrentReplayLanes({ ...changed, replayRevisionState })).rejects.toThrow(
      'replay seed changed'
    )
    const scoped = options(api)
    scoped.lanes[0].chats[0].scope = 'workspace'
    await expect(runConcurrentReplayLanes({ ...scoped, replayRevisionState })).rejects.toThrow(
      'replay seed changed'
    )
    expect(api.saveChat).toHaveBeenCalledTimes(9)
  })

  it('uses an accepted late save only after the previous window has drained', async () => {
    vi.useFakeTimers()
    const api = casApi()
    const save = api.saveChat.getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    api.saveChat.mockImplementationOnce(async (record) => {
      const ack = await save(record)
      await gate
      return ack
    })
    const pending = runConcurrentReplayLanes({ ...options(api), windowMs: 5, repetitions: 2 })
    await vi.advanceTimersByTimeAsync(6)
    expect(api.saveChat).toHaveBeenCalledTimes(1)
    release()
    const result = await finish(pending)
    expect(result.run.evidence.windows).toHaveLength(2)
    expect(result.run.evidence.windows[0].lanes[0].lateEvents).toBe(1)
    expect(api.saveChat.mock.calls.map(([record]) => record.persistenceRevision)).toEqual([
      1, 2, 3, 4
    ])
    expect(result.run.failed).toBe(false)
  })

  it('does not revive a shared base from an ACK after unresolved completion was reported', async () => {
    vi.useFakeTimers()
    const api = casApi()
    const save = api.saveChat.getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    api.saveChat.mockImplementationOnce(async (record) => {
      const ack = await save(record)
      await gate
      return ack
    })
    const replayRevisionState = createReplayRevisionState(api)
    const first = await finish(
      runConcurrentReplayLanes({
        ...options(api),
        replayRevisionState,
        windowMs: 5,
        cleanupTimeoutMs: 5
      })
    )
    expect(first.run.incomplete).toBe(true)
    const evidence = JSON.stringify(first.run)
    release()
    await vi.advanceTimersByTimeAsync(0)
    const second = await finish(runConcurrentReplayLanes({ ...options(api), replayRevisionState }))
    expect(second.run.failed).toBe(true)
    expect(api.saveChat).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(first.run)).toBe(evidence)
  })

  it('does not begin a repetition after a rejected late seed', async () => {
    vi.useFakeTimers()
    const api = casApi()
    api.saveChat.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 6))
      return { accepted: false, appChatId: 'light', persistenceRevision: 85 }
    })
    const result = await finish(runConcurrentReplayLanes({ ...options(api), windowMs: 5 }))
    expect(result.run.evidence.windows).toHaveLength(1)
    expect(result.run.evidence.windows[0].lanes[0].lateEvents).toBe(1)
    expect(api.saveChat).toHaveBeenCalledTimes(1)
    expect(result.evidenceEligible).toBe(false)
  })

  it('leaves no-op schedule completion save-free', async () => {
    vi.useFakeTimers()
    const input = options()
    input.lanes[0].schedule = [{ seq: 1, kind: 'schedule_complete', appChatId: 'light' }]
    const result = await finish(runConcurrentReplayLanes(input))
    expect(result.run.failed).toBe(false)
    expect(input.api.saveChat).not.toHaveBeenCalled()
  })
})
