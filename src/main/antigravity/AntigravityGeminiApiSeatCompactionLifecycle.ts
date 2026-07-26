export interface AntigravityGeminiApiSeatSummaryResult {
  readonly ok: boolean
  readonly text: string
  readonly error?: string
  readonly timedOut?: true
}

export interface AntigravityGeminiApiSeatSummaryClient {
  readonly models: {
    generateContentStream(parameters: {
      readonly model: string
      readonly contents: ReadonlyArray<{
        readonly role: 'user'
        readonly parts: ReadonlyArray<{ readonly text: string }>
      }>
      readonly config: { readonly abortSignal: AbortSignal }
    }): Promise<AsyncIterable<unknown>>
  }
}

export interface AntigravityGeminiApiSeatSummaryClientConstructor {
  new (options: { readonly apiKey: string }): AntigravityGeminiApiSeatSummaryClient
}

export interface AntigravityGeminiApiSeatSummaryOperation {
  /**
   * The semantic summarize result. A timeout aborts the exact request, but this
   * promise does not settle until that request/iterator has actually joined.
   */
  readonly result: Promise<AntigravityGeminiApiSeatSummaryResult>
  /**
   * Exact provider terminal evidence. MaintenanceCompactionRegistry may pair
   * beginNativeActivity with this promise rather than treating timeout as
   * transport close.
   */
  readonly terminal: Promise<void>
  readonly signal: AbortSignal
  abort(reason?: unknown): void
}

export interface StartAntigravityGeminiApiSeatSummaryInput {
  readonly GoogleGenAI: AntigravityGeminiApiSeatSummaryClientConstructor
  readonly apiKey: string
  readonly model: string
  readonly prompt: string
  readonly timeoutMs: number
  readonly cancellationSignal?: AbortSignal
  readonly createAbortController?: () => AbortController
}

type AbortKind = 'cancelled' | 'timeout'

const CANCELLED_ERROR = 'Compaction was cancelled for history deletion.'

/**
 * Starts one sender-free Gemini API seat-summary request.
 *
 * The timeout owns the same AbortController passed to the SDK. It never races
 * a detached `work` promise: after abort, the operation waits for the pending
 * request/iterator and its optional `return()` cleanup to settle. Every chunk
 * is fenced after `next()` so a provider that resolves one final chunk after
 * abort cannot mutate the summary.
 */
export function startAntigravityGeminiApiSeatSummary(
  input: StartAntigravityGeminiApiSeatSummaryInput
): AntigravityGeminiApiSeatSummaryOperation {
  const controller = (input.createAbortController ?? (() => new AbortController()))()
  const timeoutMs = Math.max(1, Math.trunc(input.timeoutMs))
  let abortKind: AbortKind | null = null

  const abort = (reason?: unknown): void => {
    if (!abortKind) abortKind = 'cancelled'
    if (!controller.signal.aborted) controller.abort(reason ?? 'seat-compaction-cancelled')
  }
  const cancelFromParent = (): void => abort(input.cancellationSignal?.reason)
  if (input.cancellationSignal?.aborted) {
    cancelFromParent()
  } else {
    input.cancellationSignal?.addEventListener('abort', cancelFromParent, { once: true })
  }

  const timeout = setTimeout(() => {
    if (!abortKind) abortKind = 'timeout'
    if (!controller.signal.aborted) controller.abort('seat-compaction-timeout')
  }, timeoutMs)
  timeout.unref?.()

  const result = (async (): Promise<AntigravityGeminiApiSeatSummaryResult> => {
    let iterator: AsyncIterator<unknown> | null = null
    let iteratorReturned = false
    const returnIterator = async (): Promise<void> => {
      if (iteratorReturned || typeof iterator?.return !== 'function') return
      iteratorReturned = true
      try {
        await iterator.return()
      } catch {
        // Rejection is still terminal evidence: the cleanup operation settled.
      }
    }
    const abortedResult = (): AntigravityGeminiApiSeatSummaryResult => {
      if (abortKind === 'timeout') {
        return {
          ok: false,
          text: '',
          timedOut: true,
          error: `Summarize turn timed out after ${Math.round(timeoutMs / 1000)}s.`
        }
      }
      return { ok: false, text: '', error: CANCELLED_ERROR }
    }

    try {
      if (controller.signal.aborted) return abortedResult()
      const client = new input.GoogleGenAI({ apiKey: input.apiKey })
      if (controller.signal.aborted) return abortedResult()
      const stream = await client.models.generateContentStream({
        model: input.model,
        contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
        config: { abortSignal: controller.signal }
      })
      iterator = stream[Symbol.asyncIterator]()
      if (controller.signal.aborted) {
        await returnIterator()
        return abortedResult()
      }

      let text = ''
      while (true) {
        const step = await iterator.next()
        if (controller.signal.aborted) {
          await returnIterator()
          return abortedResult()
        }
        if (step.done) break
        const chunk = step.value as any
        const parts = chunk?.candidates?.[0]?.content?.parts
        if (Array.isArray(parts)) {
          for (const part of parts) {
            if (part && part.thought !== true && typeof part.text === 'string') text += part.text
          }
        } else if (typeof chunk?.text === 'string') {
          text += chunk.text
        }
      }
      const trimmed = text.trim()
      return trimmed
        ? { ok: true, text: trimmed }
        : { ok: false, text: '', error: 'Summarize turn returned no text.' }
    } catch (error) {
      if (controller.signal.aborted) {
        await returnIterator()
        return abortedResult()
      }
      return {
        ok: false,
        text: '',
        error: error instanceof Error ? error.message : String(error)
      }
    } finally {
      clearTimeout(timeout)
      input.cancellationSignal?.removeEventListener('abort', cancelFromParent)
    }
  })()

  return {
    result,
    terminal: result.then(
      () => undefined,
      () => undefined
    ),
    signal: controller.signal,
    abort
  }
}
