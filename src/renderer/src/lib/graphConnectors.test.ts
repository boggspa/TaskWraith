import { describe, expect, it } from 'vitest'

import { buildGraphConnectorPaths, type NodeBox } from './graphConnectors'

const box = (x: number, y: number): NodeBox => ({ x, y, width: 100, height: 40 })

describe('buildGraphConnectorPaths', () => {
  it('anchors right-centre -> left-centre and carries the variant', () => {
    const boxes = new Map<string, NodeBox>([
      ['a', box(0, 0)],
      ['b', box(200, 100)]
    ])
    const [path] = buildGraphConnectorPaths(boxes, [{ id: 'e1', from: 'a', to: 'b', variant: 'user' }])
    // a right-centre = (100, 20); b left-centre = (200, 120)
    expect(path.d.startsWith('M 100 20 C')).toBe(true)
    expect(path.d.endsWith('200 120')).toBe(true)
    expect(path.variant).toBe('user')
  })

  it('skips edges with an unmeasured endpoint', () => {
    const boxes = new Map<string, NodeBox>([['a', box(0, 0)]])
    expect(buildGraphConnectorPaths(boxes, [{ id: 'e1', from: 'a', to: 'missing' }])).toEqual([])
  })

  it('defaults the variant and keeps a minimum reach for near-overlapping edges', () => {
    // a right-edge = 100, b left-edge = 120 → gap 20, so reach floors at 24.
    const boxes = new Map<string, NodeBox>([
      ['a', box(0, 0)],
      ['b', box(120, 200)]
    ])
    const [path] = buildGraphConnectorPaths(boxes, [{ id: 'e1', from: 'a', to: 'b' }])
    expect(path.variant).toBe('default')
    expect(path.d).toContain('C 124 20')
  })
})
