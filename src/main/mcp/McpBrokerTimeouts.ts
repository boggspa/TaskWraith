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
 * waiting on their behalf. `ensemble_await` (owner request 2026-08-05) may
 * wait up to 10 minutes per call for fan-out lanes to settle, so its broker
 * budget is that ceiling plus grace — the broker kill stays a last-resort
 * liveness backstop, never the effective cap. Keep this list in lockstep with
 * the awaited-tool clamps in EnsembleOrchestrator (ENSEMBLE_AWAIT_MAX_*).
 */

export const MCP_BROKER_REQUEST_TIMEOUT_MS = 130_000

/** ensemble_await clamp ceiling (600s) + 30s grace. */
export const MCP_BROKER_LONG_POLL_TIMEOUT_MS = 630_000

const LONG_POLL_TOOL_NAMES: ReadonlySet<string> = new Set(['ensemble_await'])

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
  return toolName !== null && LONG_POLL_TOOL_NAMES.has(toolName)
    ? MCP_BROKER_LONG_POLL_TIMEOUT_MS
    : MCP_BROKER_REQUEST_TIMEOUT_MS
}
