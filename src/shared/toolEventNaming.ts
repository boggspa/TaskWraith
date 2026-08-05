/**
 * Single source of truth for "what is this tool called?" across the two lanes
 * that render the same provider tool call.
 *
 * Every provider stdout line carries a tool call twice: the legacy payload
 * (normalized by the renderer's GeminiStreamAdapter) and a `runItemEvents[]`
 * sidecar (synthesized by main's RunItemEventCompatMapper). Both lanes have to
 * derive a tool name from the same freeform payload, and they used to do it
 * with two hand-maintained fallback chains that had drifted apart — the adapter
 * read `function.name` and the mapper did not.
 *
 * That drift was user-visible: an OpenAI-shaped `{function:{name:"Bash"}}` call
 * rendered as TWO rows labelled differently ("Used tool" from the sidecar,
 * "Shell command" from the legacy lane), because the renderer's dedupe keyed on
 * the tool name and the two lanes disagreed about it. Keep both lanes on this
 * resolver so the names can never diverge again.
 */

function stringAt(source: unknown, ...keys: string[]): string {
  if (!source || typeof source !== 'object') return ''
  const record = source as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

function nested(source: unknown, key: string): unknown {
  if (!source || typeof source !== 'object') return undefined
  return (source as Record<string, unknown>)[key]
}

/**
 * Resolve a tool name from a provider tool payload, in the precedence order
 * both lanes must agree on. `fallback` is the caller's terminal value for a
 * payload that names the tool nowhere at all — the mapper's result branch
 * wants `undefined` (the name is genuinely unknown and downstream infers it),
 * the use branch wants a placeholder.
 */
export function resolveToolEventName(payload: unknown): string
export function resolveToolEventName<F extends string | undefined>(
  payload: unknown,
  fallback: F
): string | F
export function resolveToolEventName(
  payload: unknown,
  fallback: string | undefined = 'unknown'
): string | undefined {
  const params = nested(payload, 'params')
  return (
    stringAt(payload, 'tool_name', 'toolName', 'name') ||
    stringAt(nested(payload, 'function'), 'name') ||
    stringAt(payload, 'tool') ||
    stringAt(params, 'type') ||
    stringAt(nested(payload, 'item'), 'type') ||
    stringAt(nested(params, 'item'), 'type') ||
    stringAt(payload, 'type') ||
    fallback
  )
}
