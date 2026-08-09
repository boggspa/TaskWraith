import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { MESH_SCENE_LEGACY_SCHEMA_VERSION, MESH_SCENE_SCHEMA_VERSION } from '../../shared/meshScene'
import { MeshSceneStore } from './MeshSceneStore'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('MeshSceneStore schema migration', () => {
  it('keeps legacy v1 scenes visible and lazily rewrites them as revisioned v2 records', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-mesh-scenes-'))
    temporaryDirectories.push(directory)
    fs.writeFileSync(
      path.join(directory, 'mesh-scenes.json'),
      JSON.stringify([
        {
          schemaVersion: MESH_SCENE_LEGACY_SCHEMA_VERSION,
          id: 'legacy-scene',
          chatId: 'chat-a',
          title: 'Legacy scene',
          backgroundColor: '#171a21',
          lighting: { environment: 'studio', intensity: 1 },
          camera: {
            position: { x: 4, y: 3, z: 5 },
            target: { x: 0, y: 0, z: 0 },
            fieldOfView: 45
          },
          nodes: [],
          dependencies: { sources: [], bindings: [] },
          createdAt: '2026-07-27T00:00:00.000Z',
          updatedAt: '2026-07-27T00:00:00.000Z'
        }
      ])
    )
    const store = new MeshSceneStore(directory)
    const migrated = store.get('legacy-scene')

    expect(migrated).toMatchObject({
      schemaVersion: MESH_SCENE_SCHEMA_VERSION,
      revision: 0,
      id: 'legacy-scene'
    })
    store.upsert({ ...migrated!, revision: 1 })
    const persisted = JSON.parse(fs.readFileSync(path.join(directory, 'mesh-scenes.json'), 'utf8'))
    expect(persisted[0]).toMatchObject({ schemaVersion: MESH_SCENE_SCHEMA_VERSION, revision: 1 })
  })
})
