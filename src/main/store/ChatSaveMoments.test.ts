/**
 * Which moments one save contains, read from the batch the app really derives
 * for it (or authors, for the transcript edits main and the renderer author),
 * never from operations written by hand.
 */
import { describe, expect, it } from 'vitest'

import { classifyChatSaveMoments, type ChatSaveMoment } from './ChatSaveMoments'
import { deriveChatRecordMutationWithProjection } from './ChatRecordMutation'
import { ChatTranscriptMutationIndex } from './ChatTranscriptMutationAuthoring'
import type { FlushReason } from './saveCoalescer'
import type { ChatMessage, ChatRecord, ChatRun } from './types'

const AT = '2026-10-05T00:00:00.000Z'

function message(
  id: string,
  role: ChatMessage['role'],
  content: string,
  metadata?: ChatMessage['metadata']
): ChatMessage {
  return { id, role, content, timestamp: AT, ...(metadata ? { metadata } : {}) }
}

function run(runId: string, status: string, extra: Partial<ChatRun> = {}): ChatRun {
  return { runId, startedAt: AT, status, provider: 'codex', ...extra }
}

function thread(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-moments',
    scope: 'global',
    chatKind: 'single',
    provider: 'codex',
    title: 'Moments',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    persistenceRevision: 4,
    messages: [
      message('user-1', 'user', 'First question'),
      message('reply-1', 'assistant', 'An answer')
    ],
    runs: [run('run-1', 'completed')],
    ...overrides
  }
}

function advanced(previous: ChatRecord, next: ChatRecord): ChatRecord {
  return { ...next, persistenceRevision: previous.persistenceRevision! + 1 }
}

/** One save from `previous` to what `change` makes of it, through the derivation the store runs. */
function save(
  previous: ChatRecord,
  change: (record: ChatRecord) => ChatRecord,
  flushReason: FlushReason = 'normal'
): ChatSaveMoment[] {
  const next = advanced(previous, change(previous))
  const { batch, transcriptOps } = deriveChatRecordMutationWithProjection(previous, next)
  return classifyChatSaveMoments({
    previous,
    next,
    operations: batch.operations,
    transcriptOps,
    flushReason
  })
}

/** One save whose transcript edit is authored, as `mutate-chat-transcript` and main's run flushes author theirs. */
function authoredSave(
  previous: ChatRecord,
  author: (
    transaction: ReturnType<ChatTranscriptMutationIndex['begin']>,
    rows: ChatMessage[]
  ) => void
): ChatSaveMoment[] {
  const transaction = new ChatTranscriptMutationIndex(
    previous.messages,
    previous.persistenceRevision
  ).begin()
  const rows = previous.messages.slice()
  author(transaction, rows)
  const next = advanced(previous, { ...previous, messages: rows })
  const { batch, transcriptOps } = deriveChatRecordMutationWithProjection(previous, next, {
    authoredTranscript: transaction.finish()
  })
  return classifyChatSaveMoments({
    previous,
    next,
    operations: batch.operations,
    transcriptOps,
    flushReason: 'normal'
  })
}

const appended =
  (...rows: ChatMessage[]) =>
  (record: ChatRecord): ChatRecord => ({ ...record, messages: [...record.messages, ...rows] })

const USER_MESSAGE: ChatSaveMoment[] = [{ moment: 'user_message' }]
const DECISION: ChatSaveMoment[] = [{ moment: 'decision' }]
const DESTRUCTIVE: ChatSaveMoment[] = [{ moment: 'destructive' }]

describe('the moments of one save', () => {
  it.each<[string, (record: ChatRecord) => ChatRecord, ChatSaveMoment[]]>([
    [
      'a message the user sent from the composer',
      appended(message('user-2', 'user', 'Next question')),
      USER_MESSAGE
    ],
    [
      'a steer while a run streams',
      appended(message('steer-1', 'user', 'Look at the tests too', { kind: 'midRunSteering' })),
      USER_MESSAGE
    ],
    [
      "the user's prompt to an ensemble round",
      appended(
        message('ensemble-user-round-2', 'user', 'Both of you, review this', {
          kind: 'ensembleRoundPrompt',
          ensembleRoundId: 'round-2'
        })
      ),
      USER_MESSAGE
    ],
    [
      'a message sent from the phone or the command line',
      appended(
        message('ios-user-1', 'user', 'From the socket', {
          origin: { channel: 'local-control', pid: 4242, label: 'Claude Code' }
        })
      ),
      USER_MESSAGE
    ],
    [
      "an answer to an agent's question",
      appended(
        message('agent-question-reply-q1', 'user', 'Use the second option', {
          kind: 'agentQuestionReply',
          questionId: 'q1'
        })
      ),
      DECISION
    ],
    [
      'streamed text',
      (record) => ({
        ...record,
        messages: record.messages.map((row) =>
          row.id === 'reply-1' ? { ...row, content: `${row.content} and more` } : row
        )
      }),
      []
    ],
    [
      'a run that starts',
      (record) => ({
        ...appended(message('reply-2', 'assistant', ''))(record),
        runs: [...record.runs, run('run-2', 'running')]
      }),
      []
    ],
    [
      'a finished run written again with another finished status',
      (record) => ({
        ...record,
        runs: record.runs.map((row) => ({ ...row, status: 'failed' }))
      }),
      []
    ],
    [
      "an agent's prompt to a sub-thread",
      appended(
        message('subthread-prompt-1', 'user', 'Do the sub-task', { kind: 'subThreadDelegation' })
      ),
      []
    ],
    [
      "an execution graph stage's prompt",
      appended(message('graph-prompt-1', 'user', 'Stage two', { kind: 'executionGraphAttempt' })),
      []
    ],
    [
      "a collaborator's comment",
      appended(
        message('comment-1', 'user', 'Looks good to me', { kind: 'humanCollaboratorComment' })
      ),
      []
    ],
    [
      'external text arriving as a steer',
      appended(
        message('steer-2', 'user', 'From outside', {
          kind: 'midRunSteering',
          sourceTrust: 'external_untrusted'
        })
      ),
      []
    ],
    [
      'an external contribution carried in a user row',
      appended(
        message('contribution-1', 'user', '<external_contribution>text</external_contribution>')
      ),
      []
    ],
    [
      'a row from a retired external channel',
      appended(message('inbound-1', 'user', 'Hello', { kind: 'channelInbound' })),
      []
    ],
    [
      "a provider thread's imported rows",
      appended(message('import-1', 'user', 'Old prompt', { kind: 'externalProviderThreadImport' })),
      []
    ],
    [
      'rows removed from the transcript',
      (record) => ({ ...record, messages: record.messages.slice(0, 1) }),
      DESTRUCTIVE
    ],
    [
      'the same rows in another order',
      (record) => ({ ...record, messages: [record.messages[1], record.messages[0]] }),
      []
    ]
  ])('%s', (_name, change, expected) => {
    expect(save(thread(), change)).toEqual(expected)
  })

  it('reads a run reaching a status that is not live as its final record, with its id', () => {
    const live = thread({ runs: [run('run-1', 'completed'), run('run-2', 'running')] })

    expect(
      save(live, (record) => ({
        ...record,
        runs: record.runs.map((row) =>
          row.runId === 'run-2' ? { ...row, status: 'completed', endedAt: AT } : row
        )
      }))
    ).toEqual([{ moment: 'run_final', runId: 'run-2' }])
  })

  it('reads a run recorded already finished as its final record', () => {
    expect(
      save(thread(), (record) => ({ ...record, runs: [...record.runs, run('run-2', 'failed')] }))
    ).toEqual([{ moment: 'run_final', runId: 'run-2' }])
  })

  it('reads finished runs moved in the list as nothing, and a new finished run among them as final', () => {
    const previous = thread({ runs: [run('run-1', 'completed'), run('run-2', 'failed')] })

    expect(
      save(previous, (record) => ({
        ...record,
        runs: [run('run-0', 'cancelled'), record.runs[1], record.runs[0]]
      }))
    ).toEqual([{ moment: 'run_final', runId: 'run-0' }])
  })

  it('does not read a finished run written again as another final record', () => {
    expect(
      save(thread(), (record) => ({
        ...record,
        runs: record.runs.map((row) => ({ ...row, endedAt: AT, historyCompactionGeneration: 3 }))
      }))
    ).toEqual([])
  })

  it('reads every save of the deletion flush as destructive, whatever its batch holds', () => {
    expect(
      save(thread(), (record) => ({ ...record, title: 'Renamed' }), 'history-deletion')
    ).toEqual(DESTRUCTIVE)
  })

  it('reads an edit and resend, as the renderer authors it, as a message and a removal', () => {
    const previous = thread({
      messages: [
        message('user-1', 'user', 'First question'),
        message('reply-1', 'assistant', 'An answer'),
        message('user-2', 'user', 'Second question'),
        message('reply-2', 'assistant', 'Another answer')
      ]
    })

    expect(
      authoredSave(previous, (transaction, rows) => {
        const edited = { ...rows[2], content: 'Second question, rephrased' }
        transaction.update(edited)
        rows[2] = edited
        transaction.splice(3, 1, ['reply-2'], [])
        rows.splice(3, 1)
      })
    ).toEqual([{ moment: 'user_message' }, { moment: 'destructive' }])
  })

  it('reads an edit the store derives instead of taking it as authored as a message too', () => {
    const previous = thread({
      messages: [
        message('user-1', 'user', 'First question'),
        message('reply-1', 'assistant', 'An answer'),
        message('user-2', 'user', 'Second question')
      ]
    })
    const rephrase = (content: string) => (record: ChatRecord) => ({
      ...record,
      messages: record.messages.map((row) => (row.id === 'user-2' ? { ...row, content } : row))
    })

    expect(save(previous, rephrase('Second question, with more'))).toEqual(USER_MESSAGE)
    expect(save(previous, rephrase('A different question'))).toEqual(USER_MESSAGE)
    expect(
      save(previous, (record) => ({
        ...rephrase('A different question')(record),
        messages: rephrase('A different question')(record).messages.filter(
          (row) => row.id !== 'reply-1'
        )
      }))
    ).toEqual([{ moment: 'user_message' }, { moment: 'destructive' }])
  })

  it("does not read a change to a user row's metadata as a message", () => {
    expect(
      save(thread(), (record) => ({
        ...record,
        messages: record.messages.map((row) =>
          row.role === 'user' ? { ...row, metadata: { subThreadTitle: 'Renamed' } } : row
        )
      }))
    ).toEqual([])
  })

  it('follows positions through several splices of one authored batch', () => {
    const previous = thread({
      messages: [
        message('user-1', 'user', 'First question'),
        message('reply-1', 'assistant', 'An answer'),
        message('tool-1', 'tool', ''),
        message('reply-2', 'assistant', 'More'),
        message('user-2', 'user', 'Second question')
      ]
    })

    // Two rows taken out and put back at the end: nothing is removed or new.
    expect(
      authoredSave(previous, (transaction, rows) => {
        const [tool] = rows.splice(2, 1)
        transaction.splice(2, 1, ['tool-1'], [])
        const [question] = rows.splice(3, 1)
        transaction.splice(3, 1, ['user-2'], [])
        rows.push(tool, question)
        transaction.append([tool, question])
      })
    ).toEqual([])
    // A stale row of a run removed, as an ensemble flush does, and its new rows added.
    expect(
      authoredSave(previous, (transaction, rows) => {
        rows.splice(2, 1)
        transaction.splice(2, 1, ['tool-1'], [])
        const added = [message('reply-3', 'assistant', 'Done')]
        rows.push(...added)
        transaction.append(added)
      })
    ).toEqual(DESTRUCTIVE)
  })

  it('reads a path granted or revoked as a decision', () => {
    const grant = {
      id: 'runtime-1',
      provider: 'codex' as const,
      path: '/Users/someone/elsewhere',
      kind: 'directory' as const,
      access: 'read' as const,
      duration: 'thisThread' as const,
      createdAt: AT
    }
    const granted = thread({ providerMetadata: { externalPathGrants: [grant] } })

    expect(save(thread(), () => granted)).toEqual(DECISION)
    expect(save(granted, () => thread({ providerMetadata: {} }))).toEqual(DECISION)
    expect(
      save(granted, (record) => ({
        ...record,
        providerMetadata: { ...record.providerMetadata, providerThreadId: 'thread-2' }
      }))
    ).toEqual([])
  })

  it('reads a proposed plan approved or dismissed as a decision', () => {
    const plan = { title: 'The plan', body: 'Step one, step two', status: 'pending' as const }
    const proposed = thread({
      messages: [
        message('user-1', 'user', 'Plan it'),
        message('plan-1', 'assistant', 'Here is a plan', { proposedPlan: plan })
      ]
    })
    const decide = (status: 'approved' | 'dismissed') => (record: ChatRecord) => ({
      ...record,
      messages: record.messages.map((row) =>
        row.id === 'plan-1' ? { ...row, metadata: { proposedPlan: { ...plan, status } } } : row
      )
    })

    expect(save(proposed, decide('dismissed'))).toEqual(DECISION)
    expect(
      save(proposed, (record) =>
        appended(message('user-2', 'user', 'Implement the plan'))(decide('approved')(record))
      )
    ).toEqual([{ moment: 'user_message' }, { moment: 'decision' }])
  })

  it('reads a prompt queued for an ensemble round as a message', () => {
    const round = (entries: string[]) =>
      ({
        enabled: true,
        maxParticipants: 2,
        participants: [],
        activeRound: {
          roundId: 'round-1',
          status: 'running',
          startedAt: AT,
          participants: [],
          queuedPrompts: entries,
          queuedPromptEntries: entries.map((prompt, index) => ({
            persistenceVersion: 1,
            id: `ensemble-queued-chat-moments-${index + 1}`,
            prompt
          }))
        }
      }) as unknown as ChatRecord['ensemble']
    const running = thread({ chatKind: 'ensemble', ensemble: round(['First']) })

    expect(
      save(running, (record) => ({ ...record, ensemble: round(['First', 'Second']) }))
    ).toEqual(USER_MESSAGE)
    expect(
      save(running, (record) => ({
        ...record,
        ensemble: {
          ...record.ensemble!,
          activeRound: { ...record.ensemble!.activeRound!, status: 'completed' }
        }
      }))
    ).toEqual([])
  })

  it('on a thread of 30 seats, reads one seat ending while 29 stream as that one final record', () => {
    const seats = Array.from({ length: 30 }, (_, index) => `seat-${index}`)
    const previous = thread({
      chatKind: 'ensemble',
      messages: [
        message('user-1', 'user', 'All of you'),
        ...seats.map((seat) => ({
          ...message(`reply-${seat}`, 'assistant', 'Working'),
          runId: `run-${seat}`
        }))
      ],
      runs: [
        ...Array.from({ length: 200 }, (_, index) => run(`run-old-${index}`, 'completed')),
        ...seats.map((seat) => run(`run-${seat}`, 'running', { stats: { tokens: 1 } }))
      ]
    })

    expect(
      save(previous, (record) => ({
        ...record,
        messages: record.messages.map((row) =>
          row.role === 'assistant' ? { ...row, content: `${row.content}, still` } : row
        ),
        runs: record.runs.map((row) =>
          row.runId === 'run-seat-17'
            ? { ...row, status: 'completed', endedAt: AT, stats: { tokens: 9 } }
            : row.status === 'running'
              ? { ...row, stats: { tokens: 2 } }
              : row
        )
      }))
    ).toEqual([{ moment: 'run_final', runId: 'run-seat-17' }])
  })
})

describe('what classifying a save reads of the record', () => {
  /** Counts the elements read from an array, by index or by iteration. */
  function counted<T>(items: T[]): { items: T[]; reads: () => number } {
    let reads = 0
    const proxy = new Proxy(items, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1
        return Reflect.get(target, key, receiver)
      }
    })
    return { items: proxy, reads: () => reads }
  }

  function classifyCounting(
    previous: ChatRecord,
    next: ChatRecord,
    flushReason: FlushReason = 'normal'
  ) {
    const { batch, transcriptOps } = deriveChatRecordMutationWithProjection(previous, next)
    const before = { messages: counted(previous.messages), runs: counted(previous.runs) }
    const after = { messages: counted(next.messages), runs: counted(next.runs) }
    const moments = classifyChatSaveMoments({
      previous: { ...previous, messages: before.messages.items, runs: before.runs.items },
      next: { ...next, messages: after.messages.items, runs: after.runs.items },
      operations: batch.operations,
      transcriptOps,
      flushReason
    })
    return {
      moments,
      rowsRead: before.messages.reads() + after.messages.reads(),
      runsRead: before.runs.reads() + after.runs.reads()
    }
  }

  const rows = Array.from({ length: 50_000 }, (_, index) =>
    message(`row-${index}`, index % 2 ? 'assistant' : 'user', `Row ${index}`)
  )
  const runs = Array.from({ length: 5_000 }, (_, index) =>
    run(`run-${index}`, index >= 4_990 ? 'running' : 'completed')
  )
  const long = thread({ messages: rows, runs })

  it('reads no row and no run of a long thread for a streaming save', () => {
    const last = rows[rows.length - 1]
    const result = classifyCounting(
      long,
      advanced(long, {
        ...long,
        messages: [...rows.slice(0, -1), { ...last, content: `${last.content}!` }],
        runs: runs.map((row) => (row.status === 'running' ? { ...row, stats: { tokens: 5 } } : row))
      })
    )

    expect(result).toEqual({ moments: [], rowsRead: 0, runsRead: 0 })
  })

  it('reads no row to find a truncation destructive', () => {
    const result = classifyCounting(long, advanced(long, { ...long, messages: rows.slice(0, 10) }))

    expect(result).toEqual({ moments: DESTRUCTIVE, rowsRead: 0, runsRead: 0 })
  })

  it('reads only the runs newer than the one that ended', () => {
    const result = classifyCounting(
      long,
      advanced(long, {
        ...long,
        runs: runs.map((row) => (row.runId === 'run-4995' ? { ...row, status: 'completed' } : row))
      })
    )

    expect(result).toEqual({
      moments: [{ moment: 'run_final', runId: 'run-4995' }],
      rowsRead: 0,
      runsRead: 5
    })
  })
})
