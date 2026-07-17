export interface KimiThinkingBatchState {
  kimiThinkingPendingText?: string
  kimiThinkingFlushTimer?: NodeJS.Timeout
}

export interface KimiThinkingBatchTimers {
  setTimeoutFn?: (callback: () => void, ms: number) => NodeJS.Timeout
  clearTimeoutFn?: (timer: NodeJS.Timeout) => void
}

export const KIMI_THINKING_BATCH_MS = 250

/**
 * Kimi ACP emits thinking one token at a time. Publishing each token as a
 * cumulative tool_result floods the durable ledger and renderer, which can
 * make the approval card unresponsive just when a tool call arrives. Batch
 * only the transport updates; the accumulated trace and chronology stay
 * byte-for-byte intact.
 */
export function queueKimiThinkingChunk(
  state: KimiThinkingBatchState,
  text: string,
  emit: (chunk: string) => void,
  timers: KimiThinkingBatchTimers = {}
): void {
  if (!text) return
  state.kimiThinkingPendingText = `${state.kimiThinkingPendingText || ''}${text}`
  if (state.kimiThinkingFlushTimer) return
  const setTimeoutFn = timers.setTimeoutFn ?? ((callback, ms) => setTimeout(callback, ms))
  state.kimiThinkingFlushTimer = setTimeoutFn(() => {
    state.kimiThinkingFlushTimer = undefined
    const pending = state.kimiThinkingPendingText || ''
    state.kimiThinkingPendingText = ''
    if (pending) emit(pending)
  }, KIMI_THINKING_BATCH_MS)
}

/** Flush before content/tools/close so no final suffix or ordering is lost. */
export function flushKimiThinkingChunks(
  state: KimiThinkingBatchState,
  emit: (chunk: string) => void,
  timers: KimiThinkingBatchTimers = {}
): void {
  if (state.kimiThinkingFlushTimer) {
    const clearTimeoutFn = timers.clearTimeoutFn ?? ((timer) => clearTimeout(timer))
    clearTimeoutFn(state.kimiThinkingFlushTimer)
    state.kimiThinkingFlushTimer = undefined
  }
  const pending = state.kimiThinkingPendingText || ''
  state.kimiThinkingPendingText = ''
  if (pending) emit(pending)
}
