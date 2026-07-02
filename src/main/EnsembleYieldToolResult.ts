export type EnsembleYieldToolResult = {
  ok: boolean
  tool: 'ensemble_yield'
  reason?: string
  target?: string
  message?: string
  error?: 'no_active_run'
}

export const ENSEMBLE_YIELD_NO_ACTIVE_RUN_MESSAGE =
  'No active Ensemble participant run matches this yield call.'

export function buildEnsembleYieldToolResult(input: {
  yielded: boolean
  reason?: string
  target?: string
}): EnsembleYieldToolResult {
  const base = {
    ok: input.yielded,
    tool: 'ensemble_yield' as const,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.target ? { target: input.target } : {})
  }
  if (input.yielded) return base
  return {
    ...base,
    message: ENSEMBLE_YIELD_NO_ACTIVE_RUN_MESSAGE,
    error: 'no_active_run'
  }
}
