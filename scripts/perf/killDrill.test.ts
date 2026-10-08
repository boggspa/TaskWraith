import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const drill = require('./killDrill.cjs') as Record<string, any>
const { manyAgentPrompt } = require('./manyAgentRounds.cjs') as {
  manyAgentPrompt: (place: number, index: number) => string
}
const { liveRoundPrompt } = require('./liveRounds.cjs') as {
  liveRoundPrompt: (purpose: string) => string
}

const repoRoot = path.resolve(__dirname, '..', '..')
/** Every directory this file makes is named so, directly in the temporary folder. */
const PREFIX = 'harness-kill-drill-'
const made: string[] = []

function makeDirectory(): string {
  const dir = mkdtempSync(path.join(tmpdir(), PREFIX))
  made.push(dir)
  return dir
}

afterEach(() => {
  while (made.length > 0) {
    const dir = made.pop()!
    if (dir === tmpdir() || !dir.startsWith(tmpdir() + path.sep + PREFIX)) {
      throw new Error(`refusing to remove ${dir}: not a directory this file made`)
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

type Round = {
  roundId: string
  sentAtMs: number
  acceptedAtMs: number
  pageMs: number | null
  endedAtMs: number | null
  status: string | null
}
type Thread = { chatId: string; rounds: Round[]; failure: string | null }
type Snapshot = {
  observer: { installId: string | null; faults: number; failure: string | null }
  sending: boolean
  threads: Array<Thread & { deliveries: { full: number; compact: number } }>
}

const CHATS = ['chat-01', 'chat-02']
const THREADS = CHATS.map((chatId, place) => ({ chatId, model: `scripted-llama:t00${place + 1}` }))

/** A round the observer saw end, or one still running. */
const ended = (roundId: string, at = 1): Round => ({
  roundId,
  sentAtMs: at,
  acceptedAtMs: at + 1,
  pageMs: 1,
  endedAtMs: at + 10,
  status: 'completed'
})
const running = (roundId: string, at = 1): Round => ({
  roundId,
  sentAtMs: at,
  acceptedAtMs: at + 1,
  pageMs: 1,
  endedAtMs: null,
  status: null
})

function snapshot(threads: Thread[]): Snapshot {
  return {
    observer: { installId: 'install-1', faults: 0, failure: null },
    sending: true,
    threads: threads.map((thread) => ({ ...thread, deliveries: { full: 0, compact: 0 } }))
  }
}

/** Two threads, each with two rounds seen to end and a third running. */
const READY = snapshot([
  { chatId: CHATS[0], rounds: [ended('a1'), ended('a2'), running('a3')], failure: null },
  { chatId: CHATS[1], rounds: [ended('b1'), ended('b2'), running('b3')], failure: null }
])

/**
 * Lanes that show the snapshots given, one a poll and the last for good;
 * `stop` shows the cut. Records what was asked of them, in order.
 */
function fakeLanes(snapshots: Snapshot[], cut: Snapshot = snapshots[snapshots.length - 1]) {
  const events: string[] = []
  let polls = 0
  const createLanes = (options: { chatIds: string[]; roundTimeoutMs?: number }) => {
    events.push(`create ${options.chatIds.join(',')} ${options.roundTimeoutMs ?? ''}`.trim())
    return {
      install: async () => void events.push('install'),
      start: () => void events.push('start'),
      snapshot: () => snapshots[Math.min(polls++, snapshots.length - 1)],
      stop: async () => {
        events.push('stop')
        return cut
      }
    }
  }
  return { events, createLanes }
}

/** A clock that a sleep moves on, so bounds are reached without waiting. */
function fakeClock() {
  let now = 1_000
  return { nowMs: () => now, sleep: async (ms: number) => void (now += ms) }
}

describe('when the drill may kill', () => {
  it('waits until every thread has seen two rounds end and one is still running', () => {
    expect(drill.killReadiness(READY, 2)).toEqual({
      ready: true,
      endedByThread: [2, 2],
      threadsWithARoundRunning: 2,
      failures: []
    })
    const early = snapshot([
      { chatId: CHATS[0], rounds: [ended('a1'), ended('a2'), running('a3')], failure: null },
      { chatId: CHATS[1], rounds: [ended('b1'), running('b2')], failure: null }
    ])
    expect(drill.killReadiness(early, 2).ready).toBe(false)
    const idle = snapshot([
      { chatId: CHATS[0], rounds: [ended('a1'), ended('a2')], failure: null },
      { chatId: CHATS[1], rounds: [ended('b1'), ended('b2')], failure: null }
    ])
    expect(drill.killReadiness(idle, 2)).toMatchObject({
      ready: false,
      threadsWithARoundRunning: 0
    })
    const failed = snapshot([
      { chatId: CHATS[0], rounds: [ended('a1'), ended('a2'), running('a3')], failure: null },
      {
        chatId: CHATS[1],
        rounds: [ended('b1'), ended('b2'), running('b3')],
        failure: 'not_started'
      }
    ])
    expect(drill.killReadiness(failed, 2)).toMatchObject({
      ready: false,
      failures: [{ place: 1, failure: 'not_started' }]
    })
    expect(drill.killReadiness({ threads: [] }, 2).ready).toBe(false)
  })
})

describe('the record of what the first launch sent', () => {
  it('holds each send by thread, acknowledged or not, with the prompt it was sent with', () => {
    const cut = snapshot([
      { chatId: CHATS[0], rounds: [ended('a1'), running('a2')], failure: 'send_failed' },
      { chatId: CHATS[1], rounds: [ended('b1')], failure: 'steered' }
    ])
    const priorRounds = [
      {
        purpose: 'warm_up',
        chatId: CHATS[0],
        status: 'started',
        roundId: 'w1',
        outcome: 'settled',
        roundStatus: 'completed'
      },
      {
        purpose: 'smoke',
        chatId: CHATS[0],
        status: 'blocked',
        roundId: null,
        outcome: 'not_started',
        roundStatus: null
      },
      { purpose: 'smoke', chatId: 'another-chat', status: 'started', roundId: 'x' },
      // Acknowledged, but never seen to settle.
      {
        purpose: 'smoke',
        chatId: CHATS[1],
        status: 'started',
        roundId: 's1',
        outcome: 'timeout',
        roundStatus: 'running'
      },
      // Started with no round named is no acknowledgement the drill can find again.
      { purpose: 'smoke', chatId: CHATS[1], status: 'started', roundId: null, outcome: 'timeout' }
    ]
    const [first, second] = drill.drillRecordOf({ threads: THREADS, snapshot: cut, priorRounds })
    expect(first).toMatchObject({ place: 0, chatId: CHATS[0] })
    expect(first.sends).toEqual([
      {
        source: 'warm_up',
        prompt: liveRoundPrompt('warm_up'),
        acknowledged: true,
        roundId: 'w1',
        seenToEnd: true,
        endStatus: 'completed'
      },
      {
        source: 'smoke',
        prompt: liveRoundPrompt('smoke'),
        acknowledged: false,
        roundId: null,
        seenToEnd: false,
        endStatus: null,
        unanswered: 'not_started'
      },
      {
        source: 'lane',
        index: 1,
        prompt: manyAgentPrompt(0, 1),
        acknowledged: true,
        roundId: 'a1',
        seenToEnd: true,
        endStatus: 'completed',
        acceptedAtMs: 2,
        endedAtMs: 11
      },
      {
        source: 'lane',
        index: 2,
        prompt: manyAgentPrompt(0, 2),
        acknowledged: true,
        roundId: 'a2',
        seenToEnd: false,
        endStatus: null,
        acceptedAtMs: 2,
        endedAtMs: null
      },
      {
        source: 'lane',
        index: 3,
        prompt: manyAgentPrompt(0, 3),
        acknowledged: false,
        roundId: null,
        seenToEnd: false,
        endStatus: null,
        unanswered: 'send_failed'
      }
    ])
    expect(second.sends[0]).toEqual({
      source: 'smoke',
      prompt: liveRoundPrompt('smoke'),
      acknowledged: true,
      roundId: 's1',
      seenToEnd: false,
      endStatus: 'running'
    })
    expect(second.sends[1]).toMatchObject({
      source: 'smoke',
      acknowledged: false,
      unanswered: 'timeout'
    })
    // A steered send was acknowledged, though it started no round.
    expect(second.sends.map((send: Record<string, unknown>) => send.prompt)).toEqual([
      liveRoundPrompt('smoke'),
      liveRoundPrompt('smoke'),
      manyAgentPrompt(1, 1),
      manyAgentPrompt(1, 2)
    ])
    expect(second.sends[3]).toMatchObject({ acknowledged: true, steered: true, roundId: null })
  })

  it('makes no send of a lane that stopped for any other reason', () => {
    const cut = snapshot([
      { chatId: CHATS[0], rounds: [ended('a1')], failure: 'observer_read_failed' },
      { chatId: CHATS[1], rounds: [ended('b1')], failure: 'busy_before_send' }
    ])
    const record = drill.drillRecordOf({ threads: THREADS, snapshot: cut, priorRounds: [] })
    expect(record.map((thread: { sends: unknown[] }) => thread.sends.length)).toEqual([1, 1])
  })
})

describe('the first launch’s phase', () => {
  const input = (clock: ReturnType<typeof fakeClock>, extra: Record<string, unknown> = {}) => ({
    page: {},
    threads: THREADS,
    priorRounds: [],
    nowMs: clock.nowMs,
    sleep: clock.sleep,
    ...extra
  })

  it('stops its lanes, then kills, once it may, and leaves its record before it throws', async () => {
    const lanes = fakeLanes([snapshot([]), READY])
    const order: string[] = lanes.events
    const records: Array<Record<string, any>> = []
    const phase = drill.createDriveAndKill({
      createLanes: lanes.createLanes,
      killChild: async () => {
        order.push('kill')
        return { ok: true, pgid: 4321, signal: 'SIGKILL' }
      },
      onRecord: (record: Record<string, any>) => {
        order.push('record')
        records.push(record)
      }
    })
    const clock = fakeClock()
    const failure = await phase(input(clock, { laneOptions: { roundTimeoutMs: 900_000 } })).then(
      () => null,
      (error: Error & { code?: string; killDrill?: unknown }) => error
    )
    expect(failure?.code).toBe(drill.KILLED_CODE)
    expect(order).toEqual([
      'create chat-01,chat-02 900000',
      'install',
      'start',
      'stop',
      'kill',
      'record'
    ])
    expect(records).toHaveLength(1)
    expect(failure?.killDrill).toBe(records[0])
    expect(records[0]).toMatchObject({
      outcome: 'killed',
      endedRoundsBeforeKill: 2,
      kill: { ok: true, pgid: 4321 },
      atCut: { ready: true, threadsWithARoundRunning: 2 }
    })
    expect(records[0].threads[0].sends.map((send: { roundId: string }) => send.roundId)).toEqual([
      'a1',
      'a2',
      'a3'
    ])
  })

  it('never kills once a thread has failed, nor after its bound, nor with nothing running at the cut', async () => {
    const failed = snapshot([
      { chatId: CHATS[0], rounds: [ended('a1')], failure: 'not_started' },
      { chatId: CHATS[1], rounds: [running('b1')], failure: null }
    ])
    const idleAtCut = snapshot([
      { chatId: CHATS[0], rounds: [ended('a1'), ended('a2')], failure: null },
      { chatId: CHATS[1], rounds: [ended('b1'), ended('b2')], failure: null }
    ])
    for (const [snapshots, cut, outcome] of [
      [[failed], failed, 'thread_failed_before_kill'],
      [[snapshot([])], snapshot([]), 'kill_condition_not_reached'],
      [[READY], idleAtCut, 'nothing_running_at_the_cut']
    ] as Array<[Snapshot[], Snapshot, string]>) {
      const lanes = fakeLanes(snapshots, cut)
      const kills: unknown[] = []
      const records: Array<Record<string, unknown>> = []
      const phase = drill.createDriveAndKill({
        createLanes: lanes.createLanes,
        killChild: async () => void kills.push(1),
        onRecord: (record: Record<string, unknown>) => void records.push(record)
      })
      const clock = fakeClock()
      const result = await phase(input(clock, { leadInTimeoutMs: 60_000 }))
      expect(kills).toEqual([])
      expect(lanes.events).toContain('stop')
      expect(result).toMatchObject({ verdict: { ok: false, reasons: [outcome] } })
      expect(records[0]).toMatchObject({ outcome, kill: null })
    }
  })

  it('is refused without the means to kill or record', () => {
    expect(() => drill.createDriveAndKill({ onRecord: () => {} })).toThrow(
      'the kill drill needs a way to kill the app it launched'
    )
    expect(() => drill.createDriveAndKill({ killChild: async () => ({}) })).toThrow(
      'the kill drill needs onRecord'
    )
  })
})

describe('killing the recorded process group as a crash would', () => {
  const member = (pid: number, command: string) => ({ pid, pgid: 4321, command })

  it('sends SIGKILL to that group alone, then waits until nothing is left in it', async () => {
    const signals: Array<[number, string]> = []
    const listings = [
      [member(4321, 'Electron'), member(4400, 'Electron Helper (Renderer)')],
      [member(4321, 'Electron')],
      []
    ]
    const clock = fakeClock()
    const kill = await drill.killProcessGroupAsACrash({
      pgid: 4321,
      listGroup: async () => listings.shift() ?? [],
      signal: (target: number, name: string) => void signals.push([target, name]),
      ...clock
    })
    expect(signals).toEqual([[-4321, 'SIGKILL']])
    expect(kill).toMatchObject({
      ok: true,
      pgid: 4321,
      signal: 'SIGKILL',
      membersAtKill: [
        { pid: 4321, command: 'Electron' },
        { pid: 4400, command: 'Electron Helper (Renderer)' }
      ]
    })
    expect(kill.groupGoneAfterMs).toBeGreaterThan(0)
  })

  it('signals nothing without its leader, or with no group recorded, and says when the group lives on', async () => {
    const signals: unknown[] = []
    const signal = (...args: unknown[]) => void signals.push(args)
    expect(
      await drill.killProcessGroupAsACrash({
        pgid: 4321,
        listGroup: async () => [member(4400, 'Electron Helper')],
        signal
      })
    ).toMatchObject({ ok: false, reason: 'leader_not_found' })
    for (const pgid of [null, 0, 1, -5, 1.5]) {
      expect(await drill.killProcessGroupAsACrash({ pgid, signal })).toMatchObject({
        ok: false,
        reason: 'no_recorded_process_group'
      })
    }
    expect(signals).toEqual([])

    const clock = fakeClock()
    const survived = await drill.killProcessGroupAsACrash({
      pgid: 4321,
      listGroup: async () => [member(4321, 'Electron')],
      signal,
      groupGoneTimeoutMs: 100,
      ...clock
    })
    expect(survived).toMatchObject({
      ok: false,
      reason: 'group_survived',
      survivors: [{ pid: 4321, command: 'Electron' }]
    })
    expect(
      await drill.killProcessGroupAsACrash({
        pgid: 4321,
        listGroup: async () => [member(4321, 'Electron')],
        signal: () => {
          throw Object.assign(new Error('no'), { code: 'EPERM' })
        }
      })
    ).toMatchObject({ ok: false, reason: 'signal_failed_EPERM' })
  })

  it('reads a process by its pid, group and command name only', () => {
    expect(
      drill.parseProcessLine(
        '  4400  4321 /x/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer)'
      )
    ).toEqual({ pid: 4400, pgid: 4321, command: 'Electron Helper (Renderer)' })
    expect(drill.parseProcessLine('')).toBeNull()
  })
})

/** A page whose `window.api.getChat` answers from `chats`, the read run as the page runs it. */
function fakePage(chats: Record<string, unknown>, options: { notReadyFor?: number } = {}) {
  let reads = 0
  return {
    reads: () => reads,
    evaluate: async (expression: string) => {
      reads += 1
      const api =
        reads <= (options.notReadyFor ?? 0)
          ? undefined
          : { getChat: async (chatId: string) => chats[chatId] ?? null }
      return vm.runInNewContext(expression, { window: { api } })
    }
  }
}

/** A thread as the app keeps it, from the rounds it holds. */
function chatRecord(
  rounds: Array<{ roundId: string; prompt: string; ended?: boolean; runs?: string[] }>,
  extra: Record<string, unknown> = {}
) {
  return {
    messages: [
      ...rounds.map((round) => ({
        id: `ensemble-user-${round.roundId}`,
        role: 'user',
        content: round.prompt
      })),
      { id: 'other', role: 'user', content: 'a message that is no drill’s' },
      { id: 'reply', role: 'assistant', content: 'an answer' }
    ],
    runs: rounds.flatMap((round) =>
      (round.runs ?? ['success', 'success']).map((status) => ({
        ensembleRoundId: round.roundId,
        status
      }))
    ),
    ensemble: {
      roundWallMsById: Object.fromEntries(
        rounds.filter((round) => round.ended !== false).map((round) => [round.roundId, 10])
      ),
      activeRound: null
    },
    ...extra
  }
}

describe('the read-back', () => {
  it('keeps of each thread only what the drill compares, never a user’s words', async () => {
    const page = fakePage({
      [CHATS[0]]: chatRecord([{ roundId: 'a1', prompt: manyAgentPrompt(0, 1) }])
    })
    const value = await page.evaluate(drill.readBackExpression(CHATS))
    const read = drill.parseReadBack(value, CHATS)
    expect(read).toEqual({
      ok: true,
      chats: [
        {
          chatId: CHATS[0],
          found: true,
          messageCount: 3,
          runCount: 2,
          userMessages: [
            { id: 'ensemble-user-a1', prompt: manyAgentPrompt(0, 1) },
            { id: 'other', prompt: null }
          ],
          ledger: ['a1'],
          activeRound: null,
          runs: [
            { roundId: 'a1', status: 'success' },
            { roundId: 'a1', status: 'success' }
          ]
        },
        { chatId: CHATS[1], found: false }
      ]
    })
    expect(JSON.stringify(value)).not.toContain('no drill')
    expect(JSON.stringify(value)).not.toContain('an answer')
  })

  it('refuses a read that is not the threads it asked for', () => {
    expect(drill.parseReadBack({ notReady: true }, CHATS)).toEqual({
      ok: false,
      reason: 'page_not_ready'
    })
    for (const value of [
      null,
      { chats: [] },
      {
        chats: [
          { chatId: CHATS[1], found: false },
          { chatId: CHATS[0], found: false }
        ]
      },
      {
        chats: [
          { chatId: CHATS[0], found: true, messageCount: 1 },
          { chatId: CHATS[1], found: false }
        ]
      }
    ]) {
      expect(drill.parseReadBack(value, CHATS)).toEqual({ ok: false, reason: 'invalid' })
    }
  })

  it('waits for the page to answer for every thread, within its bound', async () => {
    const record = { outcome: 'killed', kill: { ok: true }, threads: [] }
    const both = {
      [CHATS[0]]: chatRecord([]),
      [CHATS[1]]: chatRecord([])
    }
    const page = fakePage(both, { notReadyFor: 2 })
    const clock = fakeClock()
    const judged: unknown[] = []
    const phase = drill.createReadBack({
      record,
      readyPollMs: 10,
      onJudged: (result: unknown) => judged.push(result)
    })
    const result = await phase({ page, threads: THREADS, ...clock })
    expect(page.reads()).toBe(3)
    expect(result.killDrill.readBack).toMatchObject({ ok: true, attempts: 3, readAfterMs: 20 })
    expect(judged).toEqual([result.killDrill])

    // A thread that never comes back is judged once the bound has passed.
    const half = fakePage({ [CHATS[0]]: chatRecord([]) })
    const bounded = drill.createReadBack({ record, readyTimeoutMs: 50, readyPollMs: 10 })
    const late = await bounded({ page: half, threads: THREADS, ...fakeClock() })
    expect(half.reads()).toBe(6)
    expect(late.killDrill.readBack.chats[1]).toEqual({ chatId: CHATS[1], found: false })
  })
})

describe('the judgement', () => {
  /** The first launch's record: on thread 1 the warm-up and two lane rounds, on thread 2 one. */
  function recordOf(cut: Snapshot) {
    return {
      outcome: 'killed',
      kill: { ok: true },
      threads: drill.drillRecordOf({
        threads: THREADS,
        snapshot: cut,
        priorRounds: [
          {
            purpose: 'warm_up',
            chatId: CHATS[0],
            status: 'started',
            roundId: 'w1',
            outcome: 'settled',
            roundStatus: 'completed'
          }
        ]
      })
    }
  }
  const CUT = snapshot([
    { chatId: CHATS[0], rounds: [ended('a1'), running('a2')], failure: 'send_failed' },
    { chatId: CHATS[1], rounds: [ended('b1')], failure: null }
  ])
  const kept = () => ({
    [CHATS[0]]: chatRecord([
      { roundId: 'w1', prompt: liveRoundPrompt('warm_up') },
      { roundId: 'a1', prompt: manyAgentPrompt(0, 1) },
      { roundId: 'a2', prompt: manyAgentPrompt(0, 2), ended: false, runs: ['running'] }
    ]),
    [CHATS[1]]: chatRecord([{ roundId: 'b1', prompt: manyAgentPrompt(1, 1) }])
  })
  const judge = async (chats: Record<string, unknown>, record = recordOf(CUT)) => {
    const read = drill.parseReadBack(
      await fakePage(chats).evaluate(drill.readBackExpression(CHATS)),
      CHATS
    )
    return drill.judgeKillDrill({ record, readBack: read })
  }

  it('passes when everything acknowledged is there, and reports what was not acknowledged', async () => {
    const judgement = await judge(kept())
    expect(judgement).toMatchObject({
      ok: true,
      reasons: [],
      counts: { acknowledged: 4, acknowledgedPresent: 4, seenToEnd: 3, seenToEndKept: 3 },
      missing: [],
      changed: [],
      endsLost: []
    })
    // The send the kill cut off was never acknowledged: reported, allowed.
    expect(judgement.unacknowledged).toEqual([
      {
        chatId: CHATS[0],
        source: 'lane',
        prompt: manyAgentPrompt(0, 3),
        unanswered: 'send_failed',
        kept: false
      }
    ])
    // A round acknowledged but not seen to end: what the relaunch shows of it.
    expect(judgement.notSeenToEnd).toEqual([
      {
        chatId: CHATS[0],
        source: 'lane',
        prompt: manyAgentPrompt(0, 2),
        roundId: 'a2',
        endRecordedAfter: false,
        runStatusesAfter: ['running']
      }
    ])
  })

  it('fails on an acknowledged message that is missing or changed', async () => {
    const chats = kept()
    const thread = chats[CHATS[1]] as { messages: Array<{ id: string; content: string }> }
    thread.messages = thread.messages.filter((message) => message.id !== 'ensemble-user-b1')
    const first = chats[CHATS[0]] as { messages: Array<{ id: string; content: string }> }
    first.messages.find((message) => message.id === 'ensemble-user-w1')!.content = manyAgentPrompt(
      0,
      9
    )
    const judgement = await judge(chats)
    expect(judgement.ok).toBe(false)
    expect(judgement.reasons).toEqual([
      'acknowledged_message_changed',
      'acknowledged_message_missing'
    ])
    expect(judgement.missing).toEqual([
      { chatId: CHATS[1], source: 'lane', prompt: manyAgentPrompt(1, 1), roundId: 'b1' }
    ])
    expect(judgement.changed).toEqual([
      { chatId: CHATS[0], source: 'warm_up', prompt: liveRoundPrompt('warm_up'), roundId: 'w1' }
    ])
  })

  it('fails on a round seen to end that is no longer ended, has lost its runs, or has one not final', async () => {
    const chats = kept()
    const first = chats[CHATS[0]] as ReturnType<typeof chatRecord>
    delete (first.ensemble.roundWallMsById as Record<string, number>).a1
    first.runs = first.runs.filter((run) => run.ensembleRoundId !== 'w1')
    const second = chats[CHATS[1]] as ReturnType<typeof chatRecord>
    second.runs[0].status = 'running'
    const judgement = await judge(chats)
    expect(judgement.reasons).toEqual([
      'ended_round_runs_missing',
      'ended_round_end_not_recorded',
      'ended_round_run_not_final'
    ])
    expect(judgement.endsLost.map((lost: { roundId: string; lost: string[] }) => lost)).toEqual([
      {
        chatId: CHATS[0],
        source: 'warm_up',
        prompt: liveRoundPrompt('warm_up'),
        roundId: 'w1',
        endStatus: 'completed',
        lost: ['runs_missing']
      },
      {
        chatId: CHATS[0],
        source: 'lane',
        prompt: manyAgentPrompt(0, 1),
        roundId: 'a1',
        endStatus: 'completed',
        lost: ['end_not_recorded']
      },
      {
        chatId: CHATS[1],
        source: 'lane',
        prompt: manyAgentPrompt(1, 1),
        roundId: 'b1',
        endStatus: 'completed',
        lost: ['run_not_final']
      }
    ])
  })

  it('takes a round the thread still holds as its active round, ended, as recorded', async () => {
    const chats = kept()
    const second = chats[CHATS[1]] as ReturnType<typeof chatRecord>
    second.ensemble.roundWallMsById = {}
    ;(second.ensemble as Record<string, unknown>).activeRound = {
      roundId: 'b1',
      status: 'completed'
    }
    expect((await judge(chats)).ok).toBe(true)
    ;(second.ensemble as Record<string, unknown>).activeRound = { roundId: 'b1', status: 'running' }
    expect((await judge(chats)).reasons).toEqual(['ended_round_end_not_recorded'])
    // Another round, ended, records nothing of this one.
    ;(second.ensemble as Record<string, unknown>).activeRound = {
      roundId: 'b9',
      status: 'completed'
    }
    expect((await judge(chats)).reasons).toEqual(['ended_round_end_not_recorded'])
  })

  it('fails on a thread that is gone, a read that failed, a kill that failed, or a drill that saw nothing end', async () => {
    const chats = kept()
    delete chats[CHATS[1]]
    const gone = await judge(chats)
    expect(gone.reasons).toEqual(['thread_missing'])
    expect(gone.missing).toEqual([
      { chatId: CHATS[1], prompt: manyAgentPrompt(1, 1), roundId: 'b1' }
    ])

    expect(
      drill.judgeKillDrill({
        record: recordOf(CUT),
        readBack: { ok: false, reason: 'read_failed' }
      }).reasons
    ).toEqual(['read_back_read_failed'])
    expect(
      drill.judgeKillDrill({
        record: { ...recordOf(CUT), kill: { ok: false, reason: 'group_survived' } },
        readBack: { ok: false, reason: 'page_not_ready' }
      }).reasons
    ).toEqual(['kill_group_survived', 'read_back_page_not_ready'])
    expect(
      drill.judgeKillDrill({
        record: { ...recordOf(CUT), outcome: 'kill_condition_not_reached', kill: null },
        readBack: { ok: false, reason: 'not_read' }
      }).reasons
    ).toEqual(['kill_condition_not_reached', 'read_back_not_read'])
    expect(drill.judgeKillDrill({ record: null, readBack: null })).toMatchObject({
      ok: false,
      reasons: ['first_launch_unrecorded']
    })
    const nothingEnded = snapshot([
      { chatId: CHATS[0], rounds: [running('a1')], failure: null },
      { chatId: CHATS[1], rounds: [running('b1')], failure: null }
    ])
    const record = {
      outcome: 'killed',
      kill: { ok: true },
      threads: drill.drillRecordOf({ threads: THREADS, snapshot: nothingEnded, priorRounds: [] })
    }
    expect((await judge(kept(), record)).reasons).toEqual(['nothing_seen_to_end'])
  })

  it('finds a steered send by its prompt', async () => {
    const cut = snapshot([
      { chatId: CHATS[0], rounds: [ended('a1')], failure: 'steered' },
      { chatId: CHATS[1], rounds: [ended('b1')], failure: null }
    ])
    const record = {
      outcome: 'killed',
      kill: { ok: true },
      threads: drill.drillRecordOf({ threads: THREADS, snapshot: cut, priorRounds: [] })
    }
    const chats = {
      [CHATS[0]]: chatRecord([{ roundId: 'a1', prompt: manyAgentPrompt(0, 1) }]),
      [CHATS[1]]: chatRecord([{ roundId: 'b1', prompt: manyAgentPrompt(1, 1) }])
    }
    expect((await judge(chats, record)).reasons).toEqual(['acknowledged_message_missing'])
    const first = chats[CHATS[0]] as ReturnType<typeof chatRecord>
    first.messages.push({ id: 'steer-row', role: 'user', content: manyAgentPrompt(0, 2) })
    expect((await judge(chats, record)).ok).toBe(true)
  })
})

describe('the scripted model both launches share', () => {
  it('starts once, gives each launch a stop that leaves it running, and stops at the drill’s end', async () => {
    const started: Array<Record<string, unknown>> = []
    const stops: string[] = []
    const shared = drill.createSharedDaemon({
      dir: '/drill/scripted-ollama',
      start: async (input: Record<string, unknown>) => {
        started.push(input)
        return {
          pid: 77,
          baseUrl: 'http://127.0.0.1:1',
          stop: async () => {
            stops.push('real')
            return { exit: { code: 0, signal: null }, forced: false, summary: {} }
          }
        }
      }
    })
    expect(await shared.stop()).toBeNull()
    const config = { seed: 42, models: [{ name: 'scripted-llama:t001' }] }
    const first = await shared.start({ dir: '/launch-1/scripted-ollama', config })
    const second = await shared.start({ dir: '/launch-2/scripted-ollama', config })
    expect(started).toEqual([{ dir: '/drill/scripted-ollama', config }])
    expect([first.pid, second.pid, shared.pid]).toEqual([77, 77, 77])
    expect(await first.stop()).toEqual({
      exit: null,
      forced: false,
      summary: { keptRunningForTheKillDrill: true },
      stderrTail: ''
    })
    expect(stops).toEqual([])
    await expect(shared.start({ dir: '/x', config: { ...config, seed: 7 } })).rejects.toThrow(
      'the kill drill’s relaunch asked for a different scripted model'
    )
    expect(await shared.stop()).toMatchObject({ exit: { code: 0 } })
    expect(stops).toEqual(['real'])
  })
})

describe('stopping the Hosts the drill recorded', () => {
  const BIRTH = 'a'.repeat(64)
  const PROFILE = '/drill/home/Library/Application Support/TaskWraith Dev drill-1'

  function hostCli(listings: Array<Array<Record<string, unknown>>>, exits: number[] = []) {
    const calls: string[][] = []
    const run = ({ args }: { args: string[] }) => {
      calls.push(args)
      const hosts = args[0] === 'status' ? (listings.shift() ?? []) : []
      return { exit: args[0] === 'status' ? 0 : (exits.shift() ?? 0), parsed: { hosts } }
    }
    return { calls, run }
  }

  it('stops each recorded Host by its pid and birth, then the profile alone, never --all', () => {
    const cli = hostCli([
      [
        { pid: 7001, liveness: 'live', birthIdentity: BIRTH },
        { pid: 7002, liveness: 'dead', birthIdentity: null }
      ],
      []
    ])
    const result = drill.stopRecordedHosts({
      run: cli.run,
      isAlive: () => false,
      profilePath: PROFILE,
      hostPids: [7001, 7001, 7002, 7003, null],
      cliPath: '/tree/out/host/host-runtime/cli.js',
      nodePath: '/node',
      env: {}
    })
    expect(cli.calls).toEqual([
      ['status', '--profile', PROFILE, '--json'],
      ['stop-all', '--profile', PROFILE, '--expect-pid', '7001', '--expect-birth', BIRTH, '--json'],
      ['stop-all', '--profile', PROFILE, '--json'],
      ['status', '--profile', PROFILE, '--json']
    ])
    expect(cli.calls.flat()).not.toContain('--all')
    expect(result.ok).toBe(true)
    expect(result.steps.map((step: { step: string }) => step.step)).toEqual([
      'status_before',
      'stop_recorded_host',
      'recorded_host_not_live',
      'recorded_host_not_listed',
      'stop_profile',
      'status_after'
    ])
    expect(result.recorded).toEqual([
      { pid: 7001, aliveAfter: false },
      { pid: 7002, aliveAfter: false },
      { pid: 7003, aliveAfter: false }
    ])
  })

  it('is not ok while a Host is listed or alive after, or a stop failed', () => {
    const options = (run: unknown, isAlive = () => false) => ({
      run,
      isAlive,
      profilePath: PROFILE,
      hostPids: [7001],
      env: {}
    })
    const live = [{ pid: 7001, liveness: 'live', birthIdentity: BIRTH }]
    expect(drill.stopRecordedHosts(options(hostCli([live, live]).run)).ok).toBe(false)
    expect(drill.stopRecordedHosts(options(hostCli([live, []]).run, () => true)).ok).toBe(false)
    expect(drill.stopRecordedHosts(options(hostCli([live, []], [1]).run)).ok).toBe(false)
    for (const birthIdentity of [null, 'not-a-digest', 'A'.repeat(64)]) {
      const cli = hostCli([[{ pid: 7001, liveness: 'live', birthIdentity }], []])
      const result = drill.stopRecordedHosts(options(cli.run))
      expect(result.steps[1]).toEqual({ step: 'recorded_host_without_birth', pid: 7001 })
      expect(cli.calls.some((args: string[]) => args.includes('--expect-pid'))).toBe(false)
    }
  })
})

describe('the drill', () => {
  const INSTANCE = 'drill-1'

  /** The drill's world: a home, a temporary folder and a folder for its record, all made here. */
  function world() {
    const root = makeDirectory()
    const home = path.join(root, 'home')
    const temporary = path.join(root, 'tmp')
    mkdirSync(home)
    mkdirSync(temporary)
    const profile = path.join(home, 'Library', 'Application Support', `TaskWraith Dev ${INSTANCE}`)
    return { root, home, temporary, profile, drillDir: path.join(root, 'drill') }
  }

  const argvFor = (home: string) => [
    '--workload=many_agents_live',
    '--live-agents',
    '--agent-threads=2',
    '--agent-seats=2',
    '--launch',
    '--i-accept-isolated-launch',
    `--home=${home}`,
    `--instance-id=${INSTANCE}`
  ]

  /** What a launch's browser guard says when no browser started. */
  const noBrowser = (launch: number) => ({
    browser: `/drill/launch-${launch}/browser-stand-in.sh`,
    requestsFile: `/drill/launch-${launch}/browser-requests.txt`,
    requests: [],
    browsers: 'none_started',
    browsersStarted: [],
    processListing: { before: 700, after: 700, error: null }
  })
  const firefoxStarted = (launch: number) => ({
    ...noBrowser(launch),
    requests: ['https://accounts.example.test/oauth2/auth?…'],
    browsers: 'started',
    browsersStarted: [{ pid: 12287, command: 'firefox', browser: 'firefox' }],
    processListing: { before: 700, after: 714, error: null }
  })

  /**
   * A runner that does what the drill needs of the real one: the first
   * launch materializes the profile, reports the session it verified, starts
   * the model, runs the phase and unwinds through its own cleanup, which
   * tells what its browser guard saw (`guards`, a launch each, or none when
   * null); the relaunch runs the read-back on the threads the profile holds.
   */
  function fakeRunner(
    w: ReturnType<typeof world>,
    chats: Record<string, unknown>,
    guards: Array<Record<string, unknown> | null> = [noBrowser(1), noBrowser(2)]
  ) {
    const calls: Array<{ argv: string[]; options: Record<string, any> }> = []
    const daemonStops: unknown[] = []
    const runner = async (argv: string[], options: Record<string, any>) => {
      calls.push({ argv, options })
      const first = calls.length === 1
      const guard = guards[calls.length - 1]
      if (first) mkdirSync(w.profile, { recursive: true })
      const socketNamespace = path.join(w.temporary, 'twh2-501-aaaa')
      mkdirSync(socketNamespace, { recursive: true })
      options.onVerifiedCaptureSession({
        childPid: first ? 4321 : 4400,
        userDataPath: w.profile,
        serverInstance: { ok: true, evidence: { hostPid: 7001, socketNamespace } }
      })
      const daemon = await options.startScriptedDaemon({
        dir: path.join(argv.find((arg) => arg.startsWith('--artifact-dir='))!.slice(15), 'm'),
        config: { seed: 42 }
      })
      const clock = fakeClock()
      try {
        const agents = await options.runManyAgents({
          page: fakePage(chats),
          threads: THREADS,
          priorRounds: [],
          ...clock
        })
        return { ok: agents.verdict.ok }
      } finally {
        daemonStops.push(await daemon.stop())
        if (guard) options.onBrowserGuard(guard)
      }
    }
    return { calls, daemonStops, runner }
  }

  const keptChats = () => ({
    [CHATS[0]]: chatRecord([
      { roundId: 'a1', prompt: manyAgentPrompt(0, 1) },
      { roundId: 'a2', prompt: manyAgentPrompt(0, 2) },
      { roundId: 'a3', prompt: manyAgentPrompt(0, 3), ended: false, runs: ['running'] }
    ]),
    [CHATS[1]]: chatRecord([
      { roundId: 'b1', prompt: manyAgentPrompt(1, 1) },
      { roundId: 'b2', prompt: manyAgentPrompt(1, 2) },
      { roundId: 'b3', prompt: manyAgentPrompt(1, 3), ended: false, runs: ['success'] }
    ])
  })

  function drillOptions(
    w: ReturnType<typeof world>,
    runner: unknown,
    extra: Record<string, unknown> = {}
  ) {
    const kills: unknown[] = []
    const hostStops: Array<Record<string, any>> = []
    const daemonStarts: unknown[] = []
    return {
      kills,
      hostStops,
      daemonStarts,
      options: {
        runner,
        argv: argvFor(w.home),
        platform: 'darwin',
        drillDir: w.drillDir,
        repoRoot,
        tmpdir: w.temporary,
        runnerOptions: { allowDirtyLaunch: true, terminateOptions: { waitMs: 20 } },
        createLanes: fakeLanes([READY]).createLanes,
        killChild: async (pgid: number) => {
          kills.push(pgid)
          return { ok: true, pgid, signal: 'SIGKILL' }
        },
        listGroup: async () => [],
        stopHosts: (input: Record<string, any>) => {
          hostStops.push(input)
          return { ok: true, steps: [], recorded: [{ pid: 7001, aliveAfter: false }] }
        },
        startDaemon: async (input: unknown) => {
          daemonStarts.push(input)
          return {
            pid: 99,
            baseUrl: 'http://127.0.0.1:1',
            stop: async () => ({ exit: { code: 0, signal: null }, forced: false, summary: {} })
          }
        },
        nowIso: () => '2026-10-05T04:00:00.000Z',
        ...extra
      }
    }
  }

  it('kills the first launch, reads the relaunch back, stops what it left, and records it all', async () => {
    const w = world()
    const fake = fakeRunner(w, keptChats())
    const { options, kills, hostStops, daemonStarts } = drillOptions(w, fake.runner)
    const report = await drill.runKillDrill(options)

    expect(fake.calls.map((call) => call.argv.slice(8))).toEqual([
      [
        '--materialize-instance-userdata',
        `--artifact-dir=${path.join(w.drillDir, 'launch-1-drive-and-kill')}`
      ],
      ['--reuse-instance-userdata', `--artifact-dir=${path.join(w.drillDir, 'launch-2-read-back')}`]
    ])
    for (const { options: launch } of fake.calls) {
      // No capture steps, the operator's options kept, what each launch's
      // browser guard saw told back, and no launch's cleanup may reap the
      // Host by its command line.
      expect(launch).toMatchObject({ maxCapturePhaseMs: 0, allowDirtyLaunch: true })
      expect(launch.onBrowserGuard).toEqual(expect.any(Function))
      expect(launch.terminateOptions.waitMs).toBe(20)
      expect(await launch.terminateOptions.listPidsMatchingCommandNeedle('anything')).toEqual([])
    }
    // One model for both launches, in the drill's own folder.
    expect(daemonStarts).toEqual([
      { dir: path.join(w.drillDir, 'scripted-ollama'), config: { seed: 42 } }
    ])
    expect(fake.daemonStops).toMatchObject([
      { summary: { keptRunningForTheKillDrill: true } },
      { summary: { keptRunningForTheKillDrill: true } }
    ])
    expect(kills).toEqual([4321])

    expect(report).toMatchObject({
      kind: 'kill_drill',
      ok: true,
      verdict: { ok: true, reasons: [] },
      cleanup: { ok: true, hostStopped: true, processGroupsEmpty: true, modelStopped: true },
      firstLaunch: { ended: 'killed_by_the_drill', childPid: 4321 },
      secondLaunch: { ended: 'returned', ok: true, childPid: 4400 },
      record: { outcome: 'killed', kill: { ok: true, pgid: 4321 } },
      judgement: { counts: { acknowledged: 6, acknowledgedPresent: 6, seenToEnd: 4 } },
      modelStop: { pid: 99, exit: { code: 0 }, forced: false, summary: true },
      processGroupsLeft: { first: [], second: [] },
      browserGuard: { ok: true, firstLaunch: noBrowser(1), secondLaunch: noBrowser(2) },
      profilePath: w.profile
    })
    // The Hosts are stopped by the identities recorded, on the drill's own profile.
    expect(hostStops).toHaveLength(1)
    expect(hostStops[0]).toMatchObject({
      hostPids: [7001, 7001],
      profilePath: realpathSync(w.profile),
      cliPath: path.join(repoRoot, 'out', 'host', 'host-runtime', 'cli.js'),
      env: {
        HOME: w.home,
        TASKWRAITH_HOST_REGISTRY_ROOT: path.join(w.home, '.taskwraith', 'hosts'),
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin'
      }
    })
    // What the run left, and where: nothing in the temporary folder was removed.
    expect(report.leftBehind).toMatchObject({
      temporaryFolder: w.temporary,
      newInTemporaryFolder: ['twh2-501-aaaa'],
      hostSocketFolders: [{ name: 'twh2-501-aaaa', presentAfter: true }],
      home: ['Library']
    })
    expect(existsSync(path.join(w.temporary, 'twh2-501-aaaa'))).toBe(true)
    // du(1) is a POSIX diagnostic, not a prerequisite for the crash drill.
    if (process.platform === 'win32') expect(report.diskKib.drillDir).toBeNull()
    else expect(report.diskKib.drillDir).toEqual(expect.any(Number))
    expect(
      JSON.parse(readFileSync(path.join(w.drillDir, 'kill-drill-report.json'), 'utf8'))
    ).toEqual(JSON.parse(JSON.stringify(report)))
  })

  it('fails when the relaunch lost what was acknowledged', async () => {
    const w = world()
    const chats = keptChats()
    const lost = chats[CHATS[1]] as ReturnType<typeof chatRecord>
    lost.messages = lost.messages.filter((message) => message.id !== 'ensemble-user-b2')
    const fake = fakeRunner(w, chats)
    const report = await drill.runKillDrill(drillOptions(w, fake.runner).options)
    expect(report).toMatchObject({
      ok: false,
      verdict: { ok: false, reasons: ['acknowledged_message_missing'] },
      secondLaunch: { ended: 'returned', ok: false }
    })
  })

  it('still stops what it left when the first launch fails before the phase', async () => {
    const w = world()
    const runner = async () => {
      throw new Error('Launch preflight refused')
    }
    const { options, kills, hostStops } = drillOptions(w, runner)
    const report = await drill.runKillDrill(options)
    expect(kills).toEqual([])
    expect(hostStops).toHaveLength(1)
    expect(hostStops[0].hostPids).toEqual([])
    expect(report).toMatchObject({
      ok: false,
      verdict: { ok: false, reasons: ['first_launch_unrecorded'] },
      firstLaunch: { ended: 'failed', error: 'Launch preflight refused' },
      secondLaunch: { ended: 'not_launched' },
      modelStop: null,
      processGroupsLeft: { first: null, second: null }
    })
    expect(existsSync(path.join(w.drillDir, 'kill-drill-report.json'))).toBe(true)
  })

  it('never relaunches after a kill that failed, and says why', async () => {
    const w = world()
    const fake = fakeRunner(w, keptChats())
    const report = await drill.runKillDrill(
      drillOptions(w, fake.runner, {
        killChild: async (pgid: number) => ({ ok: false, reason: 'group_survived', pgid })
      }).options
    )
    expect(fake.calls).toHaveLength(1)
    expect(report).toMatchObject({
      ok: false,
      verdict: { ok: false, reasons: ['kill_group_survived'] },
      secondLaunch: { ended: 'not_launched' }
    })
  })

  it('never relaunches unless the first launch’s guard saw no browser start, and still stops what it left', async () => {
    const cases: Array<[Record<string, unknown> | null, string]> = [
      [firefoxStarted(1), 'first_launch_browsers_started'],
      [
        { ...noBrowser(1), browsers: 'unknown', processListing: { error: 'ps timed out' } },
        'first_launch_browsers_unknown'
      ],
      [null, 'first_launch_browsers_unwatched']
    ]
    for (const [guard, reason] of cases) {
      const w = world()
      const fake = fakeRunner(w, keptChats(), [guard])
      const { options, kills, hostStops } = drillOptions(w, fake.runner)
      const report = await drill.runKillDrill(options)
      expect(kills).toEqual([4321])
      expect(fake.calls).toHaveLength(1)
      expect(hostStops).toHaveLength(1)
      expect(report).toMatchObject({
        ok: false,
        verdict: { ok: false, reasons: [reason] },
        secondLaunch: { ended: 'not_launched' },
        browserGuard: { ok: false, firstLaunch: guard, secondLaunch: null },
        cleanup: { ok: true }
      })
    }
  })

  it('is not ok when a browser started during the relaunch, though nothing was lost', async () => {
    const w = world()
    const fake = fakeRunner(w, keptChats(), [noBrowser(1), firefoxStarted(2)])
    const report = await drill.runKillDrill(drillOptions(w, fake.runner).options)
    expect(fake.calls).toHaveLength(2)
    expect(report).toMatchObject({
      ok: false,
      verdict: { ok: true, reasons: [] },
      cleanup: { ok: true },
      browserGuard: { ok: false, firstLaunch: noBrowser(1), secondLaunch: firefoxStarted(2) }
    })
  })

  it('is not clean while a group, a Host or the model is left', async () => {
    const w = world()
    const fake = fakeRunner(w, keptChats())
    const report = await drill.runKillDrill(
      drillOptions(w, fake.runner, {
        listGroup: async (pgid: number) =>
          pgid === 4400 ? [{ pid: 4401, pgid, command: 'Electron Helper' }] : [],
        stopHosts: () => ({ ok: false, steps: [], recorded: [] })
      }).options
    )
    expect(report).toMatchObject({
      ok: false,
      verdict: { ok: true },
      cleanup: { ok: false, hostStopped: false, processGroupsEmpty: false },
      processGroupsLeft: { second: [{ pid: 4401, command: 'Electron Helper' }] }
    })
  })

  it('is refused the arguments it gives each launch itself, and a folder already there', async () => {
    const w = world()
    const refusal = (argv: string[], extra: Record<string, unknown> = {}) =>
      drill.runKillDrill({ ...drillOptions(w, async () => ({})).options, argv, ...extra }).then(
        () => null,
        (error: Error) => error.message
      )
    for (const extra of [
      '--materialize-instance-userdata',
      '--reuse-instance-userdata',
      '--artifact-dir=/x',
      '--out-dir=/x',
      '--dry-run'
    ]) {
      expect(await refusal([...argvFor(w.home), extra])).toMatch(
        /^the kill drill gives each launch --[a-z-]+ itself$/
      )
    }
    expect(await refusal(argvFor(w.home).filter((arg) => arg !== '--live-agents'))).toBe(
      'the kill drill needs --live-agents, --home and --instance-id'
    )
    mkdirSync(w.drillDir)
    expect(await refusal(argvFor(w.home))).toBe(
      `the kill drill's folder already exists: ${w.drillDir}`
    )
    expect(await refusal(argvFor(w.home), { repoRoot: 'relative' })).toBe(
      'the kill drill needs the absolute root of the tree it launches'
    )
  })
})
