import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import { groupAdjacentToolMessages } from '../lib/transcriptToolMessageGrouping'
import { toolStackStateKey } from './TranscriptPanel'

const toolMessage = (id: string, toolId: string): ChatMessage => ({
  id,
  role: 'tool',
  content: '',
  timestamp: '2026-01-01T00:00:00.000Z',
  runId: 'run-1',
  toolActivities: [
    {
      id: toolId,
      toolName: 'claude_thinking',
      displayName: 'Claude thinking',
      category: 'unknown',
      status: 'success',
      startedAt: '2026-01-01T00:00:00.000Z',
      parameters: { kind: 'reasoning' }
    } as NonNullable<ChatMessage['toolActivities']>[number]
  ]
})

describe('toolStackStateKey', () => {
  it('stays stable while a tool group grows (1 → 2 messages churns the merged id)', () => {
    // The reported collapse: expanding the live viewport on a single tool
    // message, then new activity streams in — the grouped row's id mutates
    // from `<id>` to `tool-group-<id>`, remounting the stack. The lifted
    // expansion state must key on something that survives that transition.
    const first = toolMessage('tool-1', 'claude-thinking-run-1')
    const [singleton] = groupAdjacentToolMessages([first])
    const keyBefore = toolStackStateKey(singleton)

    const second = toolMessage('tool-2', 'call-abc')
    const [grown] = groupAdjacentToolMessages([first, second])
    expect(grown.id).not.toBe(singleton.id) // the churn that used to reset state
    expect(toolStackStateKey(grown)).toBe(keyBefore)

    const third = toolMessage('tool-3', 'call-def')
    const [grownAgain] = groupAdjacentToolMessages([first, second, third])
    expect(toolStackStateKey(grownAgain)).toBe(keyBefore)
  })

  it('falls back to the message id for ungrouped rows', () => {
    const solo = toolMessage('tool-solo', 'call-1')
    expect(toolStackStateKey(solo)).toBe('tool-solo')
  })
})
