/**
 * Barrier durability through the real store: a thread's saves of each kind,
 * with what each one syncs on the calling thread and what it leaves owed.
 */
import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ThreadBarrierDurability } from './ThreadBarrierDurability'
import type { ThreadDurabilityPort } from './ThreadDurabilityDebt'
import type { ChatRecord, RunEventInput } from './types'
import { disposeHostOwnedStores, importHostOwnedStore } from './hostOwnedErasure.testutil'
import { watchCrashDisk, type CrashDisk } from './unsyncedWriteCrashDisk.testutil'

const layers = vi.hoisted(() => ({
  port: null as ThreadDurabilityPort | null,
  built: [] as ThreadBarrierDurability[]
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
        port: {
          syncFile: (target) => layers.port!.syncFile(target),
          syncDirectory: (target) => layers.port!.syncDirectory(target)
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
  return { steps, profilePath }
}

const JOURNAL = `chat-journal-v2/${CHAT}.mutations.jsonl`
const CHECKPOINT_TEMPORARY = `chat-journal-v2/.${CHAT}.checkpoint.json.<pid>.<time>.tmp`
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
})

describe('barrier durability, switched on', () => {
  it('makes no thread store sync on the calling thread: only checkpoints still sync there', async () => {
    const { steps } = await drive(true)

    expect(steps.map((step) => [step.name, step.issued])).toEqual([
      [
        'a new thread with its first message',
        [`file:${CHECKPOINT_TEMPORARY}`, 'directory:chat-journal-v2', 'directory:chat-journal-v2']
      ],
      ['a run starts', []],
      ['streamed text', []],
      ['a user message', []],
      ['an approval opens', []],
      ['the approval is answered', []],
      ['a tool result whose detail is moved out', []],
      ['the run ends', [`file:${CHECKPOINT_TEMPORARY}`, 'directory:chat-journal-v2']]
    ])
    expect(layers.built).toHaveLength(1)
  })

  it('leaves each save owing what it wrote, for the thread barrier to pay', async () => {
    const { steps } = await drive(true)

    // In any order: a barrier hands the port every file at once, then every directory.
    expect(steps.map((step) => [step.name, [...step.paid].sort()])).toEqual([
      ['a new thread with its first message', []],
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
      ['the run ends', ['directory:chat-journal-v2', `file:${EVENTS}`]]
    ])
  })
})

describe('a torn journal tail', () => {
  it.each([true, false])(
    'with the switch on (%s), is cut before the next append, with the one sync that costs',
    async (switchOn) => {
      if (switchOn) vi.stubEnv('TASKWRAITH_THREAD_BARRIER_DURABILITY', '1')
      const first = await importHostOwnedStore([])
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
