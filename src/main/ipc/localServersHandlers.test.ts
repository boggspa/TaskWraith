import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { registerLocalServersHandlers } from './localServersHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

describe('registerLocalServersHandlers', () => {
  it('registers snapshot and refresh handlers against the injected service', async () => {
    const snapshot = {
      sampledAt: '2026-06-27T12:00:00.000Z',
      servers: [],
      platform: 'darwin' as const,
      detectionAvailable: true
    }
    const refreshed = { ...snapshot, sampledAt: '2026-06-27T12:00:01.000Z' }
    const localServersService = {
      snapshot: vi.fn(() => snapshot),
      refreshNow: vi.fn(async () => refreshed),
      stopServer: vi.fn(),
      stopAll: vi.fn()
    }

    registerLocalServersHandlers({ localServersService })

    const snapshotHandler = mockedHandle.mock.calls.find(
      ([channel]) => channel === 'local-servers-snapshot'
    )?.[1]
    const refreshHandler = mockedHandle.mock.calls.find(
      ([channel]) => channel === 'local-servers-refresh'
    )?.[1]

    expect(snapshotHandler?.({} as any)).toBe(snapshot)
    await expect(refreshHandler?.({} as any)).resolves.toBe(refreshed)
  })

  it('preserves stop pid normalization and stop-all behavior', async () => {
    const localServersService = {
      snapshot: vi.fn(),
      refreshNow: vi.fn(),
      stopServer: vi.fn(async () => ({ ok: true })),
      stopAll: vi.fn(async () => ({ stopped: 2 }))
    }

    registerLocalServersHandlers({ localServersService })

    const stopHandler = mockedHandle.mock.calls.find(
      ([channel]) => channel === 'local-servers-stop'
    )?.[1]
    const stopAllHandler = mockedHandle.mock.calls.find(
      ([channel]) => channel === 'local-servers-stop-all'
    )?.[1]

    await expect(stopHandler?.({} as any, '123')).resolves.toEqual({ ok: true })
    expect(localServersService.stopServer).toHaveBeenCalledWith(123)
    await expect(stopAllHandler?.({} as any)).resolves.toEqual({ stopped: 2 })
  })
})
