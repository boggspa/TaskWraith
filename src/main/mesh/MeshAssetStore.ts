/**
 * Content-addressed-ish private vault for Mesh Canvas imports.
 *
 * Unlike transcript media, a mesh import is a small bundle: an OBJ can point at
 * an MTL which in turn points at several texture files; a JSON glTF can point at
 * buffers and images.  This store copies only the declared local dependencies
 * into a private, token-gated directory, so the viewer never receives an
 * arbitrary filesystem path or a file:// capability.
 */
import * as fs from 'fs'
import * as path from 'path'
import { randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import {
  MESH_MAX_IMPORT_BUNDLE_BYTES,
  isSafeMeshAssetRelativePath,
  meshImportFormatFromPath,
  type MeshAssetManifest,
  type MeshImportFormat
} from '../../shared/meshScene'
import {
  meshGltfReferences,
  meshMtlTextureReferences,
  meshObjMtlReferences
} from './MeshModelDependencies'
import { resolveMeshScenePackage } from './MeshScenePackageResolver'

const ASSET_ID_RE = /^[a-zA-Z0-9_-]{16,128}$/
// Covers the entry file plus every copied dependency. A per-file cap alone
// would allow a glTF/OBJ with many individually-valid textures to fill the
// private vault without a bounded import cost.
const MANIFEST_FILE = 'manifest.json'

export interface MeshAssetFile {
  assetId: string
  accessToken: string
  relativePath: string
  filePath: string
  mimeType: string
  byteLength: number
}

export interface ImportedMeshAsset {
  manifest: MeshAssetManifest
}

export interface ImportedMeshScenePackage {
  manifest: MeshAssetManifest
  title?: string
  roots: ReturnType<typeof resolveMeshScenePackage>['roots']
}

export interface MeshAssetStoreDeps {
  uuid?: () => string
  now?: () => string
}

function safeId(value: string): boolean {
  return ASSET_ID_RE.test(value)
}

function strictSourceFile(sourcePath: string): { realPath: string; stat: fs.Stats } {
  const lstat = fs.lstatSync(sourcePath)
  if (lstat.isSymbolicLink() || !lstat.isFile()) {
    throw new Error('Mesh import source must be a regular file.')
  }
  const realPath = fs.realpathSync(sourcePath)
  const stat = fs.statSync(realPath)
  if (!stat.isFile() || stat.size > MESH_MAX_IMPORT_BUNDLE_BYTES) {
    throw new Error(
      `Mesh import source must be a regular file under ${MESH_MAX_IMPORT_BUNDLE_BYTES / 1024 / 1024} MiB.`
    )
  }
  return { realPath, stat }
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    Boolean(relative) &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  )
}

function meshMimeForPath(relativePath: string): string {
  const ext = path.extname(relativePath).toLowerCase()
  switch (ext) {
    case '.glb':
      return 'model/gltf-binary'
    case '.gltf':
      return 'model/gltf+json'
    case '.obj':
      return 'model/obj'
    case '.mtl':
      return 'text/plain; charset=utf-8'
    case '.bin':
      return 'application/octet-stream'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    case '.bmp':
      return 'image/bmp'
    case '.ktx2':
      return 'image/ktx2'
    default:
      return 'application/octet-stream'
  }
}

function isSupportedTexturePath(sourcePath: string): boolean {
  return ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(
    path.extname(sourcePath).toLowerCase()
  )
}

function normalizeManifest(value: unknown): MeshAssetManifest | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<MeshAssetManifest>
  if (
    raw.schemaVersion !== 1 ||
    typeof raw.id !== 'string' ||
    !safeId(raw.id) ||
    typeof raw.accessToken !== 'string' ||
    !/^[a-f0-9]{32,128}$/i.test(raw.accessToken) ||
    (raw.kind !== 'model' && raw.kind !== 'texture') ||
    typeof raw.entryPath !== 'string' ||
    !isSafeMeshAssetRelativePath(raw.entryPath) ||
    !Array.isArray(raw.files) ||
    !raw.files.every(isSafeMeshAssetRelativePath) ||
    typeof raw.byteLength !== 'number' ||
    !Number.isFinite(raw.byteLength) ||
    raw.byteLength < 0 ||
    typeof raw.createdAt !== 'string'
  ) {
    return null
  }
  const format = raw.format
  if (format !== undefined && format !== 'glb' && format !== 'gltf' && format !== 'obj') return null
  if (raw.kind === 'model' && !format) return null
  return {
    schemaVersion: 1,
    id: raw.id,
    accessToken: raw.accessToken,
    kind: raw.kind,
    ...(format ? { format } : {}),
    entryPath: raw.entryPath,
    files: [...new Set(raw.files)],
    byteLength: Math.floor(raw.byteLength),
    createdAt: raw.createdAt
  }
}

/**
 * Main-process private asset vault.  Every imported asset gets a random id and
 * token. The id identifies a scene dependency; the token is supplied only in
 * renderer-safe `twmesh://` URLs and never in MCP tool output.
 */
export class MeshAssetStore {
  private readonly uuid: () => string
  private readonly now: () => string

  constructor(
    private readonly baseDir: string,
    deps: MeshAssetStoreDeps = {}
  ) {
    this.uuid = deps.uuid ?? randomUUID
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  private ensureRoot(): void {
    fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 })
    const stat = fs.lstatSync(this.baseDir)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Mesh asset vault path is not a safe directory.')
    }
  }

  private assetDirectory(assetId: string): string {
    if (!safeId(assetId)) throw new Error('Invalid mesh asset id.')
    return path.join(this.baseDir, assetId)
  }

  private readManifest(assetId: string): MeshAssetManifest | null {
    try {
      const dir = this.assetDirectory(assetId)
      const stat = fs.lstatSync(dir)
      if (stat.isSymbolicLink() || !stat.isDirectory()) return null
      const raw = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8'))
      return normalizeManifest(raw)
    } catch {
      return null
    }
  }

  get(assetId: string): MeshAssetManifest | null {
    return this.readManifest(assetId)
  }

  importModel(sourcePath: string): ImportedMeshAsset {
    const format = meshImportFormatFromPath(sourcePath)
    if (!format) throw new Error('Mesh Canvas currently imports .glb, .gltf, and .obj files.')
    return { manifest: this.importBundle(sourcePath, 'model', format) }
  }

  /**
   * Import a complete exporter-produced package as one private vault bundle.
   * The resolver has already verified every source file is local, regular,
   * beneath the selected directory, and explicitly declared by the manifest.
   */
  importScenePackage(manifestPath: string): ImportedMeshScenePackage {
    this.ensureRoot()
    const scenePackage = resolveMeshScenePackage(manifestPath)
    const firstRoot = scenePackage.roots[0]
    if (!firstRoot) throw new Error('Scene package has no importable roots.')
    const assetId = this.uuid().replace(/[^a-zA-Z0-9_-]/g, '')
    if (!safeId(assetId)) throw new Error('Mesh asset id generator returned an invalid id.')
    const tempDir = path.join(this.baseDir, `.${assetId}-${randomBytes(8).toString('hex')}.tmp`)
    const finalDir = this.assetDirectory(assetId)
    try {
      fs.mkdirSync(tempDir, { mode: 0o700 })
      let byteLength = 0
      for (const file of scenePackage.files) {
        const destination = path.join(tempDir, ...file.relativePath.split('/'))
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
        fs.copyFileSync(file.sourcePath, destination, fs.constants.COPYFILE_EXCL)
        byteLength += file.byteLength
      }
      const manifest: MeshAssetManifest = {
        schemaVersion: 1,
        id: assetId,
        accessToken: randomBytes(32).toString('hex'),
        kind: 'model',
        format: firstRoot.format,
        entryPath: firstRoot.path,
        files: scenePackage.files.map((file) => file.relativePath).sort(),
        byteLength,
        createdAt: this.now()
      }
      fs.writeFileSync(path.join(tempDir, MANIFEST_FILE), JSON.stringify(manifest), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      })
      fs.renameSync(tempDir, finalDir)
      return {
        manifest,
        ...(scenePackage.title ? { title: scenePackage.title } : {}),
        roots: scenePackage.roots
      }
    } catch (error) {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 2 })
      throw error
    }
  }

  importTexture(sourcePath: string): ImportedMeshAsset {
    if (!isSupportedTexturePath(sourcePath)) {
      throw new Error('Texture imports support PNG, JPEG, WebP, GIF, and BMP files.')
    }
    return { manifest: this.importBundle(sourcePath, 'texture') }
  }

  private importBundle(
    sourcePath: string,
    kind: 'model' | 'texture',
    format?: MeshImportFormat
  ): MeshAssetManifest {
    this.ensureRoot()
    const source = strictSourceFile(sourcePath)
    const sourceDir = path.dirname(source.realPath)
    const sourceDirReal = fs.realpathSync(sourceDir)
    const entryPath = path.basename(source.realPath)
    if (!isSafeMeshAssetRelativePath(entryPath))
      throw new Error('Mesh import file name is not safe.')

    const assetId = this.uuid().replace(/[^a-zA-Z0-9_-]/g, '')
    if (!safeId(assetId)) throw new Error('Mesh asset id generator returned an invalid id.')
    const tempDir = path.join(this.baseDir, `.${assetId}-${randomBytes(8).toString('hex')}.tmp`)
    const finalDir = this.assetDirectory(assetId)
    const files = new Set<string>()
    let byteLength = 0

    const copyRelative = (relativePath: string): void => {
      if (!isSafeMeshAssetRelativePath(relativePath) || files.has(relativePath)) return
      const candidate = path.resolve(sourceDirReal, ...relativePath.split('/'))
      if (!pathInside(sourceDirReal, candidate)) return
      let dependency: { realPath: string; stat: fs.Stats }
      try {
        dependency = strictSourceFile(candidate)
      } catch {
        return
      }
      if (!pathInside(sourceDirReal, dependency.realPath)) return
      if (byteLength + dependency.stat.size > MESH_MAX_IMPORT_BUNDLE_BYTES) {
        throw new Error(
          `Mesh import bundle exceeds ${MESH_MAX_IMPORT_BUNDLE_BYTES / 1024 / 1024} MiB including dependencies.`
        )
      }
      const destination = path.join(tempDir, ...relativePath.split('/'))
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
      fs.copyFileSync(dependency.realPath, destination, fs.constants.COPYFILE_EXCL)
      files.add(relativePath)
      byteLength += dependency.stat.size
    }

    try {
      fs.mkdirSync(tempDir, { mode: 0o700 })
      fs.copyFileSync(source.realPath, path.join(tempDir, entryPath), fs.constants.COPYFILE_EXCL)
      files.add(entryPath)
      byteLength += source.stat.size

      if (kind === 'model' && format === 'obj') {
        const obj = fs.readFileSync(source.realPath, 'utf8')
        for (const mtlPath of meshObjMtlReferences(obj)) {
          copyRelative(mtlPath)
          const copiedMtl = path.join(tempDir, ...mtlPath.split('/'))
          if (!fs.existsSync(copiedMtl)) continue
          const mtl = fs.readFileSync(copiedMtl, 'utf8')
          for (const texturePath of meshMtlTextureReferences(mtl)) copyRelative(texturePath)
        }
      } else if (kind === 'model' && format === 'gltf') {
        const gltf = fs.readFileSync(source.realPath, 'utf8')
        for (const dependencyPath of meshGltfReferences(gltf)) copyRelative(dependencyPath)
      }

      const manifest: MeshAssetManifest = {
        schemaVersion: 1,
        id: assetId,
        accessToken: randomBytes(32).toString('hex'),
        kind,
        ...(format ? { format } : {}),
        entryPath,
        files: [...files].sort(),
        byteLength,
        createdAt: this.now()
      }
      fs.writeFileSync(path.join(tempDir, MANIFEST_FILE), JSON.stringify(manifest), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      })
      fs.renameSync(tempDir, finalDir)
      return manifest
    } catch (error) {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 2 })
      throw error
    }
  }

  resolveAssetFile(input: {
    assetId: string
    accessToken: string
    relativePath: string
  }): MeshAssetFile | null {
    if (!safeId(input.assetId) || !isSafeMeshAssetRelativePath(input.relativePath)) return null
    const manifest = this.readManifest(input.assetId)
    if (!manifest || !manifest.files.includes(input.relativePath)) return null
    const expected = Buffer.from(manifest.accessToken, 'utf8')
    const actual = Buffer.from(input.accessToken, 'utf8')
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
    const dir = this.assetDirectory(input.assetId)
    const candidate = path.join(dir, ...input.relativePath.split('/'))
    try {
      const before = fs.lstatSync(candidate)
      if (before.isSymbolicLink() || !before.isFile()) return null
      const realDir = fs.realpathSync(dir)
      const realFile = fs.realpathSync(candidate)
      if (!pathInside(realDir, realFile)) return null
      const after = fs.statSync(realFile)
      if (!after.isFile() || after.size !== before.size) return null
      return {
        assetId: input.assetId,
        accessToken: input.accessToken,
        relativePath: input.relativePath,
        filePath: realFile,
        mimeType: meshMimeForPath(input.relativePath),
        byteLength: after.size
      }
    } catch {
      return null
    }
  }

  remove(assetIds: Iterable<string>): void {
    this.ensureRoot()
    for (const assetId of new Set(assetIds)) {
      if (!safeId(assetId)) continue
      const directory = this.assetDirectory(assetId)
      try {
        const stat = fs.lstatSync(directory)
        if (stat.isSymbolicLink() || !stat.isDirectory()) continue
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 2 })
      } catch {
        // A missing / already-purged asset is the desired end state.
      }
    }
  }

  clearAll(): void {
    try {
      this.ensureRoot()
      const names = fs.readdirSync(this.baseDir)
      this.remove(names.filter(safeId))
    } catch {
      // The matching scene store clear is the durable authority. If the asset
      // directory is unavailable, leave no broadened cleanup target behind.
    }
  }
}

export { meshMimeForPath }
