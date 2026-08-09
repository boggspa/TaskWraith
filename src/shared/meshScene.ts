/**
 * Shared, node-free contracts for TaskWraith Mesh Canvas.
 *
 * The renderer consumes these records directly while the main process owns
 * persistence, import validation, asset serving, and audit.  Keeping the
 * model declarative means agents describe a scene instead of injecting scripts
 * into a graphics surface.
 */

import type { MeshTopologyDocument, MeshTopologySource, MeshTopologySummary } from './meshTopology'

export const MESH_SCENE_SCHEMA_VERSION = 2 as const
export const MESH_SCENE_LEGACY_SCHEMA_VERSION = 1 as const
/** Bound durable scene complexity before an import can allocate a private asset bundle. */
export const MESH_MAX_SCENE_NODES = 500
/** Maximum total bytes copied for one imported model or scene package. */
export const MESH_MAX_IMPORT_BUNDLE_BYTES = 512 * 1024 * 1024
/** Bound reactive object-information sources attached to one durable scene. */
export const MESH_MAX_SCENE_OBJECT_DATA_SOURCES = 200
/** One property has at most one incoming edge; this bounds graph evaluation cost. */
export const MESH_MAX_SCENE_DEPENDENCY_BINDINGS = 1_000

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

export interface MeshEditableNode {
  id: string
  kind: 'editable'
  name: string
  topologyId: string
  topologyRevision: number
  topologySummary: MeshTopologySummary
  /** Original primitive/import provenance; conversion never overwrites it. */
  source: Exclude<MeshTopologySource, { kind: 'generated' }>
  transform: MeshTransform
  material: MeshPbrMaterial
  visible: boolean
}

export type MeshSceneNode = MeshPrimitiveNode | MeshImportedNode | MeshEditableNode

/**
 * The small, typed property vocabulary available to the reactive scene graph.
 * No expressions or code cross this boundary: object information is mapped to
 * a known field, and numeric fields may apply only scale + offset.
 */
export const MESH_SCENE_DEPENDENCY_PROPERTIES = [
  'transform.position.x',
  'transform.position.y',
  'transform.position.z',
  'transform.rotation.x',
  'transform.rotation.y',
  'transform.rotation.z',
  'transform.scale.x',
  'transform.scale.y',
  'transform.scale.z',
  'visible',
  'material.baseColor',
  'material.metallic',
  'material.roughness',
  'material.opacity',
  'material.emissive',
  'material.doubleSided'
] as const

export type MeshSceneDependencyProperty = (typeof MESH_SCENE_DEPENDENCY_PROPERTIES)[number]
export type MeshSceneObjectDataValue = string | number | boolean

/** A provider-neutral fact source, updated through a typed scene mutation. */
export interface MeshSceneObjectDataSource {
  id: string
  values: Record<string, MeshSceneObjectDataValue>
  updatedAt: string
}

export type MeshSceneDependencySource =
  | { kind: 'object_data'; sourceId: string; key: string }
  | { kind: 'node_property'; nodeId: string; property: MeshSceneDependencyProperty }

export interface MeshSceneDependencyBinding {
  id: string
  targetNodeId: string
  targetProperty: MeshSceneDependencyProperty
  source: MeshSceneDependencySource
  /** Optional affine mapping for numeric fields only: `value * scale + offset`. */
  numericTransform?: { scale: number; offset: number }
  createdAt: string
}

/** Durable, declarative graph evaluated by main after every scene mutation. */
export interface MeshSceneDependencyGraph {
  sources: MeshSceneObjectDataSource[]
  bindings: MeshSceneDependencyBinding[]
}

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

/**
 * Durable scene record. Workspace scenes are recallable by every thread in the
 * same canonical workspace; records without a workspace remain chat-scoped.
 * Imported source paths are never stored here.
 */
export interface MeshSceneRecord {
  schemaVersion: typeof MESH_SCENE_SCHEMA_VERSION
  id: string
  /** Monotonic scene metadata revision; editable geometry has its own CAS revision. */
  revision: number
  /** Originating chat attribution. This is the authority only for global scenes. */
  chatId?: string
  runId?: string
  workspacePath?: string
  title: string
  backgroundColor: string
  lighting: MeshSceneLighting
  camera: MeshSceneCamera
  nodes: MeshSceneNode[]
  dependencies: MeshSceneDependencyGraph
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
  editableCount: number
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
export type MeshSceneView = Omit<MeshSceneRecord, 'workspacePath' | 'dependencies'> & {
  /** Default vault URL by asset id, used for explicitly assigned texture assets. */
  assetUrls: Record<string, string>
  /** Import-node-specific entry URLs, allowing a scene package to share one vault bundle across roots. */
  modelUrls: Record<string, string>
  /** Main-owned topology documents required by editable renderer nodes. */
  topologies: Record<string, MeshTopologyDocument>
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

export function isMeshSceneDependencyProperty(
  value: unknown
): value is MeshSceneDependencyProperty {
  return (
    typeof value === 'string' &&
    (MESH_SCENE_DEPENDENCY_PROPERTIES as readonly string[]).includes(value)
  )
}

export function meshSceneSummary(scene: MeshSceneRecord): MeshSceneSummary {
  const imports = scene.nodes.filter((node) => node.kind === 'import').length
  const primitives = scene.nodes.filter((node) => node.kind === 'primitive').length
  const editable = scene.nodes.filter((node) => node.kind === 'editable').length
  return {
    sceneId: scene.id,
    title: scene.title,
    nodeCount: scene.nodes.length,
    importCount: imports,
    primitiveCount: primitives,
    editableCount: editable,
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
      // eslint-disable-next-line no-control-regex -- rejecting control bytes is exactly the check.
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

export function createEmptyMeshSceneDependencyGraph(): MeshSceneDependencyGraph {
  return { sources: [], bindings: [] }
}
