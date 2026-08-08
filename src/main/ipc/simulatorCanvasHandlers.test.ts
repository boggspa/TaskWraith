import { describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { SIMULATOR_VIEW_CONTROL_REQUIRED } from '../../shared/simulatorCanvas'
import { SIMULATOR_HUMAN_CONTROLLER_RUN_ID } from '../simulator/SimulatorControllerLease'
import { SimulatorSessionStore } from '../simulator/SimulatorSessionStore'
import { registerSimulatorCanvasHandlers } from './simulatorCanvasHandlers'

describe('registerSimulatorCanvasHandlers', () => {
  it('registers host + interaction channels and auto-claims human control on mutate', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      })
    } as unknown as IpcMain

    const hostControl = {
      status: vi.fn(async () => ({ installed: true, platform: 'darwin' })),
      openSimulatorApp: vi.fn(async () => ({ ok: true })),
      listDevices: vi.fn(async () => ({ ok: true, devices: [] })),
      boot: vi.fn(async () => ({ ok: true, udid: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA' })),
      install: vi.fn(async () => ({ ok: true })),
      launch: vi.fn(async () => ({ ok: true })),
      terminate: vi.fn(async () => ({ ok: true })),
      screenshot: vi.fn(async () => ({
        ok: true,
        frame: { pngBase64: 'aa', width: 1, height: 1 }
      }))
    }
    const claimHuman = vi.fn((chatId: string) => ({
      ok: true as const,
      token: {
        tokenId: 'human-tok',
        chatId,
        runId: SIMULATOR_HUMAN_CONTROLLER_RUN_ID,
        kind: 'human' as const,
        mintedAt: 1,
        updatedAt: 1
      }
    }))
    const interaction = {
      interactionStatus: vi.fn(() => ({
        canControl: false,
        actuationReady: false,
        reason: SIMULATOR_VIEW_CONTROL_REQUIRED,
        hasObservation: true
      })),
      tap: vi.fn(async () => ({ ok: false, error: SIMULATOR_VIEW_CONTROL_REQUIRED })),
      type: vi.fn(async () => ({ ok: false, error: SIMULATOR_VIEW_CONTROL_REQUIRED })),
      scroll: vi.fn(async () => ({ ok: false, error: SIMULATOR_VIEW_CONTROL_REQUIRED }))
    }

    const idb = {
      isAvailable: vi.fn(() => true),
      companionAvailable: vi.fn(() => true),
      describeAll: vi.fn(async () => ({
        ok: true,
        tree: [{ AXLabel: 'Home' }],
        truncated: false
      })),
      hardwareButton: vi.fn(async () => ({ ok: true, stdout: '', stderr: '' })),
      rotate: vi.fn(async () => ({ ok: true, stdout: '', stderr: '' }))
    }

    const release = vi.fn((input: { chatId: string; runId: string }) => ({
      ok: true as const,
      token: {
        tokenId: 'human-tok',
        chatId: input.chatId,
        runId: SIMULATOR_HUMAN_CONTROLLER_RUN_ID,
        kind: 'human' as const,
        mintedAt: 1,
        updatedAt: 1
      }
    }))

    registerSimulatorCanvasHandlers(ipcMain, {
      getHostControl: () => hostControl as never,
      getControllerLease: () => ({ claimHuman, peek: () => null, release }),
      getInteraction: () => interaction,
      getIdb: () => idb
    })

    const expected = [
      'simulator-canvas:status',
      'simulator-canvas:claim-control',
      'simulator-canvas:release-control',
      'simulator-canvas:session',
      'simulator-canvas:open-app',
      'simulator-canvas:list-devices',
      'simulator-canvas:boot',
      'simulator-canvas:pick-app',
      'simulator-canvas:install',
      'simulator-canvas:launch',
      'simulator-canvas:terminate',
      'simulator-canvas:screenshot',
      'simulator-canvas:interaction-status',
      'simulator-canvas:tap',
      'simulator-canvas:type',
      'simulator-canvas:scroll',
      'simulator-canvas:inspect',
      'simulator-canvas:button',
      'simulator-canvas:rotate'
    ]
    expect([...handlers.keys()].sort()).toEqual([...expected].sort())

    const event = {} as IpcMainInvokeEvent
    expect(await handlers.get('simulator-canvas:status')?.(event)).toEqual({
      ok: true,
      status: {
        installed: true,
        platform: 'darwin',
        idbAvailable: true,
        idbCompanionAvailable: true
      }
    })
    expect(await handlers.get('simulator-canvas:claim-control')?.(event, 'chat-1')).toMatchObject({
      ok: true,
      token: { tokenId: 'human-tok', kind: 'human' }
    })
    expect(await handlers.get('simulator-canvas:release-control')?.(event, 'chat-1')).toEqual({
      ok: true,
      released: true,
      token: {
        tokenId: 'human-tok',
        chatId: 'chat-1',
        runId: SIMULATOR_HUMAN_CONTROLLER_RUN_ID,
        kind: 'human',
        mintedAt: 1,
        updatedAt: 1
      }
    })
    expect(release).toHaveBeenCalledWith({
      chatId: 'chat-1',
      runId: SIMULATOR_HUMAN_CONTROLLER_RUN_ID
    })
    expect(await handlers.get('simulator-canvas:open-app')?.(event, 'chat-1')).toEqual({ ok: true })
    expect(await handlers.get('simulator-canvas:list-devices')?.(event)).toEqual({
      ok: true,
      devices: []
    })
    expect(
      await handlers.get('simulator-canvas:boot')?.(
        event,
        'chat-1',
        'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'
      )
    ).toEqual({ ok: true, udid: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA' })
    expect(
      await handlers.get('simulator-canvas:install')?.(
        event,
        'chat-1',
        'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
        '/Users/me/Build/Example.app'
      )
    ).toEqual({ ok: true })
    expect(
      await handlers.get('simulator-canvas:launch')?.(
        event,
        'chat-1',
        'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
        'com.example.App'
      )
    ).toEqual({ ok: true })
    expect(
      await handlers.get('simulator-canvas:terminate')?.(
        event,
        'chat-1',
        'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
        'com.example.App'
      )
    ).toEqual({ ok: true })
    expect(
      await handlers.get('simulator-canvas:screenshot')?.(
        event,
        'chat-1',
        'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'
      )
    ).toEqual({
      ok: true,
      frame: { pngBase64: 'aa', width: 1, height: 1 }
    })

    expect(await handlers.get('simulator-canvas:interaction-status')?.(event, 'chat-1')).toEqual({
      canControl: false,
      actuationReady: false,
      reason: SIMULATOR_VIEW_CONTROL_REQUIRED,
      hasObservation: true,
      controllerLeaseHeld: false,
      controllerKind: null
    })
    expect(
      await handlers.get('simulator-canvas:tap')?.(event, {
        chatId: 'chat-1',
        x: 0.5,
        y: 0.25
      })
    ).toEqual({ ok: false, error: SIMULATOR_VIEW_CONTROL_REQUIRED })

    expect(hostControl.boot).toHaveBeenCalledWith('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', {
      chatId: 'chat-1',
      controllerTokenId: 'human-tok'
    })
    expect(hostControl.screenshot).toHaveBeenCalledWith(
      'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
      { chatId: 'chat-1' }
    )
    expect(claimHuman).toHaveBeenCalled()
    expect(interaction.tap).toHaveBeenCalledWith({ chatId: 'chat-1', x: 0.5, y: 0.25 })

    expect(
      await handlers.get('simulator-canvas:inspect')?.(
        event,
        'chat-1',
        'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'
      )
    ).toEqual({
      ok: true,
      tree: [{ AXLabel: 'Home' }],
      truncated: false
    })
    expect(idb.describeAll).toHaveBeenCalledWith('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA')

    claimHuman.mockClear()
    expect(
      await handlers.get('simulator-canvas:button')?.(
        event,
        'chat-1',
        'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
        'HOME'
      )
    ).toEqual({ ok: true, stdout: '', stderr: '' })
    expect(claimHuman).toHaveBeenCalledWith('chat-1')
    expect(idb.hardwareButton).toHaveBeenCalledWith(
      'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
      'HOME'
    )

    claimHuman.mockClear()
    expect(
      await handlers.get('simulator-canvas:rotate')?.(
        event,
        'chat-1',
        'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
        'PORTRAIT'
      )
    ).toEqual({ ok: true, stdout: '', stderr: '' })
    expect(claimHuman).toHaveBeenCalledWith('chat-1')
    expect(idb.rotate).toHaveBeenCalledWith(
      'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
      'PORTRAIT'
    )
  })

  it('opens a native .app picker and merges controller kind into interaction status', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      })
    } as unknown as IpcMain
    const showOpenDialog = vi.fn(async () => ({
      canceled: false,
      filePaths: ['/Users/me/Build/Example.app']
    }))
    const peek = vi.fn(() => ({
      tokenId: 'run-tok',
      chatId: 'chat-1',
      runId: 'run-9',
      kind: 'run' as const,
      mintedAt: 1,
      updatedAt: 1
    }))
    registerSimulatorCanvasHandlers(ipcMain, {
      getHostControl: () =>
        ({
          status: vi.fn(),
          openSimulatorApp: vi.fn(),
          listDevices: vi.fn(),
          boot: vi.fn(),
          install: vi.fn(),
          launch: vi.fn(),
          terminate: vi.fn(),
          screenshot: vi.fn()
        }) as never,
      getControllerLease: () => ({
        claimHuman: vi.fn(() => ({
          ok: true as const,
          token: {
            tokenId: 'human-tok',
            chatId: 'chat-1',
            runId: SIMULATOR_HUMAN_CONTROLLER_RUN_ID,
            kind: 'human' as const,
            mintedAt: 1,
            updatedAt: 1
          }
        })),
        peek,
        release: vi.fn()
      }),
      getInteraction: () =>
        ({
          interactionStatus: vi.fn(() => ({
            canControl: true,
            actuationReady: true,
            reason: 'ready',
            hasObservation: true,
            controllerLeaseHeld: true
          })),
          tap: vi.fn(),
          type: vi.fn(),
          scroll: vi.fn()
        }) as never,
      getRequestingWindow: () => ({ id: 1 }) as never,
      showOpenDialog
    })

    const event = {} as IpcMainInvokeEvent
    expect(await handlers.get('simulator-canvas:pick-app')?.(event, 'chat-1')).toEqual({
      ok: true,
      canceled: false,
      appPath: '/Users/me/Build/Example.app'
    })
    expect(showOpenDialog).toHaveBeenCalled()
    expect(await handlers.get('simulator-canvas:interaction-status')?.(event, 'chat-1')).toEqual({
      canControl: true,
      actuationReady: true,
      reason: 'ready',
      hasObservation: true,
      controllerLeaseHeld: true,
      controllerKind: 'run'
    })
  })

  it('persists successful rotate orientation on the chat session and exposes it via session + interaction-status', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      })
    } as unknown as IpcMain
    const sessionStore = new SimulatorSessionStore({ now: () => 'now' })
    const upsertSpy = vi.spyOn(sessionStore, 'upsert')
    const idb = {
      isAvailable: vi.fn(() => true),
      companionAvailable: vi.fn(() => true),
      describeAll: vi.fn(),
      hardwareButton: vi.fn(),
      rotate: vi.fn(
        async (): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> => ({
          ok: true,
          stdout: '',
          stderr: ''
        })
      )
    }
    registerSimulatorCanvasHandlers(ipcMain, {
      getHostControl: () =>
        ({
          status: vi.fn(),
          openSimulatorApp: vi.fn(),
          listDevices: vi.fn(),
          boot: vi.fn(),
          install: vi.fn(),
          launch: vi.fn(),
          terminate: vi.fn(),
          screenshot: vi.fn()
        }) as never,
      getControllerLease: () => ({
        claimHuman: vi.fn((chatId: string) => ({
          ok: true as const,
          token: {
            tokenId: 'human-tok',
            chatId,
            runId: SIMULATOR_HUMAN_CONTROLLER_RUN_ID,
            kind: 'human' as const,
            mintedAt: 1,
            updatedAt: 1
          }
        })),
        peek: () => null,
        release: vi.fn()
      }),
      getSessionStore: () => sessionStore,
      getInteraction: () =>
        ({
          interactionStatus: vi.fn(() => ({
            canControl: true,
            actuationReady: true,
            reason: 'ready',
            hasObservation: true,
            controllerLeaseHeld: true
          })),
          tap: vi.fn(),
          type: vi.fn(),
          scroll: vi.fn()
        }) as never,
      getIdb: () => idb
    })

    const event = {} as IpcMainInvokeEvent
    expect(
      await handlers.get('simulator-canvas:rotate')?.(
        event,
        'chat-1',
        'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
        'LANDSCAPE_LEFT'
      )
    ).toEqual({ ok: true, stdout: '', stderr: '' })
    expect(upsertSpy).toHaveBeenCalledWith('chat-1', {
      orientation: 'LANDSCAPE_LEFT'
    })
    expect(await handlers.get('simulator-canvas:session')?.(event, 'chat-1')).toMatchObject({
      ok: true,
      session: { orientation: 'LANDSCAPE_LEFT' }
    })
    expect(
      await handlers.get('simulator-canvas:interaction-status')?.(event, 'chat-1')
    ).toMatchObject({
      orientation: 'LANDSCAPE_LEFT'
    })

    idb.rotate.mockResolvedValueOnce({ ok: false, stdout: '', stderr: '', error: 'boom' })
    upsertSpy.mockClear()
    expect(
      await handlers.get('simulator-canvas:rotate')?.(
        event,
        'chat-1',
        'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
        'PORTRAIT'
      )
    ).toMatchObject({ ok: false })
    expect(upsertSpy).not.toHaveBeenCalled()
  })

  it('validates button/rotate allowlists before claiming human control', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      })
    } as unknown as IpcMain
    const claimHuman = vi.fn((chatId: string) => ({
      ok: true as const,
      token: {
        tokenId: 'human-tok',
        chatId,
        runId: SIMULATOR_HUMAN_CONTROLLER_RUN_ID,
        kind: 'human' as const,
        mintedAt: 1,
        updatedAt: 1
      }
    }))
    const idb = {
      isAvailable: vi.fn(() => true),
      companionAvailable: vi.fn(() => true),
      describeAll: vi.fn(),
      hardwareButton: vi.fn(async () => ({ ok: true, stdout: '', stderr: '' })),
      rotate: vi.fn(async () => ({ ok: true, stdout: '', stderr: '' }))
    }
    registerSimulatorCanvasHandlers(ipcMain, {
      getHostControl: () =>
        ({
          status: vi.fn(),
          openSimulatorApp: vi.fn(),
          listDevices: vi.fn(),
          boot: vi.fn(),
          install: vi.fn(),
          launch: vi.fn(),
          terminate: vi.fn(),
          screenshot: vi.fn()
        }) as never,
      getControllerLease: () => ({ claimHuman, peek: () => null, release: vi.fn() }),
      getInteraction: () =>
        ({
          interactionStatus: vi.fn(),
          tap: vi.fn(),
          type: vi.fn(),
          scroll: vi.fn()
        }) as never,
      getIdb: () => idb
    })

    const event = {} as IpcMainInvokeEvent
    await expect(
      handlers.get('simulator-canvas:button')?.(
        event,
        'chat-1',
        'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
        'NOT_A_BUTTON'
      )
    ).rejects.toThrow(/APPLE_PAY|HOME|LOCK|SIDE_BUTTON|SIRI/)
    expect(claimHuman).not.toHaveBeenCalled()
    expect(idb.hardwareButton).not.toHaveBeenCalled()

    await expect(
      handlers.get('simulator-canvas:rotate')?.(
        event,
        'chat-1',
        'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
        'clockwise'
      )
    ).rejects.toThrow(/PORTRAIT|orientation|direction/i)
    expect(claimHuman).not.toHaveBeenCalled()
    expect(idb.rotate).not.toHaveBeenCalled()
  })

  it('rejects malformed string identities before calling the host', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      })
    } as unknown as IpcMain
    const hostControl = {
      status: vi.fn(),
      openSimulatorApp: vi.fn(),
      listDevices: vi.fn(),
      boot: vi.fn(),
      install: vi.fn(),
      launch: vi.fn(),
      terminate: vi.fn(),
      screenshot: vi.fn()
    }
    const interaction = {
      interactionStatus: vi.fn(),
      tap: vi.fn(),
      type: vi.fn(),
      scroll: vi.fn()
    }
    registerSimulatorCanvasHandlers(ipcMain, {
      getHostControl: () => hostControl as never,
      getControllerLease: () => ({
        claimHuman: vi.fn(() => ({
          ok: true as const,
          token: {
            tokenId: 't',
            chatId: 'chat-1',
            runId: SIMULATOR_HUMAN_CONTROLLER_RUN_ID,
            kind: 'human' as const,
            mintedAt: 1,
            updatedAt: 1
          }
        })),
        peek: () => null,
        release: vi.fn()
      }),
      getInteraction: () => interaction
    })

    await expect(
      handlers.get('simulator-canvas:boot')?.({} as IpcMainInvokeEvent, 'chat-1', ' udid ')
    ).rejects.toThrow(/udid/)
    await expect(
      handlers.get('simulator-canvas:launch')?.(
        {} as IpcMainInvokeEvent,
        'chat-1',
        'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
        ' '
      )
    ).rejects.toThrow(/bundleId/)
    await expect(
      handlers.get('simulator-canvas:tap')?.({} as IpcMainInvokeEvent, { chatId: 'chat-1' })
    ).rejects.toThrow(/x/)
    expect(hostControl.boot).not.toHaveBeenCalled()
    expect(hostControl.launch).not.toHaveBeenCalled()
    expect(interaction.tap).not.toHaveBeenCalled()
  })
})
