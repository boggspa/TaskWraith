import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { MeshAssetStore } from './MeshAssetStore'
import { MeshSceneService, type MeshSceneEvent } from './MeshSceneService'
import { MeshSceneStore } from './MeshSceneStore'

describe('MeshSceneService', () => {
  let root: string
  let workspace: string
  let assets: MeshAssetStore
  let service: MeshSceneService
  let events: MeshSceneEvent[]
  let sequence: number

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-mesh-'))
    workspace = path.join(root, 'workspace')
    fs.mkdirSync(workspace)
    events = []
    sequence = 0
    assets = new MeshAssetStore(path.join(root, 'assets'))
    service = new MeshSceneService({
      store: new MeshSceneStore(path.join(root, 'scenes')),
      assets,
      uuid: () => `mesh-node-${++sequence}`,
      now: () => '2026-07-27T12:00:00.000Z',
      broadcast: (event) => events.push(event)
    })
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  const context = (chatId = 'chat-a') => ({
    chatId,
    runId: 'run-a',
    provider: 'codex',
    workspacePath: workspace
  })

  it('creates chat-owned declarative scenes and applies primitives', () => {
    const scene = service.create({ title: 'Materials study', backgroundColor: '#102030' }, context())
    const updated = service.apply(
      scene.id,
      {
        operation: 'add_primitive',
        primitive: 'torus',
        name: 'Hero torus',
        material: { baseColor: '#cc8844', metallic: 0.65, roughness: 0.18 }
      },
      context()
    )

    expect(updated.nodes).toHaveLength(1)
    expect(updated.nodes[0]).toMatchObject({
      kind: 'primitive',
      primitive: 'torus',
      name: 'Hero torus',
      material: { baseColor: '#cc8844', metallic: 0.65, roughness: 0.18 }
    })
    expect(service.list(context())).toEqual([
      expect.objectContaining({ sceneId: scene.id, nodeCount: 1, primitiveCount: 1 })
    ])
    expect(events.map((event) => event.kind)).toEqual(['scene.created', 'scene.updated'])
  })

  it('imports OBJ/MTL/texture bundles without retaining a source path in the scene', () => {
    const sourceDir = path.join(workspace, 'models')
    fs.mkdirSync(sourceDir)
    fs.writeFileSync(path.join(sourceDir, 'texture.png'), Buffer.from([137, 80, 78, 71]))
    fs.writeFileSync(path.join(sourceDir, 'material.mtl'), 'newmtl Paint\nmap_Kd texture.png\n')
    fs.writeFileSync(
      path.join(sourceDir, 'fixture.obj'),
      'mtllib material.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'
    )
    const scene = service.create({}, context())
    const imported = service.importModel(
      scene.id,
      { sourcePath: path.join(sourceDir, 'fixture.obj') },
      context()
    )
    const node = imported.nodes[0]
    expect(node).toMatchObject({ kind: 'import', entryPath: 'fixture.obj', format: 'obj' })
    if (!node || node.kind !== 'import') throw new Error('expected imported node')

    const manifest = assets.get(node.assetId)
    expect(manifest?.files).toEqual(['fixture.obj', 'material.mtl', 'texture.png'])
    expect(JSON.stringify(imported)).not.toContain(sourceDir)
    const view = service.viewForChat(scene.id, 'chat-a')
    expect(view?.assetUrls[node.assetId]).toMatch(/^twmesh:\/\/asset\//)
    // The tool-facing inspection record has no vault token; only the renderer
    // projection carries the opaque local URL needed by Three's loader.
    expect(JSON.stringify(service.inspect(scene.id, context()))).not.toContain(
      manifest?.accessToken ?? ''
    )

    const resolved = assets.resolveAssetFile({
      assetId: node.assetId,
      accessToken: manifest!.accessToken,
      relativePath: 'texture.png'
    })
    expect(resolved?.mimeType).toBe('image/png')
  })

  it('refuses imports outside the active workspace and cross-chat scene access', () => {
    const external = path.join(root, 'external.obj')
    fs.writeFileSync(external, 'v 0 0 0\n')
    const scene = service.create({}, context())
    expect(() => service.importModel(scene.id, { sourcePath: external }, context())).toThrow(
      /inside the active workspace/
    )
    expect(() => service.inspect(scene.id, context('chat-b'))).toThrow(/does not belong/)
  })

  it('purges scoped scene metadata and its private assets under the matching history authority', async () => {
    const source = path.join(workspace, 'fixture.glb')
    fs.writeFileSync(source, Buffer.from('glTF'))
    const scene = service.create({}, context())
    const imported = service.importModel(scene.id, { sourcePath: source }, context())
    const node = imported.nodes[0]
    if (!node || node.kind !== 'import') throw new Error('expected imported node')

    await service.beginAuthorityHistoryClear({ chatIds: ['chat-a'] })
    service.endAuthorityHistoryClear({ chatIds: ['chat-a'] })

    expect(service.list(context())).toEqual([])
    expect(assets.get(node.assetId)).toBeNull()
  })
})
