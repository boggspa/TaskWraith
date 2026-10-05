/**
 * Barrier durability through the real store: a thread's saves of each kind,
 * with what each one syncs on the calling thread and what it leaves owed.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createHostProjectionSerialQueue } from '../../host-runtime/HostProjectionSerialQueue'
import { createHostBridgeQueuedStartAdapter } from '../host/HostBridgeQueuedStartAdapter'
import {
  createHostBridgeQueuedStartProducer,
  verifyHostBridgeQueuedStartRecord,
  type HostBridgeQueuedStartIdentity
} from '../host/HostBridgeQueuedStartProducer'
import { CHAT_DURABILITY_MOMENTS, type ChatDurabilityMoment } from './ChatDurabilityTickets'
import type { ThreadBarrierDurability } from './ThreadBarrierDurability'
import { ThreadCatalogueDiskReader } from './ThreadCatalogueDiskReader'
import type { ThreadDurabilityPort, ThreadDurabilitySyncOptions } from './ThreadDurabilityDebt'
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
          syncFile: (target, sync) => layers.port!.syncFile(target, sync),
          syncDirectory: (target, sync) => layers.port!.syncDirectory(target, sync)
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

/** Until no batch of staged tool detail is between its commit and its end. */
async function stagingSettled(layer: ThreadBarrierDurability): Promise<void> {
  await vi.waitFor(() => expect(layer.snapshot().staging?.outstanding ?? 0).toBe(0))
}

/** `disk`'s port, listing apart in `background` each sync asked for at background class. */
function listingBackground(disk: CrashDisk, background: string[]): ThreadDurabilityPort {
  const sync =
    (call: 'syncFile' | 'syncDirectory') =>
    (target: string, options?: ThreadDurabilitySyncOptions) => {
      const before = disk.paid.length
      const outcome = disk.port[call](target, options)
      // The disk names a path as it is asked for it, before the sync settles.
      if (options?.background) background.push(...disk.paid.slice(before))
      return outcome
    }
  return { syncFile: sync('syncFile'), syncDirectory: sync('syncDirectory') }
}

/** `all` without one of each entry of `some`. */
function without(all: readonly string[], some: readonly string[]): string[] {
  const left = [...all]
  for (const entry of some) {
    const index = left.indexOf(entry)
    if (index >= 0) left.splice(index, 1)
  }
  return left
}

/** A port that holds every background sync until released; any other goes through at once. */
function holdingBackground(port: ThreadDurabilityPort): {
  port: ThreadDurabilityPort
  release(): void
} {
  let release = (): void => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  return {
    port: {
      syncFile: async (target, options) => {
        if (options?.background) await held
        return port.syncFile(target, options)
      },
      syncDirectory: async (target, options) => {
        if (options?.background) await held
        return port.syncDirectory(target, options)
      }
    },
    release: () => release()
  }
}

/**
 * The steps, each with what it synced on the calling thread, what the
 * staging synced for it in the background, and what the thread's barrier
 * then paid.
 */
async function drive(switchOn: boolean) {
  if (switchOn) vi.stubEnv('TASKWRAITH_THREAD_BARRIER_DURABILITY', '1')
  const { AppStore, profilePath } = await importHostOwnedStore([])
  const disk = watchCrashDisk(profilePath)
  disks.push(disk)
  const background: string[] = []
  layers.port = listingBackground(disk, background)
  const steps: Array<{ name: string; issued: string[]; staged: string[]; paid: string[] }> = []
  for (const step of STEPS) {
    disk.issued.length = 0
    disk.paid.length = 0
    background.length = 0
    step.act(AppStore)
    const issued = disk.issued.map(stable)
    const layer = layers.built[0]
    if (layer) {
      await stagingSettled(layer)
      await layer.debt.barrier(CHAT)
    }
    steps.push({
      name: step.name,
      issued,
      staged: background.map(stable),
      paid: without(disk.paid, background).map(stable)
    })
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

/**
 * What the save that moves a tool result's detail out wrote with the switch
 * off, captured from the store at the commit before tool detail was staged:
 * the detail's bytes, the checkpoint event that records them and the row's
 * reference. With the switch off, nothing may differ.
 */
const DETAIL_BEFORE_THE_STAGING = {
  bytes: 70_267,
  sha256: 'b67b325f6d6a113ca385e5a190f467452402188e3a125d2c716f2a0b161c0ad5',
  checkpoints: [
    {
      kind: 'tool',
      phase: 'artifact',
      source: 'main',
      summary: 'Checkpointed 1 tool activity detail',
      chatId: CHAT,
      runId: RUN,
      payload: {
        type: 'tool_activity_detail_checkpoint',
        schemaVersion: 1,
        generation: 1,
        activityCount: 1,
        offset: 0,
        byteLength: 70_267,
        sha256: 'b67b325f6d6a113ca385e5a190f467452402188e3a125d2c716f2a0b161c0ad5'
      },
      artifacts: [
        {
          id: `${RUN}:tool-activity-detail:0`,
          kind: 'other',
          path: `${RUN}/tool-activity-details.jsonl`,
          sha256: 'b67b325f6d6a113ca385e5a190f467452402188e3a125d2c716f2a0b161c0ad5',
          sizeBytes: 70_267,
          metadata: { offset: 0, activityCount: 1, generation: 1 }
        }
      ]
    }
  ],
  ref: {
    schemaVersion: 1,
    storage: 'run_event_artifact',
    runId: RUN,
    activityId: 'activity-1',
    offset: 0,
    byteLength: 70_267,
    sha256: 'b67b325f6d6a113ca385e5a190f467452402188e3a125d2c716f2a0b161c0ad5'
  }
}

/** The checkpoint events in the run's ledger, without what changes from run to run. */
function detailCheckpoints(profilePath: string): unknown[] {
  if (!existsSync(path.join(profilePath, EVENTS))) return []
  return readFileSync(path.join(profilePath, EVENTS), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((record) => record.payload?.type === 'tool_activity_detail_checkpoint')
    .map(({ kind, phase, source, summary, chatId, runId, payload, artifacts }) => ({
      kind,
      phase,
      source,
      summary,
      chatId,
      runId,
      payload,
      artifacts
    }))
}

describe('barrier durability, switched off', () => {
  it('syncs what each save synced before the switch existed, and builds nothing', async () => {
    const { steps } = await drive(false)

    expect(steps.map((step) => [step.name, step.issued])).toEqual(SYNCED_BEFORE_THE_SWITCH)
    expect(layers.built).toEqual([])
  })

  it("writes a tool result's detail as before the switch: the same bytes, syncs, checkpoint and reference", async () => {
    const { steps, profilePath, AppStore } = await drive(false)

    const detail = readFileSync(path.join(profilePath, DETAIL))
    const row = AppStore.getChat(CHAT)!.messages.find((message) => message.id === 'tool-1')!
    expect({
      bytes: detail.byteLength,
      sha256: createHash('sha256').update(detail).digest('hex'),
      checkpoints: detailCheckpoints(profilePath),
      ref: row.toolActivities![0].detailRef
    }).toEqual(DETAIL_BEFORE_THE_STAGING)
    expect(steps[6]).toMatchObject({
      name: 'a tool result whose detail is moved out',
      issued: [
        `file:${DETAIL}`,
        `directory:run-artifacts/${RUN}`,
        `file:${EVENTS}`,
        `file:${JOURNAL}`
      ]
    })
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
      // The row stays inline until its detail is on the disk, which no barrier pays.
      ['a tool result whose detail is moved out', [`file:${JOURNAL}`]],
      ['the run ends', [`file:${JOURNAL}`, `file:${EVENTS}`]]
    ])
  })

  it("stages a tool result's detail, synced in the background, and no barrier pays any of it", async () => {
    const { steps } = await drive(true)
    const layer = layers.built[0]

    // The segment, every folder on the path to it, then its checkpoint's ledger.
    expect(steps.map((step) => [step.name, step.staged])).toEqual([
      ['a new thread with its first message', []],
      ['a run starts', []],
      ['streamed text', []],
      ['a user message', []],
      ['an approval opens', []],
      ['the approval is answered', []],
      [
        'a tool result whose detail is moved out',
        [
          `file:${DETAIL}`,
          `directory:run-artifacts/${RUN}`,
          'directory:run-artifacts',
          'directory:.',
          `file:${EVENTS}`
        ]
      ],
      ['the run ends', []]
    ])
    // Neither a user's barrier nor the run's final one paid any detail.
    expect(steps.flatMap((step) => step.paid).filter((entry) => entry.includes(DETAIL))).toEqual([])
    expect(layer.debt.snapshot().owners.detail).toMatchObject({ noted: 0, synced: 0 })
    // Staged at the tool result, its ref taken when the run ended.
    expect(layer.snapshot().staging).toMatchObject({
      outstanding: 0,
      batches: { committed: 1, durable: 1, failed: 0, dropped: 0 },
      rows: { staged: 1, swapped: 1 },
      syncs: { files: 2, directories: 3 },
      checkpointEvents: 1
    })
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
  it('stages tool detail too: no sync on the calling thread, and none of it owed to the thread', async () => {
    vi.stubEnv('TASKWRAITH_THREAD_BARRIER_DURABILITY', '1')
    const { AppStore, profilePath } = await importHostOwnedStore([], undefined, { gateOpen: true })
    const disk = watchCrashDisk(profilePath)
    disks.push(disk)
    const background: string[] = []
    layers.port = listingBackground(disk, background)
    STEPS[0].act(AppStore)
    STEPS[1].act(AppStore)
    await layers.built[0].debt.barrier(CHAT)
    disk.issued.length = 0
    disk.paid.length = 0

    STEPS[6].act(AppStore)

    const stores =
      /^(file|directory):(run-artifacts|run-events|chat-journal-v2\/.*\.mutations\.jsonl)/
    expect(disk.issued.filter((entry) => stores.test(entry))).toEqual([])
    await stagingSettled(layers.built[0])
    expect(background).toEqual([
      `file:${DETAIL}`,
      `directory:run-artifacts/${RUN}`,
      'directory:run-artifacts',
      'directory:.',
      `file:${EVENTS}`
    ])
    await layers.built[0].debt.barrier(CHAT)
    expect(without(disk.paid, background)).toEqual([`file:${JOURNAL}`])
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
    const background: string[] = []
    layers.port = listingBackground(disk, background)
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

    // The first seat's tool result, its detail staged, and its last event;
    // the other seat streams on.
    STEPS[6].act(AppStore)
    await stagingSettled(layers.built[0])
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

    // What one finished run owes: the journal segment and the run's event
    // file. Its detail was staged and synced in the background, never owed.
    expect(without(disk.paid, background).map(stable).sort()).toEqual([
      `file:${JOURNAL}`,
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
      expect(disk.paid.map(stable)).toEqual(expect.arrayContaining([`file:${EVENTS}`]))
      // The run's detail was never the thread's to pay.
      expect(disk.paid.map(stable)).not.toContain(`file:${DETAIL}`)
    }
  )
})

describe('tool detail staged under the switch, through the real store', () => {
  /** A thread whose run has started, all paid, its background syncs held until released. */
  async function staging() {
    vi.stubEnv('TASKWRAITH_THREAD_BARRIER_DURABILITY', '1')
    const { AppStore, profilePath } = await importHostOwnedStore([])
    const disk = watchCrashDisk(profilePath)
    disks.push(disk)
    const held = holdingBackground(disk.port)
    layers.port = held.port
    STEPS[0].act(AppStore)
    STEPS[1].act(AppStore)
    const layer = layers.built[0]
    await layer.debt.barrier(CHAT)
    disk.paid.length = 0
    return { AppStore, profilePath, disk, layer, release: held.release }
  }

  it("lets a user's barrier settle while the detail waits in the background, and pays none of it", async () => {
    const { AppStore, disk, layer, release } = await staging()

    STEPS[6].act(AppStore)
    STEPS[3].act(AppStore)
    await layer.tickets.awaitChat(CHAT, ['user_message'])

    expect(layer.snapshot().staging).toMatchObject({ outstanding: 1 })
    expect(disk.paid.map(stable)).toEqual([`file:${JOURNAL}`])
    release()
    await stagingSettled(layer)
    expect(layer.snapshot().staging).toMatchObject({ batches: { durable: 1 } })
    expect(layer.debt.snapshot().owners.detail).toMatchObject({ noted: 0, synced: 0 })
  })

  it("appends no checkpoint to an erased run's ledger when the thread is erased during a batch", async () => {
    const { AppStore, profilePath, layer, release } = await staging()
    STEPS[6].act(AppStore)
    expect(layer.snapshot().staging).toMatchObject({ outstanding: 1 })

    await AppStore.deleteChatViaHost(CHAT)
    release()
    await stagingSettled(layer)

    expect(existsSync(path.join(profilePath, EVENTS))).toBe(false)
    expect(existsSync(path.join(profilePath, 'run-artifacts', RUN))).toBe(false)
    // The erasure dropped the thread's batch: it ended at its next step.
    expect(layer.snapshot().staging).toMatchObject({
      batches: { committed: 1, durable: 0, failed: 0, dropped: 1 },
      checkpointEvents: 0
    })
  })

  it("appends no checkpoint to a run's ledger that a deletion being prepared during the batch froze", async () => {
    const { AppStore, profilePath, layer, release } = await staging()
    STEPS[6].act(AppStore)

    AppStore.prepareHistoryDeletion({ kind: 'chat', rootChatId: CHAT })
    release()
    await stagingSettled(layer)

    expect(detailCheckpoints(profilePath)).toEqual([])
    expect(layer.snapshot().staging).toMatchObject({
      batches: { committed: 1, durable: 0, failed: 1 },
      checkpointEvents: 0
    })
  })

  it('writes nothing into the folder of a run whose thread was erased, for a late save of it', async () => {
    const { AppStore, profilePath, layer, release } = await staging()
    const before = AppStore.getChat(CHAT)!
    await AppStore.deleteChatViaHost(CHAT)
    release()
    expect(existsSync(path.join(profilePath, 'run-artifacts', RUN))).toBe(false)

    // A writer still holding the thread saves its tool result after the erasure.
    STEPS[6].act({
      getChat: () => before,
      saveChat: (record: ChatRecord) => AppStore.saveChat(record)
    } as unknown as Store)

    expect(existsSync(path.join(profilePath, 'run-artifacts', RUN))).toBe(false)
    expect(layer.snapshot().staging).toMatchObject({
      batches: { committed: 0 },
      rows: { staged: 0, passedOver: 0 }
    })
  })

  it('quits without waiting for a batch still syncing, and the batch ends with nothing referenced', async () => {
    const { AppStore, profilePath, layer, release } = await staging()
    STEPS[6].act(AppStore)

    await AppStore.flushAllChatSaves({ hostDrainTimeoutMs: 5_000 })

    expect(layer.snapshot().threads).toMatchObject({ quitThreads: 1, quitUnpaid: 0 })
    expect(layer.snapshot().staging).toMatchObject({ outstanding: 1 })
    release()
    await stagingSettled(layer)
    expect(layer.snapshot().staging).toMatchObject({
      batches: { durable: 0, dropped: 1 },
      checkpointEvents: 0
    })
    expect(detailCheckpoints(profilePath)).toEqual([])
  })

  it.each([
    'TASKWRAITH_JOURNAL_FLUSHER',
    'TASKWRAITH_RUN_EVENT_FLUSHER',
    'TASKWRAITH_CATALOGUE_DEFERRED_DURABILITY'
  ])('is never built while %s is on, which may keep run events in the flusher', async (flusher) => {
    vi.stubEnv('TASKWRAITH_THREAD_BARRIER_DURABILITY', '1')
    vi.stubEnv(flusher, '1')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { AppStore } = await importHostOwnedStore([])

      expect(layers.built).toEqual([])
      expect(AppStore.getThreadBarrierDurabilityPerf()).toMatchObject({
        enabled: false,
        ignored: `${flusher} on`
      })
    } finally {
      warn.mockRestore()
    }
  })
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

  it('switched on, writes them and their new directories without a sync', async () => {
    const steps = await driveWithCatalogue(true)

    expect(steps[0].name).toBe('a new thread with its first message')
    // Rebuildable catalogue names need no sync; the first checkpoint remains owed.
    expect(firstCheckpoint(steps[0], [])).toEqual(FIRST_CHECKPOINT_OWED)
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
      refusal: null as Error | null,
      asked: 0
    }
    const through = async <T>(sync: () => Promise<T>): Promise<T> => {
      state.asked += 1
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
      },
      /** The syncs the layer has asked for. */
      asked: () => state.asked
    }
  }

  it.each(['awaitChatRecordDispatchDurable', 'awaitChatRecordPersisted'] as const)(
    "make %s wait for the user's message, on its save's barrier and none of their own",
    async (barrier) => {
      const { AppStore, gates, hold, release } = await dispatching()
      const urgent = () => layers.built[0].debt.snapshot().barriers.urgent
      const before = urgent()
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
      // One urgent barrier in all: the save's.
      expect(urgent() - before).toBe(1)
    }
  )

  it.each(['awaitChatRecordDispatchDurable', 'awaitChatRecordPersisted'] as const)(
    'make %s raise no barrier and ask for no sync on a thread owing only what streaming wrote',
    async (barrier) => {
      const { AppStore, gates, hold, release, asked } = await dispatching()
      const layer = layers.built[0]
      // The new thread's message is paid and told: nothing of the user's is left.
      await layer.tickets.awaitChat(CHAT)
      STEPS[2].act(AppStore)
      hold()
      const before = { barriers: layer.debt.snapshot().barriers, asked: asked() }
      expect(layer.debt.snapshot().owed.files).toBeGreaterThan(0)

      let done = false
      const waiting = AppStore[barrier](CHAT).then(() => (done = true))
      // Done while the disk is held: nothing was asked of it.
      await vi.waitFor(() => expect(done).toBe(true), { timeout: 500 })
      await waiting

      expect(layer.debt.snapshot().barriers).toEqual(before.barriers)
      expect(asked()).toBe(before.asked)
      expect(layer.debt.snapshot().owed.files).toBeGreaterThan(0)
      // Nothing to wait for is no wait.
      expect(gates.durableMomentGateSnapshot()).toMatchObject({ waits: 0, overdue: 0 })
      release()
    }
  )

  it("lets a dispatch go past a run's final record still syncing, which is not the user's", async () => {
    const { AppStore, gates, hold, release, asked } = await dispatching()
    const layer = layers.built[0]
    await layer.tickets.awaitChat(CHAT)
    hold()
    STEPS[7].act(AppStore)
    expect(layer.tickets.snapshot().moments.run_final.pending).toBe(1)
    const before = { barriers: layer.debt.snapshot().barriers, asked: asked() }

    let done = false
    const waiting = AppStore.awaitChatRecordDispatchDurable(CHAT).then(() => (done = true))
    await vi.waitFor(() => expect(done).toBe(true), { timeout: 500 })
    await waiting

    expect(layer.debt.snapshot().barriers).toEqual(before.barriers)
    expect(asked()).toBe(before.asked)
    expect(gates.durableMomentGateSnapshot()).toMatchObject({ waits: 0 })
    release()
  })

  it("lets a dispatch go at once with nothing of the user's pending", async () => {
    const { AppStore, hold } = await dispatching()
    await layers.built[0].tickets.awaitChat(CHAT)
    STEPS[2].act(AppStore)
    hold()

    let done = false
    void AppStore.awaitChatRecordDispatchDurable(CHAT).then(() => (done = true))
    await Promise.resolve()

    expect(done).toBe(true)
  })

  const GRANT = {
    id: 'runtime-dispatch-1',
    provider: 'codex' as const,
    path: '/Users/someone/elsewhere',
    kind: 'directory' as const,
    access: 'read' as const,
    duration: 'thisThread' as const,
    createdAt: AT
  }

  it.each([
    [
      "an answer to an agent's question",
      (chat: ChatRecord): ChatRecord => ({
        ...chat,
        messages: [
          ...chat.messages,
          {
            id: 'agent-question-reply-q2',
            role: 'user',
            content: 'The first option',
            timestamp: AT,
            metadata: { kind: 'agentQuestionReply', questionId: 'q2' }
          }
        ]
      })
    ],
    [
      'a path an approval grants',
      (chat: ChatRecord): ChatRecord => ({
        ...chat,
        providerMetadata: { ...chat.providerMetadata, externalPathGrants: [GRANT] }
      })
    ]
  ])(
    'tell the agent of %s once its own barrier is paid, as before, and a dispatch then waits for it',
    async (_decision, decide) => {
      const { AppStore, gates, hold, release } = await dispatching()
      const layer = layers.built[0]
      await layer.tickets.awaitChat(CHAT)
      const before = layer.debt.snapshot().barriers
      hold()
      AppStore.saveChat(decide(AppStore.getChat(CHAT)!))

      // Where the agent is told of the decision.
      const told = gates.awaitUserMoment(CHAT)
      expect(told).not.toBeNull()
      const settled = { told: false, dispatched: false }
      void told!.then(() => (settled.told = true))
      const dispatched = AppStore.awaitChatRecordDispatchDurable(CHAT).then(
        () => (settled.dispatched = true)
      )
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(settled).toEqual({ told: false, dispatched: false })

      release()
      await Promise.all([told, dispatched])
      expect(layer.tickets.snapshot().moments.decision).toMatchObject({ noted: 1, covered: 1 })
      // One urgent barrier in all: the decision's.
      expect(layer.debt.snapshot().barriers).toMatchObject({
        raised: before.raised + 1,
        urgent: before.urgent + 1
      })
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

  const QUEUED: HostBridgeQueuedStartIdentity = {
    hostCommandActionId: 'host:command:22222222-2222-4222-8222-222222222222',
    threadId: CHAT,
    runId: 'run-queued-b2',
    promptMessageId: 'user-queued-2',
    provider: 'codex'
  }

  /**
   * A prompt queued from the phone, its ticket paid, then its run row in a save
   * of its own, as the Host bridge saves them; and the producer wired as the
   * app wires it, its adapter invoked.
   */
  async function queuedStart(store: Store, hold: () => void, asked: () => number) {
    const chat = store.getChat(CHAT)!
    store.saveChat({
      ...chat,
      messages: [
        ...chat.messages,
        {
          id: QUEUED.promptMessageId,
          role: 'user',
          content: 'Queued from the phone',
          timestamp: AT
        }
      ]
    })
    await layers.built[0].tickets.awaitChat(CHAT)
    hold()
    const prompted = store.getChat(CHAT)!
    store.saveChat({
      ...prompted,
      runs: [
        ...prompted.runs,
        {
          runId: QUEUED.runId,
          provider: 'codex',
          startedAt: AT,
          promptMessageId: QUEUED.promptMessageId,
          status: 'running'
        }
      ]
    })
    expect(verifyHostBridgeQueuedStartRecord(store.getChat(CHAT), QUEUED)).toBe(true)
    const producer = createHostBridgeQueuedStartProducer({
      persistenceEnabled: () => true,
      awaitPromptAndStartDurable: ({ threadId }) => store.awaitChatRecordStartDurable(threadId),
      verifyPromptAndStart: (identity) =>
        verifyHostBridgeQueuedStartRecord(store.getChat(identity.threadId), identity)
    })
    const adapter = createHostBridgeQueuedStartAdapter({
      runProjectionOperation: createHostProjectionSerialQueue()
    })
    const prepared = vi.spyOn(adapter, 'prepared')
    producer.onAdapter(adapter, vi.fn())
    const askedBeforeTheClaim = asked()
    adapter.register({
      hostCommandActionId: QUEUED.hostCommandActionId,
      threadId: CHAT,
      authority: {
        actorId: 'actor-a',
        clientId: 'client-a',
        clientClass: 'desktop',
        commandFingerprint: 'fingerprint-a'
      }
    })
    producer
      .observeDispatch(QUEUED)!
      .observer.onAdapterInvoked?.({ provider: 'codex', appRunId: QUEUED.runId })
    return {
      prepared,
      askedBeforeTheClaim,
      async drain() {
        producer.beginShutdown()
        await producer.drain()
        await adapter.drain()
      }
    }
  }

  it("make a queued start claim its run row durable only once a normal barrier has synced the row's line", async () => {
    const { AppStore, hold, release, asked } = await dispatching()
    const layer = layers.built[0]
    const before = layer.debt.snapshot().barriers

    const start = await queuedStart(AppStore, hold, asked)
    // The run row's line, asked of the held disk, and no claim yet.
    await vi.waitFor(() => expect(asked()).toBeGreaterThan(start.askedBeforeTheClaim), {
      timeout: 500
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(start.prepared).not.toHaveBeenCalled()
    // The prompt's urgent barrier, and the start's: of the thread's own debt, not urgent.
    expect(layer.debt.snapshot().barriers).toMatchObject({
      raised: before.raised + 2,
      urgent: before.urgent + 1,
      threadOnly: before.threadOnly + 2
    })

    release()
    await vi.waitFor(() => expect(start.prepared).toHaveBeenCalledOnce(), { timeout: 2_000 })
    expect(start.prepared.mock.calls[0][0]).toMatchObject({
      durablePromptAndStartPersisted: true,
      start: { kind: 'solo', runId: QUEUED.runId }
    })
    expect(AppStore.getThreadBarrierDurabilityPerf().starts).toMatchObject({
      waits: 1,
      overdue: 0,
      rejected: 0
    })
    await start.drain()
  })

  it('let a queued start claim at the bound when the disk hangs, and count it overdue', async () => {
    const { AppStore, gates, hold, release, asked } = await dispatching()

    const start = await queuedStart(AppStore, hold, asked)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(start.prepared).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(start.prepared).toHaveBeenCalledOnce(), {
      timeout: gates.DURABLE_MOMENT_GATE_BOUND_MS + 1_000
    })

    expect(AppStore.getThreadBarrierDurabilityPerf().starts).toMatchObject({
      waits: 1,
      overdue: 1
    })
    // Apart from the waits the user sits in.
    expect(gates.durableMomentGateSnapshot()).toMatchObject({ overdue: 0 })
    release()
    await start.drain()
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
