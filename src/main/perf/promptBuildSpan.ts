/**
 * prompt_build span (Independent Threads Programme M1 / S1).
 *
 * Measures the heavyweight Ensemble participant prompt projection, not the
 * waitForBuildTurn macrotask yield and not persist-barrier completion.
 * Optional sink: production uses hostAdmission.workSpans. A throwing sink
 * loses the measurement, never the prompt.
 */

import type { WorkSpanRecordInput } from './WorkSpanRecorder'

export type PromptBuildSpanSink = {
  record(span: WorkSpanRecordInput): void
}

export interface PromptBuildSpanAttrs {
  readonly chatId?: string
  readonly runId?: string
  readonly participantId?: string
  readonly laneId?: string
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function emitPromptBuild(
  sink: PromptBuildSpanSink,
  attrs: PromptBuildSpanAttrs,
  chatId: string,
  startedAt: number,
  durationMs: number,
  bytes: number
): void {
  try {
    sink.record({
      chatId,
      kind: 'prompt_build',
      startedAt,
      durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0,
      bytes: Number.isFinite(bytes) && bytes >= 0 ? bytes : 0,
      // Main-thread CPU; the closed resource set has no cost-centre token (A1.27).
      resource: 'none',
      ...(isNonEmptyString(attrs.runId) ? { runId: attrs.runId.trim() } : {}),
      ...(isNonEmptyString(attrs.participantId)
        ? { participantId: attrs.participantId.trim() }
        : {}),
      ...(isNonEmptyString(attrs.laneId) ? { laneId: attrs.laneId.trim() } : {})
    })
  } catch {
    // Instrumentation must never alter prompt construction.
  }
}

/**
 * Run a prompt projection and record one prompt_build span. Missing sink or
 * chatId skips measurement and still runs the builder.
 */
export function recordPromptBuildSpan<T extends { prompt: string }>(
  sink: PromptBuildSpanSink | undefined,
  attrs: PromptBuildSpanAttrs,
  build: () => T,
  now: () => number = Date.now
): T {
  const chatId = isNonEmptyString(attrs.chatId) ? attrs.chatId.trim() : ''
  if (!sink || !chatId) return build()
  let startedAt: number
  try {
    startedAt = now()
  } catch {
    return build()
  }
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt < 0) {
    return build()
  }
  let result: T
  try {
    result = build()
  } catch (error) {
    let endedAt: number
    try {
      endedAt = now()
    } catch {
      throw error
    }
    if (typeof endedAt === 'number' && Number.isFinite(endedAt) && endedAt >= 0) {
      emitPromptBuild(sink, attrs, chatId, startedAt, Math.max(0, endedAt - startedAt), 0)
    }
    throw error
  }
  let endedAt: number
  try {
    endedAt = now()
  } catch {
    return result
  }
  if (typeof endedAt !== 'number' || !Number.isFinite(endedAt) || endedAt < 0) return result
  const prompt = result?.prompt
  const bytes = typeof prompt === 'string' ? prompt.length : 0
  emitPromptBuild(sink, attrs, chatId, startedAt, Math.max(0, endedAt - startedAt), bytes)
  return result
}
