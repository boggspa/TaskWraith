import type { CloseoutSummaryRequest, CloseoutSummarySnapshot } from './store/types'
import { closeoutNarrativeHasAuthoredNumeral } from '../shared/closeoutReceipt'

/** Sanitize/normalize seam for the `closeout:summarize` IPC channel. Pure and
 *  self-contained (no index.ts imports) so it stays unit-testable and out of
 *  the main-process god-module. The daemon prompt is assembled verbatim from
 *  these strings, so every field is whitespace-collapsed and length-capped
 *  here regardless of what the renderer sent. */

const CLOSEOUT_DIGEST_MAX_ITEMS = 16
const CLOSEOUT_SUMMARY_RESULT_MAX_CHARS = 2000

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function compactText(value: unknown, maxLength: number): string {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`
}

function boundedCount(value: unknown, max = 1_000_000): number | undefined {
  const count = typeof value === 'number' ? value : NaN
  return Number.isFinite(count) && count >= 0 ? Math.min(Math.round(count), max) : undefined
}

/** Duration cap: 7 days in ms — far above any real run, small enough to keep
 *  the daemon's Int decode and prompt formatting sane. */
const CLOSEOUT_DURATION_MAX_MS = 604_800_000

function compactTextArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .slice(0, maxItems)
    .map((item) => compactText(item, maxLength))
    .filter(Boolean)
}

export function sanitizeCloseoutSummaryRequest(input: unknown): CloseoutSummaryRequest {
  const record = asRecord(input) || {}
  const targetId = compactText(record.targetId, 120)
  if (!targetId) throw new Error('Close-out summary target id is required.')

  const fileChanges = Array.isArray(record.fileChanges)
    ? record.fileChanges
        .slice(0, CLOSEOUT_DIGEST_MAX_ITEMS)
        .map((item) => {
          const row = asRecord(item) || {}
          const additions = boundedCount(row.additions)
          const deletions = boundedCount(row.deletions)
          return {
            path: compactText(row.path, 200),
            ...(additions !== undefined ? { additions } : {}),
            ...(deletions !== undefined ? { deletions } : {})
          }
        })
        .filter((item) => item.path)
    : []

  const commits = Array.isArray(record.commits)
    ? record.commits
        .slice(0, 8)
        .map((item) => {
          const row = asRecord(item) || {}
          const subject = compactText(row.subject, 140)
          return {
            hash: compactText(row.hash, 40),
            ...(subject ? { subject } : {})
          }
        })
        .filter((item) => item.hash)
    : []

  const toolCounts: Record<string, number> = {}
  for (const [key, value] of Object.entries(asRecord(record.toolCounts) || {}).slice(0, 12)) {
    const label = compactText(key, 40)
    const count = boundedCount(value)
    if (label && count !== undefined && count > 0) toolCounts[label] = count
  }

  const participants = Array.isArray(record.participants)
    ? record.participants
        .slice(0, 8)
        .map((item) => {
          const row = asRecord(item) || {}
          const provider = compactText(row.provider, 60)
          const model = compactText(row.model, 120)
          const status = compactText(row.status, 40)
          const finalText = compactText(row.finalText, 400)
          return {
            label: compactText(row.label, 80),
            ...(provider ? { provider } : {}),
            ...(model ? { model } : {}),
            ...(status ? { status } : {}),
            ...(finalText ? { finalText } : {})
          }
        })
        .filter((item) => item.label)
    : []

  const durationMs = boundedCount(record.durationMs, CLOSEOUT_DURATION_MAX_MS)
  const status = compactText(record.status, 60)
  const provider = compactText(record.provider, 60)
  const model = compactText(record.model, 120)
  const promptText = compactText(record.promptText, 700)
  const finalText = compactText(record.finalText, 1400)
  const validations = compactTextArray(record.validations, 6, 240)
  const warnings = compactTextArray(record.warnings, 8, 280)

  return enforceCloseoutDigestBudget({
    targetId,
    scope: record.scope === 'ensembleRound' ? 'ensembleRound' : 'run',
    ...(status ? { status } : {}),
    ...(durationMs !== undefined && durationMs > 0 ? { durationMs } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(promptText ? { promptText } : {}),
    ...(finalText ? { finalText } : {}),
    ...(fileChanges.length > 0 ? { fileChanges } : {}),
    ...(commits.length > 0 ? { commits } : {}),
    ...(Object.keys(toolCounts).length > 0 ? { toolCounts } : {}),
    ...(validations.length > 0 ? { validations } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(participants.length > 0 ? { participants } : {})
  })
}

/** Per-field caps alone still allow a worst-case digest (~16k chars for a busy
 *  8-participant ensemble round) that can blow the small on-device model's
 *  context window, silently downgrading exactly the close-outs that matter
 *  most. Shrink the digest in decreasing order of dispensability until it fits
 *  a conservative total budget. */
const CLOSEOUT_DIGEST_TOTAL_BUDGET_CHARS = 6000

function approximateDigestChars(request: CloseoutSummaryRequest): number {
  let total =
    (request.promptText?.length || 0) +
    (request.finalText?.length || 0) +
    (request.status?.length || 0) +
    (request.provider?.length || 0) +
    (request.model?.length || 0)
  for (const change of request.fileChanges || []) total += change.path.length + 16
  for (const commit of request.commits || []) total += commit.hash.length + (commit.subject?.length || 0) + 3
  for (const key of Object.keys(request.toolCounts || {})) total += key.length + 8
  for (const validation of request.validations || []) total += validation.length + 3
  for (const warning of request.warnings || []) total += warning.length + 3
  for (const participant of request.participants || []) {
    total +=
      participant.label.length +
      (participant.provider?.length || 0) +
      (participant.model?.length || 0) +
      (participant.status?.length || 0) +
      (participant.finalText?.length || 0) +
      12
  }
  return total
}

function enforceCloseoutDigestBudget(request: CloseoutSummaryRequest): CloseoutSummaryRequest {
  const reductions: Array<(input: CloseoutSummaryRequest) => CloseoutSummaryRequest> = [
    (input) =>
      input.participants
        ? {
            ...input,
            participants: input.participants.map((participant) =>
              participant.finalText
                ? { ...participant, finalText: compactText(participant.finalText, 160) }
                : participant
            )
          }
        : input,
    (input) =>
      input.participants && input.participants.length > 4
        ? { ...input, participants: input.participants.slice(0, 4) }
        : input,
    (input) => (input.finalText ? { ...input, finalText: compactText(input.finalText, 700) } : input),
    (input) =>
      input.fileChanges && input.fileChanges.length > 8
        ? { ...input, fileChanges: input.fileChanges.slice(0, 8) }
        : input,
    (input) =>
      input.warnings && input.warnings.length > 4
        ? { ...input, warnings: input.warnings.slice(0, 4) }
        : input,
    (input) =>
      input.commits && input.commits.length > 4
        ? { ...input, commits: input.commits.slice(0, 4) }
        : input,
    (input) => (input.promptText ? { ...input, promptText: compactText(input.promptText, 300) } : input)
  ]
  let result = request
  for (const reduce of reductions) {
    if (approximateDigestChars(result) <= CLOSEOUT_DIGEST_TOTAL_BUDGET_CHARS) return result
    result = reduce(result)
  }
  return result
}

export function normalizeCloseoutSummaryResult(
  request: CloseoutSummaryRequest,
  result: unknown,
  generatedAt: string
): CloseoutSummarySnapshot {
  const record = asRecord(result) || {}
  const summary = compactText(record.summary, CLOSEOUT_SUMMARY_RESULT_MAX_CHARS)
  if (!summary) {
    return buildCloseoutSummaryUnavailableSnapshot(
      request,
      'Foundation Models returned no close-out summary.'
    )
  }
  if (closeoutNarrativeHasAuthoredNumeral(summary)) {
    return buildCloseoutSummaryUnavailableSnapshot(
      request,
      'Foundation Models returned a quantitative claim reserved for the app-owned receipt.'
    )
  }
  return {
    targetId: request.targetId,
    generatedAt,
    status: 'ready',
    summary,
    model: compactText(record.model, 120) || 'Apple Foundation Models'
  }
}

export function buildCloseoutSummaryUnavailableSnapshot(
  request: CloseoutSummaryRequest,
  reason: string
): CloseoutSummarySnapshot {
  return {
    targetId: request.targetId,
    generatedAt: new Date().toISOString(),
    status: 'unavailable',
    summary: '',
    error: compactText(reason, 500) || 'Close-out summarization is unavailable.'
  }
}
