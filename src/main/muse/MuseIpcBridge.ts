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
import type {
  AgenticServiceId,
  EffectiveRunPermissions,
  TaskWraithMcpProfileId
} from '../store/types'
import type { ContextCompactionSignal } from '../../shared/contextCompaction'
import type { MuseExecNormalizedEvent } from './MuseExecJson'
import type { AcpChildProcess } from '../acp/AcpTurnClient'
import { museMspTransportEnabled, museMspSessionResumeEnabled } from '../museGate'
import { MUSE_DEFAULT_REASONING_EFFORT, resolveMuseExecSessionId } from './MuseCliArgs'
import { MUSE_MSP_CLIENT_VERSION } from './MuseMspProtocol'
import { describeMuseMspApproval } from './MuseMspApproval'
import { museMeterSnapshotToProviderStats, unavailableMuseMeterSnapshot } from './MuseUsage'
import { runMuseMspProvider, type MuseMspSpawnInput } from './MuseMspRun'
import { createMuseThinkingTranscript } from './MuseThinkingTranscript'
import {
  buildMuseTaskWraithMcpSettings,
  MUSE_TASKWRAITH_MCP_SERVER_NAME,
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
  /**
   * Main-resolved, chat-owned absolute image paths. Renderer-nominated paths
   * never reach here: `expandPdfImagePathsForPayload` has already replaced the
   * array with delivered paths (or emptied it and stamped a warning) by the
   * time the adapter runs.
   */
  imagePaths?: readonly string[]
  /** Ensemble seat identity; absent for a solo run. */
  ensembleRun?: { participantId?: string } | null
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
  /**
   * Publish the provider-exit event for this run (`sendAgentCompatExit`).
   *
   * The renderer seals a solo run — clears its active-run context, unlocks the
   * composer, applies a queued provider change, pumps the run queue — only on
   * `agent-exit`, never on the `result` compat line. Without this every Muse
   * turn completed on the main side while the chat stayed "running" in the UI.
   * Called after the terminal result and BEFORE `finishRun`: RunManager.finish
   * releases the run's persistence authority, after which the exit emitter
   * discards the event instead of publishing it.
   */
  sendExit?: (sender: unknown, exitCode: number, route: MuseIpcCompatRoute) => void
  /**
   * Chat-card sink for a Muse compaction ITEM. Wired in the composition root
   * onto `appendContextCompactionMessageToChat` + progress broadcast — the same
   * pair Codex/Claude/Kimi already use. Absent means the signal stays in-process.
   */
  onContextCompaction?: (input: {
    chatId: string
    signal: ContextCompactionSignal
    appRunId: string
    participantId?: string
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
  /**
   * Durable per-chat seat directory for the MSP lane. Lives in the composition
   * root because it needs `app.getPath('userData')`; the bridge stays
   * Electron-free. Absent (or a chat-less payload) falls back to a disposable
   * home, which simply means this turn cannot be resumed.
   */
  getSeatHome?: (
    chatId: string,
    participantId: string
  ) => { boundaryRoot: string; path: string } | null
  /**
   * Durable MSP wire-diagnostics directory — one JSONL file per run (see
   * MuseMspWireLog). Lives in the composition root because it needs
   * `app.getPath('userData')`. Absent means no wire log is written, which
   * never changes turn behavior.
   */
  museWireLogDir?: string
  /** `muse serve` child for the MSP lane; defaults to the real child process. */
  spawnMsp?: (input: MuseMspSpawnInput) => AcpChildProcess
  /**
   * Raise a TaskWraith approval card and await the verdict.
   *
   * Built in the composition root because the orchestrator closes over the run
   * manager, the permission service and a WebContents sender. Its ABSENCE is
   * meaningful: without it the MSP lane keeps exec-lane parity (`allowAll`
   * under the host sandbox) rather than selecting `onRequest` and then denying
   * everything.
   */
  requestApproval?: (input: MuseApprovalAsk) => Promise<boolean>
  /** Test seam — defaults to the real lifecycle. */
  runMuseProvider?: typeof runMuseProvider
  /** Test seam — defaults to the real MSP lifecycle. */
  runMuseMspProvider?: typeof runMuseMspProvider
  now?: () => number
}

export interface MuseApprovalAsk {
  readonly sender: unknown
  readonly service: AgenticServiceId
  readonly method: string
  readonly title: string
  readonly body: string
  readonly toolName: string
  readonly rawToolCall: Record<string, unknown> | null
  readonly workspacePath: string
  /**
   * Load-bearing. The orchestrator resolves `effectivePermissions`,
   * `workflowMode`, `ensembleRun` and `appChatId` from the RunManager by run
   * id; without it the read-only/plan posture clamp silently disappears and the
   * run behaves as though it had no permission preset at all.
   */
  readonly appRunId: string
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

/**
 * `muse serve` child for the MSP lane.
 *
 * Same shape as the exec spawn with one load-bearing difference: stdin is
 * never ended. MSP is a bidirectional JSON-RPC channel and an EOF on stdin
 * terminates the host mid-session. The unhandled-'error' guard is kept for the
 * same reason it exists on the exec lane — an 'error' on child.stdin with no
 * listener takes down Electron main, not just the turn.
 */
/**
 * Whether an MSP outcome is a HOST failure rather than a failed turn.
 *
 * `muse serve` only exists from Muse Code 1.0.3; on an older CLI the subcommand
 * is unknown and the host dies immediately, so a default-ON transport would
 * turn every turn into a hard failure for those users. A run that never
 * established a session and never published an event did not fail at the task,
 * it failed to start — and the exec lane can still do the work.
 *
 * Deliberately narrow: once a session exists or anything has streamed, the turn
 * belongs to the provider and is never silently re-run.
 */
export function museMspHostFailedToStart(outcome: MuseRunOutcome): boolean {
  return outcome.status === 'failed' && !outcome.sessionId && outcome.events.length === 0
}

/** Named fail-fast when an MSP turn advertised TaskWraith MCP without shipping the server. */
export const MUSE_MCP_PREFLIGHT_MISSING_TASKWRAITH_SERVER =
  'Muse MCP preflight: this turn advertised the TaskWraith bridge, but the composed Muse settings omit mcp_servers.taskwraith. Refusing to dispatch rather than letting a required-mode audit fail silently.'

/** True when composed run settings actually carry the app-owned TaskWraith MCP server. */
export function museComposedSettingsCarryTaskWraithMcp(
  mcpSettings: MuseMcpSettings | undefined
): boolean {
  return mcpSettings?.mcp_servers?.[MUSE_TASKWRAITH_MCP_SERVER_NAME] != null
}

/** Startup-shaped failure outcome for a host that never came up. */
function museFailedStartupOutcome(museSessionId: string): MuseRunOutcome {
  const meter = unavailableMuseMeterSnapshot(museSessionId)
  return {
    status: 'failed',
    // Empty on purpose: museMspHostFailedToStart keys on it, and a host that
    // never handshook has no provider session to name.
    sessionId: '',
    exitCode: null,
    assistantText: '',
    events: [],
    meter,
    providerStats: museMeterSnapshotToProviderStats(meter),
    warnings: [],
    argv: [],
    effort: MUSE_DEFAULT_REASONING_EFFORT,
    writeCapable: false,
    skillPinHash: '',
    leasePath: ''
  }
}

export function createChildProcessMuseMspSpawn(
  spawnImpl: NodeSpawn = nodeSpawn
): (input: MuseMspSpawnInput) => AcpChildProcess {
  return (input) => {
    const child = spawnImpl(input.binaryPath, [...input.argv], {
      cwd: input.cwd,
      env: { ...input.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false
    })
    child.stdin?.once('error', () => undefined)
    return child as unknown as AcpChildProcess
  }
}

export function createChildProcessMuseSpawn(spawnImpl: NodeSpawn = nodeSpawn): MuseRunSpawn {
  return (input) => {
    const child = spawnImpl(input.binaryPath, [...input.argv], {
      cwd: input.cwd,
      env: { ...input.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false
    })

    // The stdin payload is the API key, written the instant the child exists.
    // A muse binary that exits before draining it makes the write EPIPE, and
    // an 'error' on child.stdin with no listener is an unhandled event in
    // Electron main — the whole app, not the turn. The child's exit code and
    // stderr already say why it stopped reading, so the write failure is
    // absorbed. Same fix as the Host adapter (HostNodeMuseResources).
    child.stdin?.once('error', () => undefined)
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

/**
 * Exit code projected onto the `agent-exit` lane. The renderer reads it as
 * `exitCode === 0 ? completed : failed`; 130 mirrors the SIGINT convention the
 * renderer already stamps on an accepted cancellation.
 */
export function museExitCodeForOutcome(
  outcome: Pick<MuseRunOutcome, 'status' | 'exitCode'>
): number {
  if (outcome.status === 'success') return 0
  if (outcome.status === 'cancelled') return 130
  return typeof outcome.exitCode === 'number' && outcome.exitCode !== 0 ? outcome.exitCode : 1
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

  // Captured after the guard above: TypeScript loses the non-null narrowing
  // inside the fallback closure.
  const binaryPath = resolved.binaryPath
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

  // Prompt composition treats a missing flag as advertised (`!== false`). The
  // prepare gate above still requires `=== true`. That desync can ship a
  // settings.json with no mcp_servers.taskwraith while the prompt still names
  // the tools; `mode: 'required'` then kills the turn. Fail closed before
  // dispatch. Do not widen museMspHostFailedToStart — a wedge already has a
  // sessionId, and silently re-running that turn is forbidden.
  if (
    museMspTransportEnabled() &&
    payload.taskWraithMcpAdvertised !== false &&
    !museComposedSettingsCarryTaskWraithMcp(mcpSettings)
  ) {
    failSetup(deps, event, payload, MUSE_MCP_PREFLIGHT_MISSING_TASKWRAITH_SERVER)
    return
  }

  let cancelled = false
  let museMspStartupError: string | null = null
  const cancel = () => {
    cancelled = true
  }
  deps.registerCancel?.(runId, cancel)

  const run = deps.runMuseProvider ?? runMuseProvider
  const startedAt = deps.now?.() ?? Date.now()
  const museSessionId = resolveMuseExecSessionId(payload.providerSessionId)
  const thinking = createMuseThinkingTranscript(runId)
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

    // Work starts here, with nothing in front of it. The opening is asked for
    // INSIDE the turn now: the launch prompt carries the opening steer, and
    // `MuseAnnounceSteer` re-asks mid-turn when the model reaches for a tool
    // with no prose behind it. The private pre-turn `muse exec` that used to
    // run at this point cost ~20s of latency and a billed sub-run every turn,
    // and under Muse Code 1.1.1 its result was discarded every time.

    const emitMuseEvent = (museEvent: MuseExecNormalizedEvent): void => {
      // Publish completion once the session tail has supplied final text and
      // usage. The stdout terminal envelope alone has neither usage nor the
      // rich result payload the shared close-out/transcript consumers need.
      if (museEvent.type === 'terminal') return
      if (museEvent.type === 'thinking') {
        for (const compat of thinking.project(museEvent)) {
          deps.sendCompatLine(event.sender, compat, route)
        }
        return
      }
      const compat = museExecEventToCompatPayload(museEvent, { model: payload.model })
      if (!compat) return
      thinking.observe(compat)
      deps.sendCompatLine(event.sender, compat, route)
    }
    const emitMuseWarning = (message: string): void => {
      if (cancelled || !message) return
      deps.sendCompatLine(
        event.sender,
        { type: 'provider_warning', provider: 'muse', message },
        route
      )
    }

    const seat =
      route.appChatId && deps.getSeatHome
        ? deps.getSeatHome(route.appChatId, payload.ensembleRun?.participantId || 'solo')
        : null

    const execRun = (): Promise<MuseRunOutcome> =>
      run({
        binaryPath,
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
        onEvent: emitMuseEvent
      })

    let outcome = museMspTransportEnabled()
      ? await (deps.runMuseMspProvider ?? runMuseMspProvider)({
          binaryPath: resolved.binaryPath,
          workspacePath,
          prompt,
          runId,
          clientVersion: MUSE_MSP_CLIENT_VERSION,
          spawnMsp: deps.spawnMsp ?? createChildProcessMuseMspSpawn(),
          ...(seat ? { durableSeat: seat } : {}),
          temporaryRoot: deps.getTemporaryRoot(),
          // A seat we cannot resume into must not claim a stored session: MSP
          // rejects a resume whose log is not in THIS home, and a fresh
          // disposable home never has one.
          resumeSessionId:
            seat && museMspSessionResumeEnabled() ? payload.providerSessionId || null : null,
          model: payload.model,
          reasoningEffort: payload.reasoningEffort,
          approvalMode: payload.approvalMode,
          ultraTaskDelegationAutoAllow,
          ...(payload.imagePaths ? { imagePaths: payload.imagePaths } : {}),
          // MSP has no `--api-key-stdin`; both credential shapes travel as a
          // projected auth.json inside the seat.
          apiKey: credential.apiKey,
          authJsonText: credential.authJsonText,
          ...(mcpSettings ? { mcpSettings } : {}),
          ...(deps.museWireLogDir ? { wireLogDir: deps.museWireLogDir } : {}),
          onEvent: emitMuseEvent,
          onWarning: emitMuseWarning,
          ...(deps.onContextCompaction && route.appChatId
            ? {
                onContextCompaction: (signal: ContextCompactionSignal) => {
                  const chatId = route.appChatId
                  if (!chatId) return
                  deps.onContextCompaction!({
                    chatId,
                    signal,
                    appRunId: runId,
                    ...(payload.ensembleRun?.participantId
                      ? { participantId: payload.ensembleRun.participantId }
                      : {})
                  })
                }
              }
            : {}),
          ...(deps.requestApproval
            ? {
                onApprovalRequest: async (request) => {
                  const ask = describeMuseMspApproval(request)
                  try {
                    const allowed = await deps.requestApproval!({
                      sender: event.sender,
                      service: ask.service,
                      method: ask.method,
                      title: ask.title,
                      body: ask.body,
                      toolName: ask.toolName,
                      rawToolCall: ask.rawToolCall,
                      workspacePath,
                      appRunId: runId
                    })
                    return allowed ? 'allow' : 'deny'
                  } catch {
                    // Fail closed on the tool, not on the turn: an orchestrator
                    // fault must not cancel work the user is mid-way through.
                    return 'deny'
                  }
                }
              }
            : {}),
          shouldCancel: () => cancelled
        }).catch((error): MuseRunOutcome => {
          // A host that could not be spawned at all lands here rather than in
          // onClose; record it as a startup failure so the fallback can run.
          museMspStartupError = error instanceof Error ? error.message : String(error)
          return museFailedStartupOutcome(museSessionId)
        })
      : await execRun()

    if (museMspTransportEnabled() && !cancelled && museMspHostFailedToStart(outcome)) {
      emitMuseWarning(
        `Muse's MSP session host did not start${
          museMspStartupError ? ` (${museMspStartupError})` : ''
        }; running this turn on \`muse exec\` instead. The MSP transport needs Muse Code 1.0.3 or newer.`
      )
      outcome = await execRun()
    }

    const failed = outcome.status !== 'success'
    const resultText =
      (failed ? formatMuseFailureResultText(outcome) : undefined) || outcome.assistantText
    deps.sendCompatLine(
      event.sender,
      {
        type: 'result',
        status: outcome.status === 'cancelled' ? 'cancelled' : failed ? 'failed' : 'success',
        subtype: failed ? 'error' : 'success',
        provider: 'muse',
        // The init line pinned the id we MINTED. On the MSP lane the id the
        // provider actually used arrives with session/ready, well after that
        // line shipped; run_finished is applied last, so this is what makes a
        // resumable session id reach chat.linkedProviderSessionId.
        ...(outcome.sessionId ? { providerThreadId: outcome.sessionId } : {}),
        ...(resultText ? { result: resultText } : {}),
        stats: {
          // The work run is the only provider run in a turn now, so its usage
          // IS the turn's usage: every reported field carries through verbatim
          // (including the confidence marker), with only the host's wall-clock
          // duration re-stamped over the provider's own.
          ...outcome.providerStats,
          duration_ms: Date.now() - startedAt
        }
      },
      route
    )

    // Order is load-bearing: the exit must be published while main still holds
    // this run's persistence authority (see `MuseIpcBridgeDeps.sendExit`).
    deps.sendExit?.(event.sender, museExitCodeForOutcome(outcome), route)

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
