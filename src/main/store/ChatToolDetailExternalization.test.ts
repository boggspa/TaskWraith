import { describe, expect, it, vi } from 'vitest'
import {
  TOOL_DETAIL_EXTERNALIZATION_GENERATION,
  externalizeTerminalToolActivityDetails
} from './ChatToolDetailExternalization'
import type { ChatRecord, ToolActivityDetailRef } from './types'

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
