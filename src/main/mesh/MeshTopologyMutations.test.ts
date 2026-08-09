import { describe, expect, it } from 'vitest'
import { meshTopologyFromPrimitive } from './MeshTopologyGeometry'
import {
  MeshTopologyRevisionConflictError,
  applyMeshTopologyEdit,
  type MeshTopologyEditInput
} from './MeshTopologyMutations'
import type { MeshTopologyDocument, MeshTopologyMutation } from '../../shared/meshTopology'

function ids(): () => string {
  let next = 0
  return () => `topology-element-${++next}`
}

function box(): { document: MeshTopologyDocument; uuid: () => string; now: () => string } {
  const uuid = ids()
  let tick = 0
  const now = () => `2026-08-09T00:00:${String(tick++).padStart(2, '0')}.000Z`
  return {
    document: meshTopologyFromPrimitive({
      topologyId: 'topology-box',
      primitive: 'box',
      name: 'Box',
      uuid,
      now
    }),
    uuid,
    now
  }
}

function edit(
  document: MeshTopologyDocument,
  operation: MeshTopologyMutation,
  clientMutationId: string,
  uuid: () => string,
  now: () => string
): ReturnType<typeof applyMeshTopologyEdit> {
  const input: MeshTopologyEditInput = {
    expectedRevision: document.revision,
    clientMutationId,
    operations: [operation],
    editor: { provider: 'codex', participantId: 'seat-a' }
  }
  return applyMeshTopologyEdit(document, input, { uuid, now })
}

describe('applyMeshTopologyEdit', () => {
  it('applies revisioned edits, deduplicates retries, and rejects a stale ensemble writer', () => {
    const { document, uuid, now } = box()
    const vertexId = document.vertices[0].id
    const moved = edit(
      document,
      { operation: 'move_vertices', vertices: [{ vertexId, delta: { x: 0.25 } }] },
      'mutation-move',
      uuid,
      now
    )

    expect(moved.document.revision).toBe(1)
    expect(moved.document.vertices.find((vertex) => vertex.id === vertexId)?.position.x).toBe(-0.55)
    const duplicate = applyMeshTopologyEdit(
      moved.document,
      {
        expectedRevision: 0,
        clientMutationId: 'mutation-move',
        operations: [{ operation: 'delete_vertices', vertexIds: [vertexId] }]
      },
      { uuid, now }
    )
    expect(duplicate.duplicate).toBe(true)
    expect(duplicate.document.revision).toBe(1)
    expect(() =>
      applyMeshTopologyEdit(
        moved.document,
        {
          expectedRevision: 0,
          clientMutationId: 'mutation-seat-b',
          operations: [{ operation: 'move_vertices', vertices: [{ vertexId, delta: { y: 1 } }] }]
        },
        { uuid, now }
      )
    ).toThrow(MeshTopologyRevisionConflictError)
  })

  it('supports face extrusion, inset, subdivision, edge split/collapse, and per-loop UVs', () => {
    const state = box()
    let document = state.document
    const originalFace = document.faces[0].id
    document = edit(
      document,
      { operation: 'extrude_faces', faceIds: [originalFace], distance: 0.5 },
      'mutation-extrude',
      state.uuid,
      state.now
    ).document
    expect(document.faces.length).toBe(10)

    const insetFace = document.faces.at(-1)!.id
    document = edit(
      document,
      { operation: 'inset_faces', faceIds: [insetFace], amount: 0.2 },
      'mutation-inset',
      state.uuid,
      state.now
    ).document
    const subdivideFace = document.faces.at(-1)!.id
    document = edit(
      document,
      { operation: 'subdivide_faces', faceIds: [subdivideFace] },
      'mutation-subdivide',
      state.uuid,
      state.now
    ).document

    const edge = document.edges[0]
    document = edit(
      document,
      { operation: 'split_edge', edgeId: edge.id, factor: 0.4 },
      'mutation-split',
      state.uuid,
      state.now
    ).document
    const splitEdge = document.edges.find((entry) => entry.vertexIds.includes(edge.vertexIds[0]))!
    document = edit(
      document,
      { operation: 'collapse_edge', edgeId: splitEdge.id },
      'mutation-collapse',
      state.uuid,
      state.now
    ).document

    const uvFace = document.faces[0]
    document = edit(
      document,
      { operation: 'unwrap_uv', projection: 'box', faceIds: [uvFace.id] },
      'mutation-unwrap',
      state.uuid,
      state.now
    ).document
    expect(
      document.faces.find((face) => face.id === uvFace.id)?.loops.every((loop) => loop.uv)
    ).toBe(true)
  })

  it('sculpts, authors an armature, assigns weights, and poses bones atomically', () => {
    const state = box()
    let document = state.document
    const boneId = 'bone-root'
    document = edit(
      document,
      {
        operation: 'upsert_bones',
        bones: [
          {
            id: boneId,
            name: 'Root',
            head: { x: 0, y: -1, z: 0 },
            tail: { x: 0, y: 1, z: 0 }
          }
        ]
      },
      'mutation-bone',
      state.uuid,
      state.now
    ).document
    const vertexId = document.vertices[0].id
    document = edit(
      document,
      {
        operation: 'set_vertex_weights',
        vertices: [{ vertexId, weights: [{ boneId, weight: 1 }] }]
      },
      'mutation-weight',
      state.uuid,
      state.now
    ).document
    document = edit(
      document,
      {
        operation: 'pose_bones',
        bones: [{ boneId, pose: { rotation: { x: 0, y: 0, z: 30 } } }]
      },
      'mutation-pose',
      state.uuid,
      state.now
    ).document
    document = edit(
      document,
      {
        operation: 'sculpt',
        mode: 'grab',
        center: { ...document.vertices[0].position },
        radius: 1,
        strength: 0.2,
        direction: { x: 0, y: 1, z: 0 },
        vertexIds: [vertexId]
      },
      'mutation-sculpt',
      state.uuid,
      state.now
    ).document

    expect(document.bones[0].pose?.rotation.z).toBe(30)
    expect(document.vertices.find((vertex) => vertex.id === vertexId)?.weights).toEqual([
      { boneId, weight: 1 }
    ])
  })

  it('rewrites the complete internal geometry while preserving source provenance', () => {
    const state = box()
    const result = edit(
      state.document,
      {
        operation: 'replace_geometry',
        vertices: [
          { id: 'replacement-a', position: { x: 0, y: 0, z: 0 } },
          { id: 'replacement-b', position: { x: 1, y: 0, z: 0 } },
          { id: 'replacement-c', position: { x: 0, y: 1, z: 0 } }
        ],
        faces: [
          {
            id: 'replacement-face',
            vertexIds: ['replacement-a', 'replacement-b', 'replacement-c']
          }
        ]
      },
      'mutation-rewrite',
      state.uuid,
      state.now
    )

    expect(result.document.source).toEqual({ kind: 'primitive', primitive: 'box' })
    expect(result.summary).toMatchObject({ vertexCount: 3, edgeCount: 3, faceCount: 1 })
  })
})
