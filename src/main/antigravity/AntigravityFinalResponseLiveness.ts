import { parseAgyTranscriptLine, type AgyTranscriptStep } from './AntigravityToolProjection'

export const ANTIGRAVITY_FINAL_RESPONSE_EXIT_GRACE_MS = 30_000

export interface AgyFinalResponseLivenessWarning {
  title: string
  message: string
}

export interface AgyCompletedFinalResponse {
  stepIndex: number
  createdAt: string
  content: string
}

export function isAgyCompletedFinalResponseCandidate(step: AgyTranscriptStep): boolean {
  return (
    step.source === 'MODEL' &&
    step.type === 'PLANNER_RESPONSE' &&
    step.status.trim().toUpperCase() === 'DONE' &&
    step.content.trim().length > 0 &&
    (!step.tool_calls || step.tool_calls.length === 0) &&
    !(step.truncated_fields || []).some((field) => field.trim().toLowerCase() === 'content')
  )
}

function latestAgyTranscriptStep(lines: readonly string[]): AgyTranscriptStep | null {
  let latest: AgyTranscriptStep | null = null
  for (const line of lines) {
    const step = parseAgyTranscriptLine(line)
    if (step && (!latest || step.step_index > latest.step_index)) latest = step
  }
  return latest
}

export function latestAgyTranscriptStepIndex(lines: readonly string[]): number {
  return latestAgyTranscriptStep(lines)?.step_index ?? -1
}

/**
 * Returns only an exact terminal planner record that belongs after the caller's
 * turn baseline. A later native step disarms the candidate, even if an earlier
 * completed response remains in the transcript.
 */
export function latestAgyCompletedFinalResponse(
  lines: readonly string[],
  afterStepIndex = -1
): AgyCompletedFinalResponse | null {
  const latest = latestAgyTranscriptStep(lines)
  if (
    !latest ||
    latest.step_index <= afterStepIndex ||
    !isAgyCompletedFinalResponseCandidate(latest)
  ) {
    return null
  }
  return {
    stepIndex: latest.step_index,
    createdAt: latest.created_at,
    content: latest.content.trim()
  }
}

/**
 * Tracks native evidence that official agy has recorded a final response but
 * has not yet closed. This never converts brain content into assistant output
 * and never owns process settlement; it produces one display-only warning.
 */
export class AgyFinalResponseLiveness {
  private candidateStepIndex: number | null = null
  private observedAtMs = 0
  private warned = false
  private closed = false

  constructor(
    private readonly graceMs = ANTIGRAVITY_FINAL_RESPONSE_EXIT_GRACE_MS,
    private readonly now: () => number = Date.now
  ) {}

  observeTranscriptLines(lines: readonly string[]): void {
    if (this.closed) return
    const latest = latestAgyCompletedFinalResponse(lines)
    if (!latest) {
      this.clearCandidate()
      return
    }
    if (latest.stepIndex === this.candidateStepIndex) return
    this.candidateStepIndex = latest.stepIndex
    this.observedAtMs = this.now()
    this.warned = false
  }

  takeWarning(): AgyFinalResponseLivenessWarning | null {
    if (
      this.closed ||
      this.warned ||
      this.candidateStepIndex === null ||
      this.now() - this.observedAtMs < Math.max(0, this.graceMs)
    ) {
      return null
    }
    this.warned = true
    const seconds = Math.max(1, Math.round(this.graceMs / 1_000))
    return {
      title: 'AntiGravity final response is awaiting native exit',
      message:
        `AntiGravity's native transcript recorded a completed final response, but official agy has not exited after ${seconds} seconds. ` +
        'TaskWraith is preserving the live process and keeping run state plus any active workspace locks or permission leases in place until the native CLI exits.'
    }
  }

  close(): void {
    this.closed = true
    this.clearCandidate()
  }

  private clearCandidate(): void {
    this.candidateStepIndex = null
    this.observedAtMs = 0
    this.warned = false
  }
}
