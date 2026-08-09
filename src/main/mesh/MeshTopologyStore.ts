/** Atomic, one-document-per-file storage for editable Mesh Canvas topology. */
import * as fs from 'fs'
import * as path from 'path'
import {
  MESH_TOPOLOGY_MAX_BONES,
  MESH_TOPOLOGY_MAX_EDGES,
  MESH_TOPOLOGY_MAX_FACES,
  MESH_TOPOLOGY_MAX_LOOPS,
  MESH_TOPOLOGY_MAX_RECENT_MUTATIONS,
  MESH_TOPOLOGY_MAX_VERTICES,
  MESH_TOPOLOGY_MAX_WEIGHTS_PER_VERTEX,
  MESH_TOPOLOGY_SCHEMA_VERSION,
  meshTopologyEdgeKey,
  type MeshTopologyBone,
  type MeshTopologyBonePose,
  type MeshTopologyDocument,
  type MeshTopologyEdge,
  type MeshTopologyFace,
  type MeshTopologyLoop,
  type MeshTopologyMutationReceipt,
  type MeshTopologySource,
  type MeshTopologyVertex,
  type MeshTopologyWeight,
  type MeshVector2
} from '../../shared/meshTopology'
import {
  isMeshImportFormat,
  isMeshPrimitiveKind,
  isSafeMeshAssetRelativePath,
  type MeshVector3
} from '../../shared/meshScene'

const TOPOLOGY_ID_RE = /^[a-zA-Z0-9_-]{3,128}$/
const ASSET_ID_RE = /^[a-zA-Z0-9_-]{16,128}$/
const MAX_TOPOLOGY_FILE_BYTES = 64 * 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown, limit = 256): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed && trimmed.length <= limit ? trimmed : null
}

function finite(value: unknown, min = -1_000_000, max = 1_000_000): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null
}

function vector3(value: unknown): MeshVector3 | null {
  if (!isRecord(value)) return null
  const x = finite(value.x)
  const y = finite(value.y)
  const z = finite(value.z)
  return x === null || y === null || z === null ? null : { x, y, z }
}

function vector2(value: unknown): MeshVector2 | null {
  if (!isRecord(value)) return null
  const u = finite(value.u)
  const v = finite(value.v)
  return u === null || v === null ? null : { u, v }
}

function pose(value: unknown): MeshTopologyBonePose | null {
  if (!isRecord(value)) return null
  const translation = value.translation === undefined ? undefined : vector3(value.translation)
  const rotation = value.rotation === undefined ? undefined : vector3(value.rotation)
  const scale = value.scale === undefined ? undefined : vector3(value.scale)
  if (translation === null || rotation === null || scale === null) return null
  return {
    ...(translation ? { translation } : {}),
    ...(rotation ? { rotation } : {}),
    ...(scale ? { scale } : {})
  }
}

function source(value: unknown): MeshTopologySource | null {
  if (!isRecord(value)) return null
  if (value.kind === 'generated') return { kind: 'generated' }
  if (value.kind === 'primitive' && isMeshPrimitiveKind(value.primitive)) {
    return { kind: 'primitive', primitive: value.primitive }
  }
  const assetId = stringValue(value.assetId, 128)
  const entryPath = typeof value.entryPath === 'string' ? value.entryPath : ''
  if (
    value.kind === 'import' &&
    assetId &&
    ASSET_ID_RE.test(assetId) &&
    isMeshImportFormat(value.format) &&
    isSafeMeshAssetRelativePath(entryPath)
  ) {
    return { kind: 'import', assetId, format: value.format, entryPath }
  }
  return null
}

function weight(value: unknown): MeshTopologyWeight | null {
  if (!isRecord(value)) return null
  const boneId = stringValue(value.boneId, 128)
  const amount = finite(value.weight, 0, 1)
  return boneId && TOPOLOGY_ID_RE.test(boneId) && amount !== null
    ? { boneId, weight: amount }
    : null
}

function vertex(value: unknown): MeshTopologyVertex | null {
  if (!isRecord(value)) return null
  const id = stringValue(value.id, 128)
  const position = vector3(value.position)
  if (!id || !TOPOLOGY_ID_RE.test(id) || !position) return null
  const rawWeights = value.weights === undefined ? [] : value.weights
  if (!Array.isArray(rawWeights) || rawWeights.length > MESH_TOPOLOGY_MAX_WEIGHTS_PER_VERTEX) {
    return null
  }
  const weights = rawWeights.map(weight)
  if (weights.some((entry) => entry === null)) return null
  const normalizedWeights = weights as MeshTopologyWeight[]
  if (new Set(normalizedWeights.map((entry) => entry.boneId)).size !== normalizedWeights.length) {
    return null
  }
  const total = normalizedWeights.reduce((sum, entry) => sum + entry.weight, 0)
  return {
    id,
    position,
    ...(total > 0
      ? {
          weights: normalizedWeights.map((entry) => ({
            boneId: entry.boneId,
            weight: entry.weight / total
          }))
        }
      : {})
  }
}

function edge(value: unknown): MeshTopologyEdge | null {
  if (!isRecord(value) || !Array.isArray(value.vertexIds) || value.vertexIds.length !== 2) {
    return null
  }
  const id = stringValue(value.id, 128)
  const first = stringValue(value.vertexIds[0], 128)
  const second = stringValue(value.vertexIds[1], 128)
  const crease = value.crease === undefined ? undefined : finite(value.crease, 0, 1)
  if (!id || !TOPOLOGY_ID_RE.test(id) || !first || !second || first === second || crease === null) {
    return null
  }
  return {
    id,
    vertexIds: [first, second],
    ...(value.seam === true ? { seam: true } : {}),
    ...(crease !== undefined ? { crease } : {})
  }
}

function loop(value: unknown): MeshTopologyLoop | null {
  if (!isRecord(value)) return null
  const vertexId = stringValue(value.vertexId, 128)
  const edgeId = stringValue(value.edgeId, 128)
  const uv = value.uv === undefined ? undefined : vector2(value.uv)
  if (!vertexId || !edgeId || uv === null) return null
  return { vertexId, edgeId, ...(uv ? { uv } : {}) }
}

function face(value: unknown): MeshTopologyFace | null {
  if (!isRecord(value) || !Array.isArray(value.loops) || value.loops.length < 3) return null
  const id = stringValue(value.id, 128)
  const loops = value.loops.map(loop)
  const materialIndex =
    value.materialIndex === undefined ? undefined : finite(value.materialIndex, 0, 65_535)
  if (
    !id ||
    !TOPOLOGY_ID_RE.test(id) ||
    loops.some((entry) => entry === null) ||
    materialIndex === null ||
    (materialIndex !== undefined && !Number.isInteger(materialIndex))
  ) {
    return null
  }
  return {
    id,
    loops: loops as MeshTopologyLoop[],
    ...(materialIndex !== undefined ? { materialIndex } : {}),
    ...(typeof value.smooth === 'boolean' ? { smooth: value.smooth } : {})
  }
}

function bone(value: unknown): MeshTopologyBone | null {
  if (!isRecord(value)) return null
  const id = stringValue(value.id, 128)
  const name = stringValue(value.name, 200)
  const parentId = value.parentId === undefined ? undefined : stringValue(value.parentId, 128)
  const head = vector3(value.head)
  const tail = vector3(value.tail)
  const roll = value.roll === undefined ? undefined : finite(value.roll, -360_000, 360_000)
  const nextPose = value.pose === undefined ? undefined : pose(value.pose)
  if (
    !id ||
    !TOPOLOGY_ID_RE.test(id) ||
    !name ||
    !head ||
    !tail ||
    roll === null ||
    nextPose === null
  ) {
    return null
  }
  if (head.x === tail.x && head.y === tail.y && head.z === tail.z) return null
  return {
    id,
    name,
    ...(parentId ? { parentId } : {}),
    head,
    tail,
    ...(roll !== undefined ? { roll } : {}),
    ...(nextPose ? { pose: nextPose } : {})
  }
}

function receipt(value: unknown): MeshTopologyMutationReceipt | null {
  if (!isRecord(value)) return null
  const clientMutationId = stringValue(value.clientMutationId, 128)
  const revision = finite(value.revision, 0, Number.MAX_SAFE_INTEGER)
  const updatedAt = stringValue(value.updatedAt, 128)
  if (!clientMutationId || revision === null || !Number.isInteger(revision) || !updatedAt)
    return null
  const editor = isRecord(value.editor)
    ? {
        ...(stringValue(value.editor.provider, 100)
          ? { provider: stringValue(value.editor.provider, 100)! }
          : {}),
        ...(stringValue(value.editor.runId, 256)
          ? { runId: stringValue(value.editor.runId, 256)! }
          : {}),
        ...(stringValue(value.editor.participantId, 256)
          ? { participantId: stringValue(value.editor.participantId, 256)! }
          : {})
      }
    : undefined
  return { clientMutationId, revision, updatedAt, ...(editor ? { editor } : {}) }
}

function uniqueIds(values: readonly { id: string }[]): boolean {
  return new Set(values.map((value) => value.id)).size === values.length
}

function hasBoneCycle(bones: readonly MeshTopologyBone[]): boolean {
  const parents = new Map(bones.map((entry) => [entry.id, entry.parentId]))
  for (const start of parents.keys()) {
    const seen = new Set<string>()
    let cursor: string | undefined = start
    while (cursor) {
      if (seen.has(cursor)) return true
      seen.add(cursor)
      cursor = parents.get(cursor)
    }
  }
  return false
}

export function normalizeMeshTopologyDocument(value: unknown): MeshTopologyDocument | null {
  if (!isRecord(value) || value.schemaVersion !== MESH_TOPOLOGY_SCHEMA_VERSION) return null
  const id = stringValue(value.id, 128)
  const revision = finite(value.revision, 0, Number.MAX_SAFE_INTEGER)
  const name = stringValue(value.name, 200)
  const topologySource = source(value.source)
  const createdAt = stringValue(value.createdAt, 128)
  const updatedAt = stringValue(value.updatedAt, 128)
  if (
    !id ||
    !TOPOLOGY_ID_RE.test(id) ||
    revision === null ||
    !Number.isInteger(revision) ||
    !name ||
    !topologySource ||
    !createdAt ||
    !updatedAt ||
    !Array.isArray(value.vertices) ||
    !Array.isArray(value.edges) ||
    !Array.isArray(value.faces) ||
    !Array.isArray(value.bones) ||
    !Array.isArray(value.recentMutations) ||
    value.vertices.length > MESH_TOPOLOGY_MAX_VERTICES ||
    value.edges.length > MESH_TOPOLOGY_MAX_EDGES ||
    value.faces.length > MESH_TOPOLOGY_MAX_FACES ||
    value.bones.length > MESH_TOPOLOGY_MAX_BONES ||
    value.recentMutations.length > MESH_TOPOLOGY_MAX_RECENT_MUTATIONS
  ) {
    return null
  }
  const vertices = value.vertices.map(vertex)
  const edges = value.edges.map(edge)
  const faces = value.faces.map(face)
  const bones = value.bones.map(bone)
  const receipts = value.recentMutations.map(receipt)
  if (
    vertices.some((entry) => entry === null) ||
    edges.some((entry) => entry === null) ||
    faces.some((entry) => entry === null) ||
    bones.some((entry) => entry === null) ||
    receipts.some((entry) => entry === null)
  ) {
    return null
  }
  const normalizedVertices = vertices as MeshTopologyVertex[]
  const normalizedEdges = edges as MeshTopologyEdge[]
  const normalizedFaces = faces as MeshTopologyFace[]
  const normalizedBones = bones as MeshTopologyBone[]
  const normalizedReceipts = receipts as MeshTopologyMutationReceipt[]
  if (
    !uniqueIds(normalizedVertices) ||
    !uniqueIds(normalizedEdges) ||
    !uniqueIds(normalizedFaces) ||
    !uniqueIds(normalizedBones) ||
    new Set(normalizedReceipts.map((entry) => entry.clientMutationId)).size !==
      normalizedReceipts.length ||
    normalizedFaces.reduce((total, entry) => total + entry.loops.length, 0) >
      MESH_TOPOLOGY_MAX_LOOPS
  ) {
    return null
  }
  const vertexIds = new Set(normalizedVertices.map((entry) => entry.id))
  const boneIds = new Set(normalizedBones.map((entry) => entry.id))
  const edgeById = new Map(normalizedEdges.map((entry) => [entry.id, entry]))
  const edgeKeys = new Set<string>()
  for (const entry of normalizedEdges) {
    const key = meshTopologyEdgeKey(entry.vertexIds[0], entry.vertexIds[1])
    if (
      !vertexIds.has(entry.vertexIds[0]) ||
      !vertexIds.has(entry.vertexIds[1]) ||
      edgeKeys.has(key)
    ) {
      return null
    }
    edgeKeys.add(key)
  }
  for (const entry of normalizedFaces) {
    if (new Set(entry.loops.map((item) => item.vertexId)).size < 3) return null
    for (let index = 0; index < entry.loops.length; index += 1) {
      const current = entry.loops[index]
      const next = entry.loops[(index + 1) % entry.loops.length]
      const faceEdge = edgeById.get(current.edgeId)
      if (
        !vertexIds.has(current.vertexId) ||
        !faceEdge ||
        meshTopologyEdgeKey(faceEdge.vertexIds[0], faceEdge.vertexIds[1]) !==
          meshTopologyEdgeKey(current.vertexId, next.vertexId)
      ) {
        return null
      }
    }
  }
  for (const entry of normalizedBones) {
    if (entry.parentId && (!boneIds.has(entry.parentId) || entry.parentId === entry.id)) return null
  }
  if (hasBoneCycle(normalizedBones)) return null
  for (const entry of normalizedVertices) {
    if (entry.weights?.some((item) => !boneIds.has(item.boneId))) return null
  }
  return {
    schemaVersion: MESH_TOPOLOGY_SCHEMA_VERSION,
    id,
    revision,
    name,
    source: topologySource,
    vertices: normalizedVertices,
    edges: normalizedEdges,
    faces: normalizedFaces,
    bones: normalizedBones,
    recentMutations: normalizedReceipts,
    createdAt,
    updatedAt
  }
}

function cloneDocument(document: MeshTopologyDocument): MeshTopologyDocument {
  return JSON.parse(JSON.stringify(document)) as MeshTopologyDocument
}

export class MeshTopologyStore {
  constructor(private readonly baseDir: string) {}

  private ensureRoot(): void {
    fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 })
    const stat = fs.lstatSync(this.baseDir)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Mesh topology store path is not a safe directory.')
    }
  }

  private documentPath(topologyId: string): string {
    if (!TOPOLOGY_ID_RE.test(topologyId)) throw new Error('Invalid mesh topology id.')
    return path.join(this.baseDir, `${topologyId}.json`)
  }

  get(topologyId: string): MeshTopologyDocument | null {
    try {
      this.ensureRoot()
      const documentPath = this.documentPath(topologyId)
      const stat = fs.lstatSync(documentPath)
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_TOPOLOGY_FILE_BYTES)
        return null
      const normalized = normalizeMeshTopologyDocument(
        JSON.parse(fs.readFileSync(documentPath, 'utf8'))
      )
      return normalized ? cloneDocument(normalized) : null
    } catch {
      return null
    }
  }

  upsert(document: MeshTopologyDocument): MeshTopologyDocument {
    const normalized = normalizeMeshTopologyDocument(document)
    if (!normalized) throw new Error('Mesh topology document is invalid.')
    this.ensureRoot()
    const serialized = JSON.stringify(normalized)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_TOPOLOGY_FILE_BYTES) {
      throw new Error('Mesh topology document exceeds the 64 MiB storage limit.')
    }
    const destination = this.documentPath(normalized.id)
    const temporary = path.join(this.baseDir, `.${normalized.id}.${process.pid}.${Date.now()}.tmp`)
    try {
      fs.writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      fs.renameSync(temporary, destination)
    } finally {
      try {
        fs.rmSync(temporary, { force: true })
      } catch {
        // Best-effort cleanup after an atomic rename.
      }
    }
    return cloneDocument(normalized)
  }

  remove(topologyIds: Iterable<string>): void {
    this.ensureRoot()
    for (const topologyId of new Set(topologyIds)) {
      if (!TOPOLOGY_ID_RE.test(topologyId)) continue
      const target = this.documentPath(topologyId)
      try {
        const stat = fs.lstatSync(target)
        if (stat.isSymbolicLink() || !stat.isFile()) continue
        fs.rmSync(target, { force: true })
      } catch {
        // Missing is the desired end state.
      }
    }
  }

  clearAll(): void {
    try {
      this.ensureRoot()
      this.remove(
        fs
          .readdirSync(this.baseDir)
          .filter((name) => name.endsWith('.json'))
          .map((name) => name.slice(0, -'.json'.length))
      )
    } catch {
      // Keep cleanup bounded to the verified topology directory.
    }
  }
}
