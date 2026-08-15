import {
  AGENT_QUESTION_TRANSPORT_TIMEOUT_MS,
  APPROVAL_TRANSPORT_TIMEOUT_MS
} from '../../shared/interactionTimeouts'

/**
 * Request budgets for the MCP broker clients (the socket hop between a
 * provider-side bridge stub and the TaskWraith main process).
 *
 * The default budget exists so a dead main process can never hang a provider
 * forever, and it must exceed the full user-configurable approval ceiling.
 * Otherwise a valid Settings value can be cut off by the transport before the
 * approval timer resolves it.
 *
 * LONG-POLL tools deliberately hold their call open while main does bounded
 * waiting on their behalf:
 * - `ensemble_await` may wait up to 10 minutes per call for fan-out lanes to
 *   settle (ENSEMBLE_AWAIT_MAX_*), so its broker budget is that ceiling plus
 *   grace.
 * - `ask_user_question` parks until the user answers or the 24-minute
 *   registry TTL fires, so its broker budget is that ceiling plus grace.
 *
 * The broker kill stays a last-resort liveness backstop, never the effective
 * cap. Keep long-poll names in lockstep with the awaited-tool clamps.
 */

export const MCP_BROKER_REQUEST_TIMEOUT_MS = APPROVAL_TRANSPORT_TIMEOUT_MS

/** ensemble_await clamp ceiling (600s) + 30s grace. */
export const MCP_BROKER_LONG_POLL_TIMEOUT_MS = 630_000

/** ask_user_question registry TTL plus transport settlement grace. */
export const MCP_BROKER_ASK_USER_QUESTION_TIMEOUT_MS = AGENT_QUESTION_TRANSPORT_TIMEOUT_MS

const LONG_POLL_TIMEOUT_BY_TOOL: ReadonlyMap<string, number> = new Map([
  ['ensemble_await', MCP_BROKER_LONG_POLL_TIMEOUT_MS],
  ['ask_user_question', MCP_BROKER_ASK_USER_QUESTION_TIMEOUT_MS]
])

function toolNameOfRequest(request: unknown): string | null {
  if (typeof request !== 'object' || request === null) return null
  const record = request as { method?: unknown; params?: unknown }
  if (record.method !== 'tools/call') return null
  const params = record.params as { name?: unknown } | undefined
  return typeof params?.name === 'string' ? params.name : null
}

/**
 * The broker request budget for a raw JSON-RPC message: the long-poll
 * allowance for declared long-poll tool calls, the standard budget for
 * everything else (including anything unparseable — fail toward the
 * conservative budget, never toward the long one).
 */
export function mcpBrokerRequestTimeoutMsFor(request: unknown): number {
  const toolName = toolNameOfRequest(request)
  if (toolName === null) return MCP_BROKER_REQUEST_TIMEOUT_MS
  return LONG_POLL_TIMEOUT_BY_TOOL.get(toolName) ?? MCP_BROKER_REQUEST_TIMEOUT_MS
}
