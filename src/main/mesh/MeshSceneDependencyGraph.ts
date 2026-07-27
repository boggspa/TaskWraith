/**
 * Typed, main-owned reactive graph for Mesh Canvas scene properties.
 *
 * A graph edge may read a provider-neutral object-data fact or another known
 * node property, then write one known node property. There is deliberately no
 * expression language, dynamic path traversal, or executable content here.
 */
import {
  MESH_MAX_SCENE_DEPENDENCY_BINDINGS,
  MESH_MAX_SCENE_OBJECT_DATA_SOURCES,
  createEmptyMeshSceneDependencyGraph,
  isMeshSceneDependencyProperty,
  type MeshPbrMaterial,
  type MeshSceneDependencyBinding,
  type MeshSceneDependencyGraph,
  type MeshSceneDependencyProperty,
  type MeshSceneDependencySource,
  type MeshSceneNode,
  type MeshSceneObjectDataSource,
  type MeshSceneObjectDataValue,
  type MeshSceneRecord
} from '../../shared/meshScene'

const GRAPH_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/
const MAX_OBJECT_DATA_VALUES = 128
const MAX_OBJECT_DATA_STRING_LENGTH = 512

const TRANSFORM_ADDRESS: Partial<
  Record<MeshSceneDependencyProperty, readonly ['position' | 'rotation' | 'scale', 'x' | 'y' | 'z']>
> = {
  'transform.position.x': ['position', 'x'],
  'transform.position.y': ['position', 'y'],
  'transform.position.z': ['position', 'z'],
  'transform.rotation.x': ['rotation', 'x'],
  'transform.rotation.y': ['rotation', 'y'],
  'transform.rotation.z': ['rotation', 'z'],
  'transform.scale.x': ['scale', 'x'],
  'transform.scale.y': ['scale', 'y'],
  'transform.scale.z': ['scale', 'z']
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && GRAPH_ID_RE.test(value)
}

function safeTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128
}

function isObjectDataValue(value: unknown): value is MeshSceneObjectDataValue {
  return (
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.length <= MAX_OBJECT_DATA_STRING_LENGTH)
  )
}

function normalizeObjectDataValues(value: unknown): Record<string, MeshSceneObjectDataValue> | null {
  if (!isRecord(value)) return null
  const entries = Object.entries(value)
  if (!entries.length || entries.length > MAX_OBJECT_DATA_VALUES) return null
  const result: Record<string, MeshSceneObjectDataValue> = {}
  for (const [key, entry] of entries) {
    if (!safeId(key) || !isObjectDataValue(entry)) return null
    result[key] = entry
  }
  return result
}

function cloneSource(source: MeshSceneDependencySource): MeshSceneDependencySource {
  return source.kind === 'object_data'
    ? { kind: 'object_data', sourceId: source.sourceId, key: source.key }
    : { kind: 'node_property', nodeId: source.nodeId, property: source.property }
}

function cloneBinding(binding: MeshSceneDependencyBinding): MeshSceneDependencyBinding {
  return {
    ...binding,
    source: cloneSource(binding.source),
    ...(binding.numericTransform ? { numericTransform: { ...binding.numericTransform } } : {})
  }
}

export function cloneMeshSceneDependencyGraph(
  graph: MeshSceneDependencyGraph | undefined
): MeshSceneDependencyGraph {
  if (!graph) return createEmptyMeshSceneDependencyGraph()
  return {
    sources: graph.sources.map((source) => ({ ...source, values: { ...source.values } })),
    bindings: graph.bindings.map(cloneBinding)
  }
}

function isNumericProperty(property: MeshSceneDependencyProperty): boolean {
  return Boolean(TRANSFORM_ADDRESS[property]) ||
    property === 'material.metallic' ||
    property === 'material.roughness' ||
    property === 'material.opacity'
}

function propertyKey(nodeId: string, property: MeshSceneDependencyProperty): string {
  return `${nodeId}\u0000${property}`
}

function sourceValue(
  scene: MeshSceneRecord,
  source: MeshSceneDependencySource,
  bindingsByTarget: ReadonlyMap<string, MeshSceneDependencyBinding>,
  resolveBinding: (key: string) => void
): MeshSceneObjectDataValue | undefined {
  if (source.kind === 'object_data') {
    return scene.dependencies.sources.find((item) => item.id === source.sourceId)?.values[source.key]
  }
  const key = propertyKey(source.nodeId, source.property)
  if (bindingsByTarget.has(key)) resolveBinding(key)
  const node = scene.nodes.find((item) => item.id === source.nodeId)
  return node ? readNodeProperty(node, source.property) : undefined
}

function readNodeProperty(
  node: MeshSceneNode,
  property: MeshSceneDependencyProperty
): MeshSceneObjectDataValue | undefined {
  const transformAddress = TRANSFORM_ADDRESS[property]
  if (transformAddress) {
    const [part, axis] = transformAddress
    return node.transform[part][axis]
  }
  if (property === 'visible') return node.visible
  const material = node.material
  switch (property) {
    case 'material.baseColor':
      return material?.baseColor
    case 'material.metallic':
      return material?.metallic
    case 'material.roughness':
      return material?.roughness
    case 'material.opacity':
      return material?.opacity
    case 'material.emissive':
      return material?.emissive
    case 'material.doubleSided':
      return material?.doubleSided
    default:
      return undefined
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function safeHexColor(value: unknown): string | null {
  return typeof value === 'string' && (/^#[0-9a-f]{6}$/i.test(value) || /^#[0-9a-f]{3}$/i.test(value))
    ? value
    : null
}

function resolvedPropertyValue(
  binding: MeshSceneDependencyBinding,
  value: MeshSceneObjectDataValue | undefined
): MeshSceneObjectDataValue {
  const property = binding.targetProperty
  if (isNumericProperty(property)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Mesh Canvas dependency for ${property} requires a numeric source value.`)
    }
    const mapped = binding.numericTransform
      ? value * binding.numericTransform.scale + binding.numericTransform.offset
      : value
    if (!Number.isFinite(mapped)) throw new Error('Mesh Canvas dependency produced a non-finite number.')
    if (property.startsWith('transform.scale.')) return clamp(mapped, 0.001, 10_000)
    if (property.startsWith('transform.')) return clamp(mapped, -100_000, 100_000)
    return clamp(mapped, 0, 1)
  }
  if (binding.numericTransform) {
    throw new Error(`Mesh Canvas dependency mapping is only valid for numeric property ${property}.`)
  }
  if (property === 'visible' || property === 'material.doubleSided') {
    if (typeof value !== 'boolean') {
      throw new Error(`Mesh Canvas dependency for ${property} requires a boolean source value.`)
    }
    return value
  }
  const color = safeHexColor(value)
  if (!color) throw new Error(`Mesh Canvas dependency for ${property} requires a #RGB or #RRGGBB source value.`)
  return color
}

function writeNodeProperty(
  scene: MeshSceneRecord,
  nodeId: string,
  property: MeshSceneDependencyProperty,
  value: MeshSceneObjectDataValue
): void {
  const index = scene.nodes.findIndex((node) => node.id === nodeId)
  if (index < 0) throw new Error('Mesh Canvas dependency target node was not found.')
  const node = scene.nodes[index]
  const transformAddress = TRANSFORM_ADDRESS[property]
  if (transformAddress) {
    const [part, axis] = transformAddress
    if (typeof value !== 'number') throw new Error('Mesh Canvas dependency value is invalid.')
    node.transform = {
      ...node.transform,
      [part]: { ...node.transform[part], [axis]: value }
    }
    return
  }
  if (property === 'visible') {
    if (typeof value !== 'boolean') throw new Error('Mesh Canvas dependency value is invalid.')
    node.visible = value
    return
  }
  const material: MeshPbrMaterial = { ...(node.material ?? {}) }
  switch (property) {
    case 'material.baseColor':
      material.baseColor = value as string
      break
    case 'material.metallic':
      material.metallic = value as number
      break
    case 'material.roughness':
      material.roughness = value as number
      break
    case 'material.opacity':
      material.opacity = value as number
      break
    case 'material.emissive':
      material.emissive = value as string
      break
    case 'material.doubleSided':
      material.doubleSided = value as boolean
      break
    default:
      throw new Error('Mesh Canvas dependency property is invalid.')
  }
  if (node.kind === 'primitive') node.material = material
  else node.material = material
}

function normalizeSource(
  value: unknown,
  sourceIds: ReadonlySet<string>,
  nodeIds: ReadonlySet<string>
): MeshSceneDependencySource | null {
  if (!isRecord(value)) return null
  if (value.kind === 'object_data') {
    if (!safeId(value.sourceId) || !safeId(value.key) || !sourceIds.has(value.sourceId)) return null
    return { kind: 'object_data', sourceId: value.sourceId, key: value.key }
  }
  if (value.kind === 'node_property') {
    if (!safeId(value.nodeId) || !nodeIds.has(value.nodeId) || !isMeshSceneDependencyProperty(value.property)) {
      return null
    }
    return { kind: 'node_property', nodeId: value.nodeId, property: value.property }
  }
  return null
}

function normalizeNumericTransform(
  value: unknown,
  property: MeshSceneDependencyProperty
): { scale: number; offset: number } | null | undefined {
  if (value === undefined) return undefined
  if (!isNumericProperty(property) || !isRecord(value)) return null
  const hasScale = value.scale !== undefined
  const hasOffset = value.offset !== undefined
  if (!hasScale && !hasOffset) return undefined
  const scale = hasScale && typeof value.scale === 'number' && Number.isFinite(value.scale) ? value.scale : 1
  const offset = hasOffset && typeof value.offset === 'number' && Number.isFinite(value.offset) ? value.offset : 0
  if ((hasScale && scale !== value.scale) || (hasOffset && offset !== value.offset)) return null
  if (Math.abs(scale) > 100_000 || Math.abs(offset) > 100_000) return null
  return { scale, offset }
}

/**
 * Loads a persisted graph defensively. Missing graph data is a valid v1 scene
 * and normalizes to an empty graph; malformed supplied graph data invalidates
 * the record rather than silently retargeting a dependent scene.
 */
export function normalizeMeshSceneDependencyGraph(
  value: unknown,
  nodes: readonly MeshSceneNode[]
): MeshSceneDependencyGraph | null {
  if (value === undefined) return createEmptyMeshSceneDependencyGraph()
  if (!isRecord(value) || !Array.isArray(value.sources) || !Array.isArray(value.bindings)) return null
  if (
    value.sources.length > MESH_MAX_SCENE_OBJECT_DATA_SOURCES ||
    value.bindings.length > MESH_MAX_SCENE_DEPENDENCY_BINDINGS
  ) {
    return null
  }
  const sources: MeshSceneObjectDataSource[] = []
  const sourceIds = new Set<string>()
  for (const rawSource of value.sources) {
    if (!isRecord(rawSource) || !safeId(rawSource.id) || sourceIds.has(rawSource.id)) return null
    const values = normalizeObjectDataValues(rawSource.values)
    if (!values || !safeTimestamp(rawSource.updatedAt)) return null
    sources.push({ id: rawSource.id, values, updatedAt: rawSource.updatedAt })
    sourceIds.add(rawSource.id)
  }
  const nodeIds = new Set(nodes.map((node) => node.id))
  const bindings: MeshSceneDependencyBinding[] = []
  const bindingIds = new Set<string>()
  const targetKeys = new Set<string>()
  for (const rawBinding of value.bindings) {
    if (!isRecord(rawBinding) || !safeId(rawBinding.id) || bindingIds.has(rawBinding.id)) return null
    if (
      !safeId(rawBinding.targetNodeId) ||
      !nodeIds.has(rawBinding.targetNodeId) ||
      !isMeshSceneDependencyProperty(rawBinding.targetProperty) ||
      !safeTimestamp(rawBinding.createdAt)
    ) {
      return null
    }
    const targetKey = propertyKey(rawBinding.targetNodeId, rawBinding.targetProperty)
    if (targetKeys.has(targetKey)) return null
    const source = normalizeSource(rawBinding.source, sourceIds, nodeIds)
    const numericTransform = normalizeNumericTransform(rawBinding.numericTransform, rawBinding.targetProperty)
    if (!source || numericTransform === null) return null
    if (source.kind === 'object_data') {
      const sourceData = sources.find((candidate) => candidate.id === source.sourceId)
      if (!sourceData || !Object.prototype.hasOwnProperty.call(sourceData.values, source.key)) {
        return null
      }
    }
    bindings.push({
      id: rawBinding.id,
      targetNodeId: rawBinding.targetNodeId,
      targetProperty: rawBinding.targetProperty,
      source,
      ...(numericTransform ? { numericTransform } : {}),
      createdAt: rawBinding.createdAt
    })
    bindingIds.add(rawBinding.id)
    targetKeys.add(targetKey)
  }
  return { sources, bindings }
}

/** Evaluate every affected dependency in topological property order. */
export function resolveMeshSceneDependencyGraph(scene: MeshSceneRecord): void {
  const bindingsByTarget = new Map<string, MeshSceneDependencyBinding>()
  for (const binding of scene.dependencies.bindings) {
    const key = propertyKey(binding.targetNodeId, binding.targetProperty)
    if (bindingsByTarget.has(key)) throw new Error('Mesh Canvas dependency graph has duplicate targets.')
    bindingsByTarget.set(key, binding)
  }
  const resolved = new Set<string>()
  const resolving = new Set<string>()
  const resolveBinding = (target: string): void => {
    if (resolved.has(target)) return
    if (resolving.has(target)) throw new Error('Mesh Canvas dependency graph contains a cycle.')
    const binding = bindingsByTarget.get(target)
    if (!binding) return
    resolving.add(target)
    const rawValue = sourceValue(scene, binding.source, bindingsByTarget, resolveBinding)
    const value = resolvedPropertyValue(binding, rawValue)
    writeNodeProperty(scene, binding.targetNodeId, binding.targetProperty, value)
    resolving.delete(target)
    resolved.add(target)
  }
  for (const target of bindingsByTarget.keys()) resolveBinding(target)
}

export function upsertMeshSceneObjectData(
  scene: MeshSceneRecord,
  input: { sourceId: string; values: unknown },
  now: string
): void {
  if (!safeId(input.sourceId)) throw new Error('Mesh Canvas object data source id is invalid.')
  const values = normalizeObjectDataValues(input.values)
  if (!values) throw new Error('Mesh Canvas object data values must be a bounded map of strings, numbers, or booleans.')
  const index = scene.dependencies.sources.findIndex((source) => source.id === input.sourceId)
  if (index < 0) {
    if (scene.dependencies.sources.length >= MESH_MAX_SCENE_OBJECT_DATA_SOURCES) {
      throw new Error(`Mesh Canvas scenes support up to ${MESH_MAX_SCENE_OBJECT_DATA_SOURCES} object data sources.`)
    }
    scene.dependencies.sources.push({ id: input.sourceId, values, updatedAt: now })
    return
  }
  const current = scene.dependencies.sources[index]
  scene.dependencies.sources[index] = {
    ...current,
    values: { ...current.values, ...values },
    updatedAt: now
  }
}

export function bindMeshSceneNodeProperty(
  scene: MeshSceneRecord,
  input: {
    nodeId: string
    property: MeshSceneDependencyProperty
    source: MeshSceneDependencySource
    numericTransform?: unknown
  },
  createId: () => string,
  now: string
): void {
  if (!safeId(input.nodeId) || !scene.nodes.some((node) => node.id === input.nodeId)) {
    throw new Error('Mesh Canvas dependency target node was not found.')
  }
  if (!isMeshSceneDependencyProperty(input.property)) throw new Error('Mesh Canvas dependency property is invalid.')
  const sourceIds = new Set(scene.dependencies.sources.map((source) => source.id))
  const nodeIds = new Set(scene.nodes.map((node) => node.id))
  const source = normalizeSource(input.source, sourceIds, nodeIds)
  const numericTransform = normalizeNumericTransform(input.numericTransform, input.property)
  if (!source || numericTransform === null) throw new Error('Mesh Canvas dependency source or numeric mapping is invalid.')
  if (source.kind === 'object_data') {
    const data = scene.dependencies.sources.find((item) => item.id === source.sourceId)
    if (!data || !(source.key in data.values)) {
      throw new Error('Mesh Canvas dependency object data key was not found.')
    }
  }
  const index = scene.dependencies.bindings.findIndex(
    (binding) => binding.targetNodeId === input.nodeId && binding.targetProperty === input.property
  )
  const binding: MeshSceneDependencyBinding = {
    id: index >= 0 ? scene.dependencies.bindings[index].id : createId(),
    targetNodeId: input.nodeId,
    targetProperty: input.property,
    source,
    ...(numericTransform ? { numericTransform } : {}),
    createdAt: index >= 0 ? scene.dependencies.bindings[index].createdAt : now
  }
  if (index >= 0) scene.dependencies.bindings[index] = binding
  else {
    if (scene.dependencies.bindings.length >= MESH_MAX_SCENE_DEPENDENCY_BINDINGS) {
      throw new Error(`Mesh Canvas scenes support up to ${MESH_MAX_SCENE_DEPENDENCY_BINDINGS} dependency bindings.`)
    }
    scene.dependencies.bindings.push(binding)
  }
}

export function unbindMeshSceneNodeProperty(
  scene: MeshSceneRecord,
  input: { nodeId: string; property: MeshSceneDependencyProperty }
): void {
  const next = scene.dependencies.bindings.filter(
    (binding) => binding.targetNodeId !== input.nodeId || binding.targetProperty !== input.property
  )
  if (next.length === scene.dependencies.bindings.length) {
    throw new Error('Mesh Canvas dependency binding was not found.')
  }
  scene.dependencies.bindings = next
}

export function removeMeshSceneNodeDependencies(scene: MeshSceneRecord, nodeId: string): void {
  scene.dependencies.bindings = scene.dependencies.bindings.filter(
    (binding) =>
      binding.targetNodeId !== nodeId &&
      !(binding.source.kind === 'node_property' && binding.source.nodeId === nodeId)
  )
}
