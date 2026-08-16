import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, realpathSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { MESH_MCP_TOOL_NAMES, type MeshMcpToolName } from '../../shared/taskWraithMcpCatalog'

/**
 * The intentionally small coordination surface Pi receives in Ensemble mode.
 *
 * Pi has no MCP client.  These names are implemented by a TaskWraith-owned,
 * per-run Pi extension which talks only to the already-authenticated local
 * TaskWraith broker. It is not a generic MCP proxy; only the fixed exact-file
 * and managed-shell lists below may be combined with it.
 */
export const PI_ENSEMBLE_COORDINATION_TOOL_NAMES = Object.freeze([
  'ensemble_yield',
  'ensemble_send',
  'ensemble_fanout',
  'ensemble_poll_response',
  'scout_brief',
  'blackboard_post',
  'blackboard_read',
  'blackboard_delete'
] as const)

/** Exact workspace mutation tools whose arguments can be locked and committed
 * inside TaskWraith's broker transaction. */
export const PI_EXACT_FILE_TOOL_NAMES = Object.freeze([
  'write_file',
  'replace',
  'apply_patch'
] as const)

/** Managed shell and elevation tools. Native Pi bash remains disabled: proven
 * reads use the normal route and opaque process effects require one visible,
 * audited host approval. */
export const PI_MANAGED_SHELL_TOOL_NAMES = Object.freeze([
  'run_shell_command',
  'request_tool_permission'
] as const)

/** Chat-local Mesh scene/topology tools admitted through the normal main gate. */
export const PI_MESH_TOOL_NAMES = Object.freeze([...MESH_MCP_TOOL_NAMES])

export type PiEnsembleCoordinationToolName = (typeof PI_ENSEMBLE_COORDINATION_TOOL_NAMES)[number]
export type PiExactFileToolName = (typeof PI_EXACT_FILE_TOOL_NAMES)[number]
export type PiManagedShellToolName = (typeof PI_MANAGED_SHELL_TOOL_NAMES)[number]
export type PiTaskWraithToolName =
  | PiEnsembleCoordinationToolName
  | PiExactFileToolName
  | PiManagedShellToolName
  | MeshMcpToolName

/**
 * The broker enforces this independently of Pi's extension registration.
 *
 * A write-capable Pi seat can inspect its own process environment, so the
 * run-bound local-broker token is authentication, not a capability boundary.
 * Keep the authorization boundary server-side: even a caller that obtained
 * that token cannot turn the contained Pi route into the generic TaskWraith
 * MCP surface.
 */
export function isPiEnsembleCoordinationToolName(
  value: unknown
): value is PiEnsembleCoordinationToolName {
  return (
    typeof value === 'string' &&
    (PI_ENSEMBLE_COORDINATION_TOOL_NAMES as readonly string[]).includes(value)
  )
}

export function isPiTaskWraithToolName(value: unknown): value is PiTaskWraithToolName {
  return (
    isPiEnsembleCoordinationToolName(value) ||
    (typeof value === 'string' &&
      ((PI_EXACT_FILE_TOOL_NAMES as readonly string[]).includes(value) ||
        (PI_MANAGED_SHELL_TOOL_NAMES as readonly string[]).includes(value) ||
        (PI_MESH_TOOL_NAMES as readonly string[]).includes(value)))
  )
}

/** Printed by the app-owned extension only after every fixed tool is registered. */
export const PI_TASKWRAITH_TOOLS_READY_MARKER = '__TASKWRAITH_PI_TOOLS_READY_V2__'
export const PI_ENSEMBLE_COORDINATION_READY_MARKER = PI_TASKWRAITH_TOOLS_READY_MARKER

const EXTENSION_FILE_NAME = 'taskwraith-tools.mjs'

export interface PreparedPiTaskWraithExtension {
  readonly path: string
  readonly sourceSha256: string
  readonly toolNames: readonly PiTaskWraithToolName[]
}

export interface PreparedPiEnsembleCoordinationExtension extends Omit<
  PreparedPiTaskWraithExtension,
  'toolNames'
> {
  readonly toolNames: readonly PiEnsembleCoordinationToolName[]
}

/**
 * Materialize the immutable, app-owned extension inside Pi's already verified
 * per-run home.  Pi's `--no-extensions` continues to disable discovery from
 * user and workspace locations; `-e` is an explicit one-file allowlist.
 */
export function preparePiEnsembleCoordinationExtension(input: {
  isolatedHomeDir: string
}): PreparedPiEnsembleCoordinationExtension {
  return preparePiTaskWraithExtension({
    isolatedHomeDir: input.isolatedHomeDir,
    toolNames: PI_ENSEMBLE_COORDINATION_TOOL_NAMES
  }) as PreparedPiEnsembleCoordinationExtension
}

export function preparePiTaskWraithExtension(input: {
  isolatedHomeDir: string
  toolNames: readonly PiTaskWraithToolName[]
}): PreparedPiTaskWraithExtension {
  const isolatedHomeDir = requireCanonicalDirectory(input.isolatedHomeDir)
  const toolNames = [...new Set(input.toolNames)]
  if (!toolNames.length || !toolNames.every(isPiTaskWraithToolName)) {
    throw new TypeError('Pi TaskWraith extension requires a non-empty fixed tool allowlist.')
  }
  const path = join(isolatedHomeDir, EXTENSION_FILE_NAME)
  const source = piTaskWraithExtensionSource(toolNames)
  // `wx` means a pre-existing file (including one planted before this call)
  // is never replaced. The isolated home itself is main-issued and 0700, but
  // fail-closed is still clearer than silently accepting an unexpected file.
  writeFileSync(path, source, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  if (process.platform !== 'win32') chmodSync(path, 0o600)
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('TaskWraith Pi coordination extension is not a regular file.')
  }
  if (process.platform !== 'win32' && (info.mode & 0o777) !== 0o600) {
    throw new Error('TaskWraith Pi coordination extension must be owner-read/write only.')
  }
  const canonicalPath = realpathSync(path)
  const relativePath = relative(isolatedHomeDir, canonicalPath)
  if (
    resolve(canonicalPath) !== path ||
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new Error('TaskWraith Pi coordination extension escaped its isolated home.')
  }
  return Object.freeze({
    path: canonicalPath,
    sourceSha256: createHash('sha256').update(source, 'utf8').digest('hex'),
    toolNames: Object.freeze(toolNames)
  })
}

/** Exact preamble inserted only after Pi has loaded the extension. */
export function piEnsembleCoordinationReadyPromptAppendix(
  receipt: PreparedPiEnsembleCoordinationExtension
): string {
  return [
    'TaskWraith ensemble coordination receipt (verified for this run):',
    `- Transport: managed Pi extension over the TaskWraith local broker (receipt ${receipt.sourceSha256.slice(0, 12)}).`,
    `- Direct coordination tools: ${receipt.toolNames.map((name) => `\`${name}\``).join(', ')}.`,
    '- This is a narrow coordination surface only. Your native Pi file/shell allowlist is unchanged; do not look for generic MCP, shell, or file tools through this extension.',
    '- If a coordination call is rejected by its normal policy, report that result and continue with the round; do not probe another transport.'
  ].join('\n')
}

export function piTaskWraithToolsReadyPromptAppendix(
  receipt: PreparedPiTaskWraithExtension
): string {
  const exactFileTools = receipt.toolNames.filter((name) =>
    (PI_EXACT_FILE_TOOL_NAMES as readonly string[]).includes(name)
  )
  const managedShellTools = receipt.toolNames.filter((name) =>
    (PI_MANAGED_SHELL_TOOL_NAMES as readonly string[]).includes(name)
  )
  const coordinationTools = receipt.toolNames.filter((name) =>
    (PI_ENSEMBLE_COORDINATION_TOOL_NAMES as readonly string[]).includes(name)
  )
  const meshTools = receipt.toolNames.filter((name) =>
    (PI_MESH_TOOL_NAMES as readonly string[]).includes(name)
  )
  return [
    'TaskWraith managed-tools receipt (verified for this run):',
    `- Transport: explicit app-owned Pi extension over the run-bound local broker (receipt ${receipt.sourceSha256.slice(0, 12)}).`,
    `- Direct tools: ${receipt.toolNames.map((name) => `\`${name}\``).join(', ')}.`,
    ...(exactFileTools.length
      ? [
          `- Exact edit tools (${exactFileTools.join(', ')}) acquire only their proposed file/hunk targets and release them immediately after each call. Native Pi bash/edit/write remain disabled.`
        ]
      : []),
    ...(managedShellTools.length
      ? [
          '- `run_shell_command` is the managed route for commands TaskWraith can prove read-only. Opaque or mutating process effects are never treated as contained by caller-declared paths.',
          '- When that exact boundary is returned, call `request_tool_permission` once with the exact command, cwd, failure and rationale. Any approved fallback is shown to the user and audited as a one-shot TaskWraith host execution outside the workspace sandbox.',
          '- If the user declines a tool or elevation request, respect that decision, continue with available evidence, and finish the turn; do not cancel the whole lane.'
        ]
      : []),
    ...(coordinationTools.length
      ? [
          '- Ensemble coordination remains policy-gated and uses the same run-bound server-side allowlist.'
        ]
      : []),
    ...(meshTools.length
      ? [
          '- Mesh Canvas tools edit chat-owned scenes through the same meshCanvas permission gate. Inspect the latest topology revision before each edit and retry stale revisions only after re-inspection.'
        ]
      : []),
    '- If a call is rejected, report the tool result and continue; do not probe another transport.'
  ].join('\n')
}

/** Exact fallback inserted if the extension did not prove ready before the turn starts. */
export function piEnsembleCoordinationUnavailablePromptAppendix(reason?: string): string {
  return [
    'TaskWraith ensemble coordination receipt: unavailable for this run.',
    '- Do not call, search for, or retry `ensemble_*`, `blackboard_*`, or `scout_brief` tools.',
    '- To suggest a next participant, write one unambiguous `@Role` or `@Model` mention in your response. TaskWraith routes unique in-round mentions; ordinary rotation remains available.',
    ...(reason ? [`- Availability reason: ${reason}`] : [])
  ].join('\n')
}

export function piTaskWraithToolsUnavailablePromptAppendix(input: {
  exactFileToolsExpected: boolean
  shellToolsExpected: boolean
  coordinationExpected: boolean
  meshToolsExpected?: boolean
  reason?: string
}): string {
  return [
    'TaskWraith managed-tools receipt: unavailable for this run.',
    ...(input.exactFileToolsExpected
      ? [
          '- Exact file tools were expected but their managed transport did not prove ready. Continue all work that remains possible and state the exact path/edit that still needs user action.'
        ]
      : []),
    ...(input.shellToolsExpected
      ? [
          '- Managed shell was expected but did not prove ready. Do not invent success: visibly ask the user to approve the exact command and cwd, then continue with any work that does not depend on it.'
        ]
      : []),
    ...(input.coordinationExpected
      ? [
          '- Do not call, search for, or retry `ensemble_*`, `blackboard_*`, or `scout_brief` tools. Use one unambiguous `@Role` or `@Model` mention instead.'
        ]
      : []),
    ...(input.meshToolsExpected
      ? [
          '- Mesh Canvas tools were expected but their managed transport did not prove ready. Continue without claiming scene changes and tell the user that Mesh authoring is unavailable for this turn.'
        ]
      : []),
    ...(input.reason ? [`- Availability reason: ${input.reason}`] : [])
  ].join('\n')
}

function requireCanonicalDirectory(value: string): string {
  if (typeof value !== 'string' || !value || resolve(value) !== value) {
    throw new TypeError('Pi isolated home path must be canonical and absolute.')
  }
  const canonical = realpathSync(value)
  if (canonical !== value) {
    throw new Error('Pi isolated home path must already be canonical.')
  }
  const info = lstatSync(canonical)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Pi isolated home must be a real directory.')
  }
  return canonical
}

// This source is deliberately self-contained. Pi's explicit extension loader
// resolves `typebox` from Pi's own runtime, and this file imports only Node's
// local Unix-socket client otherwise. The model cannot choose the broker path,
// token or parent provider. Registered tool names are generated only from the
// fixed allowlists above, then independently re-authorized by the broker token.
function piTaskWraithExtensionSource(toolNames: readonly PiTaskWraithToolName[]): string {
  return `
import { createConnection } from 'node:net'
import { Type } from 'typebox'

const READY_MARKER = '${PI_TASKWRAITH_TOOLS_READY_MARKER}'
const TOOL_NAMES = ${JSON.stringify(toolNames)}
const SOCKET_PATH = process.env.TASKWRAITH_PI_COORDINATION_SOCKET || ''
const TOKEN = process.env.TASKWRAITH_PI_COORDINATION_TOKEN || ''
const RUN_ID = process.env.TASKWRAITH_RUN_ID || ''
const CHAT_ID = process.env.TASKWRAITH_CHAT_ID || ''
const WORKSPACE_PATH = process.env.TASKWRAITH_WORKSPACE_PATH || ''

function resultText(result) {
  if (result && Array.isArray(result.content)) {
    const text = result.content
      .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\\n')
    if (text) return text
  }
  if (result && typeof result.text === 'string' && result.text) return result.text
  if (result && typeof result.error === 'string' && result.error) return result.error
  return 'TaskWraith coordination returned no text.'
}

function brokerCall(tool, args) {
  return new Promise((resolve) => {
    if (!SOCKET_PATH || !TOKEN || !RUN_ID) {
      resolve({ ok: false, error: 'TaskWraith coordination is not configured for this Pi run.' })
      return
    }
    const socket = createConnection(SOCKET_PATH)
    let buffer = ''
    let settled = false
    let timeout
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket.destroy()
      resolve(result)
    }
    timeout = setTimeout(
      () => finish({ ok: false, error: 'TaskWraith coordination broker timed out.' }),
      130000
    )
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      socket.write(JSON.stringify({
        id: 'pi-coordination-' + Date.now() + '-' + Math.random().toString(36).slice(2),
        token: TOKEN,
        tool,
        arguments: args && typeof args === 'object' ? args : {},
        appRunId: RUN_ID,
        appChatId: CHAT_ID,
        parentProvider: 'pi',
        callerCwd: process.cwd(),
        callerWorkspacePath: WORKSPACE_PATH
      }) + '\\n')
    })
    socket.on('data', (chunk) => {
      buffer += chunk
      const lineEnd = buffer.indexOf('\\n')
      if (lineEnd < 0) return
      const line = buffer.slice(0, lineEnd).trim()
      try {
        finish(JSON.parse(line))
      } catch {
        finish({ ok: false, error: 'TaskWraith coordination broker returned malformed JSON.' })
      }
    })
    socket.on('error', () => {
      finish({ ok: false, error: 'TaskWraith coordination broker connection failed.' })
    })
    socket.on('close', () => {
      if (!settled) finish({ ok: false, error: 'TaskWraith coordination broker closed before responding.' })
    })
  })
}

function descriptionFor(name) {
  const descriptions = {
    ensemble_yield: 'Pass this Ensemble turn to the next or named participant. Optional: target and reason.',
    ensemble_send: 'Send a visible participant-authored note to participant aliases and/or User (User, Human, or You, with or without @). User delivery is durable transcript-only; @All remains roster-only. Required: to and message; optional reason.',
    ensemble_fanout: 'Ask eligible Ensemble peers to run scoped parallel lanes. Required: prompt; optional targets, reason, mode, targetStage, writeScopes, isolation.',
    ensemble_poll_response: 'Vote on an active Ensemble poll. Required: pollId and choice; optional rationale.',
    scout_brief: 'Emit structured findings from a parallel scout lane. Required: findings and confidence; optional blockers, recommendations, tags.',
    blackboard_post: 'Post a shared Ensemble entry. Required: key and value; optional attachmentIds, workspaceImagePaths, pollOptions, category, scope, ttlMinutes (whole minutes; omit for durable).',
    blackboard_read: 'Read bounded shared Ensemble blackboard entries. All filters are optional.',
    blackboard_delete: 'Retire stale shared blackboard entries when your run posture permits it. Optional ids, keys, category, or all.',
    write_file: 'Write one exact workspace file through TaskWraith mutation locking. Required: path and content.',
    replace: 'Replace exact text in one workspace file through TaskWraith mutation locking. Required: path, old_string, and new_string.',
    apply_patch: 'Apply one complete unified diff through an atomic TaskWraith multi-file transaction. Required: patch.',
    run_shell_command: 'Run a command TaskWraith can prove read-only. Required: command. Opaque or mutating process effects require request_tool_permission for one audited host execution.',
    request_tool_permission: 'Ask the user for one audited retry of a denied TaskWraith tool. Include the tool name, exact arguments, failure, and optional rationale.',
    mesh_scene_create: 'Create a chat-owned Mesh Canvas scene. Optional: title.',
    mesh_scene_list: 'List chat-owned Mesh Canvas scenes.',
    mesh_scene_inspect: 'Inspect one scene. Required: sceneId.',
    mesh_scene_import: 'Import a workspace-local GLB, glTF, or OBJ. Required: sceneId and sourcePath.',
    mesh_scene_apply: 'Apply one declarative scene/node operation. Required: sceneId and operation; pass operation-specific fields.',
    mesh_scene_set_material: 'Set one node PBR material. Required: sceneId, nodeId, and material.',
    mesh_scene_present: 'Present one Mesh Canvas scene. Required: sceneId.',
    mesh_scene_close: 'Close one presented Mesh Canvas scene. Required: sceneId.',
    mesh_scene_delete: 'Delete one chat-owned Mesh Canvas scene. Required: sceneId.',
    mesh_topology_convert: 'Convert a primitive or imported node to editable topology. Required: sceneId and nodeId.',
    mesh_topology_inspect: 'Inspect paged vertices, edges, faces, UV loops, bones, or summary. Required: sceneId and nodeId.',
    mesh_topology_edit: 'Atomically edit topology, UVs, sculpt strokes, or rigging. Required: sceneId, nodeId, expectedRevision, clientMutationId, and operations.'
  }
  return descriptions[name] || 'Use this TaskWraith Ensemble coordination tool.'
}

function parametersFor(name) {
  const optionalText = () => Type.Optional(Type.String())
  const optionalTextArray = () => Type.Optional(Type.Array(Type.String()))
  const object = (properties) => Type.Object(properties, { additionalProperties: true })
  switch (name) {
    case 'ensemble_yield':
      return object({ reason: optionalText(), target: optionalText() })
    case 'ensemble_send':
      return object({
        to: Type.Union([Type.String(), Type.Array(Type.String())]),
        message: Type.String(),
        reason: optionalText()
      })
    case 'ensemble_fanout':
      return object({
        targets: optionalTextArray(),
        prompt: Type.String(),
        reason: optionalText(),
        mode: optionalText(),
        targetStage: optionalText(),
        writeScopes: Type.Optional(Type.Any()),
        isolation: optionalText()
      })
    case 'ensemble_poll_response':
      return object({ pollId: Type.String(), choice: Type.String(), rationale: optionalText() })
    case 'scout_brief':
      return object({
        findings: Type.String(),
        confidence: Type.String(),
        blockers: optionalTextArray(),
        recommendations: optionalTextArray(),
        tags: optionalTextArray()
      })
    case 'blackboard_post':
      return object({
        key: Type.String(),
        value: Type.String(),
        pollOptions: optionalTextArray(),
        attachmentIds: optionalTextArray(),
        workspaceImagePaths: optionalTextArray(),
        category: optionalText(),
        scope: optionalText(),
        ttlMinutes: Type.Optional(Type.Number())
      })
    case 'blackboard_read':
      return object({
        ids: optionalTextArray(),
        keys: optionalTextArray(),
        category: optionalText(),
        unseenOnly: Type.Optional(Type.Boolean()),
        first: Type.Optional(Type.Number()),
        last: Type.Optional(Type.Number())
      })
    case 'blackboard_delete':
      return object({
        ids: optionalTextArray(),
        keys: optionalTextArray(),
        category: optionalText(),
        all: Type.Optional(Type.Boolean())
      })
    case 'write_file':
      return object({ path: Type.String(), content: Type.String() })
    case 'replace':
      return object({
        path: Type.String(),
        old_string: Type.String(),
        new_string: Type.String(),
        replace_all: Type.Optional(Type.Boolean())
      })
    case 'apply_patch':
      return object({
        patch: Type.String(),
        dryRun: Type.Optional(Type.Boolean()),
        check: Type.Optional(Type.Boolean())
      })
    case 'run_shell_command':
      return object({
        command: Type.String(),
        cwd: optionalText()
      })
    case 'request_tool_permission':
      return object({
        toolName: Type.String(),
        arguments: Type.Any(),
        failure: Type.String(),
        rationale: optionalText()
      })
    case 'mesh_scene_create':
      return object({ title: optionalText() })
    case 'mesh_scene_list':
      return object({})
    case 'mesh_scene_inspect':
    case 'mesh_scene_present':
    case 'mesh_scene_close':
    case 'mesh_scene_delete':
      return object({ sceneId: Type.String() })
    case 'mesh_scene_import':
      return object({ sceneId: Type.String(), sourcePath: Type.String() })
    case 'mesh_scene_apply':
      return object({ sceneId: Type.String(), operation: Type.String() })
    case 'mesh_scene_set_material':
      return object({ sceneId: Type.String(), nodeId: Type.String(), material: Type.Any() })
    case 'mesh_topology_convert':
      return object({ sceneId: Type.String(), nodeId: Type.String() })
    case 'mesh_topology_inspect':
      return object({
        sceneId: Type.String(),
        nodeId: Type.String(),
        section: optionalText(),
        offset: Type.Optional(Type.Number()),
        limit: Type.Optional(Type.Number())
      })
    case 'mesh_topology_edit':
      return object({
        sceneId: Type.String(),
        nodeId: Type.String(),
        expectedRevision: Type.Number(),
        clientMutationId: Type.String(),
        operations: Type.Array(Type.Any())
      })
    default:
      return object({})
  }
}

export default function (pi) {
  for (const name of TOOL_NAMES) {
    pi.registerTool({
      name,
      label: 'TaskWraith ' + name,
      description: descriptionFor(name),
      promptSnippet: descriptionFor(name),
      promptGuidelines: ['Use ' + name + ' only for its stated TaskWraith purpose.'],
      parameters: parametersFor(name),
      async execute(_toolCallId, params) {
        const result = await brokerCall(name, params)
        if (!result || result.ok !== true) {
          throw new Error(resultText(result))
        }
        return {
          content: [{ type: 'text', text: resultText(result) }],
          details: { taskwraith: true, tool: name, ok: true }
        }
      }
    })
  }
  process.stderr.write(READY_MARKER + '\\n')
}
`.trimStart()
}
