import { readFileSync } from 'node:fs'
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
      prompt: 'Implement the change.',
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
    expect(
      verifyExecutionGraphAttemptReceiptOnChat(
        {
          ...committed,
          messages: committed.messages.map((message) =>
            message.role === 'user' ? { ...message, content: 'Mutated prompt.' } : message
          )
        },
        receipt
      )
    ).toBe(false)
    expect(
      verifyExecutionGraphAttemptReceiptOnChat(
        {
          ...committed,
          messages: committed.messages.map((message) =>
            message.role === 'assistant' ? { ...message, content: 'Mutated output.' } : message
          )
        },
        receipt
      )
    ).toBe(false)
  })

  it('rejects a renderer race that pre-seeds the canonical run identity', () => {
    const forged = chat()
    forged.messages.push({
      id: 'execution-graph-prompt-run-one',
      role: 'assistant',
      content: 'Counterfeit prompt.',
      timestamp: 'before',
      runId: 'run-one'
    })
    forged.runs = [
      {
        runId: 'run-one',
        provider: 'claude',
        startedAt: 'before',
        status: 'completed'
      }
    ]

    expect(() =>
      seedExecutionGraphAttemptTranscript({
        chat: forged,
        binding,
        prompt: 'Canonical provider prompt.',
        startedAt: '2026-07-18T12:00:00.000Z'
      })
    ).toThrow('run identity already exists')
  })

  it('rejects any pre-seeded message carrying the canonical run identity', () => {
    const forged = chat()
    forged.messages.push({
      id: 'renderer-race',
      role: 'assistant',
      content: 'Counterfeit output.',
      timestamp: 'before',
      runId: 'run-one'
    })

    expect(() =>
      seedExecutionGraphAttemptTranscript({
        chat: forged,
        binding,
        prompt: 'Canonical provider prompt.',
        startedAt: '2026-07-18T12:00:00.000Z'
      })
    ).toThrow('message identity already exists')
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

/**
 * The third producer of activity rows, after the renderer's own reducer and the
 * bridge lane. All three now stamp the same two fields, so a row's accent never
 * depends on finding its run in an array that is empty by construction on a
 * paged record and one render stale on a retained one.
 *
 * This lane had it on NEITHER row: the assistant bubble was as bare as the tool
 * stack, both carrying only `kind` plus the attempt binding.
 */
describe('execution graph attempt row branding', () => {
  function seeded(requestedModel?: string) {
    return seedExecutionGraphAttemptTranscript({
      chat: chat(),
      binding,
      prompt: 'Implement the change.',
      startedAt: '2026-07-18T12:00:00.000Z',
      ...(requestedModel ? { requestedModel } : {})
    })
  }

  function parts(assistantMessageId: string) {
    return [
      {
        id: `${assistantMessageId}-p0`,
        kind: 'text' as const,
        content: 'Implemented the change.',
        activities: []
      },
      {
        id: `${assistantMessageId}-p1`,
        kind: 'tools' as const,
        content: '',
        activities: [
          {
            id: 'tool-one',
            toolName: 'read_file',
            displayName: 'Read file',
            category: 'read' as const,
            status: 'success' as const,
            parameters: {},
            startedAt: '2026-07-18T12:00:30.000Z'
          }
        ]
      }
    ]
  }

  it('stamps the attempt model on every row it writes', () => {
    const seed = seeded('gpt-5.6')
    const projected = projectExecutionGraphAttemptTranscript({
      chat: seed.chat,
      binding,
      promptMessageId: seed.promptMessageId,
      startedAt: '2026-07-18T12:00:00.000Z',
      timestamp: '2026-07-18T12:01:00.000Z',
      status: 'failed',
      actualModel: 'gpt-5.6',
      modelLabel: 'GPT-5.6',
      errorMessage: 'The provider refused.',
      parts: parts(seed.assistantMessageId)
    })

    const branded = projected.chat.messages.filter((message) => message.role !== 'user')
    expect(branded.map((message) => message.role)).toEqual(['assistant', 'tool', 'error'])
    for (const message of branded) {
      expect(message.metadata).toMatchObject({
        kind: 'executionGraphAttemptOutput',
        providerModel: 'gpt-5.6',
        providerModelLabel: 'GPT-5.6'
      })
    }
  })

  it('falls back to the seeded requested model when the provider reports none', () => {
    // Pi deliberately leaves `actualModel` unset -- its terminal event reports a
    // human label, and a label cannot resolve a Pi upstream, which is keyed on a
    // `<upstream>/<model>` wire id. The seeded requested model is the only wire
    // id this lane ever has for that seat.
    const seed = seeded('deepseek/v4-pro')
    const projected = projectExecutionGraphAttemptTranscript({
      chat: seed.chat,
      binding,
      promptMessageId: seed.promptMessageId,
      startedAt: '2026-07-18T12:00:00.000Z',
      timestamp: '2026-07-18T12:01:00.000Z',
      status: 'completed',
      modelLabel: 'DeepSeek V4 Pro',
      parts: parts(seed.assistantMessageId)
    })

    expect(projected.chat.messages[1].metadata).toMatchObject({
      providerModel: 'deepseek/v4-pro',
      providerModelLabel: 'DeepSeek V4 Pro'
    })
  })

  it('leaves a model-less attempt exactly as bare as it was', () => {
    // The floor. Without it an un-modelled attempt would gain empty keys that
    // out-rank the run lookup in the renderer and brand the row as nothing.
    const seed = seeded()
    const projected = projectExecutionGraphAttemptTranscript({
      chat: seed.chat,
      binding,
      promptMessageId: seed.promptMessageId,
      startedAt: '2026-07-18T12:00:00.000Z',
      timestamp: '2026-07-18T12:01:00.000Z',
      status: 'completed',
      parts: parts(seed.assistantMessageId)
    })

    for (const message of projected.chat.messages.filter((m) => m.role !== 'user')) {
      expect(Object.keys(message.metadata || {}).sort()).toEqual([
        'activationId',
        'attemptId',
        'executionId',
        'kind',
        'provider',
        'providerRunRef',
        'rootChatId',
        'schemaVersion',
        'workspaceId'
      ])
    }
  })

  it('carries the model label onto the run beside the actual model', () => {
    const seed = seeded('gpt-5.6')
    const projected = projectExecutionGraphAttemptTranscript({
      chat: seed.chat,
      binding,
      promptMessageId: seed.promptMessageId,
      startedAt: '2026-07-18T12:00:00.000Z',
      timestamp: '2026-07-18T12:01:00.000Z',
      status: 'completed',
      actualModel: 'gpt-5.6',
      modelLabel: 'GPT-5.6',
      parts: parts(seed.assistantMessageId)
    })

    expect(projected.chat.runs[0]).toMatchObject({
      actualModel: 'gpt-5.6',
      modelLabel: 'GPT-5.6'
    })
  })

  it('keeps the attempt binding verifiable with the stamp present', () => {
    // The reason this lane could not simply copy the other two: its rows are
    // evidence. `executionGraphAttemptEvidenceContent` re-derives the binding
    // from each row's metadata, and the terminal receipt digests the assistant
    // content. Both must survive two new metadata keys, or a stamped attempt
    // fails to seal and the run is unrecoverable.
    const seed = seeded('gpt-5.6')
    const projected = projectExecutionGraphAttemptTranscript({
      chat: seed.chat,
      binding,
      promptMessageId: seed.promptMessageId,
      startedAt: '2026-07-18T12:00:00.000Z',
      timestamp: '2026-07-18T12:01:00.000Z',
      status: 'completed',
      actualModel: 'gpt-5.6',
      modelLabel: 'GPT-5.6',
      parts: parts(seed.assistantMessageId)
    })
    const receipt = buildExecutionGraphAttemptTerminalReceipt({
      binding,
      status: 'completed',
      committedAt: '2026-07-18T12:01:01.000Z',
      prompt: 'Implement the change.',
      content: 'Implemented the change.',
      evidenceRefs: projected.evidenceRefs
    })
    const committed = attachExecutionGraphAttemptReceipt(projected.chat, receipt)

    expect(verifyExecutionGraphAttemptReceiptOnChat(committed, receipt)).toBe(true)
  })

  it('passes the run label through the only call site that projects an attempt', () => {
    // `projectAndPersistExecutionGraphRunTranscript` lives in the monolith where
    // no unit test reaches it, and the field is optional on the input type, so
    // dropping it would be silent. Same idiom the bridge lane's guard uses.
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    expect(source).toContain('...(state.modelLabel ? { modelLabel: state.modelLabel } : {}),')
  })
})
