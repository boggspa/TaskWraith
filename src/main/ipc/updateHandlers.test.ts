import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { registerUpdateHandlers } from './updateHandlers'
import type { ProductChangelogSnapshot } from '../store/types'
import type { UpdateStateSnapshot } from '../UpdateService'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

const baseSnapshot: UpdateStateSnapshot = {
  status: 'idle',
  enabled: true,
  channel: 'stable'
}

const baseChangelog: ProductChangelogSnapshot = {
  currentVersion: '1.6.6'
}

function createDeps(overrides: Partial<Parameters<typeof registerUpdateHandlers>[0]> = {}) {
  return {
    updateService: {
      snapshot: vi.fn(() => baseSnapshot),
      checkForUpdates: vi.fn(async () => null),
      downloadUpdate: vi.fn(async () => undefined),
      installOnQuit: vi.fn()
    },
    updateRestartCoordinator: {
      requestRestartWhenIdle: vi.fn()
    },
    changelogSnapshot: vi.fn(() => baseChangelog),
    updateLastSeenChangelogVersion: vi.fn(),
    ...overrides
  }
}

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

describe('registerUpdateHandlers', () => {
  it('returns update snapshots from the injected update service', () => {
    const snapshot = { ...baseSnapshot, status: 'not-available' as const }
    const deps = createDeps({
      updateService: {
        ...createDeps().updateService,
        snapshot: vi.fn(() => snapshot)
      }
    })
    registerUpdateHandlers(deps)

    expect(handlerFor('update-snapshot')({} as any)).toBe(snapshot)
    expect(deps.updateService.snapshot).toHaveBeenCalledTimes(1)
  })

  it('checks for updates and returns the latest service snapshot', async () => {
    const snapshot = { ...baseSnapshot, status: 'available' as const, latestVersion: '1.6.7' }
    const deps = createDeps({
      updateService: {
        ...createDeps().updateService,
        snapshot: vi.fn(() => snapshot)
      }
    })
    registerUpdateHandlers(deps)

    await expect(handlerFor('check-for-updates')({} as any)).resolves.toBe(snapshot)
    expect(deps.updateService.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(deps.updateService.snapshot).toHaveBeenCalledTimes(1)
  })

  it('downloads updates and returns the latest service snapshot', async () => {
    const snapshot = { ...baseSnapshot, status: 'downloading' as const }
    const deps = createDeps({
      updateService: {
        ...createDeps().updateService,
        snapshot: vi.fn(() => snapshot)
      }
    })
    registerUpdateHandlers(deps)

    await expect(handlerFor('download-update')({} as any)).resolves.toBe(snapshot)
    expect(deps.updateService.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(deps.updateService.snapshot).toHaveBeenCalledTimes(1)
  })

  it('downloads then requests a restart when the masthead update action is used', async () => {
    const snapshot = { ...baseSnapshot, status: 'downloaded' as const }
    const deps = createDeps({
      updateService: {
        ...createDeps().updateService,
        snapshot: vi.fn(() => snapshot)
      }
    })
    registerUpdateHandlers(deps)

    await expect(handlerFor('download-update-and-restart')({} as any)).resolves.toBe(snapshot)
    expect(deps.updateService.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(deps.updateRestartCoordinator.requestRestartWhenIdle).toHaveBeenCalledTimes(1)
  })

  it('installs later or now and returns the latest service snapshot', () => {
    const snapshot = { ...baseSnapshot, status: 'downloaded' as const }
    const deps = createDeps({
      updateService: {
        ...createDeps().updateService,
        snapshot: vi.fn(() => snapshot)
      }
    })
    registerUpdateHandlers(deps)

    expect(handlerFor('install-update-on-quit')({} as any)).toBe(snapshot)
    expect(deps.updateService.installOnQuit).toHaveBeenCalledTimes(1)
    expect(handlerFor('install-update-now')({} as any)).toBe(snapshot)
    expect(deps.updateRestartCoordinator.requestRestartWhenIdle).toHaveBeenCalledTimes(1)
    expect(deps.updateService.snapshot).toHaveBeenCalledTimes(2)
  })

  it('returns changelog snapshots and marks non-empty seen versions', () => {
    const initial = { ...baseChangelog, lastSeenChangelogVersion: '1.6.5' }
    const updated = { ...baseChangelog, lastSeenChangelogVersion: '1.6.6' }
    const deps = createDeps({
      changelogSnapshot: vi.fn().mockReturnValueOnce(initial).mockReturnValueOnce(updated)
    })
    registerUpdateHandlers(deps)

    expect(handlerFor('changelog-snapshot')({} as any)).toBe(initial)
    expect(handlerFor('mark-changelog-seen')({} as any, ' 1.6.6 ')).toBe(updated)
    expect(deps.updateLastSeenChangelogVersion).toHaveBeenCalledWith('1.6.6')
  })

  it('skips settings writes for empty changelog versions', () => {
    const deps = createDeps()
    registerUpdateHandlers(deps)

    expect(handlerFor('mark-changelog-seen')({} as any, '   ')).toBe(baseChangelog)
    expect(deps.updateLastSeenChangelogVersion).not.toHaveBeenCalled()
  })
})
