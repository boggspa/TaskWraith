/**
 * Local, opt-in startup milestone timeline.
 *
 * The 2026-08-29 investigation had to reconstruct where launch time went from a
 * V8 sampling profile and a CDP probe, because the main process recorded
 * nothing. With the workspace-lock WAL replay off the critical path the
 * remaining pre-window budget is the largest single block left, and the next
 * person to attack it should not have to re-derive the split.
 *
 * Off unless TASKWRAITH_STARTUP_MILESTONES=1. It is deliberately local: marks
 * are held in memory and printed once to this process's own stdout. Nothing is
 * reported anywhere, and enabling it changes no behaviour beyond the log line.
 */

export const STARTUP_MILESTONES_ENV = 'TASKWRAITH_STARTUP_MILESTONES'

export interface StartupMilestone {
  name: string
  /** ms since process start. */
  atMs: number
  /** ms since the previous milestone. */
  deltaMs: number
}

interface StartupMilestoneRecorderOptions {
  enabled?: boolean
  /** ms since process start; injected so the report is testable. */
  now?: () => number
  log?: (line: string) => void
}

export class StartupMilestoneRecorder {
  private readonly marks: StartupMilestone[] = []
  private readonly enabled: boolean
  private readonly now: () => number
  private readonly log: (line: string) => void
  private reported = false

  constructor(options: StartupMilestoneRecorderOptions = {}) {
    this.enabled = options.enabled ?? process.env[STARTUP_MILESTONES_ENV] === '1'
    this.now = options.now ?? (() => Math.round(process.uptime() * 1000))
    this.log = options.log ?? ((line) => console.info(line))
  }

  mark(name: string): void {
    if (!this.enabled) return
    const atMs = this.now()
    const previous = this.marks[this.marks.length - 1]
    this.marks.push({ name, atMs, deltaMs: previous ? atMs - previous.atMs : atMs })
  }

  milestones(): StartupMilestone[] {
    return this.marks.map((milestone) => ({ ...milestone }))
  }

  /** Prints once. A second call is a no-op so a re-shown window cannot spam. */
  report(): void {
    if (!this.enabled || this.reported || !this.marks.length) return
    this.reported = true
    this.log(`[startup] ${this.marks.map((m) => `${m.name}=${m.atMs}ms(+${m.deltaMs})`).join(' ')}`)
  }
}

/** The single process-wide recorder. */
export const startupMilestones = new StartupMilestoneRecorder()
