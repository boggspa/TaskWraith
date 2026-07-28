import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, realpathSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/**
 * The intentionally small coordination surface Pi receives in Ensemble mode.
 *
 * Pi has no MCP client.  These names are implemented by a TaskWraith-owned,
 * per-run Pi extension which talks only to the already-authenticated local
 * TaskWraith broker.  It is not a generic MCP proxy: it cannot expose shell,
 * file, network, or arbitrary host tools to Pi.
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

export type PiEnsembleCoordinationToolName = (typeof PI_ENSEMBLE_COORDINATION_TOOL_NAMES)[number]

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

/** Printed by the app-owned extension only after every fixed tool is registered. */
export const PI_ENSEMBLE_COORDINATION_READY_MARKER =
  '__TASKWRAITH_PI_ENSEMBLE_COORDINATION_READY_V1__'

const EXTENSION_FILE_NAME = 'taskwraith-ensemble-coordination.mjs'

export interface PreparedPiEnsembleCoordinationExtension {
  readonly path: string
  readonly sourceSha256: string
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
  const isolatedHomeDir = requireCanonicalDirectory(input.isolatedHomeDir)
  const path = join(isolatedHomeDir, EXTENSION_FILE_NAME)
  const source = PI_ENSEMBLE_COORDINATION_EXTENSION_SOURCE
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
    toolNames: PI_ENSEMBLE_COORDINATION_TOOL_NAMES
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

/** Exact fallback inserted if the extension did not prove ready before the turn starts. */
export function piEnsembleCoordinationUnavailablePromptAppendix(reason?: string): string {
  return [
    'TaskWraith ensemble coordination receipt: unavailable for this run.',
    '- Do not call, search for, or retry `ensemble_*`, `blackboard_*`, or `scout_brief` tools.',
    '- To suggest a next participant, write one unambiguous `@Role` or `@Model` mention in your response. TaskWraith routes unique in-round mentions; ordinary rotation remains available.',
    ...(reason ? [`- Availability reason: ${reason}`] : [])
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
// token, parent provider, or tool name: all are fixed below or injected by
// TaskWraith into this per-run process environment.
const PI_ENSEMBLE_COORDINATION_EXTENSION_SOURCE = `
import { createConnection } from 'node:net'
import { Type } from 'typebox'

const READY_MARKER = '${PI_ENSEMBLE_COORDINATION_READY_MARKER}'
const TOOL_NAMES = ${JSON.stringify(PI_ENSEMBLE_COORDINATION_TOOL_NAMES)}
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
    ensemble_send: 'Send a visible participant-to-participant note. Required: to (alias or aliases) and message; optional reason.',
    ensemble_fanout: 'Ask eligible Ensemble peers to run scoped parallel lanes. Required: prompt; optional targets, reason, mode, targetStage, writeScopes, isolation.',
    ensemble_poll_response: 'Vote on an active Ensemble poll. Required: pollId and choice; optional rationale.',
    scout_brief: 'Emit structured findings from a parallel scout lane. Required: findings and confidence; optional blockers, recommendations, tags.',
    blackboard_post: 'Post a durable shared Ensemble entry. Required: key and value; optional pollOptions, category, scope.',
    blackboard_read: 'Read bounded shared Ensemble blackboard entries. All filters are optional.',
    blackboard_delete: 'Retire stale shared blackboard entries when your run posture permits it. Optional ids, keys, category, or all.'
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
        category: optionalText(),
        scope: optionalText()
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
      promptGuidelines: ['Use ' + name + ' only for its stated TaskWraith Ensemble coordination purpose.'],
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
