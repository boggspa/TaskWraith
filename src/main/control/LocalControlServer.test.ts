import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTaskWraithTuiDemoState } from '../../tui/state'
import { TaskWraithControlClient } from '../../tui/client/TaskWraithControlClient'
import { TASKWRAITH_CONTROL_MAX_LINE_BYTES } from '../../shared/taskWraithControlProtocol'
import { LocalControlServer } from './LocalControlServer'

const cleanup: Array<() => Promise<void> | void> = []

function connectRaw(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

function readRawLine(socket: Socket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      socket.off('error', onError)
      socket.off('data', onData)
      try {
        resolve(JSON.parse(buffer.slice(0, newline)))
      } catch (error) {
        reject(error)
      }
    }
    const onError = (error: Error) => {
      socket.off('data', onData)
      reject(error)
    }
    socket.on('data', onData)
    socket.once('error', onError)
  })
}

function waitForRawClose(socket: Socket): Promise<void> {
  if (socket.destroyed || socket.readableEnded) return Promise.resolve()
  return new Promise((resolve) => socket.once('close', () => resolve()))
}

async function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<T>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), ms)
      work.then(resolve, reject)
    })
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function hello(token: string): string {
  return `${JSON.stringify({
    type: 'hello',
    protocolVersion: 1,
    client: 'taskwraith-tui',
    clientVersion: '0.1.0-test',
    token,
    capabilities: []
  })}\n`
}

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.()
})

describe('LocalControlServer', () => {
  it('authenticates a TUI client and delegates only the bounded facade methods', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-control-'))
    const demo = createTaskWraithTuiDemoState(1_000)
    if (!demo.snapshot || !demo.thread) throw new Error('Demo projection is incomplete.')
    const sendPrompt = vi.fn(async () => ({
      dispatched: true,
      message: 'Prompt dispatched'
    }))
    const cancelRun = vi.fn(async () => ({
      cancelled: true,
      message: 'Run cancelled'
    }))
    const threadOffers = vi.fn(() => ({
      threadId: 'demo-thread',
      provider: demo.thread!.thread.provider,
      currentModel: 'claude-opus-4-8-1m',
      models: [
        {
          id: 'claude-opus-4-8-1m',
          label: 'Opus 4.8 1M',
          current: true,
          reasoningEfforts: [{ id: 'medium', isDefault: true }]
        }
      ],
      source: 'curated' as const
    }))
    const toggleEnsembleSeat = vi.fn(async () => ({
      updated: true,
      message: 'Seat updated'
    }))
    const server = new LocalControlServer({
      userDataPath,
      hostVersion: '1.8.9-test',
      pollIntervalMs: 25,
      facade: {
        snapshot: () => demo.snapshot!,
        selectThread: (threadId) => {
          if (threadId !== 'demo-thread') throw new Error('Thread not found.')
          return demo.thread!
        },
        sendPrompt,
        cancelRun,
        threadOffers,
        toggleEnsembleSeat
      }
    })
    await server.start()
    cleanup.push(() => server.stop())

    const client = new TaskWraithControlClient({
      clientVersion: '0.1.0-test',
      userDataPath
    })
    cleanup.push(() => client.close())

    const welcome = await client.connect()
    expect(welcome.hostVersion).toBe('1.8.9-test')
    expect((await client.getSnapshot()).threads[0]?.id).toBe('demo-thread')
    expect((await client.selectThread('demo-thread')).rows).toHaveLength(3)
    await expect(client.sendPrompt('demo-thread', 'hello')).resolves.toMatchObject({
      dispatched: true
    })
    await expect(client.cancelRun('demo-thread')).resolves.toMatchObject({
      cancelled: true
    })
    expect(sendPrompt).toHaveBeenCalledWith('demo-thread', 'hello')
    expect(cancelRun).toHaveBeenCalledWith('demo-thread')

    await expect(client.threadOffers('demo-thread')).resolves.toMatchObject({
      threadId: 'demo-thread',
      models: [expect.objectContaining({ id: 'claude-opus-4-8-1m', current: true })]
    })
    expect(threadOffers).toHaveBeenCalledWith('demo-thread')
    await expect(
      client.sendPrompt('demo-thread', 'tuned', {
        model: 'claude-opus-4-8-1m',
        reasoningEffort: 'medium'
      })
    ).resolves.toMatchObject({ dispatched: true })
    expect(sendPrompt).toHaveBeenLastCalledWith('demo-thread', 'tuned', {
      model: 'claude-opus-4-8-1m',
      reasoningEffort: 'medium'
    })
    await expect(client.toggleEnsembleSeat('demo-thread', 'review', false)).resolves.toMatchObject({
      updated: true
    })
    expect(toggleEnsembleSeat).toHaveBeenCalledWith('demo-thread', 'review', false)

    const tokenMetadata = await stat(server.tokenPath)
    const discoveryMetadata = await stat(server.discoveryPath)
    if (process.platform !== 'win32') {
      const socketMetadata = await stat(server.socketPath)
      expect(socketMetadata.mode & 0o777).toBe(0o600)
      expect((await stat(dirname(server.socketPath))).mode & 0o777).toBe(0o700)
      if (typeof process.getuid === 'function') {
        expect(socketMetadata.uid).toBe(process.getuid())
      }
    }
    expect(tokenMetadata.mode & 0o777).toBe(0o600)
    expect(discoveryMetadata.mode & 0o777).toBe(0o600)
    if (typeof process.getuid === 'function') {
      expect(tokenMetadata.uid).toBe(process.getuid())
      expect(discoveryMetadata.uid).toBe(process.getuid())
    }
    const discovery = JSON.parse(await readFile(server.discoveryPath, 'utf8')) as {
      tokenPath: string
      socketPath: string
    }
    expect(discovery.tokenPath).toBe(server.tokenPath)
    expect(discovery.socketPath).toBe(server.socketPath)
    expect(await readFile(server.tokenPath, 'utf8')).not.toContain('1.8.9-test')

    server.stopSync()
    await expect(stat(server.discoveryPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(server.tokenPath)).rejects.toMatchObject({ code: 'ENOENT' })
    if (process.platform !== 'win32') {
      await expect(stat(server.socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('returns a bounded error instead of writing an oversized projection', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-control-large-'))
    const demo = createTaskWraithTuiDemoState(1_000)
    if (!demo.snapshot || !demo.thread) throw new Error('Demo projection is incomplete.')
    const oversizedSnapshot = {
      ...demo.snapshot,
      workspaces: [
        {
          ...demo.snapshot.workspaces[0],
          name: 'x'.repeat(TASKWRAITH_CONTROL_MAX_LINE_BYTES + 1)
        }
      ]
    }
    const server = new LocalControlServer({
      userDataPath,
      hostVersion: '1.8.9-test',
      pollIntervalMs: 25,
      facade: {
        snapshot: () => oversizedSnapshot,
        selectThread: () => demo.thread!,
        sendPrompt: async () => ({ dispatched: true, message: 'ok' }),
        cancelRun: async () => ({ cancelled: true, message: 'ok' }),
        threadOffers: () => {
          throw new Error('offers not stubbed')
        },
        toggleEnsembleSeat: async () => ({ updated: false, message: 'not stubbed' })
      }
    })
    await server.start()
    cleanup.push(() => server.stop())

    const client = new TaskWraithControlClient({
      clientVersion: '0.1.0-test',
      userDataPath
    })
    cleanup.push(() => client.close())
    await client.connect()

    await expect(client.getSnapshot()).rejects.toThrow('projection is too large')
    await expect(client.ping()).resolves.toHaveProperty('now')
  })

  it('rejects unauthenticated, malformed, and oversized client frames', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-control-frames-'))
    const demo = createTaskWraithTuiDemoState(1_000)
    if (!demo.snapshot || !demo.thread) throw new Error('Demo projection is incomplete.')
    const server = new LocalControlServer({
      userDataPath,
      hostVersion: '1.9.1-test',
      facade: {
        snapshot: () => demo.snapshot!,
        selectThread: () => demo.thread!,
        sendPrompt: async () => ({ dispatched: true, message: 'ok' }),
        cancelRun: async () => ({ cancelled: true, message: 'ok' }),
        threadOffers: () => {
          throw new Error('offers not stubbed')
        },
        toggleEnsembleSeat: async () => ({ updated: false, message: 'not stubbed' })
      }
    })
    await server.start()
    cleanup.push(() => server.stop())
    const token = (await readFile(server.tokenPath, 'utf8')).trim()

    const rejected = await connectRaw(server.socketPath)
    const rejectedClose = waitForRawClose(rejected)
    rejected.write(hello('not-the-token'))
    await rejectedClose

    const invalidRequest = await connectRaw(server.socketPath)
    invalidRequest.write(hello(token))
    await expect(readRawLine(invalidRequest)).resolves.toMatchObject({ type: 'welcome' })
    invalidRequest.write(
      `${JSON.stringify({
        type: 'request',
        id: 'bad-request',
        method: 'thread.delete',
        params: {}
      })}\n`
    )
    await expect(readRawLine(invalidRequest)).resolves.toMatchObject({
      type: 'response',
      id: 'bad-request',
      ok: false,
      error: { code: 'invalid_request', message: 'unknown request method' }
    })
    invalidRequest.write(
      `${JSON.stringify({
        type: 'request',
        id: 'bad-seat-toggle',
        method: 'ensemble.seat.toggle',
        params: { threadId: 'demo-thread', participantId: 'lead', enabled: 'yes' }
      })}\n`
    )
    await expect(readRawLine(invalidRequest)).resolves.toMatchObject({
      type: 'response',
      id: 'bad-seat-toggle',
      ok: false,
      error: { code: 'invalid_request', message: 'enabled must be a boolean' }
    })
    invalidRequest.write(
      `${JSON.stringify({
        type: 'request',
        id: 'bad-selection',
        method: 'composer.send',
        params: { threadId: 'demo-thread', text: 'hi', model: 42 }
      })}\n`
    )
    await expect(readRawLine(invalidRequest)).resolves.toMatchObject({
      type: 'response',
      id: 'bad-selection',
      ok: false,
      error: { code: 'invalid_request', message: 'model must be a bounded string' }
    })
    invalidRequest.destroy()

    const malformed = await connectRaw(server.socketPath)
    const malformedClose = waitForRawClose(malformed)
    malformed.write('{ definitely-not-json\n')
    await malformedClose

    const oversized = await connectRaw(server.socketPath)
    const oversizedClose = waitForRawClose(oversized)
    oversized.write(`${'x'.repeat(TASKWRAITH_CONTROL_MAX_LINE_BYTES + 1)}\n`)
    await oversizedClose
  })

  it('lets clients time out a stalled projection while keeping the control socket responsive', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-control-timeout-'))
    const never = new Promise<never>(() => {})
    const server = new LocalControlServer({
      userDataPath,
      hostVersion: '1.9.1-test',
      facade: {
        snapshot: () => never,
        selectThread: () => never,
        sendPrompt: async () => ({ dispatched: true, message: 'ok' }),
        cancelRun: async () => ({ cancelled: true, message: 'ok' }),
        threadOffers: () => {
          throw new Error('offers not stubbed')
        },
        toggleEnsembleSeat: async () => ({ updated: false, message: 'not stubbed' })
      }
    })
    await server.start()
    cleanup.push(() => server.stop())
    const client = new TaskWraithControlClient({
      clientVersion: '0.1.0-test',
      userDataPath,
      requestTimeoutMs: 15
    })
    cleanup.push(() => client.close())
    await client.connect()

    await expect(client.getSnapshot()).rejects.toThrow('host request timed out: snapshot.get')
    await expect(client.ping()).resolves.toHaveProperty('now')
  })

  it('publishes snapshot and selected-thread changes without leaking its token', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-control-events-'))
    const demo = createTaskWraithTuiDemoState(1_000)
    if (!demo.snapshot || !demo.thread) throw new Error('Demo projection is incomplete.')
    let snapshot = demo.snapshot
    let thread = demo.thread
    const log = vi.fn()
    const server = new LocalControlServer({
      userDataPath,
      hostVersion: '1.9.1-test',
      pollIntervalMs: 10,
      log,
      facade: {
        snapshot: () => snapshot,
        selectThread: () => thread,
        sendPrompt: async () => ({ dispatched: true, message: 'ok' }),
        cancelRun: async () => ({ cancelled: true, message: 'ok' }),
        threadOffers: () => {
          throw new Error('offers not stubbed')
        },
        toggleEnsembleSeat: async () => ({ updated: false, message: 'not stubbed' })
      }
    })
    await server.start()
    cleanup.push(() => server.stop())
    const token = (await readFile(server.tokenPath, 'utf8')).trim()
    const discovery = await readFile(server.discoveryPath, 'utf8')
    expect(discovery).not.toContain(token)
    expect(log.mock.calls.flat().join('\n')).not.toContain(token)
    expect(process.argv.join('\u0000')).not.toContain(token)

    const client = new TaskWraithControlClient({
      clientVersion: '0.1.0-test',
      userDataPath
    })
    cleanup.push(() => client.close())
    const snapshots: string[] = []
    const threads: string[] = []
    client.on('snapshot', (next) => snapshots.push(next.threads[0]?.title ?? ''))
    client.on('thread', (next) => threads.push(next.rows[0]?.text ?? ''))
    await client.connect()
    await client.selectThread('demo-thread')

    snapshot = {
      ...snapshot,
      threads: snapshot.threads.map((entry) =>
        entry.id === 'demo-thread' ? { ...entry, title: 'Updated thread' } : entry
      )
    }
    thread = {
      ...thread,
      rows: [{ ...thread.rows[0]!, text: 'Updated transcript row' }, ...thread.rows.slice(1)]
    }
    await vi.waitFor(() => expect(snapshots).toContain('Updated thread'), { timeout: 500 })
    await vi.waitFor(() => expect(threads).toContain('Updated transcript row'), { timeout: 500 })
  })

  it('replaces stale discovery artifacts, refuses a live host, and applies client bounds', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-control-discovery-'))
    const demo = createTaskWraithTuiDemoState(1_000)
    if (!demo.snapshot || !demo.thread) throw new Error('Demo projection is incomplete.')
    const createServer = (maxClients?: number) =>
      new LocalControlServer({
        userDataPath,
        hostVersion: '1.9.1-test',
        maxClients,
        facade: {
          snapshot: () => demo.snapshot!,
          selectThread: () => demo.thread!,
          sendPrompt: async () => ({ dispatched: true, message: 'ok' }),
          cancelRun: async () => ({ cancelled: true, message: 'ok' }),
          threadOffers: () => {
            throw new Error('offers not stubbed')
          },
          toggleEnsembleSeat: async () => ({ updated: false, message: 'not stubbed' })
        }
      })

    const stale = createServer(1)
    if (process.platform !== 'win32') {
      await mkdir(dirname(stale.socketPath), { recursive: true })
      await writeFile(stale.socketPath, 'stale socket')
    }
    await writeFile(stale.discoveryPath, 'stale discovery')
    await writeFile(stale.tokenPath, 'stale token')
    await withDeadline(stale.start(), 1_000, 'Stale discovery replacement did not settle.')
    expect(await readFile(stale.discoveryPath, 'utf8')).not.toBe('stale discovery')
    expect(await readFile(stale.tokenPath, 'utf8')).not.toBe('stale token')

    const competing = createServer()
    await expect(
      withDeadline(competing.start(), 500, 'Live socket ownership check did not settle.')
    ).rejects.toThrow('already owned by a live host')
    await new Promise((resolve) => setTimeout(resolve, 20))

    const first = await withDeadline(
      connectRaw(stale.socketPath),
      500,
      'First bounded client did not connect.'
    )
    first.write(hello((await readFile(stale.tokenPath, 'utf8')).trim()))
    await expect(readRawLine(first)).resolves.toMatchObject({ type: 'welcome' })
    const second = await withDeadline(
      connectRaw(stale.socketPath),
      500,
      'Second bounded client did not connect.'
    )
    const secondClose = waitForRawClose(second)
    await withDeadline(secondClose, 250, 'Bounded client connection did not close.')
    const firstClose = waitForRawClose(first)
    first.destroy()
    await firstClose
    await withDeadline(stale.stop(), 500, 'Control server shutdown did not settle.')
  })
})
