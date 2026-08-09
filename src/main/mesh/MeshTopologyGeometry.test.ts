import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { meshTopologySummary } from '../../shared/meshTopology'
import type { MeshImportedNode } from '../../shared/meshScene'
import { MeshAssetStore } from './MeshAssetStore'
import { meshTopologyFromImportedNode, meshTopologyFromPrimitive } from './MeshTopologyGeometry'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-topology-'))
  temporaryDirectories.push(directory)
  return directory
}

function ids(prefix = 'element'): () => string {
  let next = 0
  return () => `${prefix}-${++next}`
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('meshTopologyFromPrimitive', () => {
  it('materializes the renderer-only box as stable editable vertices, edges, faces, and UV loops', () => {
    const document = meshTopologyFromPrimitive({
      topologyId: 'topology-box',
      primitive: 'box',
      name: 'Editable box',
      uuid: ids(),
      now: () => '2026-08-09T00:00:00.000Z'
    })

    expect(meshTopologySummary(document)).toMatchObject({
      topologyId: 'topology-box',
      revision: 0,
      vertexCount: 8,
      edgeCount: 12,
      faceCount: 6,
      triangleCount: 12,
      uvLoopCount: 24
    })
    expect(
      new Set(document.faces.flatMap((face) => face.loops.map((loop) => loop.edgeId))).size
    ).toBe(12)
  })

  it.each(['plane', 'sphere', 'cylinder', 'torus'] as const)(
    'materializes %s with a closed, non-empty topology',
    (primitive) => {
      const document = meshTopologyFromPrimitive({
        topologyId: `topology-${primitive}`,
        primitive,
        name: primitive,
        uuid: ids(primitive),
        now: () => '2026-08-09T00:00:00.000Z'
      })
      expect(document.vertices.length).toBeGreaterThan(3)
      expect(document.edges.length).toBeGreaterThan(3)
      expect(document.faces.length).toBeGreaterThan(0)
    }
  )
})

describe('meshTopologyFromImportedNode', () => {
  function importedNode(
    assetId: string,
    format: 'obj' | 'gltf',
    entryPath: string
  ): MeshImportedNode {
    return {
      id: 'node-imported',
      kind: 'import',
      name: 'Imported',
      assetId,
      format,
      entryPath,
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 }
      },
      visible: true
    }
  }

  it('keeps OBJ UVs per loop so one shared vertex can cross a seam', () => {
    const root = temporaryDirectory()
    const source = path.join(root, 'seam.obj')
    fs.writeFileSync(
      source,
      [
        'v 0 0 0',
        'v 1 0 0',
        'v 1 1 0',
        'v 0 1 0',
        'vt 0 0',
        'vt 1 0',
        'vt 1 1',
        'vt 0 1',
        'f 1/1 2/2 3/3',
        'f 1/4 3/3 4/1'
      ].join('\n')
    )
    const assets = new MeshAssetStore(path.join(root, 'assets'), {
      uuid: ids('asset-identifier')
    })
    const manifest = assets.importModel(source).manifest
    const document = meshTopologyFromImportedNode({
      topologyId: 'topology-obj',
      node: importedNode(manifest.id, 'obj', manifest.entryPath),
      assets,
      uuid: ids(),
      now: () => '2026-08-09T00:00:00.000Z'
    })

    const firstVertex = document.vertices[0].id
    const seamUvs = document.faces
      .flatMap((face) => face.loops)
      .filter((loop) => loop.vertexId === firstVertex)
      .map((loop) => loop.uv)
    expect(seamUvs).toEqual([
      { u: 0, v: 0 },
      { u: 0, v: 1 }
    ])
  })

  it('decodes external-buffer glTF triangles from the private asset bundle', () => {
    const root = temporaryDirectory()
    const binary = Buffer.alloc(42)
    const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0]
    positions.forEach((value, index) => binary.writeFloatLE(value, index * 4))
    binary.writeUInt16LE(0, 36)
    binary.writeUInt16LE(1, 38)
    binary.writeUInt16LE(2, 40)
    fs.writeFileSync(path.join(root, 'triangle.bin'), binary)
    fs.writeFileSync(
      path.join(root, 'triangle.gltf'),
      JSON.stringify({
        asset: { version: '2.0' },
        buffers: [{ uri: 'triangle.bin', byteLength: binary.length }],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: 36 },
          { buffer: 0, byteOffset: 36, byteLength: 6 }
        ],
        accessors: [
          { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
          { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }
        ],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
        nodes: [{ mesh: 0, translation: [2, 3, 4] }],
        scenes: [{ nodes: [0] }],
        scene: 0
      })
    )
    const assets = new MeshAssetStore(path.join(root, 'assets'), {
      uuid: ids('asset-identifier')
    })
    const manifest = assets.importModel(path.join(root, 'triangle.gltf')).manifest
    const document = meshTopologyFromImportedNode({
      topologyId: 'topology-gltf',
      node: importedNode(manifest.id, 'gltf', manifest.entryPath),
      assets,
      uuid: ids(),
      now: () => '2026-08-09T00:00:00.000Z'
    })

    expect(document.vertices.map((vertex) => vertex.position)).toEqual([
      { x: 2, y: 3, z: 4 },
      { x: 3, y: 3, z: 4 },
      { x: 2, y: 4, z: 4 }
    ])
    expect(document.faces).toHaveLength(1)
  })
})
