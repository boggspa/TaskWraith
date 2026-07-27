import { emitKeypressEvents } from 'node:readline'
import type { ReadStream, WriteStream } from 'node:tty'
import type {
  TaskWraithControlSnapshot,
  TaskWraithControlThreadSnapshot,
  TaskWraithControlTranscriptRow
} from '../shared/taskWraithControlProtocol'
import { Ansi, sanitizeTerminalText, type AnsiColorMode } from './ansi'
import {
  TaskWraithControlClient,
  TaskWraithControlIncompatibleProtocolError
} from './client/TaskWraithControlClient'
import { renderTaskWraithTui } from './render'
import { createTaskWraithTuiDemoState, type TaskWraithTuiState, type TuiOverlay } from './state'
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
    animationFrame: 0
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
  private readonly client: TaskWraithControlClient | null
  private state: TaskWraithTuiState
  private stopped = false
  private terminalActive = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private animationTimer: ReturnType<typeof setInterval> | null = null
  private demoReplyTimer: ReturnType<typeof setTimeout> | null = null
  private selectingThread = false
  private sendingPrompt = false
  private bracketedPaste = false
  private bracketedPasteBuffer = ''
  private lastError = ''
  /** Whether a `welcome` has ever been received. Distinguishes a first-time
   *  "offline" state (App never found) from a "reconnecting" state (App was
   *  reachable and the connection dropped). */
  private everConnected = false

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
      : new TaskWraithControlClient({
          clientVersion: options.clientVersion,
          ...(options.userDataPath ? { userDataPath: options.userDataPath } : {})
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
      this.setNotice('Connected to TaskWraith', 'good', 1_500)
      this.render()
    })
    this.client.on('snapshot', (snapshot) => {
      this.state.snapshot = snapshot
      const selectedStillExists =
        this.state.selectedThreadId &&
        snapshot.threads.some((thread) => thread.id === this.state.selectedThreadId)
      if (!selectedStillExists) {
        this.state.selectedThreadId = undefined
        this.state.thread = undefined
        const threadId = preferredThread(snapshot, this.options.initialThreadId)
        if (threadId) void this.openThread(threadId)
      }
      this.render()
    })
    this.client.on('thread', (thread) => {
      if (thread.thread.id !== this.state.selectedThreadId) return
      this.state.thread = thread
      this.render()
    })
    this.client.on('disconnected', (error) => {
      if (this.stopped) return
      // The host was reachable before, so this is a drop-and-retry rather
      // than "the App was never found" — distinct terminal states.
      this.state.connection = this.everConnected ? 'reconnecting' : 'offline'
      this.lastError = error?.message ?? 'TaskWraith host disconnected.'
      this.setNotice(
        this.everConnected
          ? 'TaskWraith host disconnected · reconnecting'
          : 'Electron host offline · retrying',
        'warning'
      )
      this.scheduleReconnect()
      this.render()
    })
  }

  private async connect(): Promise<void> {
    if (!this.client || this.stopped) return
    this.state.connection = this.everConnected ? 'reconnecting' : 'connecting'
    this.render()
    try {
      await this.client.connect()
      const snapshot = await this.client.getSnapshot()
      this.state.snapshot = snapshot
      this.state.connection = 'connected'
      this.everConnected = true
      const threadId = preferredThread(
        snapshot,
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
      if (error instanceof TaskWraithControlIncompatibleProtocolError) {
        this.state.connection = 'incompatible-protocol'
        const message = error.message
        if (message !== this.lastError) {
          this.lastError = message
          this.setNotice('TaskWraith host protocol is incompatible · update the App', 'error')
        }
      } else {
        this.state.connection = this.everConnected ? 'reconnecting' : 'offline'
        const message = error instanceof Error ? error.message : String(error)
        if (message !== this.lastError) {
          this.lastError = message
          this.setNotice(
            this.everConnected
              ? 'TaskWraith host disconnected · reconnecting'
              : 'Electron host offline · retrying locally',
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
    if (!threadId || this.selectingThread) return
    if (!this.client) {
      this.state.selectedThreadId = threadId
      this.state.overlay = 'none'
      this.state.scrollOffset = 0
      this.render()
      return
    }
    this.selectingThread = true
    try {
      const thread = await this.client.selectThread(threadId)
      this.state.selectedThreadId = threadId
      this.state.thread = thread
      this.state.overlay = 'none'
      this.state.scrollOffset = 0
      this.setNotice(`Opened ${thread.thread.title}`, 'good', 1_800)
    } catch (error) {
      this.setNotice(error instanceof Error ? error.message : String(error), 'error', 4_000)
    } finally {
      this.selectingThread = false
      this.render()
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
    if (key.name === 'escape') {
      this.state.overlay = 'none'
      this.render()
      return
    }
    if (this.state.overlay === 'threads') {
      this.handleThreadPickerKey(key)
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
    if (this.sendingPrompt) {
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
    this.sendingPrompt = true
    try {
      const result = await this.client.sendPrompt(threadId, text)
      if (!result.dispatched) this.restoreComposerText(original)
      this.setNotice(
        result.message || (result.dispatched ? 'Prompt dispatched' : 'Prompt not dispatched'),
        result.dispatched ? 'good' : 'warning',
        result.dispatched ? 2_000 : 4_000
      )
    } catch (error) {
      this.restoreComposerText(original)
      this.setNotice(error instanceof Error ? error.message : String(error), 'error', 5_000)
    } finally {
      this.sendingPrompt = false
    }
    this.render()
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
    try {
      const result = await this.client.cancelRun(threadId)
      this.setNotice(result.message, result.cancelled ? 'good' : 'warning', 3_000)
    } catch (error) {
      this.setNotice(error instanceof Error ? error.message : String(error), 'error', 5_000)
    }
    this.render()
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
