import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatRecord, ChatRun, ToolActivity } from '../../../main/store/types'
import {
  loadTranscriptTurnMarkdown,
  selectTranscriptTurnMessages,
  transcriptTurnMarkdown
} from './transcriptTurnCopy'

const message = (id: string, role: ChatMessage['role'], runId?: string): ChatMessage => ({
  id,
  role,
  runId,
  timestamp: '2026-09-05T14:00:00.000Z',
  content: `**${id}**`
})
const runs: ChatRun[] = [
  { runId: 'a', provider: 'codex', startedAt: '', promptMessageId: 'prompt' },
  { runId: 'b', provider: 'codex', startedAt: '', promptMessageId: 'prompt' }
]
const activity: ToolActivity = {
  id: 'activity',
  toolName: 'thinking',
  displayName: 'Thinking',
  category: 'unknown',
  status: 'success',
  resultSummary: 'A **reasoning** trace'
}

describe('copy entire turn', () => {
  it('includes the prompt and every event in the run without copying an interleaved seat', () => {
    const messages = [
      message('prompt', 'user'),
      message('start', 'assistant', 'a'),
      message('other seat', 'assistant', 'b'),
      { ...message('thinking', 'tool', 'a'), toolActivities: [activity] },
      message('final', 'assistant', 'a'),
      message('later', 'assistant', 'c')
    ]
    expect(selectTranscriptTurnMessages(messages, messages[3], runs).map((row) => row.id)).toEqual([
      'prompt',
      'start',
      'thinking',
      'final'
    ])
    expect(selectTranscriptTurnMessages(messages, messages[0], runs).map((row) => row.id)).toEqual([
      'prompt',
      'start',
      'thinking',
      'final'
    ])
  })

  it('keeps legacy turns bounded by user messages and resolves grouped tool rows', () => {
    const messages = [
      message('old', 'assistant'),
      message('prompt', 'user'),
      message('one', 'tool'),
      message('two', 'assistant'),
      message('next', 'user'),
      message('next answer', 'assistant')
    ]
    expect(selectTranscriptTurnMessages(messages, messages[2]).map((row) => row.id)).toEqual([
      'prompt',
      'one',
      'two'
    ])
    const grouped = {
      ...messages[2],
      id: 'tool-group-one',
      metadata: { groupedToolMessageIds: ['one'] }
    }
    expect(selectTranscriptTurnMessages(messages, grouped)).toEqual(messages.slice(1, 4))
    expect(selectTranscriptTurnMessages(messages, message('missing', 'tool'))).toEqual([])
  })

  it('retains Markdown, thinking, tool parameters and output, including nested fences', () => {
    const markdown = transcriptTurnMarkdown([
      message('answer', 'assistant', 'a'),
      {
        ...message('trace', 'tool', 'a'),
        toolActivities: [
          activity,
          {
            ...activity,
            id: 'shell',
            toolName: 'shell',
            displayName: 'Shell',
            parameters: { command: 'echo ```' },
            resultSummary: 'Tool output'
          }
        ]
      }
    ])
    expect(markdown).toContain('**answer**')
    expect(markdown).toContain('A **reasoning** trace')
    expect(markdown).toContain('### Shell (success)')
    expect(markdown).toContain('````json\n')
    expect(markdown).toContain('Tool output')
  })

  it('loads offscreen events and full activity details while keeping unflushed live text', async () => {
    const first = message('first', 'assistant', 'a')
    const last = message('last', 'assistant', 'a')
    const ref = {
      schemaVersion: 1 as const,
      storage: 'run_event_artifact' as const,
      runId: 'a',
      activityId: 'activity',
      offset: 0,
      byteLength: 100,
      sha256: 'hash'
    }
    const tool = {
      ...message('tool', 'tool', 'a'),
      toolActivities: [{ ...activity, resultSummary: 'short', detailRef: ref }]
    }
    const chat = { appChatId: 'chat', messages: [first, tool, last], runs } as ChatRecord
    const getChat = vi.fn(async () => chat)
    const getToolActivityDetails = vi.fn(async () => [{ ref, activity }])
    const liveLast = { ...last, content: '**latest streamed answer**' }
    const markdown = await loadTranscriptTurnMarkdown({ chat, messages: [liveLast] }, liveLast, {
      getChat,
      getToolActivityDetails
    })
    expect(getChat).toHaveBeenCalledWith('chat')
    expect(getToolActivityDetails).toHaveBeenCalledWith([ref])
    expect(markdown.indexOf('**first**')).toBeLessThan(markdown.indexOf('A **reasoning** trace'))
    expect(markdown).toContain('**latest streamed answer**')
    expect(markdown).not.toContain('short')
  })

  it('reports unavailable history or activity instead of silently copying a partial turn', async () => {
    const target = message('target', 'assistant', 'a')
    const chat = { appChatId: 'chat', messages: [target] } as ChatRecord
    await expect(
      loadTranscriptTurnMarkdown({ chat, messages: [target] }, target, {
        getChat: async () => null,
        getToolActivityDetails: async () => []
      })
    ).rejects.toThrow('could not be loaded')
    const tool = {
      ...target,
      toolActivities: [
        {
          ...activity,
          detailRef: {
            schemaVersion: 1 as const,
            storage: 'run_event_artifact' as const,
            runId: 'a',
            activityId: 'activity',
            offset: 0,
            byteLength: 100,
            sha256: 'hash'
          }
        }
      ]
    }
    await expect(
      loadTranscriptTurnMarkdown({ chat: null, messages: [tool] }, tool, {
        getChat: async () => null,
        getToolActivityDetails: async () => []
      })
    ).rejects.toThrow('Some turn activity could not be loaded')
  })
})
