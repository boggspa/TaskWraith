// Mistral Vibe adapter over the provider-neutral ACP turn client (src/main/acp).
//
// The bidirectional JSON-RPC state machine (initialize → session/new →
// session/prompt, session/update streaming, client-mediated
// session/request_permission, default-deny safety, transport keep-alive,
// cancellation) lives in AcpTurnClient. This file supplies the Vibe-shaped
// hooks — and one hook that is load-bearing in a way no other seat's is.
//
// ── THE clientInfo TRAP ────────────────────────────────────────────────────
// `vibe-acp` forwards the ACP `clientInfo` straight into the metadata of every
// upstream API request. Mistral's API rejects that request outright when
// `client_name` or `client_version` is empty:
//
//   "Value error, metadata value cannot be empty" … {"client_name":"",
//    "client_version":"", "agent_entrypoint":"acp", …}
//
// The rejection surfaces to us as an opaque JSON-RPC `-32603` naming the model,
// not the field — it reads exactly like an auth or quota failure. Every prompt
// fails; the handshake and session/new both succeed first, so the lane looks
// healthy right up until the first turn.
//
// The core declares `initializeParams` as an opaque, UNVALIDATED
// `Record<string, unknown>` and supplies no clientInfo of its own — and the
// core's own test fixture (AcpTurnClient.test.ts) omits clientInfo entirely.
// A wrapper written to the type signature, or copied from that fixture, ships
// broken. So this module never exposes a raw params object: the only way to
// build one is `buildMistralInitializeParams`, which throws rather than emit an
// empty name. Do not inline an object literal at the call site.
//
// Note also that Grok hardcodes `version: '1.0.6'` and Kimi defaults to the same
// stale literal while the app ships 1.8.x. Harmless for them; here the version
// travels to Mistral on every request, so it is a required argument.
// ───────────────────────────────────────────────────────────────────────────

import {
  createAcpTurnAbortController,
  runAcpTurn,
  type AcpChildProcess,
  type AcpToolRecoveryContext,
  type AcpTurnHandle
} from '../acp/AcpTurnClient'
import type { AcpPermissionRequest, AcpPermissionDecision } from '../grok/GrokAcpProtocol'
import type { NormalizedGrokRunEvent } from '../grok/GrokAcpProtocol'
import {
  MISTRAL_BROKER_MCP_TOOL_NAMESPACE,
  MISTRAL_SCOPED_MCP_SERVER_NAME
} from '../index.constants'

export type { AcpChildProcess } from '../acp/AcpTurnClient'

/** The client name Mistral sees in request metadata. Must be non-empty. */
const MISTRAL_CLIENT_NAME = 'taskwraith'

const MISTRAL_VIBE_BROKER_TOOL_NAMESPACE_ALIASES = [
  MISTRAL_BROKER_MCP_TOOL_NAMESPACE,
  'taskwraith',
  'taskwright'
] as const
const MISTRAL_VIBE_SCOPED_TOOL_NAMESPACE_ALIASES = [
  MISTRAL_SCOPED_MCP_SERVER_NAME,
  'taskwraith-mistral',
  'taskwraith_mistral',
  'taskwraith-glm',
  'taskwraith_glm',
  'taskwraith-zai',
  'taskwraith_zai',
  'taskwraith-zai-glm',
  'taskwraith_zai_glm',
  'taskwright-mistral',
  'taskwright_mistral',
  'taskwright-glm',
  'taskwright_glm',
  'taskwright-zai',
  'taskwright_zai',
  'taskwright-zai-glm',
  'taskwright_zai_glm'
] as const
const MISTRAL_VIBE_TOOL_NAMESPACE_ALIASES: readonly {
  canonical: string
  aliases: readonly string[]
}[] = [
  {
    canonical: MISTRAL_BROKER_MCP_TOOL_NAMESPACE,
    aliases: MISTRAL_VIBE_BROKER_TOOL_NAMESPACE_ALIASES
  },
  {
    canonical: MISTRAL_SCOPED_MCP_SERVER_NAME,
    aliases: MISTRAL_VIBE_SCOPED_TOOL_NAMESPACE_ALIASES
  }
]

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function canonicalVibeTaskWraithToolName(machineName: unknown): string | null {
  if (typeof machineName !== 'string') return null
  const trimmedName = machineName.trim()
  const normalizedName = trimmedName.toLowerCase()
  if (!trimmedName) return null
  for (const { canonical, aliases } of MISTRAL_VIBE_TOOL_NAMESPACE_ALIASES) {
    for (const alias of aliases) {
      const lowerAlias = alias.toLowerCase()
      const doubleUnderscorePrefix = `${lowerAlias}__`
      const singleUnderscorePrefix = `${lowerAlias}_`
      const prefixLength =
        normalizedName.startsWith(doubleUnderscorePrefix) ? lowerAlias.length + 2
        : normalizedName.startsWith(singleUnderscorePrefix) &&
          normalizedName.charAt(lowerAlias.length) === '_'
          ? lowerAlias.length + 1
          : 0
      if (!prefixLength) continue
      if (trimmedName.length <= prefixLength) continue
      return `${canonical}__${trimmedName.slice(prefixLength)}`
    }
  }
  return null
}

function patchIfTaskWraithAlias(
  holder: Record<string, unknown> | null | undefined,
  key: string,
  canonicalName: string,
  patch: Record<string, unknown>
): boolean {
  if (!holder || typeof holder[key] !== 'string') return false
  const candidate = holder[key]
  if (typeof candidate !== 'string') return false
  const normalized = canonicalVibeTaskWraithToolName(candidate)
  if (normalized !== canonicalName || candidate === canonicalName) return false
  patch[key] = canonicalName
  return true
}

/**
 * Normalize Vibe's structured MCP identity into the spelling consumed by the
 * existing strict TaskWraith resolver.
 *
 * This deliberately ignores ACP `title`/`toolName`: those are human labels.
 * Vibe 2.23.x puts the model's exact published tool name in the correlated
 * tool-call `_meta.tool_name` field and marks generic MCP effects as
 * `_meta.effect_kind='tool'` + `kind='other'`. Native write/bash calls carry
 * different kinds and metadata, so they remain on the normal permission path.
 * The returned descriptor is local permission evidence only; it does not
 * rewrite the provider invocation or bypass the broker's signed mutation gate.
 * When Vibe omits rawInput from ACP, the broker still validates the provider's
 * original invocation arguments before any operation executes.
 */
export function normalizeMistralVibePermissionRequest(
  request: AcpPermissionRequest
): AcpPermissionRequest {
  const rawToolCall = record(request.rawToolCall)
  const metadata = record(rawToolCall?._meta)
  if (!rawToolCall || !metadata) return request
  const rawInputValue = rawToolCall.rawInput
  if (rawInputValue !== undefined && rawInputValue !== null && !record(rawInputValue)) {
    return request
  }
  const rawInput = record(rawInputValue) || {}
  if (rawToolCall.kind !== 'other' || metadata.effect_kind !== 'tool') return request
  if (request.toolKind && request.toolKind !== 'other') return request

  const snakeToolInput = record(rawInput.tool_input)
  const camelToolInput = record(rawInput.toolInput)
  if (snakeToolInput && camelToolInput) return request
  const nestedToolInput = snakeToolInput || camelToolInput
  const identityCandidates = [
    rawToolCall.tool_name,
    rawToolCall.toolName,
    rawToolCall.name,
    rawInput.tool_name,
    rawInput.toolName,
    nestedToolInput?.tool_name,
    nestedToolInput?.toolName,
    metadata.tool_name
  ]
  const canonicalNames = identityCandidates.flatMap((identity) => {
    const canonicalName = canonicalVibeTaskWraithToolName(identity)
    return canonicalName ? [canonicalName] : []
  })
  const canonicalName = canonicalNames[0]
  if (!canonicalName) return request
  if (
    canonicalNames.some((candidate) => candidate !== canonicalName) ||
    identityCandidates.some((identity) => {
      if (identity === undefined) return false
      return canonicalVibeTaskWraithToolName(identity) !== canonicalName
    })
  ) {
    return request
  }

  const rawInputPatch: Record<string, unknown> = {
    ...(rawInput.tool_name !== canonicalName ? { tool_name: canonicalName } : {}),
    ...(Object.keys(rawInput).length === 0 ? { tool_name: canonicalName } : {})
  }
  if (Object.keys(rawInputPatch).length === 0 && rawInput.tool_name === canonicalName) {
    if (Object.keys(rawInput).length > 0) return request
  }
  const rawToolCallPatch: Record<string, unknown> = {}
  patchIfTaskWraithAlias(rawToolCall, 'tool_name', canonicalName, rawToolCallPatch)
  patchIfTaskWraithAlias(rawToolCall, 'toolName', canonicalName, rawToolCallPatch)
  patchIfTaskWraithAlias(rawToolCall, 'name', canonicalName, rawToolCallPatch)
  if (nestedToolInput) {
    const nestedInputPatch: Record<string, unknown> = {}
    const didPatchNestedToolName =
      patchIfTaskWraithAlias(nestedToolInput, 'tool_name', canonicalName, nestedInputPatch) ||
      patchIfTaskWraithAlias(nestedToolInput, 'toolName', canonicalName, nestedInputPatch)
    if (didPatchNestedToolName) {
      if (rawInput.tool_input) {
        rawInputPatch.tool_input = {
          ...(snakeToolInput || {}),
          ...(nestedInputPatch as Record<string, unknown>)
        }
      } else if (rawInput.toolInput) {
        rawInputPatch.toolInput = {
          ...(camelToolInput || {}),
          ...(nestedInputPatch as Record<string, unknown>)
        }
      }
    }
  }
  if (
    Object.keys(rawToolCallPatch).length === 0 &&
    Object.keys(rawInputPatch).length === 0
  ) {
    return request
  }
  const nextRawInput =
    Object.keys(rawInputPatch).length > 0 ? { ...rawInput, ...rawInputPatch } : rawInput
  return {
    ...request,
    rawToolCall: {
      ...rawToolCall,
      ...rawToolCallPatch,
      rawInput: nextRawInput
    }
  }
}

/**
 * Build the `initialize` params for a Vibe session.
 *
 * THROWS on an empty/blank version rather than letting an empty `client_version`
 * reach Mistral, because the resulting 422 is indistinguishable from an auth
 * failure at the call site. Callers pass `app.getVersion()`.
 */
export function buildMistralInitializeParams(appVersion: string): Record<string, unknown> {
  const version = typeof appVersion === 'string' ? appVersion.trim() : ''
  if (!version) {
    throw new Error(
      'Mistral ACP initialize requires a non-empty app version: vibe-acp forwards clientInfo into Mistral API request metadata, and an empty client_version is rejected as an opaque -32603.'
    )
  }
  return {
    protocolVersion: 1,
    // We do not service fs/* — `onInboundRequest` is never wired in production,
    // so any fs request would be answered -32601. Never advertise a capability
    // we will not honour.
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    clientInfo: { name: MISTRAL_CLIENT_NAME, version }
  }
}

/** ENOENT / spawn-failure copy naming the real binary, so a PATH problem does
 *  not read as a Mistral outage. The binary is `vibe-acp`, NOT `mistral` and
 *  NOT `vibe` — `vibe` is the interactive TUI and will hang a run. */
export function formatMistralProcessError(err: Error): string {
  const message = typeof err?.message === 'string' ? err.message : String(err)
  if (message.includes('ENOENT')) {
    return 'Mistral Vibe could not start: the `vibe-acp` binary was not found on PATH. Install the Mistral Vibe CLI (it installs `vibe` and `vibe-acp` side by side) and sign in with `vibe --setup`, then retry.'
  }
  return `Mistral Vibe process error: ${message}`
}

export interface MistralAcpRunOptions {
  prompt: string
  cwd: string
  /** TaskWraith's version string, forwarded to Mistral as `client_version`. */
  appVersion: string
  /** Spawns `vibe-acp` (injected for testability). */
  spawnProcess: () => AcpChildProcess
  /**
   * MCP servers advertised to session/new. vibe-acp accepts stdio servers
   * directly — its session/new signature takes
   * `list[HttpMcpServer | SseMcpServer | McpServerStdio | AcpMcpServer]` — so
   * this seat uses the Grok-style direct path and needs no loopback HTTP bridge.
   * The ACP McpServer enum is UNTAGGED: do not add a `type: 'stdio'` discriminator,
   * which matches no variant and produces a -32602 that hangs the turn.
   */
  mcpServers?: unknown[]
  /**
   * Config selections applied to the fresh session after `session/new` and
   * before the prompt.
   *
   * THE ONLY PLACE THIS SEAT CAN BE CONFIGURED AT ALL. `vibe-acp` has no CLI
   * surface (`[-h] [-v] [--setup]`) and `buildMistralAcpCliArgs()` returns an
   * empty argv, so BOTH the permission mode and the model travel here or not at
   * all. Omit the `mode` option and a read-only seat runs write-capable; omit
   * the `model` option and the turn silently uses whatever `active_model` sits
   * in the user's global `~/.vibe/config.toml`. Neither failure announces
   * itself — the session opens, the prompt succeeds, and the wrong thing runs.
   *
   * Build the `mode` value with `mistralSessionModeForSeat` (MistralCliArgs),
   * never a literal: the ungated `accept-edits` / `auto-approve` modes are
   * unreachable through that helper by design.
   */
  sessionConfigOptions?: ReadonlyArray<{ configId: string; value: string }>
  onEvent: (event: NormalizedGrokRunEvent) => void
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

export interface MistralAcpRunHandle extends AcpTurnHandle {
  closed: Promise<void>
}

export const MISTRAL_TOOL_FAILURE_CONTINUITY_PROMPT =
  'The previous tool was rejected or failed. Do not end or cancel the participant turn, and ' +
  'do not blindly retry the same tool. If an applicable TaskWraith-managed route is actually ' +
  'listed, use it once for the same requested operation; otherwise continue from available ' +
  'evidence and answer in prose. If the task genuinely cannot proceed, report the exact tool, ' +
  'command, or path still needed so the user can make an informed choice.'

const MISTRAL_USER_DECLINED_TOOL_CONTINUITY_PROMPT =
  'The user declined the previous tool request. Respect that decision: do not retry the same ' +
  'tool, request the same permission, or substitute an equivalent side effect. Continue from ' +
  'the evidence already available and produce the best complete report you can; if a required ' +
  'step remains impossible, state it precisely without cancelling the participant turn.'

function isMistralDeniedToolTerminal(status: string | null | undefined): boolean {
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

function mistralToolRecoveryPrompt(context: AcpToolRecoveryContext): string {
  return /\buser\s+(?:declined|rejected|cancelled|canceled)\b/i.test(
    context.lastFailedToolOutput || ''
  )
    ? MISTRAL_USER_DECLINED_TOOL_CONTINUITY_PROMPT
    : MISTRAL_TOOL_FAILURE_CONTINUITY_PROMPT
}

/**
 * Route RunManager cancellation through the ACP handle so the turn is cancelled
 * at the protocol level before RunManager's raw process-kill fallback runs.
 *
 * Worth having even though Vibe terminates cleanly on every signal we measured:
 * `handle.cancel()` sends `session/cancel`, which lets the agent stop a
 * mid-flight tool and close the turn tidily, whereas the kill fallback severs
 * the pipe and leaves the last streamed frame unaccounted for.
 */
export function createMistralTurnAbortController(handle: { cancel: () => void }): AbortController {
  return createAcpTurnAbortController(handle)
}

export function runMistralAcpTurn(options: MistralAcpRunOptions): MistralAcpRunHandle {
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  const handle = runAcpTurn({
    prompt: options.prompt,
    cwd: options.cwd,
    spawnProcess: options.spawnProcess,
    initializeParams: buildMistralInitializeParams(options.appVersion),
    mcpServers: options.mcpServers,
    // Fresh-session lane only. `resumeConfigOptions` is deliberately NOT set:
    // this seat opens a new session every turn (mistralSeatSessionsEnabled() is
    // hard-disabled), so there is never a persisted provider-side selection to
    // re-assert.
    sessionConfigOptions: options.sessionConfigOptions,
    onEvent: options.onEvent,
    onProcess: options.onProcess,
    onPermissionRequest: options.onPermissionRequest
      ? (request) => options.onPermissionRequest!(normalizeMistralVibePermissionRequest(request))
      : undefined,
    // Vibe can terminate opaquely after a native permission denial or an ACP
    // tool failure. Preserve the decision, then give the same session one
    // bounded chance to finish/report rather than failing the participant.
    deniedToolRecovery: {
      detect: isMistralDeniedToolTerminal,
      prompt: mistralToolRecoveryPrompt,
      shouldRecover: (context) => context.toolFailureSeen && !context.assistantTextSeen,
      warning:
        'Mistral stopped after a rejected or failed tool; continuing once so it can finish from available evidence.'
    },
    formatProcessError: formatMistralProcessError,
    // MEASURED, not assumed (2026-07-26, vibe-acp 2.22.0): all three terminators
    // produce a clean `close` with exit code 0 in ~165ms — SIGTERM 165ms,
    // SIGINT 164ms, stdin EOF 167ms. So unlike `kimi acp`, which ignores both
    // signals and exits only on stdin EOF, Vibe cannot strand a turn behind the
    // core's 4s SIGKILL backstop whichever we pick. SIGTERM is explicit here
    // rather than falling through to the core's SIGINT default purely so a
    // reader sees the choice was verified.
    endProcess: (child) => child.kill('SIGTERM'),
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
