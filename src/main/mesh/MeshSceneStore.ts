/** Durable workspace-recallable (or, without a workspace, chat-scoped) Mesh Canvas scenes. */
import * as fs from 'fs'
import * as path from 'path'
import {
  MESH_SCENE_LEGACY_SCHEMA_VERSION,
  MESH_SCENE_SCHEMA_VERSION,
  MESH_MAX_SCENE_NODES,
  cloneDefaultCamera,
  cloneDefaultLighting,
  cloneDefaultTransform,
  isMeshImportFormat,
  isMeshPrimitiveKind,
  isSafeMeshAssetRelativePath,
  type MeshPbrMaterial,
  type MeshSceneNode,
  type MeshSceneRecord,
  type MeshTransform,
  type MeshVector3
} from '../../shared/meshScene'
import type { MeshTopologySummary } from '../../shared/meshTopology'
import {
  normalizeMeshSceneDependencyGraph,
  resolveMeshSceneDependencyGraph
} from './MeshSceneDependencyGraph'

const SCENES_FILE = 'mesh-scenes.json'
const MAX_SCENES = 200

function canonicalWorkspacePath(value: string): string {
  try {
    return fs.realpathSync(value)
  } catch {
    return path.resolve(value)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown, limit = 2_000): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed && trimmed.length <= limit ? trimmed : null
}

function asFinite(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback
}

function asVector(value: unknown, fallback: MeshVector3): MeshVector3 {
  const raw = isRecord(value) ? value : {}
  return {
    x: asFinite(raw.x, fallback.x, -100_000, 100_000),
    y: asFinite(raw.y, fallback.y, -100_000, 100_000),
    z: asFinite(raw.z, fallback.z, -100_000, 100_000)
  }
}

function asTransform(value: unknown): MeshTransform {
  const defaults = cloneDefaultTransform()
  const raw = isRecord(value) ? value : {}
  return {
    position: asVector(raw.position, defaults.position),
    rotation: asVector(raw.rotation, defaults.rotation),
    scale: {
      x: asFinite(isRecord(raw.scale) ? raw.scale.x : undefined, defaults.scale.x, 0.001, 10_000),
      y: asFinite(isRecord(raw.scale) ? raw.scale.y : undefined, defaults.scale.y, 0.001, 10_000),
      z: asFinite(isRecord(raw.scale) ? raw.scale.z : undefined, defaults.scale.z, 0.001, 10_000)
    }
  }
}

function asColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const color = value.trim()
  return /^#[0-9a-f]{6}$/i.test(color) || /^#[0-9a-f]{3}$/i.test(color) ? color : undefined
}

function asMaterial(value: unknown): MeshPbrMaterial {
  const raw = isRecord(value) ? value : {}
  const textureAssetId = asString(raw.textureAssetId, 128)
  return {
    ...(asColor(raw.baseColor) ? { baseColor: asColor(raw.baseColor) } : {}),
    ...(typeof raw.metallic !== 'undefined' ? { metallic: asFinite(raw.metallic, 0, 0, 1) } : {}),
    ...(typeof raw.roughness !== 'undefined'
      ? { roughness: asFinite(raw.roughness, 0.7, 0, 1) }
      : {}),
    ...(typeof raw.opacity !== 'undefined' ? { opacity: asFinite(raw.opacity, 1, 0, 1) } : {}),
    ...(asColor(raw.emissive) ? { emissive: asColor(raw.emissive) } : {}),
    ...(textureAssetId && /^[a-zA-Z0-9_-]{16,128}$/.test(textureAssetId) ? { textureAssetId } : {}),
    ...(typeof raw.doubleSided === 'boolean' ? { doubleSided: raw.doubleSided } : {})
  }
}

function asTopologySummary(value: unknown, topologyId: string): MeshTopologySummary | null {
  if (!isRecord(value) || value.topologyId !== topologyId || !isRecord(value.bounds)) return null
  const revision = asFinite(value.revision, -1, -1, Number.MAX_SAFE_INTEGER)
  const counts = [
    value.vertexCount,
    value.edgeCount,
    value.faceCount,
    value.triangleCount,
    value.uvLoopCount,
    value.seamCount,
    value.boneCount,
    value.weightedVertexCount
  ].map((entry) => asFinite(entry, -1, -1, Number.MAX_SAFE_INTEGER))
  const min = isRecord(value.bounds.min) ? asVector(value.bounds.min, { x: 0, y: 0, z: 0 }) : null
  const max = isRecord(value.bounds.max) ? asVector(value.bounds.max, { x: 0, y: 0, z: 0 }) : null
  const updatedAt = asString(value.updatedAt, 128)
  if (
    revision < 0 ||
    !Number.isInteger(revision) ||
    counts.some((entry) => entry < 0 || !Number.isInteger(entry)) ||
    !min ||
    !max ||
    !updatedAt
  ) {
    return null
  }
  return {
    topologyId,
    revision,
    vertexCount: counts[0],
    edgeCount: counts[1],
    faceCount: counts[2],
    triangleCount: counts[3],
    uvLoopCount: counts[4],
    seamCount: counts[5],
    boneCount: counts[6],
    weightedVertexCount: counts[7],
    bounds: { min, max },
    updatedAt
  }
}

function asNode(value: unknown): MeshSceneNode | null {
  if (!isRecord(value)) return null
  const id = asString(value.id, 128)
  const name = asString(value.name, 200)
  if (!id || !/^[a-zA-Z0-9_-]{3,128}$/.test(id) || !name) return null
  const transform = asTransform(value.transform)
  const visible = value.visible !== false
  if (value.kind === 'primitive' && isMeshPrimitiveKind(value.primitive)) {
    return {
      id,
      kind: 'primitive',
      primitive: value.primitive,
      name,
      transform,
      material: asMaterial(value.material),
      visible
    }
  }
  const topologyId = asString(value.topologyId, 128)
  const topologyRevision = asFinite(value.topologyRevision, -1, -1, Number.MAX_SAFE_INTEGER)
  const topologySummary = topologyId ? asTopologySummary(value.topologySummary, topologyId) : null
  if (
    value.kind === 'editable' &&
    topologyId &&
    /^[a-zA-Z0-9_-]{3,128}$/.test(topologyId) &&
    Number.isInteger(topologyRevision) &&
    topologyRevision >= 0 &&
    topologySummary &&
    topologySummary.revision === topologyRevision &&
    isRecord(value.source)
  ) {
    const primitiveSource =
      value.source.kind === 'primitive' && isMeshPrimitiveKind(value.source.primitive)
        ? { kind: 'primitive' as const, primitive: value.source.primitive }
        : null
    const sourceAssetId = asString(value.source.assetId, 128)
    const sourceEntryPath = typeof value.source.entryPath === 'string' ? value.source.entryPath : ''
    const importSource =
      value.source.kind === 'import' &&
      sourceAssetId &&
      /^[a-zA-Z0-9_-]{16,128}$/.test(sourceAssetId) &&
      isMeshImportFormat(value.source.format) &&
      isSafeMeshAssetRelativePath(sourceEntryPath)
        ? {
            kind: 'import' as const,
            assetId: sourceAssetId,
            format: value.source.format,
            entryPath: sourceEntryPath
          }
        : null
    const source = primitiveSource ?? importSource
    if (!source) return null
    return {
      id,
      kind: 'editable',
      name,
      topologyId,
      topologyRevision,
      topologySummary,
      source,
      transform,
      material: asMaterial(value.material),
      visible
    }
  }
  const assetId = asString(value.assetId, 128)
  const entryPath = typeof value.entryPath === 'string' ? value.entryPath : ''
  if (
    value.kind === 'import' &&
    assetId &&
    /^[a-zA-Z0-9_-]{16,128}$/.test(assetId) &&
    isMeshImportFormat(value.format) &&
    isSafeMeshAssetRelativePath(entryPath)
  ) {
    return {
      id,
      kind: 'import',
      name,
      assetId,
      format: value.format,
      entryPath,
      transform,
      ...(isRecord(value.material) ? { material: asMaterial(value.material) } : {}),
      visible
    }
  }
  return null
}

function normalizeScene(value: unknown): MeshSceneRecord | null {
  if (!isRecord(value)) return null
  const id = asString(value.id, 128)
  const title = asString(value.title, 200)
  const createdAt = asString(value.createdAt, 128)
  const updatedAt = asString(value.updatedAt, 128)
  if (
    (value.schemaVersion !== MESH_SCENE_SCHEMA_VERSION &&
      value.schemaVersion !== MESH_SCENE_LEGACY_SCHEMA_VERSION) ||
    !id ||
    !/^[a-zA-Z0-9_-]{3,128}$/.test(id) ||
    !title ||
    !createdAt ||
    !updatedAt
  ) {
    return null
  }
  const rawNodes = Array.isArray(value.nodes) ? value.nodes : []
  const nodes = rawNodes.map(asNode).filter((node): node is MeshSceneNode => node !== null)
  if (nodes.length !== rawNodes.length || nodes.length > MESH_MAX_SCENE_NODES) return null
  const dependencies = normalizeMeshSceneDependencyGraph(value.dependencies, nodes)
  if (!dependencies) return null
  const rawLighting = isRecord(value.lighting) ? value.lighting : {}
  const rawCamera = isRecord(value.camera) ? value.camera : {}
  const defaults = cloneDefaultCamera()
  const presentation =
    isRecord(value.presentation) && asString(value.presentation.presentedAt, 128)
      ? {
          presentedAt: asString(value.presentation.presentedAt, 128)!,
          ...(asString(value.presentation.presenter, 100)
            ? { presenter: asString(value.presentation.presenter, 100)! }
            : {}),
          ...(asString(value.presentation.title, 200)
            ? { title: asString(value.presentation.title, 200)! }
            : {})
        }
      : undefined
  const scene: MeshSceneRecord = {
    schemaVersion: MESH_SCENE_SCHEMA_VERSION,
    id,
    revision:
      value.schemaVersion === MESH_SCENE_SCHEMA_VERSION
        ? Math.floor(asFinite(value.revision, 0, 0, Number.MAX_SAFE_INTEGER))
        : 0,
    ...(asString(value.chatId, 256) ? { chatId: asString(value.chatId, 256)! } : {}),
    ...(asString(value.runId, 256) ? { runId: asString(value.runId, 256)! } : {}),
    ...(asString(value.workspacePath, 4_096)
      ? { workspacePath: asString(value.workspacePath, 4_096)! }
      : {}),
    title,
    backgroundColor: asColor(value.backgroundColor) ?? '#171a21',
    lighting: {
      environment:
        rawLighting.environment === 'sunset' || rawLighting.environment === 'neutral'
          ? rawLighting.environment
          : 'studio',
      intensity: asFinite(rawLighting.intensity, cloneDefaultLighting().intensity, 0, 8)
    },
    camera: {
      position: asVector(rawCamera.position, defaults.position),
      target: asVector(rawCamera.target, defaults.target),
      fieldOfView: asFinite(rawCamera.fieldOfView, defaults.fieldOfView, 15, 100)
    },
    nodes,
    dependencies,
    createdAt,
    updatedAt,
    ...(presentation ? { presentation } : {})
  }
  try {
    resolveMeshSceneDependencyGraph(scene)
    return scene
  } catch {
    return null
  }
}

function assetsInScene(scene: MeshSceneRecord): Set<string> {
  const assets = new Set<string>()
  for (const node of scene.nodes) {
    if (node.kind === 'import') assets.add(node.assetId)
    if (node.kind === 'editable' && node.source.kind === 'import') assets.add(node.source.assetId)
    if ((node.kind === 'primitive' || node.kind === 'editable') && node.material.textureAssetId) {
      assets.add(node.material.textureAssetId)
    }
    if (node.kind === 'import' && node.material?.textureAssetId) {
      assets.add(node.material.textureAssetId)
    }
  }
  return assets
}

function topologiesInScene(scene: MeshSceneRecord): Set<string> {
  return new Set(
    scene.nodes.filter((node) => node.kind === 'editable').map((node) => node.topologyId)
  )
}

function orphanedAssets(
  retired: readonly MeshSceneRecord[],
  retained: readonly MeshSceneRecord[]
): string[] {
  const retainedAssets = new Set(retained.flatMap((scene) => [...assetsInScene(scene)]))
  const retiredAssets = new Set(retired.flatMap((scene) => [...assetsInScene(scene)]))
  return [...retiredAssets].filter((asset) => !retainedAssets.has(asset))
}

function orphanedTopologies(
  retired: readonly MeshSceneRecord[],
  retained: readonly MeshSceneRecord[]
): string[] {
  const retainedTopologies = new Set(retained.flatMap((scene) => [...topologiesInScene(scene)]))
  const retiredTopologies = new Set(retired.flatMap((scene) => [...topologiesInScene(scene)]))
  return [...retiredTopologies].filter((topology) => !retainedTopologies.has(topology))
}

export interface MeshSceneUpsertResult {
  scene: MeshSceneRecord
  orphanedAssetIds: string[]
  orphanedTopologyIds: string[]
}

export interface MeshSceneRemoveResult {
  removed: MeshSceneRecord | null
  orphanedAssetIds: string[]
  orphanedTopologyIds: string[]
}

/** Small atomic JSON store isolated from the shared AppStore. */
export class MeshSceneStore {
  private readonly scenesPath: string

  constructor(private readonly baseDir: string) {
    this.scenesPath = path.join(baseDir, SCENES_FILE)
  }

  private ensureRoot(): void {
    fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 })
    const stat = fs.lstatSync(this.baseDir)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Mesh scene store path is not a safe directory.')
    }
  }

  private readAll(): MeshSceneRecord[] {
    try {
      this.ensureRoot()
      const stat = fs.lstatSync(this.scenesPath)
      if (stat.isSymbolicLink() || !stat.isFile()) return []
      const parsed = JSON.parse(fs.readFileSync(this.scenesPath, 'utf8'))
      if (!Array.isArray(parsed)) return []
      return parsed.map(normalizeScene).filter((scene): scene is MeshSceneRecord => scene !== null)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      return []
    }
  }

  private writeAll(scenes: readonly MeshSceneRecord[]): void {
    this.ensureRoot()
    const tempPath = path.join(this.baseDir, `.${SCENES_FILE}.${process.pid}.${Date.now()}.tmp`)
    try {
      fs.writeFileSync(tempPath, JSON.stringify(scenes), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      })
      fs.renameSync(tempPath, this.scenesPath)
    } finally {
      try {
        fs.rmSync(tempPath, { force: true })
      } catch {
        // Temp cleanup is best effort after a successful rename.
      }
    }
  }

  list(): MeshSceneRecord[] {
    return this.readAll().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  get(sceneId: string): MeshSceneRecord | null {
    return this.list().find((scene) => scene.id === sceneId) ?? null
  }

  upsert(scene: MeshSceneRecord): MeshSceneUpsertResult {
    const normalized = normalizeScene(scene)
    if (!normalized) throw new Error('Mesh scene record is invalid.')
    const existing = this.list()
    const replaced = existing.filter((entry) => entry.id === normalized.id)
    const retainedExisting = existing.filter((entry) => entry.id !== normalized.id)
    const next = [normalized, ...retainedExisting].slice(0, MAX_SCENES)
    const evicted = retainedExisting.slice(Math.max(0, MAX_SCENES - 1))
    this.writeAll(next)
    return {
      scene: normalized,
      orphanedAssetIds: orphanedAssets([...replaced, ...evicted], next),
      orphanedTopologyIds: orphanedTopologies([...replaced, ...evicted], next)
    }
  }

  remove(sceneId: string): MeshSceneRemoveResult {
    const scenes = this.list()
    const removed = scenes.find((scene) => scene.id === sceneId) ?? null
    if (!removed) return { removed: null, orphanedAssetIds: [], orphanedTopologyIds: [] }
    const retained = scenes.filter((scene) => scene.id !== sceneId)
    this.writeAll(retained)
    return {
      removed,
      orphanedAssetIds: orphanedAssets([removed], retained),
      orphanedTopologyIds: orphanedTopologies([removed], retained)
    }
  }

  purgeAuthorities(input: { chatIds?: Iterable<string>; workspacePaths?: Iterable<string> }): {
    assetIds: string[]
    topologyIds: string[]
  } {
    const chatIds = new Set([...(input.chatIds ?? [])].map((value) => value.trim()).filter(Boolean))
    const workspacePaths = new Set(
      [...(input.workspacePaths ?? [])]
        .map((value) => value.trim())
        .filter(Boolean)
        .map(canonicalWorkspacePath)
    )
    if (!chatIds.size && !workspacePaths.size) return { assetIds: [], topologyIds: [] }
    const scenes = this.list()
    const removed = scenes.filter(
      (scene) =>
        Boolean(!scene.workspacePath && scene.chatId && chatIds.has(scene.chatId)) ||
        Boolean(
          scene.workspacePath && workspacePaths.has(canonicalWorkspacePath(scene.workspacePath))
        )
    )
    if (!removed.length) return { assetIds: [], topologyIds: [] }
    const retained = scenes.filter((scene) => !removed.includes(scene))
    this.writeAll(retained)
    return {
      assetIds: orphanedAssets(removed, retained),
      topologyIds: orphanedTopologies(removed, retained)
    }
  }

  clearAll(): { assetIds: string[]; topologyIds: string[] } {
    const assets = new Set(this.list().flatMap((scene) => [...assetsInScene(scene)]))
    const topologies = new Set(this.list().flatMap((scene) => [...topologiesInScene(scene)]))
    this.writeAll([])
    return { assetIds: [...assets], topologyIds: [...topologies] }
  }
}
