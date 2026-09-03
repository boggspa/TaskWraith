import type { AgentRunPayload, AgentRunRoute } from '../run/AgentRunTypes'
import type { ProviderId } from '../store/types'
import {
  mapAntigravityGeminiApiTurnStatusToMessage,
  type AntigravityGeminiApiTerminalFinishStatus
} from './AntigravityGeminiApiMainRuntime'

export const ANTIGRAVITY_COMBINED_MODE_PROVIDER: ProviderId = 'antigravity'

const GEMINI_API_TOKEN = 'gemini-api'

const ACP_TOKEN = 'antigravity-acp'

/**
 * Detect Gemini API namespace *candidates* for quarantine onto the official
 * SDK lane. Matching is intentionally broader than the committed exact
 * `gemini-api:gemini-*` validator, but token-bounded: after trim +
 * case-folding, reserve end-of-string and intended/malformed separators
 * (`:`, whitespace, other non [a-z0-9-] chars). Do **not** reserve an
 * ASCII alphanumeric or hyphen continuation — e.g. `gemini-apix` stays on
 * ordinary `agy`. The original model string is preserved and re-validated
 * by the agent turn before any secret load.
 */
export function isAntigravityGeminiApiModelCandidate(model: unknown): boolean {
  if (typeof model !== 'string') return false
  const normalized = model.trim().toLowerCase()
  if (!normalized.startsWith(GEMINI_API_TOKEN)) return false
  if (normalized.length === GEMINI_API_TOKEN.length) return true
  const continuation = normalized.charAt(GEMINI_API_TOKEN.length)
  // Alphanumeric or hyphen continuation keeps the model on ordinary AGY.
  return !/[a-z0-9-]/.test(continuation)
}

/**
 * Detect official-ACP namespace *candidates* for quarantine onto the
 * Google-published `agy_acp_server` lane. Same token-bounded rule as the
 * Gemini API predicate above: after trim + case-folding, reserve
 * end-of-string and intended/malformed separators, but do **not** reserve an
 * ASCII alphanumeric or hyphen continuation — e.g. `antigravity-acpx` stays
 * on ordinary `agy`. An ACP candidate must never fall through to the agy
 * lane: that would silently run a different transport than the user picked.
 */
export function isAntigravityAcpModelCandidate(model: unknown): boolean {
  if (typeof model !== 'string') return false
  const normalized = model.trim().toLowerCase()
  if (!normalized.startsWith(ACP_TOKEN)) return false
  if (normalized.length === ACP_TOKEN.length) return true
  const continuation = normalized.charAt(ACP_TOKEN.length)
  // Alphanumeric or hyphen continuation keeps the model on ordinary AGY.
  return !/[a-z0-9-]/.test(continuation)
}

export interface AntigravityCombinedModeDispatchDependencies {
  /**
   * Registers the RunManager session this lane's whole lifecycle keys on.
   * The gemini-api lane has no child process, so unlike the CLI transports
   * nothing else ever creates its session — and without one, the abort
   * attach fails, every compat emission is dropped by the session-keyed
   * persistence-authority gate, `finishRun` is a no-op, and cancel returns
   * false: the renderer shows an unkillable "Working" run with zero events.
   * Returns undefined when registration is refused (e.g. the history-clear
   * admission fence), in which case dispatch must fail the invoke visibly.
   */
  readonly registerRunSession: (route: AgentRunRoute) => unknown
  /**
   * The full agentic Gemini API turn (tools, history replay, usage — the
   * parameterized `tryRunGeminiApi` with AntiGravity deps). It OWNS the run
   * lifecycle end-to-end once invoked: init/content/tool events, terminal
   * error/exit projections, and the RunManager finish. Admission that the
   * shared runtime does not know about (Gemini-API disclosure, exact model
   * route validation, dedicated secret-store key load) lives inside the
   * wiring of this dependency, not here.
   */
  readonly runGeminiApiAgentTurn: (
    event: Electron.IpcMainInvokeEvent,
    payload: AgentRunPayload,
    route: AgentRunRoute
  ) => Promise<void>
  readonly sendAgentCompatError: (
    sender: Electron.WebContents,
    provider: ProviderId,
    message: string,
    route?: AgentRunRoute | null
  ) => void
  readonly sendAgentCompatExit: (
    sender: Electron.WebContents,
    provider: ProviderId,
    code: number | null,
    route?: AgentRunRoute | null
  ) => void
  readonly finishRun: (
    runId: string | undefined,
    status: AntigravityGeminiApiTerminalFinishStatus
  ) => void
  /** Exact existing official-agy production path. Must not be invoked for API candidates. */
  readonly runAgyProvider: (
    event: Electron.IpcMainInvokeEvent,
    payload: AgentRunPayload
  ) => Promise<void>
  /**
   * Reads the Settings → Providers → AntiGravity ACP transport switch
   * (`antigravityUseAcp`). Optional so this module compiles and fails closed
   * before the composition root wires it (S5); absent means "off".
   */
  readonly isAcpTransportEnabled?: () => boolean
  /**
   * The official-ACP turn over the Google-published `agy_acp_server` binary
   * (the S3 client, wired at the composition root in S5). It OWNS the run
   * lifecycle end-to-end once invoked, exactly like runGeminiApiAgentTurn.
   * Optional: while the lane is unconnected, ACP candidates terminalize with
   * honest "not connected yet" copy instead of falling through to agy.
   */
  readonly runOfficialAcpProvider?: (
    event: Electron.IpcMainInvokeEvent,
    payload: AgentRunPayload,
    route: AgentRunRoute
  ) => Promise<void>
}

/**
 * Combined-mode AntiGravity production dispatch bridge.
 *
 * - Exact `gemini-api:gemini-*` (and broader namespace candidates) → the
 *   in-process agentic Gemini API runtime under provider 'antigravity'.
 * - `antigravity-acp` namespace candidates → the official-ACP lane, gated on
 *   the Settings transport switch; fails closed while the lane is unwired.
 * - Every other model → unchanged official user-installed `agy` path.
 * - Never falls through between lanes. Never invents run/chat IDs.
 */
export async function dispatchAntigravityCombinedMode(
  event: Electron.IpcMainInvokeEvent,
  payload: AgentRunPayload,
  deps: AntigravityCombinedModeDispatchDependencies
): Promise<void> {
  const route = exactIncomingRoute(payload)

  // Both AntiGravity transports need the same host-owned lifecycle before
  // either lane can await setup or emit terminal state. The in-process Gemini
  // API lane has no child process to register it, while the official agy lane
  // deliberately enters runCliProviderProcess with requireExistingRun=true so
  // cancellation/history authority is fixed before launch preparation.
  registerCombinedModeRunSession(route, deps)

  if (isAntigravityGeminiApiModelCandidate(payload.model)) {
    await runAntigravityGeminiApiDispatchLane(event, payload, route, deps)
    return
  }
  if (isAntigravityAcpModelCandidate(payload.model)) {
    await runAntigravityAcpDispatchLane(event, payload, route, deps)
    return
  }
  await deps.runAgyProvider(event, payload)
}

function registerCombinedModeRunSession(
  route: AgentRunRoute,
  deps: AntigravityCombinedModeDispatchDependencies
): void {
  let registeredSession: unknown
  try {
    registeredSession = deps.registerRunSession(route)
  } catch (error) {
    throw error instanceof Error ? error : new Error('AntiGravity run session registration failed.')
  }
  if (!registeredSession) {
    throw new Error(
      'AntiGravity run session could not be registered; the run cannot start right now.'
    )
  }
}

async function runAntigravityGeminiApiDispatchLane(
  event: Electron.IpcMainInvokeEvent,
  payload: AgentRunPayload,
  route: AgentRunRoute,
  deps: AntigravityCombinedModeDispatchDependencies
): Promise<void> {
  try {
    await deps.runGeminiApiAgentTurn(event, payload, route)
  } catch {
    // The agent turn owns its terminal projections; reaching here means it
    // died without completing them. Recover a visible fixed-copy terminal
    // exactly once so the registered session cannot strand as Working.
    terminalizeBridgeFailure(event.sender, route, deps, 'unavailable')
  }
}

/** Fixed ACP-lane terminal copy. Never reuse the Gemini API status mapper. */
export const ANTIGRAVITY_ACP_TRANSPORT_DISABLED_MESSAGE =
  'This model runs on the official AntiGravity ACP transport. Enable the ACP transport switch in Settings -> Providers -> AntiGravity to use it.'
export const ANTIGRAVITY_ACP_LANE_NOT_CONNECTED_MESSAGE =
  'The official AntiGravity ACP transport is not connected in this build yet, so this model cannot run. Switch back to the legacy agy CLI transport or choose another model.'
export const ANTIGRAVITY_ACP_TURN_UNAVAILABLE_MESSAGE =
  'The official AntiGravity ACP transport became unavailable before it could finish. Try the run again, or switch back to the legacy agy CLI transport.'

/**
 * Official-ACP dispatch lane. The run session is already registered, so every
 * exit from this lane must terminalize visibly — never throw, and never fall
 * through to agy (that would silently run a different transport than the user
 * selected). While the S3 client / S5 wiring are unlanded the lane fails
 * closed with honest copy.
 */
async function runAntigravityAcpDispatchLane(
  event: Electron.IpcMainInvokeEvent,
  payload: AgentRunPayload,
  route: AgentRunRoute,
  deps: AntigravityCombinedModeDispatchDependencies
): Promise<void> {
  if (deps.isAcpTransportEnabled?.() !== true) {
    terminalizeAcpLaneFailure(event.sender, route, deps, ANTIGRAVITY_ACP_TRANSPORT_DISABLED_MESSAGE)
    return
  }
  const runOfficialAcpProvider = deps.runOfficialAcpProvider
  if (!runOfficialAcpProvider) {
    terminalizeAcpLaneFailure(event.sender, route, deps, ANTIGRAVITY_ACP_LANE_NOT_CONNECTED_MESSAGE)
    return
  }
  try {
    await runOfficialAcpProvider(event, payload, route)
  } catch {
    // Same recovery contract as the Gemini API lane: the provider owns its
    // terminal projections, so a throw means it died without completing them.
    terminalizeAcpLaneFailure(event.sender, route, deps, ANTIGRAVITY_ACP_TURN_UNAVAILABLE_MESSAGE)
  }
}

/**
 * ACP counterpart to terminalizeBridgeFailure, taking explicit fixed copy
 * instead of a Gemini API status. Order is load-bearing: the renderer seals
 * a run only on the exit event and finishRun releases persistence authority,
 * so exit must be emitted BEFORE finish or the run wedges as "Working".
 */
function terminalizeAcpLaneFailure(
  sender: Electron.WebContents,
  route: AgentRunRoute,
  deps: AntigravityCombinedModeDispatchDependencies,
  message: string
): void {
  try {
    deps.sendAgentCompatError(sender, ANTIGRAVITY_COMBINED_MODE_PROVIDER, message, route)
  } catch {
    // Lifecycle callbacks are fallible; terminalization must still complete.
  }
  try {
    deps.sendAgentCompatExit(sender, ANTIGRAVITY_COMBINED_MODE_PROVIDER, 1, route)
  } catch {
    // Lifecycle callbacks are fallible; terminalization must still complete.
  }
  try {
    deps.finishRun(route.appRunId, 'failed')
  } catch {
    // Lifecycle callbacks are fallible; terminalization must still complete.
  }
}

function exactIncomingRoute(payload: AgentRunPayload): AgentRunRoute {
  const route: AgentRunRoute = {}
  // Preserve supplied identities byte-for-byte. Do not coerce, trim,
  // synthesize, or invent fallback run identities.
  if (
    Object.prototype.hasOwnProperty.call(payload, 'appChatId') &&
    typeof payload.appChatId === 'string'
  ) {
    route.appChatId = payload.appChatId
  }
  if (
    Object.prototype.hasOwnProperty.call(payload, 'appRunId') &&
    typeof payload.appRunId === 'string'
  ) {
    route.appRunId = payload.appRunId
  }
  return route
}

function terminalizeBridgeFailure(
  sender: Electron.WebContents,
  route: AgentRunRoute,
  deps: AntigravityCombinedModeDispatchDependencies,
  status: 'unavailable' | 'keyUnavailable'
): void {
  const message = mapAntigravityGeminiApiTurnStatusToMessage(status)
  try {
    deps.sendAgentCompatError(sender, ANTIGRAVITY_COMBINED_MODE_PROVIDER, message, route)
  } catch {
    // Lifecycle callbacks are fallible; terminalization must still complete.
  }
  try {
    deps.sendAgentCompatExit(sender, ANTIGRAVITY_COMBINED_MODE_PROVIDER, 1, route)
  } catch {
    // Lifecycle callbacks are fallible; terminalization must still complete.
  }
  try {
    deps.finishRun(route.appRunId, 'failed')
  } catch {
    // Lifecycle callbacks are fallible; terminalization must still complete.
  }
}
