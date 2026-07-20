import { describe, expect, it } from 'vitest'

import {
  buildProjectThreadGraphProjection,
  type ProjectThreadGraphInput
} from './projectThreadGraphProjection'
import type { ProjectGraphEdge } from '../../../shared/projects'

const edge = (
  id: string,
  from: string,
  to: string,
  projectId = 'p1'
): ProjectGraphEdge => ({
  id,
  projectId,
  fromChatId: from,
  toChatId: to,
  kind: 'dependency',
  createdAt: 1
})

const baseInput = (overrides: Partial<ProjectThreadGraphInput> = {}): ProjectThreadGraphInput => ({
  projectId: 'p1',
  projectName: 'Alpha',
  memberChatIds: ['a', 'b', 'c', 'ghost'],
  chats: [
    { appChatId: 'a', title: 'A', provider: 'claude' },
    { appChatId: 'b', title: 'B', parentChatId: 'a', parentChatRelation: 'subThread' },
    { appChatId: 'c', title: 'C', chatKind: 'ensemble' }
  ],
  graphEdges: [edge('e1', 'a', 'c')],
  runningChatIds: new Set(['b']),
  homeChatId: 'a',
  ...overrides
})

describe('buildProjectThreadGraphProjection', () => {
  it('projects members to nodes, including a placeholder for an unloaded member', () => {
    const projection = buildProjectThreadGraphProjection(baseInput())
    expect(projection.nodeCount).toBe(4)
    const byId = new Map(projection.orderedNodes.map((node) => [node.chatId, node]))
    expect(byId.get('ghost')?.isPlaceholder).toBe(true)
    expect(byId.get('ghost')?.statusLabel).toBe('Not loaded')
    expect(byId.get('a')?.isHome).toBe(true)
    expect(byId.get('b')?.isRunning).toBe(true)
    expect(byId.get('b')?.statusTone).toBe('running')
    expect(byId.get('b')?.relationBadge).toBe('Sub-thread')
    expect(byId.get('c')?.kindLabel).toBe('Ensemble')
    expect(projection.runningCount).toBe(1)
  })

  it('derives relationship edges and merges user dependency edges', () => {
    const projection = buildProjectThreadGraphProjection(baseInput())
    const keyed = projection.edges.map((e) => `${e.source}:${e.fromChatId}->${e.toChatId}:${e.kind}`)
    expect(keyed).toContain('derived:a->b:delegation')
    expect(keyed).toContain('user:a->c:dependency')
    // User edges are removable; derived are not.
    expect(projection.edges.find((e) => e.source === 'user')?.removable).toBe(true)
    expect(projection.edges.find((e) => e.source === 'derived')?.removable).toBe(false)
    const c = projection.orderedNodes.find((node) => node.chatId === 'c')
    expect(c?.dependencies).toEqual([
      expect.objectContaining({ fromChatId: 'a', fromTitle: 'A', label: 'Depends on' })
    ])
  })

  it('lays out roots first, then dependents, by longest-path stage', () => {
    const projection = buildProjectThreadGraphProjection(baseInput())
    const stageOf = (id: string) =>
      projection.orderedNodes.find((node) => node.chatId === id)?.stage
    expect(stageOf('a')).toBe(0)
    expect(stageOf('ghost')).toBe(0)
    expect(stageOf('b')).toBe(1)
    expect(stageOf('c')).toBe(1)
    expect(projection.stages[0].label).toBe('Roots')
  })

  it('excludes relationships and user edges whose endpoints are not both members', () => {
    const projection = buildProjectThreadGraphProjection(
      baseInput({
        memberChatIds: ['a', 'b'],
        // b's parent 'a' is a member (kept); c is not a member so its user edge drops.
        graphEdges: [edge('e1', 'a', 'c'), edge('eX', 'a', 'b', 'other-project')]
      })
    )
    // Only the derived a->b edge survives: e1 (a->c) has a non-member endpoint,
    // eX belongs to another project.
    expect(projection.edges).toHaveLength(1)
    expect(projection.edges[0]).toMatchObject({ source: 'derived', fromChatId: 'a', toChatId: 'b' })
  })

  it('is cycle-safe: surfaces an issue and parks cyclic nodes in a trailing stage', () => {
    const projection = buildProjectThreadGraphProjection(
      baseInput({
        memberChatIds: ['x', 'y'],
        chats: [
          { appChatId: 'x', title: 'X' },
          { appChatId: 'y', title: 'Y' }
        ],
        graphEdges: [edge('e1', 'x', 'y'), edge('e2', 'y', 'x')],
        runningChatIds: new Set(),
        homeChatId: undefined
      })
    )
    expect(projection.issues[0]).toMatch(/dependency cycle/i)
    expect(projection.orderedNodes.every((node) => node.inCycle)).toBe(true)
  })

  it('dedupes members and ignores blank ids', () => {
    const projection = buildProjectThreadGraphProjection(
      baseInput({ memberChatIds: ['a', 'a', '', 'b'] })
    )
    expect(projection.orderedNodes.map((node) => node.chatId).sort()).toEqual(['a', 'b'])
  })
})
