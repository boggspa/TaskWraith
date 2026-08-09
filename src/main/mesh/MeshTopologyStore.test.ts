import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { meshTopologyFromPrimitive } from './MeshTopologyGeometry'
import { MeshTopologyStore, normalizeMeshTopologyDocument } from './MeshTopologyStore'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-topology-store-'))
  temporaryDirectories.push(directory)
  return directory
}

function ids(): () => string {
  let next = 0
  return () => `topology-element-${++next}`
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('MeshTopologyStore', () => {
  it('atomically round-trips an isolated editable document and returns detached clones', () => {
    const directory = temporaryDirectory()
    const store = new MeshTopologyStore(directory)
    const document = meshTopologyFromPrimitive({
      topologyId: 'topology-box',
      primitive: 'box',
      name: 'Box',
      uuid: ids(),
      now: () => '2026-08-09T00:00:00.000Z'
    })

    store.upsert(document)
    const loaded = store.get(document.id)!
    loaded.vertices[0].position.x = 99
    expect(store.get(document.id)?.vertices[0].position.x).toBe(-0.8)
    expect(fs.readdirSync(directory)).toEqual(['topology-box.json'])

    store.remove([document.id])
    expect(store.get(document.id)).toBeNull()
  })

  it('rejects a face loop whose stable edge does not connect its consecutive vertices', () => {
    const document = meshTopologyFromPrimitive({
      topologyId: 'topology-box',
      primitive: 'box',
      name: 'Box',
      uuid: ids(),
      now: () => '2026-08-09T00:00:00.000Z'
    })
    document.faces[0].loops[0].edgeId = document.faces[1].loops[0].edgeId

    expect(normalizeMeshTopologyDocument(document)).toBeNull()
  })
})
