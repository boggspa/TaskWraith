import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { MeshAssetStore } from '../mesh/MeshAssetStore'
import { MeshSceneService, type MeshSceneEvent } from '../mesh/MeshSceneService'
import { MeshSceneStore } from '../mesh/MeshSceneStore'
import { createMeshToolExecutors } from './MeshToolExecutors'

describe('MeshToolExecutors', () => {
  let root: string
  let workspace: string
  let events: MeshSceneEvent[]
  let sequence: number
  let executors: ReturnType<typeof createMeshToolExecutors>

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-mesh-mcp-'))
    workspace = path.join(root, 'workspace')
    fs.mkdirSync(workspace)
    events = []
    sequence = 0
    const service = new MeshSceneService({
      store: new MeshSceneStore(path.join(root, 'scenes')),
      assets: new MeshAssetStore(path.join(root, 'assets')),
      uuid: () => `scene-node-${++sequence}`,
      now: () => '2026-07-27T12:00:00.000Z',
      broadcast: (event) => events.push(event)
    })
    executors = createMeshToolExecutors(service)
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  const context = (chatId = 'chat-a') => ({
    appChatId: chatId,
    appRunId: 'run-a',
    workspacePath: workspace
  })

  async function execute(name: Parameters<typeof executors.executeMeshTool>[0], args: unknown) {
    return executors.executeMeshTool(name, args, context(), 'codex')
  }

  it('creates, edits, inspects, and presents a chat-owned declarative scene', async () => {
    const created = await execute('mesh_scene_create', { title: 'Product study' })
    expect(created.isError).not.toBe(true)
    const createValue = created.structuredContent as { scene: { id: string } }
    const sceneId = createValue.scene.id

    const applied = await execute('mesh_scene_apply', {
      sceneId,
      operation: 'add_primitive',
      primitive: 'torus',
      material: { baseColor: '#bb8844', metallic: 0.5, roughness: 0.2 }
    })
    expect(applied.structuredContent).toMatchObject({
      ok: true,
      scene: { nodes: [{ kind: 'primitive', primitive: 'torus' }] }
    })

    const listed = await execute('mesh_scene_list', {})
    expect(listed.structuredContent).toMatchObject({
      ok: true,
      scenes: [{ sceneId, primitiveCount: 1 }]
    })

    const inspected = await execute('mesh_scene_inspect', { sceneId })
    expect(inspected.structuredContent).toMatchObject({
      ok: true,
      scene: { id: sceneId, title: 'Product study' }
    })

    const presented = await execute('mesh_scene_present', { sceneId, title: 'Review model' })
    expect(presented.structuredContent).toMatchObject({
      ok: true,
      scene: { presentation: { title: 'Review model', presenter: 'codex' } }
    })
    expect(events.map((event) => event.kind)).toEqual([
      'scene.created',
      'scene.updated',
      'scene.presented'
    ])

    const closed = await execute('mesh_scene_close', { sceneId })
    expect(
      (closed.structuredContent as { scene: { presentation?: unknown } }).scene.presentation
    ).toBeUndefined()

    const deleted = await execute('mesh_scene_delete', { sceneId })
    expect(deleted.structuredContent).toEqual({ ok: true, deletedSceneId: sceneId })
    expect((await execute('mesh_scene_list', {})).structuredContent).toEqual({
      ok: true,
      scenes: []
    })
  })

  it('imports workspace-local Wavefront bundles and keeps source paths out of results', async () => {
    const modelDirectory = path.join(workspace, 'models')
    fs.mkdirSync(modelDirectory)
    fs.writeFileSync(path.join(modelDirectory, 'texture.png'), Buffer.from([137, 80, 78, 71]))
    fs.writeFileSync(
      path.join(modelDirectory, 'material.mtl'),
      'newmtl Paint\nmap_Kd texture.png\n'
    )
    fs.writeFileSync(
      path.join(modelDirectory, 'fixture.obj'),
      'mtllib material.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'
    )
    const created = await execute('mesh_scene_create', {})
    const sceneId = (created.structuredContent as { scene: { id: string } }).scene.id

    const imported = await execute('mesh_scene_import', {
      sceneId,
      sourcePath: 'models/fixture.obj'
    })
    expect(imported.structuredContent).toMatchObject({
      ok: true,
      scene: { nodes: [{ kind: 'import', format: 'obj', entryPath: 'fixture.obj' }] }
    })
    expect(JSON.stringify(imported.structuredContent)).not.toContain(workspace)
  })

  it('attaches a workspace texture without exposing arbitrary vault asset addressing', async () => {
    const textureDirectory = path.join(workspace, 'textures')
    fs.mkdirSync(textureDirectory)
    fs.writeFileSync(path.join(textureDirectory, 'paint.png'), Buffer.from([137, 80, 78, 71]))
    const created = await execute('mesh_scene_create', {})
    const sceneId = (created.structuredContent as { scene: { id: string } }).scene.id
    const applied = await execute('mesh_scene_apply', {
      sceneId,
      operation: 'add_primitive',
      primitive: 'box'
    })
    const nodeId = (applied.structuredContent as { scene: { nodes: Array<{ id: string }> } }).scene
      .nodes[0].id

    const textured = await execute('mesh_scene_set_material', {
      sceneId,
      nodeId,
      material: {},
      texturePath: 'textures/paint.png'
    })
    expect(textured.structuredContent).toMatchObject({
      ok: true,
      scene: { nodes: [{ material: { textureAssetId: expect.any(String) } }] }
    })

    const rejected = await execute('mesh_scene_set_material', {
      sceneId,
      nodeId,
      material: { textureAssetId: 'cross-chat-asset-reference' }
    })
    expect(rejected).toMatchObject({ isError: true })
    expect(rejected.text).toContain('textureAssetId is internal')
  })

  it('accepts typed object data and dependency bindings through mesh_scene_apply', async () => {
    const created = await execute('mesh_scene_create', {})
    const sceneId = (created.structuredContent as { scene: { id: string } }).scene.id
    const node = await execute('mesh_scene_apply', {
      sceneId,
      operation: 'add_primitive',
      primitive: 'sphere'
    })
    const nodeId = (node.structuredContent as { scene: { nodes: Array<{ id: string }> } }).scene
      .nodes[0].id

    const data = await execute('mesh_scene_apply', {
      sceneId,
      operation: 'upsert_object_data',
      sourceId: 'measurement',
      values: { radius: 3 }
    })
    expect(data.isError).not.toBe(true)

    const bound = await execute('mesh_scene_apply', {
      sceneId,
      operation: 'bind_node_property',
      nodeId,
      property: 'transform.scale.x',
      source: { kind: 'object_data', sourceId: 'measurement', key: 'radius' },
      numericTransform: { scale: 0.5 }
    })
    expect(bound.structuredContent).toMatchObject({
      ok: true,
      scene: {
        nodes: [{ id: nodeId, transform: { scale: { x: 1.5 } } }],
        dependencies: { bindings: [{ targetNodeId: nodeId, targetProperty: 'transform.scale.x' }] }
      }
    })
  })

  it('refuses out-of-workspace imports and cross-chat scene access', async () => {
    const outside = path.join(root, 'outside.obj')
    fs.writeFileSync(outside, 'v 0 0 0\n')
    const created = await execute('mesh_scene_create', {})
    const sceneId = (created.structuredContent as { scene: { id: string } }).scene.id

    const outsideImport = await execute('mesh_scene_import', { sceneId, sourcePath: outside })
    expect(outsideImport).toMatchObject({ isError: true })
    expect(outsideImport.text).toContain('inside the active workspace')

    const crossChat = await executors.executeMeshTool(
      'mesh_scene_inspect',
      { sceneId },
      context('chat-b'),
      'codex'
    )
    expect(crossChat).toMatchObject({ isError: true })
    expect(crossChat.text).toContain('does not belong')
  })
})
