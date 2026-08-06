import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReadStream, WriteStream } from 'node:tty'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HOST_PROTOCOL_VERSION,
  HOST_PROJECTION_VERSION,
  createEmptyHostSnapshot,
  type HostBootstrapWelcome,
  type HostSnapshot
} from '../shared/hostProtocol'
import {
  HOST_LOCAL_TRANSPORT_VERSION,
  type HostLocalTransportHostFrame
} from '../shared/hostProtocolTransport'
import { stripAnsi } from './ansi'
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
 * Fake Host v2 — TCP loopback (sandbox-safe) + Host local transport
 * ---------------------------------------------------------------------- */

interface FakeHostHandlers {
  snapshot: () => HostSnapshot
}

class FakeHostV2 {
  readonly userDataPath: string
  readonly discoveryPath: string
  readonly tokenPath: string
  readonly token = 'tui-test-host-token-0123456789abcdef'
  private server: Server | null = null
  private readonly sockets = new Set<Socket>()
  private socketPath = ''
  handlers: FakeHostHandlers

  constructor(userDataPath: string, handlers: FakeHostHandlers) {
    this.userDataPath = userDataPath
    this.discoveryPath = join(userDataPath, 'taskwraith-host-v2.json')
    this.tokenPath = join(userDataPath, 'taskwraith-host-v2.token')
    this.handlers = handlers
  }

  async start(): Promise<void> {
    const server = createServer((socket) => this.accept(socket))
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Fake Host failed to bind a TCP loopback port.')
    }
    this.socketPath = `127.0.0.1:${address.port}`
    await writeFile(this.tokenPath, `${this.token}\n`, 'utf8')
    await writeFile(
      this.discoveryPath,
      JSON.stringify({
        protocolVersion: 2,
        socketPath: this.socketPath,
        tokenPath: this.tokenPath,
        pid: process.pid,
        startedAt: new Date(0).toISOString()
      }),
      'utf8'
    )
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  dropAllClients(): void {
    for (const socket of this.sockets) socket.destroy()
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
    socket.on('close', () => this.sockets.delete(socket))
    socket.on('error', () => {})
  }

  private onLine(socket: Socket, line: string): void {
    const message = JSON.parse(line) as Record<string, unknown>
    if (message.type === 'hello') {
      if (message.token !== this.token) {
        socket.destroy()
        return
      }
      const welcome: HostBootstrapWelcome = {
        type: 'host.welcome',
        protocolVersion: HOST_PROTOCOL_VERSION,
        controlProtocolCompat: 1,
        projectionVersion: HOST_PROJECTION_VERSION,
        hostId: 'fake-host',
        hostVersion: '1.9.1-preview',
        sessionId: 'fake-session',
        generation: 3,
        cursor: 9,
        authenticatedClient: {
          clientId: 'tui-test',
          clientClass: 'tui',
          clientVersion: '0.1.0-test'
        },
        capabilities: ['bootstrap', 'snapshot', 'health'],
        freshness: 'live'
      }
      this.write(socket, {
        type: 'welcome',
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        welcome
      })
      return
    }
    if (message.type !== 'request') return
    const id = String(message.id)
    const kind = String(message.kind)
    if (kind === 'snapshot.get') {
      this.write(socket, {
        type: 'response',
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        id,
        ok: true,
        result: {
          kind: 'snapshot.get',
          frame: {
            type: 'host.snapshot',
            protocolVersion: HOST_PROTOCOL_VERSION,
            snapshot: this.handlers.snapshot()
          }
        }
      })
      return
    }
    this.write(socket, {
      type: 'response',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      id,
      ok: false,
      error: { code: 'unsupported_kind' }
    })
  }

  private write(socket: Socket, frame: HostLocalTransportHostFrame): void {
    if (socket.destroyed) return
    socket.write(`${JSON.stringify(frame)}\n`)
  }
}

function makeHostSnapshot(overrides?: Partial<HostSnapshot>): HostSnapshot {
  const base = createEmptyHostSnapshot({
    generation: 3,
    cursor: 9,
    freshness: 'live',
    generatedAt: new Date(0).toISOString()
  })
  return {
    ...base,
    workspaces: [
      {
        id: 'ws-1',
        name: 'AGBench',
        path: '/tmp/agbench',
        pinned: true,
        updatedAt: 0
      }
    ],
    providers: [
      {
        providerId: 'claude',
        displayProvider: 'Claude',
        modelId: 'sonnet-5',
        modelLabel: 'Sonnet 5',
        shortCode: 'CLD',
        hueKey: 'claude',
        available: true
      }
    ],
    threads: [
      {
        id: 'thread-1',
        workspaceId: 'ws-1',
        title: 'Solo thread',
        chatKind: 'single',
        archived: false,
        pinned: false,
        updatedAt: 10,
        messageCount: 1,
        providerId: 'claude',
        latestPreview: 'Hello TaskWraith',
        previewTruncated: false
      }
    ],
    usage: { availability: 'unavailable', confidence: 'unknown', band: 'unknown' },
    ...overrides
  }
}

async function setupHost(snapshot: HostSnapshot = makeHostSnapshot()): Promise<{
  host: FakeHostV2
  userDataPath: string
}> {
  const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-host-v2-'))
  const host = new FakeHostV2(userDataPath, { snapshot: () => snapshot })
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

describe('TaskWraithTui Host projection (Wave 4.2a)', () => {
  it('connects over Host v2, loads one snapshot, auto-selects the newest thread, and refuses commands', async () => {
    const { host, userDataPath } = await setupHost()
    const { tui, input, output } = startTui(userDataPath)

    await tui.start()
    await waitFor(() => output.lastFrame.includes('Solo thread'), 'thread auto-selected')
    expect(output.lastFrame).toContain('Hello TaskWraith')
    expect(output.lastFrame).toContain('Host preview only')

    feed(input, 'ship the preview')
    feed(input, '\r')
    await waitFor(
      () => output.lastFrame.includes('read-only') || output.lastFrame.includes('Wave 4.2b'),
      'composer refused as read-only'
    )

    feed(input, '/cancel\r')
    await waitFor(
      () => output.lastFrame.includes('read-only') || output.lastFrame.includes('Wave 4.2b'),
      'cancel refused as read-only'
    )

    host.dropAllClients()
    await host.stop()
    await waitFor(
      () => output.lastFrame.includes('disconnected') || output.lastFrame.includes('reconnecting'),
      'disconnect surfaced'
    )

    const revived = new FakeHostV2(userDataPath, {
      snapshot: () =>
        makeHostSnapshot({
          threads: [
            {
              id: 'thread-1',
              workspaceId: 'ws-1',
              title: 'Solo thread (revived)',
              chatKind: 'single',
              archived: false,
              pinned: false,
              updatedAt: 20,
              messageCount: 1,
              providerId: 'claude',
              latestPreview: 'Hello again',
              previewTruncated: false
            }
          ]
        })
    })
    await revived.start()
    cleanup.push(() => revived.stop())
    await waitFor(
      () => output.lastFrame.includes('Solo thread (revived)'),
      'reconnected to the revived Host',
      5_000
    )
  }, 12_000)

  it('shows the "Open TaskWraith to answer" plain-text attention state from Host run evidence', async () => {
    const snapshot = makeHostSnapshot({
      runs: [
        {
          runId: 'run-1',
          threadId: 'thread-1',
          providerId: 'claude',
          providerOutcome: 'requires_action'
        }
      ]
    })
    const { userDataPath } = await setupHost(snapshot)
    const { tui, output } = startTui(userDataPath)

    await tui.start()
    const start = Date.now()
    while (Date.now() - start < 4_000 && !output.lastFrame.includes('Open TaskWraith to answer')) {
      output.emit('resize')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(output.lastFrame).toContain('Open TaskWraith to answer')
    expect(output.lastFrame).not.toMatch(/spinner|working…/i)
  }, 6_000)

  it('reports a missing thread without crashing when the initial thread id no longer exists', async () => {
    const { userDataPath } = await setupHost(
      makeHostSnapshot({
        threads: [
          {
            id: 'other-thread',
            workspaceId: 'ws-1',
            title: 'Other',
            chatKind: 'single',
            archived: false,
            pinned: false,
            updatedAt: 1,
            messageCount: 0,
            providerId: 'claude'
          }
        ]
      })
    )
    const { input, output } = makeTty()
    const tui = new TaskWraithTui({
      clientVersion: '0.1.0-test',
      userDataPath,
      initialThreadId: 'missing-thread',
      colorMode: 'none',
      animationEnabled: false,
      input: input as unknown as ReadStream,
      output: output as unknown as WriteStream
    })
    cleanup.push(() => tui.stop())
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Other'), 'falls back to available thread')
  })

  it('accepts bracketed-paste text as a single composer insertion including embedded line breaks', async () => {
    const { userDataPath } = await setupHost()
    const { tui, input, output } = startTui(userDataPath)
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Solo thread'), 'connected')
    feed(input, '\u001b[200~line one\nline two\u001b[201~')
    await waitFor(() => output.lastFrame.includes('line one'), 'paste inserted')
    expect(output.lastFrame).toContain('line two')
  })
})

describe('TaskWraithTui terminal restoration', () => {
  it('restores raw mode and the primary screen buffer on stop()', async () => {
    const { input, output } = makeTty()
    const tui = new TaskWraithTui({
      clientVersion: '0.1.0-test',
      demo: true,
      colorMode: 'none',
      animationEnabled: false,
      input: input as unknown as ReadStream,
      output: output as unknown as WriteStream
    })
    await tui.start()
    expect(input.isRawMode).toBe(true)
    expect(output.frames.some((frame) => frame.includes('\u001b[?1049h'))).toBe(true)
    tui.stop()
    expect(input.isRawMode).toBe(false)
    expect(output.frames.at(-1) ?? '').toContain('\u001b[?1049l')
  })

  it('restores the terminal even when startup fails after raw mode is entered', async () => {
    const { input, output } = makeTty()
    const write = output.write.bind(output)
    let writes = 0
    output.write = (chunk: string) => {
      writes += 1
      if (writes === 1) {
        write(chunk)
        throw new Error('forced render failure')
      }
      return write(chunk)
    }
    const tui = new TaskWraithTui({
      clientVersion: '0.1.0-test',
      demo: true,
      colorMode: 'none',
      animationEnabled: false,
      input: input as unknown as ReadStream,
      output: output as unknown as WriteStream
    })
    await expect(tui.start()).rejects.toThrow(/forced render failure/)
    expect(input.isRawMode).toBe(false)
  })

  it('restores raw mode when the alternate-screen write fails during startup', async () => {
    const { input, output } = makeTty()
    output.write = () => {
      throw new Error('alternate screen failed')
    }
    const tui = new TaskWraithTui({
      clientVersion: '0.1.0-test',
      demo: true,
      colorMode: 'none',
      animationEnabled: false,
      input: input as unknown as ReadStream,
      output: output as unknown as WriteStream
    })
    await expect(tui.start()).rejects.toThrow(/alternate screen failed/)
    expect(input.isRawMode).toBe(false)
  })

  it('rejects start() outside a TTY without ever entering raw mode', async () => {
    const input = new FakeInput()
    input.isTTY = false as unknown as true
    const output = new FakeOutput()
    output.isTTY = false as unknown as true
    const tui = new TaskWraithTui({
      clientVersion: '0.1.0-test',
      demo: true,
      colorMode: 'none',
      animationEnabled: false,
      input: input as unknown as ReadStream,
      output: output as unknown as WriteStream
    })
    await expect(tui.start()).rejects.toThrow(/requires a terminal/)
    expect(input.isRawMode).toBe(false)
  })
})
