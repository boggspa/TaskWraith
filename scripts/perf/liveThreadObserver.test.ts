import { createRequire } from 'node:module'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

type Transition = {
  seq: number
  thread: number
  chatId: string
  roundId: string | null
  status: string | null
  atMs: number
}
type ThreadState = {
  chatId: string
  roundId: string | null
  status: string | null
  full: number
  compact: number
}
type ParsedRead =
  | {
      ok: true
      installId: string
      faults: number
      nextSeq: number
      lost: boolean
      transitions: Transition[]
      threads: ThreadState[]
    }
  | { ok: false; reason: string }
type Config = { chatIds: string[]; chatIdsKey: string; version: number; maxTransitions: number }

const observer = require('./liveThreadObserver.cjs') as {
  THREAD_OBSERVER_GLOBAL: string
  THREAD_OBSERVER_MAX_THREADS: number
  THREAD_OBSERVER_MAX_TRANSITIONS: number
  installThreadObserverExpression: (config: Config) => string
  parseThreadObserverRead: (
    text: unknown,
    config: Config,
    sinceSeq?: number,
    expectedInstallId?: string
  ) => ParsedRead
  readThreadObserverExpression: (config: Config, sinceSeq?: number) => string
  threadObserverConfig: (input: { chatIds?: unknown }) => Config
  uninstallThreadObserverExpression: (config: Config) => string
}

const CHATS = ['perf-many-chat-01', 'perf-many-chat-02', 'perf-many-chat-03']
const [A, B, C] = CHATS
const CONFIG = observer.threadObserverConfig({ chatIds: CHATS })

type Listener = (payload: unknown) => void

/**
 * A page with the preload's two subscription functions and nothing else: a
 * page function that reached for anything outside its own source would throw
 * a ReferenceError here.
 */
function fakePage(api: 'full' | 'none' | 'second_throws' = 'full') {
  const listeners = { delivery: [] as Listener[], invalidation: [] as Listener[] }
  const unsubscribed: string[] = []
  const subscribe = (channel: 'delivery' | 'invalidation') => (callback: Listener) => {
    listeners[channel].push(callback)
    return () => {
      unsubscribed.push(channel)
      listeners[channel] = listeners[channel].filter((listener) => listener !== callback)
    }
  }
  const window: Record<string, unknown> = {}
  if (api !== 'none') {
    window.api = {
      onChatUpdated: subscribe('delivery'),
      onChatUpdateInvalidated:
        api === 'second_throws'
          ? () => {
              throw new Error('preload gone')
            }
          : subscribe('invalidation')
    }
  }
  let clock = 1_000
  const context = vm.createContext({ window, Date: { now: () => clock } })
  const page = {
    window,
    listeners,
    unsubscribed,
    run: (expression: string): unknown => vm.runInContext(expression, context),
    deliver: (payload: unknown) => {
      for (const listener of [...listeners.delivery]) listener(payload)
    },
    invalidate: (payload: unknown) => {
      for (const listener of [...listeners.invalidation]) listener(payload)
    },
    at: (ms: number) => {
      clock = ms
      return page
    },
    read: (sinceSeq?: number, expectedInstallId?: string, config: Config = CONFIG) =>
      observer.parseThreadObserverRead(
        page.run(observer.readThreadObserverExpression(config, sinceSeq)),
        config,
        sinceSeq,
        expectedInstallId
      )
  }
  return page
}

function installed(config: Config = CONFIG) {
  const page = fakePage()
  expect(page.run(observer.installThreadObserverExpression(config))).toBe('installed')
  return page
}

function readOk(page: ReturnType<typeof fakePage>, sinceSeq?: number, config: Config = CONFIG) {
  const read = page.read(sinceSeq, undefined, config)
  if (!read.ok) throw new Error(`read refused: ${read.reason}`)
  return read
}

const round = (roundId: string, status: string) => ({ activeRound: { roundId, status } })
const snapshot = (chatId: string, ensemble: unknown) => ({
  protocolVersion: 2,
  kind: 'snapshot',
  deliveryId: 'delivery-1',
  chatId,
  revision: 1,
  chat: {
    appChatId: chatId,
    messages: [{ role: 'user', content: 'secret prompt text' }],
    ...(ensemble === undefined ? {} : { ensemble })
  }
})
const patchV2 = (
  chatId: string,
  recordDelta: Record<string, unknown>,
  recordCleared?: string[]
) => ({
  protocolVersion: 2,
  kind: 'patch',
  deliveryId: 'delivery-2',
  chatId,
  baseRevision: 1,
  revision: 2,
  recordMask: [...Object.keys(recordDelta), ...(recordCleared ?? [])],
  recordDelta,
  ...(recordCleared ? { recordCleared } : {})
})
const patchV1 = (chatId: string, record: Record<string, unknown>) => ({
  protocolVersion: 1,
  kind: 'patch',
  deliveryId: 'delivery-3',
  chatId,
  baseRevision: 2,
  revision: 3,
  record,
  messages: { start: 0, deleteCount: 0, items: [] }
})
const invalidation = (chatId: string, summary: Record<string, unknown>) => ({
  protocolVersion: 1,
  kind: 'invalidation',
  chatId,
  revision: 4,
  summary: { appChatId: chatId, summaryOnly: true, title: 'secret title', ...summary }
})

describe('the many-thread page observer', () => {
  it('follows every thread’s round through its compact updates, on one sequence', () => {
    const page = installed()
    page.at(2_000).invalidate(invalidation(A, { ensemble: round('a-1', 'running') }))
    page.at(2_100).invalidate(invalidation(C, { ensemble: round('c-1', 'running') }))
    // A summary without `ensemble` is silent, never a round end.
    page.at(2_150).invalidate(invalidation(A, {}))
    page.at(2_200).invalidate(invalidation(B, { ensemble: round('b-1', 'running') }))
    // A repeated state is counted, not a transition.
    page.at(2_250).invalidate(invalidation(C, { ensemble: round('c-1', 'running') }))
    page.at(2_300).invalidate(invalidation(A, { ensemble: round('a-1', 'completed') }))
    const read = readOk(page)
    expect(read.transitions).toEqual([
      { seq: 1, thread: 0, chatId: A, roundId: 'a-1', status: 'running', atMs: 2_000 },
      { seq: 2, thread: 2, chatId: C, roundId: 'c-1', status: 'running', atMs: 2_100 },
      { seq: 3, thread: 1, chatId: B, roundId: 'b-1', status: 'running', atMs: 2_200 },
      { seq: 4, thread: 0, chatId: A, roundId: 'a-1', status: 'completed', atMs: 2_300 }
    ])
    expect(read).toMatchObject({ nextSeq: 5, lost: false, faults: 0 })
    expect(read.threads).toEqual([
      { chatId: A, roundId: 'a-1', status: 'completed', full: 0, compact: 3 },
      { chatId: B, roundId: 'b-1', status: 'running', full: 0, compact: 1 },
      { chatId: C, roundId: 'c-1', status: 'running', full: 0, compact: 2 }
    ])
  })

  it('follows the open thread through every full delivery shape', () => {
    const page = installed()
    page.at(1_100).deliver(snapshot(B, round('r-1', 'running')))
    // A v2 patch that does not carry `ensemble` says nothing about the round.
    page.at(1_200).deliver(patchV2(B, { title: 'renamed' }))
    page.at(1_300).deliver(patchV2(B, { ensemble: round('r-1', 'completed') }))
    page.at(1_400).deliver(patchV1(B, { appChatId: B, ensemble: round('r-2', 'running') }))
    // A snapshot without a chat, or a delivery of another kind, says nothing
    // either: neither ends the round that is running.
    page.at(1_420).deliver({ kind: 'snapshot', chatId: B })
    page.at(1_440).deliver({ kind: 'ack', chatId: B, record: { ensemble: round('r-9', 'x') } })
    page.at(1_500).deliver(patchV2(B, {}, ['ensemble']))
    // A round without an id is no round: its status is not kept either.
    page.at(1_600).deliver(patchV2(B, { ensemble: { activeRound: { status: 'running' } } }))
    const read = readOk(page)
    expect(
      read.transitions.map(({ seq, roundId, status, atMs }) => [seq, roundId, status, atMs])
    ).toEqual([
      [1, 'r-1', 'running', 1_100],
      [2, 'r-1', 'completed', 1_300],
      [3, 'r-2', 'running', 1_400],
      [4, null, null, 1_500]
    ])
    expect(read.transitions.every((transition) => transition.chatId === B)).toBe(true)
    expect(read.threads[1]).toEqual({ chatId: B, roundId: null, status: null, full: 8, compact: 0 })
  })

  it('takes any thread on either channel, and ignores chats it was not given', () => {
    const page = installed()
    page.deliver(snapshot(A, round('a-1', 'running')))
    page.invalidate(invalidation(A, { ensemble: round('a-1', 'completed') }))
    page.invalidate(invalidation(B, { ensemble: round('b-1', 'running') }))
    page.deliver(snapshot('another-chat', round('x-1', 'running')))
    page.invalidate(invalidation('another-chat', { ensemble: round('x-1', 'running') }))
    // An id that names something every object has is still not a thread.
    page.invalidate(invalidation('constructor', { ensemble: round('x-2', 'running') }))
    page.invalidate(invalidation('__proto__', { ensemble: round('x-3', 'running') }))
    const read = readOk(page)
    expect(read.transitions.map((transition) => [transition.chatId, transition.status])).toEqual([
      [A, 'running'],
      [A, 'completed'],
      [B, 'running']
    ])
    expect(read.threads.map((thread) => [thread.full, thread.compact])).toEqual([
      [1, 1],
      [0, 1],
      [0, 0]
    ])
    expect(read.faults).toBe(0)
  })

  it('never throws into the app’s dispatch, and counts what it could not read', () => {
    const page = installed()
    const hostile = {
      chatId: A,
      get kind(): string {
        throw new Error('getter gone')
      }
    }
    expect(() => page.deliver(hostile)).not.toThrow()
    expect(() => page.deliver(null)).not.toThrow()
    expect(() => page.invalidate('not a payload')).not.toThrow()
    expect(() => page.invalidate({ chatId: 7 })).not.toThrow()
    expect(readOk(page).faults).toBe(1)
  })

  it('keeps no delivery content, only ids, statuses, times and counts', () => {
    const page = installed()
    page.deliver(snapshot(A, round('a-1', 'running')))
    page.invalidate(invalidation(B, { ensemble: round('b-1', 'running') }))
    const text = page.run(observer.readThreadObserverExpression(CONFIG)) as string
    expect(typeof text).toBe('string')
    expect(text).not.toContain('secret')
    // Nor the chat ids: the reader knows the threads by their place, and a
    // read does not send them to the page either.
    expect(text).not.toContain('perf-many-chat')
    expect(observer.readThreadObserverExpression(CONFIG)).not.toContain('perf-many-chat')
  })

  it('sends only what the reader has not seen, so a round between two reads is not missed', () => {
    const page = installed()
    page.at(3_000).invalidate(invalidation(A, { ensemble: round('a-1', 'running') }))
    const first = readOk(page)
    expect(first.transitions.map((transition) => transition.seq)).toEqual([1])
    // A whole round on another thread starts and ends before the next read.
    page.at(3_100).invalidate(invalidation(B, { ensemble: round('b-1', 'running') }))
    page.at(3_200).invalidate(invalidation(B, { ensemble: round('b-1', 'completed') }))
    const second = readOk(page, first.nextSeq - 1)
    expect(second.transitions).toEqual([
      { seq: 2, thread: 1, chatId: B, roundId: 'b-1', status: 'running', atMs: 3_100 },
      { seq: 3, thread: 1, chatId: B, roundId: 'b-1', status: 'completed', atMs: 3_200 }
    ])
    expect(readOk(page, second.nextSeq - 1)).toMatchObject({ transitions: [], lost: false })
  })

  it('keeps the newest transitions and tells a reader that fell behind', () => {
    const small = { ...CONFIG, maxTransitions: 8 }
    const page = installed(small)
    for (let index = 1; index <= 14; index += 1) {
      page
        .at(10_000 + index)
        .invalidate(invalidation(CHATS[index % 3], { ensemble: round(`r-${index}`, 'running') }))
    }
    const all = readOk(page, 0, small)
    expect(all.transitions.map((transition) => transition.seq)).toEqual([
      7, 8, 9, 10, 11, 12, 13, 14
    ])
    expect(all).toMatchObject({ nextSeq: 15, lost: true })
    expect(readOk(page, 6, small).lost).toBe(false)
    expect(readOk(page, 5, small).lost).toBe(true)
    expect(readOk(page, 10, small).transitions.map((transition) => transition.seq)).toEqual([
      11, 12, 13, 14
    ])
    expect(readOk(page, 14, small)).toMatchObject({ transitions: [], lost: false })
    expect(observer.THREAD_OBSERVER_MAX_TRANSITIONS).toBe(4096)
    expect(CONFIG.maxTransitions).toBe(4096)
  })

  it('installs once per page, and refuses other threads or a page without the API', () => {
    const page = installed()
    expect(page.run(observer.installThreadObserverExpression(CONFIG))).toBe('already_installed')
    expect(page.listeners.delivery).toHaveLength(1)
    for (const chatIds of [
      [A, B],
      [A, B, 'another-chat'],
      [B, A, C]
    ]) {
      const other = observer.threadObserverConfig({ chatIds })
      expect(page.run(observer.installThreadObserverExpression(other))).toBe(
        'installed_for_other_chats'
      )
      // A reader of other threads is told so, not handed these threads' rounds.
      expect(page.read(0, undefined, other)).toEqual({ ok: false, reason: 'chat_mismatch' })
    }
    // Nor is an observer of another version this one.
    expect(page.run(observer.installThreadObserverExpression({ ...CONFIG, version: 2 }))).toBe(
      'installed_for_other_chats'
    )
    expect(fakePage('none').run(observer.installThreadObserverExpression(CONFIG))).toBe(
      'api_unavailable'
    )
  })

  it('undoes a half-made install', () => {
    const page = fakePage('second_throws')
    expect(page.run(observer.installThreadObserverExpression(CONFIG))).toBe('install_failed')
    expect(page.listeners.delivery).toEqual([])
    expect(page.unsubscribed).toEqual(['delivery'])
    expect(page.window[observer.THREAD_OBSERVER_GLOBAL]).toBeUndefined()
  })

  it('uninstalls its listeners, after which a read says it is not installed', () => {
    const page = installed()
    expect(page.run(observer.uninstallThreadObserverExpression(CONFIG))).toBe('uninstalled')
    expect(page.unsubscribed.sort()).toEqual(['delivery', 'invalidation'])
    expect(page.listeners).toEqual({ delivery: [], invalidation: [] })
    expect(page.read()).toEqual({ ok: false, reason: 'not_installed' })
    expect(page.run(observer.uninstallThreadObserverExpression(CONFIG))).toBe('not_installed')
  })

  it('refuses a read from a reinstalled observer, whose sequence started again', () => {
    const page = installed()
    const first = readOk(page)
    page.run(observer.uninstallThreadObserverExpression(CONFIG))
    page.at(5_000).run(observer.installThreadObserverExpression(CONFIG))
    expect(page.read(0, first.installId)).toEqual({ ok: false, reason: 'reinstalled' })
    expect(page.read(0, readOk(page).installId)).toMatchObject({ ok: true })
  })
})

describe('threadObserverConfig', () => {
  it('names the threads in order under a key of its own', () => {
    expect(CONFIG).toMatchObject({
      globalName: observer.THREAD_OBSERVER_GLOBAL,
      version: 1,
      chatIds: CHATS
    })
    expect(Object.isFrozen(CONFIG)).toBe(true)
    expect(CONFIG.chatIdsKey).toMatch(/^[0-9a-f]{16}$/)
    // The key tells one list of threads from another, order included.
    const keys = [
      [A, B, C],
      [A, B],
      [B, A, C],
      [A, B, 'another-chat']
    ].map((chatIds) => observer.threadObserverConfig({ chatIds }).chatIdsKey)
    expect(new Set(keys).size).toBe(4)
    expect(observer.threadObserverConfig({ chatIds: [A] }).chatIds).toEqual([A])
  })

  it('refuses a list it could not observe', () => {
    const refused = (chatIds: unknown) => () => observer.threadObserverConfig({ chatIds })
    const many = Array.from(
      { length: observer.THREAD_OBSERVER_MAX_THREADS + 1 },
      (_, i) => `c-${i}`
    )
    expect(observer.THREAD_OBSERVER_MAX_THREADS).toBe(256)
    for (const chatIds of [undefined, 'chat', [], many]) {
      expect(refused(chatIds)).toThrow('the thread observer needs 1 to 256 chat ids')
    }
    expect(observer.threadObserverConfig({ chatIds: many.slice(1) }).chatIds).toHaveLength(256)
    for (const id of ['', ' padded ', 7, null, 'x'.repeat(513), 'bell\u0007']) {
      expect(refused([A, id])).toThrow('the thread observer was given an invalid chat id')
    }
    expect(refused([A, B, A])).toThrow('the thread observer was given a chat id twice')
  })

  it('refuses a position that is not a sequence number', () => {
    for (const since of [-1, 1.5, '3', null]) {
      expect(() => observer.readThreadObserverExpression(CONFIG, since as never)).toThrow(
        'sinceSeq is invalid'
      )
      expect(() => observer.parseThreadObserverRead('{}', CONFIG, since as never)).toThrow(
        'sinceSeq is invalid'
      )
    }
  })
})

describe('parseThreadObserverRead', () => {
  const valid = () => ({
    version: CONFIG.version,
    installId: 'install-1',
    faults: 0,
    threadCount: 3,
    nextSeq: 4,
    firstRetainedSeq: 1,
    transitions: [
      [1, 0, 'a-1', 'running', 100],
      [2, 2, 'c-1', 'running', 110],
      [3, 0, 'a-1', 'completed', 120]
    ],
    threads: [
      ['a-1', 'completed', 0, 2],
      [null, null, 0, 0],
      ['c-1', 'running', 1, 1]
    ]
  })
  const parse = (value: unknown, sinceSeq?: number, expectedInstallId?: string) =>
    observer.parseThreadObserverRead(
      typeof value === 'string' ? value : JSON.stringify(value),
      CONFIG,
      sinceSeq,
      expectedInstallId
    )
  const refusal = (mutate: (read: ReturnType<typeof valid>) => unknown, sinceSeq?: number) => {
    const read = valid()
    const replaced = mutate(read)
    return parse(replaced === undefined ? read : replaced, sinceSeq)
  }

  it('accepts a well-formed read and names each transition’s thread', () => {
    expect(parse(valid())).toEqual({
      ok: true,
      installId: 'install-1',
      faults: 0,
      nextSeq: 4,
      lost: false,
      transitions: [
        { seq: 1, thread: 0, chatId: A, roundId: 'a-1', status: 'running', atMs: 100 },
        { seq: 2, thread: 2, chatId: C, roundId: 'c-1', status: 'running', atMs: 110 },
        { seq: 3, thread: 0, chatId: A, roundId: 'a-1', status: 'completed', atMs: 120 }
      ],
      threads: [
        { chatId: A, roundId: 'a-1', status: 'completed', full: 0, compact: 2 },
        { chatId: B, roundId: null, status: null, full: 0, compact: 0 },
        { chatId: C, roundId: 'c-1', status: 'running', full: 1, compact: 1 }
      ]
    })
    // A reader at position 2 is sent only the third.
    const later = { ...valid(), transitions: [[3, 0, 'a-1', 'completed', 120]] }
    expect(parse(later, 2)).toMatchObject({ ok: true, lost: false })
  })

  it('tells a missing observer, another install and other threads apart', () => {
    expect(observer.parseThreadObserverRead(null, CONFIG)).toEqual({
      ok: false,
      reason: 'not_installed'
    })
    expect(observer.parseThreadObserverRead(undefined, CONFIG)).toEqual({
      ok: false,
      reason: 'not_installed'
    })
    expect(parse(valid(), 0, 'install-2')).toEqual({ ok: false, reason: 'reinstalled' })
    expect(parse(valid(), 0, 'install-1')).toMatchObject({ ok: true })
    expect(parse({ version: CONFIG.version, mismatch: true })).toEqual({
      ok: false,
      reason: 'chat_mismatch'
    })
  })

  it.each<[string, (read: ReturnType<typeof valid>) => unknown]>([
    ['text that is not JSON', () => '{'],
    ['a value that is not an object', () => [1]],
    ['nothing', () => 'null'],
    ['an install id that is not text', (read) => void ((read as any).installId = 7)],
    ['an install id left out', (read) => void delete (read as any).installId],
    ['another version', (read) => void (read.version = 2)],
    ['no install id', (read) => void ((read as any).installId = '')],
    ['a fault count that is not a count', (read) => void ((read as any).faults = -1)]
  ])('refuses %s as an invalid read', (_name, mutate) => {
    expect(refusal(mutate)).toEqual({ ok: false, reason: 'read_invalid' })
  })

  it('refuses a read for another number of threads', () => {
    expect(refusal((read) => void (read.threadCount = 2))).toEqual({
      ok: false,
      reason: 'thread_count_mismatch'
    })
  })

  it.each<[string, (read: ReturnType<typeof valid>) => unknown]>([
    ['a next sequence below one', (read) => void (read.nextSeq = 0)],
    ['a next sequence that is not whole', (read) => void (read.nextSeq = 4.5)],
    ['a first retained sequence below one', (read) => void (read.firstRetainedSeq = 0)],
    ['a first retained sequence past the next', (read) => void (read.firstRetainedSeq = 5)]
  ])('refuses %s', (_name, mutate) => {
    expect(refusal(mutate)).toEqual({ ok: false, reason: 'seq_invalid' })
  })

  it.each<[string, (read: ReturnType<typeof valid>) => unknown, number?]>([
    ['transitions that are not a list', (read) => void ((read as any).transitions = {})],
    ['a transition that is not a row of five', (read) => void read.transitions[1].pop()],
    ['a transition with a sixth field', (read) => void read.transitions[1].push(0)],
    ['a gap in the sequence', (read) => void (read.transitions[1][0] = 5)],
    ['a sequence the reader already has', () => undefined, 1],
    ['a sequence at or past the next', (read) => void (read.nextSeq = 3)],
    ['a list that stops short of the next', (read) => void read.transitions.pop()],
    ['a thread that is not one of them', (read) => void (read.transitions[0][1] = 3)],
    ['a thread that is not a place', (read) => void (read.transitions[0][1] = -1)],
    ['a thread that is not whole', (read) => void (read.transitions[0][1] = 0.5)],
    ['a round id that is not text', (read) => void ((read as any).transitions[0][2] = 7)],
    ['a status that is not text', (read) => void ((read as any).transitions[0][3] = 7)],
    ['a time that is not a number', (read) => void ((read as any).transitions[0][4] = 'now')]
  ])('refuses %s', (_name, mutate, sinceSeq) => {
    expect(refusal(mutate, sinceSeq)).toEqual({ ok: false, reason: 'transitions_invalid' })
  })

  it.each<[string, (read: ReturnType<typeof valid>) => unknown]>([
    ['threads that are not a list', (read) => void ((read as any).threads = {})],
    ['threads left out', (read) => void delete (read as any).threads],
    ['a thread with a fifth field', (read) => void read.threads[0].push(0)],
    ['a thread too few', (read) => void read.threads.pop()],
    ['a thread that is not a row of four', (read) => void read.threads[0].pop()],
    ['a round id that is not text', (read) => void ((read as any).threads[0][0] = 7)],
    ['a status that is not text', (read) => void ((read as any).threads[0][1] = 7)],
    ['a full count that is not a count', (read) => void ((read as any).threads[0][2] = -1)],
    ['a compact count that is not a count', (read) => void ((read as any).threads[0][3] = 1.5)]
  ])('refuses %s', (_name, mutate) => {
    expect(refusal(mutate)).toEqual({ ok: false, reason: 'threads_invalid' })
  })

  it('says the reader lost transitions only when some after its position were dropped', () => {
    const dropped = {
      ...valid(),
      nextSeq: 10,
      firstRetainedSeq: 8,
      transitions: [
        [8, 0, 'a-4', 'running', 100],
        [9, 0, 'a-4', 'completed', 110]
      ]
    }
    expect(parse(dropped, 0)).toMatchObject({ ok: true, lost: true })
    expect(parse(dropped, 6)).toMatchObject({ ok: true, lost: true })
    expect(parse(dropped, 7)).toMatchObject({ ok: true, lost: false })
    // Nothing was dropped after a position at the end.
    expect(parse({ ...dropped, transitions: [] }, 9)).toMatchObject({ ok: true, lost: false })
    // An observer that has seen nothing has dropped nothing.
    expect(parse({ ...valid(), nextSeq: 1, firstRetainedSeq: 1, transitions: [] })).toMatchObject({
      ok: true,
      lost: false,
      transitions: []
    })
  })
})
