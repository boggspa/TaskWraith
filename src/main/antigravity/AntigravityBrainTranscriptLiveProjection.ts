/**
 * Live, display-only projection of official agy's durable brain transcript.
 *
 * `agy --print` exposes only assistant text on stdout. Planner thinking and
 * read-side tool events are appended to `transcript.jsonl`, so TaskWraith tails
 * that file while the exact run is live. Projection failure can never affect
 * provider execution or terminal settlement.
 */

import { promises as fs } from 'fs'
import os from 'os'
import {
  advanceCliProviderThinkingSegments,
  cliProviderThinkingSegmentToolId,
  type CliProviderThinkingSegmentsState
} from '../providers/CliProviderThinking'
import {
  parseAgyProjectBoundSessionId,
  readAgyConversationReceipt
} from './AntigravityConversationReceipt'
import {
  agyBrainTranscriptPath,
  parseAgyTranscriptLine,
  projectAgyStepTools,
  type AgyToolEvent,
  type AgyTranscriptStep
} from './AntigravityToolProjection'

const DEFAULT_POLL_INTERVAL_MS = 400
const THINKING_CHUNK_MAX_CHARS = 24_000
const INVALID_TOOL_WARNING_THRESHOLD = 5

export type AgyBrainTranscriptCompatEvent =
  | AgyToolEvent
  | {
      type: 'provider_warning'
      severity: 'warning'
      title: string
      message: string
    }

function stripTranscriptTimingHeaders(content: string): string {
  return content
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:Created|Completed) At:\s*/i.test(line))
    .join('\n')
    .trim()
}

function diagnosticOutput(message: string, count: number, total: number): string {
  const occurrence = count === 1 ? '1 occurrence' : `${count} repeated occurrences`
  const totalSuffix = total === count ? '' : ` · ${total} tool errors this turn`
  return `${message || 'AntiGravity reported a tool error.'}\n\n${occurrence}${totalSuffix}`
}

/**
 * Pure incremental reducer used by the file monitor and unit tests. A baseline
 * suppresses prior turns in a resumed conversation; later calls consume only
 * records with a larger native step index.
 */
export class AgyBrainTranscriptProjector {
  private maxStepIndex = -1
  private readonly thinkingState: CliProviderThinkingSegmentsState = {}
  private readonly seenThinking = new Set<string>()
  private readonly errorCounts = new Map<string, number>()
  private errorTotal = 0
  private diagnosticStarted = false
  private invalidToolWarningEmitted = false

  constructor(private readonly appRunId: string) {}

  markBaseline(lines: readonly string[]): void {
    for (const line of lines) {
      const step = parseAgyTranscriptLine(line)
      if (step) this.maxStepIndex = Math.max(this.maxStepIndex, step.step_index)
    }
  }

  consume(lines: readonly string[]): AgyBrainTranscriptCompatEvent[] {
    const events: AgyBrainTranscriptCompatEvent[] = []
    for (const line of lines) {
      const step = parseAgyTranscriptLine(line)
      if (!step || step.step_index <= this.maxStepIndex) continue
      this.maxStepIndex = step.step_index
      events.push(...this.projectStep(step))
    }
    return events
  }

  private projectStep(step: AgyTranscriptStep): AgyBrainTranscriptCompatEvent[] {
    if (step.source !== 'MODEL') return []

    if (step.type === 'PLANNER_RESPONSE') {
      return this.projectThinking(step.thinking)
    }

    // Every native model step between planner frames is a chronology boundary,
    // including shell/write calls projected independently by the hook bridge.
    if (this.thinkingState.thinkingStarted) this.thinkingState.thinkingChronoBreak = true

    if (step.type === 'ERROR_MESSAGE') return this.projectError(step.content)
    return projectAgyStepTools(step)
  }

  private projectThinking(rawThinking: string | undefined): AgyBrainTranscriptCompatEvent[] {
    const thinking = (rawThinking || '').trim()
    if (!thinking || this.seenThinking.has(thinking)) return []
    this.seenThinking.add(thinking)

    const current = this.thinkingState.thinkingText || ''
    const chunk = current && !this.thinkingState.thinkingChronoBreak ? `\n\n${thinking}` : thinking
    const advance = advanceCliProviderThinkingSegments(
      this.thinkingState,
      chunk.slice(0, THINKING_CHUNK_MAX_CHARS)
    )
    if (!advance) return []

    const toolId = cliProviderThinkingSegmentToolId(
      'antigravity',
      this.appRunId,
      advance.segmentSeq
    )
    const events: AgyBrainTranscriptCompatEvent[] = []
    if (advance.startedNewActivity) {
      events.push({
        type: 'tool_use',
        tool_id: toolId,
        tool_name: 'antigravity_thinking',
        parameters: { title: 'AntiGravity thinking', kind: 'reasoning' }
      })
    }
    events.push({
      type: 'tool_result',
      tool_id: toolId,
      tool_name: 'antigravity_thinking',
      parameters: {},
      status: 'success',
      output: advance.text
    })
    return events
  }

  private projectError(rawContent: string): AgyBrainTranscriptCompatEvent[] {
    const message = stripTranscriptTimingHeaders(rawContent) || rawContent.trim()
    const key = message.replace(/\s+/g, ' ').trim() || 'unknown tool error'
    const count = (this.errorCounts.get(key) || 0) + 1
    this.errorCounts.set(key, count)
    this.errorTotal += 1

    const toolId = `antigravity-thinking-${this.appRunId}-tool-retries`
    const events: AgyBrainTranscriptCompatEvent[] = []
    if (!this.diagnosticStarted) {
      this.diagnosticStarted = true
      events.push({
        type: 'tool_use',
        tool_id: toolId,
        tool_name: 'antigravity_thinking',
        parameters: { title: 'AntiGravity tool retries', kind: 'reasoning' }
      })
    }
    events.push({
      type: 'tool_result',
      tool_id: toolId,
      tool_name: 'antigravity_thinking',
      parameters: {},
      status: 'error',
      output: diagnosticOutput(message, count, this.errorTotal)
    })

    if (
      !this.invalidToolWarningEmitted &&
      count >= INVALID_TOOL_WARNING_THRESHOLD &&
      /invalid tool call/i.test(message)
    ) {
      this.invalidToolWarningEmitted = true
      events.push({
        type: 'provider_warning',
        severity: 'warning',
        title: 'AntiGravity is retrying an invalid tool call',
        message:
          `The official agy runtime rejected the same tool call ${count} times. ` +
          'TaskWraith has coalesced the retries into one thinking trace so the failure is visible without flooding the transcript.'
      })
    }
    return events
  }
}

export interface AgyBrainTranscriptMonitorDependencies {
  readFile?: (path: string) => Promise<string>
  stat?: (path: string) => Promise<{ size: number; mtimeMs: number }>
  readReceipt?: (workspace: string | null | undefined) => Promise<string | null>
  homeDir?: string
  env?: Readonly<Record<string, string | undefined>>
  pollIntervalMs?: number
}

export interface AgyBrainTranscriptMonitorInput {
  appRunId: string
  workspace: string | null | undefined
  providerSessionId: string | null | undefined
  receiptBeforeFreshProject?: string | null
  emit: (event: AgyBrainTranscriptCompatEvent) => void
  deps?: AgyBrainTranscriptMonitorDependencies
}

/** Best-effort polling monitor; callers stop-and-drain it before run terminal projection. */
export class AgyBrainTranscriptMonitor {
  private readonly deps: AgyBrainTranscriptMonitorDependencies
  private readonly projector: AgyBrainTranscriptProjector
  private conversationId: string | null
  private lastSnapshotKey = ''
  private timer: NodeJS.Timeout | undefined
  private inFlight: Promise<void> = Promise.resolve()
  private started = false
  private stopped = false

  constructor(private readonly input: AgyBrainTranscriptMonitorInput) {
    this.deps = input.deps || {}
    this.projector = new AgyBrainTranscriptProjector(input.appRunId)
    this.conversationId = parseAgyProjectBoundSessionId(input.providerSessionId)
  }

  async prime(): Promise<void> {
    if (!this.conversationId) return
    const raw = await this.readTranscript(this.conversationId)
    if (raw === null) return
    this.projector.markBaseline(raw.split(/\r?\n/))
    await this.rememberSnapshot(this.conversationId)
  }

  start(): void {
    if (this.started || this.stopped) return
    this.started = true
    this.schedule(0)
  }

  async pollNow(): Promise<void> {
    await this.poll(false)
  }

  async stopAndDrain(): Promise<void> {
    if (this.stopped) return this.inFlight
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    await this.inFlight
    await this.poll(true)
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.inFlight = this.poll(false).finally(() => {
        this.schedule(this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
      })
    }, delayMs)
    this.timer.unref?.()
  }

  private async poll(force: boolean): Promise<void> {
    try {
      if (!this.conversationId) {
        const readReceipt =
          this.deps.readReceipt ||
          ((workspace: string | null | undefined) => readAgyConversationReceipt(workspace))
        const learned = await readReceipt(this.input.workspace)
        if (!learned || learned === this.input.receiptBeforeFreshProject) return
        this.conversationId = learned
        this.lastSnapshotKey = ''
      }

      if (!force && !(await this.transcriptChanged(this.conversationId))) return
      const raw = await this.readTranscript(this.conversationId)
      if (raw === null) return
      const events = this.projector.consume(raw.split(/\r?\n/))
      for (const event of events) {
        try {
          this.input.emit(event)
        } catch {
          // Projection is display-only.
        }
      }
      await this.rememberSnapshot(this.conversationId)
    } catch {
      // Missing/partial transcript state is expected while agy allocates a project.
    }
  }

  private transcriptPath(conversationId: string): string {
    return agyBrainTranscriptPath(
      conversationId,
      this.deps.env ?? process.env,
      this.deps.homeDir ?? os.homedir()
    )
  }

  private async readTranscript(conversationId: string): Promise<string | null> {
    const readFile = this.deps.readFile || ((path: string) => fs.readFile(path, 'utf8'))
    try {
      return await readFile(this.transcriptPath(conversationId))
    } catch {
      return null
    }
  }

  private async snapshotKey(conversationId: string): Promise<string> {
    const stat = this.deps.stat || ((path: string) => fs.stat(path))
    const snapshot = await stat(this.transcriptPath(conversationId))
    return `${snapshot.size}:${snapshot.mtimeMs}`
  }

  private async transcriptChanged(conversationId: string): Promise<boolean> {
    try {
      return (await this.snapshotKey(conversationId)) !== this.lastSnapshotKey
    } catch {
      return false
    }
  }

  private async rememberSnapshot(conversationId: string): Promise<void> {
    try {
      this.lastSnapshotKey = await this.snapshotKey(conversationId)
    } catch {
      this.lastSnapshotKey = ''
    }
  }
}
