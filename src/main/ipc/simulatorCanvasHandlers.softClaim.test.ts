import { describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { registerSimulatorCanvasHandlers } from './simulatorCanvasHandlers'

describe('simulatorCanvasHandlers soft-claim fail-closed', () => {
  it('aborts tap/type/scroll/button/rotate when soft-claim fails and never actuates', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      })
    } as unknown as IpcMain

    const claimHuman = vi.fn(() => ({
      ok: false as const,
      code: 'conflict' as const,
      error: 'Simulator control is held by another run.'
    }))
    const tap = vi.fn(async () => ({ ok: true }))
    const type = vi.fn(async () => ({ ok: true }))
    const scroll = vi.fn(async () => ({ ok: true }))
    const hardwareButton = vi.fn(async () => ({ ok: true, stdout: '', stderr: '' }))
    const rotate = vi.fn(async () => ({ ok: true, stdout: '', stderr: '' }))

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
        claimHuman,
        peek: () => null,
        release: vi.fn()
      }),
      getInteraction: () =>
        ({
          interactionStatus: vi.fn(),
          tap,
          type,
          scroll
        }) as never,
      getIdb: () => ({
        isAvailable: () => true,
        companionAvailable: () => true,
        describeAll: vi.fn(),
        hardwareButton,
        rotate
      })
    })

    const event = {} as IpcMainInvokeEvent
    const udid = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'
    const refused = {
      ok: false,
      error: 'Simulator control is held by another run.'
    }

    expect(
      await handlers.get('simulator-canvas:tap')?.(event, { chatId: 'chat-1', x: 0.5, y: 0.25 })
    ).toEqual(refused)
    expect(
      await handlers.get('simulator-canvas:type')?.(event, { chatId: 'chat-1', text: 'hi' })
    ).toEqual(refused)
    expect(
      await handlers.get('simulator-canvas:scroll')?.(event, {
        chatId: 'chat-1',
        x: 0.5,
        y: 0.5,
        deltaX: 0,
        deltaY: -20
      })
    ).toEqual(refused)
    expect(await handlers.get('simulator-canvas:button')?.(event, 'chat-1', udid, 'HOME')).toEqual(
      refused
    )
    expect(
      await handlers.get('simulator-canvas:rotate')?.(event, 'chat-1', udid, 'PORTRAIT')
    ).toEqual(refused)

    expect(tap).not.toHaveBeenCalled()
    expect(type).not.toHaveBeenCalled()
    expect(scroll).not.toHaveBeenCalled()
    expect(hardwareButton).not.toHaveBeenCalled()
    expect(rotate).not.toHaveBeenCalled()
    expect(claimHuman).toHaveBeenCalled()
  })
})
