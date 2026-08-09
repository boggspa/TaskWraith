import * as THREE from 'three'
import type {
  MeshTopologyDocument,
  MeshTopologyLoop,
  MeshTopologyVertex
} from '../../../shared/meshTopology'

export interface MeshTopologySurfaceGeometry {
  geometry: THREE.BufferGeometry
  /** Source topology vertex id for each render vertex in the position attribute. */
  sourceVertexIds: string[]
}

interface RenderVertex {
  sourceVertexId: string
  position: MeshTopologyVertex['position']
  uv?: MeshTopologyLoop['uv']
}

function positionMap(topology: MeshTopologyDocument): ReadonlyMap<string, MeshTopologyVertex> {
  return new Map(topology.vertices.map((vertex) => [vertex.id, vertex]))
}

function uvKey(loop: MeshTopologyLoop): string {
  return loop.uv ? `${loop.uv.u}:${loop.uv.v}` : 'none'
}

/**
 * Compile stable-id BMesh-style faces into one indexed BufferGeometry.
 *
 * Face loops, rather than source vertices, own UV coordinates. Render vertices
 * are therefore split at UV seams and on flat-shaded faces while smooth faces
 * share compatible source-vertex/UV pairs. N-gons use the same deterministic
 * fan triangulation as the main-process topology summary.
 */
export function buildMeshTopologySurfaceGeometry(
  topology: MeshTopologyDocument
): MeshTopologySurfaceGeometry {
  const verticesById = positionMap(topology)
  const renderVertices: RenderVertex[] = []
  const renderVertexByKey = new Map<string, number>()
  const indices: number[] = []
  let hasUv = false

  const registerLoop = (
    faceId: string,
    faceSmooth: boolean,
    loop: MeshTopologyLoop,
    loopIndex: number
  ): number | null => {
    const source = verticesById.get(loop.vertexId)
    if (!source) return null
    const key = faceSmooth
      ? `smooth:${loop.vertexId}:${uvKey(loop)}`
      : `flat:${faceId}:${loopIndex}`
    const existing = renderVertexByKey.get(key)
    if (existing !== undefined) return existing
    const index = renderVertices.length
    renderVertexByKey.set(key, index)
    renderVertices.push({
      sourceVertexId: source.id,
      position: source.position,
      ...(loop.uv ? { uv: loop.uv } : {})
    })
    if (loop.uv) hasUv = true
    return index
  }

  for (const face of topology.faces) {
    if (face.loops.length < 3) continue
    for (let triangle = 1; triangle < face.loops.length - 1; triangle += 1) {
      const loopIndices = [0, triangle, triangle + 1]
      const triangleIndices = loopIndices.map((loopIndex) =>
        registerLoop(face.id, face.smooth === true, face.loops[loopIndex], loopIndex)
      )
      if (triangleIndices.some((index) => index === null)) continue
      indices.push(...(triangleIndices as number[]))
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      renderVertices.flatMap(({ position }) => [position.x, position.y, position.z]),
      3
    )
  )
  if (hasUv) {
    geometry.setAttribute(
      'uv',
      new THREE.Float32BufferAttribute(
        renderVertices.flatMap(({ uv }) => [uv?.u ?? 0, uv?.v ?? 0]),
        2
      )
    )
  }
  geometry.setIndex(indices)
  if (indices.length > 0) geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return {
    geometry,
    sourceVertexIds: renderVertices.map((vertex) => vertex.sourceVertexId)
  }
}

export function buildMeshTopologyEdgeGeometry(
  topology: MeshTopologyDocument
): THREE.BufferGeometry {
  const verticesById = positionMap(topology)
  const positions: number[] = []
  for (const edge of topology.edges) {
    const first = verticesById.get(edge.vertexIds[0])?.position
    const second = verticesById.get(edge.vertexIds[1])?.position
    if (!first || !second) continue
    positions.push(first.x, first.y, first.z, second.x, second.y, second.z)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  return geometry
}

export function buildMeshTopologyVertexGeometry(
  topology: MeshTopologyDocument
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      topology.vertices.flatMap(({ position }) => [position.x, position.y, position.z]),
      3
    )
  )
  return geometry
}

/** Rest-pose head→tail segments used for the optional rig overlay. */
export function buildMeshTopologyBoneGeometry(
  topology: MeshTopologyDocument
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      topology.bones.flatMap((bone) => [
        bone.head.x,
        bone.head.y,
        bone.head.z,
        bone.tail.x,
        bone.tail.y,
        bone.tail.z
      ]),
      3
    )
  )
  return geometry
}
