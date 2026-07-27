/** Durable, chat-owned Mesh Canvas scene records. */
import * as fs from 'fs'
import * as path from 'path'
import {
  MESH_SCENE_SCHEMA_VERSION,
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

const SCENES_FILE = 'mesh-scenes.json'
const MAX_SCENES = 200

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
    ...(typeof raw.metallic !== 'undefined'
      ? { metallic: asFinite(raw.metallic, 0, 0, 1) }
      : {}),
    ...(typeof raw.roughness !== 'undefined'
      ? { roughness: asFinite(raw.roughness, 0.7, 0, 1) }
      : {}),
    ...(typeof raw.opacity !== 'undefined' ? { opacity: asFinite(raw.opacity, 1, 0, 1) } : {}),
    ...(asColor(raw.emissive) ? { emissive: asColor(raw.emissive) } : {}),
    ...(textureAssetId && /^[a-zA-Z0-9_-]{16,128}$/.test(textureAssetId)
      ? { textureAssetId }
      : {}),
    ...(typeof raw.doubleSided === 'boolean' ? { doubleSided: raw.doubleSided } : {})
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
    value.schemaVersion !== MESH_SCENE_SCHEMA_VERSION ||
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
  if (nodes.length !== rawNodes.length || nodes.length > 500) return null
  const rawLighting = isRecord(value.lighting) ? value.lighting : {}
  const rawCamera = isRecord(value.camera) ? value.camera : {}
  const defaults = cloneDefaultCamera()
  const presentation = isRecord(value.presentation) && asString(value.presentation.presentedAt, 128)
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
  return {
    schemaVersion: MESH_SCENE_SCHEMA_VERSION,
    id,
    ...(asString(value.chatId, 256) ? { chatId: asString(value.chatId, 256)! } : {}),
    ...(asString(value.runId, 256) ? { runId: asString(value.runId, 256)! } : {}),
    ...(asString(value.workspacePath, 4_096) ? { workspacePath: asString(value.workspacePath, 4_096)! } : {}),
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
    createdAt,
    updatedAt,
    ...(presentation ? { presentation } : {})
  }
}

function assetsInScene(scene: MeshSceneRecord): Set<string> {
  const assets = new Set<string>()
  for (const node of scene.nodes) {
    if (node.kind === 'import') assets.add(node.assetId)
    if (node.kind === 'primitive' && node.material.textureAssetId) {
      assets.add(node.material.textureAssetId)
    }
  }
  return assets
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
      fs.writeFileSync(tempPath, JSON.stringify(scenes), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
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

  upsert(scene: MeshSceneRecord): MeshSceneRecord {
    const normalized = normalizeScene(scene)
    if (!normalized) throw new Error('Mesh scene record is invalid.')
    const next = [normalized, ...this.list().filter((existing) => existing.id !== normalized.id)].slice(
      0,
      MAX_SCENES
    )
    this.writeAll(next)
    return normalized
  }

  purgeAuthorities(input: { chatIds?: Iterable<string>; workspacePaths?: Iterable<string> }): string[] {
    const chatIds = new Set([...(input.chatIds ?? [])].map((value) => value.trim()).filter(Boolean))
    const workspacePaths = new Set(
      [...(input.workspacePaths ?? [])].map((value) => value.trim()).filter(Boolean)
    )
    if (!chatIds.size && !workspacePaths.size) return []
    const scenes = this.list()
    const removed = scenes.filter(
      (scene) =>
        Boolean(scene.chatId && chatIds.has(scene.chatId)) ||
        Boolean(scene.workspacePath && workspacePaths.has(scene.workspacePath))
    )
    if (!removed.length) return []
    const retained = scenes.filter((scene) => !removed.includes(scene))
    const retainedAssets = new Set(retained.flatMap((scene) => [...assetsInScene(scene)]))
    const assets = new Set(removed.flatMap((scene) => [...assetsInScene(scene)]))
    this.writeAll(retained)
    return [...assets].filter((asset) => !retainedAssets.has(asset))
  }

  clearAll(): string[] {
    const assets = new Set(this.list().flatMap((scene) => [...assetsInScene(scene)]))
    this.writeAll([])
    return [...assets]
  }
}
