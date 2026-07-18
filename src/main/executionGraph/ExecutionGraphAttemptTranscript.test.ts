import { describe, expect, it } from 'vitest'
import type { ChatRecord } from '../store/types'
import { buildExecutionGraphAttemptTerminalReceipt } from './ExecutionGraphAttemptResult'
import {
  attachExecutionGraphAttemptReceipt,
  projectExecutionGraphAttemptTranscript,
  seedExecutionGraphAttemptTranscript,
  verifyExecutionGraphAttemptReceiptOnChat
} from './ExecutionGraphAttemptTranscript'

const binding = {
  schemaVersion: 1 as const,
  executionId: 'execution-one',
  activationId: 'activation-one',
  attemptId: 'attempt-one',
  providerRunRef: 'run-one',
  workspaceId: 'workspace-one',
  rootChatId: 'chat-one',
  provider: 'codex' as const
}

function chat(): ChatRecord {
  return {
    appChatId: 'chat-one',
    scope: 'workspace',
    chatKind: 'single',
    provider: 'codex',
    title: 'Task',
    workspaceId: 'workspace-one',
    workspacePath: '/workspace',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: []
  }
}

describe('ExecutionGraphAttemptTranscript', () => {
  it('seeds, projects, seals, and verifies one exact main-owned transcript', () => {
    const seeded = seedExecutionGraphAttemptTranscript({
      chat: chat(),
      binding,
      prompt: 'Implement the change.',
      startedAt: '2026-07-18T12:00:00.000Z',
      requestedModel: 'gpt-5.6',
      approvalMode: 'default'
    })
    expect(seeded.chat.messages).toMatchObject([
      { id: seeded.promptMessageId, role: 'user', runId: 'run-one' }
    ])
    expect(seeded.chat.runs).toMatchObject([{ runId: 'run-one', status: 'running' }])

    const projected = projectExecutionGraphAttemptTranscript({
      chat: seeded.chat,
      binding,
      promptMessageId: seeded.promptMessageId,
      startedAt: '2026-07-18T12:00:00.000Z',
      timestamp: '2026-07-18T12:01:00.000Z',
      status: 'completed',
      actualModel: 'gpt-5.6',
      parts: [
        {
          id: `${seeded.assistantMessageId}-p0`,
          kind: 'text',
          content: 'Implemented the change.',
          activities: []
        },
        {
          id: `${seeded.assistantMessageId}-p1`,
          kind: 'tools',
          content: '',
          activities: [
            {
              id: 'tool-one',
              toolName: 'read_file',
              displayName: 'Read file',
              category: 'read',
              status: 'success',
              parameters: {},
              startedAt: '2026-07-18T12:00:30.000Z'
            }
          ]
        }
      ]
    })
    const receipt = buildExecutionGraphAttemptTerminalReceipt({
      binding,
      status: 'completed',
      committedAt: '2026-07-18T12:01:01.000Z',
      content: 'Implemented the change.',
      evidenceRefs: projected.evidenceRefs
    })
    const committed = attachExecutionGraphAttemptReceipt(projected.chat, receipt)

    expect(committed.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool'
    ])
    expect(committed.runs[0]).toMatchObject({
      runId: 'run-one',
      status: 'completed',
      endedAt: '2026-07-18T12:01:00.000Z',
      providerMetadata: { executionGraphResultReceipt: receipt }
    })
    expect(verifyExecutionGraphAttemptReceiptOnChat(committed, receipt)).toBe(true)
    expect(
      verifyExecutionGraphAttemptReceiptOnChat(
        { ...committed, messages: committed.messages.filter((message) => message.role !== 'tool') },
        receipt
      )
    ).toBe(false)
  })

  it('rejects projection after the root chat or run binding changes', () => {
    const seeded = seedExecutionGraphAttemptTranscript({
      chat: chat(),
      binding,
      prompt: 'Implement the change.',
      startedAt: '2026-07-18T12:00:00.000Z'
    })
    expect(() =>
      projectExecutionGraphAttemptTranscript({
        chat: { ...seeded.chat, workspaceId: 'workspace-other' },
        binding,
        promptMessageId: seeded.promptMessageId,
        startedAt: '2026-07-18T12:00:00.000Z',
        timestamp: '2026-07-18T12:01:00.000Z',
        status: 'completed',
        parts: []
      })
    ).toThrow(/durable root/i)
  })
})
