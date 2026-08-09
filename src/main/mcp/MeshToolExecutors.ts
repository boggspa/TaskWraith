/** Provider-neutral semantic MCP executor for the Mesh Canvas surface. */
import * as path from 'path'
import type { McpToolExecutionResult } from './McpBridgeRuntime'
import {
  MESH_MCP_TOOL_NAMES,
  type MeshMcpToolName as SharedMeshMcpToolName
} from '../../shared/taskWraithMcpCatalog'
import {
  isMeshPrimitiveKind,
  isMeshSceneDependencyProperty,
  type MeshPbrMaterial,
  type MeshPrimitiveKind,
  type MeshSceneDependencySource,
  type MeshSceneLighting,
  type MeshSceneObjectDataValue,
  type MeshSceneRecord
} from '../../shared/meshScene'
import {
  MESH_TOPOLOGY_MAX_EDIT_OPERATIONS,
  meshTopologySummary,
  type MeshTopologyDocument,
  type MeshTopologyMutation
} from '../../shared/meshTopology'
import type {
  MeshSceneCallContext,
  MeshSceneCameraInput,
  MeshSceneMutation,
  MeshSceneService,
  MeshTransformInput
} from '../mesh/MeshSceneService'

/** Main-side alias retained for MCP dispatch callers. The shared catalogue owns membership. */
export { MESH_MCP_TOOL_NAMES }

export type MeshMcpToolName = SharedMeshMcpToolName

const MESH_TOOL_NAME_SET: ReadonlySet<string> = new Set(MESH_MCP_TOOL_NAMES)

export function isMeshMcpToolName(value: string): value is MeshMcpToolName {
  return MESH_TOOL_NAME_SET.has(value)
}

export interface MeshToolContext extends MeshSceneCallContext {
  appChatId?: string
  appRunId?: string
  ensembleRun?: { participantId?: string }
}

export interface MeshToolExecutors {
  executeMeshTool: (
    toolName: MeshMcpToolName,
    rawArgs: unknown,
    context: MeshToolContext,
    parentProvider: string
  ) => Promise<McpToolExecutionResult>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringValue(value: unknown, limit = 4_096): string | undefined {
  return typeof value === 'string' && value.trim() && value.trim().length <= limit
    ? value.trim()
    : undefined
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : undefined
}

function vec3(value: unknown): MeshTransformInput['position'] | undefined {
  const raw = asRecord(value)
  const result = {
    ...(numberValue(raw.x) !== undefined ? { x: numberValue(raw.x)! } : {}),
    ...(numberValue(raw.y) !== undefined ? { y: numberValue(raw.y)! } : {}),
    ...(numberValue(raw.z) !== undefined ? { z: numberValue(raw.z)! } : {})
  }
  return Object.keys(result).length ? result : undefined
}

function transform(value: unknown): MeshTransformInput | undefined {
  const raw = asRecord(value)
  const position = vec3(raw.position)
  const rotation = vec3(raw.rotation)
  const scale = vec3(raw.scale)
  const result = {
    ...(position ? { position } : {}),
    ...(rotation ? { rotation } : {}),
    ...(scale ? { scale } : {})
  }
  return Object.keys(result).length ? result : undefined
}

function material(value: unknown): MeshPbrMaterial | undefined {
  const raw = asRecord(value)
  // Asset ids are internal scene-vault references, never an agent-controlled
  // cross-chat addressing mechanism. Agents attach a new texture through the
  // workspace-scoped `texturePath` argument instead.
  if (raw.textureAssetId !== undefined) {
    throw new Error('textureAssetId is internal to Mesh Canvas; use texturePath instead.')
  }
  const result: MeshPbrMaterial = {
    ...(stringValue(raw.baseColor, 16) ? { baseColor: stringValue(raw.baseColor, 16) } : {}),
    ...(numberValue(raw.metallic) !== undefined ? { metallic: numberValue(raw.metallic)! } : {}),
    ...(numberValue(raw.roughness) !== undefined ? { roughness: numberValue(raw.roughness)! } : {}),
    ...(numberValue(raw.opacity) !== undefined ? { opacity: numberValue(raw.opacity)! } : {}),
    ...(stringValue(raw.emissive, 16) ? { emissive: stringValue(raw.emissive, 16) } : {}),
    ...(typeof raw.doubleSided === 'boolean' ? { doubleSided: raw.doubleSided } : {})
  }
  return Object.keys(result).length ? result : undefined
}

function objectDataValues(value: unknown): Record<string, MeshSceneObjectDataValue> {
  const raw = asRecord(value)
  const entries = Object.entries(raw)
  if (!entries.length) throw new Error('upsert_object_data requires a non-empty values map.')
  const result: Record<string, MeshSceneObjectDataValue> = {}
  for (const [key, entry] of entries) {
    if (
      !(
        typeof entry === 'boolean' ||
        (typeof entry === 'number' && Number.isFinite(entry)) ||
        typeof entry === 'string'
      )
    ) {
      throw new Error('Object data values must be strings, numbers, or booleans.')
    }
    result[key] = entry
  }
  return result
}

function dependencySource(value: unknown): MeshSceneDependencySource {
  const raw = asRecord(value)
  if (raw.kind === 'object_data') {
    const sourceId = stringValue(raw.sourceId, 128)
    const key = stringValue(raw.key, 128)
    if (!sourceId || !key) throw new Error('Object-data dependencies require sourceId and key.')
    return { kind: 'object_data', sourceId, key }
  }
  if (raw.kind === 'node_property') {
    const nodeId = stringValue(raw.nodeId, 128)
    if (!nodeId || !isMeshSceneDependencyProperty(raw.property)) {
      throw new Error('Node-property dependencies require nodeId and a supported property.')
    }
    return { kind: 'node_property', nodeId, property: raw.property }
  }
  throw new Error('Dependency source must be object_data or node_property.')
}

function numericTransform(value: unknown): { scale?: number; offset?: number } | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('numericTransform must be an object with numeric scale and/or offset.')
  }
  const raw = asRecord(value)
  const scale = numberValue(raw.scale)
  const offset = numberValue(raw.offset)
  if (
    (raw.scale !== undefined && scale === undefined) ||
    (raw.offset !== undefined && offset === undefined)
  ) {
    throw new Error('numericTransform scale and offset must be finite numbers.')
  }
  const result = {
    ...(scale !== undefined ? { scale } : {}),
    ...(offset !== undefined ? { offset } : {})
  }
  return Object.keys(result).length ? result : undefined
}

function sceneId(args: Record<string, unknown>): string | undefined {
  return stringValue(args.sceneId, 128)
}

function meshContext(input: MeshToolContext, parentProvider: string): MeshSceneCallContext {
  return {
    provider: parentProvider,
    chatId: input.appChatId ?? input.chatId,
    runId: input.appRunId ?? input.runId,
    workspacePath: input.workspacePath,
    participantId: input.ensembleRun?.participantId ?? input.participantId
  }
}

const TOPOLOGY_OPERATIONS: ReadonlySet<string> = new Set([
  'move_vertices',
  'create_vertices',
  'delete_vertices',
  'merge_vertices',
  'create_faces',
  'delete_faces',
  'extrude_faces',
  'inset_faces',
  'subdivide_faces',
  'split_edge',
  'collapse_edge',
  'mark_edges',
  'set_face_uvs',
  'unwrap_uv',
  'sculpt',
  'upsert_bones',
  'remove_bones',
  'set_vertex_weights',
  'pose_bones',
  'replace_geometry'
])

function topologyOperations(value: unknown): MeshTopologyMutation[] {
  if (!Array.isArray(value) || !value.length || value.length > MESH_TOPOLOGY_MAX_EDIT_OPERATIONS) {
    throw new Error(`operations must contain 1-${MESH_TOPOLOGY_MAX_EDIT_OPERATIONS} edits.`)
  }
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024) {
    throw new Error('Mesh topology edit payload exceeds the 64 KiB retry-safe limit.')
  }
  for (const entry of value) {
    const operation = asRecord(entry).operation
    if (typeof operation !== 'string' || !TOPOLOGY_OPERATIONS.has(operation)) {
      throw new Error('Mesh topology edit contains an unsupported operation.')
    }
  }
  return JSON.parse(serialized) as MeshTopologyMutation[]
}

function topologyPage(
  document: MeshTopologyDocument,
  section: string,
  offset: number,
  limit: number
): Record<string, unknown> {
  const source =
    section === 'vertices'
      ? document.vertices
      : section === 'edges'
        ? document.edges
        : section === 'faces'
          ? document.faces
          : section === 'uvs'
            ? document.faces.map((face) => ({
                faceId: face.id,
                loops: face.loops.map((loop) => ({ vertexId: loop.vertexId, uv: loop.uv ?? null }))
              }))
            : section === 'bones'
              ? document.bones
              : document.recentMutations
  const items = source.slice(offset, offset + limit)
  return {
    section,
    offset,
    limit,
    total: source.length,
    items,
    ...(offset + items.length < source.length ? { nextOffset: offset + items.length } : {})
  }
}

function resolveWorkspaceSource(rawPath: unknown, context: MeshSceneCallContext): string {
  const supplied = stringValue(rawPath, 4_096)
  if (!supplied) throw new Error('A workspace-relative sourcePath is required.')
  if (!context.workspacePath) throw new Error('Mesh imports require a workspace-scoped chat.')
  const workspace = path.resolve(context.workspacePath)
  const candidate = path.isAbsolute(supplied)
    ? path.resolve(supplied)
    : path.resolve(workspace, supplied)
  const relative = path.relative(workspace, candidate)
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('Mesh imports must stay inside the active workspace.')
  }
  return candidate
}

function result(value: Record<string, unknown>): McpToolExecutionResult {
  const text = JSON.stringify(value)
  return { text, structuredContent: value, content: [{ type: 'text', text }] }
}

/**
 * The durable scene keeps its owning workspace so history erasure can match
 * authority correctly. That local path is not renderer data and must never be
 * reflected into an MCP result (where it can cross provider boundaries).
 */
function sceneForMcp(scene: MeshSceneRecord): Omit<MeshSceneRecord, 'workspacePath'> {
  const { workspacePath: _workspacePath, ...safeScene } = scene
  return safeScene
}

function fail(tool: MeshMcpToolName, message: string): McpToolExecutionResult {
  const value = { ok: false, tool, error: message }
  const text = JSON.stringify(value)
  return { text, isError: true, structuredContent: value, content: [{ type: 'text', text }] }
}

function parseMutation(args: Record<string, unknown>): MeshSceneMutation {
  const operation = stringValue(args.operation, 64)
  if (operation === 'add_primitive') {
    const primitive = stringValue(args.primitive, 32)
    if (!isMeshPrimitiveKind(primitive))
      throw new Error('add_primitive requires a supported primitive.')
    return {
      operation,
      primitive: primitive as MeshPrimitiveKind,
      ...(stringValue(args.name, 200) ? { name: stringValue(args.name, 200) } : {}),
      ...(transform(args.transform) ? { transform: transform(args.transform) } : {}),
      ...(material(args.material) ? { material: material(args.material) } : {})
    }
  }
  if (operation === 'update_node') {
    const nodeId = stringValue(args.nodeId, 128)
    if (!nodeId) throw new Error('update_node requires nodeId.')
    return {
      operation,
      nodeId,
      ...(stringValue(args.name, 200) ? { name: stringValue(args.name, 200) } : {}),
      ...(transform(args.transform) ? { transform: transform(args.transform) } : {}),
      ...(material(args.material) ? { material: material(args.material) } : {}),
      ...(typeof args.visible === 'boolean' ? { visible: args.visible } : {})
    }
  }
  if (operation === 'remove_node') {
    const nodeId = stringValue(args.nodeId, 128)
    if (!nodeId) throw new Error('remove_node requires nodeId.')
    return { operation, nodeId }
  }
  if (operation === 'upsert_object_data') {
    const sourceId = stringValue(args.sourceId, 128)
    if (!sourceId) throw new Error('upsert_object_data requires sourceId.')
    return { operation, sourceId, values: objectDataValues(args.values) }
  }
  if (operation === 'bind_node_property') {
    const nodeId = stringValue(args.nodeId, 128)
    if (!nodeId || !isMeshSceneDependencyProperty(args.property)) {
      throw new Error('bind_node_property requires nodeId and a supported property.')
    }
    const mapping = numericTransform(args.numericTransform)
    return {
      operation,
      nodeId,
      property: args.property,
      source: dependencySource(args.source),
      ...(mapping ? { numericTransform: mapping } : {})
    }
  }
  if (operation === 'unbind_node_property') {
    const nodeId = stringValue(args.nodeId, 128)
    if (!nodeId || !isMeshSceneDependencyProperty(args.property)) {
      throw new Error('unbind_node_property requires nodeId and a supported property.')
    }
    return { operation, nodeId, property: args.property }
  }
  if (operation === 'set_scene') {
    const lightingRaw = asRecord(args.lighting)
    const cameraRaw = asRecord(args.camera)
    const lighting: Partial<MeshSceneLighting> = {
      ...(lightingRaw.environment === 'studio' ||
      lightingRaw.environment === 'sunset' ||
      lightingRaw.environment === 'neutral'
        ? { environment: lightingRaw.environment }
        : {}),
      ...(numberValue(lightingRaw.intensity) !== undefined
        ? { intensity: numberValue(lightingRaw.intensity)! }
        : {})
    }
    const position = vec3(cameraRaw.position)
    const target = vec3(cameraRaw.target)
    const camera: MeshSceneCameraInput = {
      ...(position ? { position } : {}),
      ...(target ? { target } : {}),
      ...(numberValue(cameraRaw.fieldOfView) !== undefined
        ? { fieldOfView: numberValue(cameraRaw.fieldOfView)! }
        : {})
    }
    return {
      operation,
      ...(stringValue(args.title, 200) ? { title: stringValue(args.title, 200) } : {}),
      ...(stringValue(args.backgroundColor, 16)
        ? { backgroundColor: stringValue(args.backgroundColor, 16) }
        : {}),
      ...(Object.keys(lighting).length ? { lighting } : {}),
      ...(Object.keys(camera).length ? { camera } : {})
    }
  }
  throw new Error('Unknown Mesh Canvas operation.')
}

/** Factory so this dispatch stays independently testable without Electron. */
export function createMeshToolExecutors(controller: MeshSceneService): MeshToolExecutors {
  return {
    async executeMeshTool(toolName, rawArgs, inputContext, parentProvider) {
      const args = asRecord(rawArgs)
      const context = meshContext(inputContext, parentProvider)
      try {
        if (toolName === 'mesh_scene_create') {
          const scene = controller.create(
            {
              title: stringValue(args.title, 200),
              backgroundColor: stringValue(args.backgroundColor, 16)
            },
            context
          )
          return result({ ok: true, scene: sceneForMcp(scene) })
        }
        if (toolName === 'mesh_scene_list')
          return result({ ok: true, scenes: controller.list(context) })
        const id = sceneId(args)
        if (!id) return fail(toolName, 'sceneId is required.')
        if (toolName === 'mesh_scene_inspect') {
          return result({ ok: true, scene: sceneForMcp(controller.inspect(id, context)) })
        }
        if (toolName === 'mesh_topology_convert') {
          const nodeId = stringValue(args.nodeId, 128)
          if (!nodeId) return fail(toolName, 'nodeId is required.')
          const converted = controller.makeEditable(id, { nodeId }, context)
          return result({
            ok: true,
            sceneId: converted.scene.id,
            sceneRevision: converted.scene.revision,
            nodeId,
            topology: meshTopologySummary(converted.topology)
          })
        }
        if (toolName === 'mesh_topology_inspect') {
          const nodeId = stringValue(args.nodeId, 128)
          if (!nodeId) return fail(toolName, 'nodeId is required.')
          const inspected = controller.inspectTopology(id, { nodeId }, context)
          const section = stringValue(args.section, 32) ?? 'summary'
          if (section === 'summary') {
            return result({
              ok: true,
              sceneId: id,
              sceneRevision: inspected.sceneRevision,
              nodeId,
              topology: meshTopologySummary(inspected.topology)
            })
          }
          if (
            !['vertices', 'edges', 'faces', 'uvs', 'bones', 'recent_mutations'].includes(section)
          ) {
            return fail(toolName, 'Unsupported topology inspection section.')
          }
          const rawOffset = numberValue(args.offset) ?? 0
          const rawLimit = numberValue(args.limit) ?? 100
          if (!Number.isInteger(rawOffset) || rawOffset < 0 || !Number.isInteger(rawLimit)) {
            return fail(toolName, 'offset and limit must be non-negative integers.')
          }
          return result({
            ok: true,
            sceneId: id,
            sceneRevision: inspected.sceneRevision,
            nodeId,
            topologyId: inspected.topology.id,
            topologyRevision: inspected.topology.revision,
            ...topologyPage(
              inspected.topology,
              section,
              rawOffset,
              Math.max(1, Math.min(500, rawLimit))
            )
          })
        }
        if (toolName === 'mesh_topology_edit') {
          const nodeId = stringValue(args.nodeId, 128)
          const expectedRevision = numberValue(args.expectedRevision)
          const clientMutationId = stringValue(args.clientMutationId, 128)
          if (
            !nodeId ||
            !Number.isInteger(expectedRevision) ||
            expectedRevision! < 0 ||
            !clientMutationId
          ) {
            return fail(
              toolName,
              'nodeId, non-negative integer expectedRevision, and clientMutationId are required.'
            )
          }
          const edited = controller.editTopology(
            id,
            {
              nodeId,
              edit: {
                expectedRevision: expectedRevision!,
                clientMutationId,
                operations: topologyOperations(args.operations)
              }
            },
            context
          )
          return result({
            ok: true,
            sceneId: edited.scene.id,
            sceneRevision: edited.scene.revision,
            nodeId,
            topology: edited.edit.summary,
            createdIds: edited.edit.createdIds,
            deletedIds: edited.edit.deletedIds,
            duplicate: edited.edit.duplicate
          })
        }
        if (toolName === 'mesh_scene_import') {
          const scene = controller.importModel(
            id,
            {
              sourcePath: resolveWorkspaceSource(args.sourcePath, context),
              name: stringValue(args.name, 200),
              transform: transform(args.transform)
            },
            context
          )
          return result({ ok: true, scene: sceneForMcp(scene) })
        }
        if (toolName === 'mesh_scene_apply') {
          return result({
            ok: true,
            scene: sceneForMcp(controller.apply(id, parseMutation(args), context))
          })
        }
        if (toolName === 'mesh_scene_set_material') {
          const nodeId = stringValue(args.nodeId, 128)
          const texturePath = stringValue(args.texturePath, 4_096)
          const nextMaterial = material(args.material) ?? (texturePath ? {} : undefined)
          if (!nodeId || !nextMaterial)
            return fail(toolName, 'nodeId and a material update are required.')
          return result({
            ok: true,
            scene: sceneForMcp(
              controller.setMaterial(
                id,
                {
                  nodeId,
                  material: nextMaterial,
                  ...(texturePath
                    ? { textureSourcePath: resolveWorkspaceSource(texturePath, context) }
                    : {})
                },
                context
              )
            )
          })
        }
        if (toolName === 'mesh_scene_present') {
          return result({
            ok: true,
            scene: sceneForMcp(
              controller.present(id, { title: stringValue(args.title, 200) }, context)
            ),
            presentation: 'Mesh Canvas has been presented in the chat canvas dock.'
          })
        }
        if (toolName === 'mesh_scene_close') {
          return result({ ok: true, scene: sceneForMcp(controller.closePresentation(id, context)) })
        }
        return result({ ok: true, deletedSceneId: controller.remove(id, context) })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Mesh Canvas operation failed.'
        return fail(toolName, message)
      }
    }
  }
}
