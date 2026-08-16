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
import { isAbsolute, join, resolve, sep } from 'path'
import {
  advanceCliProviderThinkingSegments,
  cliProviderThinkingSegmentToolId,
  type CliProviderThinkingSegmentsState
} from '../providers/CliProviderThinking'
import { normalizeAgyConversationId } from './AntigravityCli'
import {
  AgyFinalResponseLiveness,
  latestAgyCompletedFinalResponse,
  latestAgyTranscriptStepIndex,
  type AgyCompletedFinalResponse
} from './AntigravityFinalResponseLiveness'
import {
  agyCliRootPath,
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
const TASKWRAITH_TRANSCRIPT_MARKERS = [
  'TaskWraith gateway MCP profile is active for this provider session.',
  'TaskWraith runtime note (',
  'TaskWraith Ensemble Mode'
] as const
const WORKSPACE_PATH_ARGUMENT_KEYS = new Set([
  'cwd',
  'absolutepath',
  'searchpath',
  'targetfile',
  'filepath',
  'path'
])

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

function decodeAgyTranscriptScalar(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const decoded = JSON.parse(trimmed)
      if (typeof decoded === 'string') return decoded
    } catch {
      return null
    }
  }
  return value
}

function pathBelongsToWorkspace(value: unknown, workspace: string): boolean {
  const decoded = decodeAgyTranscriptScalar(value)?.trim()
  if (!decoded) return false
  const path = decoded.startsWith('file://') ? decoded.slice('file://'.length) : decoded
  if (!isAbsolute(path)) return false
  const root = resolve(workspace)
  const candidate = resolve(path)
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

function transcriptHasWorkspaceProvenance(raw: string, workspace: string): boolean {
  let taskWraithPrompt = false
  let workspaceToolPath = false
  for (const line of raw.split(/\r?\n/)) {
    const step = parseAgyTranscriptLine(line)
    if (!step) continue
    if (
      step.source === 'USER_EXPLICIT' &&
      step.type === 'USER_INPUT' &&
      TASKWRAITH_TRANSCRIPT_MARKERS.some((marker) => step.content.includes(marker))
    ) {
      taskWraithPrompt = true
    }
    for (const toolCall of step.tool_calls || []) {
      if (!toolCall || typeof toolCall !== 'object' || Array.isArray(toolCall)) continue
      const args = (toolCall as { args?: unknown }).args
      if (!args || typeof args !== 'object' || Array.isArray(args)) continue
      for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
        if (
          WORKSPACE_PATH_ARGUMENT_KEYS.has(key.toLowerCase()) &&
          pathBelongsToWorkspace(value, workspace)
        ) {
          workspaceToolPath = true
          break
        }
      }
      if (workspaceToolPath) break
    }
    if (taskWraithPrompt && workspaceToolPath) return true
  }
  return false
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
  listBrainConversationIds?: (brainRootPath: string) => Promise<readonly string[]>
  finalResponseExitGraceMs?: number
  now?: () => number
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
  private readonly finalResponseLiveness: AgyFinalResponseLiveness
  private conversationId: string | null
  private freshConversationBaseline: Set<string> | null = null
  private baselineStepIndex = -1
  private transcriptBaselineReady = false
  private completedFinalResponse: AgyCompletedFinalResponse | null = null
  private lastSnapshotKey = ''
  private timer: NodeJS.Timeout | undefined
  private inFlight: Promise<void> = Promise.resolve()
  private drain: Promise<AgyCompletedFinalResponse | null> | null = null
  private started = false
  private stopped = false

  constructor(private readonly input: AgyBrainTranscriptMonitorInput) {
    this.deps = input.deps || {}
    this.projector = new AgyBrainTranscriptProjector(input.appRunId)
    this.finalResponseLiveness = new AgyFinalResponseLiveness(
      this.deps.finalResponseExitGraceMs,
      this.deps.now
    )
    this.conversationId = parseAgyProjectBoundSessionId(input.providerSessionId)
  }

  async prime(): Promise<void> {
    if (!this.conversationId) {
      try {
        this.freshConversationBaseline = new Set(await this.listBrainConversationIds())
        this.transcriptBaselineReady = true
      } catch {
        this.freshConversationBaseline = null
      }
      return
    }
    const raw = await this.readTranscript(this.conversationId)
    if (raw === null) return
    const lines = raw.split(/\r?\n/)
    this.projector.markBaseline(lines)
    this.baselineStepIndex = latestAgyTranscriptStepIndex(lines)
    this.transcriptBaselineReady = true
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

  async stopAndDrain(): Promise<AgyCompletedFinalResponse | null> {
    if (this.drain) return this.drain
    this.stopped = true
    this.finalResponseLiveness.close()
    if (this.timer) clearTimeout(this.timer)
    this.drain = (async () => {
      await this.inFlight
      await this.poll(true)
      return this.completedFinalResponse
    })()
    return this.drain
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
      if (!this.transcriptBaselineReady) return
      if (!this.conversationId) {
        const readReceipt =
          this.deps.readReceipt ||
          ((workspace: string | null | undefined) => readAgyConversationReceipt(workspace))
        const learned = await readReceipt(this.input.workspace)
        const discovered = await this.discoverFreshConversationId()
        if (!discovered) return
        // The cwd receipt is shared by every agy process in this workspace, so
        // it can corroborate a unique post-launch brain but can never select
        // one by itself. A changed receipt that points elsewhere is a race;
        // fail closed instead of projecting another run's transcript.
        if (
          learned &&
          learned !== this.input.receiptBeforeFreshProject &&
          normalizeAgyConversationId(learned) !== discovered
        ) {
          return
        }
        this.conversationId = discovered
        this.lastSnapshotKey = ''
      }

      if (!force && !(await this.transcriptChanged(this.conversationId))) {
        this.emitFinalResponseLivenessWarning()
        return
      }
      const raw = await this.readTranscript(this.conversationId)
      if (raw === null) return
      const lines = raw.split(/\r?\n/)
      this.completedFinalResponse = latestAgyCompletedFinalResponse(lines, this.baselineStepIndex)
      this.finalResponseLiveness.observeTranscriptLines(lines)
      const events = this.projector.consume(lines)
      for (const event of events) {
        try {
          this.input.emit(event)
        } catch {
          // Projection is display-only.
        }
      }
      await this.rememberSnapshot(this.conversationId)
      if (!force) this.emitFinalResponseLivenessWarning()
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

  private brainRootPath(): string {
    return join(
      agyCliRootPath(this.deps.env ?? process.env, this.deps.homeDir ?? os.homedir()),
      'antigravity-cli',
      'brain'
    )
  }

  private emitFinalResponseLivenessWarning(): void {
    const warning = this.finalResponseLiveness.takeWarning()
    if (!warning) return
    try {
      this.input.emit({
        type: 'provider_warning',
        severity: 'warning',
        ...warning
      })
    } catch {
      // Projection is display-only.
    }
  }

  private async listBrainConversationIds(): Promise<readonly string[]> {
    if (this.deps.listBrainConversationIds) {
      return this.deps.listBrainConversationIds(this.brainRootPath())
    }
    const entries = await fs.readdir(this.brainRootPath(), { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  }

  private async discoverFreshConversationId(): Promise<string | null> {
    const baseline = this.freshConversationBaseline
    const workspace = typeof this.input.workspace === 'string' ? this.input.workspace.trim() : ''
    if (!baseline || !workspace) return null

    const candidates = (await this.listBrainConversationIds())
      .map((candidate) => normalizeAgyConversationId(candidate))
      .filter((candidate): candidate is string => Boolean(candidate && !baseline.has(candidate)))
    const matched: string[] = []
    for (const candidate of candidates) {
      const raw = await this.readTranscript(candidate)
      if (raw !== null && transcriptHasWorkspaceProvenance(raw, workspace)) {
        matched.push(candidate)
      }
    }
    return matched.length === 1 ? matched[0] : null
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
