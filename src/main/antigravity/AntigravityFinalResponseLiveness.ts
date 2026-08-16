import { parseAgyTranscriptLine, type AgyTranscriptStep } from './AntigravityToolProjection'

export const ANTIGRAVITY_FINAL_RESPONSE_EXIT_GRACE_MS = 30_000

export interface AgyFinalResponseLivenessWarning {
  title: string
  message: string
}

export function isAgyCompletedFinalResponseCandidate(step: AgyTranscriptStep): boolean {
  return (
    step.source === 'MODEL' &&
    step.type === 'PLANNER_RESPONSE' &&
    step.status.trim().toUpperCase() === 'DONE' &&
    step.content.trim().length > 0 &&
    (!step.tool_calls || step.tool_calls.length === 0)
  )
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
    let latest: AgyTranscriptStep | null = null
    for (const line of lines) {
      const step = parseAgyTranscriptLine(line)
      if (step && (!latest || step.step_index > latest.step_index)) latest = step
    }
    if (!latest || !isAgyCompletedFinalResponseCandidate(latest)) {
      this.clearCandidate()
      return
    }
    if (latest.step_index === this.candidateStepIndex) return
    this.candidateStepIndex = latest.step_index
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
