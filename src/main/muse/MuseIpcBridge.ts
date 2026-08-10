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
import type { MuseExecNormalizedEvent } from './MuseExecJson'
import { resolveMuseExecSessionId } from './MuseCliArgs'
import {
  isMuseCredentialPresent,
  parseMuseAuthJsonCredential,
  type MuseProbeBinary
} from './MuseProbe'
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
  /** Test seam — defaults to the real lifecycle. */
  runMuseProvider?: typeof runMuseProvider
  now?: () => number
}

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
  event: MuseExecNormalizedEvent
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
    return {
      type: 'init',
      session_id: event.sessionId || '',
      provider: 'muse',
      timestamp: new Date().toISOString()
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

async function resolveApiKeyForStdin(
  deps: MuseIpcBridgeDeps,
  payload: MuseIpcRunPayload
): Promise<string | null> {
  if (typeof payload.museApiKey === 'string' && payload.museApiKey.trim()) {
    return payload.museApiKey.trim()
  }
  if (deps.readAuthJsonText) {
    const fromFile = extractMuseMetaApiKey(await deps.readAuthJsonText())
    if (fromFile) return fromFile
  }
  const fromEnv = deps.readMetaApiKeyEnv?.()
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
  return null
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

  const credentialPresent = await isMuseCredentialPresent({
    resolveBinary: deps.resolveBinary,
    readAuthJsonText: deps.readAuthJsonText,
    readMetaApiKeyEnv: deps.readMetaApiKeyEnv,
    hasInjectedCredential: deps.hasInjectedCredential
  })
  if (!credentialPresent) {
    failSetup(deps, event, payload, MUSE_LOGIN_HINT)
    return
  }

  // Presence was checked without retaining secrets; re-read only to pipe
  // `--api-key-stdin` into the isolated seat (auth.json is not inherited).
  const apiKey = await resolveApiKeyForStdin(deps, payload)

  let cancelled = false
  const cancel = () => {
    cancelled = true
  }
  deps.registerCancel?.(runId, cancel)

  const run = deps.runMuseProvider ?? runMuseProvider
  let emittedTerminalResult = false
  const startedAt = deps.now?.() ?? Date.now()
  const museSessionId = resolveMuseExecSessionId(payload.providerSessionId)

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
      apiKey,
      spawn: deps.spawn,
      shouldCancel: () => cancelled,
      onEvent: (museEvent) => {
        const compat = museExecEventToCompatPayload(museEvent)
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
