/**
 * Shared, node-free contracts for TaskWraith Mesh Canvas.
 *
 * The renderer consumes these records directly while the main process owns
 * persistence, import validation, asset serving, and audit.  Keeping the
 * model declarative means agents describe a scene instead of injecting scripts
 * into a graphics surface.
 */

export const MESH_SCENE_SCHEMA_VERSION = 1 as const
/** Bound durable scene complexity before an import can allocate a private asset bundle. */
export const MESH_MAX_SCENE_NODES = 500

export const MESH_IMPORT_FORMATS = ['glb', 'gltf', 'obj'] as const
export type MeshImportFormat = (typeof MESH_IMPORT_FORMATS)[number]

export const MESH_PRIMITIVE_KINDS = ['box', 'sphere', 'plane', 'cylinder', 'torus'] as const
export type MeshPrimitiveKind = (typeof MESH_PRIMITIVE_KINDS)[number]

export interface MeshVector3 {
  x: number
  y: number
  z: number
}

export interface MeshTransform {
  position: MeshVector3
  /** Euler angles in degrees; converted to radians only inside the viewer. */
  rotation: MeshVector3
  scale: MeshVector3
}

/**
 * A deliberately small, DCC-neutral PBR material model.  Imported glTF/OBJ
 * materials remain intact; this describes only the overrides / primitives an
 * agent creates through the semantic MCP surface.
 */
export interface MeshPbrMaterial {
  baseColor?: string
  metallic?: number
  roughness?: number
  opacity?: number
  emissive?: string
  /** A user-owned texture copied into the mesh asset vault. */
  textureAssetId?: string
  doubleSided?: boolean
}

export interface MeshPrimitiveNode {
  id: string
  kind: 'primitive'
  primitive: MeshPrimitiveKind
  name: string
  transform: MeshTransform
  material: MeshPbrMaterial
  visible: boolean
}

export interface MeshImportedNode {
  id: string
  kind: 'import'
  name: string
  assetId: string
  format: MeshImportFormat
  /** Safe relative entry name in the mesh asset vault. */
  entryPath: string
  transform: MeshTransform
  /** Optional PBR override applied to imported mesh children by the viewer. */
  material?: MeshPbrMaterial
  visible: boolean
}

export type MeshSceneNode = MeshPrimitiveNode | MeshImportedNode

export interface MeshSceneLighting {
  environment: 'studio' | 'sunset' | 'neutral'
  intensity: number
}

export interface MeshSceneCamera {
  position: MeshVector3
  target: MeshVector3
  fieldOfView: number
}

export interface MeshScenePresentation {
  presentedAt: string
  presenter?: string
  title?: string
}

/** Durable, chat-owned scene record. Never contains a source filesystem path. */
export interface MeshSceneRecord {
  schemaVersion: typeof MESH_SCENE_SCHEMA_VERSION
  id: string
  chatId?: string
  runId?: string
  workspacePath?: string
  title: string
  backgroundColor: string
  lighting: MeshSceneLighting
  camera: MeshSceneCamera
  nodes: MeshSceneNode[]
  createdAt: string
  updatedAt: string
  presentation?: MeshScenePresentation
}

export interface MeshSceneSummary {
  sceneId: string
  title: string
  nodeCount: number
  importCount: number
  primitiveCount: number
  backgroundColor: string
  updatedAt: string
  presentedAt?: string
}

/**
 * Renderer-safe scene view; vault access tokens are short opaque capabilities.
 *
 * `workspacePath` is durable main-process history authority, not rendering
 * data. Keeping it out of this projection makes the renderer boundary unable
 * to accidentally become a workspace-path disclosure channel.
 */
export type MeshSceneView = Omit<MeshSceneRecord, 'workspacePath'> & {
  assetUrls: Record<string, string>
}

export interface MeshAssetManifest {
  schemaVersion: 1
  id: string
  accessToken: string
  kind: 'model' | 'texture'
  format?: MeshImportFormat
  entryPath: string
  files: string[]
  byteLength: number
  createdAt: string
}

export const MESH_DEFAULT_TRANSFORM: MeshTransform = Object.freeze({
  position: Object.freeze({ x: 0, y: 0, z: 0 }),
  rotation: Object.freeze({ x: 0, y: 0, z: 0 }),
  scale: Object.freeze({ x: 1, y: 1, z: 1 })
})

export const MESH_DEFAULT_CAMERA: MeshSceneCamera = Object.freeze({
  position: Object.freeze({ x: 4, y: 3, z: 5 }),
  target: Object.freeze({ x: 0, y: 0, z: 0 }),
  fieldOfView: 45
})

export const MESH_DEFAULT_LIGHTING: MeshSceneLighting = Object.freeze({
  environment: 'studio',
  intensity: 1
})

export function meshImportFormatFromPath(value: string): MeshImportFormat | null {
  const leaf = value.split(/[\\/]/).at(-1)?.toLowerCase() ?? ''
  if (leaf.endsWith('.glb')) return 'glb'
  if (leaf.endsWith('.gltf')) return 'gltf'
  if (leaf.endsWith('.obj')) return 'obj'
  return null
}

export function isMeshImportFormat(value: unknown): value is MeshImportFormat {
  return typeof value === 'string' && (MESH_IMPORT_FORMATS as readonly string[]).includes(value)
}

export function isMeshPrimitiveKind(value: unknown): value is MeshPrimitiveKind {
  return typeof value === 'string' && (MESH_PRIMITIVE_KINDS as readonly string[]).includes(value)
}

export function meshSceneSummary(scene: MeshSceneRecord): MeshSceneSummary {
  const imports = scene.nodes.filter((node) => node.kind === 'import').length
  return {
    sceneId: scene.id,
    title: scene.title,
    nodeCount: scene.nodes.length,
    importCount: imports,
    primitiveCount: scene.nodes.length - imports,
    backgroundColor: scene.backgroundColor,
    updatedAt: scene.updatedAt,
    ...(scene.presentation ? { presentedAt: scene.presentation.presentedAt } : {})
  }
}

/**
 * Reject traversal and platform-specific separators before a relative asset path
 * crosses the main/renderer boundary.  Vault entries always use POSIX slashes.
 */
export function isSafeMeshAssetRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 512) return false
  if (value.includes('\\') || value.startsWith('/') || value.includes('\0')) return false
  const segments = value.split('/')
  return segments.every(
    (segment) =>
      Boolean(segment) &&
      segment !== '.' &&
      segment !== '..' &&
      !segment.includes(':') &&
      !/[\x00-\x1f]/.test(segment)
  )
}

/** Build the opaque local URL the renderer gives Three's loader. */
export function meshAssetUrl(input: {
  assetId: string
  accessToken: string
  relativePath: string
}): string | null {
  if (!isSafeMeshAssetRelativePath(input.relativePath)) return null
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(input.assetId)) return null
  if (!/^[a-f0-9]{32,128}$/i.test(input.accessToken)) return null
  const encodedPath = input.relativePath.split('/').map(encodeURIComponent).join('/')
  return `twmesh://asset/${input.assetId}/${input.accessToken}/${encodedPath}`
}

export function cloneDefaultTransform(): MeshTransform {
  return {
    position: { ...MESH_DEFAULT_TRANSFORM.position },
    rotation: { ...MESH_DEFAULT_TRANSFORM.rotation },
    scale: { ...MESH_DEFAULT_TRANSFORM.scale }
  }
}

export function cloneDefaultCamera(): MeshSceneCamera {
  return {
    position: { ...MESH_DEFAULT_CAMERA.position },
    target: { ...MESH_DEFAULT_CAMERA.target },
    fieldOfView: MESH_DEFAULT_CAMERA.fieldOfView
  }
}

export function cloneDefaultLighting(): MeshSceneLighting {
  return { ...MESH_DEFAULT_LIGHTING }
}
