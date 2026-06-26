import { describe, expect, it } from 'vitest'
import type { ChatRecord, ToolActivity } from '../../../main/store/types'
import {
  buildComposerPlanLanes,
  composerPlanLaneLabel,
  computeComposerPlanPopoverPosition
} from './ComposerPlanPopoverButton'

function todo(id: string, content: string) {
  return { id, content, status: 'pending' as const }
}

function chat(overrides: Partial<ChatRecord>): ChatRecord {
  return {
    appChatId: 'chat-1',
    title: 'Chat',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    ...overrides
  } as ChatRecord
}

function activity(
  id: string,
  participantId: string,
  provider: 'codex' | 'claude',
  content: string
): ToolActivity {
  return {
    id,
    toolName: 'todo_write',
    displayName: 'todo_write',
    category: 'task',
    parameters: {
      todos: [todo(id, content)]
    },
    status: 'success',
    metadata: {
      ensembleParticipantId: participantId,
      ensembleProvider: provider,
      provider
    }
  } as ToolActivity
}

describe('ComposerPlanPopoverButton helpers', () => {
  it('keeps same-provider persisted participant lanes separate', () => {
    const record = chat({
      chatTodos: {
        'codex-reviewer': [todo('review', 'Review the patch')],
        'codex-builder': [todo('build', 'Apply the fix')]
      },
      ensemble: {
        participants: [
          { id: 'codex-reviewer', provider: 'codex', role: 'Reviewer', order: 1 },
          { id: 'codex-builder', provider: 'codex', role: 'Builder', order: 2 }
        ]
      } as ChatRecord['ensemble']
    })

    const lanes = buildComposerPlanLanes(record)

    expect(lanes.map((lane) => lane.lane)).toEqual(['codex-reviewer', 'codex-builder'])
    expect(lanes.map(composerPlanLaneLabel)).toEqual(['Reviewer / Codex', 'Builder / Codex'])
  })

  it('groups live todo activities by participant id before provider', () => {
    const record = chat({
      messages: [
        {
          id: 'm1',
          role: 'tool',
          content: '',
          timestamp: '2026-06-26T00:00:00.000Z',
          toolActivities: [
            activity('a1', 'codex-reviewer', 'codex', 'Review the patch'),
            activity('a2', 'codex-builder', 'codex', 'Apply the fix')
          ]
        }
      ],
      ensemble: {
        participants: [
          { id: 'codex-reviewer', provider: 'codex', role: 'Reviewer', order: 1 },
          { id: 'codex-builder', provider: 'codex', role: 'Builder', order: 2 }
        ]
      } as ChatRecord['ensemble']
    })

    const lanes = buildComposerPlanLanes(record)

    expect(lanes).toHaveLength(2)
    expect(lanes.map((lane) => lane.lane)).toEqual(['codex-reviewer', 'codex-builder'])
  })

  it('flips below when a top-pane trigger lacks room above', () => {
    const position = computeComposerPlanPopoverPosition(
      { left: 120, width: 20, top: 24, bottom: 42 },
      { width: 900, height: 700 },
      { width: 356, height: 360 }
    )

    expect(position.placement).toBe('below')
    expect(position.top).toBeGreaterThan(42)
  })

  it('opens above when there is enough room above the trigger', () => {
    const position = computeComposerPlanPopoverPosition(
      { left: 120, width: 20, top: 640, bottom: 658 },
      { width: 900, height: 700 },
      { width: 356, height: 360 }
    )

    expect(position.placement).toBe('above')
    expect(position.top).toBeGreaterThanOrEqual(368)
  })
})
