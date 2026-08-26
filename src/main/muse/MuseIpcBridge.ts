/**
 * IPC → `runMuseProvider` bridge.
 *
 * Composition-root wires deps (binary resolve, temp root, spawn, compat emit,
 * cancel hooks). Keeps `index.ts` to a thin adapter `run:` line.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { EffectiveRunPermissions, TaskWraithMcpProfileId } from '../store/types'
import type { MuseExecNormalizedEvent } from './MuseExecJson'
import { resolveMuseExecSessionId } from './MuseCliArgs'
import {
  buildMuseTaskWraithMcpSettings,
  type MuseMcpSettings,
  type MuseTaskWraithMcpInvocation
} from './MuseMcpConfig'
import { parseMuseAuthJsonCredential, type MuseProbeBinary } from './MuseProbe'
import type { MuseTaskWraithMcpPreparationInput } from './MuseTaskWraithMcpBridge'
import {
  runMuseProvider,
  type MuseRunOutcome,
  type MuseRunSpawn,
  type MuseRunSpawnHandle,
  type MuseRunStatus
} from './MuseRun'

export interface MuseIpcSender {
  readonly sender: unknown
}

export interface MuseIpcRunPayload {
  prompt?: string
  workspace?: string
  appRunId?: string
  appChatId?: string
  model?: string | null
  reasoningEffort?: string | null
  approvalMode?: string | null
  taskWraithMcpAdvertised?: boolean
  taskWraithMcpProfileId?: TaskWraithMcpProfileId | null
  effectivePermissions?: Pick<EffectiveRunPermissions, 'subThreadDelegationAutoAllowSource'> | null
  providerSessionId?: string | null
  /** Optional BYOK; never placed on argv — piped via `--api-key-stdin`. */
  museApiKey?: string | null
}

export interface MuseIpcCompatRoute {
  appRunId?: string
  appChatId?: string
}

export interface MuseIpcSetupFailure {
  sender: unknown
  message: string
  setupRequired: boolean
  appRunId?: string
  appChatId?: string
}

export interface MuseIpcBridgeDeps {
  resolveBinary: () => Promise<MuseProbeBinary>
  getTemporaryRoot: () => string
  spawn: MuseRunSpawn
  sendCompatLine: (
    sender: unknown,
    payload: Record<string, unknown>,
    route?: MuseIpcCompatRoute | null
  ) => void
  settleSetupFailure?: (failure: MuseIpcSetupFailure) => void
  /** Map Muse outcome status onto RunManager terminal statuses. */
  finishRun?: (input: {
    appRunId: string
    status: 'completed' | 'failed' | 'cancelled'
    exitCode: number | null
  }) => void
  registerCancel?: (runId: string, cancel: () => void) => void
  clearCancel?: (runId: string) => void
  readAuthJsonText?: () => Promise<string | null>
  readMetaApiKeyEnv?: () => string | null | undefined
  hasInjectedCredential?: () => boolean | Promise<boolean>
  /** Build the app-owned, exact-route MCP child invocation for a Muse turn. */
  prepareTaskWraithMcp?: (
    input: MuseTaskWraithMcpPreparationInput
  ) => Promise<MuseTaskWraithMcpInvocation | null>
  /** Test seam — defaults to the real lifecycle. */
  runMuseProvider?: typeof runMuseProvider
  now?: () => number
}

export type { MuseTaskWraithMcpPreparationInput as MuseIpcMcpPreparationInput } from './MuseTaskWraithMcpBridge'

const MUSE_LOGIN_HINT =
  'Muse is not signed in. Run `muse login` (Settings → Providers → Muse → Open Terminal), or set META_API_KEY.'

function formatMuseFailureResultText(outcome: MuseRunOutcome): string | undefined {
  const warnings = Array.isArray(outcome.warnings)
    ? outcome.warnings.map((w) => String(w || '').trim()).filter(Boolean)
    : []
  if (warnings.length === 0) return undefined
  return warnings
    .map((w) => w.replace(/^muse stderr:\s*/i, '').trim())
    .filter(Boolean)
    .join('\n')
}

/** Re-export for composition-root / adapter callers. */
export { resolveMuseExecSessionId } from './MuseCliArgs'

/** Default path written by interactive `muse login`. */
export function defaultMuseAuthJsonPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string {
  const xdg = String(env.XDG_CONFIG_HOME || '').trim()
  const configHome = xdg || join(home, '.config')
  return join(configHome, 'muse', 'auth.json')
}

export async function readDefaultMuseAuthJsonText(input?: {
  env?: NodeJS.ProcessEnv
  home?: string
  readFile?: (path: string, encoding: 'utf8') => Promise<string>
}): Promise<string | null> {
  const path = defaultMuseAuthJsonPath(input?.env ?? process.env, input?.home ?? homedir())
  const read = input?.readFile ?? ((p, enc) => readFile(p, enc))
  try {
    const text = await read(path, 'utf8')
    return typeof text === 'string' ? text : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    return null
  }
}

/** Extract Meta api_key for `--api-key-stdin` only — never log the return value. */
export function extractMuseMetaApiKey(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw) as { providers?: { meta?: { api_key?: unknown } } }
    const key = parsed?.providers?.meta?.api_key
    if (typeof key === 'string' && key.trim()) return key.trim()
  } catch {
    return null
  }
  return null
}

export function museExecEventToCompatPayload(
  event: MuseExecNormalizedEvent,
  options?: { model?: string | null }
): Record<string, unknown> | null {
  if (event.type === 'content' && event.text) {
    return { type: 'content', text: event.text, provider: 'muse' }
  }
  if (event.type === 'terminal') {
    const failed =
      event.terminal === 'failed' || event.terminal === 'error' || event.terminal === 'cancelled'
    return {
      type: 'result',
      status: failed ? (event.terminal === 'cancelled' ? 'cancelled' : 'failed') : 'success',
      subtype: failed ? 'error' : 'success',
      provider: 'muse'
    }
  }
  if (event.type === 'run_started' || event.type === 'command_accepted') {
    const model =
      typeof options?.model === 'string' && options.model.trim() ? options.model.trim() : undefined
    return {
      type: 'init',
      session_id: event.sessionId || '',
      provider: 'muse',
      timestamp: new Date().toISOString(),
      ...(model ? { model } : {})
    }
  }
  if (event.type === 'tool_use' && event.toolId && event.toolName) {
    return {
      type: 'tool_use',
      provider: 'muse',
      tool_name: event.toolName,
      tool_id: event.toolId,
      id: event.toolId,
      parameters: event.toolInput || {}
    }
  }
  if (event.type === 'tool_result' && event.toolId) {
    const output = typeof event.toolOutput === 'string' ? event.toolOutput : ''
    return {
      type: 'tool_result',
      provider: 'muse',
      tool_id: event.toolId,
      id: event.toolId,
      output,
      content: output,
      ...(event.toolStatus === 'error' ? { is_error: true } : {})
    }
  }
  return null
}

type NodeSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export function createChildProcessMuseSpawn(spawnImpl: NodeSpawn = nodeSpawn): MuseRunSpawn {
  return (input) => {
    const child = spawnImpl(input.binaryPath, [...input.argv], {
      cwd: input.cwd,
      env: { ...input.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false
    })

    if (typeof input.stdin === 'string' && input.stdin.length > 0) {
      child.stdin?.write(input.stdin)
    }
    child.stdin?.end()

    const handle: MuseRunSpawnHandle = {
      pid: child.pid ?? null,
      kill(signal) {
        try {
          child.kill(signal)
        } catch {
          /* already exited */
        }
      },
      onStdout(listener) {
        child.stdout?.on('data', (chunk: Buffer | string) => {
          listener(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
        })
      },
      onStderr(listener) {
        child.stderr?.on('data', (chunk: Buffer | string) => {
          listener(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
        })
      },
      wait() {
        return new Promise((resolve) => {
          child.once('close', (code, signal) => {
            resolve({ code, signal })
          })
          child.once('error', () => {
            resolve({ code: null, signal: null })
          })
        })
      }
    }
    return handle
  }
}

function requireField(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Muse IPC bridge requires a non-empty ${label}`)
  }
  return value.trim()
}

function mapOutcomeStatus(status: MuseRunStatus): 'completed' | 'failed' | 'cancelled' {
  if (status === 'success') return 'completed'
  if (status === 'cancelled') return 'cancelled'
  return 'failed'
}

function failSetup(
  deps: MuseIpcBridgeDeps,
  event: MuseIpcSender,
  payload: MuseIpcRunPayload,
  message: string
): void {
  if (deps.settleSetupFailure) {
    deps.settleSetupFailure({
      sender: event.sender,
      message,
      setupRequired: true,
      appRunId: typeof payload.appRunId === 'string' ? payload.appRunId : undefined,
      appChatId: typeof payload.appChatId === 'string' ? payload.appChatId : undefined
    })
    return
  }
  throw new Error(message)
}

interface ResolvedMuseRunCredential {
  readonly present: boolean
  readonly apiKey: string | null
  readonly authJsonText: string | null
}

async function resolveMuseRunCredential(
  deps: MuseIpcBridgeDeps,
  payload: MuseIpcRunPayload
): Promise<ResolvedMuseRunCredential> {
  if (typeof payload.museApiKey === 'string' && payload.museApiKey.trim()) {
    return { present: true, apiKey: payload.museApiKey.trim(), authJsonText: null }
  }

  // Muse documents META_API_KEY as taking precedence over account login. The
  // managed seat scrubs the inherited variable, so preserve that precedence by
  // piping its value through the bounded API-key stdin channel.
  const fromEnv = deps.readMetaApiKeyEnv?.()
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    return { present: true, apiKey: fromEnv.trim(), authJsonText: null }
  }

  let authJsonText: string | null = null
  if (deps.readAuthJsonText) {
    authJsonText = await deps.readAuthJsonText()
    const evidence = parseMuseAuthJsonCredential(authJsonText)
    if (evidence.credentialKind === 'api-key') {
      const fromFile = extractMuseMetaApiKey(authJsonText)
      if (fromFile) return { present: true, apiKey: fromFile, authJsonText: null }
    }
    if (evidence.credentialKind === 'oauth' && authJsonText) {
      return { present: true, apiKey: null, authJsonText }
    }
  }

  if (deps.hasInjectedCredential && (await deps.hasInjectedCredential())) {
    // The injection owner must still place the secret in the run payload. Keep
    // presence compatibility for callers that inject below this bridge.
    return { present: true, apiKey: null, authJsonText: null }
  }
  return { present: false, apiKey: null, authJsonText: null }
}

/**
 * Production IPC entry: validate → probe → spawn lifecycle → compat events.
 */
export async function runMuseProviderFromIpc(
  event: MuseIpcSender,
  payload: MuseIpcRunPayload,
  deps: MuseIpcBridgeDeps
): Promise<MuseRunOutcome | void> {
  const workspacePath = requireField(payload.workspace, 'workspace')
  const prompt = requireField(payload.prompt, 'prompt')
  const runId = requireField(payload.appRunId, 'appRunId')
  const route: MuseIpcCompatRoute = {
    appRunId: runId,
    appChatId: typeof payload.appChatId === 'string' ? payload.appChatId : undefined
  }

  const resolved = await deps.resolveBinary()
  if (!resolved.binaryPath) {
    failSetup(
      deps,
      event,
      payload,
      resolved.error ||
        'Muse binary was not found. Install the Muse Code CLI and ensure `muse` is on PATH.'
    )
    return
  }

  const credential = await resolveMuseRunCredential(deps, payload)
  if (!credential.present) {
    failSetup(deps, event, payload, MUSE_LOGIN_HINT)
    return
  }

  let mcpSettings: MuseMcpSettings | undefined
  if (payload.taskWraithMcpAdvertised === true) {
    try {
      if (!deps.prepareTaskWraithMcp) {
        throw new Error('TaskWraith MCP preparation is unavailable for Muse.')
      }
      const invocation = await deps.prepareTaskWraithMcp({
        appRunId: runId,
        appChatId: route.appChatId,
        workspacePath,
        approvalMode: payload.approvalMode,
        taskWraithMcpProfileId: payload.taskWraithMcpProfileId
      })
      if (!invocation) {
        throw new Error('TaskWraith MCP bridge did not return a route-bound Muse invocation.')
      }
      mcpSettings = buildMuseTaskWraithMcpSettings(invocation)
    } catch (error) {
      failSetup(
        deps,
        event,
        payload,
        `Muse requires its TaskWraith MCP bridge for this turn: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      return
    }
  }

  let cancelled = false
  const cancel = () => {
    cancelled = true
  }
  deps.registerCancel?.(runId, cancel)

  const run = deps.runMuseProvider ?? runMuseProvider
  let emittedTerminalResult = false
  const startedAt = deps.now?.() ?? Date.now()
  const museSessionId = resolveMuseExecSessionId(payload.providerSessionId)
  const ultraTaskDelegationAutoAllow =
    payload.effectivePermissions?.subThreadDelegationAutoAllowSource === 'ultratask'

  try {
    deps.sendCompatLine(
      event.sender,
      {
        type: 'init',
        session_id: museSessionId,
        model: payload.model || undefined,
        provider: 'muse',
        timestamp: new Date().toISOString()
      },
      route
    )

    const outcome = await run({
      binaryPath: resolved.binaryPath,
      workspacePath,
      prompt,
      runId,
      temporaryRoot: deps.getTemporaryRoot(),
      sessionId: museSessionId,
      model: payload.model,
      reasoningEffort: payload.reasoningEffort,
      approvalMode: payload.approvalMode,
      ultraTaskDelegationAutoAllow,
      apiKey: credential.apiKey,
      authJsonText: credential.authJsonText,
      ...(mcpSettings ? { mcpSettings } : {}),
      spawn: deps.spawn,
      shouldCancel: () => cancelled,
      onEvent: (museEvent) => {
        const compat = museExecEventToCompatPayload(museEvent, { model: payload.model })
        if (!compat) return
        if (compat.type === 'result') emittedTerminalResult = true
        deps.sendCompatLine(event.sender, compat, route)
      }
    })

    if (!emittedTerminalResult) {
      const failed = outcome.status !== 'success'
      const failureText = failed ? formatMuseFailureResultText(outcome) : undefined
      deps.sendCompatLine(
        event.sender,
        {
          type: 'result',
          status: outcome.status === 'cancelled' ? 'cancelled' : failed ? 'failed' : 'success',
          subtype: failed ? 'error' : 'success',
          provider: 'muse',
          ...(failureText ? { result: failureText } : {}),
          stats: {
            ...(outcome.providerStats || {}),
            duration_ms: Date.now() - startedAt
          }
        },
        route
      )
    }

    deps.finishRun?.({
      appRunId: runId,
      status: mapOutcomeStatus(outcome.status),
      exitCode: outcome.exitCode
    })

    return outcome
  } finally {
    deps.clearCancel?.(runId)
  }
}

/** Presence-only helper for Settings / picker probes (never returns the secret). */
export async function museAuthJsonCredentialPresent(input?: {
  env?: NodeJS.ProcessEnv
  home?: string
}): Promise<boolean> {
  const text = await readDefaultMuseAuthJsonText(input)
  return parseMuseAuthJsonCredential(text).present
}
