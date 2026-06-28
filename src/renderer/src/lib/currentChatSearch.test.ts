import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import {
  buildCurrentChatSearchTargets,
  findCurrentChatSearchMatches,
  normalizeCurrentChatSearchQuery
} from './currentChatSearch'

const message = (partial: Partial<ChatMessage>): ChatMessage => ({
  id: partial.id || 'msg-1',
  role: partial.role || 'assistant',
  content: partial.content || '',
  timestamp: partial.timestamp || '2026-06-28T18:00:00.000Z',
  ...partial
})

describe('current chat search', () => {
  it('normalizes whitespace and case', () => {
    expect(normalizeCurrentChatSearchQuery('  Provider   FAILURE  ')).toBe('provider failure')
  })

  it('matches system notices from message content', () => {
    const targets = buildCurrentChatSearchTargets([
      message({
        id: 'sys-1',
        role: 'system',
        content: 'Gemini has been retired. Existing chats are preserved.'
      })
    ])

    const matches = findCurrentChatSearchMatches(targets, 'retired')

    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({ messageId: 'sys-1', label: 'System' })
  })

  it('matches across line breaks when the query uses spaces', () => {
    const targets = buildCurrentChatSearchTargets([
      message({ id: 'sys-2', role: 'system', content: 'First line\nsecond line' })
    ])

    expect(findCurrentChatSearchMatches(targets, 'line second')).toHaveLength(1)
  })

  it('matches provider failure metadata lines even when content is empty', () => {
    const targets = buildCurrentChatSearchTargets([
      message({
        id: 'failure-1',
        role: 'system',
        content: '',
        metadata: {
          kind: 'providerRunFailure',
          headline: 'Ollama failed',
          lines: [{ text: 'connection refused on localhost:11434' }]
        }
      })
    ])

    const matches = findCurrentChatSearchMatches(targets, 'localhost:11434')

    expect(matches).toHaveLength(1)
    expect(matches[0].label).toBe('Provider failure')
    expect(matches[0].preview).toContain('connection refused')
  })

  it('matches tool activity names, parameters, and output summaries', () => {
    const targets = buildCurrentChatSearchTargets([
      message({
        id: 'tool-1',
        role: 'tool',
        content: '',
        toolActivities: [
          {
            id: 'activity-1',
            toolName: 'run_shell_command',
            displayName: 'Shell',
            category: 'shell',
            status: 'error',
            parameters: { command: 'npm run typecheck:web' },
            resultSummary: 'TS2322: Type mismatch in Composer.tsx',
            diffSummary: {
              source: 'content',
              confidence: 'exact',
              additions: 4,
              deletions: 1,
              files: [{ path: 'src/renderer/src/components/Composer.tsx', additions: 4 }]
            }
          }
        ]
      })
    ])

    expect(findCurrentChatSearchMatches(targets, 'typecheck:web')).toHaveLength(1)
    expect(findCurrentChatSearchMatches(targets, 'TS2322')).toHaveLength(1)
    expect(findCurrentChatSearchMatches(targets, 'Composer.tsx')).toHaveLength(1)
  })

  it('carries row keys so duplicate message ids can jump to the selected occurrence', () => {
    const targets = buildCurrentChatSearchTargets([
      message({ id: 'duplicate', role: 'assistant', content: 'first answer' }),
      message({ id: 'duplicate', role: 'assistant', content: 'second answer' })
    ])

    const matches = findCurrentChatSearchMatches(targets, 'answer')

    expect(matches.map((match) => match.rowKey)).toEqual(['duplicate#0', 'duplicate#1'])
  })
})
