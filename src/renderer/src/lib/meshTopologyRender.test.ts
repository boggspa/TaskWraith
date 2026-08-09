import { describe, expect, it } from 'vitest'
import type { MeshTopologyDocument } from '../../../shared/meshTopology'
import {
  buildMeshTopologyBoneGeometry,
  buildMeshTopologyEdgeGeometry,
  buildMeshTopologySurfaceGeometry,
  buildMeshTopologyVertexGeometry
} from './meshTopologyRender'

function topology(): MeshTopologyDocument {
  return {
    schemaVersion: 1,
    id: 'topology-a',
    revision: 4,
    name: 'Editable quad',
    source: { kind: 'generated' },
    vertices: [
      { id: 'v1', position: { x: 0, y: 0, z: 0 } },
      { id: 'v2', position: { x: 1, y: 0, z: 0 } },
      { id: 'v3', position: { x: 1, y: 1, z: 0 } },
      { id: 'v4', position: { x: 0, y: 1, z: 0 } }
    ],
    edges: [
      { id: 'e1', vertexIds: ['v1', 'v2'] },
      { id: 'e2', vertexIds: ['v2', 'v3'] },
      { id: 'e3', vertexIds: ['v3', 'v4'] },
      { id: 'e4', vertexIds: ['v4', 'v1'], seam: true }
    ],
    faces: [
      {
        id: 'f1',
        smooth: true,
        loops: [
          { vertexId: 'v1', edgeId: 'e1', uv: { u: 0, v: 0 } },
          { vertexId: 'v2', edgeId: 'e2', uv: { u: 1, v: 0 } },
          { vertexId: 'v3', edgeId: 'e3', uv: { u: 1, v: 1 } },
          { vertexId: 'v4', edgeId: 'e4', uv: { u: 0, v: 1 } }
        ]
      }
    ],
    bones: [
      {
        id: 'bone-1',
        name: 'Root',
        head: { x: 0, y: 0, z: 0 },
        tail: { x: 0, y: 1, z: 0 }
      }
    ],
    recentMutations: [],
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:01.000Z'
  }
}

describe('meshTopologyRender', () => {
  it('triangulates an n-gon while preserving per-loop UVs and smooth sharing', () => {
    const compiled = buildMeshTopologySurfaceGeometry(topology())
    expect(compiled.geometry.getAttribute('position').count).toBe(4)
    expect(compiled.geometry.getAttribute('uv').count).toBe(4)
    expect(compiled.geometry.getAttribute('normal').count).toBe(4)
    expect(compiled.geometry.getIndex()?.count).toBe(6)
    expect(compiled.sourceVertexIds).toEqual(['v1', 'v2', 'v3', 'v4'])
  })

  it('splits a smooth source vertex when adjacent face loops carry different UVs', () => {
    const document = topology()
    document.faces.push({
      id: 'f2',
      smooth: true,
      loops: [
        { vertexId: 'v1', edgeId: 'e1', uv: { u: 0.5, v: 0.5 } },
        { vertexId: 'v3', edgeId: 'e3', uv: { u: 1, v: 1 } },
        { vertexId: 'v4', edgeId: 'e4', uv: { u: 0, v: 1 } }
      ]
    })
    const compiled = buildMeshTopologySurfaceGeometry(document)
    expect(compiled.sourceVertexIds.filter((id) => id === 'v1')).toHaveLength(2)
    expect(compiled.geometry.getIndex()?.count).toBe(9)
  })

  it('builds bounded vertex, edge, and rest-pose bone overlays', () => {
    const document = topology()
    expect(buildMeshTopologyVertexGeometry(document).getAttribute('position').count).toBe(4)
    expect(buildMeshTopologyEdgeGeometry(document).getAttribute('position').count).toBe(8)
    expect(buildMeshTopologyBoneGeometry(document).getAttribute('position').count).toBe(2)
  })

  it('skips triangles that reference unavailable source vertices', () => {
    const document = topology()
    document.faces[0].loops[2].vertexId = 'missing'
    const compiled = buildMeshTopologySurfaceGeometry(document)
    expect(compiled.geometry.getIndex()?.count).toBe(0)
  })
})
