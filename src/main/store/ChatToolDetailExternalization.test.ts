import { describe, expect, it, vi } from 'vitest'
import {
  COMMIT_EVIDENCE_RECEIPT_LIMIT,
  LIVE_TOOL_DETAIL_EXTERNALIZE_BYTES,
  TOOL_DETAIL_EXTERNALIZATION_GENERATION,
  authoredMutationMentionsActivityIds,
  estimateLiveToolActivityDetailBytes,
  externalizeTerminalToolActivityDetails,
  externalizeToolActivityDetails,
  substituteToolActivitiesInAuthoredMutation
} from './ChatToolDetailExternalization'
import type { AuthoredChatTranscriptMutation } from './ChatRecordMutation'
import type { ChatRecord, ToolActivity, ToolActivityDetailRef } from './types'

function ref(runId: string, activityId: string): ToolActivityDetailRef {
  return {
    schemaVersion: 1,
    storage: 'run_event_artifact',
    runId,
    activityId,
    offset: 10,
    byteLength: 20,
    sha256: 'a'.repeat(64)
  }
}

function record(status = 'success'): ChatRecord {
  return {
    appChatId: 'chat-1',
    title: 'Tool detail',
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    messages: [
      {
        id: 'message-1',
        role: 'tool',
        content: '',
        timestamp: '2026-08-16T00:00:00.000Z',
        runId: 'run-1',
        toolActivities: [
          {
            id: 'tool-1',
            toolName: 'run_shell_command',
            displayName: 'Ran command',
            category: 'shell',
            status: 'success',
            parameters: { command: 'printf hello' },
            resultSummary: 'hello',
            outputPreview: 'hello',
            rawResultEvent: { output: 'hello' },
            filePath: '/workspace/a.ts'
          }
        ]
      }
    ],
    runs: [
      {
        runId: 'run-1',
        startedAt: '2026-08-16T00:00:00.000Z',
        endedAt: status === 'running' ? undefined : '2026-08-16T00:01:00.000Z',
        status
      }
    ]
  }
}

describe('externalizeTerminalToolActivityDetails', () => {
  it('moves heavy fields behind a detail ref and stamps a terminal run once', () => {
    const sink = vi.fn((runId: string, activity: { id: string }) => ref(runId, activity.id))
    const result = externalizeTerminalToolActivityDetails(record(), sink)
    const activity = result.chat.messages[0].toolActivities![0]

    expect(sink).toHaveBeenCalledTimes(1)
    expect(activity).toMatchObject({
      id: 'tool-1',
      displayName: 'Ran command',
      filePath: '/workspace/a.ts',
      detailRef: ref('run-1', 'tool-1')
    })
    expect(activity.parameters).toBeUndefined()
    expect(activity.resultSummary).toBeUndefined()
    expect(activity.outputPreview).toBeUndefined()
    expect(activity.rawResultEvent).toBeUndefined()
    expect(result.chat.runs[0].toolDetailExternalizationGeneration).toBe(
      TOOL_DETAIL_EXTERNALIZATION_GENERATION
    )
    expect(externalizeTerminalToolActivityDetails(result.chat, sink).chat).toBe(result.chat)
  })

  it('does not externalize an active run', () => {
    const source = record('running')
    const sink = vi.fn()

    expect(externalizeTerminalToolActivityDetails(source, sink).chat).toBe(source)
    expect(sink).not.toHaveBeenCalled()
  })

  it('waits for an explicit terminal seal on the latest run', () => {
    const source = record('success')
    delete source.runs[0].endedAt
    const sink = vi.fn()

    expect(externalizeTerminalToolActivityDetails(source, sink).chat).toBe(source)
    expect(sink).not.toHaveBeenCalled()
  })

  it('keeps full detail and leaves the run retryable when durable staging fails', () => {
    const source = record()
    const result = externalizeTerminalToolActivityDetails(source, () => null)

    expect(result.chat).toBe(source)
    expect(result.chat.messages[0].toolActivities![0].parameters).toBeDefined()
    expect(result.chat.runs[0].toolDetailExternalizationGeneration).toBeUndefined()
  })
})

const JUMBO_OUTPUT = 'x'.repeat(LIVE_TOOL_DETAIL_EXTERNALIZE_BYTES)

function liveActivity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: 'tool-live',
    toolName: 'run_shell_command',
    displayName: 'Ran command',
    category: 'shell',
    status: 'success',
    endedAt: '2026-08-18T00:00:30.000Z',
    durationMs: 1200,
    parameters: { command: 'cat big.log' },
    resultSummary: 'read big.log',
    outputPreview: 'first lines…',
    rawResultEvent: { output: JUMBO_OUTPUT },
    ...overrides
  }
}

function liveRecord(activity: ToolActivity, runStatus = 'running'): ChatRecord {
  return {
    appChatId: 'chat-live',
    title: 'Live tool detail',
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    messages: [
      {
        id: 'message-live',
        role: 'tool',
        content: '',
        timestamp: '2026-08-18T00:00:00.000Z',
        runId: 'run-live',
        toolActivities: [activity]
      }
    ],
    runs: [
      {
        runId: 'run-live',
        startedAt: '2026-08-18T00:00:00.000Z',
        status: runStatus
      }
    ]
  }
}

describe('externalizeToolActivityDetails (live runs)', () => {
  it('strips only the raw payload of a sealed jumbo activity mid-run and keeps summaries inline', () => {
    const sink = vi.fn((runId: string, activity: { id: string }) => ref(runId, activity.id))
    const source = liveRecord(liveActivity())
    const result = externalizeToolActivityDetails(source, sink, { previousChat: null })
    const activity = result.chat.messages[0].toolActivities![0]

    expect(sink).toHaveBeenCalledTimes(1)
    expect(activity.detailRef).toEqual(ref('run-live', 'tool-live'))
    expect(activity.rawResultEvent).toBeUndefined()
    expect(activity.parameters).toBeUndefined()
    expect(activity.resultSummary).toBe('read big.log')
    expect(activity.outputPreview).toBe('first lines…')
    expect(result.chat.runs[0].toolDetailExternalizationGeneration).toBeUndefined()
    expect(result.strippedActivitiesById.get('tool-live')).toBe(activity)
    expect(result.opRequiredActivityIds.has('tool-live')).toBe(true)
  })

  it('leaves a small sealed activity fully inline until its run turns terminal', () => {
    const sink = vi.fn()
    const source = liveRecord(liveActivity({ rawResultEvent: { output: 'hello' } }))
    const result = externalizeToolActivityDetails(source, sink, { previousChat: null })

    expect(result.chat).toBe(source)
    expect(sink).not.toHaveBeenCalled()
  })

  it('leaves an unsealed activity untouched however large it is', () => {
    const sink = vi.fn()
    const source = liveRecord(liveActivity({ status: 'running', endedAt: undefined }))
    const result = externalizeToolActivityDetails(source, sink, { previousChat: null })

    expect(result.chat).toBe(source)
    expect(sink).not.toHaveBeenCalled()
  })

  it('re-adopts the previous save’s ref when the orchestrator re-delivers heavy fields', () => {
    const sink = vi.fn()
    const previous = liveRecord({
      ...liveActivity({
        parameters: undefined,
        rawUseEvent: undefined,
        rawResultEvent: undefined
      }),
      detailRef: ref('run-live', 'tool-live')
    })
    const incoming = liveRecord(liveActivity())
    const result = externalizeToolActivityDetails(incoming, sink, { previousChat: previous })
    const activity = result.chat.messages[0].toolActivities![0]

    expect(sink).not.toHaveBeenCalled()
    expect(activity.detailRef).toEqual(ref('run-live', 'tool-live'))
    expect(activity.rawResultEvent).toBeUndefined()
    expect(activity.resultSummary).toBe('read big.log')
    expect(result.opRequiredActivityIds.size).toBe(0)
    expect(result.strippedActivitiesById.has('tool-live')).toBe(true)
  })

  it('re-stages when the seal identity changed since the previous save', () => {
    const sink = vi.fn((runId: string, activity: { id: string }) => ({
      ...ref(runId, activity.id),
      offset: 999
    }))
    const previous = liveRecord({
      ...liveActivity({
        parameters: undefined,
        rawUseEvent: undefined,
        rawResultEvent: undefined
      }),
      detailRef: ref('run-live', 'tool-live')
    })
    const incoming = liveRecord(liveActivity({ endedAt: '2026-08-18T00:00:45.000Z' }))
    const result = externalizeToolActivityDetails(incoming, sink, { previousChat: previous })
    const activity = result.chat.messages[0].toolActivities![0]

    expect(sink).toHaveBeenCalledTimes(1)
    expect(activity.detailRef?.offset).toBe(999)
    expect(result.opRequiredActivityIds.has('tool-live')).toBe(true)
  })

  it('strips a hydration echo that carries both a ref and raw fields without re-staging', () => {
    const sink = vi.fn()
    const incoming = liveRecord({ ...liveActivity(), detailRef: ref('run-live', 'tool-live') })
    const result = externalizeToolActivityDetails(incoming, sink, { previousChat: null })
    const activity = result.chat.messages[0].toolActivities![0]

    expect(sink).not.toHaveBeenCalled()
    expect(activity.rawResultEvent).toBeUndefined()
    expect(activity.detailRef).toEqual(ref('run-live', 'tool-live'))
    expect(result.opRequiredActivityIds.size).toBe(0)
  })

  it('does nothing on live runs unless options are provided (legacy wrapper stays terminal-only)', () => {
    const sink = vi.fn()
    const source = liveRecord(liveActivity())

    expect(externalizeTerminalToolActivityDetails(source, sink).chat).toBe(source)
    expect(sink).not.toHaveBeenCalled()
  })
})

describe('externalizeToolActivityDetails (terminal fold of live-externalized activities)', () => {
  function terminalRecordWithRef(archMatch: boolean): {
    chat: ChatRecord
    archived: ToolActivity
  } {
    const stripped: ToolActivity = {
      ...liveActivity({
        parameters: undefined,
        rawUseEvent: undefined,
        rawResultEvent: undefined
      }),
      detailRef: ref('run-live', 'tool-live')
    }
    const chat = liveRecord(stripped, 'success')
    chat.runs[0].endedAt = '2026-08-18T00:01:00.000Z'
    const archived = liveActivity(
      archMatch ? {} : { resultSummary: 'stale summary from seal time' }
    )
    return { chat, archived }
  }

  it('folds by stripping the remaining summaries when they match the archive', () => {
    const { chat, archived } = terminalRecordWithRef(true)
    const sink = vi.fn()
    const result = externalizeToolActivityDetails(chat, sink, {
      previousChat: null,
      readArchivedDetail: () => archived
    })
    const activity = result.chat.messages[0].toolActivities![0]

    expect(sink).not.toHaveBeenCalled()
    expect(activity.resultSummary).toBeUndefined()
    expect(activity.outputPreview).toBeUndefined()
    expect(activity.detailRef).toEqual(ref('run-live', 'tool-live'))
    expect(result.chat.runs[0].toolDetailExternalizationGeneration).toBe(
      TOOL_DETAIL_EXTERNALIZATION_GENERATION
    )
    expect(result.opRequiredActivityIds.has('tool-live')).toBe(true)
  })

  it('re-stages a merged detail when the inline summaries drifted from the archive', () => {
    const { chat, archived } = terminalRecordWithRef(false)
    const staged: ToolActivity[] = []
    const sink = vi.fn((runId: string, activity: ToolActivity) => {
      staged.push(activity)
      return { ...ref(runId, activity.id), offset: 777 }
    })
    const result = externalizeToolActivityDetails(chat, sink, {
      previousChat: null,
      readArchivedDetail: () => archived
    })
    const activity = result.chat.messages[0].toolActivities![0]

    expect(sink).toHaveBeenCalledTimes(1)
    expect(staged[0].rawResultEvent).toEqual({ output: JUMBO_OUTPUT })
    expect(staged[0].resultSummary).toBe('read big.log')
    expect(activity.detailRef?.offset).toBe(777)
    expect(activity.resultSummary).toBeUndefined()
    expect(result.chat.runs[0].toolDetailExternalizationGeneration).toBe(
      TOOL_DETAIL_EXTERNALIZATION_GENERATION
    )
  })

  it('keeps the activity and the run retryable when the archive is unreadable', () => {
    const { chat } = terminalRecordWithRef(true)
    const sink = vi.fn()
    const result = externalizeToolActivityDetails(chat, sink, {
      previousChat: null,
      readArchivedDetail: () => null
    })
    const activity = result.chat.messages[0].toolActivities![0]

    expect(sink).not.toHaveBeenCalled()
    expect(activity.resultSummary).toBe('read big.log')
    expect(result.chat.runs[0].toolDetailExternalizationGeneration).toBeUndefined()
  })
})

describe('authored mutation substitution', () => {
  function authored(activity: ToolActivity): AuthoredChatTranscriptMutation {
    return {
      operations: [
        {
          type: 'tool_activity_put',
          messageId: 'message-live',
          activityId: activity.id,
          activity
        },
        {
          type: 'messages_splice',
          index: 0,
          deleteCount: 0,
          messages: [
            {
              id: 'message-live',
              role: 'tool',
              content: '',
              timestamp: '2026-08-18T00:00:00.000Z',
              runId: 'run-live',
              toolActivities: [activity]
            }
          ]
        }
      ],
      transcriptOps: [
        { op: 'append', messages: [] },
        {
          op: 'update',
          id: 'message-live',
          message: {
            id: 'message-live',
            role: 'tool',
            content: '',
            timestamp: '2026-08-18T00:00:00.000Z',
            runId: 'run-live',
            toolActivities: [activity]
          }
        }
      ],
      changedMessageCount: 1
    }
  }

  it('substitutes stripped activities into every op shape that carries activities', () => {
    const heavy = liveActivity()
    const stripped: ToolActivity = {
      ...liveActivity({
        parameters: undefined,
        rawUseEvent: undefined,
        rawResultEvent: undefined
      }),
      detailRef: ref('run-live', 'tool-live')
    }
    const result = substituteToolActivitiesInAuthoredMutation(
      authored(heavy),
      new Map([[stripped.id, stripped]])
    )

    const putOp = result.operations[0]
    if (putOp.type !== 'tool_activity_put') throw new Error('expected tool_activity_put')
    expect(putOp.activity.rawResultEvent).toBeUndefined()
    expect(putOp.activity.detailRef).toEqual(ref('run-live', 'tool-live'))
    const spliceOp = result.operations[1]
    if (spliceOp.type !== 'messages_splice') throw new Error('expected messages_splice')
    expect(spliceOp.messages[0].toolActivities![0].rawResultEvent).toBeUndefined()
    const updateOp = result.transcriptOps![1]
    if (updateOp.op !== 'update') throw new Error('expected update op')
    expect(updateOp.message.toolActivities![0].rawResultEvent).toBeUndefined()
  })

  it('returns the same object when nothing matches', () => {
    const input = authored(liveActivity({ id: 'other' }))
    const stripped = liveActivity()
    expect(
      substituteToolActivitiesInAuthoredMutation(input, new Map([['tool-live', stripped]]))
    ).toBe(input)
  })

  it('reports whether authored ops mention every required activity id', () => {
    const input = authored(liveActivity())
    expect(authoredMutationMentionsActivityIds(input, new Set(['tool-live']))).toBe(true)
    expect(authoredMutationMentionsActivityIds(input, new Set(['tool-live', 'absent']))).toBe(false)
    expect(authoredMutationMentionsActivityIds(input, new Set())).toBe(true)
  })
})

describe('estimateLiveToolActivityDetailBytes', () => {
  it('counts the raw payload and summaries and crosses the threshold on jumbo output', () => {
    expect(estimateLiveToolActivityDetailBytes(liveActivity())).toBeGreaterThanOrEqual(
      LIVE_TOOL_DETAIL_EXTERNALIZE_BYTES
    )
    expect(
      estimateLiveToolActivityDetailBytes(liveActivity({ rawResultEvent: { output: 'hello' } }))
    ).toBeLessThan(LIVE_TOOL_DETAIL_EXTERNALIZE_BYTES)
  })
})

describe('commit evidence survives detail stripping', () => {
  const RECEIPT_OUTPUT =
    '[main a048ce5] feat: ChipTown interiors (lab + mart)\n' +
    ' 2 files changed, 478 insertions(+), 0 deletions(-)\n' +
    ' create mode 100644 ChipTown/Maps/lab.json'

  function commitChat(activity: ToolActivity, runStatus = 'success'): ChatRecord {
    const chat = record(runStatus)
    chat.messages[0].toolActivities = [activity]
    return chat
  }

  it('stamps evidence on a dedicated git_commit activity at terminal strip', () => {
    const sink = vi.fn((runId: string, activity: { id: string }) => ref(runId, activity.id))
    const result = externalizeTerminalToolActivityDetails(
      commitChat({
        id: 'tool-commit',
        toolName: 'mcp__TaskWraith__git_commit',
        displayName: 'git_commit',
        category: 'write',
        status: 'success',
        endedAt: '2026-08-16T00:00:30.000Z',
        parameters: { message: 'feat: ChipTown interiors (lab + mart)' },
        resultSummary: 'Committed a048ce5',
        outputPreview: RECEIPT_OUTPUT,
        rawResultEvent: { output: RECEIPT_OUTPUT }
      }),
      sink
    )
    const activity = result.chat.messages[0].toolActivities![0]
    expect(activity.outputPreview).toBeUndefined()
    expect(activity.commitEvidence?.receiptText).toContain(
      '[main a048ce5] feat: ChipTown interiors (lab + mart)'
    )
    expect(activity.commitEvidence?.receiptText).toContain('2 files changed, 478 insertions(+)')
  })

  it('keeps the shell command and cwd alongside the receipt for shell commits', () => {
    const sink = vi.fn((runId: string, activity: { id: string }) => ref(runId, activity.id))
    const result = externalizeTerminalToolActivityDetails(
      commitChat({
        id: 'tool-shell-commit',
        toolName: 'run_shell_command',
        displayName: 'Ran command',
        category: 'shell',
        status: 'success',
        endedAt: '2026-08-16T00:00:30.000Z',
        parameters: { command: 'git commit -F /tmp/msg -- src/a.ts', cwd: '/workspace' },
        rawResultEvent: { output: RECEIPT_OUTPUT }
      }),
      sink
    )
    const activity = result.chat.messages[0].toolActivities![0]
    expect(activity.parameters).toBeUndefined()
    expect(activity.commitEvidence).toMatchObject({
      command: 'git commit -F /tmp/msg -- src/a.ts',
      cwd: '/workspace'
    })
    expect(activity.commitEvidence?.receiptText).toContain('[main a048ce5]')
  })

  it('stamps no evidence on non-commit activities', () => {
    const sink = vi.fn((runId: string, activity: { id: string }) => ref(runId, activity.id))
    const result = externalizeTerminalToolActivityDetails(record(), sink)
    expect(result.chat.messages[0].toolActivities![0].commitEvidence).toBeUndefined()
  })

  it('stamps evidence when a sealed jumbo shell commit strips mid-run', () => {
    const sink = vi.fn((runId: string, activity: { id: string }) => ref(runId, activity.id))
    const result = externalizeToolActivityDetails(
      liveRecord(
        liveActivity({
          parameters: { command: 'git commit -m "feat: F2 camera viewport"' },
          rawResultEvent: { output: `[main f2f118e] feat: F2 camera viewport\n${JUMBO_OUTPUT}` }
        })
      ),
      sink,
      {}
    )
    const activity = result.chat.messages[0].toolActivities![0]
    expect(activity.parameters).toBeUndefined()
    expect(activity.commitEvidence?.command).toBe('git commit -m "feat: F2 camera viewport"')
    expect(activity.commitEvidence?.receiptText).toContain(
      '[main f2f118e] feat: F2 camera viewport'
    )
    expect(activity.commitEvidence!.receiptText.length).toBeLessThanOrEqual(
      COMMIT_EVIDENCE_RECEIPT_LIMIT
    )
  })

  it('preserves previously stamped evidence through the terminal fold', () => {
    const evidence = { command: 'git commit -m x', receiptText: '[main 1234abc] x' }
    const sink = vi.fn((runId: string, activity: { id: string }) => ref(runId, activity.id))
    const chat = commitChat({
      id: 'tool-folded',
      toolName: 'run_shell_command',
      displayName: 'Ran command',
      category: 'shell',
      status: 'success',
      endedAt: '2026-08-16T00:00:30.000Z',
      detailRef: ref('run-1', 'tool-folded'),
      resultSummary: 'committed',
      commitEvidence: evidence
    })
    const result = externalizeToolActivityDetails(chat, sink, {
      readArchivedDetail: () => ({
        id: 'tool-folded',
        toolName: 'run_shell_command',
        displayName: 'Ran command',
        category: 'shell',
        status: 'success',
        resultSummary: 'committed'
      })
    })
    const activity = result.chat.messages[0].toolActivities![0]
    expect(activity.resultSummary).toBeUndefined()
    expect(activity.commitEvidence).toEqual(evidence)
  })
})

function manyRunRecord(runCount: number): ChatRecord {
  const messages: ChatRecord['messages'] = []
  const runs: ChatRecord['runs'] = []
  for (let index = 0; index < runCount; index += 1) {
    const runId = `run-${index}`
    messages.push({
      id: `message-${index}`,
      role: 'tool',
      content: '',
      timestamp: '2026-08-16T00:00:00.000Z',
      runId,
      toolActivities: [
        {
          id: `tool-${index}`,
          toolName: 'run_shell_command',
          displayName: 'Ran command',
          category: 'shell',
          status: 'success',
          parameters: { command: 'printf hello' },
          resultSummary: 'hello',
          outputPreview: 'hello',
          rawResultEvent: { output: 'hello' }
        }
      ]
    })
    runs.push({
      runId,
      startedAt: '2026-08-16T00:00:00.000Z',
      endedAt: '2026-08-16T00:01:00.000Z',
      status: 'success'
    })
  }
  return {
    appChatId: 'chat-many',
    title: 'Many runs',
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    messages,
    runs
  }
}

describe('terminal externalization backlog cap', () => {
  it('stages at most maxTerminalRunsPerPass runs in one pass', () => {
    const sink = vi.fn((runId: string, activity: { id: string }) => ref(runId, activity.id))

    const result = externalizeToolActivityDetails(manyRunRecord(120), sink, {
      previousChat: null,
      maxTerminalRunsPerPass: 25
    })

    expect(result.completedRunIds).toHaveLength(25)
    expect(sink).toHaveBeenCalledTimes(25)
    const stamped = result.chat.runs.filter(
      (run) => run.toolDetailExternalizationGeneration === TOOL_DETAIL_EXTERNALIZATION_GENERATION
    )
    expect(stamped).toHaveLength(25)
  })

  it('drains the backlog across successive passes, oldest run first', () => {
    const sink = vi.fn((runId: string, activity: { id: string }) => ref(runId, activity.id))
    let chat = manyRunRecord(60)
    const order: string[] = []

    for (let pass = 0; pass < 3; pass += 1) {
      const result = externalizeToolActivityDetails(chat, sink, {
        previousChat: null,
        maxTerminalRunsPerPass: 25
      })
      order.push(...result.completedRunIds)
      chat = result.chat
    }

    expect(order.slice(0, 3)).toEqual(['run-0', 'run-1', 'run-2'])
    expect(new Set(order).size).toBe(60)
    expect(
      chat.runs.every(
        (run) => run.toolDetailExternalizationGeneration === TOOL_DETAIL_EXTERNALIZATION_GENERATION
      )
    ).toBe(true)
  })

  it('externalizes the whole backlog when no cap is given', () => {
    const sink = vi.fn((runId: string, activity: { id: string }) => ref(runId, activity.id))

    const result = externalizeToolActivityDetails(manyRunRecord(40), sink, { previousChat: null })

    expect(result.completedRunIds).toHaveLength(40)
  })
})
