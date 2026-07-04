/*
 * QuestionPushContent — private plaintext sealed into a question APNs push.
 * APNs carries only ciphertext; the iOS Notification Service Extension decrypts
 * this and rewrites the banner body to the first line of the question.
 */

export interface QuestionPushContent {
  question: string
}

const QUESTION_MAX_CODEPOINTS = 180

function firstMeaningfulLine(value: string | null | undefined): string {
  const raw = value ?? ''
  const firstLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  return firstLine || 'Open TaskWraith to answer.'
}

function clip(value: string, max: number): string {
  const codepoints = Array.from(value)
  if (codepoints.length <= max) return value
  return codepoints.slice(0, max - 1).join('').trimEnd() + '…'
}

export function buildQuestionPushPlaintext(content: QuestionPushContent): Buffer {
  return Buffer.from(
    JSON.stringify({
      question: clip(firstMeaningfulLine(content.question), QUESTION_MAX_CODEPOINTS)
    }),
    'utf8'
  )
}
