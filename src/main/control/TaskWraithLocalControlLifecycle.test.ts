import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalControlServer } from './LocalControlServer'

const startTaskWraithLocalControl = vi.hoisted(() => vi.fn())

vi.mock('./TaskWraithControlFacade', () => ({
  startTaskWraithLocalControl
}))

import { installTaskWraithLocalControl } from './TaskWraithLocalControlLifecycle'

class FakeApp extends EventEmitter {
  constructor(private readonly userDataPath: string) {
    super()
  }

  getPath(name: string): string {
    if (name !== 'userData') throw new Error(`Unexpected path request: ${name}`)
    return this.userDataPath
  }

  getVersion(): string {
    return '1.9.2-lifecycle-test'
  }
}

const apps: FakeApp[] = []
const servers: LocalControlServer[] = []
const temporaryDirectories: string[] = []

function createApp(userDataPath: string): FakeApp {
  const app = new FakeApp(userDataPath)
  apps.push(app)
  return app
}

async function createTemporaryUserDataPath(suffix = ''): Promise<string> {
  const userDataPath = await mkdtemp(join(tmpdir(), `taskwraith-control-lifecycle-${suffix}`))
  temporaryDirectories.push(userDataPath)
  return userDataPath
}

function connect(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

async function withDeadline<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<T>((resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`Timed out after ${milliseconds}ms`)),
        milliseconds
      )
      work.then(resolve, reject)
    })
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function waitForClose(socket: Socket): Promise<void> {
  if (socket.destroyed) return Promise.resolve()
  return new Promise((resolve) => socket.once('close', () => resolve()))
}

function executorFactory(): never {
  return {
    executeComposerPrompt: vi.fn(),
    executeCancelRun: vi.fn(),
    executeEnsembleSteer: vi.fn(),
    executeEnsembleCancelRound: vi.fn(),
    executeEnsembleRosterUpdate: vi.fn()
  } as never
}

afterEach(async () => {
  while (apps.length) apps.pop()?.emit('will-quit')
  while (servers.length) await servers.pop()?.stop()
  while (temporaryDirectories.length) {
    await rm(temporaryDirectories.pop()!, { recursive: true, force: true })
  }
  startTaskWraithLocalControl.mockReset()
  vi.restoreAllMocks()
})

describe('TaskWraith local-control bootstrap lifecycle', () => {
  it('publishes no dead socket during bootstrap and consumes frames after the first window', async () => {
    const userDataPath = await createTemporaryUserDataPath()
    const app = createApp(userDataPath)
    let server: LocalControlServer | null = null
    startTaskWraithLocalControl.mockImplementation(async (options: { hostVersion: string }) => {
      server = new LocalControlServer({
        userDataPath,
        hostVersion: options.hostVersion,
        facade: {
          snapshot: () => {
            throw new Error('Unauthenticated regression client must not request a snapshot.')
          },
          selectThread: () => {
            throw new Error('Unauthenticated regression client must not select a thread.')
          },
          sendPrompt: async () => {
            throw new Error('Unauthenticated regression client must not send a prompt.')
          },
          cancelRun: async () => {
            throw new Error('Unauthenticated regression client must not cancel a run.')
          },
          threadOffers: () => {
            throw new Error('Unauthenticated regression client must not request offers.')
          },
          toggleEnsembleSeat: async () => {
            throw new Error('Unauthenticated regression client must not configure a seat.')
          }
        }
      })
      servers.push(server)
      await server.start()
      return server
    })

    await installTaskWraithLocalControl(app as never, executorFactory)
    await new Promise((resolve) => setImmediate(resolve))

    expect(startTaskWraithLocalControl).not.toHaveBeenCalled()
    expect(existsSync(join(userDataPath, 'taskwraith-control-v1.json'))).toBe(false)
    expect(existsSync(join(userDataPath, 'taskwraith-control-v1.token'))).toBe(false)

    app.emit('browser-window-created')
    expect(startTaskWraithLocalControl).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(server).not.toBeNull())
    await vi.waitFor(() =>
      expect(existsSync(join(userDataPath, 'taskwraith-control-v1.json'))).toBe(true)
    )

    const socket = await connect(server!.socketPath)
    socket.write('not-json\n')
    await withDeadline(waitForClose(socket), 1_000)
    expect(socket.destroyed).toBe(true)

    app.emit('browser-window-created')
    expect(startTaskWraithLocalControl).toHaveBeenCalledTimes(1)
  })

  it('stops a server whose startup finishes after Electron begins quitting', async () => {
    const userDataPath = await createTemporaryUserDataPath('race-')
    const app = createApp(userDataPath)
    let resolveStart!: (server: LocalControlServer) => void
    const stopSync = vi.fn()
    startTaskWraithLocalControl.mockReturnValue(
      new Promise<LocalControlServer>((resolve) => {
        resolveStart = resolve
      })
    )

    await installTaskWraithLocalControl(app as never, executorFactory)
    app.emit('browser-window-created')
    await vi.waitFor(() => expect(startTaskWraithLocalControl).toHaveBeenCalledTimes(1))
    app.emit('will-quit')
    resolveStart({ stopSync } as unknown as LocalControlServer)

    await vi.waitFor(() => expect(stopSync).toHaveBeenCalledTimes(1))
    app.emit('will-quit')
    expect(stopSync).toHaveBeenCalledTimes(1)
  })

  it('logs one startup failure and does not retry on later windows', async () => {
    const userDataPath = await createTemporaryUserDataPath('failure-')
    const app = createApp(userDataPath)
    const error = new Error('synthetic startup failure')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    startTaskWraithLocalControl.mockRejectedValue(error)

    await installTaskWraithLocalControl(app as never, executorFactory)
    app.emit('browser-window-created')
    app.emit('browser-window-created')

    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(
        'Failed to start TaskWraith local-control sidecar host',
        error
      )
    )
    expect(startTaskWraithLocalControl).toHaveBeenCalledTimes(1)
  })
})
