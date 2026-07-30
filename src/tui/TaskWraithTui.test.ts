import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ReadStream, WriteStream } from 'node:tty'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stripAnsi } from './ansi'
import {
  taskWraithControlDiscoveryPath,
  taskWraithControlSocketPath,
  taskWraithControlTokenPath
} from '../shared/taskWraithControlPaths.node'
import {
  TASKWRAITH_CONTROL_PROTOCOL_VERSION,
  type TaskWraithControlSnapshot,
  type TaskWraithControlThreadOffers,
  type TaskWraithControlThreadSnapshot
} from '../shared/taskWraithControlProtocol'
import { TaskWraithTui } from './TaskWraithTui'

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.()
  vi.restoreAllMocks()
})

/* -------------------------------------------------------------------------
 * Minimal fake TTY streams
 * ---------------------------------------------------------------------- */

class FakeInput extends PassThrough {
  isTTY = true as const
  private rawMode = false
  setRawMode(mode: boolean): this {
    this.rawMode = mode
    return this
  }
  get isRawMode(): boolean {
    return this.rawMode
  }
}

class FakeOutput extends EventEmitter {
  isTTY = true as const
  columns = 80
  rows = 24
  readonly frames: string[] = []
  write(chunk: string): boolean {
    this.frames.push(chunk)
    return true
  }
  get lastFrame(): string {
    return stripAnsi(this.frames.at(-1) ?? '')
  }
}

function makeTty(): { input: FakeInput; output: FakeOutput } {
  return { input: new FakeInput(), output: new FakeOutput() }
}

function feed(input: FakeInput, text: string): void {
  input.write(Buffer.from(text, 'utf8'))
}

async function waitFor(
  check: () => boolean,
  description: string,
  timeoutMs = 2_000
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for: ${description}`)
}

/* -------------------------------------------------------------------------
 * Minimal fake TaskWraith control host — implements just enough of protocol
 * v1 (hello/welcome, snapshot.get/thread.select/composer.send/run.cancel/
 * ping, snapshot.changed/thread.changed/host.closing events) to drive
 * TaskWraithTui end to end without depending on the host-lane implementation.
 * ---------------------------------------------------------------------- */

interface FakeHostHandlers {
  snapshot: () => TaskWraithControlSnapshot
  selectThread: (threadId: string) => TaskWraithControlThreadSnapshot
  sendPrompt: (
    threadId: string,
    text: string,
    selection?: { model?: string; reasoningEffort?: string }
  ) => { dispatched: boolean; message: string }
  cancelRun: (threadId: string) => { cancelled: boolean; message: string }
  threadOffers?: (threadId: string) => TaskWraithControlThreadOffers
  toggleEnsembleSeat?: (
    threadId: string,
    participantId: string,
    enabled: boolean
  ) => { updated: boolean; message: string }
}

class FakeControlHost {
  readonly userDataPath: string
  readonly socketPath: string
  readonly discoveryPath: string
  readonly tokenPath: string
  readonly token = randomUUID()
  private server: Server | null = null
  private readonly sockets = new Set<Socket>()
  private readonly authenticated = new Set<Socket>()
  handlers: FakeHostHandlers

  constructor(userDataPath: string, handlers: FakeHostHandlers) {
    this.userDataPath = userDataPath
    this.socketPath = taskWraithControlSocketPath(userDataPath)
    this.discoveryPath = taskWraithControlDiscoveryPath(userDataPath)
    this.tokenPath = taskWraithControlTokenPath(userDataPath)
    this.handlers = handlers
  }

  async start(): Promise<void> {
    await mkdir(this.userDataPath, { recursive: true })
    // POSIX only. `taskWraithControlSocketPath` returns `\\.\pipe\...` on
    // Windows, whose dirname is `\\.\pipe` — a namespace, not a creatable
    // directory. A pipe needs no parent made for it.
    if (process.platform !== 'win32') {
      await mkdir(dirname(this.socketPath), { recursive: true })
    }
    await writeFile(this.tokenPath, `${this.token}\n`, 'utf8')
    await writeFile(
      this.discoveryPath,
      JSON.stringify({
        protocolVersion: TASKWRAITH_CONTROL_PROTOCOL_VERSION,
        socketPath: this.socketPath,
        tokenPath: this.tokenPath,
        pid: process.pid,
        startedAt: new Date(0).toISOString()
      }),
      'utf8'
    )
    const server = createServer((socket) => this.accept(socket))
    this.server = server
    await new Promise<void>((resolve) => server.listen(this.socketPath, resolve))
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    // Unix domain socket files outlive server.close(); a revived host must be
    // able to re-listen at the same path without EADDRINUSE. Windows named
    // pipes are reclaimed by the OS when the last handle closes, and there is
    // no filesystem entry to unlink.
    if (process.platform !== 'win32') {
      await rm(this.socketPath, { force: true })
    }
  }

  /** Force-drops every connected client, simulating an App restart/crash. */
  dropAllClients(): void {
    for (const socket of this.sockets) socket.destroy()
  }

  broadcast(event: 'snapshot.changed' | 'thread.changed', payload: unknown): void {
    for (const socket of this.authenticated) {
      this.write(socket, { type: 'event', event, sequence: 1, payload })
    }
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) this.onLine(socket, line)
        newline = buffer.indexOf('\n')
      }
    })
    socket.on('close', () => {
      this.sockets.delete(socket)
      this.authenticated.delete(socket)
    })
    socket.on('error', () => {})
  }

  private onLine(socket: Socket, line: string): void {
    const message = JSON.parse(line) as Record<string, unknown>
    if (message.type === 'hello') {
      if (message.token !== this.token) {
        socket.destroy()
        return
      }
      this.authenticated.add(socket)
      this.write(socket, {
        type: 'welcome',
        protocolVersion: TASKWRAITH_CONTROL_PROTOCOL_VERSION,
        hostVersion: '1.9.1-preview',
        sessionId: 'fake-session',
        capabilities: ['snapshot', 'transcript', 'compose', 'cancel']
      })
      return
    }
    if (message.type !== 'request' || !this.authenticated.has(socket)) return
    const { id, method, params } = message as {
      id: string
      method: string
      params?: Record<string, unknown>
    }
    try {
      let result: unknown
      switch (method) {
        case 'ping':
          result = { now: Date.now() }
          break
        case 'snapshot.get':
          result = this.handlers.snapshot()
          break
        case 'thread.select':
          result = this.handlers.selectThread(String(params?.threadId))
          break
        case 'composer.send': {
          const model = typeof params?.model === 'string' ? params.model : undefined
          const reasoningEffort =
            typeof params?.reasoningEffort === 'string' ? params.reasoningEffort : undefined
          const selection =
            model || reasoningEffort
              ? { ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) }
              : undefined
          result = selection
            ? this.handlers.sendPrompt(String(params?.threadId), String(params?.text), selection)
            : this.handlers.sendPrompt(String(params?.threadId), String(params?.text))
          break
        }
        case 'run.cancel':
          result = this.handlers.cancelRun(String(params?.threadId))
          break
        case 'thread.offers':
          if (!this.handlers.threadOffers) throw new Error('unknown request method')
          result = this.handlers.threadOffers(String(params?.threadId))
          break
        case 'ensemble.seat.toggle':
          if (!this.handlers.toggleEnsembleSeat) throw new Error('unknown request method')
          result = this.handlers.toggleEnsembleSeat(
            String(params?.threadId),
            String(params?.participantId),
            Boolean(params?.enabled)
          )
          break
        default:
          throw new Error(`unknown method ${method}`)
      }
      this.write(socket, { type: 'response', id, ok: true, result })
    } catch (error) {
      this.write(socket, {
        type: 'response',
        id,
        ok: false,
        error: {
          code: 'request_failed',
          message: error instanceof Error ? error.message : String(error)
        }
      })
    }
  }

  private write(socket: Socket, message: unknown): void {
    if (socket.destroyed) return
    socket.write(`${JSON.stringify(message)}\n`)
  }
}

/* -------------------------------------------------------------------------
 * Fixture data
 * ---------------------------------------------------------------------- */

const PROVIDER = {
  runtimeProvider: 'claude',
  displayProvider: 'Claude',
  hueKey: 'claude',
  accent: '#8A5CF6',
  model: 'sonnet-5',
  modelLabel: 'Sonnet 5',
  shortCode: 'CLD'
}

function makeSnapshot(threads: TaskWraithControlSnapshot['threads']): TaskWraithControlSnapshot {
  return {
    generatedAt: new Date(0).toISOString(),
    sequence: 1,
    workspaces: [{ id: 'ws-1', name: 'AGBench', path: '/tmp/agbench', pinned: true, updatedAt: 0 }],
    threads
  }
}

function makeThreadSnapshot(
  overrides: Partial<TaskWraithControlThreadSnapshot['thread']> = {}
): TaskWraithControlThreadSnapshot {
  const thread: TaskWraithControlThreadSnapshot['thread'] = {
    id: 'thread-1',
    workspaceId: 'ws-1',
    title: 'Solo thread',
    provider: PROVIDER,
    status: 'idle',
    chatKind: 'single',
    archived: false,
    pinned: false,
    updatedAt: 0,
    messageCount: 1,
    ...overrides
  }
  return {
    generatedAt: new Date(0).toISOString(),
    sequence: 1,
    thread,
    rows: [
      {
        id: 'row-1',
        role: 'user',
        kind: 'user',
        speaker: 'You',
        text: 'Hello TaskWraith',
        timestamp: new Date(0).toISOString(),
        truncated: false
      }
    ],
    totalRows: 1,
    hasMoreAbove: false,
    context: {
      workspaces: [
        { id: 'ws-1', name: 'AGBench', path: '/tmp/agbench', access: 'write', primary: true }
      ],
      provider: PROVIDER
    }
  }
}

async function setupHost(handlers: Partial<FakeHostHandlers> = {}): Promise<{
  host: FakeControlHost
  userDataPath: string
}> {
  const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-lifecycle-'))
  const threadSnapshot = makeThreadSnapshot()
  const snapshot = makeSnapshot([threadSnapshot.thread])
  const host = new FakeControlHost(userDataPath, {
    snapshot: () => snapshot,
    selectThread: (threadId) => {
      if (threadId !== threadSnapshot.thread.id) throw new Error('Thread not found.')
      return threadSnapshot
    },
    sendPrompt: () => ({ dispatched: true, message: 'Prompt dispatched' }),
    cancelRun: () => ({ cancelled: true, message: 'Run cancelled' }),
    ...handlers
  })
  await host.start()
  cleanup.push(() => host.stop())
  return { host, userDataPath }
}

function startTui(userDataPath: string) {
  const { input, output } = makeTty()
  const tui = new TaskWraithTui({
    clientVersion: '0.1.0-test',
    userDataPath,
    colorMode: 'none',
    animationEnabled: false,
    input: input as unknown as ReadStream,
    output: output as unknown as WriteStream
  })
  cleanup.push(() => tui.stop())
  return { tui, input, output }
}

describe('TaskWraithTui lifecycle', () => {
  it('connects, loads the snapshot, auto-selects the newest thread, composes, cancels, disconnects, and reconnects', async () => {
    const sendPrompt = vi.fn(() => ({ dispatched: true, message: 'Prompt dispatched' }))
    const cancelRun = vi.fn(() => ({ cancelled: true, message: 'Run cancelled' }))
    const { host, userDataPath } = await setupHost({ sendPrompt, cancelRun })
    const { tui, input, output } = startTui(userDataPath)

    await tui.start()
    await waitFor(() => output.lastFrame.includes('Solo thread'), 'thread auto-selected')
    expect(output.lastFrame).toContain('Hello TaskWraith')

    feed(input, 'ship the preview')
    feed(input, '\r')
    await waitFor(() => sendPrompt.mock.calls.length > 0, 'composer.send dispatched')
    expect(sendPrompt).toHaveBeenCalledWith('thread-1', 'ship the preview')

    feed(input, '/cancel\r')
    await waitFor(() => cancelRun.mock.calls.length > 0, 'run.cancel dispatched')
    expect(cancelRun).toHaveBeenCalledWith('thread-1')
    await waitFor(() => output.lastFrame.includes('Run cancelled'), 'cancel notice rendered')

    // Simulate the App going away — the client should surface a disconnect
    // notice and start retrying rather than hanging silently.
    host.dropAllClients()
    await host.stop()
    await waitFor(
      () => output.lastFrame.includes('disconnected') || output.lastFrame.includes('reconnecting'),
      'disconnect surfaced'
    )

    // Simulate the App coming back: a fresh host writes new discovery/token
    // artifacts at the same paths, and the sidecar's reconnect timer picks
    // it up without any user action.
    const revivedHost = new FakeControlHost(userDataPath, {
      snapshot: () => makeSnapshot([makeThreadSnapshot().thread]),
      selectThread: () => makeThreadSnapshot({ title: 'Solo thread (revived)' }),
      sendPrompt: () => ({ dispatched: true, message: 'ok' }),
      cancelRun: () => ({ cancelled: true, message: 'ok' })
    })
    await revivedHost.start()
    cleanup.push(() => revivedHost.stop())
    await waitFor(
      () => output.lastFrame.includes('Solo thread (revived)'),
      'reconnected to the revived host',
      5_000
    )
  }, 12_000)

  it('shows the "Open TaskWraith to answer" plain-text attention state, not a generic spinner', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-attention-'))
    const attentionThread = makeThreadSnapshot({ status: 'needs-input' })
    const snapshot = makeSnapshot([attentionThread.thread])
    const host = new FakeControlHost(userDataPath, {
      snapshot: () => snapshot,
      selectThread: () => attentionThread,
      sendPrompt: () => ({ dispatched: true, message: 'ok' }),
      cancelRun: () => ({ cancelled: true, message: 'ok' })
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, output } = startTui(userDataPath)

    await tui.start()
    // The "Opened <thread>" notice briefly takes the HUD's status slot and
    // only clears on the next render; nudge the renderer via resize events
    // until its 1.8s expiry has passed so the attention state is visible.
    const start = Date.now()
    while (Date.now() - start < 4_000 && !output.lastFrame.includes('Open TaskWraith to answer')) {
      output.emit('resize')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(output.lastFrame).toContain('Open TaskWraith to answer')
    expect(output.lastFrame).not.toMatch(/spinner|working…/i)
  }, 6_000)

  it('cancels an ensemble thread run the same way as a solo thread', async () => {
    const cancelRun = vi.fn(() => ({ cancelled: true, message: 'Ensemble run cancelled' }))
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-ensemble-cancel-'))
    const ensembleThread = makeThreadSnapshot({
      chatKind: 'ensemble',
      ensemble: {
        preset: 'Build + Review',
        mode: 'continuous',
        fanout: 'off',
        continuationHops: 1,
        maxContinuationHops: 32,
        backgroundCount: 0,
        participants: [
          {
            id: 'lead',
            provider: 'claude',
            displayProvider: 'Claude',
            hueKey: 'claude',
            accent: '#8A5CF6',
            shortCode: 'CLD',
            role: 'Lead',
            order: 1,
            active: true,
            next: false,
            enabled: true
          }
        ]
      }
    })
    const snapshot = makeSnapshot([ensembleThread.thread])
    const host = new FakeControlHost(userDataPath, {
      snapshot: () => snapshot,
      selectThread: () => ensembleThread,
      sendPrompt: () => ({ dispatched: true, message: 'ok' }),
      cancelRun
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath)

    await tui.start()
    await waitFor(() => output.lastFrame.includes('Solo thread'), 'ensemble thread selected')
    feed(input, '/cancel\r')
    await waitFor(() => cancelRun.mock.calls.length > 0, 'ensemble run.cancel dispatched')
    expect(cancelRun).toHaveBeenCalledWith('thread-1')
  })

  it('stages a model/reasoning switch from the tune lens and sends it with the next prompt', async () => {
    const sendPrompt = vi.fn(() => ({ dispatched: true, message: 'ok' }))
    const threadOffers = vi.fn(
      (): TaskWraithControlThreadOffers => ({
        threadId: 'thread-1',
        provider: PROVIDER,
        currentModel: 'sonnet-5',
        currentReasoningEffort: 'medium',
        models: [
          {
            id: 'sonnet-5',
            label: 'Sonnet 5',
            current: true,
            reasoningEfforts: [{ id: 'low' }, { id: 'medium', isDefault: true }, { id: 'high' }],
            defaultReasoningEffort: 'medium'
          },
          {
            id: 'claude-fable-5',
            label: 'Fable 5',
            reasoningEfforts: [{ id: 'medium', isDefault: true }, { id: 'high' }],
            defaultReasoningEffort: 'medium'
          }
        ],
        source: 'curated'
      })
    )
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-tune-'))
    const threadSnapshot = makeThreadSnapshot()
    const snapshot = makeSnapshot([threadSnapshot.thread])
    const host = new FakeControlHost(userDataPath, {
      snapshot: () => snapshot,
      selectThread: () => threadSnapshot,
      sendPrompt,
      cancelRun: () => ({ cancelled: true, message: 'ok' }),
      threadOffers
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath)

    await tui.start()
    await waitFor(() => output.lastFrame.includes('Solo thread'), 'thread selected')

    feed(input, '\u0007') // Ctrl+G
    await waitFor(() => output.lastFrame.includes('Model (preview)'), 'tune lens open')
    await waitFor(() => threadOffers.mock.calls.length > 0, 'offers fetched from the host')
    await waitFor(() => output.lastFrame.includes('Fable 5'), 'offers rendered')

    // Highlight opens on the current model; move to Fable 5 and raise the effort.
    feed(input, '\u001b[B') // down
    feed(input, '\u001b[C') // right
    feed(input, '\r')
    await waitFor(() => output.lastFrame.includes('Next send uses Fable 5'), 'selection staged')

    feed(input, 'run with the new model\r')
    await waitFor(() => sendPrompt.mock.calls.length > 0, 'composer.send dispatched')
    expect(sendPrompt).toHaveBeenCalledWith('thread-1', 'run with the new model', {
      model: 'claude-fable-5',
      reasoningEffort: 'high'
    })
  }, 8_000)

  it('toggles an ensemble seat through the canonical seat action from the tune lens', async () => {
    const toggleEnsembleSeat = vi.fn(() => ({ updated: true, message: 'Seat updated' }))
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-seats-'))
    const ensembleThread = makeThreadSnapshot({
      chatKind: 'ensemble',
      ensemble: {
        preset: 'Build + Review',
        mode: 'turn-bound',
        fanout: 'off',
        continuationHops: 0,
        maxContinuationHops: 32,
        backgroundCount: 0,
        participants: [
          {
            id: 'lead',
            provider: 'claude',
            displayProvider: 'Claude',
            hueKey: 'claude',
            accent: '#8A5CF6',
            shortCode: 'CLD',
            role: 'Lead',
            order: 1,
            active: false,
            next: false,
            enabled: true
          },
          {
            id: 'review',
            provider: 'codex',
            displayProvider: 'Codex',
            hueKey: 'codex',
            accent: '#705AFF',
            shortCode: 'CDX',
            role: 'Review',
            order: 2,
            active: false,
            next: false,
            enabled: false
          }
        ]
      }
    })
    const snapshot = makeSnapshot([ensembleThread.thread])
    const host = new FakeControlHost(userDataPath, {
      snapshot: () => snapshot,
      selectThread: () => ensembleThread,
      sendPrompt: () => ({ dispatched: true, message: 'ok' }),
      cancelRun: () => ({ cancelled: true, message: 'ok' }),
      toggleEnsembleSeat
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath)

    await tui.start()
    await waitFor(() => output.lastFrame.includes('Solo thread'), 'ensemble thread selected')

    feed(input, '\u0007') // Ctrl+G
    await waitFor(() => output.lastFrame.includes('Seats (preview)'), 'seat lens open')
    expect(output.lastFrame).toContain('Review')

    feed(input, '\u001b[B') // down to the disabled Review seat
    feed(input, '\r') // toggle re-enables it
    await waitFor(() => toggleEnsembleSeat.mock.calls.length > 0, 'seat toggle dispatched')
    expect(toggleEnsembleSeat).toHaveBeenCalledWith('thread-1', 'review', true)
    await waitFor(() => output.lastFrame.includes('Seat updated'), 'seat notice rendered')
  }, 8_000)

  it('reports a missing thread without crashing when the initial thread id no longer exists', async () => {
    const { userDataPath } = await setupHost()
    const { input, output } = makeTty()
    const tui = new TaskWraithTui({
      clientVersion: '0.1.0-test',
      userDataPath,
      colorMode: 'none',
      animationEnabled: false,
      initialThreadId: 'does-not-exist',
      input: input as unknown as ReadStream,
      output: output as unknown as WriteStream
    })
    cleanup.push(() => tui.stop())
    await tui.start()
    // Falls back to the newest non-archived thread instead of the missing id.
    await waitFor(() => output.lastFrame.includes('Solo thread'), 'fallback thread selected')
  })

  it('restores a cleared composer to its previous text when a prompt fails to dispatch', async () => {
    const sendPrompt = vi.fn(() => {
      throw new Error('Host rejected the prompt.')
    })
    const { userDataPath } = await setupHost({ sendPrompt })
    const { tui, input, output } = startTui(userDataPath)
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Solo thread'), 'thread selected')

    feed(input, 'this prompt will fail')
    feed(input, '\r')
    await waitFor(() => sendPrompt.mock.calls.length > 0, 'send attempted')
    await waitFor(
      () => output.lastFrame.includes('this prompt will fail'),
      'composer text restored'
    )
  })

  it('accepts bracketed-paste text as a single composer insertion including embedded line breaks', async () => {
    const { userDataPath } = await setupHost()
    const { tui, input, output } = startTui(userDataPath)
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Solo thread'), 'thread selected')

    feed(input, '\u001b[200~first line\nsecond line\u001b[201~')
    await waitFor(() => output.lastFrame.includes('first line'), 'pasted text rendered')
    expect(output.lastFrame).toContain('first line')
    expect(output.lastFrame).toContain('second line')
  })

  it('restores raw mode and the primary screen buffer on stop()', async () => {
    const { userDataPath } = await setupHost()
    const { input, output } = makeTty()
    const tui = new TaskWraithTui({
      clientVersion: '0.1.0-test',
      userDataPath,
      colorMode: 'none',
      animationEnabled: false,
      input: input as unknown as ReadStream,
      output: output as unknown as WriteStream
    })
    await tui.start()
    expect(input.isRawMode).toBe(true)
    expect(output.frames.join('')).toContain('[?1049h')

    tui.stop()
    expect(input.isRawMode).toBe(false)
    expect(output.frames.join('')).toContain('[?1049l')
  })

  it('restores the terminal even when startup fails after raw mode is entered', async () => {
    const { input, output } = makeTty()
    const failure = new Error('render exploded')
    const setRawModeSpy = vi.spyOn(input, 'setRawMode')
    const tui = new TaskWraithTui({
      clientVersion: '0.1.0-test',
      demo: true,
      colorMode: 'none',
      animationEnabled: false,
      input: input as unknown as ReadStream,
      output: output as unknown as WriteStream
    })
    // Force the first render inside start() to throw, simulating an
    // unexpected startup failure after the alternate screen was entered.
    const originalWrite = output.write.bind(output)
    let calls = 0
    output.write = (chunk: string) => {
      calls += 1
      if (calls === 2) throw failure
      return originalWrite(chunk)
    }
    await expect(tui.start()).rejects.toThrow('render exploded')
    expect(setRawModeSpy).toHaveBeenCalledWith(true)
    expect(setRawModeSpy).toHaveBeenCalledWith(false)
  })

  it('restores raw mode when the alternate-screen write fails during startup', async () => {
    const { input, output } = makeTty()
    vi.spyOn(output, 'write').mockImplementationOnce(() => {
      throw new Error('terminal write failed')
    })
    const tui = new TaskWraithTui({
      clientVersion: '0.1.0-test',
      demo: true,
      colorMode: 'none',
      animationEnabled: false,
      input: input as unknown as ReadStream,
      output: output as unknown as WriteStream
    })

    await expect(tui.start()).rejects.toThrow('terminal write failed')
    expect(input.isRawMode).toBe(false)
    expect(output.frames.join('')).toContain('[?1049l')
  })

  it('rejects start() outside a TTY without ever entering raw mode', async () => {
    const input = new FakeInput()
    const output = new FakeOutput()
    ;(input as unknown as { isTTY: boolean }).isTTY = false
    const tui = new TaskWraithTui({
      clientVersion: '0.1.0-test',
      demo: true,
      colorMode: 'none',
      input: input as unknown as ReadStream,
      output: output as unknown as WriteStream
    })
    await expect(tui.start()).rejects.toThrow(/requires a terminal/i)
    expect(input.isRawMode).toBe(false)
  })
})
