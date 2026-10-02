import { createRequire } from 'module'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

type Transition = { seq: number; roundId: string | null; status: string | null; atMs: number }
type LaneRead = {
  roundId: string | null
  status: string | null
  changedAtMs: number | null
  carrying: number
  otherSource: number
  nextSeq: number
  lost: boolean
  transitions: Transition[]
}
type ParsedRead =
  | { ok: true; installId: string; faults: number; lanes: { light: LaneRead; heavy: LaneRead } }
  | { ok: false; reason: string }
type Config = { lightChatId: string; heavyChatId: string; version: number }

const observer = require('./liveLaneObserver.cjs') as {
  LANE_OBSERVER_GLOBAL: string
  LANE_OBSERVER_MAX_TRANSITIONS: number
  installLaneObserverExpression: (config: Config) => string
  laneObserverConfig: (ids: { lightChatId?: unknown; heavyChatId?: unknown }) => Config
  parseLaneObserverRead: (
    text: unknown,
    config: Config,
    sinceSeq?: { light?: number; heavy?: number },
    expectedInstallId?: string
  ) => ParsedRead
  readLaneObserverExpression: (config: Config, sinceSeq?: unknown) => string
  roundEndIn: (
    transitions: Transition[],
    roundId: string
  ) => { status: string; atMs: number; seq: number } | null
  uninstallLaneObserverExpression: (config: Config) => string
}

const LIGHT = 'perf-light_beside_large_live-chat-01'
const HEAVY = 'perf-light_beside_large_live-chat-02'
const CONFIG = observer.laneObserverConfig({ lightChatId: LIGHT, heavyChatId: HEAVY })

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
    read: (sinceSeq?: { light?: number; heavy?: number }, expectedInstallId?: string) =>
      observer.parseLaneObserverRead(
        page.run(observer.readLaneObserverExpression(CONFIG, sinceSeq)),
        CONFIG,
        sinceSeq,
        expectedInstallId
      )
  }
  return page
}

function installed(api?: 'full' | 'none' | 'second_throws') {
  const page = fakePage(api)
  expect(page.run(observer.installLaneObserverExpression(CONFIG))).toBe('installed')
  return page
}

function readOk(page: ReturnType<typeof fakePage>, sinceSeq?: { light?: number; heavy?: number }) {
  const read = page.read(sinceSeq)
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

describe('the live-lane page observer', () => {
  it('follows the light chat’s round through every full delivery shape', () => {
    const page = installed()
    page.at(1_100).deliver(snapshot(LIGHT, round('r-1', 'running')))
    // A v2 patch that does not carry `ensemble` says nothing about the round.
    page.at(1_200).deliver(patchV2(LIGHT, { title: 'renamed' }))
    page.at(1_300).deliver(patchV2(LIGHT, { ensemble: round('r-1', 'completed') }))
    page.at(1_400).deliver(patchV1(LIGHT, { appChatId: LIGHT, ensemble: round('r-2', 'running') }))
    page.at(1_500).deliver(patchV2(LIGHT, {}, ['ensemble']))
    // A round without an id is no round: its status is not kept either.
    page.at(1_600).deliver(patchV2(LIGHT, { ensemble: { activeRound: { status: 'running' } } }))
    const { lanes } = readOk(page)
    expect(lanes.light.transitions).toEqual([
      { seq: 1, roundId: 'r-1', status: 'running', atMs: 1_100 },
      { seq: 2, roundId: 'r-1', status: 'completed', atMs: 1_300 },
      { seq: 3, roundId: 'r-2', status: 'running', atMs: 1_400 },
      { seq: 4, roundId: null, status: null, atMs: 1_500 }
    ])
    expect(lanes.light).toMatchObject({
      roundId: null,
      status: null,
      changedAtMs: 1_500,
      carrying: 5,
      otherSource: 0,
      nextSeq: 5,
      lost: false
    })
    expect(lanes.heavy.transitions).toEqual([])
  })

  it('follows the heavy chat’s round through its compact invalidations only', () => {
    const page = installed()
    page.at(2_000).invalidate(invalidation(HEAVY, { ensemble: round('h-1', 'running') }))
    // A summary without `ensemble` is silent, never a round end.
    page.at(2_100).invalidate(invalidation(HEAVY, {}))
    page.at(2_200).invalidate(invalidation(HEAVY, { ensemble: round('h-1', 'running') }))
    page.at(2_300).invalidate(invalidation(HEAVY, { ensemble: round('h-1', 'completed') }))
    const { lanes } = readOk(page)
    expect(lanes.heavy.transitions).toEqual([
      { seq: 1, roundId: 'h-1', status: 'running', atMs: 2_000 },
      { seq: 2, roundId: 'h-1', status: 'completed', atMs: 2_300 }
    ])
    // Two carrying deliveries repeated a state: counted, not a transition.
    expect(lanes.heavy).toMatchObject({ carrying: 3, nextSeq: 3, otherSource: 0 })
  })

  it('observes spectator light and focused heavy on either channel, and ignores other chats', () => {
    const page = installed()
    page.deliver(snapshot(HEAVY, round('h-1', 'running')))
    page.invalidate(invalidation(LIGHT, { ensemble: round('r-1', 'running') }))
    page.deliver(snapshot(HEAVY, round('h-1', 'completed')))
    page.invalidate(invalidation(LIGHT, { ensemble: round('r-1', 'completed') }))
    page.invalidate(invalidation(LIGHT, {}))
    page.deliver(patchV2(HEAVY, { title: 'silent' }))
    page.deliver(snapshot('another-chat', round('x-1', 'running')))
    page.invalidate(invalidation('another-chat', { ensemble: round('x-1', 'running') }))
    const { lanes } = readOk(page)
    expect(lanes.light).toMatchObject({
      otherSource: 3,
      carrying: 2,
      roundId: 'r-1',
      status: 'completed'
    })
    expect(lanes.heavy).toMatchObject({
      otherSource: 3,
      carrying: 2,
      roundId: 'h-1',
      status: 'completed'
    })
    expect(lanes.light.transitions.map((entry) => entry.status)).toEqual(['running', 'completed'])
    expect(lanes.heavy.transitions.map((entry) => entry.status)).toEqual(['running', 'completed'])
  })

  it('never throws into the app’s dispatch, and counts what it could not read', () => {
    const page = installed()
    const hostile = {
      chatId: LIGHT,
      get kind(): string {
        throw new Error('getter gone')
      }
    }
    expect(() => page.deliver(hostile)).not.toThrow()
    expect(() => page.deliver(null)).not.toThrow()
    expect(() => page.invalidate('not a payload')).not.toThrow()
    expect(readOk(page).faults).toBe(1)
  })

  it('keeps no delivery content, only ids, statuses and times', () => {
    const page = installed()
    page.deliver(snapshot(LIGHT, round('r-1', 'running')))
    page.invalidate(invalidation(HEAVY, { ensemble: round('h-1', 'running') }))
    const text = page.run(observer.readLaneObserverExpression(CONFIG)) as string
    expect(typeof text).toBe('string')
    expect(text).not.toContain('secret')
  })

  it('keeps the newest transitions, sends only those after the reader’s position, and says when it lost some', () => {
    const page = installed()
    const max = observer.LANE_OBSERVER_MAX_TRANSITIONS
    for (let index = 1; index <= max + 6; index += 1) {
      page.at(10_000 + index).deliver(snapshot(LIGHT, round(`r-${index}`, 'running')))
    }
    const all = readOk(page)
    expect(all.lanes.light.transitions).toHaveLength(max)
    expect(all.lanes.light.transitions[0].seq).toBe(7)
    expect(all.lanes.light).toMatchObject({ nextSeq: max + 7, lost: true })

    const caughtUp = readOk(page, { light: 60 })
    expect(caughtUp.lanes.light.transitions.map((transition) => transition.seq)).toEqual([
      61, 62, 63, 64, 65, 66, 67, 68, 69, 70
    ])
    expect(caughtUp.lanes.light.lost).toBe(false)
    expect(readOk(page, { light: 6 }).lanes.light.lost).toBe(false)
    expect(readOk(page, { light: 5 }).lanes.light.lost).toBe(true)
    expect(readOk(page, { light: max + 6 }).lanes.light).toMatchObject({
      transitions: [],
      lost: false
    })
  })

  it('installs once per page, and refuses another pair of chats or a page without the API', () => {
    const page = installed()
    expect(page.run(observer.installLaneObserverExpression(CONFIG))).toBe('already_installed')
    expect(page.listeners.delivery).toHaveLength(1)
    const other = observer.laneObserverConfig({ lightChatId: LIGHT, heavyChatId: 'another-chat' })
    expect(page.run(observer.installLaneObserverExpression(other))).toBe(
      'installed_for_other_chats'
    )
    expect(fakePage('none').run(observer.installLaneObserverExpression(CONFIG))).toBe(
      'api_unavailable'
    )
  })

  it('undoes a half-made install', () => {
    const page = fakePage('second_throws')
    expect(page.run(observer.installLaneObserverExpression(CONFIG))).toBe('install_failed')
    expect(page.listeners.delivery).toEqual([])
    expect(page.unsubscribed).toEqual(['delivery'])
    expect(page.window[observer.LANE_OBSERVER_GLOBAL]).toBeUndefined()
  })

  it('uninstalls its listeners, after which a read says it is not installed', () => {
    const page = installed()
    expect(page.run(observer.uninstallLaneObserverExpression(CONFIG))).toBe('uninstalled')
    expect(page.unsubscribed.sort()).toEqual(['delivery', 'invalidation'])
    expect(page.listeners).toEqual({ delivery: [], invalidation: [] })
    expect(page.read()).toEqual({ ok: false, reason: 'not_installed' })
    expect(page.run(observer.uninstallLaneObserverExpression(CONFIG))).toBe('not_installed')
  })

  it('refuses a read from a reinstalled observer, whose sequences started again', () => {
    const page = installed()
    const first = readOk(page)
    page.run(observer.uninstallLaneObserverExpression(CONFIG))
    page.at(5_000).run(observer.installLaneObserverExpression(CONFIG))
    expect(page.read(undefined, first.installId)).toEqual({ ok: false, reason: 'reinstalled' })
    expect(page.read(undefined, readOk(page).installId)).toMatchObject({ ok: true })
  })
})

describe('parseLaneObserverRead', () => {
  const valid = () => ({
    version: CONFIG.version,
    installId: 'install-1',
    faults: 0,
    lanes: {
      light: {
        chatId: LIGHT,
        roundId: 'r-2',
        status: 'running',
        changedAtMs: 1_300,
        carrying: 3,
        otherSource: 0,
        nextSeq: 4,
        firstRetainedSeq: 2,
        transitions: [
          [2, 'r-1', 'completed', 1_200],
          [3, 'r-2', 'running', 1_300]
        ]
      },
      heavy: {
        chatId: HEAVY,
        roundId: null,
        status: null,
        changedAtMs: null,
        carrying: 0,
        otherSource: 0,
        nextSeq: 1,
        firstRetainedSeq: 1,
        transitions: []
      }
    }
  })
  const parse = (value: unknown, sinceSeq?: { light?: number; heavy?: number }) =>
    observer.parseLaneObserverRead(JSON.stringify(value), CONFIG, sinceSeq)

  it('reads a well-formed state', () => {
    expect(parse(valid())).toEqual({
      ok: true,
      installId: 'install-1',
      faults: 0,
      lanes: {
        light: {
          roundId: 'r-2',
          status: 'running',
          changedAtMs: 1_300,
          carrying: 3,
          otherSource: 0,
          nextSeq: 4,
          lost: true,
          transitions: [
            { seq: 2, roundId: 'r-1', status: 'completed', atMs: 1_200 },
            { seq: 3, roundId: 'r-2', status: 'running', atMs: 1_300 }
          ]
        },
        heavy: {
          roundId: null,
          status: null,
          changedAtMs: null,
          carrying: 0,
          otherSource: 0,
          nextSeq: 1,
          lost: false,
          transitions: []
        }
      }
    })
  })

  it.each([
    ['a missing read', null, 'not_installed'],
    ['text that is not JSON', '{', 'read_invalid'],
    ['another version', { ...valid(), version: 2 }, 'read_invalid'],
    ['no install id', { ...valid(), installId: '' }, 'read_invalid'],
    ['a fractional fault count', { ...valid(), faults: 0.5 }, 'read_invalid']
  ])('refuses %s', (_label, value, reason) => {
    const text = value === null || typeof value === 'string' ? value : JSON.stringify(value)
    expect(observer.parseLaneObserverRead(text, CONFIG)).toEqual({ ok: false, reason })
  })

  const laneCases: Array<[string, (read: ReturnType<typeof valid>) => void, string]> = [
    ['another chat', (read) => void (read.lanes.light.chatId = 'another-chat'), 'chat_mismatch'],
    [
      'a numeric round id',
      (read) => void ((read.lanes.light as Record<string, unknown>).roundId = 7),
      'round_invalid'
    ],
    [
      'a numeric status',
      (read) => void ((read.lanes.light as Record<string, unknown>).status = 7),
      'status_invalid'
    ],
    [
      'a string change time',
      (read) => void ((read.lanes.light as Record<string, unknown>).changedAtMs = 'x'),
      'time_invalid'
    ],
    ['a negative count', (read) => void (read.lanes.light.carrying = -1), 'count_invalid'],
    ['a zero next sequence', (read) => void (read.lanes.light.nextSeq = 0), 'seq_invalid'],
    [
      'a first sequence past the next',
      (read) => void (read.lanes.light.firstRetainedSeq = 5),
      'seq_invalid'
    ],
    [
      'a skipped sequence',
      (read) => void (read.lanes.light.transitions[1][0] = 4),
      'transitions_invalid'
    ],
    [
      'a gap inside the retained range',
      (read) => {
        read.lanes.light.nextSeq = 5
        read.lanes.light.transitions[1][0] = 4
      },
      'transitions_invalid'
    ],
    [
      'a sequence at the next',
      (read) => void (read.lanes.light.nextSeq = 3),
      'transitions_invalid'
    ],
    [
      'a missing last transition',
      (read) => void read.lanes.light.transitions.pop(),
      'transitions_invalid'
    ],
    [
      'a short transition',
      (read) => void read.lanes.light.transitions[0].pop(),
      'transitions_invalid'
    ],
    [
      'a string time',
      (read) => void (read.lanes.light.transitions[0][3] = 'x'),
      'transitions_invalid'
    ],
    [
      'a numeric transition status',
      (read) => void (read.lanes.light.transitions[0][2] = 1),
      'transitions_invalid'
    ]
  ]
  it.each(laneCases)('refuses a lane with %s', (_label, corrupt, problem) => {
    const read = valid()
    corrupt(read)
    expect(parse(read)).toEqual({ ok: false, reason: `light_${problem}` })
  })

  it('refuses transitions at or before the reader’s position', () => {
    expect(parse(valid(), { light: 2 })).toEqual({ ok: false, reason: 'light_transitions_invalid' })
    const after = valid()
    after.lanes.light.transitions.shift()
    expect(parse(after, { light: 2 })).toMatchObject({ ok: true })
  })

  it('refuses a malformed reader position', () => {
    expect(() => parse(valid(), { light: -1 })).toThrow(/sinceSeq.light/)
    expect(() => parse(valid(), { heavy: 1.5 })).toThrow(/sinceSeq.heavy/)
  })
})

describe('roundEndIn', () => {
  const transitions: Transition[] = [
    { seq: 1, roundId: 'r-1', status: 'running', atMs: 10 },
    { seq: 2, roundId: 'r-2', status: 'running', atMs: 20 },
    { seq: 3, roundId: 'r-2', status: 'cancelled', atMs: 30 },
    { seq: 4, roundId: 'r-1', status: 'completed', atMs: 40 },
    { seq: 5, roundId: 'r-1', status: 'failed', atMs: 50 }
  ]

  it('finds the first terminal transition of that round only', () => {
    expect(observer.roundEndIn(transitions, 'r-1')).toEqual({
      status: 'completed',
      atMs: 40,
      seq: 4
    })
    expect(observer.roundEndIn(transitions, 'r-2')).toEqual({
      status: 'cancelled',
      atMs: 30,
      seq: 3
    })
    expect(observer.roundEndIn(transitions.slice(0, 2), 'r-1')).toBeNull()
    expect(observer.roundEndIn(transitions, 'r-3')).toBeNull()
  })
})

describe('laneObserverConfig', () => {
  it.each([
    ['no chats', {}],
    ['one chat twice', { lightChatId: LIGHT, heavyChatId: LIGHT }],
    ['an empty id', { lightChatId: '', heavyChatId: HEAVY }],
    ['a padded id', { lightChatId: ` ${LIGHT}`, heavyChatId: HEAVY }],
    ['a control byte', { lightChatId: `${LIGHT}\u0000`, heavyChatId: HEAVY }],
    ['an over-long id', { lightChatId: 'x'.repeat(513), heavyChatId: HEAVY }],
    ['a numeric id', { lightChatId: 7, heavyChatId: HEAVY }]
  ])('refuses %s', (_label, ids) => {
    expect(() => observer.laneObserverConfig(ids)).toThrow(/lane observer/)
  })

  it('carries each chat id into the page as data, never as code', () => {
    const quoted = observer.laneObserverConfig({
      lightChatId: "chat-');window.hacked=1;('",
      heavyChatId: HEAVY
    })
    const page = fakePage()
    expect(page.run(observer.installLaneObserverExpression(quoted))).toBe('installed')
    expect(page.window.hacked).toBeUndefined()
  })
})
