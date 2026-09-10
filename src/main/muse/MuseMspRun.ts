/**
 * The MSP lane's `MuseRunInput` -> `MuseRunOutcome` implementation.
 *
 * Deliberately shaped as a drop-in for `runMuseProvider` (MuseRun.ts) so the
 * transport swap in `MuseIpcBridge` is one line and nothing downstream — the
 * result compat line, the exit-before-finish ordering, the thinking transcript
 * — has to know which lane produced the outcome.
 *
 * What differs from the exec lane, and why:
 *
 * - The home is a DURABLE per-chat seat (MuseIsolatedHome `durableSeat`), not a
 *   disposable mkdtemp. `session/resume` reads the log out of
 *   XDG_DATA_HOME/muse/sessions, so a home destroyed at teardown can never be
 *   resumed. Everything except that log is still scrubbed on both attach and
 *   teardown.
 * - Usage comes off the wire (`session/tokenUsage`, `session/contextUsage`)
 *   rather than from a tailed session.jsonl, so it carries the provider's own
 *   window size — which no hand-kept table can.
 * - Images are real input parts rather than a warning about omitted files.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import type { AcpChildProcess } from '../acp/AcpTurnClient'
import { loadMainAuthorizedAcpImageContents } from '../acp/AcpTurnClient'
import {
  buildMuseServeArgv,
  MUSE_DEFAULT_PROVIDER,
  museWriteCapable,
  normalizeMuseReasoningEffort,
  type MuseReasoningEffort,
  type MuseSandboxNetworkMode
} from './MuseCliArgs'
import type { ContextCompactionSignal } from '../../shared/contextCompaction'
import type { MuseExecNormalizedEvent } from './MuseExecJson'
import { museAnnounceSteerAppliesToPrompt } from './MuseAnnounceSteer'
import { composeMuseLaunchPrompt } from './MuseLongTurnProgress'
import { createMuseIsolatedHome, projectMuseAuthJson } from './MuseIsolatedHome'
import type { MuseIsolatedHomeLease } from './MuseIsolatedHome'
import { buildMuseSkillPinSettings } from './MuseSkillPin'
import type { MuseMcpSettings } from './MuseMcpConfig'
import {
  runMuseMspTurn,
  type MuseMspApprovalVerdict,
  type MuseMspContextSnapshot,
  type MuseMspSessionReadyInfo,
  type MuseMspUsageSnapshot
} from './MuseMspClient'
import type {
  MuseMspApprovalMode,
  MuseMspApprovalRequest,
  MuseMspReasoningEffort,
  MuseMspTurnError,
  MuseMspTurnInputPart
} from './MuseMspProtocol'
import type { MuseRunOutcome, MuseRunStatus } from './MuseRun'
import {
  readMuseSessionLogTerminal,
  resolveMuseSessionLogPath,
  type MuseSessionLogResolveResult
} from './MuseSessionLog'
import {
  MUSE_MSP_USAGE_SOURCE,
  MUSE_TOKEN_COUNT_REPORTED,
  MUSE_TOKEN_COUNT_UNAVAILABLE,
  museMeterSnapshotToProviderStats,
  type MuseMeterSnapshot
} from './MuseUsage'

export interface MuseMspSpawnInput {
  readonly binaryPath: string
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

export interface MuseMspRunInput {
  readonly binaryPath: string
  readonly workspacePath: string
  readonly prompt: string
  readonly runId: string
  /**
   * The acknowledgment already shown to the user. Folded into the launch
   * prompt exactly as the exec lane does — without it the model repeats its
   * introduction and the two lanes answer the same prompt differently.
   */
  readonly introductionText?: string | null
  readonly clientVersion: string
  /** Bidirectional stdio child for `muse serve`; MSP writes to stdin. */
  readonly spawnMsp: (input: MuseMspSpawnInput) => AcpChildProcess
  /**
   * Durable per-chat seat. Required for resume to mean anything; when absent
   * the lane still runs, against a disposable home under `temporaryRoot`.
   */
  readonly durableSeat?: Readonly<{ boundaryRoot: string; path: string }>
  readonly temporaryRoot: string
  /** Stored MSP session id; a non-empty value asks for `session/resume`. */
  readonly resumeSessionId?: string | null
  readonly model?: string | null
  readonly reasoningEffort?: string | null
  readonly approvalMode?: string | null
  readonly sandboxNetwork?: MuseSandboxNetworkMode
  readonly trustWorkspace?: boolean
  readonly ultraTaskDelegationAutoAllow?: boolean
  /** Main-authorized, chat-owned absolute paths. Never renderer-nominated. */
  readonly imagePaths?: readonly string[]
  /**
   * BYOK / META_API_KEY. The exec lane pipes this through `--api-key-stdin`;
   * MSP owns stdin for JSON-RPC, so there is no key channel on the wire and the
   * key is projected as an api-key auth.json into the seat instead.
   */
  readonly apiKey?: string | null
  readonly authJsonText?: string | null
  readonly mcpSettings?: MuseMcpSettings
  readonly sourceEnvironment?: NodeJS.ProcessEnv
  readonly onEvent?: (event: MuseExecNormalizedEvent) => void
  readonly onWarning?: (message: string) => void
  readonly onSessionReady?: (info: MuseMspSessionReadyInfo) => void
  /** Compaction ITEM lifecycle from the client — occupancy pressure never arrives here. */
  readonly onContextCompaction?: (signal: ContextCompactionSignal) => void
  readonly onApprovalRequest?: (
    request: MuseMspApprovalRequest
  ) => MuseMspApprovalVerdict | Promise<MuseMspApprovalVerdict>
  readonly shouldCancel?: () => boolean
  readonly cancelPollIntervalMs?: number
  readonly now?: () => number
  readonly createHome?: typeof createMuseIsolatedHome
  readonly loadImages?: typeof loadMainAuthorizedAcpImageContents
  /** Bound on the session-log lookup used to adopt a missing terminal. */
  readonly sessionLogResolveTimeoutMs?: number
  /** Injected resolver (tests / parity with the exec lane). */
  readonly resolveSessionLog?: (input: {
    dataHome: string
    sessionId: string
  }) => Promise<MuseSessionLogResolveResult>
}

/**
 * Clock skew tolerance when deciding whether a logged terminal belongs to THIS
 * run. Small enough that a previous turn — minutes old on any real resume —
 * still falls outside the window.
 */
const MUSE_SESSION_LOG_TERMINAL_SKEW_MS = 2_000
const MUSE_ADOPTED_REASON_MAX_CHARS = 400
/** Below this, an env value is a flag/short literal rather than a credential. */
const MUSE_SECRET_MIN_CHARS = 6

/**
 * Strip app-owned MCP credentials out of text Muse authored.
 *
 * The bridge registration carries the broker route token in
 * `mcp_servers.<name>.env`, and a Muse-side run config error is exactly the
 * kind of message that quotes the server block back at you. Anything adopted
 * from Muse's own log therefore passes through here before it can reach a
 * warning, a transcript or a log line.
 */
export function redactMuseMcpSecrets(value: string, mcpSettings?: MuseMcpSettings): string {
  let out = value
  const secrets: string[] = []
  for (const server of Object.values(mcpSettings?.mcp_servers ?? {})) {
    for (const entry of Object.values(server?.env ?? {})) {
      if (typeof entry === 'string' && entry.trim().length >= MUSE_SECRET_MIN_CHARS) {
        secrets.push(entry)
      }
    }
  }
  // Longest first, so a secret that contains a shorter one is not half-masked.
  secrets.sort((a, b) => b.length - a.length)
  // split/join rather than RegExp: a token is arbitrary bytes, never a pattern.
  for (const secret of secrets) out = out.split(secret).join('[redacted]')
  return out.length > MUSE_ADOPTED_REASON_MAX_CHARS
    ? `${out.slice(0, MUSE_ADOPTED_REASON_MAX_CHARS)}…`
    : out
}

function requireNonEmpty(value: string, label: string): string {
  const trimmed = (value || '').trim()
  if (!trimmed) throw new Error(`MuseMspRun requires a non-empty ${label}`)
  return trimmed
}

/**
 * TaskWraith approval posture -> MSP `ApprovalMode`.
 *
 * A read-only seat is `denyUnmatched` on top of `--disable-write
 * --disable-shell`, so the wire agrees with the host rather than quietly
 * contradicting it. A write-capable seat asks TaskWraith per tool
 * (`onRequest`) when an approval handler is wired, and otherwise falls back to
 * exec-lane parity (`allowAll` under the host sandbox).
 */
export function museMspApprovalModeFor(
  approvalMode: string | null | undefined,
  appManagedApprovals = false
): MuseMspApprovalMode {
  if (!museWriteCapable(approvalMode)) return 'denyUnmatched'
  // `onRequest` only once a handler exists to answer: the client denies by
  // default when `onApprovalRequest` is absent, so selecting it without one
  // would deny every tool and make a write-capable seat useless.
  return appManagedApprovals ? 'onRequest' : 'allowAll'
}

/**
 * `MuseReasoningEffort` -> `MuseMspReasoningEffort`.
 *
 * The two ladders overlap but are not the same vocabulary: MSP publishes
 * `none`, which `--provider meta` rejects on the exec lane, and the exec ladder
 * carries `max`, which MSP does not define. `max` clamps UP to `ultra` rather
 * than falling to a default, matching how normalizeMuseReasoningEffort already
 * treats a top-tier selection on a model that cannot take it.
 */
export function museMspReasoningEffortFor(effort: MuseReasoningEffort): MuseMspReasoningEffort {
  return effort === 'max' ? 'ultra' : effort
}

/**
 * Schema-v1 api-key auth.json for a BYOK seat.
 *
 * `parseMuseAuthJsonCredential` already recognises this shape as
 * `credentialKind: 'api-key'`, and `projectMuseAuthJson` validates it and
 * removes it at teardown like any other projected credential. NOT verified
 * against a live `muse serve` BYOK account: the env route Muse documents
 * (`META_API_KEY`) is deliberately scrubbed by the seat's closed env allowlist,
 * so auth.json is the only channel a relocated home has.
 */
export function buildMuseApiKeyAuthJson(apiKey: string): string {
  return JSON.stringify({ schema_version: 1, providers: { meta: { api_key: apiKey } } })
}

function skillPinHashFor(lease: MuseIsolatedHomeLease): string {
  try {
    return createHash('sha256').update(readFileSync(lease.settingsPath)).digest('hex')
  } catch {
    return ''
  }
}

/** Text first, then images — the order Muse renders them in. */
export function buildMuseMspTurnInput(
  prompt: string,
  imagePaths: readonly string[] | undefined,
  load: typeof loadMainAuthorizedAcpImageContents
): MuseMspTurnInputPart[] {
  const parts: MuseMspTurnInputPart[] = [{ type: 'text', text: prompt }]
  if (!imagePaths || imagePaths.length === 0) return parts
  for (const image of load(imagePaths)) {
    // Field names differ from ACP's; the bytes and the validation do not.
    parts.push({ type: 'image', base64Data: image.data, mediaType: image.mimeType })
  }
  return parts
}

export async function runMuseMspProvider(input: MuseMspRunInput): Promise<MuseRunOutcome> {
  const binaryPath = requireNonEmpty(input.binaryPath, 'binaryPath')
  const workspacePath = requireNonEmpty(input.workspacePath, 'workspacePath')
  // Validated, NOT trimmed: the exec lane sends `input.prompt` verbatim, and a
  // transport that quietly strips surrounding whitespace makes the two lanes
  // send different bytes for the same turn.
  requireNonEmpty(input.prompt, 'prompt')
  const prompt = input.prompt
  const runId = requireNonEmpty(input.runId, 'runId')
  const now = input.now ?? (() => Date.now())
  const startedAt = now()
  const effort: MuseReasoningEffort = normalizeMuseReasoningEffort(
    input.reasoningEffort,
    input.model
  )
  const writeCapable = museWriteCapable(input.approvalMode)
  const argv = buildMuseServeArgv({
    approvalMode: input.approvalMode,
    sandboxNetwork: input.sandboxNetwork,
    trustWorkspace: input.trustWorkspace
  })

  const lease = (input.createHome ?? createMuseIsolatedHome)({
    temporaryRoot: input.temporaryRoot,
    runId,
    sourceEnvironment: input.sourceEnvironment,
    skillPinSettings: buildMuseSkillPinSettings('off', {
      ultraTaskDelegationAutoAllow: input.ultraTaskDelegationAutoAllow === true
    }),
    ...(input.mcpSettings ? { mcpSettings: input.mcpSettings } : {}),
    ...(input.durableSeat ? { durableSeat: input.durableSeat } : {})
  })

  const events: MuseExecNormalizedEvent[] = []
  const warnings: string[] = []
  let assistantText = ''
  let sessionId = ''
  const latest: {
    usage: MuseMspUsageSnapshot | null
    context: MuseMspContextSnapshot | null
    turnError: MuseMspTurnError | null
  } = { usage: null, context: null, turnError: null }
  let terminal: string | null = null
  let exitCode: number | null = null
  let cancelled = false

  const noteWarning = (message: string): void => {
    warnings.push(message)
    input.onWarning?.(message)
  }

  const launchPrompt = composeMuseLaunchPrompt(prompt, input.introductionText)

  try {
    const authJsonText =
      input.authJsonText || (input.apiKey ? buildMuseApiKeyAuthJson(input.apiKey) : null)
    if (authJsonText) projectMuseAuthJson(lease, authJsonText)

    let turnInput: MuseMspTurnInputPart[]
    try {
      turnInput = buildMuseMspTurnInput(
        launchPrompt,
        input.imagePaths,
        input.loadImages ?? loadMainAuthorizedAcpImageContents
      )
    } catch (error) {
      // Never silently omit an attachment: run the text turn and say so.
      noteWarning(
        `Muse could not attach the images for this turn: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      turnInput = [{ type: 'text', text: launchPrompt }]
    }

    const handle = runMuseMspTurn({
      spawnProcess: () => input.spawnMsp({ binaryPath, argv, cwd: workspacePath, env: lease.env }),
      clientVersion: input.clientVersion,
      workspaceRoot: workspacePath,
      input: turnInput,
      // Match exec's explicit --provider meta. Muse's implicit "muse" route
      // is reconstructed as "meta" on resume, breaking opaque-history replay.
      providerId: MUSE_DEFAULT_PROVIDER,
      modelId: input.model || undefined,
      reasoningEffort: museMspReasoningEffortFor(effort),
      approvalMode: museMspApprovalModeFor(input.approvalMode, Boolean(input.onApprovalRequest)),
      resumeSessionId: input.resumeSessionId ?? null,
      onEvent: (event) => {
        events.push(event)
        if (event.type === 'content' && event.text) assistantText += event.text
        input.onEvent?.(event)
      },
      onSessionReady: (info) => {
        sessionId = info.sessionId
        input.onSessionReady?.(info)
      },
      onUsage: (snapshot) => {
        latest.usage = snapshot
      },
      onContextUsage: (snapshot) => {
        latest.context = snapshot
      },
      ...(input.onContextCompaction ? { onContextCompaction: input.onContextCompaction } : {}),
      onWarning: noteWarning,
      // Same contract the launch steers keep: a native slash dispatch reaches
      // the provider untouched, so it is never steered mid-turn either.
      announceBeforeTools: museAnnounceSteerAppliesToPrompt(prompt),
      ...(input.onApprovalRequest ? { onApprovalRequest: input.onApprovalRequest } : {}),
      onClose: (code, closeTerminal, error) => {
        exitCode = code
        terminal = closeTerminal
        latest.turnError = error
      }
    })

    const pollMs = input.cancelPollIntervalMs ?? 100
    if (input.shouldCancel) {
      const poll = setInterval(() => {
        if (!input.shouldCancel?.()) return
        cancelled = true
        clearInterval(poll)
        handle.cancel()
      }, pollMs)
      try {
        await handle.closed
      } finally {
        clearInterval(poll)
      }
    } else {
      await handle.closed
    }

    // Belt to the watchdog's braces.
    //
    // This lane takes its terminal off the wire, so a host that dies — or that
    // the inactivity watchdog had to kill — leaves us with no verdict while
    // Muse has already written one to its own durable session log. That record
    // was always there; we simply never read it.
    //
    // Runs INSIDE the try on purpose: `lease.cleanup()` in the finally scrubs
    // the home, and on a disposable (non-durable-seat) run it takes the log
    // with it.
    if (!cancelled && terminal === null && sessionId) {
      try {
        const resolveSessionLog =
          input.resolveSessionLog ??
          ((opts: { dataHome: string; sessionId: string }) =>
            resolveMuseSessionLogPath({
              dataHome: opts.dataHome,
              sessionId: opts.sessionId,
              timeoutMs: input.sessionLogResolveTimeoutMs ?? 250
            }))
        const resolved = await resolveSessionLog({
          dataHome: lease.museDataDir,
          sessionId
        })
        if (resolved.sessionLogPath) {
          const record = await readMuseSessionLogTerminal({
            sessionLogPath: resolved.sessionLogPath,
            notBeforeMs: startedAt - MUSE_SESSION_LOG_TERMINAL_SKEW_MS
          })
          if (record) {
            // An unrecognised verdict falls through the status ternary to
            // 'failed', which is the right default for a turn we never saw end.
            terminal = record.terminal
            const reason = record.reason
              ? ` ${redactMuseMcpSecrets(record.reason, input.mcpSettings)}`
              : ''
            noteWarning(
              `Muse exited without reporting a result on the wire; TaskWraith adopted the "${record.terminal}" verdict recorded in its own session log.${reason}`
            )
          }
        }
      } catch (error) {
        // Redacted like every other adopted-text path. A resolver or parser
        // that quotes the offending content back is exactly where the broker
        // token would surface, and an error message is not a safer channel for
        // it than a success message.
        noteWarning(
          `Muse session-log terminal adoption failed: ${redactMuseMcpSecrets(
            error instanceof Error ? error.message : String(error),
            input.mcpSettings
          )}`
        )
      }
    }
  } finally {
    const cleanup = lease.cleanup()
    if (!cleanup.ok) noteWarning(cleanup.reason)
  }

  const status: MuseRunStatus =
    cancelled || terminal === 'cancelled'
      ? 'cancelled'
      : terminal === 'completed'
        ? 'success'
        : 'failed'
  if (latest.turnError?.message) noteWarning(latest.turnError.message)

  const reported = latest.usage !== null
  const meter: MuseMeterSnapshot = {
    museSessionId: sessionId,
    model: input.model || null,
    inputTokens: latest.usage?.inputTokens ?? 0,
    outputTokens: latest.usage?.outputTokens ?? 0,
    cacheReadInputTokens: latest.usage?.lastCallCachedTokens ?? 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: latest.usage?.lastCallReasoningTokens ?? 0,
    totalTokens: latest.usage?.totalTokens ?? 0,
    durationMs: now() - startedAt,
    estimatedCostUsd: null,
    tokenCountConfidence: reported ? MUSE_TOKEN_COUNT_REPORTED : MUSE_TOKEN_COUNT_UNAVAILABLE,
    source: MUSE_MSP_USAGE_SOURCE,
    usageIds: []
  }
  const providerStats = museMeterSnapshotToProviderStats(meter)
  // The provider's own window for THIS session; `resolveContextWindow` reads
  // the flat `totalTokenLimit` spelling and nothing else.
  if (latest.context?.windowTokens && latest.context.windowTokens > 0) {
    providerStats.totalTokenLimit = latest.context.windowTokens
  }

  return {
    status,
    sessionId,
    exitCode,
    assistantText,
    events,
    meter,
    providerStats,
    warnings,
    argv,
    effort,
    writeCapable,
    skillPinHash: skillPinHashFor(lease),
    leasePath: lease.path
  }
}
