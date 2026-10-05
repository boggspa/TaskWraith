/**
 * Barrier durability through the real store: a thread's saves of each kind,
 * with what each one syncs on the calling thread and what it leaves owed.
 */
import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { CHAT_DURABILITY_MOMENTS, type ChatDurabilityMoment } from './ChatDurabilityTickets'
import type { ThreadBarrierDurability } from './ThreadBarrierDurability'
import { ThreadCatalogueDiskReader } from './ThreadCatalogueDiskReader'
import type { ThreadDurabilityPort } from './ThreadDurabilityDebt'
import type { ChatRecord, RunEventInput } from './types'
import { disposeHostOwnedStores, importHostOwnedStore } from './hostOwnedErasure.testutil'
import { watchCrashDisk, type CrashDisk } from './unsyncedWriteCrashDisk.testutil'

const layers = vi.hoisted(() => ({
  port: null as ThreadDurabilityPort | null,
  built: [] as ThreadBarrierDurability[],
  /** The idle timers each layer armed, whether each was cleared, and how to fire one now. */
  timers: [] as Array<{ ms: number; cleared: boolean; fire: () => void }>,
  /** Added to the layer's clock, so a test can let a thread fall quiet without waiting. */
  clockOffsetMs: 0
}))

vi.mock('./ThreadBarrierDurability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ThreadBarrierDurability')>()
  return {
    ...actual,
    createThreadBarrierDurability: (
      options: import('./ThreadBarrierDurability').ThreadBarrierDurabilityOptions = {}
    ) => {
      const layer = actual.createThreadBarrierDurability({
        ...options,
        now: () => Date.now() + layers.clockOffsetMs,
        port: {
          syncFile: (target) => layers.port!.syncFile(target),
          syncDirectory: (target) => layers.port!.syncDirectory(target)
        },
        setTimer: (callback, ms) => {
          const timer = setTimeout(callback, ms)
          timer.unref()
          layers.timers.push({ ms, cleared: false, fire: callback })
          return { timer, record: layers.timers[layers.timers.length - 1] }
        },
        clearTimer: (handle) => {
          const armed = handle as {
            timer: ReturnType<typeof setTimeout>
            record: { cleared: boolean }
          }
          if (!armed) return
          clearTimeout(armed.timer)
          armed.record.cleared = true
        }
      })
      layers.built.push(layer)
      return layer
    }
  }
})

const disks: CrashDisk[] = []

afterEach(async () => {
  while (disks.length > 0) disks.pop()!.dispose()
  layers.port = null
  layers.built.length = 0
  layers.timers.length = 0
  layers.clockOffsetMs = 0
  vi.unstubAllEnvs()
  await disposeHostOwnedStores()
})

const CHAT = '5c7e0a52-8f1d-4c31-9a7e-2b3c4d5e6f70'
const RUN = 'run-barrier-a1'
const AT = '2026-10-05T00:00:00.000Z'

type Store = Awaited<ReturnType<typeof importHostOwnedStore>>['AppStore']

function event(kind: RunEventInput['kind'], summary: string): RunEventInput {
  return { runId: RUN, chatId: CHAT, kind, phase: 'control', source: 'main', summary }
}

function newThread(): ChatRecord {
  return {
    appChatId: CHAT,
    scope: 'global',
    chatKind: 'single',
    provider: 'codex',
    title: 'Barrier thread',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    workflowMode: 'normal',
    messages: [{ id: 'user-1', role: 'user', content: 'First question', timestamp: AT }],
    runs: []
  }
}

function lane(status: 'awaiting-approval' | 'running', approvalsQueued: number) {
  return {
    enabled: true,
    maxParticipants: 1,
    participants: [],
    activeRound: {
      roundId: 'round-1',
      status: 'running',
      startedAt: AT,
      participants: [],
      lanes: {
        'lane-1': {
          laneId: 'lane-1',
          participantId: 'participant-1',
          runId: RUN,
          provider: 'codex',
          intent: 'write',
          status,
          approvalsQueued,
          startedAt: AT
        }
      }
    }
  } as never
}

/** One save of each kind, in the order a thread meets them, with the run events beside them. */
const STEPS: Array<{ name: string; act(store: Store): void }> = [
  {
    name: 'a new thread with its first message',
    act: (store) => {
      store.saveChat(newThread())
    }
  },
  {
    name: 'a run starts',
    act: (store) => {
      const chat = store.getChat(CHAT)!
      store.saveChat({
        ...chat,
        runs: [{ runId: RUN, startedAt: AT, status: 'running', provider: 'codex' }],
        messages: [
          ...chat.messages,
          { id: 'reply-1', role: 'assistant', content: '', timestamp: AT, runId: RUN }
        ]
      })
      store.appendRunEvent(event('lifecycle', 'Run started'))
    }
  },
  {
    name: 'streamed text',
    act: (store) => {
      const chat = store.getChat(CHAT)!
      store.saveChat({
        ...chat,
        messages: chat.messages.map((message) =>
          message.id === 'reply-1' ? { ...message, content: 'Streaming the answer' } : message
        )
      })
      store.appendRunEvent({
        ...event('provider_raw', 'output'),
        phase: 'raw',
        source: 'provider',
        payload: { data: 'Streaming the answer' }
      })
    }
  },
  {
    name: 'a user message',
    act: (store) => {
      const chat = store.getChat(CHAT)!
      store.saveChat({
        ...chat,
        messages: [
          ...chat.messages,
          { id: 'user-2', role: 'user', content: 'And a follow-up', timestamp: AT }
        ]
      })
    }
  },
  {
    name: 'an approval opens',
    act: (store) => {
      store.saveChat({ ...store.getChat(CHAT)!, ensemble: lane('awaiting-approval', 1) })
      store.appendRunEvent(event('approval_request', 'Approval requested'))
    }
  },
  {
    name: 'the approval is answered',
    act: (store) => {
      store.saveChat({ ...store.getChat(CHAT)!, ensemble: lane('running', 0) })
      store.appendRunEvent(event('approval_response', 'Approved'))
    }
  },
  {
    name: 'a tool result whose detail is moved out',
    act: (store) => {
      const chat = store.getChat(CHAT)!
      store.saveChat({
        ...chat,
        messages: [
          ...chat.messages,
          {
            id: 'tool-1',
            role: 'tool',
            content: '',
            timestamp: AT,
            runId: RUN,
            toolActivities: [
              {
                id: 'activity-1',
                toolName: 'run_shell_command',
                displayName: 'Ran command',
                category: 'shell',
                status: 'success',
                endedAt: AT,
                rawResultEvent: { output: 'x'.repeat(70_000) }
              }
            ]
          }
        ]
      })
    }
  },
  {
    name: 'the run ends',
    act: (store) => {
      const chat = store.getChat(CHAT)!
      store.saveChat({
        ...chat,
        ensemble: lane('running', 0),
        runs: chat.runs.map((run) => ({ ...run, status: 'completed', endedAt: AT }))
      })
      store.appendRunEvent(event('lifecycle', 'Run completed'))
    }
  }
]

/** A sync's path with the parts that change from run to run taken out. */
function stable(entry: string): string {
  return entry
    .replace(/\.tmp-[0-9a-f-]{36}$/, '.tmp-<uuid>')
    .replace(/\.\d+\.\d+(\.\d+)?\.tmp$/, '.<pid>.<time>.tmp')
}

async function drive(switchOn: boolean) {
  if (switchOn) vi.stubEnv('TASKWRAITH_THREAD_BARRIER_DURABILITY', '1')
  const { AppStore, profilePath } = await importHostOwnedStore([])
  const disk = watchCrashDisk(profilePath)
  disks.push(disk)
  layers.port = disk.port
  const steps: Array<{ name: string; issued: string[]; paid: string[] }> = []
  for (const step of STEPS) {
    disk.issued.length = 0
    disk.paid.length = 0
    step.act(AppStore)
    const issued = disk.issued.map(stable)
    if (layers.built[0]) await layers.built[0].debt.barrier(CHAT)
    steps.push({ name: step.name, issued, paid: disk.paid.map(stable) })
  }
  return { steps, profilePath, AppStore }
}

const JOURNAL = `chat-journal-v2/${CHAT}.mutations.jsonl`
const CHECKPOINT_TEMPORARY = `chat-journal-v2/.${CHAT}.checkpoint.json.<pid>.<time>.tmp`

/**
 * The creating save's first checkpoint under the switch: written without a
 * sync, owing exactly its file and its folder to the thread's barrier, and
 * the profile's folder, where the name of the journal's folder is: the store
 * made that folder, in a new profile.
 */
const FIRST_CHECKPOINT_OWED = {
  issued: [],
  owed: ['directory:.', 'directory:chat-journal-v2', `file:chat-journal-v2/${CHAT}.checkpoint.json`]
}

/** The creating save's first checkpoint: what it synced after `before`, and what it left owed. */
function firstCheckpoint(step: { issued: string[]; paid: string[] }, before: string[] = []) {
  expect(step.issued.slice(0, before.length)).toEqual(before)
  return { issued: step.issued.slice(before.length), owed: [...step.paid].sort() }
}
const EVENTS = `run-events/${RUN}.jsonl`
const DETAIL = `run-artifacts/${RUN}/tool-activity-details.jsonl`

/**
 * What each save synced on the calling thread before the switch existed,
 * captured from the store at the commit before it was wired. With the switch
 * off, nothing may differ.
 */
const SYNCED_BEFORE_THE_SWITCH: Array<[string, string[]]> = [
  [
    'a new thread with its first message',
    [`file:${CHECKPOINT_TEMPORARY}`, `directory:chat-journal-v2`, `directory:chat-journal-v2`]
  ],
  ['a run starts', [`file:${JOURNAL}`, `directory:chat-journal-v2`, `file:${EVENTS}`]],
  ['streamed text', [`file:${JOURNAL}`]],
  ['a user message', [`file:${JOURNAL}`]],
  ['an approval opens', [`file:${JOURNAL}`]],
  ['the approval is answered', [`file:${JOURNAL}`]],
  [
    'a tool result whose detail is moved out',
    [`file:${DETAIL}`, `directory:run-artifacts/${RUN}`, `file:${EVENTS}`, `file:${JOURNAL}`]
  ],
  [
    'the run ends',
    [
      `file:${JOURNAL}`,
      `file:${CHECKPOINT_TEMPORARY}`,
      `directory:chat-journal-v2`,
      `directory:chat-journal-v2`,
      `file:${EVENTS}`
    ]
  ]
]

describe('barrier durability, switched off', () => {
  it('syncs what each save synced before the switch existed, and builds nothing', async () => {
    const { steps } = await drive(false)

    expect(steps.map((step) => [step.name, step.issued])).toEqual(SYNCED_BEFORE_THE_SWITCH)
    expect(layers.built).toEqual([])
  })

  it('reports itself off in the perf section, with the checkpoints still counted', async () => {
    const { AppStore } = await drive(false)

    expect(AppStore.getThreadBarrierDurabilityPerf()).toMatchObject({
      enabled: false,
      ignored: null,
      debt: null,
      port: null,
      tickets: null,
      gates: null,
      threads: null,
      checkpoints: { initial: { count: 1 }, terminal: { count: 1 } },
      tornTailsRepaired: 0
    })
  })
})

describe('barrier durability, switched on', () => {
  it('makes no thread store sync on the calling thread, a checkpoint included', async () => {
    const { steps } = await drive(true)

    expect(steps[0].name).toBe('a new thread with its first message')
    expect(firstCheckpoint(steps[0])).toEqual(FIRST_CHECKPOINT_OWED)
    expect(steps.slice(1).map((step) => [step.name, step.issued])).toEqual([
      ['a run starts', []],
      ['streamed text', []],
      ['a user message', []],
      ['an approval opens', []],
      ['the approval is answered', []],
      ['a tool result whose detail is moved out', []],
      ['the run ends', []]
    ])
    expect(layers.built).toHaveLength(1)
  })

  it('reports the layer in the perf section: its debt, tickets, gates and threads', async () => {
    const { AppStore } = await drive(true)

    const section = AppStore.getThreadBarrierDurabilityPerf()
    expect(section).toMatchObject({
      enabled: true,
      ignored: null,
      // The new thread's first message, and the follow-up.
      tickets: { moments: { user_message: { noted: 2 }, run_final: { noted: 1 } } },
      gates: { waits: 0, overdue: 0, rejected: 0 },
      // The new thread's first checkpoint; the run's end takes none.
      checkpoints: { initial: { count: 1 }, terminal: { count: 0 } },
      tornTailsRepaired: 0
    })
    expect(section.debt?.barriers.raised).toBeGreaterThan(0)
    expect(section.threads).not.toBeNull()
  })

  it('leaves each save owing what it wrote, for the thread barrier to pay', async () => {
    const { steps } = await drive(true)

    expect(steps[0].name).toBe('a new thread with its first message')
    expect(firstCheckpoint(steps[0])).toEqual(FIRST_CHECKPOINT_OWED)
    // In any order: a barrier hands the port every file at once, then every directory.
    expect(steps.slice(1).map((step) => [step.name, [...step.paid].sort()])).toEqual([
      [
        'a run starts',
        [
          'directory:.',
          'directory:chat-journal-v2',
          'directory:run-events',
          `file:${JOURNAL}`,
          `file:${EVENTS}`
        ]
      ],
      ['streamed text', [`file:${JOURNAL}`, `file:${EVENTS}`]],
      ['a user message', [`file:${JOURNAL}`]],
      ['an approval opens', [`file:${JOURNAL}`, `file:${EVENTS}`]],
      ['the approval is answered', [`file:${JOURNAL}`, `file:${EVENTS}`]],
      [
        'a tool result whose detail is moved out',
        [
          'directory:.',
          'directory:run-artifacts',
          `directory:run-artifacts/${RUN}`,
          `file:${JOURNAL}`,
          `file:${DETAIL}`,
          `file:${EVENTS}`
        ]
      ],
      ['the run ends', [`file:${JOURNAL}`, `file:${EVENTS}`]]
    ])
  })
})

describe('a torn journal tail', () => {
  it.each([true, false])(
    'with the switch on (%s), is cut before the next append, with the one sync that costs',
    async (switchOn) => {
      if (switchOn) vi.stubEnv('TASKWRAITH_THREAD_BARRIER_DURABILITY', '1')
      const first = await importHostOwnedStore([])
      // The barrier the first process raises before it is cut off pays at once.
      layers.port = { syncFile: async () => 'synced', syncDirectory: async () => 'synced' }
      STEPS[0].act(first.AppStore)
      STEPS[1].act(first.AppStore)
      await first.AppStore.awaitChatRecordPersisted(CHAT)
      const segment = path.join(first.profilePath, JOURNAL)
      // What a power cut can leave of a line written without a sync.
      appendFileSync(segment, `{"chatId":"${CHAT}","baseRev`)

      // The next process to write the thread.
      const second = await importHostOwnedStore([], undefined, { profilePath: first.profilePath })
      const disk = watchCrashDisk(first.profilePath)
      disks.push(disk)
      layers.port = disk.port
      STEPS[2].act(second.AppStore)

      const lines = readFileSync(segment, 'utf8').split('\n').filter(Boolean)
      const whole = lines.filter((line) => {
        try {
          JSON.parse(line)
          return true
        } catch {
          return false
        }
      })
      const journal = second.AppStore.getIncrementalChatPersistenceStats().journal
      expect(second.AppStore.getThreadBarrierDurabilityPerf().tornTailsRepaired).toBe(
        journal.tornTailsTruncated
      )
      if (switchOn) {
        // The cut syncs the segment once, on the calling thread; the append does not.
        expect(disk.issued.map(stable)).toEqual([`file:${JOURNAL}`])
        expect(journal.tornTailsTruncated).toBe(1)
        expect(whole).toEqual(lines)
        expect(lines).toHaveLength(2)
      } else {
        // As before the switch: no cut, and the line is glued to the fragment.
        expect(journal.tornTailsTruncated).toBe(0)
        expect(whole).toHaveLength(1)
        expect(lines).toHaveLength(2)
      }
    }
  )
})

describe('the admitted path, taken before the Host owned the store', () => {
  it('writes tool detail, and the run event that records it, without a sync too', async () => {
    vi.stubEnv('TASKWRAITH_THREAD_BARRIER_DURABILITY', '1')
    const { AppStore, profilePath } = await importHostOwnedStore([], undefined, { gateOpen: true })
    const disk = watchCrashDisk(profilePath)
    disks.push(disk)
    layers.port = disk.port
    STEPS[0].act(AppStore)
    STEPS[1].act(AppStore)
    await layers.built[0].debt.barrier(CHAT)
    disk.issued.length = 0

    STEPS[6].act(AppStore)

    const stores =
      /^(file|directory):(run-artifacts|run-events|chat-journal-v2\/.*\.mutations\.jsonl)/
    expect(disk.issued.filter((entry) => stores.test(entry))).toEqual([])
    disk.paid.length = 0
    await layers.built[0].debt.barrier(CHAT)
    expect([...disk.paid].sort()).toEqual([
      'directory:.',
      'directory:run-artifacts',
      `directory:run-artifacts/${RUN}`,
      `file:${JOURNAL}`,
      `file:${DETAIL}`,
      `file:${EVENTS}`
    ])
  })
})

describe('the tickets each save takes', () => {
  /** Saves after the run, of the two moments the steps above do not reach. */
  const LATER: typeof STEPS = [
    {
      name: "an answer to an agent's question",
      act: (store) => {
        const chat = store.getChat(CHAT)!
        store.saveChat({
          ...chat,
          messages: [
            ...chat.messages,
            {
              id: 'agent-question-reply-q1',
              role: 'user',
              content: 'The second option',
              timestamp: AT,
              metadata: { kind: 'agentQuestionReply', questionId: 'q1' }
            }
          ]
        })
      }
    },
    {
      name: 'rows removed from the transcript',
      act: (store) => {
        const chat = store.getChat(CHAT)!
        store.saveChat(
          { ...chat, messages: chat.messages.slice(0, 2) },
          { removalAskedByUser: true }
        )
      }
    }
  ]

  function noted(layer: ThreadBarrierDurability): Record<ChatDurabilityMoment, number> {
    const { moments } = layer.tickets.snapshot()
    return Object.fromEntries(
      CHAT_DURABILITY_MOMENTS.map((moment) => [moment, moments[moment].noted])
    ) as Record<ChatDurabilityMoment, number>
  }

  async function takenBy(steps: typeof STEPS, options: { gateOpen?: boolean } = {}) {
    vi.stubEnv('TASKWRAITH_THREAD_BARRIER_DURABILITY', '1')
    const { AppStore, profilePath } = await importHostOwnedStore([], undefined, options)
    const disk = watchCrashDisk(profilePath)
    disks.push(disk)
    layers.port = disk.port
    const taken: Array<[string, ChatDurabilityMoment[]]> = []
    /** The barriers each save's tickets raised: urgent ones of the thread alone, and ones of a run. */
    const raised: Array<[string, { urgent: number; threadOnly: number; scoped: number }]> = []
    for (const step of steps) {
      const before = noted(layers.built[0])
      const barriersBefore = layers.built[0].debt.snapshot().barriers
      step.act(AppStore)
      const after = noted(layers.built[0])
      const barriersAfter = layers.built[0].debt.snapshot().barriers
      taken.push([
        step.name,
        CHAT_DURABILITY_MOMENTS.flatMap((moment) =>
          Array<ChatDurabilityMoment>(after[moment] - before[moment]).fill(moment)
        )
      ])
      raised.push([
        step.name,
        {
          urgent: barriersAfter.urgent - barriersBefore.urgent,
          threadOnly: barriersAfter.threadOnly - barriersBefore.threadOnly,
          scoped: barriersAfter.scoped - barriersBefore.scoped
        }
      ])
    }
    return { taken, raised }
  }

  it('takes one for each moment a save contains, and none for anything else', async () => {
    const { taken, raised } = await takenBy([...STEPS, ...LATER])
    expect(taken).toEqual([
      // Its first checkpoint is owed like a line, and it holds the user's message.
      ['a new thread with its first message', ['user_message']],
      ['a run starts', []],
      ['streamed text', []],
      ['a user message', ['user_message']],
      // Lane approvals have no writer in the app: an approval's decision is
      // recorded, and synced, in the approval ledger.
      ['an approval opens', []],
      ['the approval is answered', []],
      ['a tool result whose detail is moved out', []],
      ['the run ends', ['run_final']],
      ["an answer to an agent's question", ['decision']],
      ['rows removed from the transcript', ['destructive']]
    ])
    // What the user sits in goes ahead of other syncs; a run's end pays its own run.
    expect(raised.filter(([, kinds]) => kinds.urgent + kinds.scoped > 0)).toEqual([
      ['a new thread with its first message', { urgent: 1, threadOnly: 1, scoped: 0 }],
      ['a user message', { urgent: 1, threadOnly: 1, scoped: 0 }],
      ['the run ends', { urgent: 0, threadOnly: 0, scoped: 1 }],
      ["an answer to an agent's question", { urgent: 1, threadOnly: 1, scoped: 0 }],
      ['rows removed from the transcript', { urgent: 1, threadOnly: 1, scoped: 0 }]
    ])
  })

  it('takes them on the admitted path too, taken before the Host owned the store', async () => {
    const { taken } = await takenBy([STEPS[0], STEPS[1], STEPS[3], STEPS[7]], { gateOpen: true })
    expect(taken).toEqual([
      // This path writes the new thread's own record first, synced in place: nothing to wait for.
      ['a new thread with its first message', []],
      ['a run starts', []],
      ['a user message', ['user_message']],
      ['the run ends', ['run_final']]
    ])
  })

  it("pays for a user's message the journal alone, and leaves what the streaming run wrote owed", async () => {
    vi.stubEnv('TASKWRAITH_THREAD_BARRIER_DURABILITY', '1')
    const { AppStore, profilePath } = await importHostOwnedStore([])
    const disk = watchCrashDisk(profilePath)
    disks.push(disk)
    layers.port = disk.port
    STEPS[0].act(AppStore)
    STEPS[1].act(AppStore)
    await layers.built[0].debt.barrier(CHAT)
    disk.paid.length = 0

    STEPS[2].act(AppStore)
    STEPS[3].act(AppStore)
    await layers.built[0].tickets.awaitChat(CHAT, ['user_message'])

    expect(disk.paid.map(stable)).toEqual([`file:${JOURNAL}`])
    // The run's streamed event is its own barrier's, or the idle one's.
    expect(layers.built[0].debt.snapshot().owed).toMatchObject({ files: 1, directories: 0 })
  })

  it("pays at a run's end what that run left owed and the thread's journal, and leaves another seat's writes owed", async () => {
    const OTHER = 'run-barrier-b'
    vi.stubEnv('TASKWRAITH_THREAD_BARRIER_DURABILITY', '1')
    const { AppStore, profilePath } = await importHostOwnedStore([])
    const disk = watchCrashDisk(profilePath)
    disks.push(disk)
    layers.port = disk.port
    STEPS[0].act(AppStore)
    const started = AppStore.getChat(CHAT)!
    AppStore.saveChat({
      ...started,
      runs: [RUN, OTHER].map((runId) => ({
        runId,
        startedAt: AT,
        status: 'running',
        provider: 'codex'
      })),
      messages: [
        ...started.messages,
        ...[RUN, OTHER].map((runId) => ({
          id: `reply-${runId}`,
          role: 'assistant' as const,
          content: '',
          timestamp: AT,
          runId
        }))
      ]
    })
    AppStore.appendRunEvent(event('lifecycle', 'Run started'))
    AppStore.appendRunEvent({ ...event('lifecycle', 'Run started'), runId: OTHER })
    await layers.built[0].debt.barrier(CHAT)
    disk.paid.length = 0

    // The first seat's tool result, its detail moved out, and its last event;
    // the other seat streams on.
    STEPS[6].act(AppStore)
    AppStore.appendRunEvent({
      ...event('provider_raw', 'output'),
      runId: OTHER,
      phase: 'raw',
      source: 'provider',
      payload: { data: 'Still going' }
    })
    AppStore.appendRunEvent(event('lifecycle', 'Run completed'))
    const ending = AppStore.getChat(CHAT)!
    AppStore.saveChat({
      ...ending,
      runs: ending.runs.map((run) =>
        run.runId === RUN ? { ...run, status: 'completed', endedAt: AT } : run
      )
    })
    expect(layers.built[0].tickets.snapshot().moments.run_final.noted).toBe(1)
    await layers.built[0].tickets.awaitChat(CHAT)

    // What one finished run owes: the journal segment, the run's event file,
    // and its detail file with the folders made for it.
    expect([...disk.paid.map(stable)].sort()).toEqual([
      'directory:.',
      'directory:run-artifacts',
      `directory:run-artifacts/${RUN}`,
      `file:${JOURNAL}`,
      `file:${DETAIL}`,
      `file:${EVENTS}`
    ])
    // What the other seat streamed is left for its own barrier.
    expect(layers.built[0].debt.snapshot().owed).toMatchObject({ files: 1, directories: 0 })
  })

  it.each([true, false])(
    'lets a user message be reported done only once the disk has it (barrier paid: %s)',
    async (paid) => {
      vi.stubEnv('TASKWRAITH_THREAD_BARRIER_DURABILITY', '1')
      const { AppStore, profilePath } = await importHostOwnedStore([])
      const disk = watchCrashDisk(profilePath)
      disks.push(disk)
      let held: Promise<void> | null = null
      let release = (): void => {}
      layers.port = {
        syncFile: async (target) => (await held, disk.port.syncFile(target)),
        syncDirectory: async (target) => (await held, disk.port.syncDirectory(target))
      }
      STEPS[0].act(AppStore)
      // The Host syncs its copy of a new thread; the test Host only writes it.
      disk.flushedAnyway(path.join(profilePath, 'chats', `${CHAT}.json`))
      disk.flushedAnyway(path.join(profilePath, 'chats'))
      STEPS[1].act(AppStore)
      STEPS[2].act(AppStore)
      await layers.built[0].debt.barrier(CHAT)
      held = new Promise<void>((resolve) => (release = resolve))

      STEPS[3].act(AppStore)
      let reported = false
      const done = layers.built[0].tickets.awaitChat(CHAT).then(() => (reported = true))
      await new Promise((resolve) => setImmediate(resolve))
      expect(reported).toBe(false)
      if (paid) {
        release()
        await done
      }

      disk.powerLoss()
      const loaded = new ThreadCatalogueDiskReader({
        profilePath,
        runtimeInstanceId: 'reader',
        segmented: false
      }).read(CHAT)!.chat
      expect(loaded.messages.some((message) => message.id === 'user-2')).toBe(paid)
      release()
    }
  )
})

describe("the journal's checkpoints, counted by trigger", () => {
  it.each([false, true])(
    'are counted where they are written; with the switch on, a run ends without one (on: %s)',
    async (switchOn) => {
      const { AppStore } = await drive(switchOn)

      const counts = AppStore.getJournalCheckpointCounts()
      const written = Object.entries(counts)
        .filter(([, entry]) => entry.count > 0)
        .map(([trigger, entry]) => [trigger, entry.count, entry.bytes > 0, entry.mainMs >= 0])
      // The new thread's first checkpoint, and with the switch off the terminal
      // one of its small record. With it on, the save that ends the run is an
      // append like any other, and the journal compacts by bytes in its worker.
      expect(written).toEqual([
        ['initial', 1, true, true],
        ...(switchOn ? [] : [['terminal', 1, true, true]])
      ])
    }
  )
})

describe('what pays the debt no moment pays, through the real store', () => {
  /** A thread through its whole run, its writes still owed, and the store holding it. */
  async function owing(options: { gateOpen?: boolean } = {}) {
    vi.stubEnv('TASKWRAITH_THREAD_BARRIER_DURABILITY', '1')
    const { AppStore, profilePath } = await importHostOwnedStore([], undefined, options)
    const disk = watchCrashDisk(profilePath)
    disks.push(disk)
    layers.port = disk.port
    for (const step of STEPS) step.act(AppStore)
    const layer = layers.built[0]
    expect(layer.debt.snapshot().owed.threads).toBe(1)
    return { AppStore, disk, layer }
  }

  it.each(['delete', 'truncate'] as const)(
    "drops an erased thread's debt unpaid on a %s, so no barrier syncs what the erasure removed",
    async (kind) => {
      const { AppStore, disk, layer } = await owing()

      if (kind === 'delete') await AppStore.deleteChatViaHost(CHAT)
      else await AppStore.truncateChatHistoryViaHost(CHAT)

      expect(layer.debt.snapshot().owed.threads).toBe(0)
      expect(layer.snapshot().threads.owing).toBe(0)
      disk.paid.length = 0
      await layer.barrier(CHAT)
      expect(disk.paid).toEqual([])
      // Its tickets were the erased thread's: the erasure covers them, so none is a missing gate.
      expect(layer.tickets.snapshot().moments).toMatchObject({
        user_message: { covered: 2 },
        run_final: { covered: 1 }
      })
      expect(layer.tickets.chatIds()).toEqual([])
    }
  )

  it("drops every thread's debt at a global clear", async () => {
    const { AppStore, disk, layer } = await owing()

    await AppStore.clearChatsViaHost()

    expect(layer.debt.snapshot().owed.threads).toBe(0)
    expect(layer.snapshot().threads.owing).toBe(0)
    expect(layer.tickets.snapshot().moments).toMatchObject({
      user_message: { covered: 2 },
      run_final: { covered: 1 }
    })
    disk.paid.length = 0
    await layer.barrier(CHAT)
    expect(disk.paid).toEqual([])
  })

  it.each(['delete', 'clear'] as const)(
    "drops the debt on the admitted path's %s too, taken before the Host owned the store",
    async (kind) => {
      const { AppStore, layer } = await owing({ gateOpen: true })

      if (kind === 'delete') await AppStore.deleteChat(CHAT)
      else await AppStore.clearChats()

      expect(layer.debt.snapshot().owed.threads).toBe(0)
      expect(layer.snapshot().threads.owing).toBe(0)
      expect(layer.tickets.snapshot().moments.run_final.covered).toBe(1)
    }
  )

  it('stops the idle timer when the store shuts its durability down', async () => {
    const { AppStore } = await owing()
    expect(layers.timers.filter((timer) => !timer.cleared)).toHaveLength(1)

    await AppStore.shutdownMainDurability()

    expect(layers.timers.filter((timer) => !timer.cleared)).toHaveLength(0)
  })

  it.each([false, true])(
    'pays what every thread owes at quit (gate open: %s)',
    async (gateOpen) => {
      const { AppStore, disk, layer } = await owing({ gateOpen })
      disk.paid.length = 0

      await AppStore.flushAllChatSaves({ hostDrainTimeoutMs: 5_000 })

      expect(layer.debt.snapshot().owed.threads).toBe(0)
      expect(layer.snapshot().threads).toMatchObject({ owing: 0, quitThreads: 1, quitUnpaid: 0 })
      expect(disk.paid.map(stable)).toEqual(
        expect.arrayContaining([`file:${EVENTS}`, `file:${DETAIL}`])
      )
    }
  )
})

const TICKET = `file:thread-catalogue-v1/pending/desktop/${CHAT}/<operation>.json.tmp-<uuid>`
const TICKETS = `directory:thread-catalogue-v1/pending/desktop/${CHAT}`
const HEAD = `file:thread-catalogue-v1/desktop/${CHAT}.json.tmp-<uuid>`
const HEADS = 'directory:thread-catalogue-v1/desktop'

/**
 * What each save synced with the catalogue's publisher installed, captured
 * from the store at the commit before the catalogue's seam was wired. With
 * the switch off, nothing may differ.
 */
const SYNCED_WITH_THE_CATALOGUE_BEFORE_THE_SWITCH: Array<[string, string[]]> = [
  [
    'a new thread with its first message',
    [
      'directory:.',
      'directory:thread-catalogue-v1',
      'directory:thread-catalogue-v1/pending',
      'directory:thread-catalogue-v1/pending/desktop',
      TICKET,
      TICKETS,
      'directory:thread-catalogue-v1',
      HEAD,
      HEADS,
      `file:${CHECKPOINT_TEMPORARY}`,
      'directory:chat-journal-v2',
      'directory:chat-journal-v2',
      HEAD,
      HEADS
    ]
  ],
  [
    'a run starts',
    [
      TICKET,
      TICKETS,
      HEAD,
      HEADS,
      `file:${JOURNAL}`,
      'directory:chat-journal-v2',
      `file:${EVENTS}`,
      HEAD,
      HEADS
    ]
  ],
  ['streamed text', [TICKET, TICKETS, HEAD, HEADS, `file:${JOURNAL}`, HEAD, HEADS]],
  ['a user message', [TICKET, TICKETS, HEAD, HEADS, `file:${JOURNAL}`, HEAD, HEADS]],
  ['an approval opens', [TICKET, TICKETS, HEAD, HEADS, `file:${JOURNAL}`, HEAD, HEADS]],
  ['the approval is answered', [TICKET, TICKETS, HEAD, HEADS, `file:${JOURNAL}`, HEAD, HEADS]],
  [
    'a tool result whose detail is moved out',
    [
      TICKET,
      TICKETS,
      HEAD,
      HEADS,
      `file:${DETAIL}`,
      `directory:run-artifacts/${RUN}`,
      `file:${EVENTS}`,
      `file:${JOURNAL}`,
      HEAD,
      HEADS
    ]
  ],
  [
    'the run ends',
    [
      TICKET,
      TICKETS,
      HEAD,
      HEADS,
      `file:${JOURNAL}`,
      `file:${CHECKPOINT_TEMPORARY}`,
      'directory:chat-journal-v2',
      'directory:chat-journal-v2',
      `file:${EVENTS}`,
      HEAD,
      HEADS
    ]
  ]
]

describe("the catalogue's heads and tickets", () => {
  /** A sync's path, with the ticket's operation id taken out too. */
  function stableWithTickets(entry: string): string {
    return stable(entry).replace(
      /(pending\/desktop\/[^/]+\/)[0-9a-f-]{36}\.json/,
      '$1<operation>.json'
    )
  }

  /** The same saves, with the catalogue's publisher installed as the app installs it. */
  async function driveWithCatalogue(switchOn: boolean) {
    if (switchOn) vi.stubEnv('TASKWRAITH_THREAD_BARRIER_DURABILITY', '1')
    const { AppStore, profilePath } = await importHostOwnedStore([])
    AppStore.installThreadCataloguePublisher('test-writer', () => {})
    const disk = watchCrashDisk(profilePath)
    disks.push(disk)
    layers.port = disk.port
    const steps: Array<{ name: string; issued: string[]; paid: string[] }> = []
    for (const step of STEPS) {
      disk.issued.length = 0
      disk.paid.length = 0
      step.act(AppStore)
      await AppStore.drainThreadCataloguePublications()
      const issued = disk.issued.map(stableWithTickets)
      if (layers.built[0]) await layers.built[0].debt.barrier(CHAT)
      steps.push({ name: step.name, issued, paid: disk.paid.map(stableWithTickets) })
    }
    await AppStore.disposeThreadCataloguePublisher()
    return steps
  }

  it('switched off, syncs what each save synced with the catalogue before the switch reached it', async () => {
    const steps = await driveWithCatalogue(false)

    expect(steps.map((step) => [step.name, step.issued])).toEqual(
      SYNCED_WITH_THE_CATALOGUE_BEFORE_THE_SWITCH
    )
    expect(layers.built).toEqual([])
  })

  it('switched on, writes them without a sync: only new directories sync', async () => {
    const steps = await driveWithCatalogue(true)

    expect(steps[0].name).toBe('a new thread with its first message')
    // The catalogue's new folders, and the first checkpoint written without a sync.
    const catalogueFolders = [
      'directory:.',
      'directory:thread-catalogue-v1',
      'directory:thread-catalogue-v1/pending',
      'directory:thread-catalogue-v1/pending/desktop',
      'directory:thread-catalogue-v1'
    ]
    expect(firstCheckpoint(steps[0], catalogueFolders)).toEqual(FIRST_CHECKPOINT_OWED)
    expect(steps.slice(1).map((step) => [step.name, step.issued])).toEqual([
      ['a run starts', []],
      ['streamed text', []],
      ['a user message', []],
      ['an approval opens', []],
      ['the approval is answered', []],
      ['a tool result whose detail is moved out', []],
      ['the run ends', []]
    ])
  })

  it('switched on, owes no barrier anything for them', async () => {
    const steps = await driveWithCatalogue(true)

    expect(
      steps.flatMap((step) => step.paid.filter((entry) => entry.includes('thread-catalogue-v1')))
    ).toEqual([])
  })
})

describe('the dispatch barriers', () => {
  /** A thread with a run, all paid, over a disk the test can hold or make refuse. */
  async function dispatching(switchOn = true) {
    if (switchOn) vi.stubEnv('TASKWRAITH_THREAD_BARRIER_DURABILITY', '1')
    const { AppStore, profilePath } = await importHostOwnedStore([])
    const gates = await import('../run/DurableMomentGate')
    const disk = watchCrashDisk(profilePath)
    disks.push(disk)
    const state = {
      held: null as Promise<void> | null,
      release: () => {},
      refusal: null as Error | null
    }
    const through = async <T>(sync: () => Promise<T>): Promise<T> => {
      await state.held
      if (state.refusal) throw state.refusal
      return sync()
    }
    layers.port = {
      syncFile: (target) => through(() => disk.port.syncFile(target)),
      syncDirectory: (target) => through(() => disk.port.syncDirectory(target))
    }
    STEPS[0].act(AppStore)
    STEPS[1].act(AppStore)
    if (layers.built[0]) await layers.built[0].debt.barrier(CHAT)
    return {
      AppStore,
      gates,
      hold() {
        state.held = new Promise<void>((resolve) => (state.release = resolve))
      },
      release: () => state.release(),
      refuse(error: Error) {
        state.refusal = error
      }
    }
  }

  it.each(['awaitChatRecordDispatchDurable', 'awaitChatRecordPersisted'] as const)(
    "make %s wait for the thread's barrier and the user's message",
    async (barrier) => {
      const { AppStore, gates, hold, release } = await dispatching()
      hold()
      STEPS[3].act(AppStore)

      let done = false
      const waiting = AppStore[barrier](CHAT).then(() => (done = true))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(done).toBe(false)

      release()
      await waiting
      // The new thread's first message and this one.
      expect(layers.built[0].tickets.snapshot().moments.user_message.covered).toBe(2)
      expect(gates.durableMomentGateSnapshot()).toMatchObject({ waits: 1, overdue: 0, rejected: 0 })
    }
  )

  it('let a dispatch go at the bound when the disk hangs, and count it overdue', async () => {
    const { AppStore, gates, hold, release } = await dispatching()
    hold()
    STEPS[3].act(AppStore)

    const started = performance.now()
    await AppStore.awaitChatRecordDispatchDurable(CHAT)

    expect(performance.now() - started).toBeGreaterThanOrEqual(
      gates.DURABLE_MOMENT_GATE_BOUND_MS - 5
    )
    expect(gates.durableMomentGateSnapshot()).toMatchObject({ waits: 1, overdue: 1 })
    expect(layers.built[0].tickets.snapshot().moments.user_message.pending).toBe(1)
    release()
  })

  it('fail a dispatch whose barrier the disk refused, as a journal flush the disk refused does', async () => {
    const { AppStore, gates, refuse } = await dispatching()
    const failure = new Error('EIO: the disk refused')
    refuse(failure)
    STEPS[3].act(AppStore)

    await expect(AppStore.awaitChatRecordDispatchDurable(CHAT)).rejects.toBe(failure)
    expect(gates.durableMomentGateSnapshot()).toMatchObject({ waits: 1, rejected: 1 })
  })

  it("wait for the journal's own syncs with the switch off, with no gate installed", async () => {
    const { AppStore, gates } = await dispatching(false)
    STEPS[3].act(AppStore)

    await expect(AppStore.awaitChatRecordDispatchDurable(CHAT)).resolves.toBeUndefined()
    expect(gates.durableMomentGateSnapshot()).toBeNull()
    expect(layers.built).toEqual([])
  })
})

describe("a new thread's first save", () => {
  const CHECKPOINT = `chat-journal-v2/${CHAT}.checkpoint.json`

  /** The store under the switch, over a disk whose syncs the test can hold. */
  async function creating() {
    vi.stubEnv('TASKWRAITH_THREAD_BARRIER_DURABILITY', '1')
    const { AppStore, profilePath } = await importHostOwnedStore([])
    const gates = await import('../run/DurableMomentGate')
    const disk = watchCrashDisk(profilePath)
    disks.push(disk)
    const state = { held: null as Promise<void> | null, release: () => {} }
    layers.port = {
      syncFile: async (target) => (await state.held, disk.port.syncFile(target)),
      syncDirectory: async (target) => (await state.held, disk.port.syncDirectory(target))
    }
    return {
      AppStore,
      gates,
      disk,
      hold() {
        state.held = new Promise<void>((resolve) => (state.release = resolve))
      },
      release: () => state.release(),
      paid: () => [...disk.paid.map(stable)].sort()
    }
  }

  /** The run dispatch facade the app builds, its provider start recorded. */
  async function dispatchFacade(started: string[]) {
    const { createRunDispatchFacade } = await import('../run/RunDispatchFacade')
    const { ScheduledOccurrenceOwnerRegistry } = await import('../ScheduledOccurrenceOwnerRegistry')
    const dispatch = createRunDispatchFacade({
      applyFailoverReroutePosture: () => {},
      repairKnownStaleGeminiMcpBridgeConfigs: async () => {},
      expandPdfImagePathsForPayload: async () => {},
      captureFailoverSnapshot: () => ({}) as never,
      scheduledOccurrenceOwners: new ScheduledOccurrenceOwnerRegistry(),
      workflowBudgetRegistry: { register: () => {} } as never,
      failoverSnapshotByRun: new Map(),
      runCoordinator: {
        dispatch: async (payload: { appChatId?: string }) => {
          started.push(payload.appChatId ?? '')
          return { dispatched: true, appRunId: 'run-first' }
        }
      } as never,
      reserveDispatch: () => ({}),
      releaseDispatchReservation: () => {},
      getSettings: () => ({ autoFailoverEnabled: false }) as never,
      getScheduledTasks: () => [],
      getWorkflowDefinitions: () => [],
      wasDurableScheduledRunIdObserved: () => false
    })
    return () =>
      dispatch(
        {
          provider: 'codex',
          scope: 'global',
          prompt: 'First question',
          appRunId: 'run-first',
          appChatId: CHAT
        } as never,
        { sender: { id: 'first-save-test' } } as never
      )
  }

  const turn = () => new Promise((resolve) => setImmediate(resolve))

  it("reports the user's first message done, and starts its run, only once its first checkpoint is on the disk", async () => {
    const { AppStore, gates, hold, release, paid } = await creating()
    const started: string[] = []
    const dispatch = await dispatchFacade(started)
    hold()

    STEPS[0].act(AppStore)
    const reply = gates.afterUserMoment(CHAT, { accepted: true })
    expect(reply).toBeInstanceOf(Promise)
    let replied = false
    void (reply as Promise<unknown>).then(() => (replied = true))
    const dispatching = dispatch()
    await turn()
    expect(replied).toBe(false)
    expect(started).toEqual([])

    release()
    await expect(reply).resolves.toEqual({ accepted: true })
    await expect(dispatching).resolves.toMatchObject({ dispatched: true })
    expect(started).toEqual([CHAT])
    expect(paid()).toEqual(['directory:.', 'directory:chat-journal-v2', `file:${CHECKPOINT}`])
    expect(layers.built[0].tickets.snapshot().moments.user_message).toMatchObject({
      noted: 1,
      covered: 1
    })
  })

  it('lets both go at the bound when the disk hangs, and counts the waits overdue', async () => {
    const { AppStore, gates, hold, release } = await creating()
    const started: string[] = []
    const dispatch = await dispatchFacade(started)
    hold()

    STEPS[0].act(AppStore)
    const begun = performance.now()
    await Promise.all([gates.afterUserMoment(CHAT, 'replied'), dispatch()])

    expect(performance.now() - begun).toBeGreaterThanOrEqual(gates.DURABLE_MOMENT_GATE_BOUND_MS - 5)
    expect(started).toEqual([CHAT])
    expect(gates.durableMomentGateSnapshot()).toMatchObject({ waits: 2, overdue: 2 })
    expect(layers.built[0].tickets.snapshot().moments.user_message.pending).toBe(1)
    release()
  })

  const NOT_THE_USERS: Array<[string, (record: ChatRecord) => ChatRecord]> = [
    ['an empty new thread', (record) => ({ ...record, messages: [] })],
    [
      'an imported provider thread',
      (record) => ({
        ...record,
        messages: [
          {
            id: 'import-1',
            role: 'user',
            content: 'An old prompt',
            timestamp: AT,
            metadata: { kind: 'externalProviderThreadImport' }
          },
          {
            id: 'import-2',
            role: 'assistant',
            content: 'An old answer',
            timestamp: AT,
            metadata: { kind: 'externalProviderThreadImport' }
          }
        ]
      })
    ],
    [
      "a sub-thread created with its agent's prompt",
      (record) => ({
        ...record,
        messages: [
          {
            id: 'prompt-1',
            role: 'user',
            content: 'Do the sub-task',
            timestamp: AT,
            metadata: { kind: 'subThreadDelegation' }
          }
        ]
      })
    ],
    [
      'a thread created as a fork, its rows copied',
      (record) => ({
        ...record,
        forkContext: { kind: 'emulated', createdAt: 1, sourceChatId: 'chat-source' }
      })
    ]
  ]

  it.each(NOT_THE_USERS)(
    'takes no ticket for %s, and leaves its first checkpoint to the idle barrier',
    async (_name, shape) => {
      const { AppStore, gates, paid } = await creating()

      AppStore.saveChat(shape(newThread()))

      const layer = layers.built[0]
      expect(layer.tickets.snapshot().moments.user_message.noted).toBe(0)
      expect(gates.awaitUserMoment(CHAT)).toBeNull()
      expect(layer.debt.snapshot().barriers.raised).toBe(0)
      expect(layer.debt.snapshot().owed).toMatchObject({ threads: 1, files: 1, directories: 2 })

      // Fifteen quiet seconds later, the idle barrier pays it.
      layers.clockOffsetMs += 15_000
      layers.timers.filter((timer) => !timer.cleared && timer.ms >= 1_000).forEach((t) => t.fire())
      await vi.waitFor(() => expect(layer.debt.snapshot().owed.threads).toBe(0))
      expect(paid()).toEqual(['directory:.', 'directory:chat-journal-v2', `file:${CHECKPOINT}`])
      expect(layer.snapshot().threads).toMatchObject({ owing: 0, idleBarriers: 1 })
    }
  )

  it("takes no ticket for a fork's copied rows, the user's among them, copied in after it was made empty", async () => {
    const { AppStore, gates } = await creating()
    AppStore.saveChat({ ...newThread(), messages: [] })
    const empty = AppStore.getChat(CHAT)!

    AppStore.saveChat({
      ...empty,
      forkContext: { kind: 'emulated', createdAt: 1, sourceChatId: 'chat-source' },
      messages: [
        { id: 'user-1', role: 'user', content: 'Copied question', timestamp: AT },
        { id: 'reply-1', role: 'assistant', content: 'Copied answer', timestamp: AT }
      ]
    })

    expect(AppStore.getChat(CHAT)!.messages).toHaveLength(2)
    expect(layers.built[0].tickets.snapshot().moments.user_message.noted).toBe(0)
    expect(gates.awaitUserMoment(CHAT)).toBeNull()
  })
})
