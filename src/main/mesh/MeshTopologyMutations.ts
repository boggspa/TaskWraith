/** Pure, atomic topology operators used by the governed Mesh Canvas tools. */
import {
  MESH_TOPOLOGY_MAX_BONES,
  MESH_TOPOLOGY_MAX_EDIT_OPERATIONS,
  MESH_TOPOLOGY_MAX_RECENT_MUTATIONS,
  MESH_TOPOLOGY_MAX_SCULPT_VERTICES,
  MESH_TOPOLOGY_MAX_VERTICES,
  meshTopologyEdgeKey,
  meshTopologySummary,
  type MeshTopologyBone,
  type MeshTopologyDocument,
  type MeshTopologyEdge,
  type MeshTopologyEditAttribution,
  type MeshTopologyEditResult,
  type MeshTopologyFace,
  type MeshTopologyFaceInput,
  type MeshTopologyLoop,
  type MeshTopologyMutation,
  type MeshTopologyVertex,
  type MeshTopologyVertexInput,
  type MeshTopologyWeight,
  type MeshVector2
} from '../../shared/meshTopology'
import type { MeshVector3 } from '../../shared/meshScene'
import { normalizeMeshTopologyDocument } from './MeshTopologyStore'

const ELEMENT_ID_RE = /^[a-zA-Z0-9_-]{3,128}$/

export class MeshTopologyRevisionConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly currentRevision: number
  ) {
    super(
      `Mesh topology revision conflict: expected ${expectedRevision}, current revision is ${currentRevision}. Inspect and retry against the current revision.`
    )
    this.name = 'MeshTopologyRevisionConflictError'
  }
}

export interface MeshTopologyEditInput {
  expectedRevision: number
  clientMutationId: string
  operations: MeshTopologyMutation[]
  editor?: MeshTopologyEditAttribution
}

export interface MeshTopologyMutationDeps {
  uuid: () => string
  now: () => string
}

function cloneDocument(document: MeshTopologyDocument): MeshTopologyDocument {
  return JSON.parse(JSON.stringify(document)) as MeshTopologyDocument
}

function idFrom(uuid: () => string): string {
  const id = uuid().replace(/[^a-zA-Z0-9_-]/g, '')
  if (!ELEMENT_ID_RE.test(id)) throw new Error('Mesh topology id generator returned an invalid id.')
  return id
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1_000_000) {
    throw new Error(`${label} must be a finite number between -1000000 and 1000000.`)
  }
  return value
}

function vector(value: Partial<MeshVector3> | undefined, label: string): Partial<MeshVector3> {
  if (!value || typeof value !== 'object') return {}
  return {
    ...(value.x !== undefined ? { x: finite(value.x, `${label}.x`) } : {}),
    ...(value.y !== undefined ? { y: finite(value.y, `${label}.y`) } : {}),
    ...(value.z !== undefined ? { z: finite(value.z, `${label}.z`) } : {})
  }
}

function fullVector(value: MeshVector3, label: string): MeshVector3 {
  const result = vector(value, label)
  if (result.x === undefined || result.y === undefined || result.z === undefined) {
    throw new Error(`${label} requires x, y, and z.`)
  }
  return result as MeshVector3
}

function uv(value: MeshVector2, label: string): MeshVector2 {
  return { u: finite(value.u, `${label}.u`), v: finite(value.v, `${label}.v`) }
}

function add(a: MeshVector3, b: MeshVector3): MeshVector3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }
}

function subtract(a: MeshVector3, b: MeshVector3): MeshVector3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

function multiply(value: MeshVector3, scalar: number): MeshVector3 {
  return { x: value.x * scalar, y: value.y * scalar, z: value.z * scalar }
}

function length(value: MeshVector3): number {
  return Math.hypot(value.x, value.y, value.z)
}

function normalize(value: MeshVector3, fallback: MeshVector3 = { x: 0, y: 1, z: 0 }): MeshVector3 {
  const magnitude = length(value)
  return magnitude > 1e-9 ? multiply(value, 1 / magnitude) : { ...fallback }
}

function lerp(a: MeshVector3, b: MeshVector3, factor: number): MeshVector3 {
  return add(a, multiply(subtract(b, a), factor))
}

function centroid(points: readonly MeshVector3[]): MeshVector3 {
  if (!points.length) return { x: 0, y: 0, z: 0 }
  return multiply(points.reduce(add, { x: 0, y: 0, z: 0 }), 1 / points.length)
}

function vertexMap(document: MeshTopologyDocument): Map<string, MeshTopologyVertex> {
  return new Map(document.vertices.map((entry) => [entry.id, entry]))
}

function faceNormal(
  face: MeshTopologyFace,
  vertices: ReadonlyMap<string, MeshTopologyVertex>
): MeshVector3 {
  const points = face.loops
    .map((entry) => vertices.get(entry.vertexId)?.position)
    .filter(Boolean) as MeshVector3[]
  if (points.length < 3) return { x: 0, y: 1, z: 0 }
  // Newell's method remains stable for convex or concave n-gons.
  const normal = { x: 0, y: 0, z: 0 }
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    normal.x += (current.y - next.y) * (current.z + next.z)
    normal.y += (current.z - next.z) * (current.x + next.x)
    normal.z += (current.x - next.x) * (current.y + next.y)
  }
  return normalize(normal)
}

function requireVertex(document: MeshTopologyDocument, vertexId: string): MeshTopologyVertex {
  const vertex = document.vertices.find((entry) => entry.id === vertexId)
  if (!vertex) throw new Error(`Mesh topology vertex ${vertexId} was not found.`)
  return vertex
}

function requireFace(document: MeshTopologyDocument, faceId: string): MeshTopologyFace {
  const face = document.faces.find((entry) => entry.id === faceId)
  if (!face) throw new Error(`Mesh topology face ${faceId} was not found.`)
  return face
}

function requireEdge(document: MeshTopologyDocument, edgeId: string): MeshTopologyEdge {
  const edge = document.edges.find((entry) => entry.id === edgeId)
  if (!edge) throw new Error(`Mesh topology edge ${edgeId} was not found.`)
  return edge
}

function checkedId(value: string | undefined, uuid: () => string, label: string): string {
  const id = value ?? idFrom(uuid)
  if (!ELEMENT_ID_RE.test(id)) throw new Error(`${label} is invalid.`)
  return id
}

function weights(
  input: readonly MeshTopologyWeight[] | undefined,
  document: MeshTopologyDocument
): MeshTopologyWeight[] | undefined {
  if (!input?.length) return undefined
  const boneIds = new Set(document.bones.map((entry) => entry.id))
  const merged = new Map<string, number>()
  for (const entry of input) {
    if (!boneIds.has(entry.boneId))
      throw new Error(`Mesh topology bone ${entry.boneId} was not found.`)
    const amount = finite(entry.weight, 'weight')
    if (amount < 0) throw new Error('Vertex weights cannot be negative.')
    merged.set(entry.boneId, (merged.get(entry.boneId) ?? 0) + amount)
  }
  const strongest = [...merged.entries()]
    .filter(([, amount]) => amount > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
  const total = strongest.reduce((sum, [, amount]) => sum + amount, 0)
  return total > 0
    ? strongest.map(([boneId, amount]) => ({ boneId, weight: amount / total }))
    : undefined
}

function newVertex(
  input: MeshTopologyVertexInput,
  document: MeshTopologyDocument,
  uuid: () => string
): MeshTopologyVertex {
  return {
    id: checkedId(input.id, uuid, 'Mesh topology vertex id'),
    position: fullVector(input.position, 'vertex.position'),
    ...(weights(input.weights, document) ? { weights: weights(input.weights, document) } : {})
  }
}

function rebuildEdges(
  document: MeshTopologyDocument,
  uuid: () => string,
  createdIds: Set<string>,
  deletedIds: Set<string>
): void {
  const existing = new Map(
    document.edges.map((entry) => [
      meshTopologyEdgeKey(entry.vertexIds[0], entry.vertexIds[1]),
      entry
    ])
  )
  const next = new Map<string, MeshTopologyEdge>()
  for (const face of document.faces) {
    for (let index = 0; index < face.loops.length; index += 1) {
      const current = face.loops[index]
      const following = face.loops[(index + 1) % face.loops.length]
      const key = meshTopologyEdgeKey(current.vertexId, following.vertexId)
      let edge = next.get(key)
      if (!edge) {
        edge = existing.get(key) ?? {
          id: idFrom(uuid),
          vertexIds: [current.vertexId, following.vertexId]
        }
        if (!existing.has(key)) createdIds.add(edge.id)
        next.set(key, edge)
      }
      current.edgeId = edge.id
    }
  }
  for (const entry of document.edges) {
    if (!next.has(meshTopologyEdgeKey(entry.vertexIds[0], entry.vertexIds[1]))) {
      deletedIds.add(entry.id)
    }
  }
  document.edges = [...next.values()]
}

function makeFace(
  input: MeshTopologyFaceInput,
  document: MeshTopologyDocument,
  uuid: () => string
): MeshTopologyFace {
  if (!Array.isArray(input.vertexIds) || input.vertexIds.length < 3) {
    throw new Error('A mesh topology face requires at least three vertices.')
  }
  if (new Set(input.vertexIds).size < 3) throw new Error('A mesh topology face is degenerate.')
  for (const vertexId of input.vertexIds) requireVertex(document, vertexId)
  if (input.uvs && input.uvs.length !== input.vertexIds.length) {
    throw new Error('Face UV count must match its vertex count.')
  }
  return {
    id: checkedId(input.id, uuid, 'Mesh topology face id'),
    loops: input.vertexIds.map((vertexId, index) => ({
      vertexId,
      edgeId: '',
      ...(input.uvs ? { uv: uv(input.uvs[index], `face.uvs[${index}]`) } : {})
    })),
    ...(input.materialIndex !== undefined
      ? { materialIndex: Math.max(0, Math.floor(finite(input.materialIndex, 'materialIndex'))) }
      : {}),
    ...(typeof input.smooth === 'boolean' ? { smooth: input.smooth } : {})
  }
}

function cleanFaceLoops(loops: MeshTopologyLoop[]): MeshTopologyLoop[] {
  const result: MeshTopologyLoop[] = []
  for (const entry of loops) {
    if (result.at(-1)?.vertexId !== entry.vertexId) result.push(entry)
  }
  if (result.length > 1 && result[0].vertexId === result.at(-1)?.vertexId) result.pop()
  return result
}

function deleteFaces(
  document: MeshTopologyDocument,
  ids: ReadonlySet<string>,
  deletedIds: Set<string>
): void {
  const before = document.faces.length
  document.faces = document.faces.filter((entry) => {
    if (!ids.has(entry.id)) return true
    deletedIds.add(entry.id)
    return false
  })
  if (before === document.faces.length && ids.size)
    throw new Error('No requested mesh faces were found.')
}

function deleteOrphanVertices(document: MeshTopologyDocument, deletedIds: Set<string>): void {
  const retained = new Set(
    document.faces.flatMap((face) => face.loops.map((loop) => loop.vertexId))
  )
  document.vertices = document.vertices.filter((entry) => {
    if (retained.has(entry.id)) return true
    deletedIds.add(entry.id)
    return false
  })
}

function applyGeometryOperation(
  document: MeshTopologyDocument,
  operation: MeshTopologyMutation,
  deps: MeshTopologyMutationDeps,
  createdIds: Set<string>,
  deletedIds: Set<string>
): void {
  if (operation.operation === 'move_vertices') {
    if (!operation.vertices.length) throw new Error('move_vertices requires at least one vertex.')
    for (const update of operation.vertices) {
      const target = requireVertex(document, update.vertexId)
      const nextPosition = vector(update.position, 'position')
      const delta = vector(update.delta, 'delta')
      if (!Object.keys(nextPosition).length && !Object.keys(delta).length) {
        throw new Error('Each moved vertex requires position or delta.')
      }
      target.position = {
        x: nextPosition.x ?? target.position.x,
        y: nextPosition.y ?? target.position.y,
        z: nextPosition.z ?? target.position.z
      }
      target.position = {
        x: target.position.x + (delta.x ?? 0),
        y: target.position.y + (delta.y ?? 0),
        z: target.position.z + (delta.z ?? 0)
      }
    }
    return
  }
  if (operation.operation === 'create_vertices') {
    if (!operation.vertices.length) throw new Error('create_vertices requires at least one vertex.')
    const existing = new Set(document.vertices.map((entry) => entry.id))
    for (const input of operation.vertices) {
      const created = newVertex(input, document, deps.uuid)
      if (existing.has(created.id))
        throw new Error(`Mesh topology id ${created.id} already exists.`)
      existing.add(created.id)
      createdIds.add(created.id)
      document.vertices.push(created)
    }
    return
  }
  if (operation.operation === 'delete_vertices') {
    const ids = new Set(operation.vertexIds)
    for (const id of ids) requireVertex(document, id)
    document.faces = document.faces.filter((face) => {
      if (!face.loops.some((loop) => ids.has(loop.vertexId))) return true
      deletedIds.add(face.id)
      return false
    })
    document.vertices = document.vertices.filter((entry) => {
      if (!ids.has(entry.id)) return true
      deletedIds.add(entry.id)
      return false
    })
    return
  }
  if (operation.operation === 'merge_vertices') {
    requireVertex(document, operation.targetVertexId)
    const sources = new Set(
      operation.sourceVertexIds.filter((id) => id !== operation.targetVertexId)
    )
    for (const id of sources) requireVertex(document, id)
    document.faces = document.faces
      .map((face) => ({
        ...face,
        loops: cleanFaceLoops(
          face.loops.map((entry) => ({
            ...entry,
            vertexId: sources.has(entry.vertexId) ? operation.targetVertexId : entry.vertexId
          }))
        )
      }))
      .filter((face) => {
        if (new Set(face.loops.map((loop) => loop.vertexId)).size >= 3) return true
        deletedIds.add(face.id)
        return false
      })
    document.vertices = document.vertices.filter((entry) => {
      if (!sources.has(entry.id)) return true
      deletedIds.add(entry.id)
      return false
    })
    return
  }
  if (operation.operation === 'create_faces') {
    if (!operation.faces.length) throw new Error('create_faces requires at least one face.')
    const existing = new Set(document.faces.map((entry) => entry.id))
    for (const input of operation.faces) {
      const created = makeFace(input, document, deps.uuid)
      if (existing.has(created.id))
        throw new Error(`Mesh topology id ${created.id} already exists.`)
      existing.add(created.id)
      createdIds.add(created.id)
      document.faces.push(created)
    }
    return
  }
  if (operation.operation === 'delete_faces') {
    deleteFaces(document, new Set(operation.faceIds), deletedIds)
    if (operation.deleteOrphanVertices) deleteOrphanVertices(document, deletedIds)
    return
  }
  if (operation.operation === 'extrude_faces') {
    const distance = finite(operation.distance, 'distance')
    const selected = operation.faceIds.map((id) => requireFace(document, id))
    const vertices = vertexMap(document)
    for (const face of selected) {
      const direction = normalize(
        operation.direction
          ? fullVector(operation.direction, 'direction')
          : faceNormal(face, vertices)
      )
      const offset = multiply(direction, distance)
      const duplicated: MeshTopologyVertex[] = face.loops.map((entry) => {
        const source = requireVertex(document, entry.vertexId)
        const created = { ...source, id: idFrom(deps.uuid), position: add(source.position, offset) }
        if (source.weights) created.weights = source.weights.map((weight) => ({ ...weight }))
        document.vertices.push(created)
        createdIds.add(created.id)
        return created
      })
      const cap: MeshTopologyFace = {
        ...face,
        id: idFrom(deps.uuid),
        loops: face.loops.map((entry, index) => ({
          ...entry,
          vertexId: duplicated[index].id,
          edgeId: ''
        }))
      }
      createdIds.add(cap.id)
      document.faces.push(cap)
      for (let index = 0; index < face.loops.length; index += 1) {
        const next = (index + 1) % face.loops.length
        const side: MeshTopologyFace = {
          id: idFrom(deps.uuid),
          loops: [
            { vertexId: face.loops[index].vertexId, edgeId: '' },
            { vertexId: face.loops[next].vertexId, edgeId: '' },
            { vertexId: duplicated[next].id, edgeId: '' },
            { vertexId: duplicated[index].id, edgeId: '' }
          ],
          ...(face.materialIndex !== undefined ? { materialIndex: face.materialIndex } : {}),
          ...(face.smooth !== undefined ? { smooth: face.smooth } : {})
        }
        createdIds.add(side.id)
        document.faces.push(side)
      }
    }
    deleteFaces(document, new Set(selected.map((entry) => entry.id)), deletedIds)
    return
  }
  if (operation.operation === 'inset_faces') {
    const amount = finite(operation.amount, 'amount')
    if (amount <= 0 || amount >= 1)
      throw new Error('Inset amount must be greater than 0 and less than 1.')
    const selected = operation.faceIds.map((id) => requireFace(document, id))
    for (const face of selected) {
      const points = face.loops.map((entry) => requireVertex(document, entry.vertexId).position)
      const center = centroid(points)
      const insetVertices = face.loops.map((entry) => {
        const source = requireVertex(document, entry.vertexId)
        const created: MeshTopologyVertex = {
          ...source,
          id: idFrom(deps.uuid),
          position: lerp(source.position, center, amount),
          ...(source.weights ? { weights: source.weights.map((weight) => ({ ...weight })) } : {})
        }
        document.vertices.push(created)
        createdIds.add(created.id)
        return created
      })
      const inner: MeshTopologyFace = {
        ...face,
        id: idFrom(deps.uuid),
        loops: face.loops.map((entry, index) => ({
          ...entry,
          vertexId: insetVertices[index].id,
          edgeId: ''
        }))
      }
      createdIds.add(inner.id)
      document.faces.push(inner)
      for (let index = 0; index < face.loops.length; index += 1) {
        const next = (index + 1) % face.loops.length
        const rim: MeshTopologyFace = {
          id: idFrom(deps.uuid),
          loops: [
            { ...face.loops[index], edgeId: '' },
            { ...face.loops[next], edgeId: '' },
            { ...face.loops[next], vertexId: insetVertices[next].id, edgeId: '' },
            { ...face.loops[index], vertexId: insetVertices[index].id, edgeId: '' }
          ],
          ...(face.materialIndex !== undefined ? { materialIndex: face.materialIndex } : {})
        }
        createdIds.add(rim.id)
        document.faces.push(rim)
      }
    }
    deleteFaces(document, new Set(selected.map((entry) => entry.id)), deletedIds)
    return
  }
  if (operation.operation === 'subdivide_faces') {
    const selected = operation.faceIds.map((id) => requireFace(document, id))
    for (const face of selected) {
      const points = face.loops.map((entry) => requireVertex(document, entry.vertexId).position)
      const center: MeshTopologyVertex = {
        id: idFrom(deps.uuid),
        position: centroid(points)
      }
      document.vertices.push(center)
      createdIds.add(center.id)
      const uvCenter = face.loops.every((entry) => entry.uv)
        ? {
            u: face.loops.reduce((sum, entry) => sum + entry.uv!.u, 0) / face.loops.length,
            v: face.loops.reduce((sum, entry) => sum + entry.uv!.v, 0) / face.loops.length
          }
        : undefined
      for (let index = 0; index < face.loops.length; index += 1) {
        const next = (index + 1) % face.loops.length
        const child: MeshTopologyFace = {
          id: idFrom(deps.uuid),
          loops: [
            { ...face.loops[index], edgeId: '' },
            { ...face.loops[next], edgeId: '' },
            { vertexId: center.id, edgeId: '', ...(uvCenter ? { uv: { ...uvCenter } } : {}) }
          ],
          ...(face.materialIndex !== undefined ? { materialIndex: face.materialIndex } : {}),
          ...(face.smooth !== undefined ? { smooth: face.smooth } : {})
        }
        createdIds.add(child.id)
        document.faces.push(child)
      }
    }
    deleteFaces(document, new Set(selected.map((entry) => entry.id)), deletedIds)
    return
  }
  if (operation.operation === 'split_edge') {
    const edge = requireEdge(document, operation.edgeId)
    const factor = operation.factor === undefined ? 0.5 : finite(operation.factor, 'factor')
    if (factor <= 0 || factor >= 1) throw new Error('Split-edge factor must be between 0 and 1.')
    const first = requireVertex(document, edge.vertexIds[0])
    const second = requireVertex(document, edge.vertexIds[1])
    const created: MeshTopologyVertex = {
      id: idFrom(deps.uuid),
      position: lerp(first.position, second.position, factor)
    }
    document.vertices.push(created)
    createdIds.add(created.id)
    for (const face of document.faces) {
      const nextLoops: MeshTopologyLoop[] = []
      for (let index = 0; index < face.loops.length; index += 1) {
        const current = face.loops[index]
        const next = face.loops[(index + 1) % face.loops.length]
        nextLoops.push(current)
        if (current.edgeId !== edge.id) continue
        const splitUv =
          current.uv && next.uv
            ? {
                u: current.uv.u + (next.uv.u - current.uv.u) * factor,
                v: current.uv.v + (next.uv.v - current.uv.v) * factor
              }
            : undefined
        nextLoops.push({ vertexId: created.id, edgeId: '', ...(splitUv ? { uv: splitUv } : {}) })
      }
      face.loops = nextLoops
    }
    return
  }
  if (operation.operation === 'collapse_edge') {
    const edge = requireEdge(document, operation.edgeId)
    const keepId = operation.keepVertexId ?? edge.vertexIds[0]
    if (!edge.vertexIds.includes(keepId)) throw new Error('keepVertexId must be an edge endpoint.')
    const removeId = edge.vertexIds[0] === keepId ? edge.vertexIds[1] : edge.vertexIds[0]
    const keep = requireVertex(document, keepId)
    const removed = requireVertex(document, removeId)
    keep.position = lerp(keep.position, removed.position, 0.5)
    document.faces = document.faces
      .map((face) => ({
        ...face,
        loops: cleanFaceLoops(
          face.loops.map((entry) => ({
            ...entry,
            vertexId: entry.vertexId === removeId ? keepId : entry.vertexId
          }))
        )
      }))
      .filter((face) => {
        if (new Set(face.loops.map((loop) => loop.vertexId)).size >= 3) return true
        deletedIds.add(face.id)
        return false
      })
    document.vertices = document.vertices.filter((entry) => entry.id !== removeId)
    deletedIds.add(removeId)
    return
  }
  if (operation.operation === 'mark_edges') {
    if (operation.seam === undefined && operation.crease === undefined) {
      throw new Error('mark_edges requires seam and/or crease.')
    }
    for (const edgeId of operation.edgeIds) {
      const edge = requireEdge(document, edgeId)
      if (operation.seam !== undefined) edge.seam = operation.seam
      if (operation.crease !== undefined) {
        const crease = finite(operation.crease, 'crease')
        if (crease < 0 || crease > 1) throw new Error('Edge crease must be between 0 and 1.')
        edge.crease = crease
      }
    }
    return
  }
  if (operation.operation === 'set_face_uvs') {
    const face = requireFace(document, operation.faceId)
    if (operation.uvs.length !== face.loops.length) {
      throw new Error('Face UV count must match its loop count.')
    }
    face.loops.forEach((entry, index) => {
      entry.uv = uv(operation.uvs[index], `uvs[${index}]`)
    })
    return
  }
  if (operation.operation === 'unwrap_uv') {
    const scale = operation.scale === undefined ? 1 : finite(operation.scale, 'scale')
    const selected = operation.faceIds?.length
      ? operation.faceIds.map((id) => requireFace(document, id))
      : document.faces
    const vertices = vertexMap(document)
    for (const face of selected) {
      const normal = faceNormal(face, vertices)
      const dominant =
        Math.abs(normal.x) >= Math.abs(normal.y) && Math.abs(normal.x) >= Math.abs(normal.z)
          ? 'planar_x'
          : Math.abs(normal.y) >= Math.abs(normal.z)
            ? 'planar_y'
            : 'planar_z'
      const projection = operation.projection === 'box' ? dominant : operation.projection
      for (const entry of face.loops) {
        const point = requireVertex(document, entry.vertexId).position
        if (projection === 'planar_x') entry.uv = { u: point.y * scale, v: point.z * scale }
        else if (projection === 'planar_y') entry.uv = { u: point.x * scale, v: point.z * scale }
        else if (projection === 'planar_z') entry.uv = { u: point.x * scale, v: point.y * scale }
        else if (projection === 'cylindrical') {
          entry.uv = {
            u: (Math.atan2(point.z, point.x) / (Math.PI * 2) + 0.5) * scale,
            v: point.y * scale
          }
        } else {
          const radius = Math.max(1e-9, length(point))
          entry.uv = {
            u: (Math.atan2(point.z, point.x) / (Math.PI * 2) + 0.5) * scale,
            v: (Math.asin(point.y / radius) / Math.PI + 0.5) * scale
          }
        }
      }
    }
    return
  }
  if (operation.operation === 'sculpt') {
    const center = fullVector(operation.center, 'center')
    const radius = finite(operation.radius, 'radius')
    const strength = finite(operation.strength, 'strength')
    if (radius <= 0) throw new Error('Sculpt radius must be positive.')
    const allowed = operation.vertexIds ? new Set(operation.vertexIds) : null
    if (allowed) for (const id of allowed) requireVertex(document, id)
    const affected = document.vertices.filter(
      (entry) =>
        (!allowed || allowed.has(entry.id)) && length(subtract(entry.position, center)) <= radius
    )
    if (affected.length > MESH_TOPOLOGY_MAX_SCULPT_VERTICES) {
      throw new Error(
        `One sculpt operation can affect at most ${MESH_TOPOLOGY_MAX_SCULPT_VERTICES} vertices.`
      )
    }
    const snapshot = new Map(document.vertices.map((entry) => [entry.id, { ...entry.position }]))
    const neighborIds = new Map<string, Set<string>>()
    for (const edge of document.edges) {
      if (!neighborIds.has(edge.vertexIds[0])) neighborIds.set(edge.vertexIds[0], new Set())
      if (!neighborIds.has(edge.vertexIds[1])) neighborIds.set(edge.vertexIds[1], new Set())
      neighborIds.get(edge.vertexIds[0])!.add(edge.vertexIds[1])
      neighborIds.get(edge.vertexIds[1])!.add(edge.vertexIds[0])
    }
    const normals = new Map<string, MeshVector3>()
    const vertices = vertexMap(document)
    for (const face of document.faces) {
      const normal = faceNormal(face, vertices)
      for (const entry of face.loops)
        normals.set(
          entry.vertexId,
          add(normals.get(entry.vertexId) ?? { x: 0, y: 0, z: 0 }, normal)
        )
    }
    const direction = operation.direction
      ? fullVector(operation.direction, 'direction')
      : { x: 0, y: 1, z: 0 }
    for (const entry of affected) {
      const distance = length(subtract(entry.position, center))
      const factor = (1 - distance / radius) ** 2 * strength
      if (operation.mode === 'smooth') {
        const neighbors = [...(neighborIds.get(entry.id) ?? [])]
          .map((id) => snapshot.get(id))
          .filter(Boolean) as MeshVector3[]
        if (neighbors.length)
          entry.position = lerp(entry.position, centroid(neighbors), Math.min(1, Math.abs(factor)))
      } else if (operation.mode === 'pinch') {
        entry.position = lerp(entry.position, center, Math.min(1, Math.abs(factor)))
      } else if (operation.mode === 'grab') {
        entry.position = add(entry.position, multiply(direction, factor))
      } else if (operation.mode === 'flatten') {
        const planeNormal = normalize(direction)
        const relative = subtract(entry.position, center)
        const signedDistance =
          relative.x * planeNormal.x + relative.y * planeNormal.y + relative.z * planeNormal.z
        entry.position = subtract(entry.position, multiply(planeNormal, signedDistance * factor))
      } else {
        entry.position = add(
          entry.position,
          multiply(normalize(normals.get(entry.id) ?? direction), factor)
        )
      }
    }
    return
  }
  if (operation.operation === 'upsert_bones') {
    if (!operation.bones.length) throw new Error('upsert_bones requires at least one bone.')
    for (const input of operation.bones) {
      const id = checkedId(input.id, deps.uuid, 'Mesh topology bone id')
      const next: MeshTopologyBone = {
        id,
        name: input.name.trim(),
        ...(input.parentId ? { parentId: input.parentId } : {}),
        head: fullVector(input.head, 'bone.head'),
        tail: fullVector(input.tail, 'bone.tail'),
        ...(input.roll !== undefined ? { roll: finite(input.roll, 'bone.roll') } : {}),
        ...(input.pose ? { pose: JSON.parse(JSON.stringify(input.pose)) } : {})
      }
      if (!next.name || next.name.length > 200) throw new Error('Bone name is required.')
      const index = document.bones.findIndex((entry) => entry.id === id)
      if (index >= 0) document.bones[index] = next
      else {
        document.bones.push(next)
        createdIds.add(id)
      }
    }
    return
  }
  if (operation.operation === 'remove_bones') {
    const ids = new Set(operation.boneIds)
    for (const id of ids) {
      if (!document.bones.some((entry) => entry.id === id)) {
        throw new Error(`Mesh topology bone ${id} was not found.`)
      }
    }
    document.bones = document.bones
      .filter((entry) => {
        if (!ids.has(entry.id)) return true
        deletedIds.add(entry.id)
        return false
      })
      .map((entry) =>
        entry.parentId && ids.has(entry.parentId) ? { ...entry, parentId: undefined } : entry
      )
    for (const entry of document.vertices) {
      const retained = entry.weights?.filter((weight) => !ids.has(weight.boneId))
      entry.weights = weights(retained, document)
      if (!entry.weights) delete entry.weights
    }
    return
  }
  if (operation.operation === 'set_vertex_weights') {
    for (const input of operation.vertices) {
      const target = requireVertex(document, input.vertexId)
      const next = weights(input.weights, document)
      if (next) target.weights = next
      else delete target.weights
    }
    return
  }
  if (operation.operation === 'pose_bones') {
    for (const input of operation.bones) {
      const target = document.bones.find((entry) => entry.id === input.boneId)
      if (!target) throw new Error(`Mesh topology bone ${input.boneId} was not found.`)
      if (input.pose === null) delete target.pose
      else {
        target.pose = {
          ...(input.pose.translation
            ? { translation: fullVector(input.pose.translation, 'pose.translation') }
            : {}),
          ...(input.pose.rotation
            ? { rotation: fullVector(input.pose.rotation, 'pose.rotation') }
            : {}),
          ...(input.pose.scale ? { scale: fullVector(input.pose.scale, 'pose.scale') } : {})
        }
      }
    }
    return
  }
  if (operation.operation === 'replace_geometry') {
    const retainedSource = document.source
    const replacement: MeshTopologyDocument = {
      ...document,
      source: retainedSource,
      vertices: [],
      edges: [],
      faces: [],
      bones: [],
      recentMutations: document.recentMutations
    }
    if (operation.bones) {
      applyGeometryOperation(
        replacement,
        { operation: 'upsert_bones', bones: operation.bones },
        deps,
        createdIds,
        deletedIds
      )
    }
    for (const input of operation.vertices) {
      const created = newVertex(input, replacement, deps.uuid)
      if (replacement.vertices.some((entry) => entry.id === created.id)) {
        throw new Error(`Mesh topology id ${created.id} already exists.`)
      }
      replacement.vertices.push(created)
      createdIds.add(created.id)
    }
    for (const input of operation.faces) {
      const created = makeFace(input, replacement, deps.uuid)
      if (replacement.faces.some((entry) => entry.id === created.id)) {
        throw new Error(`Mesh topology id ${created.id} already exists.`)
      }
      replacement.faces.push(created)
      createdIds.add(created.id)
    }
    for (const entry of [
      ...document.vertices,
      ...document.edges,
      ...document.faces,
      ...document.bones
    ]) {
      deletedIds.add(entry.id)
    }
    document.vertices = replacement.vertices
    document.edges = replacement.edges
    document.faces = replacement.faces
    document.bones = replacement.bones
    return
  }
}

export function applyMeshTopologyEdit(
  source: MeshTopologyDocument,
  input: MeshTopologyEditInput,
  deps: MeshTopologyMutationDeps
): MeshTopologyEditResult {
  const duplicate = source.recentMutations.find(
    (entry) => entry.clientMutationId === input.clientMutationId
  )
  if (duplicate) {
    return {
      document: cloneDocument(source),
      summary: meshTopologySummary(source),
      createdIds: [],
      deletedIds: [],
      duplicate: true
    }
  }
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== source.revision) {
    throw new MeshTopologyRevisionConflictError(input.expectedRevision, source.revision)
  }
  if (!ELEMENT_ID_RE.test(input.clientMutationId)) {
    throw new Error('clientMutationId must be 3-128 letters, digits, underscores, or hyphens.')
  }
  if (
    !Array.isArray(input.operations) ||
    !input.operations.length ||
    input.operations.length > MESH_TOPOLOGY_MAX_EDIT_OPERATIONS
  ) {
    throw new Error(`A topology edit requires 1-${MESH_TOPOLOGY_MAX_EDIT_OPERATIONS} operations.`)
  }
  const document = cloneDocument(source)
  const createdIds = new Set<string>()
  const deletedIds = new Set<string>()
  for (const operation of input.operations) {
    applyGeometryOperation(document, operation, deps, createdIds, deletedIds)
    rebuildEdges(document, deps.uuid, createdIds, deletedIds)
    if (document.vertices.length > MESH_TOPOLOGY_MAX_VERTICES) {
      throw new Error(`Editable topology supports at most ${MESH_TOPOLOGY_MAX_VERTICES} vertices.`)
    }
    if (document.bones.length > MESH_TOPOLOGY_MAX_BONES) {
      throw new Error(`Editable topology supports at most ${MESH_TOPOLOGY_MAX_BONES} bones.`)
    }
  }
  const updatedAt = deps.now()
  document.revision += 1
  document.updatedAt = updatedAt
  document.recentMutations = [
    {
      clientMutationId: input.clientMutationId,
      revision: document.revision,
      updatedAt,
      ...(input.editor ? { editor: { ...input.editor } } : {})
    },
    ...document.recentMutations
  ].slice(0, MESH_TOPOLOGY_MAX_RECENT_MUTATIONS)
  const normalized = normalizeMeshTopologyDocument(document)
  if (!normalized) throw new Error('Topology edit would create invalid geometry.')
  return {
    document: normalized,
    summary: meshTopologySummary(normalized),
    createdIds: [...createdIds],
    deletedIds: [...deletedIds],
    duplicate: false
  }
}
