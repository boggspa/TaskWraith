/**
 * Execution-graph attempt prompts and raw stage output are durable receipt
 * evidence, not conversation turns. They stay in the owning ChatRecord so the
 * result barrier can verify them, but normal transcript/provider-history
 * projections must keep them behind the Execution Map.
 */
const EXECUTION_GRAPH_INTERNAL_MESSAGE_KINDS = new Set([
  'executionGraphAttempt',
  'executionGraphAttemptOutput'
])

export function isExecutionGraphInternalTranscriptMessage(message: {
  readonly metadata?: { readonly kind?: unknown } | null
}): boolean {
  const kind = message?.metadata?.kind
  return typeof kind === 'string' && EXECUTION_GRAPH_INTERNAL_MESSAGE_KINDS.has(kind)
}
