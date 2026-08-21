import { describe, expect, it } from 'vitest'
import {
  applyLaneTodoWrite,
  applyTodoWrite,
  computeMergedTodosByActivityId,
  computeMergedTodosByLane,
  computeMergedTodosFromActivities,
  findCurrentTodoStep,
  isTodoToolName,
  mergeTodoLists,
  parseTodoItemsFromActivity,
  parseTodoItemsFromUnknown,
  summarizeTodoProgress,
  TODO_SOLO_LANE,
  validateTodoWriteArgs
} from './TodoList'

describe('TodoList', () => {
  it('recognises provider todo tool aliases', () => {
    expect(isTodoToolName('todo_write')).toBe(true)
    expect(isTodoToolName('mcp__TaskWraith__todo_write')).toBe(true)
    expect(isTodoToolName('update_todo_list')).toBe(true)
    expect(isTodoToolName('codex_plan')).toBe(true)
    expect(isTodoToolName('read_file')).toBe(false)
  })

  it('parses Codex-style plan steps ({step,status}) and bare strings', () => {
    expect(
      parseTodoItemsFromUnknown([
        { step: 'Scan repo', status: 'completed' },
        { step: 'Edit file', status: 'in progress' }
      ])
    ).toEqual([
      { id: 'todo-1', content: 'Scan repo', status: 'completed' },
      { id: 'todo-2', content: 'Edit file', status: 'in_progress' }
    ])
    expect(parseTodoItemsFromUnknown(['just text'])).toEqual([
      { id: 'todo-1', content: 'just text', status: 'pending' }
    ])
  })

  it('parses todos from parameters and normalises status aliases', () => {
    const items = parseTodoItemsFromActivity({
      toolName: 'todo_write',
      parameters: {
        merge: true,
        todos: [
          { id: 'a', content: 'Scout codebase', status: 'done' },
          { id: 'b', content: 'Implement fix', status: 'in progress' }
        ]
      }
    })
    expect(items).toEqual([
      { id: 'a', content: 'Scout codebase', status: 'completed' },
      { id: 'b', content: 'Implement fix', status: 'in_progress' }
    ])
  })

  it('merges todo batches by id while preserving order', () => {
    const merged = mergeTodoLists(
      [
        { id: '1', content: 'First', status: 'completed' },
        { id: '2', content: 'Second', status: 'pending' }
      ],
      [{ id: '2', content: 'Second', status: 'in_progress' }, { id: '3', content: 'Third', status: 'pending' }]
    )
    expect(merged.map((item) => item.id)).toEqual(['1', '2', '3'])
    expect(merged[1].status).toBe('in_progress')
  })

  it('replaces the list when merge is false', () => {
    const next = applyTodoWrite(
      [{ id: 'old', content: 'Old', status: 'pending' }],
      [{ id: 'new', content: 'New', status: 'pending' }],
      false
    )
    expect(next).toEqual([{ id: 'new', content: 'New', status: 'pending' }])
  })

  it('keeps lanes isolated and falls back to the solo lane', () => {
    // Two ensemble participants writing to the same chat must NOT collide.
    const afterA = applyLaneTodoWrite(
      undefined,
      'kimi',
      [{ id: '1', content: 'A1', status: 'pending' }],
      false
    )
    const afterB = applyLaneTodoWrite(
      afterA,
      'codex',
      [{ id: '1', content: 'B1', status: 'pending' }],
      false
    )
    expect(afterB.kimi).toEqual([{ id: '1', content: 'A1', status: 'pending' }])
    expect(afterB.codex).toEqual([{ id: '1', content: 'B1', status: 'pending' }])
    // Empty lane id collapses to the solo lane, preserving sibling lanes.
    const solo = applyLaneTodoWrite(afterB, '', [{ id: '1', content: 'S', status: 'pending' }], false)
    expect(solo[TODO_SOLO_LANE]).toEqual([{ id: '1', content: 'S', status: 'pending' }])
    expect(solo.kimi).toEqual([{ id: '1', content: 'A1', status: 'pending' }])
  })

  it('merges within a lane without touching siblings', () => {
    const base = applyLaneTodoWrite(
      undefined,
      'kimi',
      [
        { id: '1', content: 'Step 1', status: 'pending' },
        { id: '2', content: 'Step 2', status: 'pending' }
      ],
      false
    )
    const withCodex = applyLaneTodoWrite(
      base,
      'codex',
      [{ id: '1', content: 'C', status: 'pending' }],
      false
    )
    const merged = applyLaneTodoWrite(
      withCodex,
      'kimi',
      [{ id: '2', content: 'Step 2', status: 'completed' }],
      true
    )
    expect(merged.kimi.map((t) => [t.id, t.status])).toEqual([
      ['1', 'pending'],
      ['2', 'completed']
    ])
    expect(merged.codex).toEqual([{ id: '1', content: 'C', status: 'pending' }])
  })

  it('binds seat todos to the current Goal/assignment and drops stale-goal steps', () => {
    const prior = {
      worker: [
        {
          id: 'old',
          content: 'Old Goal step',
          status: 'completed' as const,
          goalId: 'goal-old'
        }
      ]
    }
    const next = applyLaneTodoWrite(
      prior,
      'worker',
      [{ id: 'new', content: 'Current assignment step', status: 'in_progress' }],
      true,
      { goalId: 'goal-current', assignmentId: 'assignment-1' }
    )

    expect(next.worker).toEqual([
      {
        id: 'new',
        content: 'Current assignment step',
        status: 'in_progress',
        goalId: 'goal-current',
        assignmentId: 'assignment-1'
      }
    ])
  })

  it('groups todo activities into per-lane merged lists (ensemble PlanRail)', () => {
    const byLane = computeMergedTodosByLane(
      [
        {
          id: 'a1',
          toolName: 'todo_write',
          parameters: { merge: false, todos: [{ id: '1', content: 'K1', status: 'in_progress' }] },
          lane: 'kimi'
        },
        {
          id: 'a2',
          toolName: 'todo_write',
          parameters: { merge: false, todos: [{ id: '1', content: 'C1', status: 'pending' }] },
          lane: 'codex'
        },
        // Non-todo tool from a participant must not create an empty lane.
        { id: 'a3', toolName: 'read_file', parameters: {}, lane: 'gemini' }
      ],
      (a) => (a as { lane: string }).lane
    )
    expect(Object.keys(byLane).sort()).toEqual(['codex', 'kimi'])
    expect(byLane.kimi).toEqual([{ id: '1', content: 'K1', status: 'in_progress' }])
    expect(byLane.codex).toEqual([{ id: '1', content: 'C1', status: 'pending' }])
  })

  it('tracks merged todos per activity id', () => {
    const map = computeMergedTodosByActivityId([
      {
        id: 'a1',
        toolName: 'todo_write',
        parameters: {
          merge: false,
          todos: [{ id: '1', content: 'Plan', status: 'in_progress' }]
        }
      },
      {
        id: 'a2',
        toolName: 'todo_write',
        parameters: {
          merge: true,
          todos: [{ id: '1', content: 'Plan', status: 'completed' }]
        }
      }
    ])
    expect(map.get('a1')).toEqual([{ id: '1', content: 'Plan', status: 'in_progress' }])
    expect(map.get('a2')).toEqual([{ id: '1', content: 'Plan', status: 'completed' }])
  })

  it('computes merged todos across activities chronologically', () => {
    const merged = computeMergedTodosFromActivities([
      {
        toolName: 'todo_write',
        parameters: {
          merge: false,
          todos: [{ id: '1', content: 'Plan', status: 'in_progress' }]
        }
      },
      {
        toolName: 'todo_write',
        parameters: {
          merge: true,
          todos: [{ id: '1', content: 'Plan', status: 'completed' }]
        }
      }
    ])
    expect(merged).toEqual([{ id: '1', content: 'Plan', status: 'completed' }])
  })

  it('summarises progress and finds the current step', () => {
    const todos = [
      { id: '1', content: 'Done', status: 'completed' as const },
      { id: '2', content: 'Now', status: 'in_progress' as const },
      { id: '3', content: 'Later', status: 'pending' as const }
    ]
    expect(summarizeTodoProgress(todos).label).toBe('1/3 complete')
    expect(findCurrentTodoStep(todos)?.content).toBe('Now')
  })

  it('validates MCP todo_write args', () => {
    expect(validateTodoWriteArgs({ todos: [] }).ok).toBe(false)
    expect(validateTodoWriteArgs({ todos: [{ content: 'Ship' }] })).toEqual({
      ok: true,
      merge: false,
      todos: [{ id: 'todo-1', content: 'Ship', status: 'pending' }]
    })
  })
})
