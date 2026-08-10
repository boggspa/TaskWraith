import { describe, expect, it } from 'vitest'
import type { ChatRecord, SubThreadJoinPolicy } from './store/types'
import {
  buildLinkedChildReturnContent,
  decideLinkedChildReturn,
  markLinkedChildResultReturned,
  resolveParallelResultWaveId
} from './LinkedChildReturn'

/**
 * Phase F2 — pure-function tests for the sub-thread result back-
 * propagation logic.
 *
 * The AppStore wiring remains in index.ts; the gate and content builder live
 * in LinkedChildReturn so delegated sub-threads and opted-in side chats cannot
 * drift into different trust or idempotency semantics.
 */

function makeChat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    scope: 'workspace',
    provider: 'codex',
    title: 'Sub-thread',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    archived: false,
    messages: [],
    runs: [],
    ...overrides
  }
}

describe('Phase F2 — sub-thread return decision', () => {
  it('refuses propagation when chat has no parentChatId', () => {
    const chat = makeChat()
    const decision = decideLinkedChildReturn(chat)
    expect(decision.shouldPropagate).toBe(false)
    expect(decision.reason).toBe('no parentChatId')
  })

  it('refuses propagation when returnResultToParent is false', () => {
    const chat = makeChat({
      parentChatId: 'parent-1',
      delegationContext: {
        createdAt: Date.now(),
        parentProvider: 'claude',
        delegationPrompt: 'Run the build',
        returnResultToParent: false
      },
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: 'Build succeeded',
          timestamp: new Date().toISOString()
        }
      ]
    })
    const decision = decideLinkedChildReturn(chat)
    expect(decision.shouldPropagate).toBe(false)
    expect(decision.reason).toBe('returnResultToParent=false')
  })

  it('refuses propagation when already propagated', () => {
    const chat = makeChat({
      parentChatId: 'parent-1',
      delegationContext: {
        createdAt: Date.parse('2026-01-01T00:00:00Z'),
        parentProvider: 'claude',
        delegationPrompt: 'Run the build',
        returnResultToParent: true,
        resultReturnedAt: Date.parse('2026-01-01T00:00:30Z')
      },
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: 'Build succeeded',
          timestamp: '2026-01-01T00:00:10Z'
        }
      ]
    })
    const decision = decideLinkedChildReturn(chat)
    expect(decision.shouldPropagate).toBe(false)
    expect(decision.reason).toBe('already propagated')
  })

  it('propagates a later recall result after an earlier result was returned', () => {
    const chat = makeChat({
      parentChatId: 'parent-1',
      delegationContext: {
        createdAt: Date.parse('2026-01-01T00:00:00Z'),
        parentProvider: 'claude',
        delegationPrompt: 'Run the build',
        returnResultToParent: true,
        resultReturnedAt: Date.parse('2026-01-01T00:00:30Z')
      },
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: 'Build succeeded',
          timestamp: '2026-01-01T00:00:10Z'
        },
        {
          id: 'm2',
          role: 'user',
          content: 'Show the second failure',
          timestamp: '2026-01-01T00:00:40Z'
        },
        {
          id: 'm3',
          role: 'assistant',
          content: 'Second failure details.',
          timestamp: '2026-01-01T00:00:50Z'
        }
      ]
    })
    const decision = decideLinkedChildReturn(chat)
    expect(decision.shouldPropagate).toBe(true)
    expect(decision.shouldPropagate && decision.lastAssistant?.content).toBe(
      'Second failure details.'
    )
  })

  it('refuses propagation when no assistant message exists', () => {
    const chat = makeChat({
      parentChatId: 'parent-1',
      delegationContext: {
        createdAt: Date.now(),
        parentProvider: 'claude',
        delegationPrompt: 'Run the build',
        returnResultToParent: true
      },
      messages: [{ id: 'm1', role: 'user', content: 'Run it', timestamp: new Date().toISOString() }]
    })
    const decision = decideLinkedChildReturn(chat)
    expect(decision.shouldPropagate).toBe(false)
    expect(decision.reason).toBe('no assistant message')
  })

  it('refuses propagation when the assistant message is empty', () => {
    const chat = makeChat({
      parentChatId: 'parent-1',
      delegationContext: {
        createdAt: Date.now(),
        parentProvider: 'claude',
        delegationPrompt: 'Run the build',
        returnResultToParent: true
      },
      messages: [
        { id: 'm1', role: 'assistant', content: '   \n  ', timestamp: new Date().toISOString() }
      ]
    })
    const decision = decideLinkedChildReturn(chat)
    expect(decision.shouldPropagate).toBe(false)
    expect(decision.reason).toBe('no assistant message')
  })

  it('propagates the LAST assistant message when multiple exist', () => {
    const chat = makeChat({
      parentChatId: 'parent-1',
      delegationContext: {
        createdAt: Date.now(),
        parentProvider: 'claude',
        delegationPrompt: 'Run the build',
        returnResultToParent: true
      },
      messages: [
        { id: 'm1', role: 'user', content: 'Run it', timestamp: '2026-01-01T00:00:00Z' },
        { id: 'm2', role: 'assistant', content: 'Starting…', timestamp: '2026-01-01T00:00:01Z' },
        { id: 'm3', role: 'user', content: 'and then?', timestamp: '2026-01-01T00:00:02Z' },
        { id: 'm4', role: 'assistant', content: 'All done.', timestamp: '2026-01-01T00:00:03Z' }
      ]
    })
    const decision = decideLinkedChildReturn(chat)
    expect(decision.shouldPropagate).toBe(true)
    expect(decision.shouldPropagate && decision.lastAssistant?.content).toBe('All done.')
    expect(decision.shouldPropagate && decision.parentChatId).toBe('parent-1')
  })

  it('propagates when all preconditions are satisfied', () => {
    const chat = makeChat({
      parentChatId: 'parent-1',
      delegationContext: {
        createdAt: Date.now(),
        parentProvider: 'claude',
        delegationPrompt: 'Run swift build',
        returnResultToParent: true
      },
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: 'Build succeeded with 3 warnings.',
          timestamp: new Date().toISOString()
        }
      ]
    })
    const decision = decideLinkedChildReturn(chat)
    expect(decision.shouldPropagate).toBe(true)
    expect(decision.shouldPropagate && decision.lastAssistant?.content).toBe(
      'Build succeeded with 3 warnings.'
    )
  })

  it('ignores tool / error / system messages when finding the result', () => {
    const chat = makeChat({
      parentChatId: 'parent-1',
      delegationContext: {
        createdAt: Date.now(),
        parentProvider: 'claude',
        delegationPrompt: 'Run swift build',
        returnResultToParent: true
      },
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: 'Running build',
          timestamp: '2026-01-01T00:00:00Z'
        },
        { id: 'm2', role: 'tool', content: '{"output":"..."}', timestamp: '2026-01-01T00:00:01Z' },
        { id: 'm3', role: 'system', content: 'note', timestamp: '2026-01-01T00:00:02Z' },
        { id: 'm4', role: 'error', content: 'transient', timestamp: '2026-01-01T00:00:03Z' }
      ]
    })
    const decision = decideLinkedChildReturn(chat)
    // The last *assistant* message is 'Running build' — that's what we propagate.
    expect(decision.shouldPropagate).toBe(true)
    expect(decision.shouldPropagate && decision.lastAssistant?.content).toBe('Running build')
  })
})

describe('opt-in side-chat authority return', () => {
  const sideChat = (overrides: Partial<ChatRecord> = {}): ChatRecord =>
    makeChat({
      title: 'Async design room',
      parentChatId: 'parent-1',
      parentChatRelation: 'sideChat',
      sideChatContext: {
        createdAt: Date.parse('2026-01-01T00:00:00Z'),
        returnResultToParent: true,
        returnResultEnabledAt: Date.parse('2026-01-01T00:00:10Z')
      },
      ...overrides
    })

  it('keeps ordinary side chats silent by default', () => {
    const decision = decideLinkedChildReturn(
      sideChat({
        sideChatContext: { createdAt: Date.now() },
        messages: [
          {
            id: 'answer-1',
            role: 'assistant',
            runId: 'run-1',
            content: 'Independent answer.',
            timestamp: '2026-01-01T00:01:00Z'
          }
        ]
      }),
      { outcome: 'done', sourceRunId: 'run-1' }
    )

    expect(decision).toEqual({
      shouldPropagate: false,
      reason: 'returnResultToParent=false'
    })
  })

  it('returns only the exact opted-in terminal run result', () => {
    const decision = decideLinkedChildReturn(
      sideChat({
        messages: [
          {
            id: 'old-answer',
            role: 'assistant',
            runId: 'run-old',
            content: 'Old isolated answer.',
            timestamp: '2026-01-01T00:00:05Z'
          },
          {
            id: 'answer-1',
            role: 'assistant',
            runId: 'run-1',
            content: 'Fresh side-chat result.',
            timestamp: '2026-01-01T00:01:00Z'
          }
        ]
      }),
      { outcome: 'done', sourceRunId: 'run-1' }
    )

    expect(decision).toMatchObject({
      shouldPropagate: true,
      relation: 'sideChat',
      parentChatId: 'parent-1',
      sourceAssistantMessageId: 'answer-1',
      resultContent: 'Fresh side-chat result.'
    })
  })

  it('does not return output created before the user opted in', () => {
    const decision = decideLinkedChildReturn(
      sideChat({
        messages: [
          {
            id: 'answer-1',
            role: 'assistant',
            runId: 'run-1',
            content: 'Older answer.',
            timestamp: '2026-01-01T00:00:05Z'
          }
        ]
      }),
      { outcome: 'done', sourceRunId: 'run-1' }
    )

    expect(decision).toEqual({ shouldPropagate: false, reason: 'output predates opt-in' })
  })

  it('keeps typed failure evidence even when the side chat produced no answer', () => {
    const decision = decideLinkedChildReturn(sideChat(), {
      outcome: 'failed',
      sourceRunId: 'run-failed',
      errorMessage: 'provider unavailable'
    })

    expect(decision).toMatchObject({
      shouldPropagate: true,
      relation: 'sideChat',
      sourceAssistantMessageId: 'linked-child-terminal-run-failed-failed',
      resultContent: 'Linked child run failed: provider unavailable'
    })
  })

  it('marks only side-chat return state and preserves isolation metadata', () => {
    const updated = markLinkedChildResultReturned(
      sideChat(),
      'sideChat',
      Date.parse('2026-01-01T00:02:00Z'),
      'answer-1'
    )

    expect(updated.sideChatContext).toMatchObject({
      returnResultToParent: true,
      resultReturnedAt: Date.parse('2026-01-01T00:02:00Z'),
      lastReturnedMessageId: 'answer-1'
    })
    expect(updated.delegationContext).toBeUndefined()
  })

  it('archives ephemeral sub-thread children on typed return and leaves durable alone', () => {
    const ephemeral = markLinkedChildResultReturned(
      {
        appChatId: 'child-e',
        scope: 'workspace',
        chatKind: 'single',
        provider: 'codex',
        title: 'scout',
        createdAt: 1,
        updatedAt: 1,
        archived: false,
        messages: [],
        runs: [],
        parentChatId: 'parent',
        parentChatRelation: 'subThread',
        delegationContext: {
          createdAt: 1,
          parentProvider: 'codex',
          delegationPrompt: 'go',
          returnResultToParent: true,
          lifecycle: 'ephemeral'
        }
      },
      'subThread',
      Date.parse('2026-01-01T00:02:00Z'),
      'asst-1'
    )
    expect(ephemeral.archived).toBe(true)
    expect(ephemeral.delegationContext?.resultReturnedAt).toBe(Date.parse('2026-01-01T00:02:00Z'))

    const durable = markLinkedChildResultReturned(
      {
        appChatId: 'child-d',
        scope: 'workspace',
        chatKind: 'single',
        provider: 'codex',
        title: 'worker',
        createdAt: 1,
        updatedAt: 1,
        archived: false,
        messages: [],
        runs: [],
        parentChatId: 'parent',
        parentChatRelation: 'subThread',
        delegationContext: {
          createdAt: 1,
          parentProvider: 'codex',
          delegationPrompt: 'go',
          returnResultToParent: true,
          lifecycle: 'durable'
        }
      },
      'subThread',
      Date.parse('2026-01-01T00:02:00Z'),
      'asst-2'
    )
    expect(durable.archived).toBe(false)
  })

  it('uses a distinct untrusted side-chat envelope', () => {
    const content = buildLinkedChildReturnContent({
      relation: 'sideChat',
      label: 'Codex',
      title: 'Async design room',
      childId: 'side-1',
      result: 'A bounded result.',
      outcome: 'done'
    })

    expect(content).toContain('Side-chat result from Codex side-chat')
    expect(content).toContain('untrusted linked-child output')
    expect(content).toContain('<side_chat_result>\nA bounded result.\n</side_chat_result>')
  })
})

describe('resolveParallelResultWaveId', () => {
  const join = (groupId: string): SubThreadJoinPolicy => ({
    schemaVersion: 1,
    groupId,
    required: true,
    debounceMs: 250,
    armedAt: '2026-01-01T00:00:00.000Z',
    deadlineAt: '2026-01-01T00:05:00.000Z'
  })

  it('returns the mailbox event join groupId when present', () => {
    expect(resolveParallelResultWaveId(join('parent-run-1'), join('child-fallback'))).toBe(
      'parent-run-1'
    )
  })

  it('falls back to the child join groupId when the event has no join', () => {
    expect(resolveParallelResultWaveId(undefined, join('parent-run-2'))).toBe('parent-run-2')
  })

  it('omits a wave id when neither join carries a groupId (side chats / legacy)', () => {
    expect(resolveParallelResultWaveId(undefined, undefined)).toBeUndefined()
    expect(resolveParallelResultWaveId(join('   '), join(''))).toBeUndefined()
  })

  it('never invents a parent-run or synthetic id', () => {
    expect(resolveParallelResultWaveId(null, null)).toBeUndefined()
    expect(resolveParallelResultWaveId({ groupId: undefined as unknown as string }, null)).toBeUndefined()
  })
})
