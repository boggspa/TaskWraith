/**
 * Trusted main-process coordinator for Mesh Canvas scenes.
 *
 * It owns chat attribution, source-workspace containment, durable scene edits,
 * private asset imports, history purges, and renderer event broadcasts. The
 * renderer only receives a declarative scene plus tokenized local asset URLs.
 */
import * as fs from 'fs'
import * as path from 'path'
import {
  MESH_SCENE_SCHEMA_VERSION,
  MESH_MAX_SCENE_NODES,
  cloneDefaultCamera,
  cloneDefaultLighting,
  cloneDefaultTransform,
  createEmptyMeshSceneDependencyGraph,
  isMeshPrimitiveKind,
  meshAssetUrl,
  meshSceneSummary,
  type MeshPbrMaterial,
  type MeshPrimitiveKind,
  type MeshSceneCamera,
  type MeshSceneLighting,
  type MeshSceneDependencyProperty,
  type MeshSceneDependencySource,
  type MeshSceneNode,
  type MeshSceneObjectDataValue,
  type MeshSceneRecord,
  type MeshSceneSummary,
  type MeshSceneView,
  type MeshTransform
} from '../../shared/meshScene'
import {
  meshTopologySummary,
  type MeshTopologyDocument,
  type MeshTopologyEditResult
} from '../../shared/meshTopology'
import type { MeshAssetStore } from './MeshAssetStore'
import { meshTopologyFromImportedNode, meshTopologyFromPrimitive } from './MeshTopologyGeometry'
import { applyMeshTopologyEdit, type MeshTopologyEditInput } from './MeshTopologyMutations'
import type { MeshTopologyStore } from './MeshTopologyStore'
import {
  bindMeshSceneNodeProperty,
  cloneMeshSceneDependencyGraph,
  removeMeshSceneNodeDependencies,
  resolveMeshSceneDependencyGraph,
  unbindMeshSceneNodeProperty,
  upsertMeshSceneObjectData
} from './MeshSceneDependencyGraph'
import type { MeshSceneStore } from './MeshSceneStore'

export interface MeshSceneCallContext {
  provider?: string
  chatId?: string
  runId?: string
  workspacePath?: string
  participantId?: string
}

export interface MeshHistoryAuthority {
  chatIds?: Iterable<string>
  workspacePaths?: Iterable<string>
}

export interface MeshSceneEvent {
  schemaVersion: 1
  kind: 'scene.created' | 'scene.updated' | 'scene.presented' | 'scene.closed' | 'scene.deleted'
  sceneId: string
  chatId?: string
  summary: MeshSceneSummary
  createdAt: string
}

export interface MeshTransformInput {
  position?: Partial<MeshTransform['position']>
  rotation?: Partial<MeshTransform['rotation']>
  scale?: Partial<MeshTransform['scale']>
}

export interface MeshSceneCameraInput {
  position?: Partial<MeshSceneCamera['position']>
  target?: Partial<MeshSceneCamera['target']>
  fieldOfView?: number
}

export type MeshSceneMutation =
  | {
      operation: 'add_primitive'
      primitive: MeshPrimitiveKind
      name?: string
      transform?: MeshTransformInput
      material?: MeshPbrMaterial
    }
  | {
      operation: 'update_node'
      nodeId: string
      name?: string
      transform?: MeshTransformInput
      material?: MeshPbrMaterial
      visible?: boolean
    }
  | { operation: 'remove_node'; nodeId: string }
  | {
      operation: 'set_scene'
      title?: string
      backgroundColor?: string
      lighting?: Partial<MeshSceneLighting>
      camera?: MeshSceneCameraInput
    }
  | {
      operation: 'upsert_object_data'
      sourceId: string
      values: Record<string, MeshSceneObjectDataValue>
    }
  | {
      operation: 'bind_node_property'
      nodeId: string
      property: MeshSceneDependencyProperty
      source: MeshSceneDependencySource
      numericTransform?: { scale?: number; offset?: number }
    }
  | {
      operation: 'unbind_node_property'
      nodeId: string
      property: MeshSceneDependencyProperty
    }

export interface MeshSceneServiceDeps {
  store: MeshSceneStore
  assets: MeshAssetStore
  topologies: MeshTopologyStore
  uuid: () => string
  now: () => string
  broadcast?: (event: MeshSceneEvent) => void
}

function nonEmpty(value: unknown, limit = 200): string | null {
  if (typeof value !== 'string') return null
  const result = value.trim()
  return result && result.length <= limit ? result : null
}

function safeHexColor(value: unknown): string | null {
  const color = nonEmpty(value, 16)
  return color && (/^#[0-9a-f]{6}$/i.test(color) || /^#[0-9a-f]{3}$/i.test(color)) ? color : null
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback
}

function mergeTransform(current: MeshTransform, next?: MeshTransformInput): MeshTransform {
  const position: Partial<MeshTransform['position']> = next?.position ?? {}
  const rotation: Partial<MeshTransform['rotation']> = next?.rotation ?? {}
  const scale: Partial<MeshTransform['scale']> = next?.scale ?? {}
  return {
    position: {
      x: boundedNumber(position.x, current.position.x, -100_000, 100_000),
      y: boundedNumber(position.y, current.position.y, -100_000, 100_000),
      z: boundedNumber(position.z, current.position.z, -100_000, 100_000)
    },
    rotation: {
      x: boundedNumber(rotation.x, current.rotation.x, -100_000, 100_000),
      y: boundedNumber(rotation.y, current.rotation.y, -100_000, 100_000),
      z: boundedNumber(rotation.z, current.rotation.z, -100_000, 100_000)
    },
    scale: {
      x: boundedNumber(scale.x, current.scale.x, 0.001, 10_000),
      y: boundedNumber(scale.y, current.scale.y, 0.001, 10_000),
      z: boundedNumber(scale.z, current.scale.z, 0.001, 10_000)
    }
  }
}

function mergeMaterial(
  current: MeshPbrMaterial | undefined,
  next?: MeshPbrMaterial
): MeshPbrMaterial {
  const base = current ?? {}
  if (!next) return { ...base }
  return {
    ...base,
    ...(safeHexColor(next.baseColor) ? { baseColor: safeHexColor(next.baseColor)! } : {}),
    ...(typeof next.metallic !== 'undefined'
      ? { metallic: boundedNumber(next.metallic, base.metallic ?? 0, 0, 1) }
      : {}),
    ...(typeof next.roughness !== 'undefined'
      ? { roughness: boundedNumber(next.roughness, base.roughness ?? 0.7, 0, 1) }
      : {}),
    ...(typeof next.opacity !== 'undefined'
      ? { opacity: boundedNumber(next.opacity, base.opacity ?? 1, 0, 1) }
      : {}),
    ...(safeHexColor(next.emissive) ? { emissive: safeHexColor(next.emissive)! } : {}),
    ...(next.textureAssetId && /^[a-zA-Z0-9_-]{16,128}$/.test(next.textureAssetId)
      ? { textureAssetId: next.textureAssetId }
      : {}),
    ...(typeof next.doubleSided === 'boolean' ? { doubleSided: next.doubleSided } : {})
  }
}

function cloneNode(node: MeshSceneNode): MeshSceneNode {
  if (node.kind === 'primitive') {
    return {
      ...node,
      transform: mergeTransform(node.transform),
      material: mergeMaterial(node.material)
    }
  }
  if (node.kind === 'editable') {
    return {
      ...node,
      topologySummary: JSON.parse(JSON.stringify(node.topologySummary)),
      source: { ...node.source },
      transform: mergeTransform(node.transform),
      material: mergeMaterial(node.material)
    }
  }
  return {
    ...node,
    transform: mergeTransform(node.transform),
    ...(node.material ? { material: mergeMaterial(node.material) } : {})
  }
}

function cloneScene(scene: MeshSceneRecord): MeshSceneRecord {
  return {
    ...scene,
    lighting: { ...scene.lighting },
    camera: {
      position: { ...scene.camera.position },
      target: { ...scene.camera.target },
      fieldOfView: scene.camera.fieldOfView
    },
    nodes: scene.nodes.map(cloneNode),
    dependencies: cloneMeshSceneDependencyGraph(scene.dependencies),
    ...(scene.presentation ? { presentation: { ...scene.presentation } } : {})
  }
}

/** A clean ownership boundary around mesh scene mutation and rendering data. */
export class MeshSceneService {
  private historyClearHolds = 0
  private readonly chatHolds = new Map<string, number>()
  private readonly workspaceHolds = new Map<string, number>()

  constructor(private readonly deps: MeshSceneServiceDeps) {}

  private persist(scene: MeshSceneRecord): MeshSceneRecord {
    const saved = this.deps.store.upsert(scene)
    this.deps.assets.remove(saved.orphanedAssetIds)
    this.deps.topologies.remove(saved.orphanedTopologyIds)
    return saved.scene
  }

  private emit(kind: MeshSceneEvent['kind'], scene: MeshSceneRecord): void {
    this.deps.broadcast?.({
      schemaVersion: 1,
      kind,
      sceneId: scene.id,
      ...(scene.chatId ? { chatId: scene.chatId } : {}),
      summary: meshSceneSummary(scene),
      createdAt: this.deps.now()
    })
  }

  private blocked(ctx: MeshSceneCallContext): boolean {
    return Boolean(
      this.historyClearHolds > 0 ||
      (ctx.chatId && (this.chatHolds.get(ctx.chatId) ?? 0) > 0) ||
      (ctx.workspacePath && (this.workspaceHolds.get(ctx.workspacePath) ?? 0) > 0)
    )
  }

  private requireChat(ctx: MeshSceneCallContext): string {
    const chatId = nonEmpty(ctx.chatId, 256)
    if (!chatId) throw new Error('Mesh Canvas requires an active chat authority.')
    return chatId
  }

  private assertSceneAuthority(scene: MeshSceneRecord, ctx: MeshSceneCallContext): void {
    if (this.blocked(ctx))
      throw new Error('Mesh Canvas history is being cleared; try again afterwards.')
    const chatId = this.requireChat(ctx)
    if (scene.chatId !== chatId)
      throw new Error('The Mesh Canvas scene does not belong to this chat.')
  }

  private getOwned(sceneId: string, ctx: MeshSceneCallContext): MeshSceneRecord {
    const scene = this.deps.store.get(sceneId)
    if (!scene) throw new Error('Mesh Canvas scene was not found.')
    this.assertSceneAuthority(scene, ctx)
    return scene
  }

  private assertWorkspaceSource(sourcePath: string, ctx: MeshSceneCallContext): string {
    if (!nonEmpty(ctx.workspacePath, 4_096)) {
      throw new Error('Mesh imports require a workspace-scoped chat.')
    }
    const workspace = fs.realpathSync(ctx.workspacePath!)
    const source = fs.realpathSync(sourcePath)
    const relative = path.relative(workspace, source)
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error('Mesh imports must stay inside the active workspace.')
    }
    return source
  }

  create(
    input: { title?: string; backgroundColor?: string },
    ctx: MeshSceneCallContext
  ): MeshSceneRecord {
    if (this.blocked(ctx))
      throw new Error('Mesh Canvas history is being cleared; try again afterwards.')
    const chatId = this.requireChat(ctx)
    const now = this.deps.now()
    const scene: MeshSceneRecord = {
      schemaVersion: MESH_SCENE_SCHEMA_VERSION,
      id: this.deps.uuid(),
      revision: 0,
      chatId,
      ...(nonEmpty(ctx.runId, 256) ? { runId: nonEmpty(ctx.runId, 256)! } : {}),
      ...(nonEmpty(ctx.workspacePath, 4_096) ? { workspacePath: ctx.workspacePath } : {}),
      title: nonEmpty(input.title, 200) ?? 'Mesh scene',
      backgroundColor: safeHexColor(input.backgroundColor) ?? '#171a21',
      lighting: cloneDefaultLighting(),
      camera: cloneDefaultCamera(),
      nodes: [],
      dependencies: createEmptyMeshSceneDependencyGraph(),
      createdAt: now,
      updatedAt: now
    }
    const saved = this.persist(scene)
    this.emit('scene.created', saved)
    return cloneScene(saved)
  }

  /**
   * Import a model selected by the human through TaskWraith's native file
   * picker. Unlike `importModel`, this deliberately does not accept an
   * agent-supplied workspace path: the picker selection itself is the only
   * authority for a Documents/Downloads-style source. The copied vault asset
   * and resulting scene remain chat-owned, so agents can subsequently inspect
   * and edit it through their ordinary Mesh Canvas grant.
   */
  importUserSelectedModel(
    input: { sourcePath: string; title?: string },
    ctx: MeshSceneCallContext
  ): MeshSceneRecord {
    if (this.blocked(ctx))
      throw new Error('Mesh Canvas history is being cleared; try again afterwards.')
    const chatId = this.requireChat(ctx)
    const asset = this.deps.assets.importModel(input.sourcePath).manifest
    const now = this.deps.now()
    const displayName =
      path.basename(asset.entryPath, path.extname(asset.entryPath)) || 'Imported mesh'
    const scene: MeshSceneRecord = {
      schemaVersion: MESH_SCENE_SCHEMA_VERSION,
      id: this.deps.uuid(),
      revision: 0,
      chatId,
      ...(nonEmpty(ctx.runId, 256) ? { runId: nonEmpty(ctx.runId, 256)! } : {}),
      ...(nonEmpty(ctx.workspacePath, 4_096) ? { workspacePath: ctx.workspacePath } : {}),
      title: nonEmpty(input.title, 200) ?? displayName,
      backgroundColor: '#171a21',
      lighting: cloneDefaultLighting(),
      camera: cloneDefaultCamera(),
      nodes: [
        {
          id: this.deps.uuid(),
          kind: 'import',
          name: asset.entryPath,
          assetId: asset.id,
          format: asset.format!,
          entryPath: asset.entryPath,
          transform: cloneDefaultTransform(),
          visible: true
        }
      ],
      dependencies: createEmptyMeshSceneDependencyGraph(),
      createdAt: now,
      updatedAt: now
    }
    let saved: MeshSceneRecord
    try {
      saved = this.persist(scene)
    } catch (error) {
      this.deps.assets.remove([asset.id])
      throw error
    }
    this.emit('scene.created', saved)
    return cloneScene(saved)
  }

  /**
   * Import a human-selected declarative scene package. Its manifest has already
   * constrained the copy to exported model roots and declared local sidecars;
   * no native DCC project, extension, script, or editor process is executed.
   */
  importUserSelectedScenePackage(
    input: { manifestPath: string; title?: string },
    ctx: MeshSceneCallContext
  ): MeshSceneRecord {
    if (this.blocked(ctx)) {
      throw new Error('Mesh Canvas history is being cleared; try again afterwards.')
    }
    const chatId = this.requireChat(ctx)
    const imported = this.deps.assets.importScenePackage(input.manifestPath)
    if (imported.roots.length > MESH_MAX_SCENE_NODES) {
      this.deps.assets.remove([imported.manifest.id])
      throw new Error(`Mesh Canvas scenes support up to ${MESH_MAX_SCENE_NODES} objects.`)
    }
    const now = this.deps.now()
    const nodes: MeshSceneNode[] = imported.roots.map((root) => {
      const displayName = path.basename(root.path, path.extname(root.path)) || 'Imported mesh'
      return {
        id: this.deps.uuid(),
        kind: 'import',
        name: root.name ?? displayName,
        assetId: imported.manifest.id,
        format: root.format,
        entryPath: root.path,
        transform: cloneDefaultTransform(),
        visible: true
      }
    })
    const firstNode = nodes[0]
    if (!firstNode) {
      this.deps.assets.remove([imported.manifest.id])
      throw new Error('Scene package has no importable roots.')
    }
    const scene: MeshSceneRecord = {
      schemaVersion: MESH_SCENE_SCHEMA_VERSION,
      id: this.deps.uuid(),
      revision: 0,
      chatId,
      ...(nonEmpty(ctx.runId, 256) ? { runId: nonEmpty(ctx.runId, 256)! } : {}),
      ...(nonEmpty(ctx.workspacePath, 4_096) ? { workspacePath: ctx.workspacePath } : {}),
      title: nonEmpty(input.title, 200) ?? imported.title ?? firstNode.name,
      backgroundColor: '#171a21',
      lighting: cloneDefaultLighting(),
      camera: cloneDefaultCamera(),
      nodes,
      dependencies: createEmptyMeshSceneDependencyGraph(),
      createdAt: now,
      updatedAt: now
    }
    let saved: MeshSceneRecord
    try {
      saved = this.persist(scene)
    } catch (error) {
      this.deps.assets.remove([imported.manifest.id])
      throw error
    }
    this.emit('scene.created', saved)
    return cloneScene(saved)
  }

  list(ctx: MeshSceneCallContext): MeshSceneSummary[] {
    const chatId = this.requireChat(ctx)
    return this.deps.store
      .list()
      .filter((scene) => scene.chatId === chatId)
      .map(meshSceneSummary)
  }

  inspect(sceneId: string, ctx: MeshSceneCallContext): MeshSceneRecord {
    return cloneScene(this.getOwned(sceneId, ctx))
  }

  importModel(
    sceneId: string,
    input: { sourcePath: string; name?: string; transform?: MeshTransformInput },
    ctx: MeshSceneCallContext
  ): MeshSceneRecord {
    const scene = cloneScene(this.getOwned(sceneId, ctx))
    if (scene.nodes.length >= MESH_MAX_SCENE_NODES) {
      throw new Error(`Mesh Canvas scenes support up to ${MESH_MAX_SCENE_NODES} objects.`)
    }
    const sourcePath = this.assertWorkspaceSource(input.sourcePath, ctx)
    const asset = this.deps.assets.importModel(sourcePath).manifest
    const node: MeshSceneNode = {
      id: this.deps.uuid(),
      kind: 'import',
      name: nonEmpty(input.name, 200) ?? path.basename(sourcePath),
      assetId: asset.id,
      format: asset.format!,
      entryPath: asset.entryPath,
      transform: mergeTransform(cloneDefaultTransform(), input.transform),
      visible: true
    }
    scene.nodes.push(node)
    scene.revision += 1
    scene.updatedAt = this.deps.now()
    let saved: MeshSceneRecord
    try {
      saved = this.persist(scene)
    } catch (error) {
      this.deps.assets.remove([asset.id])
      throw error
    }
    this.emit('scene.updated', saved)
    return cloneScene(saved)
  }

  apply(sceneId: string, mutation: MeshSceneMutation, ctx: MeshSceneCallContext): MeshSceneRecord {
    const scene = cloneScene(this.getOwned(sceneId, ctx))
    if (mutation.operation === 'add_primitive') {
      if (!isMeshPrimitiveKind(mutation.primitive))
        throw new Error('Unsupported Mesh Canvas primitive.')
      if (scene.nodes.length >= MESH_MAX_SCENE_NODES) {
        throw new Error(`Mesh Canvas scenes support up to ${MESH_MAX_SCENE_NODES} objects.`)
      }
      scene.nodes.push({
        id: this.deps.uuid(),
        kind: 'primitive',
        primitive: mutation.primitive,
        name: nonEmpty(mutation.name, 200) ?? mutation.primitive,
        transform: mergeTransform(cloneDefaultTransform(), mutation.transform),
        material: mergeMaterial({}, mutation.material),
        visible: true
      })
    } else if (mutation.operation === 'update_node') {
      const nodeId = nonEmpty(mutation.nodeId, 128)
      const index = nodeId ? scene.nodes.findIndex((node) => node.id === nodeId) : -1
      if (index < 0) throw new Error('Mesh Canvas node was not found.')
      const current = scene.nodes[index]
      const name = nonEmpty(mutation.name, 200) ?? current.name
      if (current.kind === 'primitive') {
        scene.nodes[index] = {
          ...current,
          name,
          transform: mergeTransform(current.transform, mutation.transform),
          material: mergeMaterial(current.material, mutation.material),
          ...(typeof mutation.visible === 'boolean' ? { visible: mutation.visible } : {})
        }
      } else {
        scene.nodes[index] = {
          ...current,
          name,
          transform: mergeTransform(current.transform, mutation.transform),
          ...(mutation.material
            ? { material: mergeMaterial(current.material, mutation.material) }
            : {}),
          ...(typeof mutation.visible === 'boolean' ? { visible: mutation.visible } : {})
        }
      }
    } else if (mutation.operation === 'remove_node') {
      const nodeId = nonEmpty(mutation.nodeId, 128)
      if (!nodeId) throw new Error('Mesh Canvas node was not found.')
      const next = scene.nodes.filter((node) => node.id !== nodeId)
      if (next.length === scene.nodes.length) throw new Error('Mesh Canvas node was not found.')
      scene.nodes = next
      removeMeshSceneNodeDependencies(scene, nodeId)
    } else if (mutation.operation === 'set_scene') {
      const nextTitle = nonEmpty(mutation.title, 200)
      const nextBackground = safeHexColor(mutation.backgroundColor)
      scene.title = nextTitle ?? scene.title
      scene.backgroundColor = nextBackground ?? scene.backgroundColor
      if (mutation.lighting) {
        scene.lighting = {
          environment:
            mutation.lighting.environment === 'sunset' ||
            mutation.lighting.environment === 'neutral'
              ? mutation.lighting.environment
              : scene.lighting.environment,
          intensity: boundedNumber(mutation.lighting.intensity, scene.lighting.intensity, 0, 8)
        }
      }
      if (mutation.camera) {
        scene.camera = {
          position: {
            x: boundedNumber(
              mutation.camera.position?.x,
              scene.camera.position.x,
              -100_000,
              100_000
            ),
            y: boundedNumber(
              mutation.camera.position?.y,
              scene.camera.position.y,
              -100_000,
              100_000
            ),
            z: boundedNumber(
              mutation.camera.position?.z,
              scene.camera.position.z,
              -100_000,
              100_000
            )
          },
          target: {
            x: boundedNumber(mutation.camera.target?.x, scene.camera.target.x, -100_000, 100_000),
            y: boundedNumber(mutation.camera.target?.y, scene.camera.target.y, -100_000, 100_000),
            z: boundedNumber(mutation.camera.target?.z, scene.camera.target.z, -100_000, 100_000)
          },
          fieldOfView: boundedNumber(mutation.camera.fieldOfView, scene.camera.fieldOfView, 15, 100)
        }
      }
    } else if (mutation.operation === 'upsert_object_data') {
      upsertMeshSceneObjectData(scene, mutation, this.deps.now())
    } else if (mutation.operation === 'bind_node_property') {
      bindMeshSceneNodeProperty(scene, mutation, this.deps.uuid, this.deps.now())
    } else if (mutation.operation === 'unbind_node_property') {
      unbindMeshSceneNodeProperty(scene, mutation)
    }
    // A normal tool mutation may update a source node, while an object-data
    // mutation updates an external fact. Either way, resolve all reachable
    // descendants in one durable transaction before the renderer hears about
    // the resulting scene.updated event.
    resolveMeshSceneDependencyGraph(scene)
    scene.revision += 1
    scene.updatedAt = this.deps.now()
    const saved = this.persist(scene)
    this.emit('scene.updated', saved)
    return cloneScene(saved)
  }

  /** Materialize a renderer primitive or opaque import as chat-owned editable topology. */
  makeEditable(
    sceneId: string,
    input: { nodeId: string },
    ctx: MeshSceneCallContext
  ): { scene: MeshSceneRecord; topology: MeshTopologyDocument } {
    const scene = cloneScene(this.getOwned(sceneId, ctx))
    const nodeIndex = scene.nodes.findIndex((entry) => entry.id === input.nodeId)
    if (nodeIndex < 0) throw new Error('Mesh Canvas node was not found.')
    const node = scene.nodes[nodeIndex]
    if (node.kind === 'editable') {
      const topology = this.deps.topologies.get(node.topologyId)
      if (!topology) throw new Error('Editable topology is no longer available.')
      return { scene, topology }
    }
    const topologyId = this.deps.uuid()
    const topology =
      node.kind === 'primitive'
        ? meshTopologyFromPrimitive({
            topologyId,
            primitive: node.primitive,
            name: node.name,
            uuid: this.deps.uuid,
            now: this.deps.now
          })
        : meshTopologyFromImportedNode({
            topologyId,
            node,
            assets: this.deps.assets,
            uuid: this.deps.uuid,
            now: this.deps.now
          })
    if (topology.source.kind === 'generated') {
      throw new Error('Converted topology lost its primitive/import provenance.')
    }
    const summary = meshTopologySummary(topology)
    scene.nodes[nodeIndex] = {
      id: node.id,
      kind: 'editable',
      name: node.name,
      topologyId: topology.id,
      topologyRevision: topology.revision,
      topologySummary: summary,
      source: topology.source,
      transform: mergeTransform(node.transform),
      material: mergeMaterial(node.kind === 'primitive' ? node.material : node.material),
      visible: node.visible
    }
    scene.revision += 1
    scene.updatedAt = this.deps.now()
    this.deps.topologies.upsert(topology)
    let saved: MeshSceneRecord
    try {
      saved = this.persist(scene)
    } catch (error) {
      this.deps.topologies.remove([topology.id])
      throw error
    }
    this.emit('scene.updated', saved)
    return { scene: cloneScene(saved), topology }
  }

  inspectTopology(
    sceneId: string,
    input: { nodeId: string },
    ctx: MeshSceneCallContext
  ): { sceneRevision: number; nodeId: string; topology: MeshTopologyDocument } {
    const scene = this.getOwned(sceneId, ctx)
    const node = scene.nodes.find((entry) => entry.id === input.nodeId)
    if (!node || node.kind !== 'editable')
      throw new Error('Editable Mesh Canvas node was not found.')
    const topology = this.deps.topologies.get(node.topologyId)
    if (!topology || topology.revision !== node.topologyRevision) {
      throw new Error('Editable topology is unavailable or out of sync with its scene node.')
    }
    return { sceneRevision: scene.revision, nodeId: node.id, topology }
  }

  editTopology(
    sceneId: string,
    input: { nodeId: string; edit: MeshTopologyEditInput },
    ctx: MeshSceneCallContext
  ): { scene: MeshSceneRecord; edit: MeshTopologyEditResult } {
    const scene = cloneScene(this.getOwned(sceneId, ctx))
    const nodeIndex = scene.nodes.findIndex((entry) => entry.id === input.nodeId)
    const node = nodeIndex >= 0 ? scene.nodes[nodeIndex] : null
    if (!node || node.kind !== 'editable')
      throw new Error('Editable Mesh Canvas node was not found.')
    const current = this.deps.topologies.get(node.topologyId)
    if (!current || current.revision !== node.topologyRevision) {
      throw new Error('Editable topology is unavailable or out of sync with its scene node.')
    }
    const edit = applyMeshTopologyEdit(
      current,
      {
        ...input.edit,
        editor: {
          ...(nonEmpty(ctx.provider, 100) ? { provider: nonEmpty(ctx.provider, 100)! } : {}),
          ...(nonEmpty(ctx.runId, 256) ? { runId: nonEmpty(ctx.runId, 256)! } : {}),
          ...(nonEmpty(ctx.participantId, 256)
            ? { participantId: nonEmpty(ctx.participantId, 256)! }
            : {})
        }
      },
      { uuid: this.deps.uuid, now: this.deps.now }
    )
    if (edit.duplicate) return { scene, edit }
    scene.nodes[nodeIndex] = {
      ...node,
      topologyRevision: edit.document.revision,
      topologySummary: edit.summary
    }
    scene.revision += 1
    scene.updatedAt = this.deps.now()
    this.deps.topologies.upsert(edit.document)
    let saved: MeshSceneRecord
    try {
      saved = this.persist(scene)
    } catch (error) {
      this.deps.topologies.upsert(current)
      throw error
    }
    this.emit('scene.updated', saved)
    return { scene: cloneScene(saved), edit }
  }

  setMaterial(
    sceneId: string,
    input: { nodeId: string; material: MeshPbrMaterial; textureSourcePath?: string },
    ctx: MeshSceneCallContext
  ): MeshSceneRecord {
    const material = { ...input.material }
    // Validate the chat-owned node before allocating a new private texture
    // asset, so a typo or cross-chat scene id cannot leave an orphaned vault
    // bundle behind.
    const existing = this.getOwned(sceneId, ctx)
    if (!existing.nodes.some((node) => node.id === input.nodeId)) {
      throw new Error('Mesh Canvas node was not found.')
    }
    let importedTextureAssetId: string | null = null
    if (input.textureSourcePath) {
      const textureSource = this.assertWorkspaceSource(input.textureSourcePath, ctx)
      importedTextureAssetId = this.deps.assets.importTexture(textureSource).manifest.id
      material.textureAssetId = importedTextureAssetId
    }
    try {
      return this.apply(sceneId, { operation: 'update_node', nodeId: input.nodeId, material }, ctx)
    } catch (error) {
      if (importedTextureAssetId) this.deps.assets.remove([importedTextureAssetId])
      throw error
    }
  }

  present(sceneId: string, input: { title?: string }, ctx: MeshSceneCallContext): MeshSceneRecord {
    const scene = cloneScene(this.getOwned(sceneId, ctx))
    scene.presentation = {
      presentedAt: this.deps.now(),
      ...(nonEmpty(ctx.provider, 100) ? { presenter: nonEmpty(ctx.provider, 100)! } : {}),
      ...(nonEmpty(input.title, 200) ? { title: nonEmpty(input.title, 200)! } : {})
    }
    scene.revision += 1
    scene.updatedAt = this.deps.now()
    const saved = this.persist(scene)
    this.emit('scene.presented', saved)
    return cloneScene(saved)
  }

  closePresentation(sceneId: string, ctx: MeshSceneCallContext): MeshSceneRecord {
    const scene = cloneScene(this.getOwned(sceneId, ctx))
    delete scene.presentation
    scene.revision += 1
    scene.updatedAt = this.deps.now()
    const saved = this.persist(scene)
    this.emit('scene.closed', saved)
    return cloneScene(saved)
  }

  remove(sceneId: string, ctx: MeshSceneCallContext): string {
    const scene = cloneScene(this.getOwned(sceneId, ctx))
    const result = this.deps.store.remove(scene.id)
    if (!result.removed) throw new Error('Mesh Canvas scene was not found.')
    this.deps.assets.remove(result.orphanedAssetIds)
    this.deps.topologies.remove(result.orphanedTopologyIds)
    this.emit('scene.deleted', scene)
    return scene.id
  }

  /** Renderer-only projection. The tokenized URLs never cross the MCP result. */
  viewForChat(sceneId: string, chatId: string): MeshSceneView | null {
    const scene = this.deps.store.get(sceneId)
    if (!scene || scene.chatId !== chatId) return null
    const assetIds = new Set<string>()
    for (const node of scene.nodes) {
      if (node.kind === 'import') assetIds.add(node.assetId)
      if ((node.kind === 'primitive' || node.kind === 'editable') && node.material.textureAssetId) {
        assetIds.add(node.material.textureAssetId)
      }
      if (node.kind === 'import' && node.material?.textureAssetId) {
        assetIds.add(node.material.textureAssetId)
      }
    }
    const assetUrls: Record<string, string> = {}
    const assetsById = new Map<string, NonNullable<ReturnType<MeshAssetStore['get']>>>()
    for (const assetId of assetIds) {
      const asset = this.deps.assets.get(assetId)
      if (!asset) continue
      assetsById.set(assetId, asset)
      const url = meshAssetUrl({
        assetId: asset.id,
        accessToken: asset.accessToken,
        relativePath: asset.entryPath
      })
      if (url) assetUrls[assetId] = url
    }
    const modelUrls: Record<string, string> = {}
    for (const node of scene.nodes) {
      if (node.kind !== 'import') continue
      const asset = assetsById.get(node.assetId)
      if (!asset) continue
      const url = meshAssetUrl({
        assetId: asset.id,
        accessToken: asset.accessToken,
        relativePath: node.entryPath
      })
      if (url) modelUrls[node.id] = url
    }
    const topologies: Record<string, MeshTopologyDocument> = {}
    for (const node of scene.nodes) {
      if (node.kind !== 'editable') continue
      const topology = this.deps.topologies.get(node.topologyId)
      if (topology && topology.revision === node.topologyRevision) {
        topologies[node.topologyId] = topology
      }
    }
    const {
      workspacePath: _workspacePath,
      dependencies: _dependencies,
      ...rendererScene
    } = cloneScene(scene)
    return { ...rendererScene, assetUrls, modelUrls, topologies }
  }

  listForChat(chatId: string): MeshSceneSummary[] {
    return this.deps.store
      .list()
      .filter((scene) => scene.chatId === chatId)
      .map(meshSceneSummary)
  }

  beginAuthorityHistoryClear(input: MeshHistoryAuthority): Promise<void> {
    const chatIds = new Set([...(input.chatIds ?? [])].map((value) => value.trim()).filter(Boolean))
    const workspacePaths = new Set(
      [...(input.workspacePaths ?? [])].map((value) => value.trim()).filter(Boolean)
    )
    for (const chatId of chatIds) this.chatHolds.set(chatId, (this.chatHolds.get(chatId) ?? 0) + 1)
    for (const workspacePath of workspacePaths) {
      this.workspaceHolds.set(workspacePath, (this.workspaceHolds.get(workspacePath) ?? 0) + 1)
    }
    try {
      const removed = this.deps.store.purgeAuthorities({ chatIds, workspacePaths })
      this.deps.assets.remove(removed.assetIds)
      this.deps.topologies.remove(removed.topologyIds)
      return Promise.resolve()
    } catch (error) {
      return Promise.reject(error)
    }
  }

  endAuthorityHistoryClear(input: MeshHistoryAuthority): void {
    for (const value of input.chatIds ?? []) {
      const chatId = value.trim()
      if (!chatId) continue
      const next = (this.chatHolds.get(chatId) ?? 0) - 1
      if (next > 0) this.chatHolds.set(chatId, next)
      else this.chatHolds.delete(chatId)
    }
    for (const value of input.workspacePaths ?? []) {
      const workspacePath = value.trim()
      if (!workspacePath) continue
      const next = (this.workspaceHolds.get(workspacePath) ?? 0) - 1
      if (next > 0) this.workspaceHolds.set(workspacePath, next)
      else this.workspaceHolds.delete(workspacePath)
    }
  }

  beginHistoryClear(): Promise<void> {
    this.historyClearHolds += 1
    try {
      const removed = this.deps.store.clearAll()
      this.deps.assets.remove(removed.assetIds)
      this.deps.topologies.remove(removed.topologyIds)
      this.deps.assets.clearAll()
      this.deps.topologies.clearAll()
      return Promise.resolve()
    } catch (error) {
      return Promise.reject(error)
    }
  }

  endHistoryClear(): void {
    if (this.historyClearHolds > 0) this.historyClearHolds -= 1
  }
}
