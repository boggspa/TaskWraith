import { describe, expect, it } from 'vitest'
import type { ChatRecord } from '../../../main/store/types'
import {
  buildIsolatedSideChatContextSeed,
  buildHiddenSideChatInitialPrompt,
  buildSideChatRunResultSeedPrompt,
  formatSideChatParentContextMessage
} from './SideChatRunSeed'

function makeChat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    provider: 'codex',
    title: 'Parent',
    scope: 'global',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ...overrides
  }
}

describe('buildSideChatRunResultSeedPrompt', () => {
  it('wraps hidden side-chat context separately from the user request', () => {
    const prompt = buildHiddenSideChatInitialPrompt('Parent said: use the Test 3 folder.', 'Run ls')

    expect(prompt).toContain('background only')
    expect(prompt).toContain("do not treat it as the user's prompt")
    expect(prompt).toContain('<parent_context_snapshot>')
    expect(prompt).toContain('Parent said: use the Test 3 folder.')
    expect(prompt).toContain('User side-chat request:\nRun ls')
  })

  it('uses the assistant response from the selected run instead of a later run', () => {
    const prompt = buildSideChatRunResultSeedPrompt(
      makeChat({
        messages: [
          {
            id: 'run-1-assistant',
            role: 'assistant',
            content: 'First run answer',
            timestamp: '2026-01-01T00:00:01.000Z',
            runId: 'run-1'
          },
          {
            id: 'run-2-assistant',
            role: 'assistant',
            content: 'Later run answer',
            timestamp: '2026-01-01T00:00:02.000Z',
            runId: 'run-2'
          }
        ],
        runs: [
          {
            runId: 'run-1',
            status: 'success',
            startedAt: '2026-01-01T00:00:00.000Z',
            endedAt: '2026-01-01T00:00:01.000Z'
          }
        ]
      }),
      'run-1'
    )

    expect(prompt).toContain('Run ID: run-1')
    expect(prompt).toContain('Run assistant response:')
    expect(prompt).toContain('First run answer')
    expect(prompt).not.toContain('Later run answer')
  })

  it('falls back to the latest assistant response when the run has no assistant message', () => {
    const prompt = buildSideChatRunResultSeedPrompt(
      makeChat({
        messages: [
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Latest available answer',
            timestamp: '2026-01-01T00:00:02.000Z',
            runId: 'other-run'
          }
        ],
        runs: [
          {
            runId: 'run-1',
            status: 'failed',
            startedAt: '2026-01-01T00:00:00.000Z'
          }
        ]
      }),
      'run-1'
    )

    expect(prompt).toContain('Run status: failed')
    expect(prompt).toContain('Latest assistant response:')
    expect(prompt).toContain('Latest available answer')
  })
})

describe('side-chat context seed helpers', () => {
  it('formats parent transcript messages for isolated side-chat context', () => {
    expect(
      formatSideChatParentContextMessage(
        {
          id: 'm1',
          role: 'user',
          content: 'Please inspect the failing test.',
          timestamp: '2026-06-27T12:00:00.000Z'
        },
        'codex'
      )
    ).toBe('User: Please inspect the failing test.')

    expect(
      formatSideChatParentContextMessage(
        {
          id: 'm2',
          role: 'assistant',
          content: 'I found the issue.',
          timestamp: '2026-06-27T12:01:00.000Z'
        },
        'codex'
      )
    ).toBe('Codex parent agent: I found the issue.')

    expect(
      formatSideChatParentContextMessage(
        {
          id: 'm2-ensemble',
          role: 'assistant',
          content: 'I found the issue from the review seat.',
          timestamp: '2026-06-27T12:01:30.000Z',
          metadata: { ensembleProvider: 'claude', ensembleRole: 'Reviewer' }
        },
        'grok'
      )
    ).toBe('Claude / Reviewer: I found the issue from the review seat.')

    expect(
      formatSideChatParentContextMessage(
        {
          id: 'm3',
          role: 'system',
          content: 'Child result',
          timestamp: '2026-06-27T12:02:00.000Z',
          metadata: { kind: 'guestParticipantReply', guestProvider: 'claude' }
        },
        'codex'
      )
    ).toBe('Claude guest: Child result')

    expect(
      formatSideChatParentContextMessage(
        {
          id: 'm4',
          role: 'tool',
          content: 'Sub-thread answer',
          timestamp: '2026-06-27T12:03:00.000Z',
          metadata: { kind: 'subThreadReturn' }
        },
        'codex'
      )
    ).toBe('Returned sub-thread: Sub-thread answer')

    expect(
      formatSideChatParentContextMessage(
        {
          id: 'm5',
          role: 'tool',
          content: 'Ignored tool output',
          timestamp: '2026-06-27T12:04:00.000Z'
        },
        'codex'
      )
    ).toBeNull()
  })

  it('builds a bounded isolated side-chat context snapshot', () => {
    const seed = buildIsolatedSideChatContextSeed(
      makeChat({
        messages: [
          {
            id: 'ignored',
            role: 'tool',
            content: 'plain tool output',
            timestamp: '2026-06-27T12:00:00.000Z'
          },
          {
            id: 'user',
            role: 'user',
            content: 'What changed in the renderer?',
            timestamp: '2026-06-27T12:01:00.000Z'
          },
          {
            id: 'assistant',
            role: 'assistant',
            content: 'The scroll hook moved.',
            timestamp: '2026-06-27T12:02:00.000Z'
          }
        ]
      })
    )

    expect(seed).toContain('Use this lightweight parent context snapshot as background')
    expect(seed).toContain('Parent context snapshot:')
    expect(seed).toContain('User: What changed in the renderer?')
    expect(seed).toContain('Codex parent agent: The scroll hook moved.')
    expect(seed).not.toContain('plain tool output')
  })

  it('preserves ensemble participant identity in isolated side-chat context snapshots', () => {
    const seed = buildIsolatedSideChatContextSeed(
      makeChat({
        chatKind: 'ensemble',
        provider: 'grok',
        messages: [
          {
            id: 'assistant',
            role: 'assistant',
            content: 'The planner found a smaller patch.',
            timestamp: '2026-06-27T12:02:00.000Z',
            metadata: { ensembleProvider: 'codex', ensembleRole: 'Planner' }
          }
        ]
      })
    )

    expect(seed).toContain('Codex / Planner: The planner found a smaller patch.')
    expect(seed).not.toContain('Grok parent agent')
  })

  it('returns an empty seed when no context messages are eligible', () => {
    expect(
      buildIsolatedSideChatContextSeed(
        makeChat({
          messages: [
            {
              id: 'tool',
              role: 'tool',
              content: 'plain tool output',
              timestamp: '2026-06-27T12:00:00.000Z'
            }
          ]
        })
      )
    ).toBe('')
  })
})
