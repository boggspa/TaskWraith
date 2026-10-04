/**
 * Fixed inputs for the thread-log goldens, and the one function that turns an
 * implementation's answers into the recorded shape.
 *
 * The recorded answers live in `threadLogGoldens.json`. They were captured from
 * the apply and batch-validation code as it stood in `src/main/store` before it
 * moved here, at the blobs that file names under `capturedFrom`. To reproduce
 * the capture, put those two blobs back and run the store's golden test: it
 * passes unchanged. This file therefore stays free of both implementations: it
 * holds plain data and imports neither side.
 */

import { readFileSync } from 'node:fs'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type JsonObject = { [key: string]: Json }

/** What is being recorded: the old exports, or the module that replaced them. */
export interface ThreadLogGoldenSubject {
  applyOne(source: never, batch: never): unknown
  applyMany(source: never, batches: never): unknown
  validBatch(value: unknown, chatId: string): boolean
}

export interface ThreadLogApplyCase {
  name: string
  /** `one` goes through the single-batch entry point, `many` through the chain. */
  entry: 'one' | 'many'
  source: unknown
  batches: unknown
}

export interface ThreadLogValidationCase {
  name: string
  value: unknown
  chatId: string
}

/**
 * `inputsUnchanged` is read after every object in the returned record has been
 * written to, so it also says the result shares nothing with what went in.
 */
export type ThreadLogApplyOutcome =
  | { returned: unknown; inputsUnchanged: boolean }
  /** An engine error's wording varies with the JavaScript engine, so only its name is kept. */
  | { threw: { name: string; message: string | null }; inputsUnchanged: boolean }

export interface ThreadLogGoldens {
  apply: Record<string, ThreadLogApplyOutcome>
  validation: Record<string, boolean>
}

const CHAT_ID = 'chat-golden'
const FORMAT = 'taskwraith-chat-mutation'
const AT = '2026-10-04T00:00:00.000Z'

function activity(id: string, resultSummary: string): JsonObject {
  return {
    id,
    toolName: 'exec_command',
    displayName: 'Run command',
    category: 'shell',
    status: 'success',
    parameters: { command: 'npm test', cwd: '/workspace' },
    resultSummary
  }
}

function message(id: string, role: string, content: string, extra: JsonObject = {}): JsonObject {
  return { id, role, content, timestamp: AT, ...extra }
}

function run(runId: string, status: string): JsonObject {
  return { runId, startedAt: AT, status }
}

function seat(id: string, order: number): JsonObject {
  return { id, provider: 'codex', enabled: true, role: `Seat ${order}`, order, instructions: '' }
}

function record(overrides: JsonObject = {}): JsonObject {
  return {
    appChatId: CHAT_ID,
    title: 'Golden chat',
    createdAt: 1,
    updatedAt: 10,
    archived: false,
    workspaceId: 'workspace-1',
    providerMetadata: { nested: { kept: true }, list: [1, 2, 3] },
    persistenceRevision: 10,
    messages: [
      message('m1', 'user', 'first question'),
      message('m2', 'assistant', 'partial answer', {
        runId: 'r1',
        toolActivities: [activity('a1', 'started'), activity('a2', 'queued')]
      }),
      message('m3', 'tool', '')
    ],
    runs: [run('r0', 'success'), run('r1', 'running')],
    ensemble: {
      enabled: true,
      maxParticipants: 2,
      maxContinuationHops: 6,
      participants: [seat('s1', 1), seat('s2', 2)]
    },
    ...overrides
  }
}

function withoutField(field: string): JsonObject {
  const { [field]: _dropped, ...rest } = record()
  return rest
}

function batch(operations: unknown, overrides: Record<string, unknown> = {}): unknown {
  return {
    format: FORMAT,
    version: 1,
    chatId: CHAT_ID,
    baseRevision: 10,
    revision: 11,
    savedAt: AT,
    operations,
    ...overrides
  }
}

const one = (
  name: string,
  operations: unknown,
  source: unknown = record(),
  header: Record<string, unknown> = {}
): ThreadLogApplyCase => ({ name, entry: 'one', source, batches: batch(operations, header) })

/** Every operation type applied on its own, in the shapes a derived batch uses. */
const OPERATION_CASES: ThreadLogApplyCase[] = [
  one('record_patch sets nested values and clears a field', [
    {
      type: 'record_patch',
      set: { title: 'Renamed', providerMetadata: { nested: { kept: false } }, archived: true },
      clear: ['workspaceId', 'neverPresent']
    }
  ]),
  one('messages_splice inserts in the middle', [
    {
      type: 'messages_splice',
      index: 1,
      deleteCount: 0,
      messages: [message('m1b', 'assistant', 'inserted € \u{1f600}')]
    }
  ]),
  one('messages_splice replaces a range', [
    {
      type: 'messages_splice',
      index: 1,
      deleteCount: 2,
      messages: [message('m4', 'assistant', 'replacement'), message('m5', 'user', 'follow-up')]
    }
  ]),
  one('messages_splice appends at the end', [
    { type: 'messages_splice', index: 3, deleteCount: 0, messages: [message('m4', 'user', 'tail')] }
  ]),
  one('messages_splice removes every row', [
    { type: 'messages_splice', index: 0, deleteCount: 3, messages: [] }
  ]),
  one('message_content_append extends streamed text', [
    { type: 'message_content_append', messageId: 'm2', content: ', then more café 日本' }
  ]),
  one('message_put replaces one row whole', [
    {
      type: 'message_put',
      messageId: 'm2',
      message: message('m2', 'assistant', 'rewritten', { toolActivities: [] })
    }
  ]),
  one('message_patch sets and clears fields, content included', [
    {
      type: 'message_patch',
      messageId: 'm2',
      set: { content: 'edited', metadata: { kind: 'subThreadReturn' } },
      clear: ['runId', 'neverPresent']
    }
  ]),
  one('tool_activities_presence adds an empty list', [
    { type: 'tool_activities_presence', messageId: 'm3', present: true }
  ]),
  one('tool_activities_presence keeps an existing list', [
    { type: 'tool_activities_presence', messageId: 'm2', present: true }
  ]),
  one('tool_activities_presence removes the list', [
    { type: 'tool_activities_presence', messageId: 'm2', present: false }
  ]),
  one('tool_activities_splice replaces within an existing list', [
    {
      type: 'tool_activities_splice',
      messageId: 'm2',
      index: 1,
      deleteCount: 1,
      activities: [activity('a3', 'new'), activity('a4', 'newer')]
    }
  ]),
  one('tool_activities_splice creates the list on a row without one', [
    {
      type: 'tool_activities_splice',
      messageId: 'm3',
      index: 0,
      deleteCount: 0,
      activities: [activity('a9', 'first')]
    }
  ]),
  one('tool_activity_put replaces one activity', [
    {
      type: 'tool_activity_put',
      messageId: 'm2',
      activityId: 'a1',
      activity: activity('a1', 'finished')
    }
  ]),
  one('runs_splice inserts and removes', [
    {
      type: 'runs_splice',
      index: 0,
      deleteCount: 1,
      runs: [run('r2', 'queued'), run('r3', 'queued')]
    }
  ]),
  one('run_put replaces one run', [{ type: 'run_put', runId: 'r1', run: run('r1', 'success') }]),
  one('ensemble_patch sets and clears chrome', [
    {
      type: 'ensemble_patch',
      set: { maxContinuationHops: 12, orchestrationMode: 'parallel' },
      clear: ['maxParticipants']
    }
  ]),
  one('ensemble_participant_patch sets and clears a seat field', [
    {
      type: 'ensemble_participant_patch',
      participantId: 's2',
      set: { linkedProviderSessionId: 'session-2', role: 'Reviewer' },
      clear: ['instructions']
    }
  ]),
  one('several operations apply in the order written', [
    { type: 'record_patch', set: { updatedAt: 11 }, clear: [] },
    {
      type: 'messages_splice',
      index: 3,
      deleteCount: 0,
      messages: [message('m4', 'assistant', 'streaming')]
    },
    { type: 'message_content_append', messageId: 'm4', content: ' on' },
    { type: 'tool_activities_presence', messageId: 'm4', present: true },
    {
      type: 'tool_activities_splice',
      messageId: 'm4',
      index: 0,
      deleteCount: 0,
      activities: [activity('b1', 'started')]
    },
    {
      type: 'tool_activity_put',
      messageId: 'm4',
      activityId: 'b1',
      activity: activity('b1', 'finished')
    },
    { type: 'message_patch', messageId: 'm4', set: { runId: 'r1' }, clear: [] },
    { type: 'run_put', runId: 'r1', run: run('r1', 'success') },
    { type: 'runs_splice', index: 2, deleteCount: 0, runs: [run('r2', 'running')] },
    { type: 'ensemble_patch', set: { enabled: false }, clear: [] },
    { type: 'ensemble_participant_patch', participantId: 's1', set: { enabled: false }, clear: [] },
    { type: 'message_put', messageId: 'm1', message: message('m1', 'user', 'edited question') }
  ]),
  one('a batch with no operations only advances the revision', []),
  one(
    'a record with no revision is treated as revision zero',
    [{ type: 'record_patch', set: { title: 'From zero' }, clear: [] }],
    withoutField('persistenceRevision'),
    { baseRevision: 0, revision: 1 }
  )
]

const reject = (
  name: string,
  operations: unknown,
  source: unknown = record()
): ThreadLogApplyCase => one(`rejects ${name}`, operations, source)

/** Everything the apply code refuses, by batch header and then by operation. */
const REJECTION_CASES: ThreadLogApplyCase[] = [
  {
    name: 'rejects an unknown batch format',
    entry: 'one',
    source: record(),
    batches: batch([], { format: 'someone-elses-format' })
  },
  {
    name: 'rejects an unknown batch version',
    entry: 'one',
    source: record(),
    batches: batch([], { version: 2 })
  },
  {
    name: 'rejects a batch for another chat',
    entry: 'one',
    source: record(),
    batches: batch([], { chatId: 'other-chat' })
  },
  {
    name: 'rejects a base revision behind the record',
    entry: 'one',
    source: record(),
    batches: batch([], { baseRevision: 9, revision: 11 })
  },
  {
    name: 'rejects a base revision ahead of the record',
    entry: 'one',
    source: record(),
    batches: batch([], { baseRevision: 11, revision: 12 })
  },
  {
    name: 'rejects a revision that does not advance',
    entry: 'one',
    source: record(),
    batches: batch([], { baseRevision: 10, revision: 10 })
  },
  {
    name: 'rejects a base revision against a record whose revision is not a safe integer',
    entry: 'one',
    source: record({ persistenceRevision: 10.5 }),
    batches: batch([])
  },
  ...['appChatId', 'messages', 'runs', 'persistenceRevision'].flatMap((field) => [
    reject(`record_patch setting the protected field ${field}`, [
      { type: 'record_patch', set: { [field]: 'x' }, clear: [] }
    ]),
    reject(`record_patch clearing the protected field ${field}`, [
      { type: 'record_patch', set: {}, clear: [field] }
    ])
  ]),
  reject('messages_splice starting past the end', [
    { type: 'messages_splice', index: 4, deleteCount: 0, messages: [] }
  ]),
  reject('messages_splice deleting past the end', [
    { type: 'messages_splice', index: 2, deleteCount: 2, messages: [] }
  ]),
  reject('messages_splice with a negative index', [
    { type: 'messages_splice', index: -1, deleteCount: 0, messages: [] }
  ]),
  reject('messages_splice with a fractional count', [
    { type: 'messages_splice', index: 0, deleteCount: 0.5, messages: [] }
  ]),
  reject('messages_splice with no bounds at all', [{ type: 'messages_splice', messages: [] }]),
  reject('message_content_append to a missing row', [
    { type: 'message_content_append', messageId: 'absent', content: 'x' }
  ]),
  reject('message_put for a missing row', [
    { type: 'message_put', messageId: 'absent', message: message('absent', 'user', 'x') }
  ]),
  reject('message_put whose row carries another id', [
    { type: 'message_put', messageId: 'm2', message: message('m9', 'user', 'x') }
  ]),
  reject('message_patch on a missing row', [
    { type: 'message_patch', messageId: 'absent', set: {}, clear: [] }
  ]),
  reject('message_patch setting the id', [
    { type: 'message_patch', messageId: 'm2', set: { id: 'm9' }, clear: [] }
  ]),
  reject('message_patch setting toolActivities', [
    { type: 'message_patch', messageId: 'm2', set: { toolActivities: [] }, clear: [] }
  ]),
  reject('message_patch clearing the id', [
    { type: 'message_patch', messageId: 'm2', set: {}, clear: ['id'] }
  ]),
  reject('message_patch clearing toolActivities', [
    { type: 'message_patch', messageId: 'm2', set: {}, clear: ['toolActivities'] }
  ]),
  reject('tool_activities_presence on a missing row', [
    { type: 'tool_activities_presence', messageId: 'absent', present: true }
  ]),
  reject('tool_activities_splice past the end', [
    { type: 'tool_activities_splice', messageId: 'm2', index: 3, deleteCount: 0, activities: [] }
  ]),
  reject('tool_activities_splice on a missing row', [
    {
      type: 'tool_activities_splice',
      messageId: 'absent',
      index: 0,
      deleteCount: 0,
      activities: []
    }
  ]),
  reject('tool_activity_put for a missing activity', [
    {
      type: 'tool_activity_put',
      messageId: 'm2',
      activityId: 'absent',
      activity: activity('absent', 'x')
    }
  ]),
  reject('tool_activity_put on a row with no activities', [
    { type: 'tool_activity_put', messageId: 'm3', activityId: 'a1', activity: activity('a1', 'x') }
  ]),
  reject('runs_splice past the end', [{ type: 'runs_splice', index: 3, deleteCount: 0, runs: [] }]),
  reject('run_put for a missing run', [
    { type: 'run_put', runId: 'absent', run: run('absent', 'x') }
  ]),
  reject(
    'ensemble_patch on a record with no ensemble',
    [{ type: 'ensemble_patch', set: { enabled: false }, clear: [] }],
    withoutField('ensemble')
  ),
  reject('ensemble_patch setting the roster', [
    { type: 'ensemble_patch', set: { participants: [] }, clear: [] }
  ]),
  reject('ensemble_patch clearing the roster', [
    { type: 'ensemble_patch', set: {}, clear: ['participants'] }
  ]),
  reject('ensemble_participant_patch for a missing seat', [
    { type: 'ensemble_participant_patch', participantId: 'absent', set: {}, clear: [] }
  ]),
  reject(
    'ensemble_participant_patch on a record with no ensemble',
    [{ type: 'ensemble_participant_patch', participantId: 's1', set: {}, clear: [] }],
    withoutField('ensemble')
  ),
  reject('ensemble_participant_patch setting the seat id', [
    { type: 'ensemble_participant_patch', participantId: 's1', set: { id: 's9' }, clear: [] }
  ]),
  reject('ensemble_participant_patch clearing the seat id', [
    { type: 'ensemble_participant_patch', participantId: 's1', set: {}, clear: ['id'] }
  ]),
  reject('an operation type outside the vocabulary', [{ type: 'future_operation', payload: 1 }]),
  reject('a later operation after earlier ones already applied', [
    { type: 'record_patch', set: { title: 'Never seen' }, clear: [] },
    { type: 'message_content_append', messageId: 'absent', content: 'x' }
  ])
]

/**
 * Operations that pass batch validation (only `type` is checked) but lack the
 * fields the apply code reads. What happens to each is part of the contract a
 * move must not change, however odd.
 */
const MALFORMED_CASES: ThreadLogApplyCase[] = [
  one('malformed: record_patch with no set', [{ type: 'record_patch', clear: [] }]),
  one('malformed: record_patch with no clear', [{ type: 'record_patch', set: {} }]),
  one('malformed: messages_splice with no messages', [
    { type: 'messages_splice', index: 0, deleteCount: 0 }
  ]),
  one('malformed: message_content_append with no content', [
    { type: 'message_content_append', messageId: 'm2' }
  ]),
  one('malformed: message_put with no message', [{ type: 'message_put', messageId: 'm2' }]),
  one('malformed: message_patch with no clear', [
    { type: 'message_patch', messageId: 'm2', set: { content: 'kept?' } }
  ]),
  one('malformed: tool_activities_presence with no flag', [
    { type: 'tool_activities_presence', messageId: 'm2' }
  ]),
  one('malformed: tool_activities_splice with no activities', [
    { type: 'tool_activities_splice', messageId: 'm2', index: 0, deleteCount: 0 }
  ]),
  one('malformed: tool_activity_put with no activity', [
    { type: 'tool_activity_put', messageId: 'm2', activityId: 'a1' }
  ]),
  one('malformed: runs_splice with no runs', [{ type: 'runs_splice', index: 0, deleteCount: 0 }]),
  one('malformed: run_put with no run', [{ type: 'run_put', runId: 'r1' }]),
  one('malformed: ensemble_patch with a null set', [
    { type: 'ensemble_patch', set: null, clear: [] }
  ]),
  one('malformed: ensemble_participant_patch with no clear', [
    { type: 'ensemble_participant_patch', participantId: 's1', set: { role: 'kept?' } }
  ]),
  one('malformed: a null operation', [null]),
  one('malformed: operations that are not a list', { type: 'record_patch' })
]

/** Chains through the multi-batch entry point. */
const CHAIN_CASES: ThreadLogApplyCase[] = [
  {
    name: 'an empty chain returns a copy of the record',
    entry: 'many',
    source: record(),
    batches: []
  },
  {
    name: 'a chain applies each batch on the revision the last one produced',
    entry: 'many',
    source: record(),
    batches: [
      batch([{ type: 'message_content_append', messageId: 'm2', content: ' one' }]),
      batch([{ type: 'message_content_append', messageId: 'm2', content: ' two' }], {
        baseRevision: 11,
        revision: 14
      }),
      batch([{ type: 'run_put', runId: 'r1', run: run('r1', 'success') }], {
        baseRevision: 14,
        revision: 15
      })
    ]
  },
  {
    name: 'rejects a chain with a gap between two batches',
    entry: 'many',
    source: record(),
    batches: [
      batch([{ type: 'message_content_append', messageId: 'm2', content: ' one' }]),
      batch([{ type: 'message_content_append', messageId: 'm2', content: ' two' }], {
        baseRevision: 12,
        revision: 13
      })
    ]
  },
  {
    name: 'rejects a chain that repeats a batch',
    entry: 'many',
    source: record(),
    batches: [
      batch([{ type: 'message_content_append', messageId: 'm2', content: ' one' }]),
      batch([{ type: 'message_content_append', messageId: 'm2', content: ' one' }])
    ]
  },
  {
    name: 'rejects a chain whose second batch has a refused operation',
    entry: 'many',
    source: record(),
    batches: [
      batch([{ type: 'record_patch', set: { title: 'Applied then discarded' }, clear: [] }]),
      batch([{ type: 'run_put', runId: 'absent', run: run('absent', 'x') }], {
        baseRevision: 11,
        revision: 12
      })
    ]
  },
  {
    name: 'rejects a chain whose second batch is for another chat',
    entry: 'many',
    source: record(),
    batches: [batch([]), batch([], { chatId: 'other-chat', baseRevision: 11, revision: 12 })]
  }
]

/** Deterministic generator: the same seed always yields the same sequence. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), state | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A long chain of valid batches drawn from all twelve operation types. Only the
 * identities are tracked here, enough to keep every operation applicable; what
 * the record looks like afterwards is for the code under test to say.
 */
function seededChain(seed: number, batchCount: number): ThreadLogApplyCase {
  const random = mulberry32(seed)
  const pick = (count: number): number => Math.floor(random() * count)
  const messages: Array<{ id: string; activities: string[] | null }> = [
    { id: 'm1', activities: null },
    { id: 'm2', activities: ['a1', 'a2'] },
    { id: 'm3', activities: null }
  ]
  const runs = ['r0', 'r1']
  const seats = ['s1', 's2']
  let nextId = 0
  const fresh = (prefix: string): string => `${prefix}-${seed}-${(nextId += 1)}`
  const operation = (): unknown => {
    const kind = messages.length === 0 ? 1 : pick(12)
    const row = messages.length === 0 ? null : messages[pick(messages.length)]
    switch (kind) {
      case 0:
        return {
          type: 'record_patch',
          set: { title: `Title ${pick(1000)}`, updatedAt: pick(1_000_000) },
          clear: pick(2) === 0 ? ['workspaceId'] : []
        }
      case 1: {
        const index = pick(messages.length + 1)
        const deleteCount = pick(Math.min(2, messages.length - index) + 1)
        const inserted = Array.from({ length: pick(3) }, () => fresh('m'))
        messages.splice(index, deleteCount, ...inserted.map((id) => ({ id, activities: null })))
        return {
          type: 'messages_splice',
          index,
          deleteCount,
          messages: inserted.map((id) => message(id, pick(2) === 0 ? 'user' : 'assistant', id))
        }
      }
      case 2:
        return { type: 'message_content_append', messageId: row!.id, content: ` +${pick(100)}` }
      case 3:
        row!.activities = null
        return {
          type: 'message_put',
          messageId: row!.id,
          message: message(row!.id, 'assistant', `put ${pick(100)}`)
        }
      case 4:
        return {
          type: 'message_patch',
          messageId: row!.id,
          set: pick(2) === 0 ? { content: `patched ${pick(100)}` } : { runId: runs[0] ?? 'none' },
          clear: pick(3) === 0 ? ['runId'] : []
        }
      case 5: {
        const present = pick(2) === 0
        if (!present) row!.activities = null
        else row!.activities ??= []
        return { type: 'tool_activities_presence', messageId: row!.id, present }
      }
      case 6: {
        const existing = row!.activities ?? []
        const index = pick(existing.length + 1)
        const deleteCount = pick(Math.min(2, existing.length - index) + 1)
        const inserted = Array.from({ length: pick(3) }, () => fresh('a'))
        existing.splice(index, deleteCount, ...inserted)
        row!.activities = existing
        return {
          type: 'tool_activities_splice',
          messageId: row!.id,
          index,
          deleteCount,
          activities: inserted.map((id) => activity(id, 'spliced'))
        }
      }
      case 7: {
        const owner = messages.find((candidate) => candidate.activities?.length)
        if (!owner) return { type: 'message_content_append', messageId: row!.id, content: '.' }
        const activityId = owner.activities![pick(owner.activities!.length)]
        return {
          type: 'tool_activity_put',
          messageId: owner.id,
          activityId,
          activity: activity(activityId, `put ${pick(100)}`)
        }
      }
      case 8: {
        const index = pick(runs.length + 1)
        const deleteCount = pick(Math.min(1, runs.length - index) + 1)
        const inserted = Array.from({ length: pick(2) + (runs.length <= 1 ? 1 : 0) }, () =>
          fresh('r')
        )
        runs.splice(index, deleteCount, ...inserted)
        return {
          type: 'runs_splice',
          index,
          deleteCount,
          runs: inserted.map((id) => run(id, 'running'))
        }
      }
      case 9: {
        if (runs.length === 0) return { type: 'record_patch', set: { archived: true }, clear: [] }
        const runId = runs[pick(runs.length)]
        return { type: 'run_put', runId, run: run(runId, pick(2) === 0 ? 'success' : 'error') }
      }
      case 10:
        return {
          type: 'ensemble_patch',
          set: { maxContinuationHops: pick(20) },
          clear: pick(4) === 0 ? ['orchestrationMode'] : []
        }
      default:
        return {
          type: 'ensemble_participant_patch',
          participantId: seats[pick(seats.length)],
          set: { role: `Role ${pick(50)}`, enabled: pick(2) === 0 },
          clear: pick(4) === 0 ? ['model'] : []
        }
    }
  }
  const batches: unknown[] = []
  let revision = 10
  for (let index = 0; index < batchCount; index += 1) {
    const operations = Array.from({ length: 1 + pick(4) }, operation)
    // Revisions may skip, as a coalesced save does, but never repeat.
    const next = revision + 1 + pick(3)
    batches.push(batch(operations, { baseRevision: revision, revision: next }))
    revision = next
  }
  return {
    name: `seeded chain ${seed}: ${batchCount} batches over all twelve operations`,
    entry: 'many',
    source: record(),
    batches
  }
}

export const THREAD_LOG_APPLY_CASES: readonly ThreadLogApplyCase[] = [
  ...OPERATION_CASES,
  ...REJECTION_CASES,
  ...MALFORMED_CASES,
  ...CHAIN_CASES,
  seededChain(20261004, 120),
  seededChain(7, 60)
]

/** The twelve operation types of the journal vocabulary, in declaration order. */
export const THREAD_LOG_OPERATION_TYPE_NAMES = [
  'record_patch',
  'messages_splice',
  'message_content_append',
  'message_put',
  'message_patch',
  'tool_activities_presence',
  'tool_activities_splice',
  'tool_activity_put',
  'runs_splice',
  'run_put',
  'ensemble_patch',
  'ensemble_participant_patch'
] as const

const valid = (name: string, value: unknown, chatId = CHAT_ID): ThreadLogValidationCase => ({
  name,
  value,
  chatId
})

export const THREAD_LOG_VALIDATION_CASES: readonly ThreadLogValidationCase[] = [
  ...THREAD_LOG_OPERATION_TYPE_NAMES.map((type) =>
    valid(`a batch holding only a ${type} operation`, batch([{ type }]))
  ),
  valid(
    'a batch holding all twelve operation types',
    batch(THREAD_LOG_OPERATION_TYPE_NAMES.map((type) => ({ type })))
  ),
  valid('a batch with no operations', batch([])),
  valid('a batch with extra fields', batch([], { author: 'someone', sequence: 4 })),
  valid('a batch based on revision zero', batch([], { baseRevision: 0, revision: 1 })),
  valid('a batch that skips revisions', batch([], { baseRevision: 10, revision: 99 })),
  valid('a batch with an empty savedAt', batch([], { savedAt: '' })),
  valid('a batch read for another chat', batch([]), 'other-chat'),
  valid('a batch naming another chat', batch([], { chatId: 'other-chat' })),
  valid('a batch with no chat id', batch([], { chatId: undefined })),
  valid('null', null),
  valid('undefined', undefined),
  valid('a string', JSON.stringify(batch([]))),
  valid('a number', 11),
  valid('an array', [batch([])]),
  valid('an empty object', {}),
  valid('another format', batch([], { format: 'someone-elses-format' })),
  valid('no format', batch([], { format: undefined })),
  valid('another version', batch([], { version: 2 })),
  valid('a version given as text', batch([], { version: '1' })),
  valid('a negative base revision', batch([], { baseRevision: -1, revision: 1 })),
  valid('a fractional base revision', batch([], { baseRevision: 10.5, revision: 11 })),
  valid('a base revision given as text', batch([], { baseRevision: '10', revision: 11 })),
  valid('a base revision that is not a number', batch([], { baseRevision: Number.NaN })),
  valid('no base revision', batch([], { baseRevision: undefined })),
  valid('a revision equal to its base', batch([], { baseRevision: 10, revision: 10 })),
  valid('a revision behind its base', batch([], { baseRevision: 10, revision: 9 })),
  valid('a fractional revision', batch([], { revision: 11.5 })),
  valid('a revision past the safe integers', batch([], { revision: Number.MAX_SAFE_INTEGER + 1 })),
  valid('an infinite revision', batch([], { revision: Number.POSITIVE_INFINITY })),
  valid('no revision', batch([], { revision: undefined })),
  valid('no savedAt', batch([], { savedAt: undefined })),
  valid('a numeric savedAt', batch([], { savedAt: 1_759_536_000_000 })),
  valid('no operations', batch(undefined)),
  valid('operations given as an object', batch({ 0: { type: 'record_patch' }, length: 1 })),
  valid('operations given as text', batch('record_patch')),
  valid('a null operation', batch([null])),
  valid('a text operation', batch(['record_patch'])),
  valid('an operation with no type', batch([{ set: {}, clear: [] }])),
  valid('an operation type outside the vocabulary', batch([{ type: 'future_operation' }])),
  valid('an operation type differing only in case', batch([{ type: 'Record_Patch' }])),
  // Names every object inherits must not pass for vocabulary.
  ...['constructor', 'toString', 'hasOwnProperty', '__proto__'].map((type) =>
    valid(`an operation typed ${type}`, batch([{ type }]))
  ),
  valid(
    'one unknown operation among known ones',
    batch([{ type: 'record_patch' }, { type: 'future_operation' }, { type: 'run_put' }])
  )
]

function clone<T>(value: T): T {
  return structuredClone(value)
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Write to every object and array reachable from a value. */
function scribble(value: unknown): void {
  if (!value || typeof value !== 'object') return
  for (const child of Object.values(value)) scribble(child)
  if (Array.isArray(value)) value.push('scribbled')
  else (value as Record<string, unknown>).scribbled = true
}

/** The answers recorded from the code before it moved. */
export function loadThreadLogGoldens(): ThreadLogGoldens {
  const file = JSON.parse(
    readFileSync(new URL('./threadLogGoldens.json', import.meta.url), 'utf8')
  ) as ThreadLogGoldens
  return { apply: file.apply, validation: file.validation }
}

/** How often each operation type occurs across the batches of one apply case. */
export function operationTypeCounts(testCase: ThreadLogApplyCase): Record<string, number> {
  const counts: Record<string, number> = {}
  const batches = (
    Array.isArray(testCase.batches) ? testCase.batches : [testCase.batches]
  ) as Array<{ operations: Array<{ type: string }> }>
  for (const { operations } of batches) {
    for (const { type } of operations) counts[type] = (counts[type] ?? 0) + 1
  }
  return counts
}

/** Ask one implementation every question and record its answers. */
export function captureThreadLogGoldens(subject: ThreadLogGoldenSubject): ThreadLogGoldens {
  const apply: ThreadLogGoldens['apply'] = {}
  for (const testCase of THREAD_LOG_APPLY_CASES) {
    if (testCase.name in apply) throw new Error(`Duplicate apply case: ${testCase.name}`)
    const source = clone(testCase.source)
    const batches = clone(testCase.batches)
    let outcome: { returned: unknown } | { threw: { name: string; message: string | null } }
    try {
      const returned =
        testCase.entry === 'one'
          ? subject.applyOne(source as never, batches as never)
          : subject.applyMany(source as never, batches as never)
      // Through JSON, as the journal stores it: an undefined slot becomes null.
      outcome = { returned: JSON.parse(JSON.stringify(returned)) as unknown }
      scribble(returned)
    } catch (error) {
      const failure = error as Error
      outcome = {
        threw: {
          name: failure.name,
          message: failure.name === 'Error' ? failure.message : null
        }
      }
    }
    apply[testCase.name] = {
      ...outcome,
      inputsUnchanged: sameJson(source, testCase.source) && sameJson(batches, testCase.batches)
    }
  }
  const validation: ThreadLogGoldens['validation'] = {}
  for (const testCase of THREAD_LOG_VALIDATION_CASES) {
    if (testCase.name in validation) throw new Error(`Duplicate validation case: ${testCase.name}`)
    validation[testCase.name] = subject.validBatch(clone(testCase.value), testCase.chatId)
  }
  return { apply, validation }
}
