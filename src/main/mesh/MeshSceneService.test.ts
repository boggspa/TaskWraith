import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  MESH_SCENE_PACKAGE_KIND,
  MESH_SCENE_PACKAGE_MANIFEST_FILE
} from '../../shared/meshScenePackage'
import { MeshAssetStore } from './MeshAssetStore'
import { MeshSceneService, type MeshSceneEvent } from './MeshSceneService'
import { MeshSceneStore } from './MeshSceneStore'
import { MeshTopologyStore } from './MeshTopologyStore'
import { MeshTopologyRevisionConflictError } from './MeshTopologyMutations'

describe('MeshSceneService', () => {
  let root: string
  let workspace: string
  let assets: MeshAssetStore
  let service: MeshSceneService
  let topologies: MeshTopologyStore
  let events: MeshSceneEvent[]
  let sequence: number

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-mesh-'))
    workspace = path.join(root, 'workspace')
    fs.mkdirSync(workspace)
    events = []
    sequence = 0
    assets = new MeshAssetStore(path.join(root, 'assets'))
    topologies = new MeshTopologyStore(path.join(root, 'topologies'))
    service = new MeshSceneService({
      store: new MeshSceneStore(path.join(root, 'scenes')),
      assets,
      topologies,
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
    participantId: 'seat-a',
    workspacePath: workspace
  })

  it('creates workspace-recallable declarative scenes and applies primitives', () => {
    const scene = service.create(
      { title: 'Materials study', backgroundColor: '#102030' },
      context()
    )
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

  it('converts a primitive and applies collaborative topology edits with strict revision CAS', () => {
    const scene = service.create({ title: 'Collaborative topology' }, context())
    const composed = service.apply(
      scene.id,
      { operation: 'add_primitive', primitive: 'box', name: 'Editable box' },
      context()
    )
    const nodeId = composed.nodes[0].id
    const converted = service.makeEditable(scene.id, { nodeId }, context())
    const editable = converted.scene.nodes[0]
    expect(editable).toMatchObject({
      kind: 'editable',
      topologyRevision: 0,
      source: { kind: 'primitive', primitive: 'box' }
    })
    if (editable.kind !== 'editable') throw new Error('expected editable node')
    expect(
      service.viewForChat(scene.id, 'chat-a', workspace)?.topologies[editable.topologyId]
    ).toBeTruthy()

    const vertexId = converted.topology.vertices[0].id
    const first = service.editTopology(
      scene.id,
      {
        nodeId,
        edit: {
          expectedRevision: 0,
          clientMutationId: 'seat-a-move',
          operations: [{ operation: 'move_vertices', vertices: [{ vertexId, delta: { x: 0.2 } }] }]
        }
      },
      context()
    )
    expect(first.edit.summary.revision).toBe(1)
    expect(first.edit.document.recentMutations[0].editor).toMatchObject({
      provider: 'codex',
      runId: 'run-a',
      participantId: 'seat-a'
    })
    expect(service.inspectTopology(scene.id, { nodeId }, context('chat-b')).topology.revision).toBe(
      1
    )
    expect(service.list(context('chat-b'))).toEqual([
      expect.objectContaining({ sceneId: scene.id, editableCount: 1 })
    ])
    expect(() =>
      service.editTopology(
        scene.id,
        {
          nodeId,
          edit: {
            expectedRevision: 0,
            clientMutationId: 'seat-b-stale',
            operations: [
              { operation: 'move_vertices', vertices: [{ vertexId, delta: { y: 0.2 } }] }
            ]
          }
        },
        { ...context('chat-b'), participantId: 'seat-b' }
      )
    ).toThrow(MeshTopologyRevisionConflictError)
    const second = service.editTopology(
      scene.id,
      {
        nodeId,
        edit: {
          expectedRevision: 1,
          clientMutationId: 'seat-b-fresh',
          operations: [{ operation: 'move_vertices', vertices: [{ vertexId, delta: { y: 0.2 } }] }]
        }
      },
      { ...context('chat-b'), participantId: 'seat-b' }
    )
    expect(second.edit.summary.revision).toBe(2)
    expect(events.at(-1)).toMatchObject({ kind: 'scene.updated', chatId: 'chat-b' })

    service.remove(scene.id, context('chat-b'))
    expect(topologies.get(editable.topologyId)).toBeNull()
  })

  it('isolates workspace scenes from other workspaces and global scenes from other chats', () => {
    const otherWorkspace = path.join(root, 'other-workspace')
    fs.mkdirSync(otherWorkspace)
    const workspaceScene = service.create({ title: 'Workspace scene' }, context('chat-a'))

    expect(() =>
      service.inspect(workspaceScene.id, {
        ...context('chat-b'),
        workspacePath: otherWorkspace
      })
    ).toThrow('not available in this workspace')

    const globalContext = {
      chatId: 'global-a',
      runId: 'run-global',
      provider: 'codex',
      participantId: 'seat-global'
    }
    const globalScene = service.create({ title: 'Global scene' }, globalContext)
    expect(service.inspect(globalScene.id, globalContext).id).toBe(globalScene.id)
    expect(() => service.inspect(globalScene.id, { ...globalContext, chatId: 'global-b' })).toThrow(
      'does not belong to this chat'
    )
  })

  it('converts an imported OBJ without overwriting or losing its source asset', () => {
    const sourcePath = path.join(workspace, 'source.obj')
    const sourceText = ['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f 1 2 3'].join('\n')
    fs.writeFileSync(sourcePath, sourceText)
    const scene = service.create({ title: 'Imported rewrite' }, context())
    const imported = service.importModel(scene.id, { sourcePath }, context())
    const nodeId = imported.nodes[0].id
    const converted = service.makeEditable(scene.id, { nodeId }, context())
    expect(converted.scene.nodes[0]).toMatchObject({
      kind: 'editable',
      source: { kind: 'import', format: 'obj', entryPath: 'source.obj' }
    })
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(sourceText)
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
    const view = service.viewForChat(scene.id, 'chat-a', workspace)
    expect(view?.assetUrls[node.assetId]).toMatch(/^twmesh:\/\/asset\//)
    expect(JSON.stringify(view)).not.toContain(workspace)
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

  it('refuses imports outside the active workspace and cross-workspace scene access', () => {
    const external = path.join(root, 'external.obj')
    const otherWorkspace = path.join(root, 'other-workspace-import')
    fs.writeFileSync(external, 'v 0 0 0\n')
    fs.mkdirSync(otherWorkspace)
    const scene = service.create({}, context())
    expect(() => service.importModel(scene.id, { sourcePath: external }, context())).toThrow(
      /inside the active workspace/
    )
    expect(() =>
      service.inspect(scene.id, { ...context('chat-b'), workspacePath: otherWorkspace })
    ).toThrow(/not available in this workspace/)
  })

  it('imports a human-selected external model as a workspace-recallable scene agents can edit', () => {
    const downloads = path.join(root, 'Downloads')
    fs.mkdirSync(downloads)
    const selected = path.join(downloads, 'manual-fixture.obj')
    fs.writeFileSync(selected, 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n')

    const scene = service.importUserSelectedModel({ sourcePath: selected }, context())
    const node = scene.nodes[0]
    if (!node || node.kind !== 'import') throw new Error('expected imported node')

    expect(scene).toMatchObject({
      chatId: 'chat-a',
      title: 'manual-fixture',
      nodes: [{ kind: 'import', name: 'manual-fixture.obj', entryPath: 'manual-fixture.obj' }]
    })
    expect(JSON.stringify(scene)).not.toContain(selected)
    expect(service.list(context())).toEqual([
      expect.objectContaining({ sceneId: scene.id, importCount: 1, nodeCount: 1 })
    ])

    const edited = service.apply(
      scene.id,
      { operation: 'update_node', nodeId: node.id, name: 'Edited by agent' },
      context()
    )
    expect(edited.nodes[0]).toMatchObject({ name: 'Edited by agent' })
    expect(assets.get(node.assetId)).not.toBeNull()
    expect(events.map((event) => event.kind)).toEqual(['scene.created', 'scene.updated'])
  })

  it('imports a selected multi-root scene package as one workspace-recallable vault bundle', () => {
    const exports = path.join(root, 'Downloads', 'gallery-export')
    fs.mkdirSync(path.join(exports, 'models'), { recursive: true })
    fs.writeFileSync(
      path.join(exports, 'models', 'gallery.glb'),
      Buffer.from([0x67, 0x6c, 0x54, 0x46])
    )
    fs.writeFileSync(
      path.join(exports, 'models', 'sign.obj'),
      'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'
    )
    const manifestPath = path.join(exports, MESH_SCENE_PACKAGE_MANIFEST_FILE)
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        kind: MESH_SCENE_PACKAGE_KIND,
        title: 'Gallery export',
        roots: [
          { path: 'models/gallery.glb', name: 'Gallery' },
          { path: 'models/sign.obj', name: 'Sign' }
        ],
        files: ['models/gallery.glb', 'models/sign.obj']
      })
    )

    const scene = service.importUserSelectedScenePackage({ manifestPath }, context())
    const imports = scene.nodes.filter(
      (node): node is Extract<typeof node, { kind: 'import' }> => node.kind === 'import'
    )
    expect(scene).toMatchObject({
      chatId: 'chat-a',
      title: 'Gallery export',
      nodes: [
        { kind: 'import', name: 'Gallery', entryPath: 'models/gallery.glb', format: 'glb' },
        { kind: 'import', name: 'Sign', entryPath: 'models/sign.obj', format: 'obj' }
      ]
    })
    expect(new Set(imports.map((node) => node.assetId)).size).toBe(1)
    expect(JSON.stringify(scene)).not.toContain(exports)

    const view = service.viewForChat(scene.id, 'chat-a', workspace)
    expect(view?.modelUrls[imports[0]!.id]).toMatch(/models\/gallery\.glb$/)
    expect(view?.modelUrls[imports[1]!.id]).toMatch(/models\/sign\.obj$/)
    const bundle = assets.get(imports[0]!.assetId)
    expect(bundle?.files).toEqual(['models/gallery.glb', 'models/sign.obj'])
    expect(events.map((event) => event.kind)).toEqual(['scene.created'])
  })

  it('reactively resolves object facts and chained node-property dependencies in one scene update', () => {
    const scene = service.create({ title: 'Reactive layout' }, context())
    const withLeader = service.apply(
      scene.id,
      { operation: 'add_primitive', primitive: 'box', name: 'Leader' },
      context()
    )
    const leader = withLeader.nodes[0]
    const withFollower = service.apply(
      scene.id,
      { operation: 'add_primitive', primitive: 'sphere', name: 'Follower' },
      context()
    )
    const follower = withFollower.nodes[1]
    if (!leader || !follower) throw new Error('expected two primitive nodes')

    service.apply(
      scene.id,
      { operation: 'upsert_object_data', sourceId: 'telemetry', values: { span: 2 } },
      context()
    )
    const boundLeader = service.apply(
      scene.id,
      {
        operation: 'bind_node_property',
        nodeId: leader.id,
        property: 'transform.position.x',
        source: { kind: 'object_data', sourceId: 'telemetry', key: 'span' },
        numericTransform: { scale: 2, offset: 1 }
      },
      context()
    )
    expect(boundLeader.nodes.find((node) => node.id === leader.id)?.transform.position.x).toBe(5)

    const chained = service.apply(
      scene.id,
      {
        operation: 'bind_node_property',
        nodeId: follower.id,
        property: 'transform.position.x',
        source: { kind: 'node_property', nodeId: leader.id, property: 'transform.position.x' }
      },
      context()
    )
    expect(chained.nodes.find((node) => node.id === follower.id)?.transform.position.x).toBe(5)

    const updated = service.apply(
      scene.id,
      { operation: 'upsert_object_data', sourceId: 'telemetry', values: { span: 4 } },
      context()
    )
    expect(updated.nodes.find((node) => node.id === leader.id)?.transform.position.x).toBe(9)
    expect(updated.nodes.find((node) => node.id === follower.id)?.transform.position.x).toBe(9)
    service.apply(
      scene.id,
      {
        operation: 'unbind_node_property',
        nodeId: leader.id,
        property: 'transform.position.x'
      },
      context()
    )
    const directToolUpdate = service.apply(
      scene.id,
      {
        operation: 'update_node',
        nodeId: leader.id,
        transform: { position: { x: 12 } }
      },
      context()
    )
    expect(
      directToolUpdate.nodes.find((node) => node.id === follower.id)?.transform.position.x
    ).toBe(12)
    expect(updated.dependencies).toMatchObject({
      sources: [{ id: 'telemetry', values: { span: 4 } }],
      bindings: [{ targetNodeId: leader.id }, { targetNodeId: follower.id }]
    })
    // The renderer gets only already-resolved scene nodes, not raw object facts.
    expect(service.viewForChat(scene.id, 'chat-a', workspace)).not.toHaveProperty('dependencies')
    expect(events.at(-1)).toMatchObject({ kind: 'scene.updated', sceneId: scene.id })
  })

  it('rejects cyclic property edges atomically', () => {
    const scene = service.create({}, context())
    const withFirst = service.apply(
      scene.id,
      { operation: 'add_primitive', primitive: 'box' },
      context()
    )
    const first = withFirst.nodes[0]
    const withSecond = service.apply(
      scene.id,
      { operation: 'add_primitive', primitive: 'sphere' },
      context()
    )
    const second = withSecond.nodes[1]
    if (!first || !second) throw new Error('expected two primitive nodes')

    service.apply(
      scene.id,
      {
        operation: 'bind_node_property',
        nodeId: second.id,
        property: 'transform.position.x',
        source: { kind: 'node_property', nodeId: first.id, property: 'transform.position.x' }
      },
      context()
    )

    expect(() =>
      service.apply(
        scene.id,
        {
          operation: 'bind_node_property',
          nodeId: first.id,
          property: 'transform.position.x',
          source: { kind: 'node_property', nodeId: second.id, property: 'transform.position.x' }
        },
        context()
      )
    ).toThrow(/contains a cycle/)
    expect(service.inspect(scene.id, context()).dependencies.bindings).toHaveLength(1)
  })

  it('preserves workspace scenes across chat clears and purges them with workspace history', async () => {
    const source = path.join(workspace, 'fixture.glb')
    fs.writeFileSync(source, Buffer.from('glTF'))
    const scene = service.create({}, context())
    const imported = service.importModel(scene.id, { sourcePath: source }, context())
    const node = imported.nodes[0]
    if (!node || node.kind !== 'import') throw new Error('expected imported node')

    await service.beginAuthorityHistoryClear({ chatIds: ['chat-a'] })
    service.endAuthorityHistoryClear({ chatIds: ['chat-a'] })

    expect(service.list(context('chat-b'))).toEqual([
      expect.objectContaining({ sceneId: scene.id, importCount: 1 })
    ])
    expect(assets.get(node.assetId)).not.toBeNull()

    await service.beginAuthorityHistoryClear({ workspacePaths: [workspace] })
    service.endAuthorityHistoryClear({ workspacePaths: [workspace] })

    expect(service.list(context())).toEqual([])
    expect(assets.get(node.assetId)).toBeNull()
  })

  it('deletes a scene and releases only assets no remaining scene references', () => {
    const source = path.join(workspace, 'fixture.glb')
    fs.writeFileSync(source, Buffer.from('glTF'))
    const scene = service.create({}, context())
    const imported = service.importModel(scene.id, { sourcePath: source }, context())
    const node = imported.nodes[0]
    if (!node || node.kind !== 'import') throw new Error('expected imported node')

    expect(service.remove(scene.id, context())).toBe(scene.id)
    expect(service.list(context())).toEqual([])
    expect(assets.get(node.assetId)).toBeNull()
    expect(events.at(-1)).toMatchObject({ kind: 'scene.deleted', sceneId: scene.id })
  })
})
