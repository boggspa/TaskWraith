import { describe, expect, it, vi } from 'vitest'

import type { AuthoredChatTranscriptMutation } from './ChatRecordMutation'
import { prepareChatForPersistence } from './ChatPersistencePreparation'
import type { ChatRecord, ToolActivityDetailRef } from './types'

function detailRef(): ToolActivityDetailRef {
  return {
    schemaVersion: 1,
    storage: 'run_event_artifact',
    runId: 'run-1',
    activityId: 'tool-1',
    offset: 0,
    byteLength: 70_000,
    sha256: 'a'.repeat(64)
  }
}

function liveToolChat(): ChatRecord {
  return {
    appChatId: 'chat-1',
    scope: 'global',
    chatKind: 'single',
    provider: 'codex',
    title: 'Tool-heavy chat',
    createdAt: 1,
    updatedAt: 2,
    persistenceRevision: 2,
    archived: false,
    messages: [
      {
        id: 'message-1',
        role: 'tool',
        content: '',
        timestamp: '2026-09-04T00:00:00.000Z',
        runId: 'run-1',
        toolActivities: [
          {
            id: 'tool-1',
            toolName: 'run_shell_command',
            displayName: 'Ran command',
            category: 'shell',
            status: 'success',
            endedAt: '2026-09-04T00:00:01.000Z',
            parameters: { command: 'printf hello' },
            rawResultEvent: { output: 'x'.repeat(70_000) }
          }
        ]
      }
    ],
    runs: [
      {
        runId: 'run-1',
        startedAt: '2026-09-04T00:00:00.000Z',
        status: 'running'
      }
    ]
  }
}

function authored(chat: ChatRecord): AuthoredChatTranscriptMutation {
  return {
    operations: [
      {
        type: 'message_put',
        messageId: chat.messages[0].id,
        message: chat.messages[0]
      }
    ],
    transcriptOps: [{ op: 'update', id: chat.messages[0].id, message: chat.messages[0] }],
    changedMessageCount: 1
  }
}

describe('prepareChatForPersistence', () => {
  it('commits and checkpoints detail before publishing stripped chat and authored operations', () => {
    const source = liveToolChat()
    const order: string[] = []
    const persistDetailCheckpoint = vi.fn(() => order.push('checkpoint'))

    const result = prepareChatForPersistence({
      chat: source,
      previous: null,
      authoredTranscript: authored(source),
      authoredTranscriptEligible: true,
      createDetailBatch: () => ({
        stage: () => {
          order.push('stage')
          return detailRef()
        },
        commit: () => {
          order.push('commit')
          return [{ runId: 'run-1' }]
        }
      }),
      readArchivedDetail: () => null,
      persistDetailCheckpoint,
      maxTerminalRunsPerPass: 25
    })

    expect(order).toEqual(['stage', 'commit', 'checkpoint'])
    expect(result.externalizationFailed).toBe(false)
    const activity = result.chat.messages[0].toolActivities![0]
    expect(activity.detailRef).toEqual(detailRef())
    expect(activity.parameters).toBeUndefined()
    expect(activity.rawResultEvent).toBeUndefined()
    const operation = result.authoredTranscript?.operations[0]
    expect(operation?.type).toBe('message_put')
    if (operation?.type !== 'message_put') throw new Error('expected substituted message_put')
    expect(operation.message.toolActivities?.[0].detailRef).toEqual(detailRef())
    expect(operation.message.toolActivities?.[0].rawResultEvent).toBeUndefined()
  })

  it('retains inline detail and requests full compatibility fallback when checkpointing fails', () => {
    const source = liveToolChat()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = prepareChatForPersistence({
        chat: source,
        previous: null,
        authoredTranscriptEligible: true,
        createDetailBatch: () => ({
          stage: () => detailRef(),
          commit: () => [{ runId: 'run-1' }]
        }),
        readArchivedDetail: () => null,
        persistDetailCheckpoint: () => {
          throw new Error('checkpoint failed')
        },
        maxTerminalRunsPerPass: 25
      })

      expect(result.externalizationFailed).toBe(true)
      expect(result.chat.messages[0].toolActivities?.[0].rawResultEvent).toBeDefined()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('treats an unarchived sealed jumbo activity as a preparation failure', () => {
    const source = liveToolChat()
    const result = prepareChatForPersistence({
      chat: source,
      previous: null,
      authoredTranscriptEligible: true,
      createDetailBatch: () => ({ stage: () => null, commit: () => [] }),
      readArchivedDetail: () => null,
      persistDetailCheckpoint: () => {},
      maxTerminalRunsPerPass: 25
    })

    expect(result.externalizationFailed).toBe(true)
    expect(result.chat.messages[0].toolActivities?.[0].rawResultEvent).toBeDefined()
  })

  it('drops authored operations when the caller says its transcript lineage is ineligible', () => {
    const source = liveToolChat()
    const result = prepareChatForPersistence({
      chat: source,
      previous: null,
      authoredTranscript: authored(source),
      authoredTranscriptEligible: false,
      createDetailBatch: () => ({ stage: () => detailRef(), commit: () => [] }),
      readArchivedDetail: () => null,
      persistDetailCheckpoint: () => {},
      maxTerminalRunsPerPass: 25
    })

    expect(result.authoredTranscript).toBeUndefined()
  })
})
