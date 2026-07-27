/**
 * Electron-main resolver for declarative scene-package manifests. It resolves
 * only local, declared, regular files beneath the selected package directory;
 * no DCC project, script, plugin, or executable is opened while importing.
 */
import * as fs from 'fs'
import * as path from 'path'
import { MESH_MAX_IMPORT_BUNDLE_BYTES, isSafeMeshAssetRelativePath } from '../../shared/meshScene'
import {
  isMeshScenePackageManifestFileName,
  parseMeshScenePackageManifest,
  type MeshScenePackageManifest,
  type MeshScenePackageRoot
} from '../../shared/meshScenePackage'
import {
  meshGltfReferences,
  meshMtlTextureReferences,
  meshObjMtlReferences
} from './MeshModelDependencies'

const MAX_MESH_SCENE_PACKAGE_MANIFEST_BYTES = 1024 * 1024

export interface ResolvedMeshScenePackageFile {
  /** Safe POSIX-relative package path; this becomes a vault-local path. */
  relativePath: string
  /** Electron-main-only source path. Never project this value to a renderer or agent. */
  sourcePath: string
  byteLength: number
}

export interface ResolvedMeshScenePackage {
  title?: string
  roots: readonly MeshScenePackageRoot[]
  files: readonly ResolvedMeshScenePackageFile[]
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

function regularFile(sourcePath: string, message: string): { realPath: string; stat: fs.Stats } {
  try {
    const before = fs.lstatSync(sourcePath)
    if (before.isSymbolicLink() || !before.isFile()) throw new Error(message)
    const realPath = fs.realpathSync(sourcePath)
    const stat = fs.statSync(realPath)
    if (!stat.isFile()) throw new Error(message)
    return { realPath, stat }
  } catch (error) {
    if (error instanceof Error && error.message === message) throw error
    throw new Error(message)
  }
}

function relativeReference(ownerPath: string, reference: string): string {
  const candidate = path.posix.normalize(path.posix.join(path.posix.dirname(ownerPath), reference))
  if (!isSafeMeshAssetRelativePath(candidate)) {
    throw new Error(`Scene package reference from “${ownerPath}” is not a safe local path.`)
  }
  return candidate
}

function requireDeclared(
  files: ReadonlyMap<string, ResolvedMeshScenePackageFile>,
  relativePath: string,
  ownerPath: string
): ResolvedMeshScenePackageFile {
  const file = files.get(relativePath)
  if (!file) {
    throw new Error(
      `Scene package dependency “${relativePath}” referenced by “${ownerPath}” must be declared in files.`
    )
  }
  return file
}

function verifyDeclaredModelDependencies(
  roots: readonly MeshScenePackageRoot[],
  files: ReadonlyMap<string, ResolvedMeshScenePackageFile>
): void {
  for (const root of roots) {
    const rootFile = requireDeclared(files, root.path, root.path)
    if (root.format === 'gltf') {
      const source = fs.readFileSync(rootFile.sourcePath, 'utf8')
      for (const dependency of meshGltfReferences(source, { rejectUnsafe: true })) {
        requireDeclared(files, relativeReference(root.path, dependency), root.path)
      }
      continue
    }
    if (root.format !== 'obj') continue

    const obj = fs.readFileSync(rootFile.sourcePath, 'utf8')
    for (const mtlReference of meshObjMtlReferences(obj, { rejectUnsafe: true })) {
      const mtlPath = relativeReference(root.path, mtlReference)
      const mtlFile = requireDeclared(files, mtlPath, root.path)
      const mtl = fs.readFileSync(mtlFile.sourcePath, 'utf8')
      for (const textureReference of meshMtlTextureReferences(mtl, { rejectUnsafe: true })) {
        requireDeclared(files, relativeReference(mtlPath, textureReference), mtlPath)
      }
    }
  }
}

/**
 * Resolve an exporter-produced package without copying it. The caller owns
 * copying the returned allowlisted files into a private vault transaction.
 */
export function resolveMeshScenePackage(manifestPath: string): ResolvedMeshScenePackage {
  if (!isMeshScenePackageManifestFileName(manifestPath)) {
    throw new Error('Scene package selection must be taskwraith.mesh-scene.json.')
  }
  const manifestFile = regularFile(
    manifestPath,
    'Scene package manifest must be a regular local file.'
  )
  if (manifestFile.stat.size > MAX_MESH_SCENE_PACKAGE_MANIFEST_BYTES) {
    throw new Error('Scene package manifest exceeds 1 MiB.')
  }
  const packageRoot = fs.realpathSync(path.dirname(manifestFile.realPath))
  const rootStat = fs.lstatSync(packageRoot)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('Scene package directory is not safe.')
  }

  let manifest: MeshScenePackageManifest
  try {
    manifest = parseMeshScenePackageManifest(
      JSON.parse(fs.readFileSync(manifestFile.realPath, 'utf8'))
    )
  } catch (error) {
    throw new Error(
      error instanceof Error ? `Invalid scene package: ${error.message}` : 'Invalid scene package.'
    )
  }

  let byteLength = 0
  const files = manifest.files.map((relativePath) => {
    const candidate = path.resolve(packageRoot, ...relativePath.split('/'))
    if (!pathInside(packageRoot, candidate)) {
      throw new Error(`Scene package file “${relativePath}” escapes its selected directory.`)
    }
    const resolved = regularFile(
      candidate,
      `Scene package file “${relativePath}” must be a regular file.`
    )
    if (!pathInside(packageRoot, resolved.realPath)) {
      throw new Error(`Scene package file “${relativePath}” escapes its selected directory.`)
    }
    byteLength += resolved.stat.size
    if (byteLength > MESH_MAX_IMPORT_BUNDLE_BYTES) {
      throw new Error(
        `Scene package exceeds ${MESH_MAX_IMPORT_BUNDLE_BYTES / 1024 / 1024} MiB including declared files.`
      )
    }
    return { relativePath, sourcePath: resolved.realPath, byteLength: resolved.stat.size }
  })
  verifyDeclaredModelDependencies(
    manifest.roots,
    new Map(files.map((file) => [file.relativePath, file]))
  )
  return { ...(manifest.title ? { title: manifest.title } : {}), roots: manifest.roots, files }
}
