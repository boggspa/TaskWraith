/** Primitive and imported-model conversion into TaskWraith's editable topology. */
import * as fs from 'fs'
import * as path from 'path'
import {
  MESH_TOPOLOGY_MAX_FACES,
  MESH_TOPOLOGY_MAX_VERTICES,
  MESH_TOPOLOGY_SCHEMA_VERSION,
  meshTopologyEdgeKey,
  type MeshTopologyBone,
  type MeshTopologyDocument,
  type MeshTopologyEdge,
  type MeshTopologyFace,
  type MeshTopologySource,
  type MeshTopologyVertex,
  type MeshTopologyWeight,
  type MeshVector2
} from '../../shared/meshTopology'
import type {
  MeshAssetManifest,
  MeshImportedNode,
  MeshPrimitiveKind,
  MeshVector3
} from '../../shared/meshScene'
import type { MeshAssetStore } from './MeshAssetStore'

interface RawVertex {
  position: MeshVector3
  weights?: MeshTopologyWeight[]
}

interface RawFace {
  indices: number[]
  uvs?: MeshVector2[]
  materialIndex?: number
  smooth?: boolean
}

interface GeometryBuildInput {
  topologyId: string
  name: string
  source: MeshTopologySource
  vertices: RawVertex[]
  faces: RawFace[]
  bones?: MeshTopologyBone[]
  uuid: () => string
  now: () => string
}

function elementId(uuid: () => string): string {
  const id = uuid().replace(/[^a-zA-Z0-9_-]/g, '')
  if (!/^[a-zA-Z0-9_-]{3,128}$/.test(id)) {
    throw new Error('Mesh topology id generator returned an invalid id.')
  }
  return id
}

function buildTopology(input: GeometryBuildInput): MeshTopologyDocument {
  if (!input.vertices.length || !input.faces.length) {
    throw new Error('Editable topology requires at least one vertex and one face.')
  }
  if (input.vertices.length > MESH_TOPOLOGY_MAX_VERTICES) {
    throw new Error(`Imported topology exceeds ${MESH_TOPOLOGY_MAX_VERTICES} vertices.`)
  }
  if (input.faces.length > MESH_TOPOLOGY_MAX_FACES) {
    throw new Error(`Imported topology exceeds ${MESH_TOPOLOGY_MAX_FACES} faces.`)
  }
  const vertices: MeshTopologyVertex[] = input.vertices.map((entry) => ({
    id: elementId(input.uuid),
    position: { ...entry.position },
    ...(entry.weights?.length ? { weights: entry.weights.map((weight) => ({ ...weight })) } : {})
  }))
  const edges: MeshTopologyEdge[] = []
  const edgeByKey = new Map<string, MeshTopologyEdge>()
  const faces: MeshTopologyFace[] = input.faces.map((entry) => {
    if (entry.indices.length < 3 || new Set(entry.indices).size < 3) {
      throw new Error('Imported topology contains a degenerate face.')
    }
    if (entry.uvs && entry.uvs.length !== entry.indices.length) {
      throw new Error('Imported topology contains a mismatched UV loop.')
    }
    const loops = entry.indices.map((vertexIndex, index) => {
      const nextIndex = entry.indices[(index + 1) % entry.indices.length]
      const vertex = vertices[vertexIndex]
      const next = vertices[nextIndex]
      if (!vertex || !next) throw new Error('Imported face references a missing vertex.')
      const key = meshTopologyEdgeKey(vertex.id, next.id)
      let edge = edgeByKey.get(key)
      if (!edge) {
        edge = { id: elementId(input.uuid), vertexIds: [vertex.id, next.id] }
        edgeByKey.set(key, edge)
        edges.push(edge)
      }
      return {
        vertexId: vertex.id,
        edgeId: edge.id,
        ...(entry.uvs ? { uv: { ...entry.uvs[index] } } : {})
      }
    })
    return {
      id: elementId(input.uuid),
      loops,
      ...(entry.materialIndex !== undefined ? { materialIndex: entry.materialIndex } : {}),
      ...(entry.smooth !== undefined ? { smooth: entry.smooth } : {})
    }
  })
  const now = input.now()
  return {
    schemaVersion: MESH_TOPOLOGY_SCHEMA_VERSION,
    id: input.topologyId,
    revision: 0,
    name: input.name,
    source: input.source,
    vertices,
    edges,
    faces,
    bones: input.bones?.map((bone) => JSON.parse(JSON.stringify(bone)) as MeshTopologyBone) ?? [],
    recentMutations: [],
    createdAt: now,
    updatedAt: now
  }
}

function primitiveBox(): { vertices: RawVertex[]; faces: RawFace[] } {
  const s = 0.8
  const vertices = [
    [-s, -s, -s],
    [s, -s, -s],
    [s, s, -s],
    [-s, s, -s],
    [-s, -s, s],
    [s, -s, s],
    [s, s, s],
    [-s, s, s]
  ].map(([x, y, z]) => ({ position: { x, y, z } }))
  const square = [
    { u: 0, v: 0 },
    { u: 1, v: 0 },
    { u: 1, v: 1 },
    { u: 0, v: 1 }
  ]
  return {
    vertices,
    faces: [
      [0, 3, 2, 1],
      [4, 5, 6, 7],
      [0, 1, 5, 4],
      [3, 7, 6, 2],
      [0, 4, 7, 3],
      [1, 2, 6, 5]
    ].map((indices) => ({ indices, uvs: square.map((entry) => ({ ...entry })) }))
  }
}

function primitivePlane(): { vertices: RawVertex[]; faces: RawFace[] } {
  return {
    vertices: [
      { position: { x: -1, y: -1, z: 0 } },
      { position: { x: 1, y: -1, z: 0 } },
      { position: { x: 1, y: 1, z: 0 } },
      { position: { x: -1, y: 1, z: 0 } }
    ],
    faces: [
      {
        indices: [0, 1, 2, 3],
        uvs: [
          { u: 0, v: 0 },
          { u: 1, v: 0 },
          { u: 1, v: 1 },
          { u: 0, v: 1 }
        ]
      }
    ]
  }
}

function primitiveCylinder(segments = 32): { vertices: RawVertex[]; faces: RawFace[] } {
  const vertices: RawVertex[] = []
  for (const y of [-1, 1]) {
    for (let segment = 0; segment < segments; segment += 1) {
      const angle = (segment / segments) * Math.PI * 2
      vertices.push({ position: { x: Math.cos(angle) * 0.8, y, z: Math.sin(angle) * 0.8 } })
    }
  }
  const faces: RawFace[] = []
  for (let segment = 0; segment < segments; segment += 1) {
    const next = (segment + 1) % segments
    faces.push({
      indices: [segment, next, segments + next, segments + segment],
      uvs: [
        { u: segment / segments, v: 0 },
        { u: (segment + 1) / segments, v: 0 },
        { u: (segment + 1) / segments, v: 1 },
        { u: segment / segments, v: 1 }
      ],
      smooth: true
    })
  }
  faces.push({ indices: Array.from({ length: segments }, (_, index) => segments - 1 - index) })
  faces.push({ indices: Array.from({ length: segments }, (_, index) => segments + index) })
  return { vertices, faces }
}

function primitiveSphere(segments = 32, rings = 16): { vertices: RawVertex[]; faces: RawFace[] } {
  const vertices: RawVertex[] = [{ position: { x: 0, y: 1, z: 0 } }]
  for (let ring = 1; ring < rings; ring += 1) {
    const phi = (ring / rings) * Math.PI
    for (let segment = 0; segment < segments; segment += 1) {
      const theta = (segment / segments) * Math.PI * 2
      vertices.push({
        position: {
          x: Math.sin(phi) * Math.cos(theta),
          y: Math.cos(phi),
          z: Math.sin(phi) * Math.sin(theta)
        }
      })
    }
  }
  const bottom = vertices.length
  vertices.push({ position: { x: 0, y: -1, z: 0 } })
  const indexAt = (ring: number, segment: number): number =>
    1 + (ring - 1) * segments + ((segment + segments) % segments)
  const faces: RawFace[] = []
  for (let segment = 0; segment < segments; segment += 1) {
    faces.push({ indices: [0, indexAt(1, segment), indexAt(1, segment + 1)], smooth: true })
  }
  for (let ring = 1; ring < rings - 1; ring += 1) {
    for (let segment = 0; segment < segments; segment += 1) {
      faces.push({
        indices: [
          indexAt(ring, segment),
          indexAt(ring + 1, segment),
          indexAt(ring + 1, segment + 1),
          indexAt(ring, segment + 1)
        ],
        smooth: true
      })
    }
  }
  for (let segment = 0; segment < segments; segment += 1) {
    faces.push({
      indices: [indexAt(rings - 1, segment + 1), indexAt(rings - 1, segment), bottom],
      smooth: true
    })
  }
  return { vertices, faces }
}

function primitiveTorus(
  majorSegments = 32,
  minorSegments = 16
): {
  vertices: RawVertex[]
  faces: RawFace[]
} {
  const vertices: RawVertex[] = []
  for (let major = 0; major < majorSegments; major += 1) {
    const theta = (major / majorSegments) * Math.PI * 2
    for (let minor = 0; minor < minorSegments; minor += 1) {
      const phi = (minor / minorSegments) * Math.PI * 2
      const radius = 1 + Math.cos(phi) * 0.32
      vertices.push({
        position: {
          x: radius * Math.cos(theta),
          y: Math.sin(phi) * 0.32,
          z: radius * Math.sin(theta)
        }
      })
    }
  }
  const at = (major: number, minor: number): number =>
    ((major + majorSegments) % majorSegments) * minorSegments +
    ((minor + minorSegments) % minorSegments)
  const faces: RawFace[] = []
  for (let major = 0; major < majorSegments; major += 1) {
    for (let minor = 0; minor < minorSegments; minor += 1) {
      faces.push({
        indices: [
          at(major, minor),
          at(major + 1, minor),
          at(major + 1, minor + 1),
          at(major, minor + 1)
        ],
        smooth: true
      })
    }
  }
  return { vertices, faces }
}

export function meshTopologyFromPrimitive(input: {
  topologyId: string
  primitive: MeshPrimitiveKind
  name: string
  uuid: () => string
  now: () => string
}): MeshTopologyDocument {
  const geometry =
    input.primitive === 'plane'
      ? primitivePlane()
      : input.primitive === 'cylinder'
        ? primitiveCylinder()
        : input.primitive === 'sphere'
          ? primitiveSphere()
          : input.primitive === 'torus'
            ? primitiveTorus()
            : primitiveBox()
  return buildTopology({
    ...input,
    source: { kind: 'primitive', primitive: input.primitive },
    ...geometry
  })
}

function objIndex(raw: string, length: number): number {
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed === 0) throw new Error('OBJ contains an invalid index.')
  const index = parsed > 0 ? parsed - 1 : length + parsed
  if (index < 0 || index >= length) throw new Error('OBJ index is outside its source array.')
  return index
}

function parseObj(source: string): { vertices: RawVertex[]; faces: RawFace[] } {
  const positions: MeshVector3[] = []
  const texcoords: MeshVector2[] = []
  const faces: RawFace[] = []
  const materials = new Map<string, number>()
  let materialIndex: number | undefined
  for (const originalLine of source.replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
    const line = originalLine.trim()
    if (!line || line.startsWith('#')) continue
    const [keyword, ...values] = line.split(/\s+/)
    if (keyword === 'v') {
      const [x, y, z] = values.map(Number)
      if (![x, y, z].every(Number.isFinite)) throw new Error('OBJ vertex is invalid.')
      positions.push({ x, y, z })
    } else if (keyword === 'vt') {
      const [u, v] = values.map(Number)
      if (![u, v].every(Number.isFinite)) throw new Error('OBJ texture coordinate is invalid.')
      texcoords.push({ u, v })
    } else if (keyword === 'usemtl') {
      const name = values.join(' ')
      if (!materials.has(name)) materials.set(name, materials.size)
      materialIndex = materials.get(name)
    } else if (keyword === 'f') {
      if (values.length < 3) throw new Error('OBJ face has fewer than three vertices.')
      const indices: number[] = []
      const uvs: Array<MeshVector2 | null> = []
      for (const token of values) {
        const [vertexToken, uvToken] = token.split('/')
        indices.push(objIndex(vertexToken, positions.length))
        uvs.push(uvToken ? (texcoords[objIndex(uvToken, texcoords.length)] ?? null) : null)
      }
      faces.push({
        indices,
        ...(uvs.every(Boolean) ? { uvs: uvs as MeshVector2[] } : {}),
        ...(materialIndex !== undefined ? { materialIndex } : {})
      })
    }
  }
  if (!positions.length || !faces.length) throw new Error('OBJ contains no editable polygon mesh.')
  return { vertices: positions.map((position) => ({ position })), faces }
}

type JsonRecord = Record<string, unknown>
type Matrix4 = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number
]

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {}
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

const IDENTITY: Matrix4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function multiplyMatrices(a: Matrix4, b: Matrix4): Matrix4 {
  const result = new Array<number>(16).fill(0)
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let cursor = 0; cursor < 4; cursor += 1) {
        result[column * 4 + row] += a[cursor * 4 + row] * b[column * 4 + cursor]
      }
    }
  }
  return result as Matrix4
}

function nodeMatrix(node: JsonRecord): Matrix4 {
  if (
    Array.isArray(node.matrix) &&
    node.matrix.length === 16 &&
    node.matrix.every(Number.isFinite)
  ) {
    return node.matrix as Matrix4
  }
  const translation = Array.isArray(node.translation) ? node.translation.map(Number) : [0, 0, 0]
  const rotation = Array.isArray(node.rotation) ? node.rotation.map(Number) : [0, 0, 0, 1]
  const scale = Array.isArray(node.scale) ? node.scale.map(Number) : [1, 1, 1]
  if (![...translation, ...rotation, ...scale].every(Number.isFinite)) {
    throw new Error('glTF node transform is invalid.')
  }
  const [x, y, z, w] = rotation
  const [sx, sy, sz] = scale
  const xx = x * x
  const yy = y * y
  const zz = z * z
  const xy = x * y
  const xz = x * z
  const yz = y * z
  const wx = w * x
  const wy = w * y
  const wz = w * z
  return [
    (1 - 2 * (yy + zz)) * sx,
    2 * (xy + wz) * sx,
    2 * (xz - wy) * sx,
    0,
    2 * (xy - wz) * sy,
    (1 - 2 * (xx + zz)) * sy,
    2 * (yz + wx) * sy,
    0,
    2 * (xz + wy) * sz,
    2 * (yz - wx) * sz,
    (1 - 2 * (xx + yy)) * sz,
    0,
    Number(translation[0] ?? 0),
    Number(translation[1] ?? 0),
    Number(translation[2] ?? 0),
    1
  ]
}

function transformPoint(matrix: Matrix4, point: readonly number[]): MeshVector3 {
  const x = Number(point[0] ?? 0)
  const y = Number(point[1] ?? 0)
  const z = Number(point[2] ?? 0)
  return {
    x: matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    y: matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    z: matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]
  }
}

function decodeDataUri(uri: string): Buffer | null {
  const match = /^data:.*?;base64,([a-z0-9+/=\r\n]+)$/i.exec(uri)
  return match ? Buffer.from(match[1], 'base64') : null
}

function parseGlb(contents: Buffer): { json: JsonRecord; binary?: Buffer } {
  if (contents.length < 20 || contents.readUInt32LE(0) !== 0x46546c67) {
    throw new Error('GLB header is invalid.')
  }
  if (contents.readUInt32LE(4) !== 2 || contents.readUInt32LE(8) !== contents.length) {
    throw new Error('Only well-formed GLB 2.0 files are editable.')
  }
  let offset = 12
  let json: JsonRecord | null = null
  let binary: Buffer | undefined
  while (offset + 8 <= contents.length) {
    const length = contents.readUInt32LE(offset)
    const type = contents.readUInt32LE(offset + 4)
    const chunk = contents.subarray(offset + 8, offset + 8 + length)
    if (type === 0x4e4f534a)
      json = record(JSON.parse(chunk.toString('utf8').replace(/[\0\s]+$/, '')))
    if (type === 0x004e4942 && !binary) binary = chunk
    offset += 8 + length
  }
  if (!json) throw new Error('GLB has no JSON scene chunk.')
  return { json, ...(binary ? { binary } : {}) }
}

function resolveVaultBuffer(
  manifest: MeshAssetManifest,
  assets: MeshAssetStore,
  entryPath: string,
  uri: string
): Buffer {
  const embedded = decodeDataUri(uri)
  if (embedded) return embedded
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.includes('?') || uri.includes('#')) {
    throw new Error('glTF external buffers must be local files in the imported asset bundle.')
  }
  const relativePath = path.posix.normalize(
    path.posix.join(path.posix.dirname(entryPath), decodeURIComponent(uri))
  )
  const resolved = assets.resolveAssetFile({
    assetId: manifest.id,
    accessToken: manifest.accessToken,
    relativePath
  })
  if (!resolved) throw new Error(`glTF buffer ${uri} is unavailable in the private asset bundle.`)
  return fs.readFileSync(resolved.filePath)
}

interface GltfAccess {
  json: JsonRecord
  buffers: Buffer[]
}

function accessorValues(access: GltfAccess, accessorIndex: number): number[][] {
  const accessor = record(array(access.json.accessors)[accessorIndex])
  if (!Object.keys(accessor).length || accessor.sparse !== undefined) {
    throw new Error('Sparse or missing glTF accessors are not yet editable.')
  }
  const viewIndex = Number(accessor.bufferView)
  const view = record(array(access.json.bufferViews)[viewIndex])
  if (!Number.isInteger(viewIndex) || !Object.keys(view).length) {
    throw new Error('glTF accessor has no buffer view.')
  }
  if (record(view.extensions).EXT_meshopt_compression) {
    throw new Error('Meshopt-compressed glTF geometry must be decompressed before editing.')
  }
  const componentType = Number(accessor.componentType)
  const component =
    componentType === 5120
      ? {
          bytes: 1,
          read: (data: DataView, offset: number) => data.getInt8(offset),
          signed: true,
          max: 127
        }
      : componentType === 5121
        ? {
            bytes: 1,
            read: (data: DataView, offset: number) => data.getUint8(offset),
            signed: false,
            max: 255
          }
        : componentType === 5122
          ? {
              bytes: 2,
              read: (data: DataView, offset: number) => data.getInt16(offset, true),
              signed: true,
              max: 32767
            }
          : componentType === 5123
            ? {
                bytes: 2,
                read: (data: DataView, offset: number) => data.getUint16(offset, true),
                signed: false,
                max: 65535
              }
            : componentType === 5125
              ? {
                  bytes: 4,
                  read: (data: DataView, offset: number) => data.getUint32(offset, true),
                  signed: false,
                  max: 4294967295
                }
              : componentType === 5126
                ? {
                    bytes: 4,
                    read: (data: DataView, offset: number) => data.getFloat32(offset, true),
                    signed: true,
                    max: 1
                  }
                : null
  const components =
    accessor.type === 'SCALAR'
      ? 1
      : accessor.type === 'VEC2'
        ? 2
        : accessor.type === 'VEC3'
          ? 3
          : accessor.type === 'VEC4'
            ? 4
            : accessor.type === 'MAT4'
              ? 16
              : 0
  const count = Number(accessor.count)
  const buffer = access.buffers[Number(view.buffer)]
  if (!component || !components || !Number.isInteger(count) || count < 0 || !buffer) {
    throw new Error('glTF accessor format is unsupported.')
  }
  const start = Number(view.byteOffset ?? 0) + Number(accessor.byteOffset ?? 0)
  const stride = Number(view.byteStride ?? component.bytes * components)
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(stride) ||
    stride < component.bytes * components
  ) {
    throw new Error('glTF accessor byte layout is invalid.')
  }
  const data = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const values: number[][] = []
  for (let index = 0; index < count; index += 1) {
    const row: number[] = []
    for (let cursor = 0; cursor < components; cursor += 1) {
      const offset = start + index * stride + cursor * component.bytes
      if (offset < 0 || offset + component.bytes > buffer.byteLength) {
        throw new Error('glTF accessor reads outside its declared buffer.')
      }
      let value = component.read(data, offset)
      if (accessor.normalized === true && componentType !== 5126) {
        value = component.signed ? Math.max(-1, value / component.max) : value / component.max
      }
      row.push(value)
    }
    values.push(row)
  }
  return values
}

function primitiveTriangles(indices: number[], mode: number): number[][] {
  if (mode === 4) {
    if (indices.length % 3) throw new Error('glTF triangle index count is invalid.')
    return Array.from({ length: indices.length / 3 }, (_, index) =>
      indices.slice(index * 3, index * 3 + 3)
    )
  }
  if (mode === 5) {
    return Array.from({ length: Math.max(0, indices.length - 2) }, (_, index) =>
      index % 2
        ? [indices[index + 1], indices[index], indices[index + 2]]
        : [indices[index], indices[index + 1], indices[index + 2]]
    )
  }
  if (mode === 6) {
    return Array.from({ length: Math.max(0, indices.length - 2) }, (_, index) => [
      indices[0],
      indices[index + 1],
      indices[index + 2]
    ])
  }
  throw new Error('Only glTF triangle, triangle-strip, and triangle-fan primitives are editable.')
}

function parseGltf(
  manifest: MeshAssetManifest,
  assets: MeshAssetStore,
  entryPath: string,
  contents: Buffer,
  uuid: () => string
): { vertices: RawVertex[]; faces: RawFace[]; bones: MeshTopologyBone[] } {
  const parsed =
    manifest.format === 'glb'
      ? parseGlb(contents)
      : { json: record(JSON.parse(contents.toString('utf8'))) }
  const json = parsed.json
  if (
    array(json.animations).length ||
    array(json.meshes).some((mesh) => array(record(mesh).weights).length)
  ) {
    throw new Error('Animated or morph-target glTF must be baked before topology conversion.')
  }
  const buffers = array(json.buffers).map((entry, index) => {
    const buffer = record(entry)
    if (index === 0 && !buffer.uri && parsed.binary) return parsed.binary
    if (typeof buffer.uri !== 'string') throw new Error('glTF buffer URI is missing.')
    return resolveVaultBuffer(manifest, assets, entryPath, buffer.uri)
  })
  const access = { json, buffers }
  const nodes = array(json.nodes).map(record)
  const nodeWorld = new Map<number, Matrix4>()
  const visit = (nodeIndex: number, parent: Matrix4, visiting: Set<number>): void => {
    if (visiting.has(nodeIndex)) throw new Error('glTF node graph contains a cycle.')
    const node = nodes[nodeIndex]
    if (!node) throw new Error('glTF scene references a missing node.')
    const world = multiplyMatrices(parent, nodeMatrix(node))
    nodeWorld.set(nodeIndex, world)
    const nextVisiting = new Set(visiting).add(nodeIndex)
    for (const child of array(node.children).map(Number)) visit(child, world, nextVisiting)
  }
  const scenes = array(json.scenes).map(record)
  const selectedScene = scenes[Number(json.scene ?? 0)] ?? scenes[0]
  const referencedChildren = new Set(nodes.flatMap((node) => array(node.children).map(Number)))
  const roots = selectedScene
    ? array(selectedScene.nodes).map(Number)
    : nodes.map((_, index) => index).filter((index) => !referencedChildren.has(index))
  for (const root of roots) visit(root, IDENTITY, new Set())

  const boneIdByNode = new Map<number, string>()
  const jointNodes = new Set<number>()
  for (const skinValue of array(json.skins)) {
    for (const joint of array(record(skinValue).joints).map(Number)) jointNodes.add(joint)
  }
  for (const joint of jointNodes) boneIdByNode.set(joint, elementId(uuid))
  const parentByNode = new Map<number, number>()
  nodes.forEach((node, parentIndex) => {
    for (const child of array(node.children).map(Number)) parentByNode.set(child, parentIndex)
  })
  const bones: MeshTopologyBone[] = [...jointNodes].map((joint) => {
    const node = nodes[joint] ?? {}
    const world = nodeWorld.get(joint) ?? nodeMatrix(node)
    const head = transformPoint(world, [0, 0, 0])
    const childJoint = array(node.children)
      .map(Number)
      .find((child) => jointNodes.has(child))
    const tail =
      childJoint !== undefined
        ? transformPoint(
            nodeWorld.get(childJoint) ?? nodeMatrix(nodes[childJoint] ?? {}),
            [0, 0, 0]
          )
        : transformPoint(world, [0, 0.2, 0])
    let parent = parentByNode.get(joint)
    while (parent !== undefined && !jointNodes.has(parent)) parent = parentByNode.get(parent)
    return {
      id: boneIdByNode.get(joint)!,
      name:
        typeof node.name === 'string' && node.name.trim()
          ? node.name.trim().slice(0, 200)
          : `Bone ${joint}`,
      ...(parent !== undefined && boneIdByNode.has(parent)
        ? { parentId: boneIdByNode.get(parent)! }
        : {}),
      head,
      tail
    }
  })

  const vertices: RawVertex[] = []
  const faces: RawFace[] = []
  for (const [nodeIndex, node] of nodes.entries()) {
    if (!nodeWorld.has(nodeIndex) || !Number.isInteger(Number(node.mesh))) continue
    const mesh = record(array(json.meshes)[Number(node.mesh)])
    for (const primitiveValue of array(mesh.primitives)) {
      const primitive = record(primitiveValue)
      if (record(primitive.extensions).KHR_draco_mesh_compression) {
        throw new Error('Draco-compressed glTF geometry must be decompressed before editing.')
      }
      if (array(primitive.targets).length) {
        throw new Error('glTF morph targets must be baked before topology conversion.')
      }
      const attributes = record(primitive.attributes)
      const positions = accessorValues(access, Number(attributes.POSITION))
      if (positions.some((entry) => entry.length < 3))
        throw new Error('glTF POSITION accessor is invalid.')
      const texcoords =
        attributes.TEXCOORD_0 !== undefined
          ? accessorValues(access, Number(attributes.TEXCOORD_0))
          : null
      const jointRows =
        attributes.JOINTS_0 !== undefined
          ? accessorValues(access, Number(attributes.JOINTS_0))
          : null
      const weightRows =
        attributes.WEIGHTS_0 !== undefined
          ? accessorValues(access, Number(attributes.WEIGHTS_0))
          : null
      const skin = Number.isInteger(Number(node.skin))
        ? record(array(json.skins)[Number(node.skin)])
        : null
      const joints = skin ? array(skin.joints).map(Number) : []
      const base = vertices.length
      for (let index = 0; index < positions.length; index += 1) {
        const rawWeights: MeshTopologyWeight[] = []
        if (jointRows?.[index] && weightRows?.[index]) {
          for (
            let cursor = 0;
            cursor < Math.min(4, jointRows[index].length, weightRows[index].length);
            cursor += 1
          ) {
            const jointNode = joints[Math.floor(jointRows[index][cursor])]
            const boneId = boneIdByNode.get(jointNode)
            const weight = weightRows[index][cursor]
            if (boneId && weight > 0) rawWeights.push({ boneId, weight })
          }
          const total = rawWeights.reduce((sum, entry) => sum + entry.weight, 0)
          if (total > 0) rawWeights.forEach((entry) => (entry.weight /= total))
        }
        vertices.push({
          position: transformPoint(nodeWorld.get(nodeIndex)!, positions[index]),
          ...(rawWeights.length ? { weights: rawWeights } : {})
        })
      }
      const sourceIndices =
        primitive.indices !== undefined
          ? accessorValues(access, Number(primitive.indices)).map((entry) => Math.floor(entry[0]))
          : positions.map((_, index) => index)
      for (const triangle of primitiveTriangles(sourceIndices, Number(primitive.mode ?? 4))) {
        if (triangle.some((index) => index < 0 || index >= positions.length)) {
          throw new Error('glTF primitive index is outside its POSITION accessor.')
        }
        faces.push({
          indices: triangle.map((index) => base + index),
          ...(texcoords
            ? {
                uvs: triangle.map((index) => ({
                  u: Number(texcoords[index]?.[0] ?? 0),
                  v: Number(texcoords[index]?.[1] ?? 0)
                }))
              }
            : {}),
          ...(primitive.material !== undefined
            ? { materialIndex: Math.max(0, Math.floor(Number(primitive.material))) }
            : {}),
          smooth: true
        })
      }
    }
  }
  if (!vertices.length || !faces.length) throw new Error('glTF contains no editable triangle mesh.')
  return { vertices, faces, bones }
}

export function meshTopologyFromImportedNode(input: {
  topologyId: string
  node: MeshImportedNode
  assets: MeshAssetStore
  uuid: () => string
  now: () => string
}): MeshTopologyDocument {
  const manifest = input.assets.get(input.node.assetId)
  if (!manifest || manifest.kind !== 'model' || manifest.format !== input.node.format) {
    throw new Error('The imported model asset is no longer available.')
  }
  const entry = input.assets.resolveAssetFile({
    assetId: manifest.id,
    accessToken: manifest.accessToken,
    relativePath: input.node.entryPath
  })
  if (!entry) throw new Error('The imported model entry is no longer available.')
  const contents = fs.readFileSync(entry.filePath)
  const geometry =
    input.node.format === 'obj'
      ? parseObj(contents.toString('utf8'))
      : parseGltf(manifest, input.assets, input.node.entryPath, contents, input.uuid)
  return buildTopology({
    topologyId: input.topologyId,
    name: input.node.name,
    source: {
      kind: 'import',
      assetId: input.node.assetId,
      format: input.node.format,
      entryPath: input.node.entryPath
    },
    ...geometry,
    uuid: input.uuid,
    now: input.now
  })
}

export const meshTopologyGeometryInternals = { parseObj, parseGltf }
