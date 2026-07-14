import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import * as os from 'os'
import * as pty from 'node-pty'
import { registerPtyHandlers, type PtyHandlerDeps } from './ptyHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

// os is pure JS (no native binary), so the default vitest automock is safe —
// matches the existing TrustStatusService.test.ts convention.
vi.mock('os')

// node-pty ships a native addon. Automocking would still load the real
// module to infer its shape, so use an explicit factory instead — this never
// touches the native binary.
vi.mock('node-pty', () => ({
  spawn: vi.fn()
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
  vi.mocked(os.platform).mockReturnValue('darwin')
  vi.mocked(pty.spawn).mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

type FakeSender = { id: number; send: ReturnType<typeof vi.fn> }
type RegisteredHandler = (event: { sender: FakeSender }, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function makeSender(id = 1): FakeSender {
  return { id, send: vi.fn() }
}

function makeFakePty() {
  let dataCb: ((data: string) => void) | undefined
  let exitCb: ((event: { exitCode: number | null }) => void) | undefined
  return {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn((cb: (data: string) => void) => {
      dataCb = cb
    }),
    onExit: vi.fn((cb: (event: { exitCode: number | null }) => void) => {
      exitCb = cb
    }),
    emitData: (data: string) => dataCb?.(data),
    emitExit: (exitCode: number | null) => exitCb?.({ exitCode })
  }
}

function createDeps() {
  return {
    requireRegisteredWorkspace: vi.fn<PtyHandlerDeps['requireRegisteredWorkspace']>(
      (workspacePath: string) => workspacePath
    ),
    assertSenderWorkspaceScope: vi.fn<PtyHandlerDeps['assertSenderWorkspaceScope']>(),
    requestAgenticServiceApproval: vi.fn<PtyHandlerDeps['requestAgenticServiceApproval']>(
      async () => true
    )
  } satisfies PtyHandlerDeps
}

describe('registerPtyHandlers', () => {
  it('registers the pty IPC channels', () => {
    registerPtyHandlers(createDeps())

    expect(handlerFor('start-pty')).toBeTypeOf('function')
    expect(handlerFor('stop-pty')).toBeTypeOf('function')
    expect(handlerFor('pty-write')).toBeTypeOf('function')
    expect(handlerFor('pty-resize')).toBeTypeOf('function')
  })

  it('denies the terminal and skips spawn when approval is refused', async () => {
    const deps = createDeps()
    vi.mocked(deps.requestAgenticServiceApproval).mockResolvedValue(false)
    registerPtyHandlers(deps)
    const sender = makeSender()

    await handlerFor('start-pty')({ sender }, '/tmp/ws', 'sess-1')

    expect(pty.spawn).not.toHaveBeenCalled()
    expect(sender.send).toHaveBeenCalledWith(
      'pty-data',
      'Terminal start denied by TaskWraith approval policy.\r\n',
      'sess-1'
    )
    expect(sender.send).toHaveBeenCalledWith('pty-exit', -1, 'sess-1')
  })

  it('rejects a secondary renderer targeting another workspace before approval or spawn', async () => {
    const deps = createDeps()
    vi.mocked(deps.assertSenderWorkspaceScope).mockImplementation(() => {
      throw new Error('Renderer workspace ownership does not match this request.')
    })
    registerPtyHandlers(deps)
    const event = { sender: makeSender(42) }

    await expect(handlerFor('start-pty')(event, '/Test 3', 'hostile')).rejects.toThrow(
      'Renderer workspace ownership'
    )
    expect(deps.assertSenderWorkspaceScope).toHaveBeenCalledWith(event, '/Test 3')
    expect(deps.requestAgenticServiceApproval).not.toHaveBeenCalled()
    expect(pty.spawn).not.toHaveBeenCalled()
  })

  it('spawns a pty on approval using the SHELL env var and forwards data/exit events', async () => {
    vi.stubEnv('SHELL', '/bin/zsh')
    const deps = createDeps()
    registerPtyHandlers(deps)
    const sender = makeSender()
    const fakePty = makeFakePty()
    vi.mocked(pty.spawn).mockReturnValue(fakePty as unknown as pty.IPty)

    await handlerFor('start-pty')({ sender }, '/tmp/ws', 'sess-1')

    expect(deps.requireRegisteredWorkspace).toHaveBeenCalledWith('/tmp/ws')
    expect(deps.requestAgenticServiceApproval).toHaveBeenCalledWith(
      sender,
      'gemini',
      'shellCommands',
      '/tmp/ws',
      expect.objectContaining({ method: 'pty/start' })
    )
    expect(pty.spawn).toHaveBeenCalledWith(
      '/bin/zsh',
      [],
      expect.objectContaining({ cwd: '/tmp/ws', cols: 80, rows: 24 })
    )

    fakePty.emitData('hello\n')
    expect(sender.send).toHaveBeenCalledWith('pty-data', 'hello\n', 'sess-1')

    fakePty.emitExit(0)
    expect(sender.send).toHaveBeenCalledWith('pty-exit', 0, 'sess-1')
  })

  it('uses powershell.exe on win32 regardless of the SHELL env var', async () => {
    vi.stubEnv('SHELL', '/bin/zsh')
    vi.mocked(os.platform).mockReturnValue('win32')
    const deps = createDeps()
    registerPtyHandlers(deps)
    const fakePty = makeFakePty()
    vi.mocked(pty.spawn).mockReturnValue(fakePty as unknown as pty.IPty)

    await handlerFor('start-pty')({ sender: makeSender() }, '/tmp/ws')

    expect(pty.spawn).toHaveBeenCalledWith('powershell.exe', [], expect.anything())
  })

  it('kills an existing session before spawning a replacement for the same key', async () => {
    const deps = createDeps()
    registerPtyHandlers(deps)
    const sender = makeSender(7)
    const firstPty = makeFakePty()
    const secondPty = makeFakePty()
    vi.mocked(pty.spawn).mockReturnValueOnce(firstPty as unknown as pty.IPty)
    vi.mocked(pty.spawn).mockReturnValueOnce(secondPty as unknown as pty.IPty)

    await handlerFor('start-pty')({ sender }, '/tmp/ws', 'sess-1')
    await handlerFor('start-pty')({ sender }, '/tmp/ws', 'sess-1')

    expect(firstPty.kill).toHaveBeenCalled()
    expect(pty.spawn).toHaveBeenCalledTimes(2)
  })

  it('skips spawning and reports a null exit when the session is stopped while approval is pending', async () => {
    const deps = createDeps()
    let resolveApproval: (value: boolean) => void = () => {}
    vi.mocked(deps.requestAgenticServiceApproval).mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveApproval = resolve
      })
    )
    registerPtyHandlers(deps)
    const sender = makeSender()

    const startPromise = handlerFor('start-pty')({ sender }, '/tmp/ws', 'sess-1')
    // No live process exists yet (approval hasn't resolved), so stop-pty marks
    // the session as stopped rather than killing a process.
    handlerFor('stop-pty')({ sender }, 'sess-1')
    resolveApproval(true)
    await startPromise

    expect(pty.spawn).not.toHaveBeenCalled()
    expect(sender.send).toHaveBeenCalledWith('pty-exit', null, 'sess-1')
  })

  it('stop-pty kills a live session and removes it from the map', async () => {
    const deps = createDeps()
    registerPtyHandlers(deps)
    const sender = makeSender()
    const fakePty = makeFakePty()
    vi.mocked(pty.spawn).mockReturnValue(fakePty as unknown as pty.IPty)
    await handlerFor('start-pty')({ sender }, '/tmp/ws', 'sess-1')

    handlerFor('stop-pty')({ sender }, 'sess-1')

    expect(fakePty.kill).toHaveBeenCalled()
  })

  it('pty-write forwards data to the live session and no-ops when the session is missing', async () => {
    const deps = createDeps()
    registerPtyHandlers(deps)
    const sender = makeSender()
    const fakePty = makeFakePty()
    vi.mocked(pty.spawn).mockReturnValue(fakePty as unknown as pty.IPty)
    await handlerFor('start-pty')({ sender }, '/tmp/ws', 'sess-1')

    handlerFor('pty-write')({ sender }, 'echo hi\n', 'sess-1')
    expect(fakePty.write).toHaveBeenCalledWith('echo hi\n')

    expect(() =>
      handlerFor('pty-write')({ sender }, 'ignored', 'no-such-session')
    ).not.toThrow()
  })

  it('pty-resize forwards cols/rows to the live session and no-ops when the session is missing', async () => {
    const deps = createDeps()
    registerPtyHandlers(deps)
    const sender = makeSender()
    const fakePty = makeFakePty()
    vi.mocked(pty.spawn).mockReturnValue(fakePty as unknown as pty.IPty)
    await handlerFor('start-pty')({ sender }, '/tmp/ws', 'sess-1')

    handlerFor('pty-resize')({ sender }, 100, 40, 'sess-1')
    expect(fakePty.resize).toHaveBeenCalledWith(100, 40)

    expect(() =>
      handlerFor('pty-resize')({ sender }, 100, 40, 'no-such-session')
    ).not.toThrow()
  })
})
