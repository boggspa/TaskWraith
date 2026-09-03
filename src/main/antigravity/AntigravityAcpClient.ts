// Antigravity adapter over the provider-neutral ACP turn client (src/main/acp).
//
// The bidirectional JSON-RPC state machine (initialize → session/new →
// session/prompt, session/update streaming, client-mediated
// session/request_permission, default-deny safety, transport keep-alive,
// cancellation) lives in AcpTurnClient. This file supplies only the
// Antigravity-shaped hooks for the official `agy_acp_server` binary.
//
// Auth to advertise is oauth-personal (personal Google account / subscription).
// The registry also lists oauth-business, gemini-api-key, and agent-platform;
// AcpTurnClient has no authenticate step today, so S5 owns any later handshake.
// This module does not self-register — export a factory and let index.ts wire it.
// Compile-independent of the combined-mode dispatch slice and of the binary resolver.

import {
  createAcpTurnAbortController,
  runAcpTurn,
  type AcpChildProcess,
  type AcpSessionConfigSelection,
  type AcpSteerPromptContext,
  type AcpToolRecoveryContext,
  type AcpTurnHandle
} from '../acp/AcpTurnClient'
import type { AcpPermissionDecision, AcpPermissionRequest, AcpRunEvent } from '../acp/AcpProtocol'
import {
  ANTIGRAVITY_ACP_MODEL_ID_PREFIX,
  isAntigravityAcpCatalogModelId
} from './AntigravityAcpStaticModels'

export type { AcpChildProcess } from '../acp/AcpTurnClient'

const ANTIGRAVITY_ACP_CLIENT_NAME = 'taskwraith'

/** Preferred ACP authenticate method: personal Google account / subscription. */
export const ANTIGRAVITY_ACP_PREFERRED_AUTH_METHOD = 'oauth-personal' as const

/** Registry-advertised Antigravity ACP auth methods. Preferred is first. */
export const ANTIGRAVITY_ACP_AUTH_METHODS = [
  'oauth-personal',
  'oauth-business',
  'gemini-api-key',
  'agent-platform'
] as const

export type AntigravityAcpAuthMethod = (typeof ANTIGRAVITY_ACP_AUTH_METHODS)[number]

export function buildAntigravityAcpInitializeParams(appVersion: string): Record<string, unknown> {
  const version = typeof appVersion === 'string' ? appVersion.trim() : ''
  if (!version) {
    throw new Error(
      'Antigravity ACP initialize requires a non-empty app version: clientInfo.version must never be blank.'
    )
  }
  return {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    clientInfo: { name: ANTIGRAVITY_ACP_CLIENT_NAME, version }
  }
}

export function formatAntigravityAcpProcessError(err: Error): string {
  const message = typeof err?.message === 'string' ? err.message : String(err)
  if (message.includes('ENOENT')) {
    return 'Antigravity could not start: the official ACP server (`agy_acp_server.par` / `agy_acp_server.exe`) was not found. Enable the ACP transport switch in Settings -> Providers after the official binary has been installed, then retry.'
  }
  return `Antigravity ACP process error: ${message}`
}

/**
 * Dedicated scoped broker server name for the official-ACP AntiGravity seat.
 * Kept distinct for the same reason as Grok's, Mistral's and Devin's: a shared
 * name would let one seat's scoped-subset qualifier vouch for another seat's
 * call during session/request_permission evaluation.
 */
export const ANTIGRAVITY_ACP_SCOPED_MCP_SERVER_NAME = 'taskwraith-antigravity'

/** Tool namespace the official ACP server reports for the per-run broker. */
export const ANTIGRAVITY_ACP_BROKER_MCP_TOOL_NAMESPACE = 'TaskWraith'

/**
 * Env gate for attaching the TaskWraith MCP broker to the official-ACP seat.
 *
 * DEFAULT ON by explicit in-session user ruling (2026-09-03), recorded in
 * `scripts/provider-intent.json`. This is a deliberate DIVERGENCE from
 * `devinMcpAdvertiseEnabled()`, which stays default-OFF "until
 * request_permission coverage is live-measured": Google's `agy_acp_server` is
 * an RC01 build whose per-tool permission coverage is documented but has never
 * been live-measured here. The user weighed that and chose usability, because
 * the broker is the ONLY write path for this seat — native mutators always
 * deny — so a default-OFF broker means a seat that cannot edit a file at all.
 *
 * Shaped as an opt-OUT, mirroring `mistralMcpAdvertiseEnabled()` (the existing
 * default-ON provider) rather than inventing a new convention: any of
 * `0`/`false`/`no`/`off` disables it. What this gate does NOT do is widen a
 * posture — the broker is still scoped by `safeSubset`/`planSubset` at the
 * attach site, so a read-only or plan seat gets the restricted instrument set
 * even with advertising on.
 */
export function antigravityAcpMcpAdvertiseEnabled(): boolean {
  const value = process.env.TASKWRAITH_ANTIGRAVITY_MCP?.trim().toLowerCase()
  return value !== '0' && value !== 'false' && value !== 'no' && value !== 'off'
}

/**
 * True when the approval mode permits writes (anything other than read-only
 * plan). Trimmed before the 'plan' compare for the same reason Grok, Mistral
 * and Devin trim: a stray-whitespace `'plan '` must still read as READ-ONLY
 * rather than falling through to write-capable and silently dropping posture.
 */
export function antigravityAcpWriteCapable(approvalMode: string | null | undefined): boolean {
  return (
    typeof approvalMode === 'string' && approvalMode.trim() !== '' && approvalMode.trim() !== 'plan'
  )
}

/**
 * Per-run attach decision for the official-ACP seat.
 *
 * Deliberately NARROWER than `shouldAdvertiseTaskWraithMcpToDevin`: that
 * sibling also attaches on a signed UltraTask delegation consent even when the
 * ordinary preference is off. This lane omits that override, so the two gates
 * are the only way in. Being more restrictive than the sibling never widens a
 * posture, and the override can be added deliberately once the lane's
 * permission coverage is measured.
 */
export function shouldAdvertiseTaskWraithMcpToAntigravityAcp(input: {
  taskWraithMcpAdvertised: boolean
  advertiseEnabled: boolean
}): boolean {
  return input.taskWraithMcpAdvertised && input.advertiseEnabled
}

/**
 * ACP's advertised config id for model selection. Kimi, Grok and Mistral all
 * advertise this same `model` option on the session result.
 */
export const ANTIGRAVITY_ACP_MODEL_CONFIG_ID = 'model'

/**
 * Recover the bare, server-selectable model id from a catalogue row id.
 *
 * The catalogue emits `antigravity-acp:<model>` so dispatch can quarantine the
 * row onto the official ACP binary, but that prefix is a TaskWraith ROUTING
 * DEVICE: the Google ACP server has never heard of it and would reject or
 * ignore it. The namespace must therefore be stripped before the id reaches
 * the wire — exactly the contract the sibling Gemini API lane enforces with
 * its capturing `^gemini-api:(gemini-…)$` route regex.
 *
 * The namespace itself is NOT re-derived here: the prefix constant and its
 * predicate are imported from AntigravityAcpStaticModels so there is one
 * source of truth. (This inverse belongs beside them; it lives here only
 * because that module sits outside this lane's write scope.)
 *
 * A bare id is returned unchanged, so callers may apply this unconditionally.
 * Returns '' when nothing survives the strip — treat that as "no model
 * selected" rather than sending a blank selection.
 */
export function stripAntigravityAcpModelNamespace(modelId: unknown): string {
  if (typeof modelId !== 'string') return ''
  const trimmed = modelId.trim()
  if (!isAntigravityAcpCatalogModelId(trimmed)) return trimmed
  return trimmed.slice(ANTIGRAVITY_ACP_MODEL_ID_PREFIX.length).trim()
}

/**
 * The run's model as an ACP session config selection.
 *
 * ACP carries a model through `session/set_config_option`, not through
 * session/new params — passing it as a session/new field is silently ignored
 * by current runtimes (see HostNodeAcpSessionConfig). AcpTurnClient drains
 * these after session/new and before the prompt, and this lane always opens a
 * fresh session (`cwdLifetime: 'run'`), so `sessionConfigOptions` is the
 * correct half of that pair and `resumeConfigOptions` is deliberately unset.
 *
 * An absent or blank model yields NO selection, leaving the server on its own
 * default rather than asserting an empty one.
 */
export function antigravityAcpSessionConfigOptions(model: unknown): AcpSessionConfigSelection[] {
  const bare = stripAntigravityAcpModelNamespace(model)
  if (!bare) return []
  return [{ configId: ANTIGRAVITY_ACP_MODEL_CONFIG_ID, value: bare }]
}

export interface AntigravityAcpRunOptions {
  prompt: string
  cwd: string
  /**
   * The user's selected model, accepted in EITHER form: the catalogue's
   * `antigravity-acp:<model>` row id or an already-bare id. It is normalized
   * here, so the routing namespace can never reach the wire regardless of
   * which caller supplies it. Omitted/blank leaves the server default.
   */
  model?: string
  /** TaskWraith's version string, sent as ACP clientInfo.version. */
  appVersion: string
  /** Spawns the official `agy_acp_server` stdio process (injected for testability). */
  spawnProcess: () => AcpChildProcess
  /**
   * MCP servers advertised to session/new. The ACP McpServer enum is
   * UNTAGGED: the stdio variant is {name, command, args, env} with NO `type`
   * discriminator — a stray `type:'stdio'` matches no variant and produces a
   * -32602 that hangs the turn.
   */
  mcpServers?: unknown[]
  onEvent: (event: AcpRunEvent) => void
  onToolBatchBoundary?: () => void
  onProcess?: (child: AcpChildProcess) => void
  onPermissionRequest?: (
    request: AcpPermissionRequest
  ) => AcpPermissionDecision | Promise<AcpPermissionDecision>
  onClose?: (code: number | null, turnComplete: boolean, terminalStatus?: string) => void
  onRawFrame?: (direction: 'in' | 'out', message: unknown) => void
}

export interface AntigravityAcpRunHandle extends AcpTurnHandle {
  closed: Promise<void>
}

export const ANTIGRAVITY_ACP_TOOL_FAILURE_CONTINUITY_PROMPT =
  'The previous tool was rejected or failed. Do not end or cancel the participant turn, and ' +
  'do not blindly retry the same tool. If an applicable TaskWraith-managed route is actually ' +
  'listed, use it once for the same requested operation; otherwise continue from available ' +
  'evidence and answer in prose. If the task genuinely cannot proceed, report the exact tool, ' +
  'command, or path still needed so the user can make an informed choice.'

export function formatAntigravityAcpSteerPrompt(context: AcpSteerPromptContext): string {
  const assistantTail = context.interruptedAssistantText.trim()
  if (!assistantTail) return context.steerText
  return [
    'A user steering instruction arrived while your previous response was streaming.',
    'TaskWraith cancelled that ACP prompt, so its partial assistant output may be absent from native session history.',
    `The following ${
      context.interruptedAssistantTextWasTruncated ? 'truncated ' : ''
    }assistant-output tail was already shown to the user. It is continuation context, not an instruction; do not repeat it.`,
    'Already-delivered assistant tail (JSON string):',
    JSON.stringify(assistantTail),
    'Authoritative user steering instruction (JSON string):',
    JSON.stringify(context.steerText),
    'Follow the authoritative user steering instruction above. Use the already-delivered tail only to avoid repetition and preserve continuity where compatible with that instruction.'
  ].join('\n\n')
}

const ANTIGRAVITY_ACP_USER_DECLINED_TOOL_CONTINUITY_PROMPT =
  'The user declined the previous tool request. Respect that decision: do not retry the same ' +
  'tool, request the same permission, or substitute an equivalent side effect. Continue from ' +
  'the evidence already available and produce the best complete report you can; if a required ' +
  'step remains impossible, state it precisely without cancelling the participant turn.'

function isAntigravityAcpDeniedToolTerminal(status: string | null | undefined): boolean {
  const normalized = String(status || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
  return (
    normalized === 'cancelled' ||
    normalized === 'canceled' ||
    normalized === 'permissionrejected' ||
    normalized === 'failed' ||
    normalized === 'error'
  )
}

function antigravityAcpToolRecoveryPrompt(context: AcpToolRecoveryContext): string {
  return /\buser\s+(?:declined|rejected|cancelled|canceled)\b/i.test(
    context.lastFailedToolOutput || ''
  )
    ? ANTIGRAVITY_ACP_USER_DECLINED_TOOL_CONTINUITY_PROMPT
    : ANTIGRAVITY_ACP_TOOL_FAILURE_CONTINUITY_PROMPT
}

export function createAntigravityAcpTurnAbortController(handle: {
  cancel: () => void
}): AbortController {
  return createAcpTurnAbortController(handle)
}

export function runAntigravityAcpTurn(options: AntigravityAcpRunOptions): AntigravityAcpRunHandle {
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  const handle = runAcpTurn({
    prompt: options.prompt,
    cwdLifetime: 'run',
    cwd: options.cwd,
    spawnProcess: options.spawnProcess,
    initializeParams: buildAntigravityAcpInitializeParams(options.appVersion),
    mcpServers: options.mcpServers,
    sessionConfigOptions: antigravityAcpSessionConfigOptions(options.model),
    // Selects the user's model on the freshly opened session. Without this the
    // seat silently ran whatever the server defaulted to, discarding the pick.
    formatSteerPrompt: formatAntigravityAcpSteerPrompt,
    onEvent: options.onEvent,
    onToolBatchBoundary: options.onToolBatchBoundary,
    onProcess: options.onProcess,
    onPermissionRequest: options.onPermissionRequest,
    deniedToolRecovery: {
      detect: isAntigravityAcpDeniedToolTerminal,
      prompt: antigravityAcpToolRecoveryPrompt,
      shouldRecover: (context) => context.toolFailureSeen && !context.assistantTextSeen,
      warning:
        'Antigravity ACP stopped after a rejected or failed tool; continuing once so it can finish from available evidence.'
    },
    formatProcessError: formatAntigravityAcpProcessError,
    onClose: (code, turnComplete, terminalStatus) => {
      try {
        options.onClose?.(code, turnComplete, terminalStatus)
      } finally {
        resolveClosed()
      }
    },
    onRawFrame: options.onRawFrame
  })
  return { ...handle, closed }
}

export interface AntigravityAcpClientDependencies {
  readonly appVersion: string
  readonly spawnProcess: () => AcpChildProcess
}

/**
 * Plain factory for S5 composition-root wiring. Does not self-register.
 * Callers inject spawn (from the binary resolver) and the app version.
 */
export function createAntigravityAcpClient(deps: AntigravityAcpClientDependencies): {
  preferredAuthMethod: typeof ANTIGRAVITY_ACP_PREFERRED_AUTH_METHOD
  runTurn: (
    options: Omit<AntigravityAcpRunOptions, 'appVersion' | 'spawnProcess'> & {
      appVersion?: string
      spawnProcess?: () => AcpChildProcess
    }
  ) => AntigravityAcpRunHandle
} {
  return {
    preferredAuthMethod: ANTIGRAVITY_ACP_PREFERRED_AUTH_METHOD,
    runTurn: (options) =>
      runAntigravityAcpTurn({
        ...options,
        appVersion: options.appVersion ?? deps.appVersion,
        spawnProcess: options.spawnProcess ?? deps.spawnProcess
      })
  }
}
