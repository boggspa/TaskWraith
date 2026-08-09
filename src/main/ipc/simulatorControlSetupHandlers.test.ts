import { describe, expect, it, vi } from 'vitest'
import type { IpcMain } from 'electron'
import {
  registerSimulatorControlSetupHandlers,
  SIMULATOR_CONTROL_SETUP_CHANNEL,
  SIMULATOR_CONTROL_SETUP_STATUS_CHANNEL
} from './simulatorControlSetupHandlers'

describe('registerSimulatorControlSetupHandlers', () => {
  it('passes the persisted enablement state into status and user-initiated setup', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      })
    } as unknown as IpcMain
    const service = {
      status: vi.fn((enabled: boolean) => ({ enabled, state: 'disabled' })),
      setup: vi.fn(async (enabled: boolean) => ({ ok: true, enabled, state: 'disabled' }))
    }

    registerSimulatorControlSetupHandlers(ipcMain, {
      getSetup: () => service as never,
      isEnabled: () => false
    })

    expect([...handlers.keys()].sort()).toEqual(
      [SIMULATOR_CONTROL_SETUP_STATUS_CHANNEL, SIMULATOR_CONTROL_SETUP_CHANNEL].sort()
    )
    expect(handlers.get(SIMULATOR_CONTROL_SETUP_STATUS_CHANNEL)?.()).toEqual({
      enabled: false,
      state: 'disabled'
    })
    await expect(handlers.get(SIMULATOR_CONTROL_SETUP_CHANNEL)?.()).resolves.toEqual({
      ok: true,
      enabled: false,
      state: 'disabled'
    })
    expect(service.status).toHaveBeenCalledWith(false)
    expect(service.setup).toHaveBeenCalledWith(false)
  })
})
