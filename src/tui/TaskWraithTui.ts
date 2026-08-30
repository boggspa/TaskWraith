import { randomUUID } from 'node:crypto'
import { emitKeypressEvents } from 'node:readline'
import { isAbsolute } from 'node:path'
import type { ReadStream, WriteStream } from 'node:tty'
import {
  HostProjectionClient,
  HostProjectionIncompatibleProtocolError
} from '../host-client/HostProjectionClient'
import {
  HOST_QUESTION_ANSWER_MAX_CHARS,
  type HostDeltasFrame,
  type HostActorIdentity,
  type HostApprovalProjection,
  type HostApprovalDecideDecision,
  type HostCommand,
  type HostCommandName,
  type HostCommandReceipt,
  type HostQuestionProjection,
  type HostSnapshot
} from '../shared/hostProtocol'
import type { HostHistoryDeltasFrame, HostHistorySinceResult } from '../shared/hostHistoryProtocol'
import type {
  HostPermissionPostureOffer,
  HostProviderModelOffer,
  HostProviderOffersProjection,
  HostProviderStatusProjection
} from '../shared/hostSetupProtocol'
import { applyHostSnapshotDeltas } from '../shared/hostSnapshotApply'
import {
  defaultTaskWraithUserDataPath,
  taskWraithControlSocketPath
} from '../shared/taskWraithControlPaths.node'
import type {
  TaskWraithControlModelOffer,
  TaskWraithControlSnapshot,
  TaskWraithControlThreadOffers,
  TaskWraithControlThreadSnapshot,
  TaskWraithControlTranscriptRow
} from '../shared/taskWraithControlProtocol'
import { Ansi, sanitizeTerminalText, type AnsiColorMode } from './ansi'
import {
  buildHostCommand,
  buildProviderAuthBeginCommand,
  buildThreadConfigureCommand,
  buildThreadArchiveCommand,
  buildThreadCreateCommand,
  buildWorkspaceRegisterCommand,
  describeHostReceipt,
  isTerminalHostReceiptStatus,
  pollHostReceiptUntilTerminal
} from './hostCommandFlow'
import {
  acknowledgeColdStartPosture,
  applyColdStartReceipt,
  beginColdStartProviderAuth,
  coldStartAuthFlows,
  coldStartConfigure,
  coldStartIdle,
  coldStartOffers,
  coldStartPending,
  coldStartSelectProvider,
  coldStartThreadCreated,
  coldStartWorkspaceRegistered,
  selectColdStartConfiguration,
  type ColdStartPendingCommand
} from './coldStartFlow'
import {
  TUI_AUTO_THEME_NAME,
  TUI_UNPAINTED_THEME,
  isAutoThemeName,
  resolveAutoTheme,
  resolveTuiTheme,
  tuiThemeForColorMode,
  tuiThemeNames,
  type TuiTheme
} from './palette'
import { resolveTuiAppearanceWithoutProbe } from './appearance'
import { renderTaskWraithTui } from './render'
import type { TuiProfileSettings } from './settings'
import {
  filterTuiSlashCommands,
  parseLeadingTuiSlashToken,
  resolveTuiSlashCommand
} from './slashCommands'
import {
  resolveStartupModel,
  resolveStartupPosture,
  resolveStartupProvider,
  resolveStartupReasoning,
  resolveStartupWorkspaceId
} from './startupDefaults'
import {
  mapHostHistoryEntriesToTranscriptRows,
  mapHostSnapshotToControlSnapshot,
  mapHostSnapshotToThreadDetail
} from './hostProjectionMap'
import {
  createTaskWraithTuiDemoState,
  tuiSeatsRoster,
  visibleThreadRows,
  type TaskWraithTuiState,
  type TuiOverlay,
  type TuiPendingHostMutation,
  type TuiPendingSelection
} from './state'
import {
  liveThreadWorkIds,
  nextDispatchableDraft,
  projectedThreadWorkIds,
  queuedDraftsForThread,
  removeQueuedDraft,
  replaceQueuedDraft
} from './promptQueue'
import { matchProviderStatus } from './providerLoginFlow'
import { projectTuiFullAccessPresence, type TuiFullAccessPresence } from './fullAccessConsent'
import { classifyHistoryResult, preserveAuthoritativeHistoryRows } from './historyReconcile'
import type { EnsureTuiHostAvailableResult } from './hostProcessManager'
import { TUI_MOTION, detectTuiUnicode, resolveTuiGlyphs, type TuiGlyphSet } from './theme'
import {
  findTuiModelChoiceIndex,
  nextAvailableTuiPosture,
  tuiModelChoices,
  type TuiModelChoice
} from './modelPicker'

interface Keypress {
  name?: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  sequence?: string
}

export interface TaskWraithTuiOptions {
  clientVersion: string
  userDataPath?: string
  initialThreadId?: string
  demo?: boolean
  /**
   * Re-arms the windowless Host launcher (ensureTuiHostAvailable). Invoked by
   * the reconnect loop once failures exceed HOST_REVIVE_FAILURE_THRESHOLD so a
   * dead Host process is relaunched instead of retried forever. The TUI class
   * itself stays launcher-agnostic; the CLI injects this.
   */
  reviveHost?: () => Promise<EnsureTuiHostAvailableResult>
  /** Opaque launch-bound signer; never persisted or exposed to provider code. */
  fullAccessPresence?: TuiFullAccessPresence
  /** Base reconnect delay; doubles per attempt up to RECONNECT_MAX_DELAY_MS. */
  reconnectBaseDelayMs?: number
  /** Failed reconnects before reviveHost is invoked. */
  reviveFailureThreshold?: number
  colorMode: AnsiColorMode
  animationEnabled?: boolean
  /** Override glyph set; defaults to env/locale detection via detectTuiUnicode. */
  glyphs?: TuiGlyphSet
  /**
   * Palette to paint in. Defaults to the unpainted theme so the class stays a
   * library: choosing to paint is a product decision, and `cli.ts` makes it.
   */
  theme?: TuiTheme
  /**
   * The name the theme was chosen by, which `auto` cannot be recovered from the
   * resolved theme alone. Carried so the picker marks the right row and so
   * `auto` persists as `auto` rather than as whatever it resolved to today.
   */
  themeName?: string
  /** Persist a confirmed theme. Omitted in tests and in one-shot renders. */
  persistTheme?: (name: string) => boolean
  /** Best-effort startup memory for the resolved Host profile. */
  profileSettings?: TuiProfileSettings
  /** Persist startup memory for this Host profile. Omitted in tests unless under test. */
  persistProfileSettings?: (changes: TuiProfileSettings) => boolean
  input?: ReadStream
  output?: WriteStream
  now?: () => number
  /** Periodic full reconciliation for Host families not journalled yet. */
  projectionRefreshMs?: number
}

const RECONNECT_DELAY_MS = 1_800
const RECONNECT_MAX_DELAY_MS = 15_000
/** Consecutive failed reconnects before the loop re-arms the Host launcher. */
const HOST_REVIVE_FAILURE_THRESHOLD = 5
const ESCAPE_CANCEL_MAX_RECOVERY_ATTEMPTS = 4
const ESCAPE_CANCEL_RECOVERY_BASE_MS = 200
const ANIMATION_INTERVAL_MS = 120

/**
 * Whether this timer tick should advance the shared animation frame.
 *
 * Two animations ride one timer, and this is the whole of what separates them.
 * The working shimmer advances on every tick. The home-frame banner sweep
 * advances on every `stride`-th, because the home frame repaints for no other
 * reason — every frame drawn there is CPU spent while the user is idle, so the
 * sweep is deliberately the slower of the two.
 *
 * Nothing advances anywhere else. A settled thread and any raised overlay must
 * both stay still, which is why `homeFrame` is not simply "no thread": the
 * canvas only falls through to the banner while no overlay is up.
 *
 * Extracted rather than left inline because it is the single line that decides
 * whether the banner sweep is a feature or dead code, and inline in a
 * `setInterval` it is unreachable by any test — every existing TUI test
 * constructs the client with `animationEnabled: false`, so the timer never
 * runs at all.
 */
export function shouldAdvanceAnimationFrame(input: {
  working: boolean
  homeFrame: boolean
  tick: number
  stride: number
}): boolean {
  if (input.working) return true
  if (!input.homeFrame) return false
  return input.tick % Math.max(1, input.stride) === 0
}

export function hostDeltasMayReleaseQueuedDraft(frame: HostDeltasFrame): boolean {
  if (frame.result.kind !== 'deltas') return true
  return frame.result.deltas.some((delta) => {
    if (delta.family !== 'run' && delta.family !== 'round') return false
    if (delta.kind === 'remove' || delta.kind === 'tombstone') return true
    if (!delta.payload || typeof delta.payload !== 'object' || Array.isArray(delta.payload)) {
      return false
    }
    const payload = delta.payload as Record<string, unknown>
    if (delta.family === 'round') {
      return (
        typeof payload.endedAt === 'number' ||
        payload.status === 'completed' ||
        payload.status === 'cancelled' ||
        payload.status === 'failed'
      )
    }
    if (typeof payload.endedAt === 'number') return true
    return (
      typeof payload.providerOutcome === 'string' &&
      payload.providerOutcome !== 'running' &&
      payload.providerOutcome !== 'requires_action' &&
      payload.providerOutcome !== 'unknown'
    )
  })
}

export function terminalRunIdsFromHostDeltas(frame: HostDeltasFrame): Set<string> {
  const ids = new Set<string>()
  if (frame.result.kind !== 'deltas') return ids
  for (const delta of frame.result.deltas) {
    if (delta.family !== 'run' || !delta.entityId) continue
    if (delta.kind === 'remove' || delta.kind === 'tombstone') {
      ids.add(delta.entityId)
      continue
    }
    if (!delta.payload || typeof delta.payload !== 'object' || Array.isArray(delta.payload))
      continue
    const payload = delta.payload as Record<string, unknown>
    if (
      typeof payload.endedAt === 'number' ||
      payload.providerOutcome === 'completed' ||
      payload.providerOutcome === 'failed' ||
      payload.providerOutcome === 'cancelled'
    ) {
      ids.add(delta.entityId)
    }
  }
  return ids
}
const TRANSCRIPT_PAGE_ROWS = 8
const HOST_FULL_REFRESH_MS = 5_000

/**
 * The Host's typed seat-toggle refusal in plain language. The authority
 * reason (or the receipt's error code) is the typed truth; unknown codes
 * fall back to the receipt's own message — the Host's words, never invented
 * ones. The Host remains the authority: the lens never pre-empts these
 * refusals with client-side mirrors that could drift from the server's.
 */
function describeSeatToggleRefusal(receipt: HostCommandReceipt): string {
  const code = receipt.authority.reason ?? receipt.errorCode ?? ''
  if (code.includes('last_seat_required')) {
    return 'Host refused · an ensemble thread keeps at least one enabled seat'
  }
  if (code.includes('round_active')) {
    return 'Host refused · seats cannot change while a round is running'
  }
  if (code.includes('participant_not_found')) {
    return 'Host refused · that participant is no longer on this thread'
  }
  if (code.includes('thread_required') || code.includes('thread_not_found')) {
    return 'Host refused · the Host no longer treats this as an ensemble thread'
  }
  if (code.includes('revision_conflict')) {
    return 'Host conflict · the roster changed mid-toggle — refresh and try again'
  }
  return receipt.errorMessage?.trim() || describeHostReceipt(receipt).text
}

function emptyState(): TaskWraithTuiState {
  return {
    connection: 'connecting',
    input: '',
    inputCursor: 0,
    overlay: 'none',
    overlayIndex: 0,
    missionFilter: 'active',
    missionParticipantOffset: 0,
    scrollOffset: 0,
    animationFrame: 0,
    tuneEffortIndex: 0,
    queuedDrafts: []
  }
}

function preferredThread(
  snapshot: TaskWraithControlSnapshot,
  preferredId?: string
): string | undefined {
  if (preferredId && snapshot.threads.some((thread) => thread.id === preferredId)) {
    return preferredId
  }
  return [...snapshot.threads]
    .filter((thread) => !thread.archived)
    .sort((left, right) => right.updatedAt - left.updatedAt)[0]?.id
}

function cloneThreadSnapshot(
  snapshot: TaskWraithControlThreadSnapshot
): TaskWraithControlThreadSnapshot {
  return {
    ...snapshot,
    thread: {
      ...snapshot.thread,
      ...(snapshot.thread.ensemble
        ? {
            ensemble: {
              ...snapshot.thread.ensemble,
              participants: snapshot.thread.ensemble.participants.map((participant) => ({
                ...participant
              }))
            }
          }
        : {})
    },
    rows: snapshot.rows.map((row) => ({
      ...row,
      ...(row.tools ? { tools: row.tools.map((tool) => ({ ...tool })) } : {})
    })),
    context: {
      ...snapshot.context,
      workspaces: snapshot.context.workspaces.map((workspace) => ({ ...workspace }))
    }
  }
}

export class TaskWraithTui {
  private readonly options: Required<
    Pick<
      TaskWraithTuiOptions,
      'clientVersion' | 'colorMode' | 'animationEnabled' | 'input' | 'output' | 'now'
    >
  > &
    Omit<
      TaskWraithTuiOptions,
      'clientVersion' | 'colorMode' | 'animationEnabled' | 'input' | 'output' | 'now'
    >
  private readonly ansi: Ansi
  private readonly glyphs: TuiGlyphSet
  /** Mutable: the /theme picker previews by repainting in the hovered theme. */
  private theme: TuiTheme
  /** The theme to restore if the picker is dismissed rather than confirmed. */
  private themeBeforePreview: TuiTheme | undefined
  private profileSettings: TuiProfileSettings
  private readonly client: HostProjectionClient | null
  private state: TaskWraithTuiState
  private stopped = false
  private terminalActive = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private projectionRefreshTimer: ReturnType<typeof setTimeout> | null = null
  private animationTimer: ReturnType<typeof setInterval> | null = null
  private demoReplyTimer: ReturnType<typeof setTimeout> | null = null
  private selectingThread = false
  private sendingPrompt = false
  private mutationInFlight = false
  private bracketedPaste = false
  private bracketedPasteBuffer = ''
  private commandPaletteAutomatic = false
  /** Retained across reconnect so an accepted lazy setup command is never reminted. */
  private unresolvedLazySetupCommand: HostCommand | undefined
  private lastError = ''
  /** Serialises full snapshots and push deltas into one atomic apply lane. */
  private projectionQueue: Promise<void> = Promise.resolve()
  /** Serialises polling and pushed transcript deltas so cursor order cannot race. */
  private historyQueue: Promise<void> = Promise.resolve()
  /** Last live HostSnapshot — authority for local thread detail + approvals. */
  private hostSnapshot: HostSnapshot | null = null
  /** Whether a `welcome` has ever been received. Distinguishes a first-time
   *  "offline" state (App never found) from a "reconnecting" state (App was
   *  reachable and the connection dropped). */
  private everConnected = false
  /** Consecutive failed connect attempts since the last successful welcome. */
  private reconnectAttempts = 0
  private clientId = `tui-${randomUUID()}`
  /** Monotonic workspace-git read generation — the staleness guard's backbone. */
  private gitReadGeneration = 0
  /** Monotonic seat-lens read/toggle generation — the staleness guard's backbone. */
  private seatsReadGeneration = 0
  /** One client command at a time drains the in-session draft FIFO. */
  private queueDrainScheduled = false
  private queueDrainActive = false
  private queueFreshReadInFlight = false
  private queueFreshReadRequested = false
  private readonly queuedDraftCommands = new Map<string, HostCommand>()
  private readonly queueRetryFences = new Map<string, string>()
  private readonly queueRetryAttempts = new Map<string, number>()
  private readonly queueRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly acceptedQueueRuns = new Map<
    string,
    { commandId: string; observedLive: boolean }
  >()
  private readonly cancelRequestedWorkIds = new Set<string>()
  private pendingEscapeCancel:
    | { threadId: string; liveWorkId: string; command?: HostCommand }
    | undefined
  private escapeRefreshInFlight = false
  private escapeCancelRecoveryInFlight = false
  private escapeCancelRecoveryAttempts = 0
  private escapeCancelRecoveryTimer: ReturnType<typeof setTimeout> | null = null
  private connectionEpoch = 0
  private homeTuneReadGeneration = 0
  private providerLoginReadGeneration = 0
  private fullAccessPresence: TuiFullAccessPresence | null
  private retainHomeForNextThread = false

  constructor(options: TaskWraithTuiOptions) {
    this.options = {
      ...options,
      animationEnabled: options.animationEnabled !== false,
      input: options.input ?? process.stdin,
      output: options.output ?? process.stdout,
      now: options.now ?? (() => Date.now())
    }
    this.ansi = new Ansi(this.options.colorMode)
    this.glyphs = options.glyphs ?? resolveTuiGlyphs(detectTuiUnicode())
    this.theme = options.theme ?? TUI_UNPAINTED_THEME
    this.profileSettings = { ...(options.profileSettings ?? {}) }
    this.fullAccessPresence = options.fullAccessPresence ?? null
    this.state = options.demo ? createTaskWraithTuiDemoState(this.options.now()) : emptyState()
    this.state.themeName = options.themeName ?? this.theme.name
    this.state.activeWorkspaceId = this.profileSettings.workspaceId
    this.client = options.demo
      ? null
      : new HostProjectionClient({
          client: {
            clientId: this.clientId,
            clientClass: 'tui',
            clientVersion: options.clientVersion,
            displayName: 'TaskWraith TUI'
          },
          // One authenticated v2 socket owns snapshots, live deltas and commands.
          capabilities: [
            'bootstrap',
            'snapshot',
            'deltas',
            'model-offers',
            'health',
            'commands',
            'receipts'
          ],
          optionalCapabilities: [
            'provider-catalog',
            'provider-auth',
            'history',
            'setup',
            'workspace-git',
            'ensemble'
          ],
          userDataPath: options.userDataPath ?? defaultTaskWraithUserDataPath()
        })
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error('TaskWraith TUI has already stopped.')
    if (!this.options.input.isTTY || !this.options.output.isTTY) {
      throw new Error('Interactive TaskWraith TUI requires a terminal.')
    }
    try {
      this.enterTerminal()
      this.bindInput()
      if (this.options.animationEnabled && this.ansi.enabled) {
        const bannerTickStride = Math.round(
          TUI_MOTION.bannerSweepIntervalMs / ANIMATION_INTERVAL_MS
        )
        let tick = 0
        this.animationTimer = setInterval(() => {
          tick += 1
          if (
            !shouldAdvanceAnimationFrame({
              working: this.state.thread?.thread.status === 'working',
              // `renderTranscriptCanvas` falls through to the home frame
              // exactly when there is no thread snapshot, and only while no
              // overlay is up.
              homeFrame: !this.state.thread && this.state.overlay === 'none',
              tick,
              stride: bannerTickStride
            })
          ) {
            return
          }
          this.state.animationFrame += 1
          this.render()
        }, ANIMATION_INTERVAL_MS)
        this.animationTimer.unref?.()
      }
      this.render()
    } catch (error) {
      // Startup failed after raw mode / the alternate screen may have been
      // entered. Restore the terminal before surfacing the failure.
      this.stop()
      throw error
    }
    if (this.client) {
      this.bindClient()
      this.scheduleProjectionRefresh()
      await this.connect().catch(() => {})
    }
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.projectionRefreshTimer) clearTimeout(this.projectionRefreshTimer)
    if (this.animationTimer) clearInterval(this.animationTimer)
    if (this.demoReplyTimer) clearTimeout(this.demoReplyTimer)
    for (const timer of this.queueRetryTimers.values()) clearTimeout(timer)
    this.queueRetryTimers.clear()
    this.clearEscapeCancelRecovery()
    this.reconnectTimer = null
    this.projectionRefreshTimer = null
    this.animationTimer = null
    this.demoReplyTimer = null
    this.replaceFullAccessPresence()
    this.client?.close()
    this.options.input.off('keypress', this.onKeypress)
    this.options.output.off('resize', this.onResize)
    this.leaveTerminal()
  }

  private enterTerminal(): void {
    if (this.terminalActive) return
    // Mark restoration as required before the first mutating TTY operation.
    // If raw-mode setup or the alternate-screen write throws, start() calls
    // stop(), which must still attempt every restoration step.
    this.terminalActive = true
    emitKeypressEvents(this.options.input)
    this.options.input.setRawMode(true)
    this.options.input.resume()
    this.options.output.write('\u001b[?1049h\u001b[?2004h\u001b[?25l\u001b[2J\u001b[H')
  }

  /**
   * Restores raw mode and the primary screen. Idempotent and defensive: this
   * runs from `stop()`, from startup-failure recovery, and from process exit
   * handlers where the input/output streams may already be half-torn-down —
   * a throw here must never prevent the remaining restoration steps.
   */
  private leaveTerminal(): void {
    if (!this.terminalActive) return
    this.terminalActive = false
    try {
      this.options.input.setRawMode(false)
    } catch {
      // Stream may already be closed during process exit.
    }
    try {
      this.options.input.pause()
    } catch {
      // Stream may already be closed during process exit.
    }
    try {
      this.options.output.write('\u001b[?2004l\u001b[?25h\u001b[?1049l')
    } catch {
      // Stream may already be closed during process exit.
    }
  }

  private bindInput(): void {
    this.options.input.on('keypress', this.onKeypress)
    this.options.output.on('resize', this.onResize)
  }

  private bindClient(): void {
    if (!this.client) return
    this.client.on('welcome', (welcome) => {
      this.connectionEpoch += 1
      if (
        this.fullAccessPresence &&
        !this.fullAccessPresence.matches(this.client?.discoveryProcessIdentity ?? null)
      ) {
        this.replaceFullAccessPresence()
      }
      this.state.hostVersion = welcome.hostVersion
      this.state.connection = 'connected'
      this.everConnected = true
      this.reconnectAttempts = 0
      this.lastError = ''
      this.setNotice('Connected to TaskWraith Host', 'good', 1_500)
      this.render()
    })
    this.client.on('deltas', (frame) => {
      void this.enqueueProjectionUpdate(() => this.applyHostDeltas(frame)).catch((error) => {
        this.surfaceProjectionSyncError(error)
      })
    })
    this.client.on('history', (frame) => {
      void this.enqueueHistoryUpdate(() => this.applyHistoryEvent(frame)).catch((error) =>
        this.surfaceProjectionSyncError(error)
      )
    })
    this.client.on('disconnected', (error) => {
      if (this.stopped) return
      // The host was reachable before, so this is a drop-and-retry rather
      // than "the App was never found" — distinct terminal states.
      this.state.connection = this.everConnected ? 'reconnecting' : 'offline'
      this.reconnectAttempts += 1
      this.lastError = error?.message ?? 'TaskWraith Host disconnected.'
      this.markHostProjectionStale()
      this.setNotice(
        this.everConnected
          ? this.revivePending()
            ? 'TaskWraith Host unreachable · restarting the standalone Host…'
            : 'TaskWraith Host disconnected · reconnecting'
          : 'Standalone Host offline · retrying',
        'warning'
      )
      this.scheduleReconnect()
      this.render()
    })
  }

  private applyHostSnapshot(snapshot: HostSnapshot): TaskWraithControlSnapshot {
    this.hostSnapshot = snapshot
    this.state.hostProjection = snapshot
    const mapped = mapHostSnapshotToControlSnapshot(snapshot)
    this.state.snapshot = mapped
    const selectedThreadId = this.state.selectedThreadId
    if (selectedThreadId) {
      const detail = mapHostSnapshotToThreadDetail(snapshot, selectedThreadId)
      this.state.thread = detail
        ? preserveAuthoritativeHistoryRows(this.state.thread, detail.thread, this.state.history)
        : undefined
    }
    const liveIds = new Set([
      ...snapshot.runs
        .filter(
          (run) =>
            run.endedAt === undefined &&
            (run.providerOutcome === 'running' ||
              run.providerOutcome === 'requires_action' ||
              run.providerOutcome === 'unknown')
        )
        .map((run) => run.runId),
      ...snapshot.rounds
        .filter(
          (round) =>
            round.endedAt === undefined &&
            (round.status === 'running' || round.status === 'unknown')
        )
        .map((round) => round.roundId)
    ])
    for (const id of this.cancelRequestedWorkIds) {
      if (!liveIds.has(id)) this.cancelRequestedWorkIds.delete(id)
    }
    for (const [threadId, barrier] of this.acceptedQueueRuns) {
      const run = snapshot.runs.find(
        (candidate) => candidate.threadId === threadId && candidate.runId === barrier.commandId
      )
      const live = Boolean(
        run &&
        run.endedAt === undefined &&
        (run.providerOutcome === 'running' ||
          run.providerOutcome === 'requires_action' ||
          run.providerOutcome === 'unknown')
      )
      const terminal = Boolean(
        run &&
        (run.endedAt !== undefined ||
          run.providerOutcome === 'completed' ||
          run.providerOutcome === 'failed' ||
          run.providerOutcome === 'cancelled')
      )
      if (terminal || (barrier.observedLive && !run)) {
        this.acceptedQueueRuns.delete(threadId)
      } else if (live && !barrier.observedLive) {
        this.acceptedQueueRuns.set(threadId, { ...barrier, observedLive: true })
      }
    }
    this.restoreBlockedDraftIfSafe()
    if (this.pendingEscapeCancel) queueMicrotask(() => this.flushPendingEscapeCancel())
    else this.scheduleQueuedDraftDrain()
    return mapped
  }

  private async applyHostDeltas(frame: HostDeltasFrame): Promise<void> {
    const base = this.hostSnapshot
    const result = frame.result
    if (
      !base ||
      result.kind === 'full_resnapshot_required' ||
      result.generation !== base.generation ||
      result.fromCursor !== base.cursor
    ) {
      await this.fetchAndApplyHostSnapshot()
      this.render()
      return
    }

    const applied = applyHostSnapshotDeltas(base, result.deltas)
    if (
      applied.outcome === 'rejected' ||
      applied.outcome === 'require_resnapshot' ||
      applied.cursor !== result.toCursor
    ) {
      await this.fetchAndApplyHostSnapshot()
      this.render()
      return
    }
    const terminalRunIds = terminalRunIdsFromHostDeltas(frame)
    for (const [threadId, barrier] of this.acceptedQueueRuns) {
      if (terminalRunIds.has(barrier.commandId)) this.acceptedQueueRuns.delete(threadId)
    }
    this.applyHostSnapshot(applied.snapshot)
    // Applied deltas are intentionally marked cached. A queued send may drain
    // only from a fresh Host read, so terminal-looking cache state triggers one
    // bounded resnapshot instead of being promoted as live authority.
    if ((this.state.queuedDrafts?.length ?? 0) > 0 && hostDeltasMayReleaseQueuedDraft(frame)) {
      await this.fetchAndApplyHostSnapshot()
    }
    this.render()
  }

  private async connect(): Promise<void> {
    if (!this.client || this.stopped) return
    this.state.connection = this.everConnected ? 'reconnecting' : 'connecting'
    this.render()
    try {
      const welcome = await this.client.connect()
      this.state.hostVersion = welcome.hostVersion
      this.reconnectAttempts = 0
      await this.refreshHostSnapshot()
      await this.resumeColdStartPending()
      await this.resumeProviderLoginPending()
      const mapped = this.state.snapshot
      if (!mapped) throw new Error('TaskWraith Host snapshot was not available after connect.')
      this.state.connection = 'connected'
      this.everConnected = true
      // A thread opens on connect only when one was actually ASKED FOR: `--thread`,
      // or a thread this session already selected. Falling back to "newest" for an
      // unasked reader picks whichever thread some other surface touched last, so
      // the home frame gets replaced a beat after it paints — and every reconnect
      // repeats the jump. Requesting a thread that has since gone still falls back
      // to an available one; that is an answer to a question the reader asked.
      const requestedThreadId = this.state.selectedThreadId ?? this.options.initialThreadId
      const threadId = requestedThreadId ? preferredThread(mapped, requestedThreadId) : undefined
      const hasOpenableThread = mapped.threads.some((thread) => !thread.archived)
      if (threadId) {
        await this.openThread(threadId, { reattach: threadId === this.state.selectedThreadId })
      } else if (hasOpenableThread) {
        // Threads exist and the reader has not chosen one: rest on the home frame
        // rather than entering setup, which is for a profile with nothing to open.
        this.state.selectedThreadId = undefined
        this.state.thread = undefined
      } else if (mapped.workspaces.length > 0 && !this.state.coldStart) {
        // A registered workspace is enough for a fresh lazy draft. Provider,
        // model and posture are validated only when the first prompt is sent.
        this.state.selectedThreadId = undefined
        this.state.thread = undefined
        this.state.overlay = 'none'
      } else {
        this.state.selectedThreadId = undefined
        this.state.thread = undefined
        if (this.client.supports('setup') && this.client.supports('provider-catalog')) {
          if (!this.state.coldStart) {
            const workspace = mapped.workspaces[0]
            this.state.coldStart = workspace
              ? coldStartWorkspaceRegistered(workspace.id)
              : coldStartIdle()
          }
          this.state.coldStartIntent = 'required'
          this.state.overlay = 'setup'
          this.setNotice('Host setup required before composing.', 'warning')
        } else if (!this.state.coldStart) {
          this.state.coldStart = { kind: 'legacy', reason: 'setup_unavailable' }
          this.state.coldStartIntent = 'required'
          this.state.overlay = 'setup'
          this.setNotice('Host setup capability is unavailable · read-only legacy mode.', 'warning')
        }
      }
      if (this.unresolvedLazySetupCommand) {
        this.setNotice('Connection restored · press Enter to resume the first prompt.', 'neutral')
      }
      if (
        !this.state.selectedThreadId &&
        this.state.overlay === 'none' &&
        this.client.supports('provider-catalog')
      ) {
        void this.loadHomeTuneProviders(false)
      }
      this.render()
    } catch (error) {
      if (this.stopped) return
      if (error instanceof HostProjectionIncompatibleProtocolError) {
        this.state.connection = 'incompatible-protocol'
        const message = error.message
        if (message !== this.lastError) {
          this.lastError = message
          this.setNotice('TaskWraith Host protocol is incompatible · update the App', 'error')
        }
      } else {
        this.state.connection = this.everConnected ? 'reconnecting' : 'offline'
        this.reconnectAttempts += 1
        const message = error instanceof Error ? error.message : String(error)
        if (message !== this.lastError) {
          this.lastError = message
          this.setNotice(
            this.everConnected
              ? this.revivePending()
                ? 'TaskWraith Host unreachable · restarting the standalone Host…'
                : 'TaskWraith Host disconnected · reconnecting'
              : 'Standalone Host offline · retrying locally',
            'warning'
          )
        }
      }
      this.scheduleReconnect()
      this.render()
    }
  }

  private revivePending(): boolean {
    const threshold = this.options.reviveFailureThreshold ?? HOST_REVIVE_FAILURE_THRESHOLD
    return (
      this.everConnected && Boolean(this.options.reviveHost) && this.reconnectAttempts >= threshold
    )
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped || !this.client) return
    // Exponential backoff from the base delay up to RECONNECT_MAX_DELAY_MS so
    // a permanently dead Host does not busy-spin an identical retry forever.
    const baseMs = this.options.reconnectBaseDelayMs ?? RECONNECT_DELAY_MS
    const attempt = Math.max(1, this.reconnectAttempts)
    const delayMs = Math.min(RECONNECT_MAX_DELAY_MS, baseMs * 2 ** (attempt - 1))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.reconnect()
    }, delayMs)
  }

  /**
   * One reconnect attempt. Once failures exceed the threshold and a launcher
   * was injected, re-arm the windowless Host before the next plain connect.
   * ensureTuiHostAvailable is a no-op while a live authenticating Host answers,
   * so this only launches when the process is actually gone.
   */
  private async reconnect(): Promise<void> {
    if (this.stopped || !this.client) return
    if (this.revivePending() && this.options.reviveHost) {
      try {
        const revived = await this.options.reviveHost()
        if (revived.kind === 'launched') {
          this.replaceFullAccessPresence(revived.fullAccessPresence)
        }
      } catch {
        // The launcher surfaces its own diagnostics; fall through to a plain
        // reconnect attempt either way.
      }
    }
    await this.connect()
  }

  private scheduleProjectionRefresh(): void {
    if (this.stopped || !this.client || this.projectionRefreshTimer) return
    const configured = this.options.projectionRefreshMs
    const delay =
      typeof configured === 'number' && Number.isFinite(configured) && configured > 0
        ? Math.floor(configured)
        : HOST_FULL_REFRESH_MS
    this.projectionRefreshTimer = setTimeout(() => {
      this.projectionRefreshTimer = null
      const refresh = this.client?.connected
        ? this.refreshHostSnapshot()
            .then(() => this.refreshSelectedHistory())
            .then(() => this.render())
            .catch((error) => this.surfaceProjectionSyncError(error))
        : Promise.resolve()
      void refresh.finally(() => this.scheduleProjectionRefresh())
    }, delay)
    this.projectionRefreshTimer.unref?.()
  }

  /**
   * `reattach` marks the re-open a reconnect performs on the thread that is
   * already on screen. It is not a navigation, so it must not close the
   * reader's overlay, drop the seat lens, scroll them back, or re-announce a
   * thread they never left.
   */
  private async openThread(
    threadId: string,
    options: { reattach?: boolean; preserveHome?: boolean } = {}
  ): Promise<void> {
    if (!threadId || this.selectingThread || this.mutationInFlight) return
    const reattach = options.reattach === true && threadId === this.state.selectedThreadId
    if (!reattach) {
      this.state.homeContinuationThreadId = options.preserveHome ? threadId : undefined
    }
    const preservedScrollOffset = this.state.scrollOffset
    if (threadId !== this.state.selectedThreadId) {
      // Offers and staged selections are per-thread state.
      this.state.offers = undefined
      this.state.pendingSelection = undefined
      this.state.tuneEffortIndex = 0
    }
    if (!this.client) {
      this.state.selectedThreadId = threadId
      this.state.overlay = 'none'
      // The seat lens is keyed to the thread it was opened for.
      this.state.seats = undefined
      this.state.scrollOffset = 0
      this.render()
      return
    }
    const host = this.hostSnapshot
    if (!host) {
      this.setNotice('Host snapshot is not loaded yet.', 'warning', 3_000)
      this.render()
      return
    }
    if (!mapHostSnapshotToThreadDetail(host, threadId)) {
      this.setNotice(`Thread ${threadId} is not in the Host snapshot.`, 'warning', 4_000)
      this.render()
      return
    }
    if (!this.client.supports('commands')) {
      this.applyLocalThread(threadId, { previewNotice: !reattach, preserveView: reattach })
      await this.loadThreadHistory(threadId)
      if (reattach) this.restoreScrollOffset(threadId, preservedScrollOffset)
      else if (this.state.thread?.thread.workspaceId) {
        this.rememberWorkspaceId(this.state.thread.thread.workspaceId)
      }
      this.render()
      return
    }
    this.selectingThread = true
    try {
      const command = this.buildMutation('thread.select', { threadId }, {})
      if (!command) return
      await this.runHostMutation(command, {
        onSucceeded: async () => {
          await this.refreshHostSnapshot()
          this.applyLocalThread(threadId, { previewNotice: !reattach, preserveView: reattach })
          await this.loadThreadHistory(threadId)
          if (reattach) this.restoreScrollOffset(threadId, preservedScrollOffset)
          else if (this.state.thread?.thread.workspaceId) {
            this.rememberWorkspaceId(this.state.thread.thread.workspaceId)
          }
        }
      })
    } finally {
      this.selectingThread = false
      this.render()
      this.scheduleQueuedDraftDrain()
    }
  }

  private applyLocalThread(
    threadId: string,
    options: { previewNotice?: boolean; preserveView?: boolean } = {}
  ): void {
    const host = this.hostSnapshot
    if (!host) return
    const detail = mapHostSnapshotToThreadDetail(host, threadId)
    if (!detail) return
    const preserveView = options.preserveView === true && this.state.selectedThreadId === threadId
    this.state.selectedThreadId = threadId
    this.state.thread = detail.thread
    if (!preserveView) {
      this.state.overlay = 'none'
      // The seat lens is keyed to the thread it was opened for.
      this.state.seats = undefined
      this.state.scrollOffset = 0
    }
    if (!this.client?.supports('history')) {
      this.state.history = {
        threadId,
        generation: 0,
        cursor: 0,
        previewOnly: true
      }
    } else if (this.state.history?.threadId !== threadId) {
      this.state.history = undefined
    }
    if (options.previewNotice) {
      this.setNotice(
        detail.previewOnly
          ? `Opened ${detail.thread.thread.title} · Host preview only`
          : `Opened ${detail.thread.thread.title}`,
        'good',
        1_800
      )
    }
    this.restoreBlockedDraftIfSafe()
  }

  /** Puts a re-attached reader back where they were reading, never at the end. */
  private restoreScrollOffset(threadId: string, scrollOffset: number): void {
    if (this.state.selectedThreadId !== threadId) return
    this.state.scrollOffset = scrollOffset
  }

  /**
   * Reads one bounded history page. Host history is an optional capability;
   * when it is absent the ordinary projection preview remains explicitly
   * labelled as such instead of being mistaken for a transcript.
   */
  private async loadThreadHistory(
    threadId: string,
    before?: { generation: number; cursor: number }
  ): Promise<void> {
    if (!this.client?.connected || !this.client.supports('history')) {
      if (this.state.selectedThreadId === threadId) {
        this.state.history = { threadId, generation: 0, cursor: 0, previewOnly: true }
      }
      return
    }
    const page = await this.client.getThreadHistory({
      threadId,
      limit: 50,
      ...(before ? { before } : {})
    })
    if (page.threadId !== threadId) throw new Error('Host returned history for a different thread.')
    if (this.state.selectedThreadId !== threadId) return
    const pageRows = mapHostHistoryEntriesToTranscriptRows(page.entries, this.state.thread?.thread)
    const current = this.state.history
    const currentRows =
      current?.threadId === threadId && !current.previewOnly ? (this.state.thread?.rows ?? []) : []
    const rows = before ? mergeTranscriptRows(pageRows, currentRows) : pageRows
    if (this.state.thread) this.state.thread = { ...this.state.thread, rows }
    this.state.history = {
      threadId,
      generation: page.generation,
      cursor: page.cursor,
      ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}),
      previewOnly: false
    }
    if (!before) this.state.scrollOffset = 0
  }

  /** Polling reconciliation for Hosts that do not yet publish history events. */
  private async refreshSelectedHistory(): Promise<void> {
    await this.enqueueHistoryUpdate(async () => {
      const history = this.state.history
      if (
        !history ||
        history.previewOnly ||
        history.loadingOlder ||
        !this.client?.connected ||
        !this.client.supports('history')
      ) {
        return
      }
      const result = await this.client.getHistorySince({
        threadId: history.threadId,
        since: { generation: history.generation, cursor: history.cursor }
      })
      await this.applyHistoryResult(history.threadId, result)
    })
  }

  /** Future-safe event handling; production presently reaches this through polling above. */
  private async applyHistoryEvent(frame: HostHistoryDeltasFrame): Promise<void> {
    await this.applyHistoryResult(frame.threadId, frame.result)
  }

  private async applyHistoryResult(
    threadId: string,
    result: HostHistorySinceResult
  ): Promise<void> {
    const history = this.state.history
    if (!history || history.previewOnly || history.threadId !== threadId) return
    const decision = classifyHistoryResult(history, result)
    if (decision === 'ignore') return
    if (decision === 'reload') {
      await this.loadThreadHistory(threadId)
      return
    }
    if (result.kind !== 'deltas') return
    if (!this.state.thread || this.state.selectedThreadId !== threadId) return
    let rows = [...this.state.thread.rows]
    for (const delta of result.deltas) {
      const id =
        delta.kind === 'remove'
          ? `host-history:${delta.entryId}`
          : `host-history:${delta.entry.entryId}`
      if (delta.kind === 'remove') {
        rows = rows.filter((row) => row.id !== id)
        continue
      }
      const row = mapHostHistoryEntriesToTranscriptRows([delta.entry], this.state.thread.thread)[0]
      const existing = rows.findIndex((candidate) => candidate.id === id)
      if (existing >= 0) rows.splice(existing, 1, row)
      else rows.push(row)
    }
    this.state.thread = { ...this.state.thread, rows }
    this.state.history = {
      ...history,
      generation: result.generation,
      cursor: result.toCursor,
      previewOnly: false
    }
    this.render()
  }

  private readonly onResize = (): void => {
    this.render()
  }

  private readonly onKeypress = (input: string, key: Keypress): void => {
    if (this.stopped) return
    if (key.name === 'paste-start') {
      this.bracketedPaste = true
      this.bracketedPasteBuffer = ''
      return
    }
    if (this.bracketedPaste) {
      if (key.name === 'paste-end') {
        this.bracketedPaste = false
        this.insertComposerText(this.bracketedPasteBuffer)
        this.bracketedPasteBuffer = ''
        this.syncCommandPaletteAfterInput()
        this.render()
      } else {
        this.bracketedPasteBuffer += input
      }
      return
    }
    if (key.ctrl && key.name === 'c') {
      if (this.state.input || this.state.overlay === 'help') {
        this.state.input = ''
        this.state.inputCursor = 0
        this.dismissCommandPalette()
        this.render()
      } else {
        this.stop()
      }
      return
    }
    if ((key.ctrl && key.name === 'd' && !this.state.input) || (key.meta && key.name === 'q')) {
      this.stop()
      return
    }
    if (
      this.state.coldStart &&
      this.state.coldStart.kind !== 'ready' &&
      this.state.overlay !== 'setup'
    ) {
      this.state.overlay = 'setup'
      void this.handleColdStartKey(input, key).catch((error) => {
        this.setNotice(
          `Host setup failed · ${error instanceof Error ? error.message : String(error)}`,
          'error',
          4_000
        )
        this.render()
      })
      return
    }
    // Wave 4.2b: while a Host mutation is pending an ask, y/n answers it.
    if (this.state.pendingHostMutation?.approvalId && !key.ctrl && !key.meta) {
      const answer = (input || key.name || '').toLowerCase()
      if (answer === 'y') {
        void this.decidePendingApproval('accept')
        return
      }
      if (answer === 'n') {
        void this.decidePendingApproval('decline')
        return
      }
    }
    // A projected provider approval is independently actionable when the
    // composer is empty. Never steal y/n from an in-progress user message.
    if (
      !this.state.pendingHostMutation &&
      this.state.overlay === 'none' &&
      !this.state.input &&
      !key.ctrl &&
      !key.meta
    ) {
      const approval = this.selectedPendingApproval()
      const answer = (input || key.name || '').toLowerCase()
      if (approval && (answer === 'y' || answer === 'n')) {
        void this.decideProjectedApproval(approval, answer === 'y' ? 'accept' : 'decline')
        return
      }
    }
    if (key.ctrl && key.name === 'l') {
      this.options.output.write('\u001b[2J')
      this.render()
      return
    }
    if (key.ctrl && key.name === 'u') {
      this.state.input = ''
      this.state.inputCursor = 0
      this.dismissCommandPalette()
      this.render()
      return
    }
    if (key.ctrl && key.name === 'a') {
      this.state.inputCursor = 0
      this.render()
      return
    }
    if (key.ctrl && key.name === 'e') {
      this.state.inputCursor = Array.from(this.state.input).length
      this.render()
      return
    }
    if (key.ctrl && key.name === 'o') {
      this.toggleOverlay('context')
      return
    }
    if (key.ctrl && key.name === 'k') {
      this.toggleOverlay('threads')
      return
    }
    if (key.ctrl && key.name === 'r') {
      this.toggleMissionOverlay()
      return
    }
    if (key.ctrl && key.name === 'p') {
      if (this.state.overlay === 'help') {
        this.dismissCommandPalette()
        this.render()
      } else {
        this.state.overlay = 'help'
        this.state.overlayIndex = 0
        this.state.commandPaletteQuery = ''
        this.commandPaletteAutomatic = false
        this.render()
      }
      return
    }
    if (key.ctrl && key.name === 'g') {
      this.toggleTuneOverlay()
      return
    }
    if (key.name === 'escape') {
      if (this.state.coldStartIntent === 'new-thread' && this.state.overlay === 'setup') {
        this.cancelNewSoloThread()
        return
      }
      if (this.state.coldStart && this.state.coldStart.kind !== 'ready') {
        this.state.overlay = 'setup'
        this.render()
        return
      }
      // Escape is handled globally, ahead of every per-overlay key handler, so
      // an overlay that needs teardown has to be named here. The theme picker
      // has already repainted the frame by the time Escape arrives: closing it
      // without reverting would silently apply the theme the user backed out of.
      if (this.state.overlay === 'theme') {
        this.dismissThemePreview()
        return
      }
      if (this.state.overlay === 'help') {
        this.dismissCommandPalette()
        this.render()
        return
      }
      if (this.state.overlay === 'login') {
        this.providerLoginReadGeneration += 1
        this.state.providerLogin = undefined
        this.state.overlay = 'none'
        this.render()
        return
      }
      if (this.state.overlay === 'none') {
        const threadId = this.state.selectedThreadId
        if (this.pendingEscapeCancel) {
          this.setNotice('Cancellation already requested · waiting for the Host', 'warning', 2_000)
          this.render()
          return
        }
        const live = threadId ? liveThreadWorkIds(this.hostSnapshot, threadId) : []
        if (live.length > 0) {
          const draft = this.state.input.trim()
          if (threadId && draft && !draft.startsWith('/') && !this.selectedOpenQuestion()) {
            this.enqueuePromptDraft(threadId, draft, this.state.pendingSelection)
            this.state.input = ''
            this.state.inputCursor = 0
            this.state.pendingSelection = undefined
            this.state.scrollOffset = 0
            this.scheduleQueuedDraftDrain()
          }
          void this.cancelRun({ shortcut: true, liveWorkIds: live })
          return
        }
        if (threadId && this.hostSnapshot?.freshness === 'cached') {
          void this.refreshThenHandleEscape(threadId, this.state.input)
          return
        }
        if (threadId && this.hostSnapshot?.freshness !== 'live') {
          this.retainEscapeIntent(threadId, this.state.input)
          return
        }
      }
      this.commandPaletteAutomatic = false
      this.state.overlay = 'none'
      this.render()
      return
    }
    if (this.state.overlay === 'setup') {
      void this.handleColdStartKey(input, key).catch((error) => {
        this.setNotice(
          `Host setup failed · ${error instanceof Error ? error.message : String(error)}`,
          'error',
          4_000
        )
        this.render()
      })
      return
    }
    if (this.state.overlay === 'threads') {
      this.handleThreadPickerKey(key)
      return
    }
    if (this.state.overlay === 'missions') {
      this.handleMissionKey(key)
      return
    }
    if (this.state.overlay === 'tune') {
      this.handleTuneKey(key)
      return
    }
    if (this.state.overlay === 'git') {
      this.handleGitKey(key)
      return
    }
    if (this.state.overlay === 'seats') {
      this.handleSeatsKey(key)
      return
    }
    if (this.state.overlay === 'workspaces') {
      this.handleWorkspacePickerKey(key)
      return
    }
    if (this.state.overlay === 'theme') {
      this.handleThemePickerKey(key)
      return
    }
    if (this.state.overlay === 'help') {
      this.handleCommandPaletteKey(input, key)
      return
    }
    if (this.state.overlay === 'login') {
      void this.handleProviderLoginKey(key)
      return
    }
    if (this.state.overlay !== 'none') {
      if (key.name === 'return' || key.name === 'enter') {
        this.state.overlay = 'none'
        this.render()
      }
      return
    }
    if (key.name === 'tab' && key.shift) {
      void this.cycleThreadPermission()
      return
    }
    if (key.name === 'pageup') {
      const history = this.state.history
      const transcriptRows = this.state.thread?.rows.length ?? 0
      const transcriptViewportRows = Math.max(1, this.options.output.rows - 3)
      const atTop = this.state.scrollOffset >= Math.max(0, transcriptRows - transcriptViewportRows)
      if (history?.nextBefore && !history.loadingOlder && atTop) {
        this.state.history = { ...history, loadingOlder: true }
        void this.loadThreadHistory(history.threadId, history.nextBefore)
          .catch((error) => this.surfaceProjectionSyncError(error))
          .finally(() => {
            if (this.state.history)
              this.state.history = { ...this.state.history, loadingOlder: false }
            this.render()
          })
      }
      this.state.scrollOffset = Math.min(
        Math.max(0, transcriptRows - 1),
        this.state.scrollOffset + TRANSCRIPT_PAGE_ROWS
      )
      this.render()
      return
    }
    if (key.name === 'pagedown') {
      this.state.scrollOffset = Math.max(0, this.state.scrollOffset - TRANSCRIPT_PAGE_ROWS)
      this.render()
      return
    }
    if (key.name === 'left') {
      this.state.inputCursor = Math.max(0, this.state.inputCursor - 1)
      this.render()
      return
    }
    if (key.name === 'right') {
      this.state.inputCursor = Math.min(
        Array.from(this.state.input).length,
        this.state.inputCursor + 1
      )
      this.render()
      return
    }
    if (key.name === 'home') {
      this.state.inputCursor = 0
      this.render()
      return
    }
    if (key.name === 'end') {
      this.state.inputCursor = Array.from(this.state.input).length
      this.render()
      return
    }
    if (key.name === 'backspace') {
      const characters = Array.from(this.state.input)
      if (this.state.inputCursor > 0) {
        characters.splice(this.state.inputCursor - 1, 1)
        this.state.input = characters.join('')
        this.state.inputCursor -= 1
      }
      this.render()
      return
    }
    if (key.name === 'delete') {
      const characters = Array.from(this.state.input)
      if (this.state.inputCursor < characters.length) {
        characters.splice(this.state.inputCursor, 1)
        this.state.input = characters.join('')
      }
      this.render()
      return
    }
    if (key.name === 'return' || key.name === 'enter') {
      void this.submit()
      return
    }
    if (!key.ctrl && !key.meta && input) {
      this.insertComposerText(input.replace(/\r?\n/g, ' '))
      this.syncCommandPaletteAfterInput()
      this.render()
    }
  }

  private insertComposerText(value: string): void {
    const safe = sanitizeTerminalText(value)
    if (!safe) return
    const characters = Array.from(this.state.input)
    const available = Math.max(0, 12_000 - characters.length)
    const inserted = Array.from(safe).slice(0, available)
    if (!inserted.length) return
    characters.splice(this.state.inputCursor, 0, ...inserted)
    this.state.input = characters.join('')
    this.state.inputCursor = Math.min(characters.length, this.state.inputCursor + inserted.length)
  }

  private dismissCommandPalette(): void {
    if (this.state.overlay === 'help') this.state.overlay = 'none'
    this.state.commandPaletteQuery = undefined
    this.commandPaletteAutomatic = false
  }

  private commandPaletteFilterText(): string {
    return this.state.commandPaletteQuery ?? (this.commandPaletteAutomatic ? this.state.input : '')
  }

  private syncCommandPaletteAfterInput(): void {
    const leadingTokenOnly = /^\s*\/[^\s]*$/.test(this.state.input)
    if (leadingTokenOnly) {
      this.state.overlay = 'help'
      this.state.overlayIndex = 0
      this.state.commandPaletteQuery = this.state.input
      this.commandPaletteAutomatic = true
      return
    }
    const slashWithArguments = Boolean(parseLeadingTuiSlashToken(this.state.input))
    if (this.commandPaletteAutomatic || (this.state.overlay === 'help' && slashWithArguments)) {
      this.dismissCommandPalette()
    }
  }

  private handleCommandPaletteKey(input: string, key: Keypress): void {
    const commands = filterTuiSlashCommands(this.commandPaletteFilterText())
    const lastIndex = Math.max(0, commands.length - 1)
    if (key.name === 'up') {
      this.state.overlayIndex = Math.max(0, this.state.overlayIndex - 1)
      this.render()
      return
    }
    if (key.name === 'down') {
      this.state.overlayIndex = Math.min(lastIndex, this.state.overlayIndex + 1)
      this.render()
      return
    }
    if (key.name === 'pageup' || key.name === 'pagedown') {
      const page = Math.max(1, (this.options.output.rows || 24) - 4)
      this.state.overlayIndex = Math.max(
        0,
        Math.min(lastIndex, this.state.overlayIndex + (key.name === 'pageup' ? -page : page))
      )
      this.render()
      return
    }
    if (key.name === 'return' || key.name === 'enter' || key.name === 'tab') {
      const selected = commands[Math.max(0, Math.min(this.state.overlayIndex, lastIndex))]
      if (!selected) {
        this.dismissCommandPalette()
        this.render()
        return
      }
      if ((key.name === 'return' || key.name === 'enter') && !selected.destructive) {
        if (this.commandPaletteAutomatic) {
          this.state.input = ''
          this.state.inputCursor = 0
        }
        this.dismissCommandPalette()
        void this.runCommand(selected.name)
        return
      }
      this.state.input = selected.name
      this.state.inputCursor = Array.from(selected.name).length
      this.dismissCommandPalette()
      this.render()
      return
    }
    if (key.name === 'left') {
      this.state.inputCursor = Math.max(0, this.state.inputCursor - 1)
      this.render()
      return
    }
    if (key.name === 'right') {
      this.state.inputCursor = Math.min(
        Array.from(this.state.input).length,
        this.state.inputCursor + 1
      )
      this.render()
      return
    }
    if (key.name === 'home') {
      this.state.inputCursor = 0
      this.render()
      return
    }
    if (key.name === 'end') {
      this.state.inputCursor = Array.from(this.state.input).length
      this.render()
      return
    }
    if (key.name === 'backspace') {
      if (!this.commandPaletteAutomatic) {
        const query = Array.from(this.state.commandPaletteQuery ?? '')
        query.pop()
        this.state.commandPaletteQuery = query.join('')
        this.state.overlayIndex = 0
        this.render()
        return
      }
      const characters = Array.from(this.state.input)
      if (this.state.inputCursor > 0) {
        characters.splice(this.state.inputCursor - 1, 1)
        this.state.input = characters.join('')
        this.state.inputCursor -= 1
      }
      this.state.overlayIndex = 0
      this.syncCommandPaletteAfterInput()
      this.render()
      return
    }
    if (key.name === 'delete') {
      if (!this.commandPaletteAutomatic) return
      const characters = Array.from(this.state.input)
      if (this.state.inputCursor < characters.length) {
        characters.splice(this.state.inputCursor, 1)
        this.state.input = characters.join('')
      }
      this.state.overlayIndex = 0
      this.syncCommandPaletteAfterInput()
      this.render()
      return
    }
    if (!key.ctrl && !key.meta && input) {
      if (!this.commandPaletteAutomatic) {
        const appended = sanitizeTerminalText(input.replace(/\r?\n/g, ' '))
        this.state.commandPaletteQuery = `${this.state.commandPaletteQuery ?? ''}${appended}`.slice(
          0,
          256
        )
        this.state.overlayIndex = 0
        this.render()
        return
      }
      this.insertComposerText(input.replace(/\r?\n/g, ' '))
      this.state.overlayIndex = 0
      this.syncCommandPaletteAfterInput()
      this.render()
    }
  }

  private async handleColdStartKey(input: string, key: Keypress): Promise<void> {
    const cold = this.state.coldStart
    const actor = this.actorIdentity()
    if (!cold || !actor || !this.client) return
    if (cold.kind === 'workspace' && (key.name === 'up' || key.name === 'down')) {
      this.state.coldStartProviderIndex = cycleIndex(
        this.state.coldStartProviderIndex ?? 0,
        this.state.coldStartProviderChoices?.length ?? 0,
        key.name === 'up' ? -1 : 1
      )
      this.render()
      return
    }
    if (cold.kind === 'auth' && (key.name === 'up' || key.name === 'down')) {
      this.state.coldStartAuthFlowIndex = cycleIndex(
        this.state.coldStartAuthFlowIndex ?? 0,
        cold.flows.length,
        key.name === 'up' ? -1 : 1
      )
      this.render()
      return
    }
    if (cold.kind === 'configure' && (key.name === 'up' || key.name === 'down')) {
      this.state.coldStartModelIndex = cycleIndex(
        this.state.coldStartModelIndex ?? 0,
        cold.offers.models.filter((candidate) => candidate.available).length,
        key.name === 'up' ? -1 : 1
      )
      this.render()
      return
    }
    if (cold.kind === 'configure' && (key.name === 'left' || key.name === 'right')) {
      this.state.coldStartPostureIndex = cycleAvailableIndex(
        cold.offers.postures,
        this.state.coldStartPostureIndex ?? 0,
        key.name === 'left' ? -1 : 1
      )
      this.render()
      return
    }
    if (cold.kind === 'configure' && key.name === 'tab') {
      const model = cold.offers.models.filter((candidate) => candidate.available)[
        this.state.coldStartModelIndex ?? 0
      ]
      this.state.coldStartReasoningIndex = cycleIndex(
        this.state.coldStartReasoningIndex ?? 0,
        model?.reasoning.filter((candidate) => candidate.available).length ?? 0,
        1
      )
      this.render()
      return
    }
    if (cold.kind === 'idle') {
      if (key.name === 'return' || key.name === 'enter') {
        const path = this.state.input.trim()
        if (!isAbsolute(path)) {
          this.setNotice('Enter an absolute workspace path.', 'warning', 3_000)
        } else {
          this.state.input = ''
          this.state.inputCursor = 0
          await this.runColdStartCommand(buildWorkspaceRegisterCommand({ actor, path }))
        }
      } else if (!key.ctrl && !key.meta && input) {
        this.insertComposerText(input)
      }
      this.render()
      return
    }
    if (key.name === 'space' && cold.kind === 'configure') {
      const posture = cold.offers.postures[this.state.coldStartPostureIndex ?? 0]
      if (posture && !posture.available) {
        this.setNotice(posture.detail || `${posture.label} is unavailable.`, 'warning', 4_000)
        this.render()
        return
      }
      if (posture?.requiresExplicitConsent)
        this.state.coldStart = acknowledgeColdStartPosture(cold, posture.postureId)
      this.render()
      return
    }
    if (key.name !== 'return' && key.name !== 'enter') return
    if (cold.kind === 'workspace') {
      if (!this.state.coldStartProviderChoices?.length) {
        await this.loadColdStartProviders()
        this.setNotice('Use ↑/↓ to choose a provider, then Enter.', 'neutral')
        this.render()
        return
      }
      const status = this.state.coldStartProviderChoices[this.state.coldStartProviderIndex ?? 0]
      if (!status) throw new Error('No Host provider is currently available.')
      await this.confirmColdStartProvider(status)
    } else if (cold.kind === 'auth') {
      if (cold.operationId) {
        await this.refreshColdStartAuth(cold.providerId)
        this.render()
        return
      }
      const flow = cold.flows[this.state.coldStartAuthFlowIndex ?? 0]
      if (!flow) throw new Error('No provider auth flow is currently available.')
      const command = buildProviderAuthBeginCommand({
        actor,
        providerId: cold.providerId,
        flowId: flow.flowId
      })
      this.state.coldStart = beginColdStartProviderAuth(
        cold,
        flow.flowId,
        this.pendingFrom(command)
      )
      await this.runColdStartCommand(command, { preserveColdPending: true })
    } else if (cold.kind === 'offers') {
      await this.runColdStartCommand(
        buildThreadCreateCommand({
          actor,
          scope: cold.workspaceId ? 'workspace' : 'global',
          workspaceId: cold.workspaceId
        })
      )
    } else if (cold.kind === 'thread') {
      this.state.coldStart = coldStartConfigure(cold)
    } else if (cold.kind === 'configure') {
      const model = cold.offers.models.filter((candidate) => candidate.available)[
        this.state.coldStartModelIndex ?? 0
      ]
      const posture = cold.offers.postures[this.state.coldStartPostureIndex ?? 0]
      if (!model || !posture) throw new Error('Host offers contain no available configuration.')
      if (!posture.available) {
        this.setNotice(posture.detail || `${posture.label} is unavailable.`, 'warning', 4_000)
        this.render()
        return
      }
      const consented =
        !posture.requiresExplicitConsent || cold.acknowledgedPostureIds.includes(posture.postureId)
      const selection = selectColdStartConfiguration(cold, {
        providerId: cold.providerId,
        modelId: model.modelId,
        postureId: posture.postureId,
        offerRevision: cold.offers.offerRevision,
        ...(consented && posture.requiresExplicitConsent ? { postureConsent: true } : {}),
        ...(model.reasoning.filter((candidate) => candidate.available)[
          this.state.coldStartReasoningIndex ?? 0
        ]
          ? {
              reasoningId: model.reasoning.filter((candidate) => candidate.available)[
                this.state.coldStartReasoningIndex ?? 0
              ].reasoningId
            }
          : {})
      })
      this.state.coldStart = selection
      if (selection.kind !== 'configure' || !selection.selection) return
      await this.runColdStartCommand(
        this.authorizeConfigureCommand(
          buildThreadConfigureCommand({ actor, selection: selection.selection })
        )
      )
    }
    this.render()
  }

  private pendingFrom(command: HostCommand): ColdStartPendingCommand {
    return {
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      name: command.name as ColdStartPendingCommand['name'],
      submittedAt: new Date(this.options.now()).toISOString()
    }
  }

  private async runColdStartCommand(
    command: HostCommand,
    options: { preserveColdPending?: boolean } = {}
  ): Promise<void> {
    if (!this.state.coldStart) return
    if (!options.preserveColdPending)
      this.state.coldStart = coldStartPending(this.state.coldStart, this.pendingFrom(command))
    await this.runHostMutation(command, {
      onTerminalReceipt: (receipt) => {
        if (this.state.coldStart)
          this.state.coldStart = applyColdStartReceipt(this.state.coldStart, receipt)
      },
      onSucceeded: async () => {
        const cold = this.state.coldStart
        if (cold?.kind === 'workspace') {
          this.rememberWorkspaceId(cold.workspaceId)
          this.setNotice('Workspace registered · choose provider', 'good')
        }
        if (cold?.kind === 'thread') this.setNotice('Thread created · configure it', 'good')
        if (cold?.kind === 'auth' && cold.operationId) await this.pollColdStartAuth(cold.providerId)
        if (cold?.kind === 'ready') {
          this.state.overlay = 'none'
          this.state.coldStartIntent = undefined
          this.state.selectedThreadId = cold.threadId
          if (this.retainHomeForNextThread) this.state.homeContinuationThreadId = cold.threadId
          this.retainHomeForNextThread = false
          await this.refreshHostSnapshot()
          this.applyLocalThread(cold.threadId, { previewNotice: true })
          await this.loadThreadHistory(cold.threadId)
          const workspaceId = this.state.thread?.thread.workspaceId
          if (workspaceId) this.rememberWorkspaceId(workspaceId)
          if (command.name === 'thread.configure') {
            const providerId = command.arguments.providerId
            const modelId = command.arguments.modelId
            const reasoningId = command.arguments.reasoningId
            if (typeof providerId === 'string' && typeof modelId === 'string') {
              this.rememberProfileSettings({
                providerId,
                modelId,
                ...(typeof reasoningId === 'string' ? { reasoningId } : { reasoningId: undefined })
              })
            }
          }
        }
      }
    })
  }

  private async refreshColdStartAuth(providerId: string): Promise<void> {
    if (!this.client?.connected || !this.state.coldStart || this.state.coldStart.kind !== 'auth')
      return
    const status = await this.client.getProviderAuthStatus(providerId)
    if (status.state !== 'authenticated') {
      this.setNotice(
        'Authentication is still pending · complete the provider flow, then reconnect or press Enter to refresh.',
        'warning'
      )
      this.render()
      return
    }
    this.state.coldStart = coldStartOffers(
      this.state.coldStart,
      this.effectiveProviderOffers(await this.client.getProviderOffers(providerId))
    )
    this.resetColdStartConfigureIndices()
    this.setNotice('Provider authenticated · choose thread creation.', 'good')
    this.render()
  }

  /** Polls a bounded number of status reads; a handoff opening is never success. */
  private async pollColdStartAuth(providerId: string): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (this.stopped || !this.client?.connected) return
      await this.refreshColdStartAuth(providerId)
      if (this.state.coldStart?.kind === 'offers') return
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 750)
        timer.unref?.()
      })
    }
    if (this.state.coldStart?.kind === 'auth') {
      this.setNotice(
        'Authentication is still pending · press Enter to refresh when complete.',
        'warning',
        4_000
      )
    }
  }

  private resetColdStartConfigureIndices(): void {
    const cold = this.state.coldStart
    const offers =
      cold?.kind === 'offers' || cold?.kind === 'thread' || cold?.kind === 'configure'
        ? cold.offers
        : undefined
    const models = offers?.models.filter((candidate) => candidate.available) ?? []
    const savedForProvider = this.profileSettings.providerId === offers?.providerId
    const model = offers
      ? resolveStartupModel(offers, savedForProvider ? this.profileSettings.modelId : undefined)
      : undefined
    this.state.coldStartModelIndex = Math.max(
      0,
      model ? models.findIndex((candidate) => candidate.modelId === model.modelId) : 0
    )
    const reasoning = resolveStartupReasoning(
      model,
      savedForProvider ? this.profileSettings.reasoningId : undefined
    )
    const reasoningOffers = model?.reasoning.filter((candidate) => candidate.available) ?? []
    this.state.coldStartReasoningIndex = Math.max(
      0,
      reasoning
        ? reasoningOffers.findIndex((candidate) => candidate.reasoningId === reasoning.reasoningId)
        : 0
    )
    const postures = offers?.postures ?? []
    const posture = offers ? resolveStartupPosture(offers) : undefined
    this.state.coldStartPostureIndex = Math.max(
      0,
      posture ? postures.findIndex((candidate) => candidate.postureId === posture.postureId) : 0
    )
  }

  private async resumeColdStartPending(): Promise<void> {
    const pending = this.state.coldStart?.pending
    if (!pending || !this.client?.connected) return
    const receipt = await this.client.lookupReceipt({ commandId: pending.commandId })
    if (this.state.coldStart)
      this.state.coldStart = applyColdStartReceipt(this.state.coldStart, receipt)
    if (this.state.coldStart?.kind === 'auth' && this.state.coldStart.operationId) {
      await this.refreshColdStartAuth(this.state.coldStart.providerId)
    }
  }

  private toggleOverlay(overlay: Exclude<TuiOverlay, 'none'>): void {
    this.state.overlay = this.state.overlay === overlay ? 'none' : overlay
    if (overlay === 'threads' && this.state.overlay === 'threads') {
      const threads = visibleThreadRows(this.state)
      this.state.overlayIndex = Math.max(
        0,
        threads.findIndex((thread) => thread.id === this.state.selectedThreadId)
      )
    }
    if (overlay === 'theme' && this.state.overlay === 'theme') {
      const names = [TUI_AUTO_THEME_NAME, ...tuiThemeNames()]
      this.themeBeforePreview = this.theme
      this.state.overlayIndex = Math.max(0, names.indexOf(this.state.themeName ?? this.theme.name))
    }
    if (overlay === 'workspaces' && this.state.overlay === 'workspaces') {
      const workspaces = this.state.snapshot?.workspaces ?? []
      const resolved = this.resolveWorkspaceId()
      this.state.overlayIndex = Math.max(
        0,
        workspaces.findIndex((workspace) => workspace.id === resolved)
      )
    }
    this.render()
  }

  /**
   * Which workspace a new thread lands in. Profile-scoped last-open memory wins,
   * then the current thread, then the most recently updated registered workspace.
   * Every remembered id is revalidated against the current Host projection.
   */
  private resolveWorkspaceId(): string | undefined {
    const workspaces = this.state.snapshot?.workspaces ?? []
    return resolveStartupWorkspaceId({
      workspaces,
      savedWorkspaceId: this.state.activeWorkspaceId ?? this.profileSettings.workspaceId,
      currentThreadWorkspaceId: this.state.thread?.thread.workspaceId
    })
  }

  private rememberProfileSettings(changes: TuiProfileSettings): boolean {
    this.profileSettings = { ...this.profileSettings, ...changes }
    return this.options.persistProfileSettings?.(changes) ?? true
  }

  private rememberWorkspaceId(workspaceId: string): void {
    this.state.activeWorkspaceId = workspaceId
    this.rememberProfileSettings({ workspaceId })
  }

  private handleWorkspacePickerKey(key: Keypress): void {
    const workspaces = this.state.snapshot?.workspaces ?? []
    if (key.name === 'up') {
      this.state.overlayIndex = Math.max(0, this.state.overlayIndex - 1)
    } else if (key.name === 'down') {
      this.state.overlayIndex = Math.min(
        Math.max(0, workspaces.length - 1),
        this.state.overlayIndex + 1
      )
    } else if (key.name === 'return' || key.name === 'enter') {
      const workspace = workspaces[this.state.overlayIndex]
      if (workspace) {
        this.rememberWorkspaceId(workspace.id)
        this.state.overlay = 'none'
        this.setNotice(`New threads will use ${workspace.name}.`, 'neutral', 3_000)
      }
      this.render()
      return
    } else {
      return
    }
    this.render()
  }

  /**
   * Resolve a theme name and paint in it.
   *
   * `auto` resolves from the synchronous appearance rungs only. The OSC 11
   * probe owns terminal input while it runs, which is safe once at startup and
   * never safe here — the reader is attached and would lose the keystroke.
   */
  private resolveThemeByName(name: string): TuiTheme {
    const chosen = isAutoThemeName(name)
      ? resolveAutoTheme(
          resolveTuiAppearanceWithoutProbe(process.env, process.platform, () => undefined)
        )
      : resolveTuiTheme(name)
    return tuiThemeForColorMode(chosen, this.options.colorMode)
  }

  /** Repaint in `name` without committing it. Used for picker previews. */
  private previewTheme(name: string): void {
    this.theme = this.resolveThemeByName(name)
  }

  /**
   * Commit a theme.
   *
   * An unknown name is answered rather than swallowed: `resolveTuiTheme` falls
   * back silently by design so a stale config cannot block startup, but a name
   * the user just typed deserves to be told it did not land.
   */
  private applyTheme(name: string, options: { persist: boolean }): void {
    const known = isAutoThemeName(name) || tuiThemeNames().includes(name.trim().toLowerCase())
    const resolved = this.resolveThemeByName(name)
    if (!known && resolved.name !== name.trim().toLowerCase()) {
      this.setNotice(
        `Unknown theme "${name}". Try: ${[TUI_AUTO_THEME_NAME, ...tuiThemeNames()].join(', ')}`,
        'warning',
        5_000
      )
      this.render()
      return
    }
    const canonical = isAutoThemeName(name) ? TUI_AUTO_THEME_NAME : resolved.name
    this.theme = resolved
    this.state.themeName = canonical
    this.themeBeforePreview = undefined
    this.state.overlay = 'none'
    if (options.persist && this.options.persistTheme) {
      const stored = this.options.persistTheme(canonical)
      this.setNotice(
        stored
          ? `Theme set to ${canonical}.`
          : `Theme set to ${canonical} for this session — could not save it.`,
        stored ? 'neutral' : 'warning',
        3_000
      )
    } else {
      this.setNotice(`Theme set to ${canonical}.`, 'neutral', 3_000)
    }
    this.render()
  }

  /** Close the picker and put back the theme the preview replaced. */
  private dismissThemePreview(): void {
    if (this.themeBeforePreview) this.theme = this.themeBeforePreview
    this.themeBeforePreview = undefined
    this.state.overlay = 'none'
    this.render()
  }

  private handleThemePickerKey(key: Keypress): void {
    const names = [TUI_AUTO_THEME_NAME, ...tuiThemeNames()]
    if (key.name === 'up') {
      this.state.overlayIndex = Math.max(0, this.state.overlayIndex - 1)
    } else if (key.name === 'down') {
      this.state.overlayIndex = Math.min(names.length - 1, this.state.overlayIndex + 1)
    } else if (key.name === 'return' || key.name === 'enter') {
      this.applyTheme(names[this.state.overlayIndex] as string, { persist: true })
      return
    } else if (key.name === 'escape') {
      // Unreachable while the global Escape branch runs first; kept so the
      // handler stays correct on its own terms if that ordering ever changes.
      this.dismissThemePreview()
      return
    } else {
      return
    }
    this.previewTheme(names[this.state.overlayIndex] as string)
    this.render()
  }

  /**
   * `/workspace <absolute-path>` — the only route to workspace.register once a
   * workspace already exists. The cold-start flow offers a path step, but only
   * when no workspace resolves at all, so a profile with one registered
   * workspace could never add a second from the CLI.
   */
  private async registerWorkspace(path: string): Promise<void> {
    if (!this.client) {
      this.setNotice('Demo mode cannot register workspaces.', 'warning', 3_000)
      this.render()
      return
    }
    // workspace.register is a setup mutation, but setup mutations are dispatched
    // over the command channel -- the `setup` capability covers the guided setup
    // projection, not mutation delivery. Gating on it would refuse on a Host that
    // advertises commands and would have registered the workspace happily.
    if (!this.client.supports('commands')) {
      this.setNotice('Connected Host does not advertise workspace commands.', 'warning', 3_000)
      this.render()
      return
    }
    const actor = this.actorIdentity()
    if (!actor) {
      this.setNotice('TaskWraith Host is not connected.', 'warning', 3_000)
      this.render()
      return
    }
    const command = buildWorkspaceRegisterCommand({ actor, path })
    await this.runHostMutation(command, {
      onSucceeded: async (receipt) => {
        const registered =
          receipt.resultRef?.kind === 'workspace' ? receipt.resultRef.workspaceId : undefined
        await this.refreshHostSnapshot()
        if (registered) {
          // Registering is an explicit act of intent, so adopt it immediately
          // rather than making the user register and then pick it as well.
          this.rememberWorkspaceId(registered)
          this.setNotice(`Registered ${path}; new threads will use it.`, 'neutral', 4_000)
        }
        this.state.overlay = 'workspaces'
      }
    })
    this.render()
  }

  private handleThreadPickerKey(key: Keypress): void {
    const threads = visibleThreadRows(this.state)
    if (key.name === 'up') {
      this.state.overlayIndex = Math.max(0, this.state.overlayIndex - 1)
    } else if (key.name === 'down') {
      this.state.overlayIndex = Math.min(
        Math.max(0, threads.length - 1),
        this.state.overlayIndex + 1
      )
    } else if (key.name === 'a') {
      // Revealing archived chats is what keeps /archive from being a one-way
      // door: this CLI must not need the desktop app to undo its own action.
      this.state.showArchivedThreads = !this.state.showArchivedThreads
      this.state.overlayIndex = 0
    } else if (key.name === 'return' || key.name === 'enter') {
      const thread = threads[this.state.overlayIndex]
      if (!thread) return
      // An archived thread cannot be selected — the Host refuses thread.select
      // for one — so Enter restores it instead of failing in the user's face.
      if (thread.archived) {
        void this.setThreadArchived(thread.id, false, thread.title)
        return
      }
      void this.openThread(thread.id)
      return
    } else {
      return
    }
    this.render()
  }

  /** `/archive` retires the open thread; the picker's `a` reveal restores it. */
  private async archiveOpenThread(): Promise<void> {
    const threadId = this.state.selectedThreadId
    const title = this.state.thread?.thread.title
    if (!threadId || !title) {
      this.setNotice('Open a thread before archiving.', 'warning', 3_000)
      this.render()
      return
    }
    await this.setThreadArchived(threadId, true, title)
  }

  private async setThreadArchived(
    threadId: string,
    archived: boolean,
    title: string
  ): Promise<void> {
    if (!this.client) {
      this.setNotice('Demo mode cannot archive threads.', 'warning', 3_000)
      this.render()
      return
    }
    // Setup mutations travel the command channel, exactly as thread.create does
    // in createSoloThread. Gating on the `setup` capability would refuse on a
    // Host that advertises commands and would have accepted this happily.
    if (!this.client.supports('commands')) {
      this.setNotice('Connected Host does not advertise thread commands.', 'warning', 3_000)
      this.render()
      return
    }
    const actor = this.actorIdentity()
    if (!actor) {
      this.setNotice('TaskWraith Host is not connected.', 'warning', 3_000)
      this.render()
      return
    }
    const command = buildThreadArchiveCommand({ actor, threadId, archived })
    await this.runHostMutation(command, {
      onSucceeded: async () => {
        await this.refreshHostSnapshot()
        if (!archived) {
          this.setNotice(`Restored ${title}.`, 'neutral', 3_000)
          await this.openThread(threadId)
          return
        }
        this.setNotice(`Archived ${title} · /threads then a reveals it.`, 'neutral', 4_000)
        // The archived thread can no longer be selected, so land somewhere real
        // rather than leaving the transcript pointed at a thread that is gone.
        const next = [...(this.state.snapshot?.threads ?? [])]
          .filter((thread) => !thread.archived)
          .sort((left, right) => right.updatedAt - left.updatedAt)[0]
        if (next) await this.openThread(next.id)
      }
    })
    this.render()
  }

  private visibleMissions() {
    const filter = this.state.missionFilter ?? 'active'
    return [...(this.state.hostProjection?.missions ?? [])]
      .filter((mission) => {
        const active = mission.status === 'active' || mission.status === 'blocked'
        if (filter === 'active') return active
        if (filter === 'history') return !active
        return true
      })
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }

  private toggleMissionOverlay(filter = this.state.missionFilter ?? 'active'): void {
    if (this.state.overlay === 'missions' && filter === this.state.missionFilter) {
      this.state.overlay = 'none'
    } else {
      this.state.overlay = 'missions'
      this.state.missionFilter = filter
      this.state.overlayIndex = 0
      this.state.missionParticipantOffset = 0
    }
    this.render()
  }

  private handleMissionKey(key: Keypress): void {
    const filters = ['active', 'history', 'all'] as const
    if (key.name === 'left' || key.name === 'right' || key.name === 'tab') {
      const current = Math.max(0, filters.indexOf(this.state.missionFilter ?? 'active'))
      const delta = key.name === 'left' ? -1 : 1
      this.state.missionFilter = filters[(current + delta + filters.length) % filters.length]
      this.state.overlayIndex = 0
      this.state.missionParticipantOffset = 0
    } else {
      const missions = this.visibleMissions()
      if (key.name === 'up') {
        this.state.overlayIndex = Math.max(0, this.state.overlayIndex - 1)
        this.state.missionParticipantOffset = 0
      } else if (key.name === 'down') {
        this.state.overlayIndex = Math.min(
          Math.max(0, missions.length - 1),
          this.state.overlayIndex + 1
        )
        this.state.missionParticipantOffset = 0
      } else if (key.name === 'pageup') {
        this.state.missionParticipantOffset = Math.max(
          0,
          (this.state.missionParticipantOffset ?? 0) - TRANSCRIPT_PAGE_ROWS
        )
      } else if (key.name === 'pagedown') {
        this.state.missionParticipantOffset = Math.min(
          Math.max(0, (this.state.hostProjection?.participants.length ?? 1) - 1),
          (this.state.missionParticipantOffset ?? 0) + TRANSCRIPT_PAGE_ROWS
        )
      } else if (key.name === 'return' || key.name === 'enter') {
        const mission = missions[this.state.overlayIndex]
        if (mission?.threadId) void this.openThread(mission.threadId)
        return
      } else {
        return
      }
    }
    this.render()
  }

  /** The tune lens stages model/reasoning for the next send. Host-validated. */
  private toggleTuneOverlay(): void {
    if (this.state.overlay === 'tune') {
      this.state.overlay = 'none'
      this.homeTuneReadGeneration += 1
      if (this.state.homeTune?.loading) this.state.homeTune = undefined
      this.render()
      return
    }
    if (this.state.thread && (!this.client || !this.client.supports('provider-catalog'))) {
      this.state.homeTune = undefined
      this.state.overlay = 'tune'
      this.state.overlayIndex = 0
      this.state.tuneEffortIndex = 0
      void this.loadOffers()
      this.render()
      return
    }
    this.state.overlay = 'tune'
    this.state.homeTune = {
      loading: true,
      providers: [],
      providerIndex: 0,
      modelIndex: 0,
      reasoningIndex: -1
    }
    void this.loadHomeTuneProviders(true)
    this.render()
  }

  private effortIndexFor(offers: TaskWraithControlThreadOffers, modelIndex: number): number {
    const offer = offers.models[modelIndex]
    if (!offer) return 0
    const wanted = offer.current
      ? (offers.currentReasoningEffort ?? offer.defaultReasoningEffort)
      : offer.defaultReasoningEffort
    return Math.max(
      0,
      offer.reasoningEfforts.findIndex((effort) => effort.id === wanted)
    )
  }

  private async loadOffers(): Promise<void> {
    const threadId = this.state.selectedThreadId
    if (!threadId) return
    if (!this.client) {
      this.state.offers = this.state.thread
        ? {
            threadId,
            provider: this.state.thread.thread.provider,
            models: [],
            source: 'curated',
            locked: 'Demo mode — model offers come from the App host.'
          }
        : undefined
      return
    }
    this.state.offersLoading = true
    this.render()
    try {
      if (!this.client.welcome?.capabilities.includes('model-offers')) {
        const locked = 'Connected Host does not advertise model offers · update TaskWraith'
        this.state.offers = {
          threadId,
          provider: this.state.thread!.thread.provider,
          models: [],
          source: 'curated',
          locked
        }
        this.setNotice(locked, 'warning', 3_000)
        return
      }
      const offers = await this.client.getThreadOffers(threadId)
      // A quick thread switch must not paint the previous thread's catalogue.
      if (this.state.selectedThreadId !== threadId) return
      this.state.offers = offers
      const currentIndex = offers.models.findIndex((model) => model.current)
      this.state.overlayIndex = Math.max(0, currentIndex)
      this.state.tuneEffortIndex = this.effortIndexFor(offers, this.state.overlayIndex)
    } catch {
      if (this.state.selectedThreadId !== threadId) return
      const locked = 'Unable to load model offers from the Host.'
      this.state.offers = {
        threadId,
        provider: this.state.thread!.thread.provider,
        models: [],
        source: 'curated',
        locked
      }
      this.setNotice(locked, 'warning', 3_000)
    } finally {
      this.state.offersLoading = false
      this.render()
    }
  }

  private handleTuneKey(key: Keypress): void {
    if (this.state.homeTune) {
      this.handleHomeTuneKey(key)
      return
    }
    const models = this.state.offers?.models ?? []
    if (this.state.offersLoading || !models.length) return
    const safeIndex = Math.max(0, Math.min(this.state.overlayIndex, models.length - 1))
    if (key.name === 'up' || key.name === 'down') {
      const nextIndex =
        key.name === 'up' ? Math.max(0, safeIndex - 1) : Math.min(models.length - 1, safeIndex + 1)
      this.state.overlayIndex = nextIndex
      this.state.tuneEffortIndex = this.state.offers
        ? this.effortIndexFor(this.state.offers, nextIndex)
        : 0
    } else if (key.name === 'left' || key.name === 'right') {
      const ladder = models[safeIndex]?.reasoningEfforts ?? []
      if (!ladder.length) return
      const delta = key.name === 'left' ? -1 : 1
      this.state.tuneEffortIndex = Math.max(
        0,
        Math.min(ladder.length - 1, this.state.tuneEffortIndex + delta)
      )
    } else if (key.name === 'return' || key.name === 'enter') {
      this.applyTuneSelection(models[safeIndex])
      return
    } else {
      return
    }
    this.render()
  }

  private resetHomeTuneSelection(
    preferredProviderId?: string,
    preferredModelId?: string,
    preferredReasoningId?: string
  ): void {
    const home = this.state.homeTune
    if (!home) return
    const choices = tuiModelChoices(home.providers)
    const selectedIndex = findTuiModelChoiceIndex(choices, preferredProviderId, preferredModelId)
    const modelIndex = Math.max(0, selectedIndex)
    const selected = choices[modelIndex]
    const reasoningRows = selected?.model.reasoning.filter((candidate) => candidate.available) ?? []
    const reasoningIndex = preferredReasoningId
      ? reasoningRows.findIndex((candidate) => candidate.reasoningId === preferredReasoningId)
      : -1
    this.state.homeTune = {
      ...home,
      providerIndex: selected?.providerIndex ?? 0,
      modelIndex,
      reasoningIndex
    }
  }

  private async loadHomeTuneProviders(_showOverlay: boolean): Promise<void> {
    const generation = ++this.homeTuneReadGeneration
    if (!this.client?.connected || !this.client.supports('provider-catalog')) {
      this.state.homeTune = {
        providers: [],
        providerIndex: 0,
        modelIndex: 0,
        reasoningIndex: -1,
        error: 'Connected Host does not advertise provider model setup.'
      }
      this.render()
      return
    }
    try {
      const statuses = (await this.client.getProviderStatuses()).filter(
        (status) => status.status === 'ready'
      )
      const loaded = (
        await Promise.all(
          statuses.map(async (status) => {
            try {
              return {
                status,
                offers: this.effectiveProviderOffers(
                  await this.client!.getProviderOffers(status.providerId)
                )
              }
            } catch {
              return null
            }
          })
        )
      ).filter((provider): provider is NonNullable<typeof provider> => provider !== null)
      if (generation !== this.homeTuneReadGeneration) return
      const providers = loaded.filter(
        ({ status, offers }) =>
          offers.providerId === status.providerId && offers.models.some((model) => model.available)
      )
      this.state.homeTune = {
        providers,
        providerIndex: 0,
        modelIndex: 0,
        reasoningIndex: -1,
        ...(providers.length ? {} : { error: 'No ready provider has selectable model offers.' })
      }
      const thread = this.state.thread?.thread
      this.resetHomeTuneSelection(
        thread?.provider.runtimeProvider ?? this.profileSettings.providerId,
        thread?.provider.model ?? this.profileSettings.modelId,
        thread?.reasoning ?? this.profileSettings.reasoningId
      )
    } catch (error) {
      if (generation !== this.homeTuneReadGeneration) return
      this.state.homeTune = {
        providers: [],
        providerIndex: 0,
        modelIndex: 0,
        reasoningIndex: -1,
        error: error instanceof Error ? error.message : String(error)
      }
    }
    this.render()
  }

  private handleHomeTuneKey(key: Keypress): void {
    const home = this.state.homeTune
    if (!home || home.loading || !home.providers.length) return
    const choices = tuiModelChoices(home.providers)
    const selected = choices[home.modelIndex]
    if (key.name === 'up' || key.name === 'down') {
      const next = cycleIndex(home.modelIndex, choices.length, key.name === 'up' ? -1 : 1)
      const nextChoice = choices[next]
      this.state.homeTune = {
        ...home,
        providerIndex: nextChoice?.providerIndex ?? 0,
        modelIndex: next,
        reasoningIndex: -1
      }
    } else if (key.name === 'left' || key.name === 'right') {
      const reasoning = selected?.model.reasoning.filter((candidate) => candidate.available) ?? []
      const slot = cycleIndex(
        home.reasoningIndex + 1,
        reasoning.length + 1,
        key.name === 'left' ? -1 : 1
      )
      this.state.homeTune = { ...home, reasoningIndex: slot - 1 }
    } else if (key.name === 'return' || key.name === 'enter') {
      if (!selected) return
      const reasoning = selected.model.reasoning.filter((candidate) => candidate.available)[
        home.reasoningIndex
      ]
      if (this.state.selectedThreadId) {
        void this.configureThreadModel(selected, reasoning?.reasoningId)
        return
      }
      const persisted = this.rememberProfileSettings({
        providerId: selected.provider.status.providerId,
        modelId: selected.model.modelId,
        ...(reasoning ? { reasoningId: reasoning.reasoningId } : { reasoningId: undefined })
      })
      this.state.overlay = 'none'
      this.setNotice(
        `${persisted ? 'Default' : 'Session default'} · ${selected.provider.status.label} / ${selected.model.label}${
          reasoning ? ` / ${reasoning.label}` : ''
        }`,
        persisted ? 'good' : 'warning',
        4_000
      )
    } else {
      return
    }
    this.render()
  }

  private async configureThreadModel(choice: TuiModelChoice, reasoningId?: string): Promise<void> {
    const threadId = this.state.selectedThreadId
    if (!threadId || !this.client?.connected || this.mutationInFlight) return
    try {
      const [current, refreshed] = await Promise.all([
        this.client.getThreadOffers(threadId),
        this.client.getProviderOffers(choice.provider.status.providerId)
      ])
      const offers = this.effectiveProviderOffers(refreshed)
      const model = offers.models.find(
        (candidate) => candidate.modelId === choice.model.modelId && candidate.available
      )
      if (!model) throw new Error('That model is no longer offered by the Host.')
      const requestedPosture =
        current.currentPostureId ?? this.state.thread?.context.permission ?? 'default'
      const posture =
        offers.postures.find(
          (candidate) => candidate.postureId === requestedPosture && candidate.available
        ) ??
        offers.postures.find(
          (candidate) => candidate.postureId === 'default' && candidate.available
        )
      if (!posture) throw new Error('The selected provider has no compatible permission tier.')
      await this.configureThreadSelection({
        threadId,
        providerId: offers.providerId,
        providerLabel: choice.provider.status.label,
        offers,
        model,
        reasoningId,
        posture,
        closeTune: true,
        ...(posture.postureId !== requestedPosture ? { downgradedFrom: requestedPosture } : {})
      })
    } catch (error) {
      this.setNotice(error instanceof Error ? error.message : String(error), 'warning', 4_000)
      this.render()
    }
  }

  private async configureThreadSelection(input: {
    threadId: string
    providerId: string
    providerLabel: string
    offers: HostProviderOffersProjection
    model: HostProviderModelOffer
    reasoningId?: string
    posture: HostPermissionPostureOffer
    closeTune?: boolean
    downgradedFrom?: string
  }): Promise<void> {
    const actor = this.actorIdentity()
    if (!actor) return
    const command = this.authorizeConfigureCommand(
      buildThreadConfigureCommand({
        actor,
        selection: {
          threadId: input.threadId,
          providerId: input.providerId,
          modelId: input.model.modelId,
          postureId: input.posture.postureId,
          offerRevision: input.offers.offerRevision,
          ...(input.reasoningId ? { reasoningId: input.reasoningId } : {}),
          ...(input.posture.requiresExplicitConsent ? { postureConsent: true } : {})
        }
      })
    )
    let configured = false
    await this.runHostMutation(command, {
      onSucceeded: async () => {
        configured = true
        await this.refreshHostSnapshot()
      }
    })
    if (!configured) return
    this.state.pendingSelection = undefined
    if (input.closeTune) this.state.overlay = 'none'
    const effort = input.reasoningId ? ` ${this.glyphs.separator} ${input.reasoningId}` : ''
    const downgrade = input.downgradedFrom
      ? ` ${this.glyphs.separator} ${input.posture.label} (compatible tier)`
      : ''
    this.setNotice(
      `${input.providerLabel} ${input.model.label}${effort}${downgrade}`,
      input.downgradedFrom ? 'warning' : 'good',
      4_000
    )
    this.render()
  }

  private async cycleThreadPermission(): Promise<void> {
    const threadId = this.state.selectedThreadId
    const thread = this.state.thread?.thread
    if (!threadId || !thread || !this.client?.connected || this.mutationInFlight) return
    try {
      const [current, refreshed] = await Promise.all([
        this.client.getThreadOffers(threadId),
        this.client.getProviderOffers(thread.provider.runtimeProvider)
      ])
      const offers = this.effectiveProviderOffers(refreshed)
      const modelId = current.currentModel ?? thread.provider.model
      const model = offers.models.find(
        (candidate) => candidate.modelId === modelId && candidate.available
      )
      if (!model) throw new Error('The active model is no longer offered by the Host.')
      const currentPosture =
        current.currentPostureId ?? this.state.thread?.context.permission ?? 'default'
      const posture = nextAvailableTuiPosture(offers.postures, currentPosture)
      if (!posture) throw new Error('No permission tier is available for the active model.')
      await this.configureThreadSelection({
        threadId,
        providerId: offers.providerId,
        providerLabel: thread.provider.displayProvider,
        offers,
        model,
        reasoningId: current.currentReasoningEffort ?? thread.reasoning,
        posture
      })
    } catch (error) {
      this.setNotice(error instanceof Error ? error.message : String(error), 'warning', 4_000)
      this.render()
    }
  }

  private applyTuneSelection(offer: TaskWraithControlModelOffer | undefined): void {
    if (!offer || offer.disabled) {
      this.setNotice(offer?.disabledReason || 'That model is not selectable.', 'warning', 3_000)
      this.render()
      return
    }
    const ladder = offer.reasoningEfforts
    const effort = ladder.length
      ? ladder[Math.max(0, Math.min(this.state.tuneEffortIndex, ladder.length - 1))]
      : undefined
    if (effort?.disabled) {
      this.setNotice(
        effort.disabledReason || 'That reasoning effort is not selectable.',
        'warning',
        3_000
      )
      this.render()
      return
    }
    const unchanged =
      Boolean(offer.current) && (!effort || effort.id === this.state.offers?.currentReasoningEffort)
    this.state.overlay = 'none'
    if (unchanged) {
      this.state.pendingSelection = undefined
      this.setNotice('Keeping the current model.', 'neutral', 2_000)
    } else {
      this.state.pendingSelection = {
        model: offer.id,
        ...(offer.label ? { label: offer.label } : {}),
        ...(effort ? { reasoningEffort: effort.id } : {})
      }
      this.setNotice(
        `Next send uses ${offer.label ?? offer.id}${
          effort ? ` ${this.glyphs.separator} ${effort.id}` : ''
        }`,
        'good',
        3_000
      )
    }
    this.render()
  }

  private async submit(): Promise<void> {
    const original = this.state.input
    const text = original.trim()
    if (!text) return
    if (this.state.coldStart && this.state.coldStart.kind !== 'ready') {
      this.setNotice('Complete Host setup before using the composer.', 'warning', 3_000)
      this.render()
      return
    }
    const question = this.selectedOpenQuestion()
    if (question && (this.sendingPrompt || this.mutationInFlight)) {
      this.setNotice('A Host command is already in flight.', 'warning', 2_000)
      this.render()
      return
    }
    if (text.startsWith('/')) {
      this.state.input = ''
      this.state.inputCursor = 0
      if (question && text.toLowerCase() === '/dismiss') {
        await this.answerProjectedQuestion(question, original, 'dismiss')
        return
      }
      await this.runCommand(text)
      return
    }
    if (question) {
      if (Array.from(text).length > HOST_QUESTION_ANSWER_MAX_CHARS) {
        this.setNotice(
          `Question answer exceeds ${HOST_QUESTION_ANSWER_MAX_CHARS.toLocaleString()} characters.`,
          'warning',
          3_000
        )
        this.render()
        return
      }
      this.state.input = ''
      this.state.inputCursor = 0
      this.state.scrollOffset = 0
      await this.answerProjectedQuestion(question, original, 'answer', text)
      return
    }
    if (this.sendingPrompt && !this.state.selectedThreadId) {
      this.setNotice('The previous prompt is still being accepted.', 'warning', 2_000)
      this.render()
      return
    }
    let threadId = this.state.selectedThreadId
    if (!threadId && this.client) {
      this.sendingPrompt = true
      try {
        threadId = await this.prepareDefaultThreadForPrompt(original)
      } finally {
        this.sendingPrompt = false
      }
      if (!threadId) return
      if (this.state.input !== original) {
        this.sendingPrompt = false
        this.setNotice(
          'Draft changed while the thread was prepared · press Enter to send.',
          'neutral'
        )
        this.render()
        return
      }
    }
    if (!threadId) {
      this.setNotice('Choose a thread with Ctrl+K before sending.', 'warning', 3_000)
      this.render()
      return
    }
    this.state.input = ''
    this.state.inputCursor = 0
    this.state.scrollOffset = 0
    if (!this.client) {
      this.sendDemoPrompt(text)
      return
    }
    const selection = this.state.pendingSelection
    const liveWork = this.enqueuePromptDraft(threadId, text, selection)
    this.state.pendingSelection = undefined
    this.restoreBlockedDraftIfSafe()
    const depth = queuedDraftsForThread(this.state, threadId).length
    this.setNotice(
      liveWork.length > 0 || this.queueDrainActive || this.mutationInFlight
        ? `Queued ${depth} draft${depth === 1 ? '' : 's'} · Esc steers with the oldest`
        : 'Sending queued draft',
      'neutral',
      2_500
    )
    this.scheduleQueuedDraftDrain()
    this.render()
  }

  private async prepareDefaultThreadForPrompt(original: string): Promise<string | undefined> {
    if (!this.client || !this.client.connected) {
      this.setNotice('TaskWraith Host is not connected.', 'warning', 3_000)
      this.render()
      return undefined
    }
    if (
      !this.client.supports('commands') ||
      !this.client.supports('setup') ||
      !this.client.supports('provider-catalog')
    ) {
      this.setNotice(
        'This Host cannot prepare a fresh default thread · choose one with Ctrl+K.',
        'warning',
        4_000
      )
      this.render()
      return undefined
    }
    const actor = this.actorIdentity()
    if (!actor) return undefined
    let workspaceId = this.resolveWorkspaceId()
    if (!workspaceId) {
      await this.startNewSoloThread()
      return undefined
    }

    let recoveredCreatedThreadId: string | undefined
    const unresolved = this.unresolvedLazySetupCommand
    if (unresolved) {
      let recovered: HostCommandReceipt | undefined
      try {
        recovered = await this.client.lookupReceipt({ commandId: unresolved.commandId })
      } catch {
        recovered = undefined
      }
      if (!recovered || !isTerminalHostReceiptStatus(recovered.status)) {
        this.setNotice('The first prompt setup is still being recovered from the Host.', 'warning')
        this.render()
        return undefined
      }
      this.unresolvedLazySetupCommand = undefined
      if (recovered.status === 'succeeded' && unresolved.name === 'thread.configure') {
        const recoveredThreadId = unresolved.target.threadId
        this.state.homeContinuationThreadId = recoveredThreadId
        await this.refreshHostSnapshot()
        this.applyLocalThread(recoveredThreadId, { previewNotice: true })
        await this.loadThreadHistory(recoveredThreadId)
        const recoveredWorkspaceId = this.state.thread?.thread.workspaceId
        if (recoveredWorkspaceId) this.rememberWorkspaceId(recoveredWorkspaceId)
        const providerId = unresolved.arguments.providerId
        const modelId = unresolved.arguments.modelId
        const reasoningId = unresolved.arguments.reasoningId
        if (typeof providerId === 'string' && typeof modelId === 'string') {
          this.rememberProfileSettings({
            providerId,
            modelId,
            ...(typeof reasoningId === 'string' ? { reasoningId } : { reasoningId: undefined })
          })
        }
        return recoveredThreadId
      }
      if (
        recovered.status === 'succeeded' &&
        unresolved.name === 'thread.create' &&
        recovered.resultRef?.kind === 'thread'
      ) {
        recoveredCreatedThreadId = recovered.resultRef.threadId
        if (typeof unresolved.arguments.workspaceId === 'string') {
          workspaceId = unresolved.arguments.workspaceId
        }
      }
    }

    let status: HostProviderStatusProjection | undefined
    try {
      status = resolveStartupProvider(
        await this.client.getProviderStatuses(),
        this.profileSettings.providerId
      )
    } catch {
      status = undefined
    }
    if (!status) {
      await this.startNewSoloThread(this.profileSettings.providerId)
      return undefined
    }

    let offers: HostProviderOffersProjection
    try {
      offers = this.effectiveProviderOffers(await this.client.getProviderOffers(status.providerId))
    } catch {
      await this.startNewSoloThread(status.providerId)
      return undefined
    }
    const savedForProvider = this.profileSettings.providerId === status.providerId
    const model = resolveStartupModel(
      offers,
      savedForProvider ? this.profileSettings.modelId : undefined
    )
    const posture = resolveStartupPosture(offers)
    const reasoning = resolveStartupReasoning(
      model,
      savedForProvider ? this.profileSettings.reasoningId : undefined
    )
    if (!model || !posture) {
      await this.startNewSoloThread(status.providerId)
      return undefined
    }

    let createdThreadId = recoveredCreatedThreadId
    if (!createdThreadId) {
      const createCommand = buildThreadCreateCommand({
        actor,
        scope: 'workspace',
        workspaceId
      })
      this.unresolvedLazySetupCommand = createCommand
      await this.runHostMutation(createCommand, {
        composerRestore: original,
        onTerminalReceipt: () => {
          this.unresolvedLazySetupCommand = undefined
        },
        onSucceeded: (receipt) => {
          createdThreadId =
            receipt.resultRef?.kind === 'thread' ? receipt.resultRef.threadId : undefined
        }
      })
    }
    if (!createdThreadId) return undefined
    const newThreadId = createdThreadId

    const selection = {
      threadId: newThreadId,
      providerId: status.providerId,
      modelId: model.modelId,
      postureId: posture.postureId,
      offerRevision: offers.offerRevision,
      ...(reasoning ? { reasoningId: reasoning.reasoningId } : {})
    }
    let configured = false
    const configureCommand = this.authorizeConfigureCommand(
      buildThreadConfigureCommand({ actor, selection })
    )
    this.unresolvedLazySetupCommand = configureCommand
    await this.runHostMutation(configureCommand, {
      composerRestore: original,
      onTerminalReceipt: () => {
        this.unresolvedLazySetupCommand = undefined
      },
      onSucceeded: async () => {
        configured = true
        this.state.homeContinuationThreadId = newThreadId
        await this.refreshHostSnapshot()
        this.applyLocalThread(newThreadId, { previewNotice: true })
        await this.loadThreadHistory(newThreadId)
      }
    })
    if (!configured) {
      let refreshedStatus: HostProviderStatusProjection | undefined
      let refreshedOffers: HostProviderOffersProjection | undefined
      try {
        refreshedStatus = (await this.client.getProviderStatuses()).find(
          (candidate) => candidate.providerId === status.providerId && candidate.status === 'ready'
        )
        if (refreshedStatus) {
          refreshedOffers = this.effectiveProviderOffers(
            await this.client.getProviderOffers(refreshedStatus.providerId)
          )
        }
      } catch {
        refreshedStatus = undefined
        refreshedOffers = undefined
      }
      if (!refreshedStatus || !refreshedOffers) {
        this.setNotice(
          'Could not refresh current Host defaults · the first draft is still in the composer.',
          'warning'
        )
        this.render()
        return undefined
      }
      const selectedProvider = coldStartSelectProvider(
        coldStartWorkspaceRegistered(workspaceId),
        refreshedStatus
      )
      const withOffers = coldStartOffers(selectedProvider, refreshedOffers)
      this.state.coldStart = coldStartConfigure(coldStartThreadCreated(withOffers, newThreadId))
      this.state.coldStartIntent = 'new-thread'
      this.state.overlay = 'setup'
      this.resetColdStartConfigureIndices()
      this.setNotice('Host defaults changed · review the current setup choices.', 'warning')
      this.render()
      return undefined
    }

    this.rememberWorkspaceId(workspaceId)
    this.rememberProfileSettings({
      providerId: status.providerId,
      modelId: model.modelId,
      ...(reasoning ? { reasoningId: reasoning.reasoningId } : { reasoningId: undefined })
    })
    return newThreadId
  }

  private restoreComposerText(value: string): void {
    if (this.state.input) return
    this.state.input = value
    this.state.inputCursor = Array.from(value).length
  }

  private async runCommand(raw: string): Promise<void> {
    const parsed = parseLeadingTuiSlashToken(raw)
    const resolved = resolveTuiSlashCommand(raw)
    const arguments_ = [...(parsed?.arguments ?? [])]
    const command = resolved?.command.name ?? parsed?.normalizedToken ?? '/'
    if (command === '/quit' || command === '/q') {
      this.stop()
      return
    }
    if (command === '/context') {
      this.toggleOverlay('context')
      return
    }
    if (command === '/threads') {
      this.toggleOverlay('threads')
      return
    }
    if (command === '/workspace' || command === '/ws') {
      // Re-join on spaces: workspace paths routinely contain them, and the
      // dispatcher split the raw line on whitespace before we ever saw it.
      const path = parsed?.argumentText ?? arguments_.join(' ').trim()
      if (!path) {
        this.toggleOverlay('workspaces')
        return
      }
      await this.registerWorkspace(path)
      return
    }
    if (command === '/theme') {
      const requested = parsed?.argumentText ?? arguments_.join(' ').trim()
      if (!requested) {
        this.toggleOverlay('theme')
        return
      }
      this.applyTheme(requested, { persist: true })
      return
    }
    if (command === '/missions') {
      this.toggleMissionOverlay('active')
      return
    }
    if (command === '/history') {
      this.toggleMissionOverlay('history')
      return
    }
    if (command === '/help') {
      this.commandPaletteAutomatic = false
      this.state.commandPaletteQuery = ''
      this.toggleOverlay('help')
      return
    }
    if (command === '/cancel') {
      await this.cancelRun()
      return
    }
    if (command === '/goal') {
      this.toggleOverlay('goal')
      return
    }
    if (command === '/archive') {
      await this.archiveOpenThread()
      return
    }
    if (command === '/dismiss') {
      // A pending question is intercepted before the dispatcher, so reaching
      // here means there is nothing to dismiss. /help advertises the command,
      // and answering an advertised command with "Unknown command" reads as a
      // broken CLI rather than an empty queue.
      this.setNotice('Nothing to dismiss - no Host question is pending.', 'neutral', 3_000)
      this.render()
      return
    }
    if (command === '/clear') {
      this.state.scrollOffset = 0
      this.setNotice('Scrollback reset for this TUI session.', 'neutral', 2_000)
      this.render()
      return
    }
    if (command === '/status') {
      this.showStatus()
      return
    }
    if (command === '/login') {
      if (arguments_.length > 1) {
        this.setNotice('/login expects at most one provider id.', 'warning', 3_000)
        this.render()
        return
      }
      await this.openProviderLoginHub(arguments_[0])
      return
    }
    if (command === '/new' || command === '/provider') {
      if (arguments_.length > 1) {
        this.setNotice(
          `${command} expects at most one provider id, not "${arguments_.join(' ')}".`,
          'warning',
          3_000
        )
        this.render()
        return
      }
      await this.startNewSoloThread(arguments_[0])
      return
    }
    if (command === '/model' || command === '/m') {
      if (!arguments_.length) {
        this.toggleTuneOverlay()
        return
      }
      if (arguments_.length !== 1) {
        this.setNotice('/model expects one offered model id.', 'warning', 3_000)
        this.render()
        return
      }
      await this.stageModel(arguments_[0])
      return
    }
    if (command === '/think' || command === '/reasoning') {
      if (arguments_.length > 1) {
        this.setNotice(
          `/think expects one offered level, not "${arguments_.join(' ')}".`,
          'warning',
          3_000
        )
        this.render()
        return
      }
      await this.stageReasoning(arguments_[0])
      return
    }
    if (command === '/tune') {
      this.toggleTuneOverlay()
      return
    }
    if (command === '/seats') {
      if (arguments_.length) {
        this.setNotice('/seats takes no arguments.', 'warning', 3_000)
        this.render()
        return
      }
      await this.openSeatsOverlay()
      return
    }
    if (command === '/git') {
      await this.runGitCommand(arguments_)
      return
    }
    this.setNotice(`Unknown command: ${raw}`, 'warning', 3_000)
    this.render()
  }

  /**
   * `/git [status|diff|log] [path]` — a capability-gated workspace-git READ.
   * `available: false` is a first-class calm state (a Host without git is a
   * normal configuration), and a Host-truncated result is bannered by the
   * renderer, never presented as complete. Interactive only: demo mode shows
   * a notice and never fabricates git data.
   */
  private async runGitCommand(arguments_: string[]): Promise<void> {
    const scopeArgument = arguments_[0]?.toLowerCase()
    let scope: 'status' | 'diff' | 'log'
    if (scopeArgument === undefined) {
      scope = this.state.git?.scope ?? 'status'
    } else if (scopeArgument === 'status' || scopeArgument === 'diff' || scopeArgument === 'log') {
      scope = scopeArgument
    } else {
      this.setNotice(
        `/git expects status, diff, or log — not "${arguments_.join(' ')}".`,
        'warning',
        3_000
      )
      this.render()
      return
    }
    await this.openGitOverlay(scope, arguments_[1])
  }

  private async openGitOverlay(scope: 'status' | 'diff' | 'log', path?: string): Promise<void> {
    this.state.overlay = 'git'
    this.state.git = { scope, ...(path ? { path } : {}), loading: true }
    this.render()
    await this.loadGitRead(scope, path)
  }

  private async loadGitRead(scope: 'status' | 'diff' | 'log', path?: string): Promise<void> {
    if (!this.client) return // demo mode: the renderer shows the notice.
    const threadId = this.state.selectedThreadId
    const threadWorkspaceId =
      this.state.thread?.thread.workspaceId ??
      this.state.snapshot?.threads.find((thread) => thread.id === threadId)?.workspaceId
    if (!threadId || !threadWorkspaceId) {
      this.state.git = {
        scope,
        ...(path ? { path } : {}),
        error: 'Open a thread in a workspace to read its git state.'
      }
      this.render()
      return
    }
    const generation = ++this.gitReadGeneration
    try {
      const outcome = await this.client.getWorkspaceGitRead({
        workspaceId: threadWorkspaceId,
        scope,
        ...(path ? { path } : {})
      })
      if (!this.gitReadIsCurrent(generation, scope, threadId, threadWorkspaceId, path)) return
      this.state.git = { scope, ...(path ? { path } : {}), outcome }
      this.render()
    } catch (error) {
      if (!this.gitReadIsCurrent(generation, scope, threadId, threadWorkspaceId, path)) return
      this.state.git = {
        scope,
        ...(path ? { path } : {}),
        error: error instanceof Error ? error.message : String(error)
      }
      this.render()
    }
  }

  /**
   * Staleness guard for workspace-git reads. COVERED: a result is dropped
   * unless it is still the newest dispatch (monotonic generation) AND its
   * thread, workspace, scope, and path all still match the overlay's current
   * request — an older answer can never land under a newer header, including
   * another repository's diff after a thread switch, a path change on the
   * same scope, or an out-of-order refresh. NOT covered, by design (decision
   * 5 — no watcher): a workspace rebound while the overlay sits open with no
   * new dispatch stays stale until the overlay is reopened or refreshed (r);
   * and a thread switch closes the overlay entirely (openThread), which this
   * guard also double-checks.
   */
  private gitReadIsCurrent(
    generation: number,
    scope: 'status' | 'diff' | 'log',
    threadId: string,
    workspaceId: string,
    path?: string
  ): boolean {
    return (
      generation === this.gitReadGeneration &&
      this.state.overlay === 'git' &&
      this.state.git?.scope === scope &&
      this.state.selectedThreadId === threadId &&
      (this.state.thread?.thread.workspaceId ??
        this.state.snapshot?.threads.find((thread) => thread.id === this.state.selectedThreadId)
          ?.workspaceId) === workspaceId &&
      (this.state.git?.path ?? undefined) === path
    )
  }

  private handleGitKey(key: Keypress): void {
    const git = this.state.git
    if (!git) return
    if (key.name === 'r') {
      this.state.git = { ...git, loading: true }
      this.render()
      void this.loadGitRead(git.scope, git.path)
      return
    }
    const scope =
      key.name === 's'
        ? ('status' as const)
        : key.name === 'd'
          ? ('diff' as const)
          : key.name === 'l'
            ? ('log' as const)
            : null
    if (scope === null || scope === git.scope) return
    this.state.git = { scope, loading: true }
    this.render()
    void this.loadGitRead(scope)
  }

  /**
   * `/seats` — the ensemble seat lens: a capability-gated roster read plus
   * seat toggles through `ensemble.seat.toggle`. A Host without the
   * 'ensemble' capability is a first-class calm state, exactly like /git's
   * git-less Host — never an error. The roster always renders from the
   * coherent projection; round execution stays desktop-only and the
   * renderer says so. Interactive only: demo mode shows a notice and never
   * fabricates a roster.
   */
  private async openSeatsOverlay(): Promise<void> {
    this.state.overlay = 'seats'
    this.state.overlayIndex = 0
    const threadId = this.state.selectedThreadId
    this.state.seats = threadId ? { threadId, loading: true } : undefined
    this.render()
    await this.loadSeatsRoster()
  }

  private async loadSeatsRoster(): Promise<void> {
    if (!this.client) return // demo mode: the renderer shows the notice.
    const threadId = this.state.seats?.threadId
    if (!threadId) return
    if (!this.client.welcome?.capabilities.includes('ensemble')) {
      this.state.seats = {
        threadId,
        unavailable: 'seat control is unavailable on this Host'
      }
      this.render()
      return
    }
    const generation = ++this.seatsReadGeneration
    try {
      // The roster has no dedicated read: it rides the coherent snapshot.
      await this.refreshHostSnapshot()
      if (!this.seatsReadIsCurrent(generation, threadId)) return
      this.state.seats = { threadId }
      this.render()
    } catch (error) {
      if (!this.seatsReadIsCurrent(generation, threadId)) return
      this.state.seats = {
        threadId,
        error: error instanceof Error ? error.message : String(error)
      }
      this.render()
    }
  }

  /**
   * Staleness guard for seat-lens reads and toggle outcomes. COVERED: a
   * roster read or toggle outcome lands only if it is still the newest
   * dispatch (monotonic generation) AND the lens is still open on the same
   * selected thread — a late answer after a thread switch can never repoint
   * the lens at another thread's roster, even transiently, which would
   * invite toggling the WRONG participant (the Host would faithfully obey a
   * well-formed command). openThread/applyLocalThread close the lens and
   * clear this state on a switch; the overlay and selectedThreadId checks
   * here are the double-check. NOT covered, by design (decision 5 — no
   * watcher): the roster renders from the coherent projection, so a thread
   * rebound with no new read keeps showing the last projected roster until
   * the lens is reopened or refreshed (r); live deltas update it freely.
   */
  private seatsReadIsCurrent(generation: number, threadId: string): boolean {
    return (
      generation === this.seatsReadGeneration &&
      this.state.overlay === 'seats' &&
      this.state.seats?.threadId === threadId &&
      this.state.selectedThreadId === threadId
    )
  }

  private handleSeatsKey(key: Keypress): void {
    const seats = this.state.seats
    if (!seats) return
    if (key.name === 'r') {
      this.state.seats = { threadId: seats.threadId, loading: true }
      this.render()
      void this.loadSeatsRoster()
      return
    }
    const roster = tuiSeatsRoster(this.state)
    if (key.name === 'up') {
      this.state.overlayIndex = Math.max(0, this.state.overlayIndex - 1)
      this.render()
      return
    }
    if (key.name === 'down') {
      this.state.overlayIndex = Math.min(
        Math.max(0, roster.length - 1),
        this.state.overlayIndex + 1
      )
      this.render()
      return
    }
    if (key.name === 'return' || key.name === 'enter' || key.name === 'space') {
      this.toggleSelectedSeat()
      return
    }
  }

  /**
   * Toggle the highlighted seat. The Host is the authority: the toggle is
   * ATTEMPTED and the Host's typed refusal rendered in plain language
   * (last-seat, active-round, …), never pre-empted by a client-side mirror
   * that could drift from the server's rules. The row never flips
   * optimistically — a succeeded toggle re-reads the authoritative snapshot
   * and the lens renders what the Host actually holds.
   */
  private toggleSelectedSeat(): void {
    const seats = this.state.seats
    if (!seats || seats.loading || seats.unavailable || seats.error) return
    const threadId = seats.threadId
    if (this.state.selectedThreadId !== threadId) return
    const roster = tuiSeatsRoster(this.state)
    const participant = roster[Math.min(this.state.overlayIndex, roster.length - 1)]
    if (!participant) return
    const command = this.buildMutation(
      'ensemble.seat.toggle',
      { threadId },
      {
        participantId: participant.id,
        enabled: !participant.enabled
      }
    )
    if (!command) return
    const generation = this.seatsReadGeneration
    void this.runHostMutation(command, {
      onTerminalReceipt: (receipt) => {
        if (receipt.status === 'succeeded') return
        if (!this.seatsReadIsCurrent(generation, threadId)) return
        this.state.seats = { threadId, actionError: describeSeatToggleRefusal(receipt) }
      },
      onSucceeded: async () => {
        await this.refreshHostSnapshot()
        if (!this.seatsReadIsCurrent(generation, threadId)) return
        this.state.seats = { threadId }
        this.render()
      }
    })
  }

  private async commandOffers(): Promise<TaskWraithControlThreadOffers | undefined> {
    const threadId = this.state.selectedThreadId
    if (!threadId) {
      this.setNotice('Open a thread before choosing a model or reasoning level.', 'warning', 3_000)
      this.render()
      return undefined
    }
    await this.loadOffers()
    const offers = this.state.offers
    if (!offers || offers.threadId !== threadId) return undefined
    if (offers.locked) {
      this.setNotice(offers.locked, 'warning', 3_000)
      this.render()
      return undefined
    }
    if (!offers.models.length) {
      this.setNotice(
        'The Host returned no selectable model offers for this thread.',
        'warning',
        3_000
      )
      this.render()
      return undefined
    }
    return offers
  }

  private async stageModel(modelId: string): Promise<void> {
    if (!this.state.selectedThreadId) {
      await this.stageHomeModel(modelId)
      return
    }
    if (!this.client?.supports('provider-catalog')) {
      const offers = await this.commandOffers()
      if (!offers) return
      const modelIndex = offers.models.findIndex((model) => model.id === modelId)
      if (modelIndex < 0) {
        this.setNotice(
          `Unknown model "${modelId}". Offered: ${offers.models.map((model) => model.id).join(', ')}`,
          'warning',
          4_000
        )
        this.render()
        return
      }
      this.state.overlayIndex = modelIndex
      this.state.tuneEffortIndex = this.effortIndexFor(offers, modelIndex)
      this.applyTuneSelection(offers.models[modelIndex])
      return
    }
    await this.loadHomeTuneProviders(false)
    const choices = tuiModelChoices(this.state.homeTune?.providers ?? []).filter(
      (choice) => choice.model.modelId === modelId
    )
    if (choices.length !== 1) {
      this.setNotice(
        choices.length > 1
          ? `Model "${modelId}" is offered by multiple providers · use /model to choose.`
          : `Unknown ready-provider model "${modelId}" · use /model to browse.`,
        'warning',
        4_000
      )
      this.render()
      return
    }
    await this.configureThreadModel(choices[0])
  }

  private async stageHomeModel(modelId: string): Promise<void> {
    await this.loadHomeTuneProviders(false)
    const providers = this.state.homeTune?.providers ?? []
    const choices = tuiModelChoices(providers)
    const matches = choices.filter((choice) => choice.model.modelId === modelId)
    if (matches.length !== 1) {
      this.setNotice(
        matches.length > 1
          ? `Model "${modelId}" is offered by multiple providers · use /model to choose.`
          : `Unknown ready-provider model "${modelId}" · use /model to browse.`,
        'warning',
        4_000
      )
      this.render()
      return
    }
    const { provider, model, providerIndex } = matches[0]
    const savedReasoning =
      this.profileSettings.providerId === provider.status.providerId &&
      this.profileSettings.modelId === model.modelId
        ? resolveStartupReasoning(model, this.profileSettings.reasoningId)
        : undefined
    const persisted = this.rememberProfileSettings({
      providerId: provider.status.providerId,
      modelId: model.modelId,
      ...(savedReasoning ? { reasoningId: savedReasoning.reasoningId } : { reasoningId: undefined })
    })
    const modelIndex = choices.findIndex(
      (choice) =>
        choice.provider.status.providerId === provider.status.providerId &&
        choice.model.modelId === model.modelId
    )
    const reasoning = model.reasoning.filter((candidate) => candidate.available)
    this.state.homeTune = {
      ...this.state.homeTune!,
      providerIndex: Math.max(0, providerIndex),
      modelIndex: Math.max(0, modelIndex),
      reasoningIndex: savedReasoning
        ? reasoning.findIndex((candidate) => candidate.reasoningId === savedReasoning.reasoningId)
        : -1
    }
    this.setNotice(
      `${persisted ? 'Default' : 'Session default'} · ${provider.status.label} / ${model.label}`,
      persisted ? 'good' : 'warning',
      4_000
    )
    this.render()
  }

  private async stageReasoning(level?: string): Promise<void> {
    const offers = await this.commandOffers()
    if (!offers) return
    const stagedModel = this.state.pendingSelection?.model
    const modelIndex = stagedModel
      ? offers.models.findIndex((model) => model.id === stagedModel)
      : offers.models.findIndex((model) => model.current)
    const selectedIndex = modelIndex >= 0 ? modelIndex : 0
    const model = offers.models[selectedIndex]
    if (!model) return
    const ladder = model.reasoningEfforts
    if (!level) {
      const current =
        this.state.pendingSelection?.model === model.id
          ? this.state.pendingSelection.reasoningEffort
          : (offers.currentReasoningEffort ?? model.defaultReasoningEffort)
      this.setNotice(
        `Reasoning for ${model.label ?? model.id}: ${current ?? 'not set'} ${this.glyphs.separator} offered: ${
          ladder.map((effort) => effort.id).join(', ') || 'none'
        }`,
        'neutral',
        4_000
      )
      this.render()
      return
    }
    const effortIndex = ladder.findIndex((effort) => effort.id === level)
    if (effortIndex < 0) {
      this.setNotice(
        `Unknown reasoning level "${level}" for ${model.label ?? model.id}. Offered: ${
          ladder.map((effort) => effort.id).join(', ') || 'none'
        }`,
        'warning',
        4_000
      )
      this.render()
      return
    }
    this.state.overlayIndex = selectedIndex
    this.state.tuneEffortIndex = effortIndex
    this.applyTuneSelection(model)
  }

  private async openProviderLoginHub(requestedProviderId?: string): Promise<void> {
    if (!this.client?.connected) {
      this.setNotice('TaskWraith Host is not connected.', 'warning', 3_000)
      this.render()
      return
    }
    if (!this.client.supports('provider-catalog')) {
      this.setNotice('Provider setup is unavailable on this Host.', 'warning', 3_000)
      this.render()
      return
    }
    const generation = ++this.providerLoginReadGeneration
    this.state.overlay = 'login'
    this.state.providerLogin = { providers: [], flows: [], flowIndex: 0, loading: true }
    this.render()
    try {
      const providers = [...(await this.client.getProviderStatuses())]
      if (generation !== this.providerLoginReadGeneration || this.state.overlay !== 'login') return
      const preferred = requestedProviderId
        ? matchProviderStatus(providers, requestedProviderId)
        : (providers.find((provider) => provider.providerId === this.profileSettings.providerId) ??
          providers[0])
      if (requestedProviderId && !preferred) {
        this.state.providerLogin = {
          providers,
          flows: [],
          flowIndex: 0,
          error: `Unknown or ambiguous provider "${requestedProviderId}".`
        }
        this.render()
        return
      }
      this.state.providerLogin = {
        providers,
        selectedProviderId: preferred?.providerId,
        flows: [],
        flowIndex: 0
      }
      if (preferred) await this.loadProviderLoginSelection(preferred.providerId)
    } catch (error) {
      if (generation !== this.providerLoginReadGeneration) return
      this.state.providerLogin = {
        providers: [],
        flows: [],
        flowIndex: 0,
        error: error instanceof Error ? error.message : String(error)
      }
    }
    this.render()
  }

  private async loadProviderLoginSelection(providerId: string): Promise<void> {
    if (!this.client?.connected || !this.state.providerLogin) return
    const generation = ++this.providerLoginReadGeneration
    this.state.providerLogin = {
      ...this.state.providerLogin,
      selectedProviderId: providerId,
      flows: [],
      flowIndex: 0,
      loading: true,
      error: undefined
    }
    this.render()
    try {
      const authStatus = this.client.supports('provider-auth')
        ? await this.client.getProviderAuthStatus(providerId)
        : undefined
      const flows =
        authStatus?.state === 'unauthenticated' && this.client.supports('provider-auth')
          ? [...(await this.client.getProviderAuthFlows(providerId))].filter(
              (flow) => flow.available
            )
          : []
      if (
        generation !== this.providerLoginReadGeneration ||
        this.state.overlay !== 'login' ||
        this.state.providerLogin?.selectedProviderId !== providerId
      ) {
        return
      }
      this.state.providerLogin = {
        ...this.state.providerLogin,
        authStatus,
        flows,
        flowIndex: 0,
        loading: false,
        operationId:
          authStatus?.state === 'authenticated' ? undefined : this.state.providerLogin.operationId
      }
    } catch (error) {
      if (generation !== this.providerLoginReadGeneration) return
      this.state.providerLogin = {
        ...this.state.providerLogin,
        flows: [],
        flowIndex: 0,
        loading: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
    this.render()
  }

  private async handleProviderLoginKey(key: Keypress): Promise<void> {
    const login = this.state.providerLogin
    if (!login || login.loading) return
    const selectedIndex = Math.max(
      0,
      login.providers.findIndex((provider) => provider.providerId === login.selectedProviderId)
    )
    if (key.name === 'up' || key.name === 'down') {
      const nextIndex = cycleIndex(
        selectedIndex,
        login.providers.length,
        key.name === 'up' ? -1 : 1
      )
      const provider = login.providers[nextIndex]
      if (provider) await this.loadProviderLoginSelection(provider.providerId)
      return
    }
    if (key.name === 'tab' && login.flows.length > 1) {
      this.state.providerLogin = {
        ...login,
        flowIndex: cycleIndex(login.flowIndex, login.flows.length, key.shift ? -1 : 1)
      }
      this.render()
      return
    }
    if (key.name === 'r') {
      await this.openProviderLoginHub(login.selectedProviderId)
      return
    }
    if (key.name !== 'return' && key.name !== 'enter') return
    if (login.pending || login.operationId) {
      if (login.selectedProviderId) await this.loadProviderLoginSelection(login.selectedProviderId)
      return
    }
    const flow = login.flows[login.flowIndex]
    if (!flow || !login.selectedProviderId) {
      await this.loadProviderLoginSelection(login.selectedProviderId ?? '')
      return
    }
    const actor = this.actorIdentity()
    if (!actor) return
    const command = buildProviderAuthBeginCommand({
      actor,
      providerId: login.selectedProviderId,
      flowId: flow.flowId
    })
    this.state.providerLogin = { ...login, pending: this.pendingFrom(command) }
    const receipt = await this.runHostMutation(command)
    if (!this.state.providerLogin) return
    if (receipt?.status === 'succeeded' && receipt.resultRef?.kind === 'provider-auth') {
      this.state.providerLogin = {
        ...this.state.providerLogin,
        pending: undefined,
        operationId: receipt.resultRef.operationId
      }
      this.setNotice('Provider setup opened · complete it, then press r to refresh.', 'neutral')
      await this.loadProviderLoginSelection(login.selectedProviderId)
    } else if (receipt && isTerminalHostReceiptStatus(receipt.status)) {
      this.state.providerLogin = { ...this.state.providerLogin, pending: undefined }
    }
    this.render()
  }

  private async resumeProviderLoginPending(): Promise<void> {
    const pending = this.state.providerLogin?.pending
    if (!pending || !this.client?.connected) return
    try {
      const receipt = await this.client.lookupReceipt({ commandId: pending.commandId })
      if (!this.state.providerLogin) return
      if (receipt.status === 'succeeded' && receipt.resultRef?.kind === 'provider-auth') {
        this.state.providerLogin = {
          ...this.state.providerLogin,
          pending: undefined,
          operationId: receipt.resultRef.operationId
        }
      } else if (isTerminalHostReceiptStatus(receipt.status)) {
        this.state.providerLogin = { ...this.state.providerLogin, pending: undefined }
      }
    } catch {
      // Retain exact pending identity. Provider auth begin is never replayed automatically.
    }
  }

  private async startNewSoloThread(requestedProviderId?: string): Promise<void> {
    if (!this.client) {
      this.setNotice('Demo mode cannot create Host threads.', 'warning', 3_000)
      this.render()
      return
    }
    if (!this.client.supports('commands')) {
      this.setNotice('Connected Host does not advertise thread creation.', 'warning', 3_000)
      this.render()
      return
    }
    const actor = this.actorIdentity()
    if (!actor) {
      this.setNotice('TaskWraith Host is not connected.', 'warning', 3_000)
      this.render()
      return
    }
    const canGuide = this.client.supports('setup') && this.client.supports('provider-catalog')
    if (!canGuide) {
      if (requestedProviderId) {
        this.setNotice(
          'Connected Host does not advertise provider setup. Use /new without a provider id.',
          'warning',
          4_000
        )
        this.retainHomeForNextThread = false
        this.render()
        return
      }
      if (!this.state.selectedThreadId) this.retainHomeForNextThread = true
      await this.createSoloThread()
      return
    }
    if (this.state.coldStartIntent === 'required' && this.state.coldStart?.kind !== 'ready') {
      this.state.overlay = 'setup'
      this.retainHomeForNextThread = false
      this.setNotice('Finish Host setup, then /new starts another solo thread.', 'warning', 3_000)
      this.render()
      return
    }
    if (!this.state.selectedThreadId) this.retainHomeForNextThread = true
    const workspaceId = this.resolveWorkspaceId()
    this.state.coldStart = workspaceId ? coldStartWorkspaceRegistered(workspaceId) : coldStartIdle()
    this.state.coldStartIntent = this.state.thread || workspaceId ? 'new-thread' : 'required'
    this.state.overlay = 'setup'
    this.state.coldStartProviderChoices = undefined
    this.state.coldStartProviderIndex = 0
    this.state.coldStartAuthFlowIndex = 0
    this.resetColdStartConfigureIndices()
    if (this.state.coldStart.kind === 'workspace') {
      await this.loadColdStartProviders()
      if (requestedProviderId) {
        const match = this.matchColdStartProvider(requestedProviderId)
        if (!match) {
          this.setNotice(
            `Unknown provider "${requestedProviderId}". Use ↑/↓ to choose, then Enter.`,
            'warning',
            4_000
          )
          this.retainHomeForNextThread = false
          this.render()
          return
        }
        await this.confirmColdStartProvider(match)
        this.render()
        return
      }
      this.setNotice('Use ↑/↓ to choose a provider, then Enter. Esc cancels.', 'neutral')
    }
    this.render()
  }

  private cancelNewSoloThread(): void {
    this.retainHomeForNextThread = false
    this.state.coldStart = undefined
    this.state.coldStartIntent = undefined
    this.state.coldStartProviderChoices = undefined
    this.state.coldStartProviderIndex = 0
    this.state.coldStartAuthFlowIndex = 0
    this.resetColdStartConfigureIndices()
    this.state.overlay = 'none'
    this.setNotice('New thread cancelled.', 'neutral', 2_000)
    this.render()
  }

  private async loadColdStartProviders(): Promise<void> {
    if (!this.client) return
    this.state.coldStartProviderChoices = (await this.client.getProviderStatuses()).filter(
      (candidate) => candidate.status === 'ready' || candidate.status === 'auth_required'
    )
    const preferred =
      resolveStartupProvider(
        this.state.coldStartProviderChoices,
        this.profileSettings.providerId
      ) ??
      this.state.coldStartProviderChoices.find(
        (candidate) => candidate.providerId === this.profileSettings.providerId
      )
    this.state.coldStartProviderIndex = Math.max(
      0,
      preferred
        ? this.state.coldStartProviderChoices.findIndex(
            (candidate) => candidate.providerId === preferred.providerId
          )
        : 0
    )
  }

  private matchColdStartProvider(requested: string) {
    const needle = requested.trim().toLowerCase()
    const choices = this.state.coldStartProviderChoices ?? []
    const exact = choices.filter(
      (candidate) =>
        candidate.providerId.toLowerCase() === needle || candidate.label.toLowerCase() === needle
    )
    if (exact.length === 1) return exact[0]
    const prefix = choices.filter(
      (candidate) =>
        candidate.providerId.toLowerCase().startsWith(needle) ||
        candidate.label.toLowerCase().startsWith(needle)
    )
    return prefix.length === 1 ? prefix[0] : undefined
  }

  private async confirmColdStartProvider(status: HostProviderStatusProjection): Promise<void> {
    const cold = this.state.coldStart
    if (!cold || !this.client) return
    const provider = coldStartSelectProvider(cold, status)
    this.state.coldStartProviderChoices = undefined
    this.state.coldStartProviderIndex = 0
    if (status.status === 'auth_required') {
      if (!this.client.supports('provider-auth'))
        throw new Error('Provider auth capability is unavailable.')
      const auth = await this.client.getProviderAuthStatus(status.providerId)
      this.state.coldStart =
        auth.state === 'authenticated'
          ? coldStartOffers(
              provider,
              this.effectiveProviderOffers(await this.client.getProviderOffers(status.providerId))
            )
          : coldStartAuthFlows(
              provider,
              auth,
              await this.client.getProviderAuthFlows(status.providerId)
            )
      this.state.coldStartAuthFlowIndex = 0
    } else {
      this.state.coldStart = coldStartOffers(
        provider,
        this.effectiveProviderOffers(await this.client.getProviderOffers(status.providerId))
      )
    }
    this.resetColdStartConfigureIndices()
  }

  private async createSoloThread(): Promise<void> {
    if (!this.client) {
      this.setNotice('Demo mode cannot create Host threads.', 'warning', 3_000)
      this.render()
      return
    }
    if (!this.client.supports('commands')) {
      this.setNotice('Connected Host does not advertise thread creation.', 'warning', 3_000)
      this.render()
      return
    }
    const actor = this.actorIdentity()
    if (!actor) {
      this.setNotice('TaskWraith Host is not connected.', 'warning', 3_000)
      this.render()
      return
    }
    const workspaceId = this.resolveWorkspaceId()
    const command = buildThreadCreateCommand({
      actor,
      scope: workspaceId ? 'workspace' : 'global',
      ...(workspaceId ? { workspaceId } : {})
    })
    let createdThreadId: string | undefined
    await this.runHostMutation(command, {
      onSucceeded: async (receipt) => {
        createdThreadId =
          receipt.resultRef?.kind === 'thread' ? receipt.resultRef.threadId : undefined
        await this.refreshHostSnapshot()
        if (!createdThreadId) {
          this.setNotice('Host created a thread without a thread locator.', 'warning', 4_000)
        }
      }
    })
    if (createdThreadId) {
      await this.openThread(createdThreadId, { preserveHome: this.retainHomeForNextThread })
      this.retainHomeForNextThread = false
    }
  }

  private showStatus(): void {
    const profilePath = this.options.userDataPath ?? defaultTaskWraithUserDataPath()
    const thread = this.state.thread?.thread
    const capabilities = this.client?.welcome?.capabilities.join(', ') || 'none advertised'
    const model = this.state.pendingSelection?.model ?? thread?.provider.model ?? 'none'
    const reasoning = this.state.pendingSelection?.reasoningEffort ?? thread?.reasoning ?? 'default'
    const status = [
      `Node Host ${this.state.connection}`,
      `profile ${profilePath}`,
      `socket ${taskWraithControlSocketPath(profilePath)}`,
      thread ? `${thread.provider.displayProvider} / ${model} / ${reasoning}` : 'no thread',
      `caps ${capabilities}`
    ].join(` ${this.glyphs.separator} `)
    this.setNotice(status, 'neutral', 6_000)
    this.render()
  }

  private enqueuePromptDraft(
    threadId: string,
    text: string,
    selection?: TuiPendingSelection
  ): string[] {
    const liveWork = liveThreadWorkIds(this.hostSnapshot, threadId)
    this.state.queuedDrafts = [
      ...(this.state.queuedDrafts ?? []),
      {
        id: `tui-draft-${randomUUID()}`,
        threadId,
        text,
        enqueuedAt: this.options.now(),
        phase: 'queued',
        ...(selection ? { selection: { ...selection } } : {}),
        ...(liveWork[0] ? { blockedByRunId: liveWork[0] } : {})
      }
    ]
    if (this.client?.connected && this.hostSnapshot?.freshness !== 'live') {
      this.queueFreshReadRequested = true
    }
    return liveWork
  }

  private async refreshThenHandleEscape(threadId: string, originalInput: string): Promise<void> {
    if (this.escapeRefreshInFlight) return
    this.escapeRefreshInFlight = true
    try {
      await this.refreshHostSnapshot()
      const live = liveThreadWorkIds(this.hostSnapshot, threadId)
      if (!live.length) return
      const draft = originalInput.trim()
      if (
        this.state.selectedThreadId === threadId &&
        this.state.input === originalInput &&
        draft &&
        !draft.startsWith('/') &&
        !this.selectedOpenQuestion()
      ) {
        this.enqueuePromptDraft(threadId, draft, this.state.pendingSelection)
        this.state.input = ''
        this.state.inputCursor = 0
        this.state.pendingSelection = undefined
        this.state.scrollOffset = 0
      }
      await this.cancelRun({ shortcut: true, liveWorkIds: live, targetThreadId: threadId })
    } catch (error) {
      this.retainEscapeIntent(threadId, originalInput)
      this.surfaceProjectionSyncError(error)
    } finally {
      this.escapeRefreshInFlight = false
      this.render()
    }
  }

  private retainEscapeIntent(threadId: string, originalInput: string): void {
    const draft = originalInput.trim()
    if (
      this.state.selectedThreadId === threadId &&
      this.state.input === originalInput &&
      draft &&
      !draft.startsWith('/') &&
      !this.selectedOpenQuestion()
    ) {
      this.enqueuePromptDraft(threadId, draft, this.state.pendingSelection)
      this.state.input = ''
      this.state.inputCursor = 0
      this.state.pendingSelection = undefined
      this.state.scrollOffset = 0
    }
    const projected = projectedThreadWorkIds(this.hostSnapshot, threadId)
    this.pendingEscapeCancel = projected[0] ? { threadId, liveWorkId: projected[0] } : undefined
    this.setNotice(
      projected[0]
        ? 'Steer queued · waiting for a fresh Host connection'
        : 'Draft queued · waiting for a fresh Host connection',
      'warning'
    )
    this.render()
  }

  private restoreBlockedDraftIfSafe(): void {
    const threadId = this.state.selectedThreadId
    if (!threadId || this.state.input) return
    const blocked = queuedDraftsForThread(this.state, threadId)[0]
    if (!blocked || blocked.phase !== 'blocked') return
    this.state.queuedDrafts = removeQueuedDraft(this.state.queuedDrafts, blocked.id)
    this.queuedDraftCommands.delete(blocked.id)
    this.clearQueuedDraftRetry(blocked.id)
    this.state.input = blocked.text
    this.state.inputCursor = Array.from(blocked.text).length
    this.state.pendingSelection = blocked.selection ? { ...blocked.selection } : undefined
    this.setNotice(`${blocked.error || 'Queued send was blocked'} · draft restored`, 'error', 4_500)
  }

  private projectionFence(): string {
    const snapshot = this.hostSnapshot
    return `${this.connectionEpoch}:${this.state.connection}:${snapshot?.generation ?? -1}:${snapshot?.cursor ?? -1}`
  }

  private scheduleQueuedDraftDrain(): void {
    if (this.queueDrainScheduled || this.stopped) return
    this.queueDrainScheduled = true
    queueMicrotask(() => {
      this.queueDrainScheduled = false
      void this.drainQueuedDrafts()
    })
  }

  private async refreshQueuedDraftAuthority(): Promise<void> {
    if (this.queueFreshReadInFlight || !this.client?.connected) return
    this.queueFreshReadInFlight = true
    try {
      await this.refreshHostSnapshot()
    } catch (error) {
      this.surfaceProjectionSyncError(error)
    } finally {
      this.queueFreshReadInFlight = false
      this.scheduleQueuedDraftDrain()
    }
  }

  private scheduleQueuedDraftRetry(draftId: string): void {
    if (this.queueRetryTimers.has(draftId) || this.stopped) return
    const attempt = (this.queueRetryAttempts.get(draftId) ?? 0) + 1
    this.queueRetryAttempts.set(draftId, attempt)
    const delayMs = Math.min(4_000, 250 * 2 ** Math.min(4, attempt - 1))
    const timer = setTimeout(() => {
      this.queueRetryTimers.delete(draftId)
      this.queueRetryFences.delete(draftId)
      this.queueFreshReadRequested = true
      this.scheduleQueuedDraftDrain()
    }, delayMs)
    timer.unref?.()
    this.queueRetryTimers.set(draftId, timer)
  }

  private clearQueuedDraftRetry(draftId: string): void {
    const timer = this.queueRetryTimers.get(draftId)
    if (timer) clearTimeout(timer)
    this.queueRetryTimers.delete(draftId)
    this.queueRetryAttempts.delete(draftId)
    this.queueRetryFences.delete(draftId)
  }

  private async drainQueuedDrafts(): Promise<void> {
    if (
      (this.state.queuedDrafts?.length ?? 0) > 0 &&
      this.client?.connected &&
      this.queueFreshReadRequested
    ) {
      this.queueFreshReadRequested = false
      void this.refreshQueuedDraftAuthority()
      return
    }
    if (
      this.queueDrainActive ||
      this.mutationInFlight ||
      this.selectingThread ||
      this.sendingPrompt ||
      !this.client?.connected ||
      this.hostSnapshot?.freshness !== 'live'
    ) {
      return
    }
    const fence = this.projectionFence()
    const blocked = new Set(
      [...this.queueRetryFences.entries()]
        .filter(([, blockedAt]) => blockedAt === fence)
        .map(([draftId]) => draftId)
    )
    const draft = nextDispatchableDraft(
      this.state,
      this.hostSnapshot,
      blocked,
      new Set(this.acceptedQueueRuns.keys())
    )
    if (!draft) return

    this.queueDrainActive = true
    this.state.queuedDrafts = replaceQueuedDraft(this.state.queuedDrafts, draft.id, {
      phase: 'dispatching',
      error: undefined
    })
    this.render()
    let command = this.queuedDraftCommands.get(draft.id)
    const recoveringCommand = Boolean(command)
    if (!command) {
      const args: Record<string, unknown> = { text: draft.text }
      if (draft.selection?.model) args.model = draft.selection.model
      if (draft.selection?.reasoningEffort) {
        args.reasoningEffort = draft.selection.reasoningEffort
      }
      command = this.buildMutation('composer.send', { threadId: draft.threadId }, args) ?? undefined
      if (command) this.queuedDraftCommands.set(draft.id, command)
    }

    try {
      if (!command) {
        this.state.queuedDrafts = replaceQueuedDraft(this.state.queuedDrafts, draft.id, {
          phase: 'queued'
        })
        this.queueRetryFences.set(draft.id, fence)
        this.scheduleQueuedDraftRetry(draft.id)
        return
      }
      let receipt: HostCommandReceipt | undefined
      if (recoveringCommand) {
        try {
          const recovered = await this.client.lookupReceipt({ commandId: command.commandId })
          if (isTerminalHostReceiptStatus(recovered.status)) {
            await this.applyTerminalReceipt(recovered, {})
            receipt = recovered
          }
        } catch {
          // Receipt absence is safe: resubmit the exact same command identity below.
        }
      }
      receipt ??= await this.runHostMutation(command)
      if (receipt?.status === 'succeeded') {
        this.acceptedQueueRuns.set(draft.threadId, {
          commandId: command.commandId,
          observedLive: false
        })
        this.state.queuedDrafts = removeQueuedDraft(this.state.queuedDrafts, draft.id)
        this.queuedDraftCommands.delete(draft.id)
        this.clearQueuedDraftRetry(draft.id)
        try {
          await this.refreshHostSnapshot()
        } catch (error) {
          this.surfaceProjectionSyncError(error)
        }
      } else if (receipt && isTerminalHostReceiptStatus(receipt.status)) {
        const description = describeHostReceipt(receipt)
        if (this.state.selectedThreadId === draft.threadId && !this.state.input) {
          this.state.queuedDrafts = removeQueuedDraft(this.state.queuedDrafts, draft.id)
          this.queuedDraftCommands.delete(draft.id)
          this.clearQueuedDraftRetry(draft.id)
          this.state.input = draft.text
          this.state.inputCursor = Array.from(draft.text).length
          this.state.pendingSelection = draft.selection ? { ...draft.selection } : undefined
          this.setNotice(`${description.text} · draft restored`, description.tone, 4_500)
        } else {
          this.clearQueuedDraftRetry(draft.id)
          this.state.queuedDrafts = replaceQueuedDraft(this.state.queuedDrafts, draft.id, {
            phase: 'blocked',
            error: description.text
          })
        }
      } else {
        this.state.queuedDrafts = replaceQueuedDraft(this.state.queuedDrafts, draft.id, {
          phase: 'queued'
        })
        this.queueRetryFences.set(draft.id, fence)
        this.scheduleQueuedDraftRetry(draft.id)
      }
    } finally {
      this.queueDrainActive = false
      this.render()
      this.scheduleQueuedDraftDrain()
    }
  }

  private async cancelRun(
    options: {
      shortcut?: boolean
      liveWorkIds?: readonly string[]
      targetThreadId?: string
      command?: HostCommand
    } = {}
  ): Promise<void> {
    const threadId = options.targetThreadId ?? this.state.selectedThreadId
    if (!threadId) {
      this.setNotice('No selected thread to cancel.', 'warning', 3_000)
      this.render()
      return
    }
    if (!this.client) {
      if (this.state.thread) {
        this.state.thread.thread.status = 'cancelled'
        this.state.thread.thread.updatedAt = this.options.now()
      }
      this.setNotice('Demo run cancelled', 'warning', 2_000)
      this.render()
      return
    }
    if (!options.liveWorkIds && this.hostSnapshot?.freshness !== 'live') {
      try {
        await this.refreshHostSnapshot()
      } catch (error) {
        this.surfaceProjectionSyncError(error)
        this.setNotice('Could not prove the live run to cancel.', 'warning', 3_000)
        return
      }
    }
    const liveWork = [...(options.liveWorkIds ?? liveThreadWorkIds(this.hostSnapshot, threadId))]
    const targetWorkId = liveWork[0]
    if (!targetWorkId) {
      this.setNotice('No live run is available to cancel.', 'warning', 2_000)
      this.render()
      return
    }
    if (this.mutationInFlight) {
      if (options.shortcut && targetWorkId) {
        this.pendingEscapeCancel = { threadId, liveWorkId: targetWorkId }
        this.setNotice('Steer queued · cancellation follows the current Host command', 'warning')
      } else {
        this.setNotice('A Host command is already in flight.', 'warning', 2_000)
      }
      this.render()
      return
    }
    if (options.shortcut && targetWorkId && this.cancelRequestedWorkIds.has(targetWorkId)) {
      this.setNotice('Cancellation already requested · waiting for the Host', 'warning', 2_000)
      this.render()
      return
    }
    if (targetWorkId) this.cancelRequestedWorkIds.add(targetWorkId)
    const command =
      options.command ??
      this.buildMutation('run.cancel', { threadId }, { expectedWorkId: targetWorkId })
    if (!command) {
      if (targetWorkId) this.cancelRequestedWorkIds.delete(targetWorkId)
      return
    }
    if (!options.command) this.clearEscapeCancelRecovery()
    let receipt: HostCommandReceipt | undefined
    if (options.command) {
      try {
        const recovered = await this.client.lookupReceipt({ commandId: command.commandId })
        if (isTerminalHostReceiptStatus(recovered.status)) {
          await this.applyTerminalReceipt(recovered, {})
          receipt = recovered
        }
      } catch {
        // The Host may not have accepted it; exact-id resubmission is idempotent.
      }
    }
    receipt ??= await this.runHostMutation(command)
    if (receipt?.status === 'succeeded') {
      this.clearEscapeCancelRecovery()
      try {
        await this.refreshHostSnapshot()
      } catch (error) {
        this.surfaceProjectionSyncError(error)
      }
      if (options.shortcut) {
        const queued = queuedDraftsForThread(this.state, threadId).length
        this.setNotice(
          queued > 0
            ? 'Stopping current run · queued steer sends after terminal confirmation'
            : 'Stopping current run',
          'warning',
          3_000
        )
      }
    } else if (!receipt) {
      if (targetWorkId) this.cancelRequestedWorkIds.delete(targetWorkId)
      if (options.shortcut && targetWorkId) {
        this.pendingEscapeCancel = {
          threadId,
          liveWorkId: targetWorkId,
          command
        }
        this.scheduleEscapeCancelRecovery()
      }
    } else {
      if (targetWorkId) this.cancelRequestedWorkIds.delete(targetWorkId)
      this.clearEscapeCancelRecovery()
    }
    this.render()
  }

  private clearEscapeCancelRecovery(): void {
    if (this.escapeCancelRecoveryTimer) clearTimeout(this.escapeCancelRecoveryTimer)
    this.escapeCancelRecoveryTimer = null
    this.escapeCancelRecoveryAttempts = 0
  }

  /**
   * An uncertain same-socket cancel cannot wait for the periodic projection.
   * Take a bounded fresh read, then retry the retained exact command only if
   * that exact work item is still live.
   */
  private scheduleEscapeCancelRecovery(): void {
    if (
      this.stopped ||
      !this.pendingEscapeCancel?.command ||
      this.escapeCancelRecoveryTimer ||
      this.escapeCancelRecoveryInFlight ||
      this.escapeCancelRecoveryAttempts >= ESCAPE_CANCEL_MAX_RECOVERY_ATTEMPTS
    ) {
      return
    }
    const attempt = this.escapeCancelRecoveryAttempts + 1
    this.escapeCancelRecoveryAttempts = attempt
    const delayMs = Math.min(1_600, ESCAPE_CANCEL_RECOVERY_BASE_MS * 2 ** (attempt - 1))
    this.escapeCancelRecoveryTimer = setTimeout(() => {
      this.escapeCancelRecoveryTimer = null
      void this.recoverPendingEscapeCancel()
    }, delayMs)
    this.escapeCancelRecoveryTimer.unref?.()
  }

  private async recoverPendingEscapeCancel(): Promise<void> {
    if (
      this.escapeCancelRecoveryInFlight ||
      !this.pendingEscapeCancel?.command ||
      !this.client?.connected
    ) {
      return
    }
    this.escapeCancelRecoveryInFlight = true
    let refreshed = false
    try {
      await this.refreshHostSnapshot()
      refreshed = this.hostSnapshot?.freshness === 'live'
    } catch (error) {
      this.surfaceProjectionSyncError(error)
    } finally {
      this.escapeCancelRecoveryInFlight = false
    }
    if (refreshed) this.flushPendingEscapeCancel()
    else this.scheduleEscapeCancelRecovery()
  }

  private flushPendingEscapeCancel(): void {
    const pending = this.pendingEscapeCancel
    if (!pending || this.mutationInFlight) return
    if (!this.client?.connected || this.hostSnapshot?.freshness !== 'live') return
    const live = liveThreadWorkIds(this.hostSnapshot, pending.threadId)
    if (!live.includes(pending.liveWorkId)) {
      this.pendingEscapeCancel = undefined
      this.clearEscapeCancelRecovery()
      this.scheduleQueuedDraftDrain()
      return
    }
    this.pendingEscapeCancel = undefined
    void this.cancelRun({
      shortcut: true,
      targetThreadId: pending.threadId,
      liveWorkIds: [pending.liveWorkId],
      ...(pending.command ? { command: pending.command } : {})
    })
  }

  private replaceFullAccessPresence(next?: TuiFullAccessPresence): void {
    if (next === this.fullAccessPresence) return
    this.fullAccessPresence?.dispose()
    this.fullAccessPresence = next ?? null
  }

  private hasMatchingFullAccessPresence(): boolean {
    return Boolean(
      this.client?.connected &&
      this.fullAccessPresence?.matches(this.client.discoveryProcessIdentity)
    )
  }

  private effectiveProviderOffers(
    offers: HostProviderOffersProjection
  ): HostProviderOffersProjection {
    return projectTuiFullAccessPresence(offers, this.hasMatchingFullAccessPresence())
  }

  private authorizeConfigureCommand(command: HostCommand): HostCommand {
    if (command.arguments.postureId !== 'full_access') return command
    if (!this.hasMatchingFullAccessPresence() || !this.fullAccessPresence) {
      throw new Error('Full Access requires a fresh user-presence Host launch from this TUI.')
    }
    return this.fullAccessPresence.authorizeConfigure(command)
  }

  private actorIdentity(): HostActorIdentity | null {
    const welcome = this.client?.welcome
    if (!welcome) return null
    const client = welcome.authenticatedClient
    return {
      actorId: client.clientId,
      clientId: client.clientId,
      clientClass: client.clientClass
    }
  }

  private buildMutation(
    name: HostCommandName,
    target: Record<string, string>,
    args: Record<string, unknown>
  ): HostCommand | null {
    const actor = this.actorIdentity()
    if (!actor) {
      this.setNotice('TaskWraith Host is not connected.', 'warning', 3_000)
      this.render()
      return null
    }
    return buildHostCommand({
      name,
      actor,
      target,
      arguments: args,
      issuedAt: new Date(this.options.now()).toISOString()
    })
  }

  private async refreshHostSnapshot(): Promise<void> {
    if (!this.client?.connected) return
    await this.enqueueProjectionUpdate(() => this.fetchAndApplyHostSnapshot())
  }

  private async fetchAndApplyHostSnapshot(): Promise<void> {
    if (!this.client?.connected) return
    const frame = await this.client.getSnapshot()
    this.applyHostSnapshot(frame.snapshot)
  }

  private enqueueProjectionUpdate(operation: () => Promise<void>): Promise<void> {
    const run = this.projectionQueue.then(operation, operation)
    this.projectionQueue = run.catch(() => undefined)
    return run
  }

  private enqueueHistoryUpdate(operation: () => Promise<void>): Promise<void> {
    const run = this.historyQueue.then(operation, operation)
    this.historyQueue = run.catch(() => undefined)
    return run
  }

  private markHostProjectionStale(): void {
    const snapshot = this.hostSnapshot
    if (!snapshot) return
    const stale: HostSnapshot = {
      ...snapshot,
      freshness: 'stale',
      health: { ...snapshot.health, freshness: 'stale' }
    }
    this.hostSnapshot = stale
    this.state.hostProjection = stale
  }

  private surfaceProjectionSyncError(error: unknown): void {
    if (this.stopped) return
    this.markHostProjectionStale()
    this.setNotice(
      `Host projection refresh failed · ${error instanceof Error ? error.message : String(error)}`,
      'warning',
      3_000
    )
    this.render()
  }

  /**
   * Bind this mutation's approval by EXACT command identity (Wave 4.2c).
   *
   * This used to filter on `actionKind === commandName` and take the newest,
   * because the wire carried no correlation field. `actionKind` is a command
   * NAME, so with two concurrent asks of the same kind the newest-wins tie
   * break could resolve another projection's approval. Host now publishes
   * `commandId` on every approval, so the match is an identity comparison and
   * there is no tie to break.
   */
  private findPendingApprovalId(commandId: string): string | undefined {
    const approvals = this.hostSnapshot?.approvals ?? []
    return approvals.find((row) => row.status === 'pending' && row.commandId === commandId)
      ?.approvalId
  }

  private selectedPendingApproval(): HostApprovalProjection | undefined {
    const threadId = this.state.selectedThreadId
    if (!threadId) return undefined
    return [...(this.hostSnapshot?.approvals ?? [])]
      .filter((row) => row.status === 'pending' && row.threadId === threadId)
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt || left.approvalId.localeCompare(right.approvalId)
      )[0]
  }

  private selectedOpenQuestion(): HostQuestionProjection | undefined {
    const threadId = this.state.selectedThreadId
    if (!threadId) return undefined
    return [...(this.hostSnapshot?.questions ?? [])]
      .filter((row) => row.status === 'open' && row.threadId === threadId)
      .sort(
        (left, right) =>
          left.askedAt - right.askedAt || left.questionId.localeCompare(right.questionId)
      )[0]
  }

  private async decideProjectedApproval(
    approval: HostApprovalProjection,
    decision: Extract<HostApprovalDecideDecision, 'accept' | 'decline'>
  ): Promise<void> {
    const command = this.buildMutation(
      'approval.decide',
      { approvalId: approval.approvalId },
      { decision }
    )
    if (!command) return
    await this.runHostMutation(command, {
      onSucceeded: async () => {
        await this.refreshHostSnapshot()
        if (this.state.selectedThreadId) this.applyLocalThread(this.state.selectedThreadId)
      }
    })
  }

  private async answerProjectedQuestion(
    question: HostQuestionProjection,
    composerRestore: string,
    decision: 'answer' | 'dismiss',
    answer?: string
  ): Promise<void> {
    const command = this.buildMutation(
      'question.answer',
      { questionId: question.questionId },
      decision === 'answer' ? { decision, answer: answer ?? '', isCustom: true } : { decision }
    )
    if (!command) {
      this.restoreComposerText(composerRestore)
      this.render()
      return
    }
    await this.runHostMutation(command, {
      composerRestore,
      onSucceeded: async () => {
        await this.refreshHostSnapshot()
        if (this.state.selectedThreadId) this.applyLocalThread(this.state.selectedThreadId)
      }
    })
  }

  private async decidePendingApproval(decision: HostApprovalDecideDecision): Promise<void> {
    const pending = this.state.pendingHostMutation
    if (!pending?.approvalId || !this.client) return
    const actor = this.actorIdentity()
    if (!actor) return
    const decide = buildHostCommand({
      name: 'approval.decide',
      actor,
      target: { approvalId: pending.approvalId },
      arguments: { decision },
      issuedAt: new Date(this.options.now()).toISOString()
    })
    try {
      const receipt = await this.client.submitCommand(decide)
      if (receipt.status === 'pending') {
        // Should not happen for response commands; surface honestly if it does.
        const desc = describeHostReceipt(receipt)
        this.setNotice(desc.text, desc.tone)
      } else if (receipt.status !== 'succeeded') {
        const desc = describeHostReceipt(receipt)
        this.setNotice(desc.text, desc.tone, 4_000)
      } else {
        this.setNotice(
          decision === 'decline' || decision === 'cancel'
            ? 'Host approval declined · waiting for receipt'
            : 'Host approval accepted · waiting for receipt',
          decision === 'decline' || decision === 'cancel' ? 'warning' : 'good',
          2_500
        )
      }
    } catch (error) {
      this.setNotice(error instanceof Error ? error.message : String(error), 'error', 4_000)
    }
    this.render()
  }

  /**
   * Submit a Host mutation and resolve its receipt honestly.
   *
   * Receipt mechanism (Wave 4.2b): poll `lookupReceipt({ commandId })` with
   * bounded backoff. Pending / authority.ask is shown as an approval wait —
   * never as completed. After the first pending receipt, refresh the snapshot
   * once so HostApprovalProjection cards can bind y/n → approval.decide.
   */
  private async runHostMutation(
    command: HostCommand,
    options: {
      composerRestore?: string
      onSucceeded?: (receipt: HostCommandReceipt) => Promise<void> | void
      onTerminalReceipt?: (receipt: HostCommandReceipt) => void
    } = {}
  ): Promise<HostCommandReceipt | undefined> {
    if (!this.client) return undefined
    if (this.mutationInFlight) {
      this.setNotice('A Host command is already in flight.', 'warning', 2_000)
      this.render()
      return undefined
    }
    this.mutationInFlight = true
    const pending: TuiPendingHostMutation = {
      commandId: command.commandId,
      name: command.name,
      ...(options.composerRestore !== undefined ? { composerRestore: options.composerRestore } : {})
    }
    this.state.pendingHostMutation = pending
    this.render()
    try {
      const initial = await this.client.submitCommand(command)
      if (initial.status === 'pending' || initial.authority.decision === 'ask') {
        const desc = describeHostReceipt(initial)
        this.setNotice(desc.text, desc.tone)
        try {
          await this.refreshHostSnapshot()
          const approvalId = this.findPendingApprovalId(pending.commandId)
          if (approvalId) {
            pending.approvalId = approvalId
            this.state.pendingHostMutation = { ...pending }
            this.setNotice(desc.text, desc.tone)
          }
        } catch {
          // Snapshot refresh failure must not invent a terminal outcome.
        }
        this.render()
        const terminal = await pollHostReceiptUntilTerminal({
          commandId: command.commandId,
          lookup: (commandId) => this.client!.lookupReceipt({ commandId }),
          shouldAbort: () => this.stopped || !this.client?.connected,
          timeoutMs: 60_000,
          initialDelayMs: 200,
          maxDelayMs: 1_500,
          onTick: (receipt) => {
            if (receipt.status === 'pending') {
              const tick = describeHostReceipt(receipt)
              this.setNotice(tick.text, tick.tone)
              this.render()
            }
          }
        })
        await this.applyTerminalReceipt(terminal, options)
        return terminal
      }
      await this.applyTerminalReceipt(initial, options)
      return initial
    } catch (error) {
      if (options.composerRestore) this.restoreComposerText(options.composerRestore)
      this.setNotice(error instanceof Error ? error.message : String(error), 'error', 4_000)
      return undefined
    } finally {
      this.mutationInFlight = false
      this.state.pendingHostMutation = undefined
      this.render()
      if (this.pendingEscapeCancel) this.flushPendingEscapeCancel()
      else this.scheduleQueuedDraftDrain()
    }
  }

  private async applyTerminalReceipt(
    receipt: HostCommandReceipt,
    options: {
      composerRestore?: string
      onSucceeded?: (receipt: HostCommandReceipt) => Promise<void> | void
      onTerminalReceipt?: (receipt: HostCommandReceipt) => void
    }
  ): Promise<void> {
    if (!isTerminalHostReceiptStatus(receipt.status)) {
      if (options.composerRestore) this.restoreComposerText(options.composerRestore)
      const stuck = describeHostReceipt(receipt)
      this.setNotice(`${stuck.text} · timed out`, 'warning', 5_000)
      return
    }
    options.onTerminalReceipt?.(receipt)
    if (receipt.status === 'succeeded') {
      const noticeBefore = this.state.notice
      await options.onSucceeded?.(receipt)
      // Prefer a specific notice from onSucceeded (e.g. "Opened …") over the
      // generic "Host accepted <name>" so the HUD still names the thread.
      if (this.state.notice === noticeBefore) {
        const ok = describeHostReceipt(receipt)
        this.setNotice(ok.text, ok.tone, 2_500)
      }
      return
    }
    if (options.composerRestore) this.restoreComposerText(options.composerRestore)
    const failed = describeHostReceipt(receipt)
    this.setNotice(failed.text, failed.tone, 4_500)
  }

  private sendDemoPrompt(text: string): void {
    if (!this.state.thread) return
    const snapshot = cloneThreadSnapshot(this.state.thread)
    const now = this.options.now()
    const userRow: TaskWraithControlTranscriptRow = {
      id: `demo-user-${now}`,
      role: 'user',
      kind: 'user',
      speaker: 'You',
      text,
      timestamp: new Date(now).toISOString(),
      truncated: false
    }
    snapshot.rows.push(userRow)
    snapshot.totalRows = snapshot.rows.length
    snapshot.thread.status = 'working'
    snapshot.thread.updatedAt = now
    snapshot.thread.wallTimeMs = 0
    snapshot.thread.tokenEstimate = 0
    this.state.thread = snapshot
    this.setNotice('Demo prompt dispatched', 'good', 1_500)
    this.render()
    if (this.demoReplyTimer) clearTimeout(this.demoReplyTimer)
    this.demoReplyTimer = setTimeout(() => {
      if (!this.state.thread) return
      const completed = cloneThreadSnapshot(this.state.thread)
      const provider = completed.thread.provider
      completed.rows.push({
        id: `demo-assistant-${this.options.now()}`,
        role: 'assistant',
        kind: 'assistant',
        speaker: `${provider.displayProvider} · Lead`,
        provider,
        text: 'The sidecar keeps the reply plain, preserves the provider accent on identity, and returns the canvas to rest.',
        timestamp: new Date(this.options.now()).toISOString(),
        truncated: false
      })
      completed.totalRows = completed.rows.length
      completed.thread.status = 'complete'
      completed.thread.updatedAt = this.options.now()
      completed.thread.wallTimeMs = 1_200
      completed.thread.tokenEstimate = 86
      this.state.thread = completed
      this.demoReplyTimer = null
      this.render()
    }, 1_200)
  }

  private setNotice(
    text: string,
    tone: 'neutral' | 'good' | 'warning' | 'error',
    durationMs?: number
  ): void {
    this.state.notice = {
      text,
      tone,
      ...(durationMs ? { expiresAt: this.options.now() + durationMs } : {})
    }
  }

  private render(): void {
    if (!this.terminalActive || this.stopped) return
    if (this.state.notice?.expiresAt && this.state.notice.expiresAt <= this.options.now()) {
      this.state.notice = undefined
    }
    const width = Math.max(24, this.options.output.columns || 80)
    const height = Math.max(8, this.options.output.rows || 24)
    const frame = renderTaskWraithTui(this.state, {
      width,
      height,
      ansi: this.ansi,
      now: this.options.now(),
      animationEnabled: this.options.animationEnabled,
      glyphs: this.glyphs,
      theme: this.theme
    })
    this.options.output.write(`\u001b[H${frame}`)
  }
}

function cycleIndex(index: number, length: number, delta: number): number {
  if (length <= 0) return 0
  return (index + delta + length) % length
}

function cycleAvailableIndex(
  items: readonly { available: boolean }[],
  index: number,
  delta: number
): number {
  if (!items.length || !items.some((item) => item.available)) return 0
  let next = index
  for (let attempts = 0; attempts < items.length; attempts += 1) {
    next = cycleIndex(next, items.length, delta)
    if (items[next]?.available) return next
  }
  return Math.max(0, Math.min(index, items.length - 1))
}

function mergeTranscriptRows(
  older: readonly TaskWraithControlTranscriptRow[],
  newer: readonly TaskWraithControlTranscriptRow[]
): TaskWraithControlTranscriptRow[] {
  const ids = new Set<string>()
  return [...older, ...newer].filter((row) => {
    if (ids.has(row.id)) return false
    ids.add(row.id)
    return true
  })
}
