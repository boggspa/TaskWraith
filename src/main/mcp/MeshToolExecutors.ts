/** Provider-neutral semantic MCP executor for the Mesh Canvas surface. */
import * as path from 'path'
import type { McpToolExecutionResult } from './McpBridgeRuntime'
import {
  MESH_SCENE_MCP_TOOL_NAMES,
  type MeshSceneMcpToolName
} from '../../shared/taskWraithMcpCatalog'
import type { MeshPbrMaterial, MeshSceneLighting, MeshSceneRecord } from '../../shared/meshScene'
import {
  isMeshPrimitiveKind,
  type MeshPrimitiveKind
} from '../../shared/meshScene'
import type {
  MeshSceneCallContext,
  MeshSceneCameraInput,
  MeshSceneMutation,
  MeshSceneService,
  MeshTransformInput
} from '../mesh/MeshSceneService'

/** Main-side alias retained for MCP dispatch callers. The shared catalogue owns membership. */
export const MESH_MCP_TOOL_NAMES = MESH_SCENE_MCP_TOOL_NAMES

export type MeshMcpToolName = MeshSceneMcpToolName

const MESH_TOOL_NAME_SET: ReadonlySet<string> = new Set(MESH_MCP_TOOL_NAMES)

export function isMeshMcpToolName(value: string): value is MeshMcpToolName {
  return MESH_TOOL_NAME_SET.has(value)
}

export interface MeshToolContext extends MeshSceneCallContext {
  appChatId?: string
  appRunId?: string
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

function sceneId(args: Record<string, unknown>): string | undefined {
  return stringValue(args.sceneId, 128)
}

function meshContext(input: MeshToolContext, parentProvider: string): MeshSceneCallContext {
  return {
    provider: parentProvider,
    chatId: input.appChatId ?? input.chatId,
    runId: input.appRunId ?? input.runId,
    workspacePath: input.workspacePath
  }
}

function resolveWorkspaceSource(rawPath: unknown, context: MeshSceneCallContext): string {
  const supplied = stringValue(rawPath, 4_096)
  if (!supplied) throw new Error('A workspace-relative sourcePath is required.')
  if (!context.workspacePath) throw new Error('Mesh imports require a workspace-scoped chat.')
  const workspace = path.resolve(context.workspacePath)
  const candidate = path.isAbsolute(supplied) ? path.resolve(supplied) : path.resolve(workspace, supplied)
  const relative = path.relative(workspace, candidate)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
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
    if (!isMeshPrimitiveKind(primitive)) throw new Error('add_primitive requires a supported primitive.')
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
            { title: stringValue(args.title, 200), backgroundColor: stringValue(args.backgroundColor, 16) },
            context
          )
          return result({ ok: true, scene: sceneForMcp(scene) })
        }
        if (toolName === 'mesh_scene_list') return result({ ok: true, scenes: controller.list(context) })
        const id = sceneId(args)
        if (!id) return fail(toolName, 'sceneId is required.')
        if (toolName === 'mesh_scene_inspect') {
          return result({ ok: true, scene: sceneForMcp(controller.inspect(id, context)) })
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
          return result({ ok: true, scene: sceneForMcp(controller.apply(id, parseMutation(args), context)) })
        }
        if (toolName === 'mesh_scene_set_material') {
          const nodeId = stringValue(args.nodeId, 128)
          const texturePath = stringValue(args.texturePath, 4_096)
          const nextMaterial = material(args.material) ?? (texturePath ? {} : undefined)
          if (!nodeId || !nextMaterial) return fail(toolName, 'nodeId and a material update are required.')
          return result({
            ok: true,
            scene: sceneForMcp(controller.setMaterial(
              id,
              {
                nodeId,
                material: nextMaterial,
                ...(texturePath
                  ? { textureSourcePath: resolveWorkspaceSource(texturePath, context) }
                  : {})
              },
              context
            ))
          })
        }
        if (toolName === 'mesh_scene_present') {
          return result({
            ok: true,
            scene: sceneForMcp(controller.present(id, { title: stringValue(args.title, 200) }, context)),
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
