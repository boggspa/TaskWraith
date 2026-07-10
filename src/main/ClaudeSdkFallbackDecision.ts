import type { RunSessionStatus } from './RunManager'

export type ClaudeSdkFailureDecision = 'cancelled' | 'terminal' | 'fallback'

type ErrorConstructorLike = abstract new (...args: any[]) => unknown

function errorString(error: unknown, key: 'name' | 'message' | 'code'): string {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return ''
  const value = (error as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}

export function isClaudeSdkAbortError(
  error: unknown,
  abortErrorConstructor?: ErrorConstructorLike
): boolean {
  let current = error
  const seen = new Set<unknown>()
  for (let depth = 0; current && depth < 5 && !seen.has(current); depth += 1) {
    seen.add(current)
    if (abortErrorConstructor) {
      try {
        if (current instanceof abortErrorConstructor) return true
      } catch {
        // A malformed SDK export must not turn an ordinary failure into a cancel.
      }
    }
    const name = errorString(current, 'name').toLowerCase()
    const code = errorString(current, 'code').toUpperCase()
    const message = errorString(current, 'message').toLowerCase()
    if (name === 'aborterror' || code === 'ABORT_ERR') return true
    if (
      message.includes('claude code process aborted by user') ||
      message === 'operation aborted' ||
      message === 'the operation was aborted'
    ) {
      return true
    }
    current =
      typeof current === 'object' && current !== null
        ? (current as { cause?: unknown }).cause
        : undefined
  }
  return false
}

export function decideClaudeSdkFailure(input: {
  error: unknown
  signalAborted?: boolean
  runStatus?: RunSessionStatus
  abortErrorConstructor?: ErrorConstructorLike
}): ClaudeSdkFailureDecision {
  if (
    input.signalAborted ||
    input.runStatus === 'cancelled' ||
    isClaudeSdkAbortError(input.error, input.abortErrorConstructor)
  ) {
    return 'cancelled'
  }
  if (input.runStatus === 'completed' || input.runStatus === 'failed') return 'terminal'
  return 'fallback'
}
