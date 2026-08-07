import { describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { SIMULATOR_VIEW_CONTROL_REQUIRED } from '../../shared/simulatorCanvas'
import { registerSimulatorCanvasHandlers } from './simulatorCanvasHandlers'

describe('registerSimulatorCanvasHandlers', () => {
  it('registers host + interaction channels and forwards validated args', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      })
    } as unknown as IpcMain

    const host = {
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
    const interaction = {
      interactionStatus: vi.fn(() => ({
        canControl: false,
        reason: SIMULATOR_VIEW_CONTROL_REQUIRED,
        hasObservation: true
      })),
      tap: vi.fn(() => ({ ok: false, error: SIMULATOR_VIEW_CONTROL_REQUIRED })),
      type: vi.fn(() => ({ ok: false, error: SIMULATOR_VIEW_CONTROL_REQUIRED })),
      scroll: vi.fn(() => ({ ok: false, error: SIMULATOR_VIEW_CONTROL_REQUIRED }))
    }

    registerSimulatorCanvasHandlers(ipcMain, {
      getHost: () => host,
      getInteraction: () => interaction
    })

    const expected = [
      'simulator-canvas:status',
      'simulator-canvas:open-app',
      'simulator-canvas:list-devices',
      'simulator-canvas:boot',
      'simulator-canvas:install',
      'simulator-canvas:launch',
      'simulator-canvas:terminate',
      'simulator-canvas:screenshot',
      'simulator-canvas:interaction-status',
      'simulator-canvas:tap',
      'simulator-canvas:type',
      'simulator-canvas:scroll'
    ]
    expect([...handlers.keys()].sort()).toEqual([...expected].sort())

    const event = {} as IpcMainInvokeEvent
    expect(await handlers.get('simulator-canvas:status')?.(event)).toEqual({
      ok: true,
      status: { installed: true, platform: 'darwin' }
    })
    expect(await handlers.get('simulator-canvas:open-app')?.(event)).toEqual({ ok: true })
    expect(await handlers.get('simulator-canvas:list-devices')?.(event)).toEqual({
      ok: true,
      devices: []
    })
    expect(
      await handlers.get('simulator-canvas:boot')?.(event, 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA')
    ).toEqual({ ok: true, udid: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA' })
    expect(
      await handlers.get('simulator-canvas:install')?.(
        event,
        'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
        '/Users/me/Build/Example.app'
      )
    ).toEqual({ ok: true })
    expect(
      await handlers.get('simulator-canvas:launch')?.(
        event,
        'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
        'com.example.App'
      )
    ).toEqual({ ok: true })
    expect(
      await handlers.get('simulator-canvas:terminate')?.(
        event,
        'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
        'com.example.App'
      )
    ).toEqual({ ok: true })
    expect(
      await handlers.get('simulator-canvas:screenshot')?.(
        event,
        'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'
      )
    ).toEqual({
      ok: true,
      frame: { pngBase64: 'aa', width: 1, height: 1 }
    })

    expect(await handlers.get('simulator-canvas:interaction-status')?.(event, 'chat-1')).toEqual({
      canControl: false,
      reason: SIMULATOR_VIEW_CONTROL_REQUIRED,
      hasObservation: true
    })
    expect(
      await handlers.get('simulator-canvas:tap')?.(event, {
        chatId: 'chat-1',
        x: 0.5,
        y: 0.25
      })
    ).toEqual({ ok: false, error: SIMULATOR_VIEW_CONTROL_REQUIRED })
    expect(
      await handlers.get('simulator-canvas:type')?.(event, { chatId: 'chat-1', text: 'hi' })
    ).toEqual({ ok: false, error: SIMULATOR_VIEW_CONTROL_REQUIRED })
    expect(
      await handlers.get('simulator-canvas:scroll')?.(event, {
        chatId: 'chat-1',
        x: 0.5,
        y: 0.5,
        deltaX: 0,
        deltaY: -20
      })
    ).toEqual({ ok: false, error: SIMULATOR_VIEW_CONTROL_REQUIRED })

    expect(host.boot).toHaveBeenCalledWith('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA')
    expect(interaction.tap).toHaveBeenCalledWith({ chatId: 'chat-1', x: 0.5, y: 0.25 })
    expect(interaction.type).toHaveBeenCalledWith({ chatId: 'chat-1', text: 'hi' })
    expect(interaction.scroll).toHaveBeenCalledWith({
      chatId: 'chat-1',
      x: 0.5,
      y: 0.5,
      deltaX: 0,
      deltaY: -20
    })
  })

  it('rejects malformed string identities before calling the host', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      })
    } as unknown as IpcMain
    const host = {
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
      getHost: () => host,
      getInteraction: () => interaction
    })

    await expect(
      handlers.get('simulator-canvas:boot')?.({} as IpcMainInvokeEvent, ' udid ')
    ).rejects.toThrow(/udid/)
    await expect(
      handlers.get('simulator-canvas:launch')?.(
        {} as IpcMainInvokeEvent,
        'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
        ' '
      )
    ).rejects.toThrow(/bundleId/)
    await expect(
      handlers.get('simulator-canvas:tap')?.({} as IpcMainInvokeEvent, { chatId: 'chat-1' })
    ).rejects.toThrow(/x/)
    expect(host.boot).not.toHaveBeenCalled()
    expect(host.launch).not.toHaveBeenCalled()
    expect(interaction.tap).not.toHaveBeenCalled()
  })
})
