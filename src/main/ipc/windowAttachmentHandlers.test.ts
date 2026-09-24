import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import {
  registerWindowAttachmentHandlers,
  type StickyAppWatchStoreLike,
  type WindowAttachmentCoordinatorLike,
  type WindowAttachmentDaemonLike,
  type WindowAttachmentHandlersDeps
} from './windowAttachmentHandlers'
import type { NativeCapabilitySnapshot } from '../NativeCapabilities'
import type { ScopedAttachedWindowSnapshot } from '../nativeWindow/ScopedAttachedWindowState'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

const EVENT = { sender: { id: 1 } }

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([name]) => name === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function attachedWindow(generation: number, streaming: boolean): ScopedAttachedWindowSnapshot {
  return {
    generation,
    ...(streaming
      ? {
          streaming: { fps: 5, bufferSeconds: 10, frameCount: 3, startedAt: '2026-01-01T00:00:00Z' }
        }
      : {})
  } as unknown as ScopedAttachedWindowSnapshot
}

function createCoordinator() {
  return {
    pick: vi.fn(async () => ({ picked: 'window' })),
    detach: vi.fn(async () => true),
    controlSession: vi.fn(async () => ({ state: 'paused' })),
    statusForChat: vi.fn(() => ({ state: 'attached' })),
    getForChat: vi.fn((): ScopedAttachedWindowSnapshot | null => null),
    observationAccessForChat: vi.fn(() => ({ scopeID: 'scope-1' }))
  }
}

function createDaemon() {
  return {
    status: vi.fn(() => ({ running: true })),
    request: vi.fn(async () => ({ hasFrame: false }))
  }
}

function createStore() {
  return {
    get: vi.fn(async () => null),
    stash: vi.fn(async () => undefined),
    clear: vi.fn(async () => true)
  }
}

function capabilities(available: boolean, reason?: string): NativeCapabilitySnapshot {
  return { screenWatch: { available, ...(reason ? { reason } : {}) } } as NativeCapabilitySnapshot
}

function createDeps(overrides: Partial<WindowAttachmentHandlersDeps> = {}) {
  const coordinator = createCoordinator()
  const daemon = createDaemon()
  const stickyAppWatchStore = createStore()
  const deps: WindowAttachmentHandlersDeps = {
    assertSenderChatScope: vi.fn(),
    getNativeCapabilities: vi.fn(() => capabilities(true)),
    getNativeWindowCoordinator: vi.fn(
      () => coordinator as unknown as WindowAttachmentCoordinatorLike
    ),
    getBridgeDaemon: vi.fn(() => daemon as unknown as WindowAttachmentDaemonLike),
    stickyAppWatchStore: stickyAppWatchStore as unknown as StickyAppWatchStoreLike,
    ...overrides
  }
  return { deps, coordinator, daemon, stickyAppWatchStore }
}

describe('registerWindowAttachmentHandlers', () => {
  it('registers every window-attachment channel once, in composition-root order', () => {
    const { deps } = createDeps()
    registerWindowAttachmentHandlers(deps)

    expect(mockedHandle.mock.calls.map(([channel]) => channel)).toEqual([
      'attach-window:pick',
      'attach-window:detach',
      'attach-window:control-session',
      'attach-window:status',
      'attach-window:preview-frame',
      'sticky-appwatch:get',
      'sticky-appwatch:stash',
      'sticky-appwatch:clear'
    ])
  })

  it('refuses a pick when Screen Watch is unavailable, surfacing the capability reason', async () => {
    const { deps, coordinator } = createDeps({
      getNativeCapabilities: vi.fn(() => capabilities(false, 'This Mac is too old.'))
    })
    registerWindowAttachmentHandlers(deps)

    await expect(handlerFor('attach-window:pick')(EVENT, 'chat-1')).rejects.toThrow(
      'This Mac is too old.'
    )
    expect(coordinator.pick).not.toHaveBeenCalled()
  })

  it('asserts sender chat scope before reaching the coordinator', async () => {
    const { deps, coordinator } = createDeps()
    vi.mocked(deps.assertSenderChatScope).mockImplementation(() => {
      throw new Error('Renderer is not authorized for chat IPC.')
    })
    registerWindowAttachmentHandlers(deps)

    await expect(handlerFor('attach-window:pick')(EVENT, 'chat-1')).rejects.toThrow(
      'Renderer is not authorized for chat IPC.'
    )
    expect(coordinator.pick).not.toHaveBeenCalled()
  })

  it('rejects an empty chat id before any coordinator work', async () => {
    const { deps, coordinator } = createDeps()
    registerWindowAttachmentHandlers(deps)

    await expect(handlerFor('attach-window:pick')(EVENT, '   ')).rejects.toThrow(
      'Chat is required.'
    )
    expect(deps.assertSenderChatScope).not.toHaveBeenCalled()
    expect(coordinator.pick).not.toHaveBeenCalled()
  })

  it('reads the coordinator ref at invocation time, not registration time', () => {
    let liveCoordinator: WindowAttachmentCoordinatorLike | null = null
    const coordinator = createCoordinator()
    const { deps } = createDeps({ getNativeWindowCoordinator: vi.fn(() => liveCoordinator) })
    registerWindowAttachmentHandlers(deps)

    expect(() => handlerFor('attach-window:status')(EVENT, 'chat-1')).toThrow(
      'Native-window coordination is not ready.'
    )

    liveCoordinator = coordinator as unknown as WindowAttachmentCoordinatorLike
    expect(handlerFor('attach-window:status')(EVENT, 'chat-1')).toEqual({ state: 'attached' })
    expect(deps.getNativeWindowCoordinator).toHaveBeenCalledTimes(2)
  })

  it('rejects a non-positive-integer attachment generation before detaching', async () => {
    const { deps, coordinator } = createDeps()
    registerWindowAttachmentHandlers(deps)

    await expect(handlerFor('attach-window:detach')(EVENT, 'chat-1', 0)).rejects.toThrow(
      'Attachment generation must be a positive integer.'
    )
    await expect(handlerFor('attach-window:detach')(EVENT, 'chat-1', 1.5)).rejects.toThrow(
      'Attachment generation must be a positive integer.'
    )
    expect(coordinator.detach).not.toHaveBeenCalled()
  })

  it('returns the detach outcome alongside the refreshed status', async () => {
    const { deps, coordinator } = createDeps()
    registerWindowAttachmentHandlers(deps)

    await expect(handlerFor('attach-window:detach')(EVENT, 'chat-1', 4)).resolves.toEqual({
      detached: true,
      status: { state: 'attached' }
    })
    expect(coordinator.detach).toHaveBeenCalledWith('chat-1', 4)
  })

  it('rejects an unknown App Drive session action', async () => {
    const { deps, coordinator } = createDeps()
    registerWindowAttachmentHandlers(deps)

    await expect(
      handlerFor('attach-window:control-session')(EVENT, 'chat-1', 'teleport')
    ).rejects.toThrow('Unknown App Drive session action.')
    expect(coordinator.controlSession).not.toHaveBeenCalled()

    await expect(
      handlerFor('attach-window:control-session')(EVENT, 'chat-1', 'takeover')
    ).resolves.toEqual({ state: 'paused' })
    expect(coordinator.controlSession).toHaveBeenCalledWith('chat-1', 'takeover')
  })

  it('refuses a preview frame with no attachment instead of throwing', async () => {
    const { deps, daemon } = createDeps({ getNativeWindowCoordinator: vi.fn(() => null) })
    registerWindowAttachmentHandlers(deps)

    await expect(handlerFor('attach-window:preview-frame')(EVENT, 'chat-1')).resolves.toEqual({
      ok: false,
      reason: 'no_attachment'
    })
    expect(daemon.request).not.toHaveBeenCalled()
  })

  it('costs no daemon request while the attachment is not streaming', async () => {
    const { deps, coordinator, daemon } = createDeps()
    coordinator.getForChat.mockReturnValue(attachedWindow(2, false))
    registerWindowAttachmentHandlers(deps)

    await expect(handlerFor('attach-window:preview-frame')(EVENT, 'chat-1')).resolves.toEqual({
      ok: false,
      reason: 'no_frame'
    })
    expect(daemon.request).not.toHaveBeenCalled()
  })

  it('refuses a frame captured under a superseded generation', async () => {
    const { deps, coordinator, daemon } = createDeps()
    coordinator.getForChat
      .mockReturnValueOnce(attachedWindow(2, true))
      .mockReturnValueOnce(attachedWindow(3, true))
    daemon.request.mockResolvedValue({ hasFrame: true } as never)
    registerWindowAttachmentHandlers(deps)

    await expect(handlerFor('attach-window:preview-frame')(EVENT, 'chat-1')).resolves.toEqual({
      ok: false,
      reason: 'no_attachment'
    })
    expect(daemon.request).toHaveBeenCalledWith(
      'appwatch.latestFrame',
      { scopeID: 'scope-1' },
      { timeoutMs: 10_000 }
    )
  })

  it('never surfaces a daemon failure as a failed preview IPC', async () => {
    const { deps, coordinator, daemon } = createDeps()
    coordinator.getForChat.mockReturnValue(attachedWindow(2, true))
    daemon.request.mockRejectedValue(new Error('daemon exploded') as never)
    registerWindowAttachmentHandlers(deps)

    await expect(handlerFor('attach-window:preview-frame')(EVENT, 'chat-1')).resolves.toEqual({
      ok: false,
      reason: 'no_frame'
    })
  })

  it('stashes sticky AppWatch metadata under the canonical chat id', async () => {
    const { deps, stickyAppWatchStore } = createDeps()
    registerWindowAttachmentHandlers(deps)

    await expect(
      handlerFor('sticky-appwatch:stash')(EVENT, {
        chatId: 'chat-9',
        windowMeta: { title: 'Notes', bundleID: 'com.apple.Notes', applicationName: 'Notes' },
        attachedAt: '2026-01-01T00:00:00.000Z',
        wasStreaming: true
      })
    ).resolves.toEqual({ ok: true })

    expect(deps.assertSenderChatScope).toHaveBeenCalledWith(EVENT, 'chat-9')
    expect(stickyAppWatchStore.stash).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-9',
        windowMeta: { title: 'Notes', bundleID: 'com.apple.Notes', applicationName: 'Notes' },
        attachedAt: '2026-01-01T00:00:00.000Z',
        wasStreaming: true
      })
    )
  })

  it('reads and clears sticky AppWatch snapshots through the store', async () => {
    const { deps, stickyAppWatchStore } = createDeps()
    registerWindowAttachmentHandlers(deps)

    await expect(handlerFor('sticky-appwatch:get')(EVENT, 'chat-9')).resolves.toEqual({
      snapshot: null
    })
    expect(stickyAppWatchStore.get).toHaveBeenCalledWith('chat-9')

    await expect(handlerFor('sticky-appwatch:clear')(EVENT, 'chat-9')).resolves.toEqual({
      ok: true
    })
    expect(stickyAppWatchStore.clear).toHaveBeenCalledWith('chat-9')
  })
})
