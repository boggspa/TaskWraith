// Devin adapter over the provider-neutral ACP turn client (src/main/acp).
//
// The bidirectional JSON-RPC state machine (initialize → session/new →
// session/prompt, session/update streaming, client-mediated
// session/request_permission, default-deny safety, transport keep-alive,
// cancellation) lives in AcpTurnClient. This file supplies only the
// Devin-shaped hooks.
//
// ── WHAT DEVIN DOES NOT NEED ───────────────────────────────────────────────
// * No clientInfo trap. `vibe-acp` forwards ACP clientInfo into Mistral API
//   request metadata and rejects empty values as an opaque -32603; no such
//   forwarding is known for `devin acp`. buildDevinInitializeParams still
//   requires a non-empty version — a required argument is cheaper than
//   discovering a second clientInfo trap in production.
// * No tool-name canonicalization. MistralAcpClient rewrites Vibe's
//   `_meta.tool_name` alias spellings into canonical TaskWraith names; that
//   quirk is Vibe's, and copying the rewrite here would canonicalize names no
//   Devin build has ever emitted. Broker detection goes straight to the
//   strict shared resolver.
// * No session config options. `vibe-acp` has no CLI surface, so Mistral must
//   push mode+model+thinking through set_config_option. Devin takes its one
//   knob (`--model`) on argv (buildDevinAcpCliArgs) and has no permission-mode
//   flag: tool approvals arrive as session/request_permission events.
// * No ACP `authenticate` call. Devin's credential lanes are the child
//   environment (WINDSURF_API_KEY normalized in) and the CLI's own
//   ~/.local/share/devin/credentials.toml — both resolved before spawn by
//   DevinCredentialLane. The ACP core has no authenticate step today; adding
//   one for the headless+api_key+api_server_url meta lane is a deliberate
//   follow-up, not a gap to improvise around.

import {
  createAcpTurnAbortController,
  runAcpTurn,
  type AcpChildProcess,
  type AcpSteerPromptContext,
  type AcpToolRecoveryContext,
  type AcpTurnHandle
} from '../acp/AcpTurnClient'
import type { AcpPermissionRequest, AcpPermissionDecision } from '../grok/GrokAcpProtocol'
import type { NormalizedGrokRunEvent } from '../grok/GrokAcpProtocol'
import { resolveStructuredTaskWraithToolRequest } from '../grok/GrokMcpAdvertise'
import { DEVIN_BROKER_MCP_TOOL_NAMESPACE, DEVIN_SCOPED_MCP_SERVER_NAME } from '../index.constants'
import { hasUltraTaskDelegationAutoAllow } from '../UltraTaskDelegationConsent'
import type { EffectiveRunPermissions } from '../store/types'

export type { AcpChildProcess } from '../acp/AcpTurnClient'

/** The client name reported in ACP initialize. */
const DEVIN_CLIENT_NAME = 'taskwraith'

/**
 * Exact provider-side broker admission. Devin's ACP permission is only the
 * hop into TaskWraith: the authenticated broker still applies the signed
 * service policy, audit ledger, workspace guards, and mutation transaction.
 */
export function devinTaskWraithBrokerToolRequested(request: AcpPermissionRequest): boolean {
  return Boolean(
    resolveStructuredTaskWraithToolRequest(request, [
      DEVIN_SCOPED_MCP_SERVER_NAME,
      DEVIN_BROKER_MCP_TOOL_NAMESPACE
    ])
  )
}

/**
 * Resolve the per-run attach decision. A signed UltraTask selection is an
 * explicit user opt-in even when the ordinary Devin advertise preference is
 * off; absent consent preserves the existing two-gate behavior.
 */
export function shouldAdvertiseTaskWraithMcpToDevin(input: {
  taskWraithMcpAdvertised: boolean
  advertiseEnabled: boolean
  effectivePermissions?: EffectiveRunPermissions | null
}): boolean {
  return (
    hasUltraTaskDelegationAutoAllow(input.effectivePermissions) ||
    (input.taskWraithMcpAdvertised && input.advertiseEnabled)
  )
}

/**
 * Build the `initialize` params for a Devin session.
 *
 * THROWS on an empty/blank version rather than emitting an empty
 * client_version — cheap insurance against a second clientInfo trap of the
 * Mistral kind. Callers pass `app.getVersion()`.
 */
export function buildDevinInitializeParams(appVersion: string): Record<string, unknown> {
  const version = typeof appVersion === 'string' ? appVersion.trim() : ''
  if (!version) {
    throw new Error(
      'Devin ACP initialize requires a non-empty app version: clientInfo.version must never be blank.'
    )
  }
  return {
    protocolVersion: 1,
    // We do not service fs/* — `onInboundRequest` is never wired in
    // production, so any fs request would be answered -32601. Never advertise
    // a capability we will not honour.
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    clientInfo: { name: DEVIN_CLIENT_NAME, version }
  }
}

/** ENOENT / spawn-failure copy naming the real binary, so a PATH problem does
 *  not read as a Devin outage. The binary is `devin`; the ACP server is the
 *  `acp` subcommand of that same binary. */
export function formatDevinProcessError(err: Error): string {
  const message = typeof err?.message === 'string' ? err.message : String(err)
  if (message.includes('ENOENT')) {
    return 'Devin could not start: the `devin` binary was not found on PATH. Install the Devin CLI (`curl -fsSL https://cli.devin.ai/install.sh | bash`) and sign in with `devin auth login` or set WINDSURF_API_KEY, then retry.'
  }
  return `Devin process error: ${message}`
}

export interface DevinAcpRunOptions {
  prompt: string
  cwd: string
  /** TaskWraith's version string, sent as ACP clientInfo.version. */
  appVersion: string
  /** Spawns `devin acp` (injected for testability). */
  spawnProcess: () => AcpChildProcess
  /**
   * MCP servers advertised to session/new. The ACP McpServer enum is
   * UNTAGGED: the stdio variant is {name, command, args, env} with NO `type`
   * discriminator — a stray `type:'stdio'` matches no variant and produces a
   * -32602 that hangs the turn.
   */
  mcpServers?: unknown[]
  onEvent: (event: NormalizedGrokRunEvent) => void
  /** Exact notification after every tool in one parallel ACP batch settles. */
  onToolBatchBoundary?: () => void
  onProcess?: (child: AcpChildProcess) => void
  /**
   * Client-mediated tool approval. Omitted = DENY, enforced by the core. A
   * missing handler is NOT neutral: it also emits a per-tool provider_warning,
   * so the seat presents as silently toolless with transcript noise.
   */
  onPermissionRequest?: (
    request: AcpPermissionRequest
  ) => AcpPermissionDecision | Promise<AcpPermissionDecision>
  onClose?: (code: number | null, turnComplete: boolean, terminalStatus?: string) => void
  onRawFrame?: (direction: 'in' | 'out', message: unknown) => void
}

export interface DevinAcpRunHandle extends AcpTurnHandle {
  closed: Promise<void>
}

export const DEVIN_TOOL_FAILURE_CONTINUITY_PROMPT =
  'The previous tool was rejected or failed. Do not end or cancel the participant turn, and ' +
  'do not blindly retry the same tool. If an applicable TaskWraith-managed route is actually ' +
  'listed, use it once for the same requested operation; otherwise continue from available ' +
  'evidence and answer in prose. If the task genuinely cannot proceed, report the exact tool, ' +
  'command, or path still needed so the user can make an informed choice.'

/**
 * Whether Devin drops a cancelled prompt's partial assistant output from
 * native session history is unmeasured. Carry the bounded tail captured by
 * AcpTurnClient so a live steer continues from what the user already saw —
 * harmless when the provider did keep the tail, decisive when it did not.
 */
export function formatDevinSteerPrompt(context: AcpSteerPromptContext): string {
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

const DEVIN_USER_DECLINED_TOOL_CONTINUITY_PROMPT =
  'The user declined the previous tool request. Respect that decision: do not retry the same ' +
  'tool, request the same permission, or substitute an equivalent side effect. Continue from ' +
  'the evidence already available and produce the best complete report you can; if a required ' +
  'step remains impossible, state it precisely without cancelling the participant turn.'

function isDevinDeniedToolTerminal(status: string | null | undefined): boolean {
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

function devinToolRecoveryPrompt(context: AcpToolRecoveryContext): string {
  return /\buser\s+(?:declined|rejected|cancelled|canceled)\b/i.test(
    context.lastFailedToolOutput || ''
  )
    ? DEVIN_USER_DECLINED_TOOL_CONTINUITY_PROMPT
    : DEVIN_TOOL_FAILURE_CONTINUITY_PROMPT
}

/**
 * Route RunManager cancellation through the ACP handle so the turn is
 * cancelled at the protocol level before RunManager's raw process-kill
 * fallback runs: `handle.cancel()` sends `session/cancel`, which lets the
 * agent stop a mid-flight tool and close the turn tidily, whereas the kill
 * fallback severs the pipe and leaves the last streamed frame unaccounted
 * for.
 */
export function createDevinTurnAbortController(handle: { cancel: () => void }): AbortController {
  return createAcpTurnAbortController(handle)
}

export function runDevinAcpTurn(options: DevinAcpRunOptions): DevinAcpRunHandle {
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  const handle = runAcpTurn({
    prompt: options.prompt,
    cwdLifetime: 'run',
    cwd: options.cwd,
    spawnProcess: options.spawnProcess,
    initializeParams: buildDevinInitializeParams(options.appVersion),
    mcpServers: options.mcpServers,
    // Fresh-session lane only: this seat opens a new session every turn
    // (devinSeatSessionsEnabled() is hard-disabled), so there is never a
    // persisted provider-side selection to re-assert.
    formatSteerPrompt: formatDevinSteerPrompt,
    onEvent: options.onEvent,
    onToolBatchBoundary: options.onToolBatchBoundary,
    onProcess: options.onProcess,
    onPermissionRequest: options.onPermissionRequest,
    // An ACP seat can terminate opaquely after a native permission denial or
    // a tool failure. Preserve the decision, then give the same session one
    // bounded chance to finish/report rather than failing the participant.
    deniedToolRecovery: {
      detect: isDevinDeniedToolTerminal,
      prompt: devinToolRecoveryPrompt,
      shouldRecover: (context) => context.toolFailureSeen && !context.assistantTextSeen,
      warning:
        'Devin stopped after a rejected or failed tool; continuing once so it can finish from available evidence.'
    },
    formatProcessError: formatDevinProcessError,
    // No measured terminator preference for `devin acp` yet — fall through to
    // the core's SIGINT default with its SIGKILL backstop rather than claiming
    // a measurement we have not taken.
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
