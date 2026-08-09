import type { MeshImportFormat, MeshPrimitiveKind, MeshVector3 } from './meshScene'

export const MESH_TOPOLOGY_SCHEMA_VERSION = 1 as const

// Topology edits currently execute synchronously in Electron main. These
// ceilings are deliberately below offline-DCC limits until the kernel moves to
// a worker; they still leave ample room for interactive agent-authored assets.
export const MESH_TOPOLOGY_MAX_VERTICES = 100_000
export const MESH_TOPOLOGY_MAX_EDGES = 200_000
export const MESH_TOPOLOGY_MAX_FACES = 100_000
export const MESH_TOPOLOGY_MAX_LOOPS = 400_000
export const MESH_TOPOLOGY_MAX_BONES = 256
export const MESH_TOPOLOGY_MAX_WEIGHTS_PER_VERTEX = 4
export const MESH_TOPOLOGY_MAX_EDIT_OPERATIONS = 64
export const MESH_TOPOLOGY_MAX_SCULPT_VERTICES = 10_000
export const MESH_TOPOLOGY_MAX_RECENT_MUTATIONS = 32

export interface MeshVector2 {
  u: number
  v: number
}

export interface MeshTopologyWeight {
  boneId: string
  weight: number
}

export interface MeshTopologyVertex {
  id: string
  position: MeshVector3
  weights?: MeshTopologyWeight[]
}

export interface MeshTopologyEdge {
  id: string
  /** Undirected edge endpoints. Face-loop order owns winding. */
  vertexIds: [string, string]
  seam?: boolean
  /** Blender-style crease weight in the closed interval [0, 1]. */
  crease?: number
}

/**
 * UVs live on loops rather than vertices. A vertex shared across a UV seam can
 * therefore carry a different coordinate on each adjacent face.
 */
export interface MeshTopologyLoop {
  vertexId: string
  edgeId: string
  uv?: MeshVector2
}

export interface MeshTopologyFace {
  id: string
  loops: MeshTopologyLoop[]
  materialIndex?: number
  smooth?: boolean
}

export interface MeshTopologyBonePose {
  translation?: MeshVector3
  /** Euler angles in degrees, matching Mesh Canvas scene transforms. */
  rotation?: MeshVector3
  scale?: MeshVector3
}

export interface MeshTopologyBone {
  id: string
  name: string
  parentId?: string
  head: MeshVector3
  tail: MeshVector3
  roll?: number
  pose?: MeshTopologyBonePose
}

export type MeshTopologySource =
  | { kind: 'primitive'; primitive: MeshPrimitiveKind }
  | {
      kind: 'import'
      assetId: string
      format: MeshImportFormat
      entryPath: string
    }
  | { kind: 'generated' }

export interface MeshTopologyEditAttribution {
  provider?: string
  runId?: string
  participantId?: string
}

export interface MeshTopologyMutationReceipt {
  clientMutationId: string
  revision: number
  updatedAt: string
  editor?: MeshTopologyEditAttribution
}

export interface MeshTopologyDocument {
  schemaVersion: typeof MESH_TOPOLOGY_SCHEMA_VERSION
  id: string
  revision: number
  name: string
  source: MeshTopologySource
  vertices: MeshTopologyVertex[]
  edges: MeshTopologyEdge[]
  faces: MeshTopologyFace[]
  bones: MeshTopologyBone[]
  recentMutations: MeshTopologyMutationReceipt[]
  createdAt: string
  updatedAt: string
}

export interface MeshTopologyBounds {
  min: MeshVector3
  max: MeshVector3
}

export interface MeshTopologySummary {
  topologyId: string
  revision: number
  vertexCount: number
  edgeCount: number
  faceCount: number
  triangleCount: number
  uvLoopCount: number
  seamCount: number
  boneCount: number
  weightedVertexCount: number
  bounds: MeshTopologyBounds
  updatedAt: string
}

export interface MeshTopologyVertexInput {
  id?: string
  position: MeshVector3
  weights?: MeshTopologyWeight[]
}

export interface MeshTopologyFaceInput {
  id?: string
  vertexIds: string[]
  uvs?: MeshVector2[]
  materialIndex?: number
  smooth?: boolean
}

export type MeshTopologyUvProjection =
  | 'planar_x'
  | 'planar_y'
  | 'planar_z'
  | 'box'
  | 'cylindrical'
  | 'spherical'

export type MeshTopologySculptMode = 'draw' | 'inflate' | 'smooth' | 'flatten' | 'pinch' | 'grab'

export type MeshTopologyMutation =
  | {
      operation: 'move_vertices'
      vertices: Array<{
        vertexId: string
        position?: Partial<MeshVector3>
        delta?: Partial<MeshVector3>
      }>
    }
  | { operation: 'create_vertices'; vertices: MeshTopologyVertexInput[] }
  | { operation: 'delete_vertices'; vertexIds: string[] }
  | {
      operation: 'merge_vertices'
      targetVertexId: string
      sourceVertexIds: string[]
    }
  | { operation: 'create_faces'; faces: MeshTopologyFaceInput[] }
  | {
      operation: 'delete_faces'
      faceIds: string[]
      deleteOrphanVertices?: boolean
    }
  | {
      operation: 'extrude_faces'
      faceIds: string[]
      distance: number
      direction?: MeshVector3
    }
  | { operation: 'inset_faces'; faceIds: string[]; amount: number }
  | { operation: 'subdivide_faces'; faceIds: string[] }
  | { operation: 'split_edge'; edgeId: string; factor?: number }
  | { operation: 'collapse_edge'; edgeId: string; keepVertexId?: string }
  | {
      operation: 'mark_edges'
      edgeIds: string[]
      seam?: boolean
      crease?: number
    }
  | { operation: 'set_face_uvs'; faceId: string; uvs: MeshVector2[] }
  | {
      operation: 'unwrap_uv'
      projection: MeshTopologyUvProjection
      faceIds?: string[]
      scale?: number
    }
  | {
      operation: 'sculpt'
      mode: MeshTopologySculptMode
      center: MeshVector3
      radius: number
      strength: number
      direction?: MeshVector3
      vertexIds?: string[]
    }
  | {
      operation: 'upsert_bones'
      bones: Array<Omit<MeshTopologyBone, 'id'> & { id?: string }>
    }
  | { operation: 'remove_bones'; boneIds: string[] }
  | {
      operation: 'set_vertex_weights'
      vertices: Array<{ vertexId: string; weights: MeshTopologyWeight[] }>
    }
  | {
      operation: 'pose_bones'
      bones: Array<{ boneId: string; pose: MeshTopologyBonePose | null }>
    }
  | {
      operation: 'replace_geometry'
      vertices: MeshTopologyVertexInput[]
      faces: MeshTopologyFaceInput[]
      bones?: Array<Omit<MeshTopologyBone, 'id'> & { id?: string }>
    }

export interface MeshTopologyEditResult {
  document: MeshTopologyDocument
  summary: MeshTopologySummary
  createdIds: string[]
  deletedIds: string[]
  duplicate: boolean
}

export function meshTopologyEdgeKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`
}

export function meshTopologySummary(document: MeshTopologyDocument): MeshTopologySummary {
  const fallback = { x: 0, y: 0, z: 0 }
  const first = document.vertices[0]?.position
  const min = { ...(first ?? fallback) }
  const max = { ...(first ?? fallback) }
  let weightedVertexCount = 0
  for (const vertex of document.vertices) {
    min.x = Math.min(min.x, vertex.position.x)
    min.y = Math.min(min.y, vertex.position.y)
    min.z = Math.min(min.z, vertex.position.z)
    max.x = Math.max(max.x, vertex.position.x)
    max.y = Math.max(max.y, vertex.position.y)
    max.z = Math.max(max.z, vertex.position.z)
    if (vertex.weights?.length) weightedVertexCount += 1
  }
  return {
    topologyId: document.id,
    revision: document.revision,
    vertexCount: document.vertices.length,
    edgeCount: document.edges.length,
    faceCount: document.faces.length,
    triangleCount: document.faces.reduce(
      (total, face) => total + Math.max(0, face.loops.length - 2),
      0
    ),
    uvLoopCount: document.faces.reduce(
      (total, face) => total + face.loops.filter((loop) => Boolean(loop.uv)).length,
      0
    ),
    seamCount: document.edges.filter((edge) => edge.seam).length,
    boneCount: document.bones.length,
    weightedVertexCount,
    bounds: { min, max },
    updatedAt: document.updatedAt
  }
}
