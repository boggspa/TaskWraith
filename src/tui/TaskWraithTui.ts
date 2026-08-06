import { randomUUID } from 'node:crypto'
import { emitKeypressEvents } from 'node:readline'
import type { ReadStream, WriteStream } from 'node:tty'
import {
  HostProjectionClient,
  HostProjectionIncompatibleProtocolError
} from '../main/host/HostProjectionClient'
import {
  type HostActorIdentity,
  type HostApprovalDecideDecision,
  type HostCommand,
  type HostCommandName,
  type HostCommandReceipt,
  type HostSnapshot
} from '../shared/hostProtocol'
import { defaultTaskWraithUserDataPath } from '../shared/taskWraithControlPaths.node'
import type {
  TaskWraithControlModelOffer,
  TaskWraithControlParticipant,
  TaskWraithControlSnapshot,
  TaskWraithControlThreadOffers,
  TaskWraithControlThreadSnapshot,
  TaskWraithControlTranscriptRow
} from '../shared/taskWraithControlProtocol'
import { Ansi, sanitizeTerminalText, type AnsiColorMode } from './ansi'
import {
  buildHostCommand,
  describeHostReceipt,
  isTerminalHostReceiptStatus,
  pollHostReceiptUntilTerminal
} from './hostCommandFlow'
import { renderTaskWraithTui } from './render'
import {
  mapHostSnapshotToControlSnapshot,
  mapHostSnapshotToThreadDetail
} from './hostProjectionMap'
import {
  createTaskWraithTuiDemoState,
  type TaskWraithTuiState,
  type TuiOverlay,
  type TuiPendingHostMutation
} from './state'
import { detectTuiUnicode, resolveTuiGlyphs, type TuiGlyphSet } from './theme'

/** Offers / tune catalogue still has no Host command surface. */
const OFFERS_UNAVAILABLE_NOTICE =
  'Host model offers are not on the command wire yet · tune staging is local only'

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
  colorMode: AnsiColorMode
  animationEnabled?: boolean
  /** Override glyph set; defaults to env/locale detection via detectTuiUnicode. */
  glyphs?: TuiGlyphSet
  input?: ReadStream
  output?: WriteStream
  now?: () => number
}

const RECONNECT_DELAY_MS = 1_800
const ANIMATION_INTERVAL_MS = 120
const TRANSCRIPT_PAGE_ROWS = 8

function emptyState(): TaskWraithTuiState {
  return {
    connection: 'connecting',
    input: '',
    inputCursor: 0,
    overlay: 'none',
    overlayIndex: 0,
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
  private readonly client: HostProjectionClient | null
  private state: TaskWraithTuiState
  private stopped = false
  private terminalActive = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private animationTimer: ReturnType<typeof setInterval> | null = null
  private demoReplyTimer: ReturnType<typeof setTimeout> | null = null
  private selectingThread = false
  private sendingPrompt = false
  private mutationInFlight = false
  private bracketedPaste = false
  private bracketedPasteBuffer = ''
  private lastError = ''
  /** Last live HostSnapshot — authority for local thread detail + approvals. */
  private hostSnapshot: HostSnapshot | null = null
  /** Whether a `welcome` has ever been received. Distinguishes a first-time
   *  "offline" state (App never found) from a "reconnecting" state (App was
   *  reachable and the connection dropped). */
  private everConnected = false
  private clientId = `tui-${randomUUID()}`

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
    this.state = options.demo ? createTaskWraithTuiDemoState(this.options.now()) : emptyState()
    this.client = options.demo
      ? null
      : new HostProjectionClient({
          client: {
            clientId: this.clientId,
            clientClass: 'tui',
            clientVersion: options.clientVersion,
            displayName: 'TaskWraith TUI'
          },
          // Wave 4.2b: same client gains commands + receipts (no parallel v1 socket).
          capabilities: ['bootstrap', 'snapshot', 'health', 'commands', 'receipts'],
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
      await this.connect().catch(() => {})
    }
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.animationTimer) clearInterval(this.animationTimer)
    if (this.demoReplyTimer) clearTimeout(this.demoReplyTimer)
    this.reconnectTimer = null
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
      this.lastError = ''
      this.setNotice('Connected to TaskWraith Host', 'good', 1_500)
      this.render()
    })
    // Wave 4.2a: no delta streaming / push snapshot events — one getSnapshot after connect.
    this.client.on('disconnected', (error) => {
      if (this.stopped) return
      // The host was reachable before, so this is a drop-and-retry rather
      // than "the App was never found" — distinct terminal states.
      this.state.connection = this.everConnected ? 'reconnecting' : 'offline'
      this.lastError = error?.message ?? 'TaskWraith Host disconnected.'
      this.setNotice(
        this.everConnected
          ? 'TaskWraith Host disconnected · reconnecting'
          : 'Electron Host offline · retrying',
        'warning'
      )
      this.scheduleReconnect()
      this.render()
    })
  }

  private applyHostSnapshot(snapshot: HostSnapshot): TaskWraithControlSnapshot {
    this.hostSnapshot = snapshot
    const mapped = mapHostSnapshotToControlSnapshot(snapshot)
    this.state.snapshot = mapped
    return mapped
  }

  private async connect(): Promise<void> {
    if (!this.client || this.stopped) return
    this.state.connection = this.everConnected ? 'reconnecting' : 'connecting'
    this.render()
    try {
      const welcome = await this.client.connect()
      this.state.hostVersion = welcome.hostVersion
      const frame = await this.client.getSnapshot()
      const mapped = this.applyHostSnapshot(frame.snapshot)
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
        const message = error instanceof Error ? error.message : String(error)
        if (message !== this.lastError) {
          this.lastError = message
          this.setNotice(
            this.everConnected
              ? 'TaskWraith Host disconnected · reconnecting'
              : 'Electron Host offline · retrying locally',
            'warning'
          )
        }
      }
      this.scheduleReconnect()
      this.render()
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped || !this.client) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, RECONNECT_DELAY_MS)
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
    this.selectingThread = true
    try {
      const command = this.buildMutation('thread.select', { threadId }, {})
      if (!command) return
      await this.runHostMutation(command, {
        onSucceeded: async () => {
          await this.refreshHostSnapshot()
          this.applyLocalThread(threadId, { previewNotice: true })
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
    this.state.scrollOffset = 0
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
    if (key.ctrl && key.name === 'p') {
      this.toggleOverlay('help')
      return
    }
    if (key.ctrl && key.name === 'g') {
      this.toggleTuneOverlay()
      return
    }
    if (key.name === 'escape') {
      this.state.overlay = 'none'
      this.render()
      return
    }
    if (this.state.overlay === 'threads') {
      this.handleThreadPickerKey(key)
      return
    }
    if (this.state.overlay === 'tune') {
      this.handleTuneKey(key)
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
      this.state.scrollOffset += TRANSCRIPT_PAGE_ROWS
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

  private toggleOverlay(overlay: Exclude<TuiOverlay, 'none'>): void {
    this.state.overlay = this.state.overlay === overlay ? 'none' : overlay
    if (overlay === 'threads' && this.state.overlay === 'threads') {
      const threads = (this.state.snapshot?.threads ?? []).filter((thread) => !thread.archived)
      this.state.overlayIndex = Math.max(
        0,
        threads.findIndex((thread) => thread.id === this.state.selectedThreadId)
      )
    }
    this.render()
  }

  private handleThreadPickerKey(key: Keypress): void {
    const threads = (this.state.snapshot?.threads ?? []).filter((thread) => !thread.archived)
    if (key.name === 'up') {
      this.state.overlayIndex = Math.max(0, this.state.overlayIndex - 1)
    } else if (key.name === 'down') {
      this.state.overlayIndex = Math.min(
        Math.max(0, threads.length - 1),
        this.state.overlayIndex + 1
      )
    } else if (key.name === 'return' || key.name === 'enter') {
      const thread = threads[this.state.overlayIndex]
      if (thread) void this.openThread(thread.id)
      return
    } else {
      return
    }
    this.render()
  }

  /** The tune lens: seat enable/disable on ensembles, model/reasoning staging
   * on solo threads. Both are host-validated; this surface only picks among
   * what the facade projected. */
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
    if (!this.state.thread.thread.ensemble) void this.loadOffers()
    this.render()
  }

  private tuneSeats(): TaskWraithControlParticipant[] {
    return this.state.thread?.thread.ensemble?.participants ?? []
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
      // No Host command yet for model offers — local staging only.
      this.state.offers = {
        threadId,
        provider: this.state.thread!.thread.provider,
        models: [],
        source: 'curated',
        locked: OFFERS_UNAVAILABLE_NOTICE
      }
      this.state.overlayIndex = 0
      this.state.tuneEffortIndex = 0
      this.setNotice(OFFERS_UNAVAILABLE_NOTICE, 'warning', 3_000)
    } finally {
      this.state.offersLoading = false
      this.render()
    }
  }

  private handleTuneKey(key: Keypress): void {
    if (this.state.thread?.thread.ensemble) {
      const seats = this.tuneSeats()
      if (!seats.length) return
      const safeIndex = Math.max(0, Math.min(this.state.overlayIndex, seats.length - 1))
      if (key.name === 'up') {
        this.state.overlayIndex = Math.max(0, safeIndex - 1)
      } else if (key.name === 'down') {
        this.state.overlayIndex = Math.min(seats.length - 1, safeIndex + 1)
      } else if (key.name === 'return' || key.name === 'enter' || key.name === 'space') {
        const seat = seats[safeIndex]
        if (seat) void this.toggleSeat(seat)
        return
      } else {
        return
      }
      this.render()
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
        `Next send uses ${offer.label ?? offer.id}${effort ? ` · ${effort.id}` : ''}`,
        'good',
        3_000
      )
    }
    this.render()
  }

  private async toggleSeat(seat: TaskWraithControlParticipant): Promise<void> {
    const threadId = this.state.selectedThreadId
    if (!threadId || this.mutationInFlight) return
    const nextEnabled = !seat.enabled
    if (!this.client) {
      seat.enabled = nextEnabled
      this.setNotice(`${nextEnabled ? 'Enabled' : 'Disabled'} ${seat.role} (demo)`, 'good', 2_000)
      this.render()
      return
    }
    const command = this.buildMutation(
      'ensemble.seat.toggle',
      { threadId },
      { participantId: seat.id, enabled: nextEnabled }
    )
    if (!command) return
    await this.runHostMutation(command, {
      onSucceeded: async () => {
        await this.refreshHostSnapshot()
        seat.enabled = nextEnabled
        this.setNotice(`${nextEnabled ? 'Enabled' : 'Disabled'} ${seat.role}`, 'good', 2_000)
      }
    })
  }

  private async submit(): Promise<void> {
    const original = this.state.input
    const text = original.trim()
    if (!text) return
    if (text.startsWith('/')) {
      this.state.input = ''
      this.state.inputCursor = 0
      await this.runCommand(text)
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
    const command = raw.trim().toLowerCase()
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
    if (command === '/help') {
      this.toggleOverlay('help')
      return
    }
    if (command === '/cancel') {
      await this.cancelRun()
      return
    }
    if (command === '/model' || command === '/seats' || command === '/tune') {
      this.toggleTuneOverlay()
      return
    }
    this.setNotice(`Unknown command: ${raw}`, 'warning', 3_000)
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
    const frame = await this.client.getSnapshot()
    this.applyHostSnapshot(frame.snapshot)
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
      onSucceeded?: () => Promise<void> | void
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
      onSucceeded?: () => Promise<void> | void
    }
  ): Promise<void> {
    if (!isTerminalHostReceiptStatus(receipt.status)) {
      if (options.composerRestore) this.restoreComposerText(options.composerRestore)
      const stuck = describeHostReceipt(receipt)
      this.setNotice(`${stuck.text} · timed out`, 'warning', 5_000)
      return
    }
    if (receipt.status === 'succeeded') {
      const noticeBefore = this.state.notice
      await options.onSucceeded?.()
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
      glyphs: this.glyphs
    })
    this.options.output.write(`\u001b[H${frame}`)
  }
}
