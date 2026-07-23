import type { AgentRunPayload, AgentRunRoute } from '../run/AgentRunTypes'
import type { RunSessionStatus } from '../RunManager'
import { canStartRunTransport } from '../RunManager'
import type { AppSettings, ProviderId } from '../store/types'
import {
  mapAntigravityGeminiApiTurnStatusToMessage,
  runAntigravityGeminiApiMainTurn,
  type AntigravityGeminiApiContentPayload,
  type AntigravityGeminiApiInitPayload,
  type AntigravityGeminiApiResultPayload,
  type AntigravityGeminiApiTerminalFinishStatus
} from './AntigravityGeminiApiMainRuntime'
import type { AntigravityGeminiApiSecretStore } from './AntigravityGeminiApiSecretStore'

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
 * by the kernel before any secret load.
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

export interface AntigravityCombinedModeRunSession {
  readonly provider: ProviderId
  readonly status: RunSessionStatus
}

export interface AntigravityCombinedModeDispatchDependencies {
  readonly getSettings: () => Pick<
    AppSettings,
    'antigravityEnabled' | 'antigravityOptInAcceptedAt' | 'antigravityGeminiApiDisclosureAcceptedAt'
  > | null
  /** Post-ready dedicated store only. Null/undefined fails closed without key load. */
  readonly getSecretStore: () => Pick<AntigravityGeminiApiSecretStore, 'loadApiKey'> | null
  readonly getRunSession: (runId: string) => AntigravityCombinedModeRunSession | undefined
  readonly attachAbortController: (runId: string, controller: AbortController) => void
  readonly sendAgentCompatLine: (
    sender: Electron.WebContents,
    provider: ProviderId,
    payload: unknown,
    route?: AgentRunRoute | null
  ) => void
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
  readonly runGeminiApiMainTurn?: typeof runAntigravityGeminiApiMainTurn
  readonly canStartTransport?: typeof canStartRunTransport
}

/**
 * Combined-mode AntiGravity production dispatch bridge.
 *
 * - Exact `gemini-api:gemini-*` (and broader namespace candidates) → reviewed
 *   Gemini API lifecycle adapter + dedicated post-ready secret store.
 * - Every other model → unchanged official user-installed `agy` path.
 * - Never falls through between lanes. Never invents run/chat IDs.
 */
export async function dispatchAntigravityCombinedMode(
  event: Electron.IpcMainInvokeEvent,
  payload: AgentRunPayload,
  deps: AntigravityCombinedModeDispatchDependencies
): Promise<void> {
  if (isAntigravityGeminiApiModelCandidate(payload.model)) {
    await runAntigravityGeminiApiDispatchLane(event, payload, deps)
    return
  }
  await deps.runAgyProvider(event, payload)
}

async function runAntigravityGeminiApiDispatchLane(
  event: Electron.IpcMainInvokeEvent,
  payload: AgentRunPayload,
  deps: AntigravityCombinedModeDispatchDependencies
): Promise<void> {
  const route = exactIncomingRoute(payload)

  let secretStore: Pick<AntigravityGeminiApiSecretStore, 'loadApiKey'> | null
  try {
    secretStore = deps.getSecretStore()
  } catch {
    terminalizeBridgeFailure(event.sender, route, deps, 'unavailable')
    return
  }
  if (!secretStore) {
    terminalizeBridgeFailure(event.sender, route, deps, 'keyUnavailable')
    return
  }

  // Per-projection attempted/completed state. Mark attempted *before*
  // invoking the callback so a side-effect-then-throw never retries that
  // same projection; recovery may still attempt the other untouched one once.
  let exitAttempted = false
  let exitCompleted = false
  let finishAttempted = false
  let finishCompleted = false
  const finishOnce = createBridgeTerminalOwner(event.sender, route, deps)

  try {
    await (deps.runGeminiApiMainTurn ?? runAntigravityGeminiApiMainTurn)(
      deps.getSettings(),
      {
        model: typeof payload.model === 'string' ? payload.model : '',
        prompt: typeof payload.prompt === 'string' ? payload.prompt : '',
        route
      },
      {
        secretStore,
        attachAbortController: (runId, controller) => {
          requireExactActiveAntigravitySession(runId, deps)
          deps.attachAbortController(runId as string, controller)
        },
        emitInit: (initPayload: AntigravityGeminiApiInitPayload) => {
          deps.sendAgentCompatLine(
            event.sender,
            ANTIGRAVITY_COMBINED_MODE_PROVIDER,
            initPayload,
            route
          )
        },
        emitContent: (contentPayload: AntigravityGeminiApiContentPayload) => {
          deps.sendAgentCompatLine(
            event.sender,
            ANTIGRAVITY_COMBINED_MODE_PROVIDER,
            contentPayload,
            route
          )
        },
        emitResult: (resultPayload: AntigravityGeminiApiResultPayload) => {
          deps.sendAgentCompatLine(
            event.sender,
            ANTIGRAVITY_COMBINED_MODE_PROVIDER,
            resultPayload,
            route
          )
        },
        emitError: (message: string) => {
          deps.sendAgentCompatError(
            event.sender,
            ANTIGRAVITY_COMBINED_MODE_PROVIDER,
            message,
            route
          )
        },
        emitExit: (code: number | null) => {
          if (exitAttempted) return
          exitAttempted = true
          deps.sendAgentCompatExit(event.sender, ANTIGRAVITY_COMBINED_MODE_PROVIDER, code, route)
          exitCompleted = true
        },
        finishRun: (status: AntigravityGeminiApiTerminalFinishStatus) => {
          if (finishAttempted) return
          finishAttempted = true
          deps.finishRun(route.appRunId, status)
          finishCompleted = true
        }
      }
    )
  } catch {
    if (!exitAttempted && !finishAttempted) {
      finishOnce('unavailable')
      return
    }
    if (!exitAttempted) {
      try {
        exitAttempted = true
        deps.sendAgentCompatExit(event.sender, ANTIGRAVITY_COMBINED_MODE_PROVIDER, 1, route)
        exitCompleted = true
      } catch {
        // Lifecycle callbacks are fallible; remaining projections still run.
      }
    } else if (!exitCompleted) {
      // Side-effect-then-throw already marked attempted; never retry exit.
    }
    if (!finishAttempted) {
      try {
        finishAttempted = true
        deps.finishRun(route.appRunId, 'failed')
        finishCompleted = true
      } catch {
        // Lifecycle callbacks are fallible; terminalization must still attempt.
      }
    } else if (!finishCompleted) {
      // Side-effect-then-throw already marked attempted; never retry finish.
    }
  }
}

function requireExactActiveAntigravitySession(
  runId: string | undefined,
  deps: AntigravityCombinedModeDispatchDependencies
): void {
  if (typeof runId !== 'string' || runId.length === 0 || runId.trim().length === 0) {
    throw new Error('antigravity-gemini-api-session-unavailable')
  }
  const session = deps.getRunSession(runId)
  const canStart = deps.canStartTransport ?? canStartRunTransport
  if (
    !session ||
    session.provider !== ANTIGRAVITY_COMBINED_MODE_PROVIDER ||
    !canStart(session.status, true)
  ) {
    throw new Error('antigravity-gemini-api-session-unavailable')
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

function createBridgeTerminalOwner(
  sender: Electron.WebContents,
  route: AgentRunRoute,
  deps: AntigravityCombinedModeDispatchDependencies
): (status: 'unavailable' | 'keyUnavailable') => void {
  let terminalized = false
  return (status) => {
    if (terminalized) return
    terminalized = true
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
}

function terminalizeBridgeFailure(
  sender: Electron.WebContents,
  route: AgentRunRoute,
  deps: AntigravityCombinedModeDispatchDependencies,
  status: 'unavailable' | 'keyUnavailable'
): void {
  createBridgeTerminalOwner(sender, route, deps)(status)
}
