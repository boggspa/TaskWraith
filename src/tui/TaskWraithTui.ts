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
import type { HostProviderStatusProjection } from '../shared/hostSetupProtocol'
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
  type TuiPendingHostMutation
} from './state'
import { detectTuiUnicode, resolveTuiGlyphs, type TuiGlyphSet } from './theme'

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
  reviveHost?: () => Promise<void>
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
const ANIMATION_INTERVAL_MS = 120
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
    tuneEffortIndex: 0
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
  private lastError = ''
  /** Serialises full snapshots and push deltas into one atomic apply lane. */
  private projectionQueue: Promise<void> = Promise.resolve()
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
    this.state = options.demo ? createTaskWraithTuiDemoState(this.options.now()) : emptyState()
    this.state.themeName = options.themeName ?? this.theme.name
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
        this.animationTimer = setInterval(() => {
          if (this.state.thread?.thread.status !== 'working') return
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
    this.reconnectTimer = null
    this.projectionRefreshTimer = null
    this.animationTimer = null
    this.demoReplyTimer = null
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
      void this.applyHistoryEvent(frame).catch((error) => this.surfaceProjectionSyncError(error))
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
      this.state.thread = detail?.thread
    }
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
    this.applyHostSnapshot(applied.snapshot)
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
      const mapped = this.state.snapshot
      if (!mapped) throw new Error('TaskWraith Host snapshot was not available after connect.')
      this.state.connection = 'connected'
      this.everConnected = true
      const threadId = preferredThread(
        mapped,
        this.state.selectedThreadId ?? this.options.initialThreadId
      )
      if (threadId) {
        await this.openThread(threadId)
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
        await this.options.reviveHost()
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

  private async openThread(threadId: string): Promise<void> {
    if (!threadId || this.selectingThread || this.mutationInFlight) return
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
      this.applyLocalThread(threadId, { previewNotice: true })
      await this.loadThreadHistory(threadId)
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
          this.applyLocalThread(threadId, { previewNotice: true })
          await this.loadThreadHistory(threadId)
        }
      })
    } finally {
      this.selectingThread = false
      this.render()
    }
  }

  private applyLocalThread(threadId: string, options: { previewNotice?: boolean } = {}): void {
    const host = this.hostSnapshot
    if (!host) return
    const detail = mapHostSnapshotToThreadDetail(host, threadId)
    if (!detail) return
    this.state.selectedThreadId = threadId
    this.state.thread = detail.thread
    this.state.overlay = 'none'
    // The seat lens is keyed to the thread it was opened for.
    this.state.seats = undefined
    this.state.scrollOffset = 0
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
    const pageRows = mapHostHistoryEntriesToTranscriptRows(page.entries)
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
    if (result.kind === 'full_resnapshot_required') {
      this.setNotice('Transcript history changed · reloaded latest page.', 'warning', 3_000)
      await this.loadThreadHistory(threadId)
      return
    }
    if (result.generation !== history.generation || result.fromCursor !== history.cursor) {
      this.setNotice('Transcript history cursor changed · reloaded latest page.', 'warning', 3_000)
      await this.loadThreadHistory(threadId)
      return
    }
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
      const row = mapHostHistoryEntriesToTranscriptRows([delta.entry])[0]
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
        this.render()
      } else {
        this.bracketedPasteBuffer += input
      }
      return
    }
    if (key.ctrl && key.name === 'c') {
      if (this.state.input) {
        this.state.input = ''
        this.state.inputCursor = 0
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
      this.toggleOverlay('help')
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
    if (this.state.overlay !== 'none') {
      if (key.name === 'return' || key.name === 'enter') {
        this.state.overlay = 'none'
        this.render()
      }
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
      this.state.coldStartPostureIndex = cycleIndex(
        this.state.coldStartPostureIndex ?? 0,
        cold.offers.postures.filter((candidate) => candidate.available).length,
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
      const posture = cold.offers.postures.filter((candidate) => candidate.available)[
        this.state.coldStartPostureIndex ?? 0
      ]
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
      const posture = cold.offers.postures.filter((candidate) => candidate.available)[
        this.state.coldStartPostureIndex ?? 0
      ]
      if (!model || !posture) throw new Error('Host offers contain no available configuration.')
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
        buildThreadConfigureCommand({ actor, selection: selection.selection })
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
        if (cold?.kind === 'workspace')
          this.setNotice('Workspace registered · choose provider', 'good')
        if (cold?.kind === 'thread') this.setNotice('Thread created · configure it', 'good')
        if (cold?.kind === 'auth' && cold.operationId) await this.pollColdStartAuth(cold.providerId)
        if (cold?.kind === 'ready') {
          this.state.overlay = 'none'
          this.state.coldStartIntent = undefined
          this.state.selectedThreadId = cold.threadId
          await this.refreshHostSnapshot()
          this.applyLocalThread(cold.threadId, { previewNotice: true })
          await this.loadThreadHistory(cold.threadId)
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
      await this.client.getProviderOffers(providerId)
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
    this.state.coldStartModelIndex = 0
    this.state.coldStartReasoningIndex = 0
    this.state.coldStartPostureIndex = 0
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
   * Which workspace a new thread lands in. An explicit /workspace pick wins and
   * keeps winning — that stickiness is the whole point of the lens. Without one
   * we inherit the open thread's workspace, and only then fall back to the first
   * registered workspace, which is raw registration order and therefore
   * arbitrary. That silent last resort is what /workspace exists to make visible.
   */
  private resolveWorkspaceId(): string | undefined {
    const workspaces = this.state.snapshot?.workspaces ?? []
    const picked = workspaces.find((workspace) => workspace.id === this.state.activeWorkspaceId)
    if (picked) return picked.id
    return this.state.thread?.thread.workspaceId ?? workspaces[0]?.id
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
        this.state.activeWorkspaceId = workspace.id
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
          this.state.activeWorkspaceId = registered
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
      this.render()
      return
    }
    if (!this.state.thread) {
      this.setNotice('Open a thread before tuning.', 'warning', 2_500)
      this.render()
      return
    }
    this.state.overlay = 'tune'
    this.state.overlayIndex = 0
    this.state.tuneEffortIndex = 0
    void this.loadOffers()
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
    const threadId = this.state.selectedThreadId
    if (!threadId) {
      this.setNotice('Choose a thread with Ctrl+K before sending.', 'warning', 3_000)
      this.render()
      return
    }
    if (this.sendingPrompt || this.mutationInFlight) {
      this.setNotice('The previous prompt is still being accepted.', 'warning', 2_000)
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
    const args: Record<string, unknown> = { text }
    if (selection?.model) args.model = selection.model
    if (selection?.reasoningEffort) args.reasoningEffort = selection.reasoningEffort
    const command = this.buildMutation('composer.send', { threadId }, args)
    if (!command) {
      this.restoreComposerText(original)
      this.render()
      return
    }
    this.sendingPrompt = true
    try {
      await this.runHostMutation(command, {
        composerRestore: original,
        onSucceeded: async () => {
          this.state.pendingSelection = undefined
          await this.refreshHostSnapshot()
          if (this.state.selectedThreadId) {
            this.applyLocalThread(this.state.selectedThreadId)
          }
        }
      })
    } finally {
      this.sendingPrompt = false
      this.render()
    }
  }

  private restoreComposerText(value: string): void {
    if (this.state.input) return
    this.state.input = value
    this.state.inputCursor = Array.from(value).length
  }

  private async runCommand(raw: string): Promise<void> {
    const [name = '', ...arguments_] = raw.trim().slice(1).split(/\s+/)
    const command = `/${name.toLowerCase()}`
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
      const path = arguments_.join(' ').trim()
      if (!path) {
        this.toggleOverlay('workspaces')
        return
      }
      await this.registerWorkspace(path)
      return
    }
    if (command === '/theme') {
      const requested = arguments_.join(' ').trim()
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
        this.render()
        return
      }
      await this.createSoloThread()
      return
    }
    if (this.state.coldStartIntent === 'required' && this.state.coldStart?.kind !== 'ready') {
      this.state.overlay = 'setup'
      this.setNotice('Finish Host setup, then /new starts another solo thread.', 'warning', 3_000)
      this.render()
      return
    }
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
    this.state.coldStartProviderIndex = 0
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
          ? coldStartOffers(provider, await this.client.getProviderOffers(status.providerId))
          : coldStartAuthFlows(
              provider,
              auth,
              await this.client.getProviderAuthFlows(status.providerId)
            )
      this.state.coldStartAuthFlowIndex = 0
    } else {
      this.state.coldStart = coldStartOffers(
        provider,
        await this.client.getProviderOffers(status.providerId)
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
    if (createdThreadId) await this.openThread(createdThreadId)
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

  private async cancelRun(): Promise<void> {
    const threadId = this.state.selectedThreadId
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
    if (this.mutationInFlight) {
      this.setNotice('A Host command is already in flight.', 'warning', 2_000)
      this.render()
      return
    }
    const command = this.buildMutation('run.cancel', { threadId }, {})
    if (!command) return
    await this.runHostMutation(command, {
      onSucceeded: async () => {
        await this.refreshHostSnapshot()
        if (this.state.selectedThreadId) {
          this.applyLocalThread(this.state.selectedThreadId)
        }
      }
    })
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
  ): Promise<void> {
    if (!this.client) return
    if (this.mutationInFlight) {
      this.setNotice('A Host command is already in flight.', 'warning', 2_000)
      this.render()
      return
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
        return
      }
      await this.applyTerminalReceipt(initial, options)
    } catch (error) {
      if (options.composerRestore) this.restoreComposerText(options.composerRestore)
      this.setNotice(error instanceof Error ? error.message : String(error), 'error', 4_000)
    } finally {
      this.mutationInFlight = false
      this.state.pendingHostMutation = undefined
      this.render()
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
