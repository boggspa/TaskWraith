import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_BOARD_DEFAULT_COLUMNS,
  isWorkspaceBoardCardLinkKind,
  isWorkspaceBoardColumnId,
  normalizeWorkspaceBoardCardRecord,
  normalizeWorkspaceBoardColumns,
  normalizeWorkspaceBoardDefinitionRecord,
  normalizeWorkspaceBoardLink,
  workspaceBoardActivityActorFromProvenance
} from './appStoreNormalizers'

const NOW_MS = Date.parse('2026-09-04T08:00:00.000Z')

describe('appStoreNormalizers workspace-board cluster', () => {
  it('rejects board records without workspace identity', () => {
    expect(normalizeWorkspaceBoardDefinitionRecord({}, NOW_MS)).toBeNull()
    expect(normalizeWorkspaceBoardDefinitionRecord({ workspaceId: 'ws' }, NOW_MS)).toBeNull()
  })

  it('fills default columns and trims the board name', () => {
    const board = normalizeWorkspaceBoardDefinitionRecord(
      {
        id: 'board-1',
        workspaceId: 'ws-a',
        workspacePath: '/repo-a',
        name: '  Ops  ',
        columns: [{ id: 'ready', name: 'Go', sortOrder: 9 }]
      },
      NOW_MS
    )
    expect(board).toMatchObject({
      id: 'board-1',
      workspaceId: 'ws-a',
      workspacePath: '/repo-a',
      name: 'Ops',
      pinned: false,
      archived: false
    })
    expect(new Set(board?.columns.map((column) => column.id))).toEqual(
      new Set(WORKSPACE_BOARD_DEFAULT_COLUMNS.map((column) => column.id))
    )
    expect(board?.columns.find((column) => column.id === 'ready')).toMatchObject({
      name: 'Go',
      sortOrder: 9
    })
    expect(board?.columns.at(-1)?.id).toBe('ready')
  })

  it('maps invalid card column ids to inbox and drops malformed links', () => {
    const card = normalizeWorkspaceBoardCardRecord(
      {
        id: 'card-1',
        boardId: 'board-1',
        workspaceId: 'ws-a',
        columnId: 'not-a-column',
        title: '  Task  ',
        link: { kind: 'nope', id: 'x' }
      },
      NOW_MS
    )
    expect(card).toMatchObject({
      id: 'card-1',
      columnId: 'inbox',
      title: 'Task'
    })
    expect(card?.link).toBeUndefined()
  })

  it('accepts a valid chat link and rejects empty ids', () => {
    expect(normalizeWorkspaceBoardLink({ kind: 'chat', id: ' chat-1 ' })).toEqual({
      kind: 'chat',
      id: 'chat-1'
    })
    expect(normalizeWorkspaceBoardLink({ kind: 'chat', id: '   ' })).toBeUndefined()
    expect(isWorkspaceBoardCardLinkKind('chat')).toBe(true)
    expect(isWorkspaceBoardCardLinkKind('thread')).toBe(false)
  })

  it('derives activity actor from provenance', () => {
    expect(workspaceBoardActivityActorFromProvenance({ actor: 'agent' })).toBe('agent')
    expect(workspaceBoardActivityActorFromProvenance({ actor: 'system' })).toBe('system')
    expect(workspaceBoardActivityActorFromProvenance({ actor: 'other' })).toBe('user')
    expect(workspaceBoardActivityActorFromProvenance(null)).toBe('user')
  })

  it('keeps known column ids and ignores unknown ones', () => {
    expect(isWorkspaceBoardColumnId('inbox')).toBe(true)
    expect(isWorkspaceBoardColumnId('mystery')).toBe(false)
    const columns = normalizeWorkspaceBoardColumns([
      { id: 'mystery' },
      { id: 'done', name: 'Done' }
    ])
    expect(columns.find((column) => column.id === ('mystery' as string))).toBeUndefined()
    expect(columns.find((column) => column.id === 'done')?.name).toBe('Done')
  })
})
