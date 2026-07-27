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
  isMeshPrimitiveKind,
  meshAssetUrl,
  meshSceneSummary,
  type MeshPbrMaterial,
  type MeshPrimitiveKind,
  type MeshSceneCamera,
  type MeshSceneLighting,
  type MeshSceneNode,
  type MeshSceneRecord,
  type MeshSceneSummary,
  type MeshSceneView,
  type MeshTransform
} from '../../shared/meshScene'
import type { MeshAssetStore } from './MeshAssetStore'
import type { MeshSceneStore } from './MeshSceneStore'

export interface MeshSceneCallContext {
  provider?: string
  chatId?: string
  runId?: string
  workspacePath?: string
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

export interface MeshSceneServiceDeps {
  store: MeshSceneStore
  assets: MeshAssetStore
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
  return color && (/^#[0-9a-f]{6}$/i.test(color) || /^#[0-9a-f]{3}$/i.test(color))
    ? color
    : null
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

function mergeMaterial(current: MeshPbrMaterial | undefined, next?: MeshPbrMaterial): MeshPbrMaterial {
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
    if (this.blocked(ctx)) throw new Error('Mesh Canvas history is being cleared; try again afterwards.')
    const chatId = this.requireChat(ctx)
    if (scene.chatId !== chatId) throw new Error('The Mesh Canvas scene does not belong to this chat.')
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
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Mesh imports must stay inside the active workspace.')
    }
    return source
  }

  create(
    input: { title?: string; backgroundColor?: string },
    ctx: MeshSceneCallContext
  ): MeshSceneRecord {
    if (this.blocked(ctx)) throw new Error('Mesh Canvas history is being cleared; try again afterwards.')
    const chatId = this.requireChat(ctx)
    const now = this.deps.now()
    const scene: MeshSceneRecord = {
      schemaVersion: MESH_SCENE_SCHEMA_VERSION,
      id: this.deps.uuid(),
      chatId,
      ...(nonEmpty(ctx.runId, 256) ? { runId: nonEmpty(ctx.runId, 256)! } : {}),
      ...(nonEmpty(ctx.workspacePath, 4_096) ? { workspacePath: ctx.workspacePath } : {}),
      title: nonEmpty(input.title, 200) ?? 'Mesh scene',
      backgroundColor: safeHexColor(input.backgroundColor) ?? '#171a21',
      lighting: cloneDefaultLighting(),
      camera: cloneDefaultCamera(),
      nodes: [],
      createdAt: now,
      updatedAt: now
    }
    const saved = this.persist(scene)
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
      if (!isMeshPrimitiveKind(mutation.primitive)) throw new Error('Unsupported Mesh Canvas primitive.')
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
          ...(mutation.material ? { material: mergeMaterial(current.material, mutation.material) } : {}),
          ...(typeof mutation.visible === 'boolean' ? { visible: mutation.visible } : {})
        }
      }
    } else if (mutation.operation === 'remove_node') {
      const nodeId = nonEmpty(mutation.nodeId, 128)
      const next = scene.nodes.filter((node) => node.id !== nodeId)
      if (next.length === scene.nodes.length) throw new Error('Mesh Canvas node was not found.')
      scene.nodes = next
    } else if (mutation.operation === 'set_scene') {
      const nextTitle = nonEmpty(mutation.title, 200)
      const nextBackground = safeHexColor(mutation.backgroundColor)
      scene.title = nextTitle ?? scene.title
      scene.backgroundColor = nextBackground ?? scene.backgroundColor
      if (mutation.lighting) {
        scene.lighting = {
          environment:
            mutation.lighting.environment === 'sunset' || mutation.lighting.environment === 'neutral'
              ? mutation.lighting.environment
              : scene.lighting.environment,
          intensity: boundedNumber(mutation.lighting.intensity, scene.lighting.intensity, 0, 8)
        }
      }
      if (mutation.camera) {
        scene.camera = {
          position: {
            x: boundedNumber(mutation.camera.position?.x, scene.camera.position.x, -100_000, 100_000),
            y: boundedNumber(mutation.camera.position?.y, scene.camera.position.y, -100_000, 100_000),
            z: boundedNumber(mutation.camera.position?.z, scene.camera.position.z, -100_000, 100_000)
          },
          target: {
            x: boundedNumber(mutation.camera.target?.x, scene.camera.target.x, -100_000, 100_000),
            y: boundedNumber(mutation.camera.target?.y, scene.camera.target.y, -100_000, 100_000),
            z: boundedNumber(mutation.camera.target?.z, scene.camera.target.z, -100_000, 100_000)
          },
          fieldOfView: boundedNumber(mutation.camera.fieldOfView, scene.camera.fieldOfView, 15, 100)
        }
      }
    }
    scene.updatedAt = this.deps.now()
    const saved = this.persist(scene)
    this.emit('scene.updated', saved)
    return cloneScene(saved)
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

  present(
    sceneId: string,
    input: { title?: string },
    ctx: MeshSceneCallContext
  ): MeshSceneRecord {
    const scene = cloneScene(this.getOwned(sceneId, ctx))
    scene.presentation = {
      presentedAt: this.deps.now(),
      ...(nonEmpty(ctx.provider, 100) ? { presenter: nonEmpty(ctx.provider, 100)! } : {}),
      ...(nonEmpty(input.title, 200) ? { title: nonEmpty(input.title, 200)! } : {})
    }
    scene.updatedAt = this.deps.now()
    const saved = this.persist(scene)
    this.emit('scene.presented', saved)
    return cloneScene(saved)
  }

  closePresentation(sceneId: string, ctx: MeshSceneCallContext): MeshSceneRecord {
    const scene = cloneScene(this.getOwned(sceneId, ctx))
    delete scene.presentation
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
      if (node.kind === 'primitive' && node.material.textureAssetId) {
        assetIds.add(node.material.textureAssetId)
      }
      if (node.kind === 'import' && node.material?.textureAssetId) {
        assetIds.add(node.material.textureAssetId)
      }
    }
    const assetUrls: Record<string, string> = {}
    for (const assetId of assetIds) {
      const asset = this.deps.assets.get(assetId)
      if (!asset) continue
      const url = meshAssetUrl({
        assetId: asset.id,
        accessToken: asset.accessToken,
        relativePath: asset.entryPath
      })
      if (url) assetUrls[assetId] = url
    }
    const { workspacePath: _workspacePath, ...rendererScene } = cloneScene(scene)
    return { ...rendererScene, assetUrls }
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
      const assets = this.deps.store.purgeAuthorities({ chatIds, workspacePaths })
      this.deps.assets.remove(assets)
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
      const assets = this.deps.store.clearAll()
      this.deps.assets.remove(assets)
      this.deps.assets.clearAll()
      return Promise.resolve()
    } catch (error) {
      return Promise.reject(error)
    }
  }

  endHistoryClear(): void {
    if (this.historyClearHolds > 0) this.historyClearHolds -= 1
  }
}
