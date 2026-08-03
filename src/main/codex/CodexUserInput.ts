import {
  REMOTE_QUESTION_MAX_CONTEXT_CHARS,
  REMOTE_QUESTION_MAX_OPTION_CHARS,
  REMOTE_QUESTION_MAX_OPTIONS,
  REMOTE_QUESTION_MAX_QUESTION_CHARS
} from '../RemoteQuestionRegistry'

/** Codex app-server's host UI request, not a TaskWraith MCP tool name. */
export const CODEX_USER_INPUT_METHOD = 'tool/requestUserInput'
export const CODEX_USER_INPUT_MAX_QUESTIONS = 3
export const CODEX_USER_INPUT_MAX_TIMEOUT_MS = 10 * 60 * 1000

export interface CodexUserInputQuestion {
  id: string
  question: string
  options?: string[]
  context?: string
}

export interface NormalizedCodexUserInputRequest {
  questions: CodexUserInputQuestion[]
  timeoutMs?: number
}

export type CodexUserInputNormalization =
  | { ok: true; request: NormalizedCodexUserInputRequest }
  | { ok: false; reason: string }

export function isCodexUserInputRequestMethod(
  method: unknown
): method is typeof CODEX_USER_INPUT_METHOD {
  return method === CODEX_USER_INPUT_METHOD
}

/**
 * Normalize the structured Codex host request into the one-question shape
 * already understood by RemoteQuestionRegistry. The caller can present the
 * returned questions sequentially and build the native `{ answers }` object
 * with the original ids. This deliberately does not enter TaskWraith's MCP
 * catalogue or provider-action taxonomy.
 */
export function normalizeCodexUserInputRequest(params: unknown): CodexUserInputNormalization {
  const input = recordFromUnknown(params)
  const rawQuestions = input?.questions
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    return { ok: false, reason: 'Codex user input request has no questions.' }
  }
  if (rawQuestions.length > CODEX_USER_INPUT_MAX_QUESTIONS) {
    return {
      ok: false,
      reason: `Codex user input request supports at most ${CODEX_USER_INPUT_MAX_QUESTIONS} questions.`
    }
  }

  const questions: CodexUserInputQuestion[] = []
  const ids = new Set<string>()
  for (const [index, rawQuestion] of rawQuestions.entries()) {
    const question = recordFromUnknown(rawQuestion)
    const id = boundedIdentifier(question?.id)
    const prompt = boundedString(question?.question, REMOTE_QUESTION_MAX_QUESTION_CHARS)
    if (!id || !prompt) {
      return { ok: false, reason: `Codex user input question ${index + 1} is malformed.` }
    }
    if (ids.has(id)) {
      return { ok: false, reason: `Codex user input question id "${id}" is duplicated.` }
    }
    ids.add(id)

    const options = normalizeOptions(question?.options)
    if (options === null) {
      return { ok: false, reason: `Codex user input question ${id} has too many options.` }
    }
    const context = boundedString(
      question?.header ?? question?.title,
      REMOTE_QUESTION_MAX_CONTEXT_CHARS
    )
    questions.push({
      id,
      question: prompt,
      ...(options.length > 0 ? { options } : {}),
      ...(context ? { context } : {})
    })
  }

  const timeoutMs = positiveInteger(input?.timeoutMs ?? input?.timeout_ms)
  return {
    ok: true,
    request: {
      questions,
      ...(timeoutMs !== undefined ? { timeoutMs } : {})
    }
  }
}

/** Keep the native response scoped to the ids TaskWraith actually displayed. */
export function buildCodexUserInputResponse(
  questions: readonly CodexUserInputQuestion[],
  answers: Readonly<Record<string, string>>
): { answers: Record<string, string> } {
  const response: Record<string, string> = {}
  for (const question of questions) {
    const answer = answers[question.id]
    if (typeof answer === 'string') response[question.id] = answer
  }
  return { answers: response }
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function boundedString(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return ''
  const normalized = value.trim()
  return normalized.length <= maxChars ? normalized : normalized.slice(0, maxChars)
}

function boundedIdentifier(value: unknown): string {
  if (typeof value !== 'string') return ''
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= 128 ? normalized : ''
}

function normalizeOptions(value: unknown): string[] | null {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return null
  const seen = new Set<string>()
  const options: string[] = []
  for (const rawOption of value) {
    const option = recordFromUnknown(rawOption)
    const label = boundedString(
      typeof rawOption === 'string' ? rawOption : option?.label,
      REMOTE_QUESTION_MAX_OPTION_CHARS
    )
    if (!label || seen.has(label)) continue
    seen.add(label)
    options.push(label)
  }
  return options.length > REMOTE_QUESTION_MAX_OPTIONS ? null : options
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.min(Math.floor(value), CODEX_USER_INPUT_MAX_TIMEOUT_MS)
}
