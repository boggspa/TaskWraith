import type { RemoteQuestionRecord, RemoteQuestionResolution } from '../RemoteQuestionRegistry'
import {
  buildCodexUserInputResponse,
  normalizeCodexUserInputRequest,
  type CodexUserInputQuestion
} from './CodexUserInput'

export interface CodexUserInputBridgeCallbacks {
  registerQuestion: (
    question: CodexUserInputQuestion,
    resolve: (result: RemoteQuestionResolution) => void,
    ttlMs: number | undefined,
    index: number
  ) => RemoteQuestionRecord
  emitQuestion: (record: RemoteQuestionRecord) => void
  now?: () => number
}

export type CodexUserInputBridgeResult =
  | { ok: true; response: { answers: Record<string, string> } }
  | { ok: false; reason: string }

/**
 * Collect one Codex host request through the existing one-question registry
 * surface. Questions are intentionally sequential: the renderer/iOS card is
 * unchanged, while the final response still preserves every host question id.
 */
export async function collectCodexUserInput(
  params: unknown,
  callbacks: CodexUserInputBridgeCallbacks
): Promise<CodexUserInputBridgeResult> {
  const normalized = normalizeCodexUserInputRequest(params)
  if (!normalized.ok) return normalized

  const now = callbacks.now ?? Date.now
  const deadlineMs = normalized.request.timeoutMs ? now() + normalized.request.timeoutMs : undefined
  const answers: Record<string, string> = {}

  for (const [index, question] of normalized.request.questions.entries()) {
    const ttlMs = remainingTtlMs(deadlineMs, now)
    if (deadlineMs !== undefined && ttlMs === 0) {
      return { ok: false, reason: 'Codex user input request timed out.' }
    }
    const result = await new Promise<RemoteQuestionResolution>((resolve) => {
      try {
        const record = callbacks.registerQuestion(question, resolve, ttlMs, index)
        callbacks.emitQuestion(record)
      } catch {
        resolve({
          answer: '',
          is_custom: false,
          cancelled: true,
          cancellation_reason: 'question-surface-unavailable'
        })
      }
    })
    if (result.cancelled) {
      return {
        ok: false,
        reason: result.cancellation_reason || 'Codex user input request was cancelled.'
      }
    }
    answers[question.id] = result.answer
  }

  return {
    ok: true,
    response: buildCodexUserInputResponse(normalized.request.questions, answers)
  }
}

function remainingTtlMs(deadlineMs: number | undefined, now: () => number): number | undefined {
  if (deadlineMs === undefined) return undefined
  return Math.max(0, deadlineMs - now())
}
