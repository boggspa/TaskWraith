/**
 * Declarative, DCC-neutral package contract for importing complete exported
 * Mesh Canvas scenes. The manifest is data only: adapters may produce it, but
 * importing it never runs a project script, plugin, or editor binary.
 */
import {
  isSafeMeshAssetRelativePath,
  meshImportFormatFromPath,
  type MeshImportFormat
} from './meshScene'

export const MESH_SCENE_PACKAGE_SCHEMA_VERSION = 1 as const
export const MESH_SCENE_PACKAGE_KIND = 'taskwraith.mesh-scene-package' as const
/** Exact manifest name used when a human selects a scene-package directory. */
export const MESH_SCENE_PACKAGE_MANIFEST_FILE = 'taskwraith.mesh-scene.json' as const
export const MESH_MAX_SCENE_PACKAGE_ROOTS = 100
export const MESH_MAX_SCENE_PACKAGE_FILES = 1_000

export interface MeshScenePackageRoot {
  /** POSIX-relative path within the selected package directory. */
  path: string
  /** Optional human-facing label for the imported scene root. */
  name?: string
  format: MeshImportFormat
}

/**
 * An exporter-produced allowlist. The importer copies only `files` and then
 * verifies that every model dependency is both local and declared here.
 */
export interface MeshScenePackageManifest {
  schemaVersion: typeof MESH_SCENE_PACKAGE_SCHEMA_VERSION
  kind: typeof MESH_SCENE_PACKAGE_KIND
  title?: string
  roots: MeshScenePackageRoot[]
  files: string[]
}

export class MeshScenePackageManifestError extends Error {
  override readonly name = 'MeshScenePackageManifestError'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function optionalLabel(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new MeshScenePackageManifestError(`${field} must be a string when provided.`)
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 200) {
    throw new MeshScenePackageManifestError(`${field} must be between 1 and 200 characters.`)
  }
  return trimmed
}

function relativePath(value: unknown, field: string): string {
  if (!isSafeMeshAssetRelativePath(value)) {
    throw new MeshScenePackageManifestError(`${field} must be a safe relative package path.`)
  }
  return value
}

function packageRoot(value: unknown, index: number): MeshScenePackageRoot {
  if (!isRecord(value)) {
    throw new MeshScenePackageManifestError(`roots[${index}] must be an object.`)
  }
  const entryPath = relativePath(value.path, `roots[${index}].path`)
  const format = meshImportFormatFromPath(entryPath)
  if (!format) {
    throw new MeshScenePackageManifestError(
      `roots[${index}].path must reference a .glb, .gltf, or .obj scene root.`
    )
  }
  const name = optionalLabel(value.name, `roots[${index}].name`)
  return { path: entryPath, ...(name ? { name } : {}), format }
}

/**
 * Validate untrusted JSON before Electron main resolves any filesystem path.
 * Unknown extension fields are deliberately ignored so exporters can retain
 * their own metadata without expanding the importer's authority.
 */
export function parseMeshScenePackageManifest(value: unknown): MeshScenePackageManifest {
  if (!isRecord(value))
    throw new MeshScenePackageManifestError('Scene package manifest must be an object.')
  if (value.schemaVersion !== MESH_SCENE_PACKAGE_SCHEMA_VERSION) {
    throw new MeshScenePackageManifestError(
      `Scene package schemaVersion must be ${MESH_SCENE_PACKAGE_SCHEMA_VERSION}.`
    )
  }
  if (value.kind !== MESH_SCENE_PACKAGE_KIND) {
    throw new MeshScenePackageManifestError(
      `Scene package kind must be “${MESH_SCENE_PACKAGE_KIND}”.`
    )
  }
  if (
    !Array.isArray(value.roots) ||
    !value.roots.length ||
    value.roots.length > MESH_MAX_SCENE_PACKAGE_ROOTS
  ) {
    throw new MeshScenePackageManifestError(
      `Scene package must declare between 1 and ${MESH_MAX_SCENE_PACKAGE_ROOTS} roots.`
    )
  }
  if (
    !Array.isArray(value.files) ||
    !value.files.length ||
    value.files.length > MESH_MAX_SCENE_PACKAGE_FILES
  ) {
    throw new MeshScenePackageManifestError(
      `Scene package must declare between 1 and ${MESH_MAX_SCENE_PACKAGE_FILES} files.`
    )
  }

  const roots = value.roots.map(packageRoot)
  const files = value.files.map((file, index) => relativePath(file, `files[${index}]`))
  if (new Set(files).size !== files.length) {
    throw new MeshScenePackageManifestError('Scene package files must not contain duplicates.')
  }
  if (new Set(roots.map((root) => root.path)).size !== roots.length) {
    throw new MeshScenePackageManifestError('Scene package roots must not contain duplicates.')
  }
  const declaredFiles = new Set(files)
  for (const root of roots) {
    if (!declaredFiles.has(root.path)) {
      throw new MeshScenePackageManifestError(
        `Scene package root “${root.path}” must also appear in files.`
      )
    }
  }

  const title = optionalLabel(value.title, 'title')
  return {
    schemaVersion: MESH_SCENE_PACKAGE_SCHEMA_VERSION,
    kind: MESH_SCENE_PACKAGE_KIND,
    ...(title ? { title } : {}),
    roots,
    files
  }
}

export function isMeshScenePackageManifestFileName(value: string): boolean {
  return value.split(/[\\/]/).at(-1)?.toLowerCase() === MESH_SCENE_PACKAGE_MANIFEST_FILE
}
