/**
 * Request budgets for the MCP broker clients (the socket hop between a
 * provider-side bridge stub and the TaskWraith main process).
 *
 * The default budget exists so a dead main process can never hang a provider
 * forever, and it must comfortably exceed the approval window (providers'
 * approval prompts hold tool calls open ~120s before the timeout policy
 * resolves them) — hence 130s.
 *
 * LONG-POLL tools deliberately hold their call open while main does bounded
 * waiting on their behalf:
 * - `ensemble_await` may wait up to 10 minutes per call for fan-out lanes to
 *   settle (ENSEMBLE_AWAIT_MAX_*), so its broker budget is that ceiling plus
 *   grace.
 * - `ask_user_question` parks until the user answers or the 12-minute
 *   registry TTL fires, so its broker budget is that ceiling plus grace.
 *
 * The broker kill stays a last-resort liveness backstop, never the effective
 * cap. Keep long-poll names in lockstep with the awaited-tool clamps.
 */

export const MCP_BROKER_REQUEST_TIMEOUT_MS = 130_000

/** ensemble_await clamp ceiling (600s) + 30s grace. */
export const MCP_BROKER_LONG_POLL_TIMEOUT_MS = 630_000

/** ask_user_question registry TTL (720s) + 30s grace. */
export const MCP_BROKER_ASK_USER_QUESTION_TIMEOUT_MS = 750_000

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
