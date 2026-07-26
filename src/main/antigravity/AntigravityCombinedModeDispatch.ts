import type { AgentRunPayload, AgentRunRoute } from '../run/AgentRunTypes'
import type { ProviderId } from '../store/types'
import {
  mapAntigravityGeminiApiTurnStatusToMessage,
  type AntigravityGeminiApiTerminalFinishStatus
} from './AntigravityGeminiApiMainRuntime'

export const ANTIGRAVITY_COMBINED_MODE_PROVIDER: ProviderId = 'antigravity'

const GEMINI_API_TOKEN = 'gemini-api'

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
}

/**
 * Combined-mode AntiGravity production dispatch bridge.
 *
 * - Exact `gemini-api:gemini-*` (and broader namespace candidates) → the
 *   in-process agentic Gemini API runtime under provider 'antigravity'.
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
