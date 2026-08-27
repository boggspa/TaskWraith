import { describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { SIMULATOR_VIEW_CONTROL_REQUIRED } from '../../shared/simulatorCanvas'
import { SIMULATOR_CONTROL_DISABLED_MESSAGE } from '../../shared/simulatorControlSetup'
import { SIMULATOR_HUMAN_CONTROLLER_RUN_ID } from '../simulator/SimulatorControllerLease'
import { SimulatorSessionStore } from '../simulator/SimulatorSessionStore'
import { registerSimulatorCanvasHandlers } from './simulatorCanvasHandlers'

describe('registerSimulatorCanvasHandlers', () => {
  it('re-authorizes the exact renderer/chat before reading or mutating simulator state', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: (_channel: string, _handler: (...args: unknown[]) => unknown) =>
        handlers.set(_channel, _handler)
    } as unknown as IpcMain
    const screenshot = vi.fn()
    const resolveContext = vi.fn((_event: IpcMainInvokeEvent, chatId: string) => {
      if (chatId !== 'chat-owned') throw new Error('Renderer chat ownership does not match.')
    })
    registerSimulatorCanvasHandlers(ipcMain, {
      resolveContext,
      getHostControl: () =>
        ({
          status: vi.fn(),
          openSimulatorApp: vi.fn(),
          listDevices: vi.fn(),
          boot: vi.fn(),
          install: vi.fn(),
          launch: vi.fn(),
          terminate: vi.fn(),
          screenshot
        }) as never,
      getControllerLease: () => ({ claimHuman: vi.fn(), peek: vi.fn(), release: vi.fn() }),
      getInteraction: () =>
        ({ interactionStatus: vi.fn(), tap: vi.fn(), type: vi.fn(), scroll: vi.fn() }) as never
    })

    const event = { sender: { id: 9 } } as unknown as IpcMainInvokeEvent
    await expect(
      handlers.get('simulator-canvas:screenshot')?.(event, 'chat-foreign', 'device-a')
    ).rejects.toThrow(/ownership/)
    expect(screenshot).not.toHaveBeenCalled()
    expect(resolveContext).toHaveBeenCalledWith(event, 'chat-foreign')
  })

  it('keeps preview read-only while Simulator control is disabled', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      })
    } as unknown as IpcMain
    const claimHuman = vi.fn()
    const openSimulatorApp = vi.fn()
    const screenshot = vi.fn(async () => ({ ok: true }))
    registerSimulatorCanvasHandlers(ipcMain, {
      resolveContext: vi.fn(),
      getHostControl: () =>
        ({
          status: vi.fn(async () => ({ installed: true, platform: 'darwin' })),
          openSimulatorApp,
          listDevices: vi.fn(),
          boot: vi.fn(),
          install: vi.fn(),
          launch: vi.fn(),
          terminate: vi.fn(),
          screenshot
        }) as never,
      getControllerLease: () => ({ claimHuman, peek: vi.fn(), release: vi.fn() }),
      getInteraction: () =>
        ({ interactionStatus: vi.fn(), tap: vi.fn(), type: vi.fn(), scroll: vi.fn() }) as never,
      isSimulatorControlEnabled: () => false
    })

    const event = {} as IpcMainInvokeEvent
    await expect(handlers.get('simulator-canvas:claim-control')?.(event, 'chat-1')).resolves.toEqual({
      ok: false,
      error: SIMULATOR_CONTROL_DISABLED_MESSAGE,
      code: 'disabled'
    })
    await expect(handlers.get('simulator-canvas:open-app')?.(event, 'chat-1')).rejects.toThrow(
      SIMULATOR_CONTROL_DISABLED_MESSAGE
    )
    await expect(
      handlers.get('simulator-canvas:screenshot')?.(
        event,
        'chat-1',
        'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'
      )
    ).resolves.toEqual({ ok: true })
    expect(claimHuman).not.toHaveBeenCalled()
    expect(openSimulatorApp).not.toHaveBeenCalled()
    expect(screenshot).toHaveBeenCalled()
  })

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
      resolveContext: vi.fn(),
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
      'simulator-canvas:rotate',
      'simulator-canvas:authorize-pasteboard-intent',
      'simulator-canvas:clipboard-push',
      'simulator-canvas:clipboard-pull'
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
      controllerKind: null,
      controllerExpiresAt: null,
      controllerStepsRemaining: null,
      controllerTarget: null
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
      resolveContext: vi.fn(),
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
      controllerKind: 'run',
      controllerExpiresAt: null,
      controllerStepsRemaining: null,
      controllerTarget: null
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
      resolveContext: vi.fn(),
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
      resolveContext: vi.fn(),
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
      resolveContext: vi.fn(),
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

  it('gates clipboard push behind a one-shot paste intent and auto-claims control', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      })
    } as unknown as IpcMain
    const pasteboardSync = vi.fn(async () => ({ ok: true }))
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
    registerSimulatorCanvasHandlers(ipcMain, {
      resolveContext: vi.fn(),
      getHostControl: () =>
        ({
          status: vi.fn(),
          openSimulatorApp: vi.fn(),
          listDevices: vi.fn(),
          boot: vi.fn(),
          install: vi.fn(),
          launch: vi.fn(),
          terminate: vi.fn(),
          screenshot: vi.fn(),
          pasteboardSync
        }) as never,
      getControllerLease: () => ({ claimHuman, peek: vi.fn(), release: vi.fn() }),
      getInteraction: () =>
        ({ interactionStatus: vi.fn(), tap: vi.fn(), type: vi.fn(), scroll: vi.fn() }) as never
    })

    const udid = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'
    const sender = { sender: { id: 7 } } as unknown as IpcMainInvokeEvent

    // Without a minted intent the push is refused and no lease is claimed.
    const refused = await handlers.get('simulator-canvas:clipboard-push')?.(
      sender,
      'chat-1',
      udid,
      'tok-1'
    )
    expect(refused).toMatchObject({ ok: false })
    expect(claimHuman).not.toHaveBeenCalled()
    expect(pasteboardSync).not.toHaveBeenCalled()

    // Preload-minted intent + matching token pushes host→sim under human control.
    await handlers.get('simulator-canvas:authorize-pasteboard-intent')?.(sender, 'tok-1')
    const pushed = await handlers.get('simulator-canvas:clipboard-push')?.(
      sender,
      'chat-1',
      udid,
      'tok-1'
    )
    expect(pushed).toEqual({ ok: true })
    expect(pasteboardSync).toHaveBeenCalledWith(udid, 'host-to-sim', {
      chatId: 'chat-1',
      controllerTokenId: 'human-tok'
    })

    // The intent is single-use: replaying the same token is refused.
    const replayed = await handlers.get('simulator-canvas:clipboard-push')?.(
      sender,
      'chat-1',
      udid,
      'tok-1'
    )
    expect(replayed).toMatchObject({ ok: false })

    // Pull (sim→host) needs no intent — a host-clipboard write, lease-gated only.
    const pulled = await handlers.get('simulator-canvas:clipboard-pull')?.(sender, 'chat-1', udid)
    expect(pulled).toEqual({ ok: true })
    expect(pasteboardSync).toHaveBeenCalledWith(udid, 'sim-to-host', {
      chatId: 'chat-1',
      controllerTokenId: 'human-tok'
    })
  })
})
