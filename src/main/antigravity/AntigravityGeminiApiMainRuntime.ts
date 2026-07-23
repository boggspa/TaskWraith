import type { AgentRunRoute } from '../run/AgentRunTypes'
import { geminiUsageMetadataToStats } from '../ProviderRunStats'
import type { RunSessionStatus } from '../RunManager'
import type { AppSettings } from '../store/types'
import {
  streamAntigravityGeminiApiTurn,
  type AntigravityGeminiApiTurnResult,
  type AntigravityGeminiApiTurnStatus
} from './AntigravityGeminiApiTurnKernel'
import type { AntigravityGeminiApiSecretStore } from './AntigravityGeminiApiSecretStore'

export const ANTIGRAVITY_GEMINI_API_RUNTIME_LABEL = 'gemini-api' as const
export const ANTIGRAVITY_GEMINI_API_PROVIDER_LABEL = 'antigravity' as const

export interface AntigravityGeminiApiRunRequest {
  readonly model: string
  readonly prompt: string
  readonly route: AgentRunRoute
}

export interface AntigravityGeminiApiInitPayload {
  readonly type: 'init'
  readonly session_id: string
  readonly model: string
  readonly timestamp: string
  readonly provider: typeof ANTIGRAVITY_GEMINI_API_PROVIDER_LABEL
  readonly runtime: typeof ANTIGRAVITY_GEMINI_API_RUNTIME_LABEL
  readonly fallback: false
}

export interface AntigravityGeminiApiContentPayload {
  readonly type: 'content'
  readonly text: string
  readonly provider: typeof ANTIGRAVITY_GEMINI_API_PROVIDER_LABEL
  readonly runtime: typeof ANTIGRAVITY_GEMINI_API_RUNTIME_LABEL
}

export interface AntigravityGeminiApiResultPayload {
  readonly type: 'result'
  readonly status: 'success' | 'failed'
  readonly stats: Record<string, unknown>
  readonly provider: typeof ANTIGRAVITY_GEMINI_API_PROVIDER_LABEL
  readonly runtime: typeof ANTIGRAVITY_GEMINI_API_RUNTIME_LABEL
  readonly providerThreadId: string
  readonly fallback: false
}

export type AntigravityGeminiApiTerminalFinishStatus = Extract<
  RunSessionStatus,
  'completed' | 'failed' | 'cancelled'
>

export interface AntigravityGeminiApiMainRuntimeDependencies {
  readonly secretStore: Pick<AntigravityGeminiApiSecretStore, 'loadApiKey'>
  readonly streamTurn?: (
    settings: Pick<AppSettings, 'antigravityGeminiApiDisclosureAcceptedAt'> | null | undefined,
    request: { readonly model: string; readonly prompt: string },
    deps: {
      readonly secretStore: Pick<AntigravityGeminiApiSecretStore, 'loadApiKey'>
      readonly abortSignal?: AbortSignal
      readonly onText: (text: string) => void | Promise<void>
    }
  ) => Promise<AntigravityGeminiApiTurnResult>
  readonly createAbortController?: () => AbortController
  readonly attachAbortController?: (runId: string | undefined, controller: AbortController) => void
  readonly emitInit: (payload: AntigravityGeminiApiInitPayload) => void
  readonly emitContent: (payload: AntigravityGeminiApiContentPayload) => void
  readonly emitResult: (payload: AntigravityGeminiApiResultPayload) => void
  readonly emitError: (message: string) => void
  readonly emitExit: (code: number | null) => void
  readonly finishRun: (status: AntigravityGeminiApiTerminalFinishStatus) => void
  readonly now?: () => number
}

const FIXED_FAILURE_MESSAGES: Record<
  Exclude<AntigravityGeminiApiTurnStatus, 'ok' | 'cancelled'>,
  string
> = {
  disclosureRequired:
    'Gemini API disclosure must be accepted in Settings before this mode can run.',
  keyUnavailable: 'Gemini API key is not configured or unavailable.',
  invalidModel: 'The selected Gemini API model route is invalid.',
  invalidPrompt: 'The prompt for this Gemini API turn is invalid.',
  sdkUnavailable: 'The official Gemini API SDK is unavailable.',
  unauthorized: 'Gemini API authentication failed.',
  rateLimited: 'Gemini API rate limit exceeded.',
  projectLimited: 'Gemini API project billing or quota limit was reached.',
  unavailable: 'Gemini API request failed.',
  invalidResponse: 'Gemini API returned an invalid response.',
  empty: 'Gemini API returned no text.'
}

interface TerminalPlan {
  readonly finishStatus: AntigravityGeminiApiTerminalFinishStatus
  readonly exitCode: number | null
  readonly errorMessage?: string
  readonly result?: AntigravityGeminiApiResultPayload
}

/**
 * Main-process-only lifecycle adapter for one Gemini API text turn inside the
 * combined AntiGravity provider. It wraps the reviewed turn kernel with
 * TaskWraith-compatible init/content/result/error/exit projections and owns
 * exactly one AbortController for the turn. It intentionally has no provider
 * dispatch, session persistence, history replay, tools, media, or usage writes.
 */
export async function runAntigravityGeminiApiMainTurn(
  settings: Pick<AppSettings, 'antigravityGeminiApiDisclosureAcceptedAt'> | null | undefined,
  request: AntigravityGeminiApiRunRequest,
  deps: AntigravityGeminiApiMainRuntimeDependencies
): Promise<void> {
  const startedAt = (deps.now ?? Date.now)()
  const controller = (deps.createAbortController ?? (() => new AbortController()))()
  const sessionId = resolveGeminiApiSessionId(request.route)
  let terminalized = false

  const terminalize = (plan: TerminalPlan): void => {
    if (terminalized) return
    terminalized = true
    if (plan.errorMessage) {
      try {
        deps.emitError(plan.errorMessage)
      } catch {
        // Lifecycle callbacks are fallible; terminalization must still complete.
      }
    }
    if (plan.result) {
      try {
        deps.emitResult(plan.result)
      } catch {
        // Lifecycle callbacks are fallible; terminalization must still complete.
      }
    }
    try {
      deps.emitExit(plan.exitCode)
    } catch {
      // Lifecycle callbacks are fallible; terminalization must still complete.
    }
    try {
      deps.finishRun(plan.finishStatus)
    } catch {
      // Lifecycle callbacks are fallible; terminalization must still complete.
    }
  }

  if (!sessionId) {
    terminalize(buildFailedTerminalPlan(null, 0, 'unavailable'))
    return
  }

  try {
    deps.attachAbortController?.(request.route.appRunId, controller)
  } catch {
    terminalize(buildFailedTerminalPlan(sessionId, 0, 'unavailable'))
    return
  }

  try {
    deps.emitInit({
      type: 'init',
      session_id: sessionId,
      model: request.model,
      timestamp: new Date(startedAt).toISOString(),
      provider: ANTIGRAVITY_GEMINI_API_PROVIDER_LABEL,
      runtime: ANTIGRAVITY_GEMINI_API_RUNTIME_LABEL,
      fallback: false
    })
  } catch {
    terminalize(buildFailedTerminalPlan(sessionId, 0, 'unavailable'))
    return
  }

  let turnResult: AntigravityGeminiApiTurnResult
  try {
    turnResult = await (deps.streamTurn ?? streamAntigravityGeminiApiTurn)(
      settings,
      { model: request.model, prompt: request.prompt },
      {
        secretStore: deps.secretStore,
        abortSignal: controller.signal,
        onText: async (text) => {
          if (terminalized) return
          try {
            deps.emitContent({
              type: 'content',
              text,
              provider: ANTIGRAVITY_GEMINI_API_PROVIDER_LABEL,
              runtime: ANTIGRAVITY_GEMINI_API_RUNTIME_LABEL
            })
          } catch {
            terminalize(
              buildFailedTerminalPlan(
                sessionId,
                (deps.now ?? Date.now)() - startedAt,
                'unavailable'
              )
            )
          }
        }
      }
    )
  } catch {
    terminalize(
      buildFailedTerminalPlan(sessionId, (deps.now ?? Date.now)() - startedAt, 'unavailable')
    )
    return
  }

  if (terminalized) return

  if (turnResult.status === 'ok') {
    terminalize({
      finishStatus: 'completed',
      exitCode: 0,
      result: {
        type: 'result',
        status: 'success',
        stats: geminiUsageMetadataToStats(
          (turnResult.usage ?? {}) as Record<string, unknown>,
          (deps.now ?? Date.now)() - startedAt
        ),
        provider: ANTIGRAVITY_GEMINI_API_PROVIDER_LABEL,
        runtime: ANTIGRAVITY_GEMINI_API_RUNTIME_LABEL,
        providerThreadId: sessionId,
        fallback: false
      }
    })
    return
  }

  if (turnResult.status === 'cancelled') {
    terminalize({ finishStatus: 'cancelled', exitCode: 130 })
    return
  }

  terminalize(
    buildFailedTerminalPlan(sessionId, (deps.now ?? Date.now)() - startedAt, turnResult.status)
  )
}

export function mapAntigravityGeminiApiTurnStatusToMessage(
  status: Exclude<AntigravityGeminiApiTurnStatus, 'ok' | 'cancelled'>
): string {
  return FIXED_FAILURE_MESSAGES[status]
}

function buildFailedTerminalPlan(
  sessionId: string | null,
  durationMs: number,
  status: Exclude<AntigravityGeminiApiTurnStatus, 'ok' | 'cancelled'>
): TerminalPlan {
  return {
    finishStatus: 'failed',
    exitCode: 1,
    errorMessage: mapAntigravityGeminiApiTurnStatusToMessage(status),
    result: sessionId
      ? {
          type: 'result',
          status: 'failed',
          stats: { duration_ms: Math.max(0, durationMs) },
          provider: ANTIGRAVITY_GEMINI_API_PROVIDER_LABEL,
          runtime: ANTIGRAVITY_GEMINI_API_RUNTIME_LABEL,
          providerThreadId: sessionId,
          fallback: false
        }
      : undefined
  }
}

function resolveGeminiApiSessionId(route: AgentRunRoute): string | null {
  if (isValidRouteIdentity(route.appChatId)) {
    return route.appChatId
  }
  if (isValidRouteIdentity(route.appRunId)) {
    return route.appRunId
  }
  return null
}

function isValidRouteIdentity(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim().length > 0
}
