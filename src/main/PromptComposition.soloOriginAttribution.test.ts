import { describe, expect, it } from 'vitest'
import { buildConversationContextProjection } from './PromptComposition'
import type { ChatMessage } from './store/types'

/**
 * A solo chat's history is rendered as `Speaker: text`. A row that arrived
 * over the local-control socket is not the operator speaking, and saying
 * "User" there is the same failure the ensemble serializer already fixes: the
 * receiving model reads an external agent's words as its operator's.
 */
function row(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1',
    role: 'user',
    content: 'rebase onto master first',
    timestamp: '2026-09-09T10:00:00.000Z',
    ...overrides
  } as ChatMessage
}

const origin = { channel: 'local-control' as const, pid: 84536, label: 'Claude Code' }

describe('solo conversation context attributes a socket row', () => {
  it('names the external agent instead of calling it the user', () => {
    const projection = buildConversationContextProjection(
      [row({ metadata: { origin } }), row({ id: 'm2', role: 'assistant', content: 'will do' })],
      3,
      ''
    )
    expect(projection.block).toContain(
      'External Agent · Claude Code · PID 84536: rebase onto master first'
    )
    expect(projection.block).not.toContain('User: rebase onto master first')
  })

  it('still names an anonymous socket sender as external', () => {
    const projection = buildConversationContextProjection(
      [row({ metadata: { origin: { channel: 'local-control' } } })],
      3,
      ''
    )
    expect(projection.block).toContain('External Agent: rebase onto master first')
  })

  it('leaves a row the operator typed as the user', () => {
    const projection = buildConversationContextProjection([row({})], 3, '')
    expect(projection.block).toContain('User: rebase onto master first')
    expect(projection.block).not.toContain('External Agent')
  })

  it('never renames an assistant row, whatever metadata it carries', () => {
    const projection = buildConversationContextProjection(
      [row({ id: 'a1', role: 'assistant', content: 'done', metadata: { origin } })],
      3,
      ''
    )
    expect(projection.block).toContain('Assistant: done')
    expect(projection.block).not.toContain('External Agent')
  })

  it('reports the same supplied ids as before, so budgeting is unchanged', () => {
    const projection = buildConversationContextProjection(
      [row({ metadata: { origin } }), row({ id: 'm2', role: 'assistant', content: 'ok' })],
      3,
      ''
    )
    expect(projection.suppliedMessageIds).toEqual(['m1', 'm2'])
  })
})
