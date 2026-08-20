import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock electron-updater BEFORE importing UpdateService — autoUpdater is
// a real Electron-runtime singleton and we don't want it to do anything
// during tests. `vi.hoisted` runs at the same hoisted phase as
// `vi.mock`, sidestepping the temporal dead zone we'd hit if the
// factory closed over a plain `const`.
const mockAutoUpdater = vi.hoisted(() => ({
  channel: 'latest' as string,
  autoDownload: true,
  autoInstallOnAppQuit: true,
  autoRunAppAfterInstall: false,
  logger: null as unknown,
  checkForUpdates: vi.fn(async () => null),
  downloadUpdate: vi.fn(async () => ['/tmp/update.dmg']),
  quitAndInstall: vi.fn(),
  on: vi.fn(),
  emit: vi.fn()
}))

vi.mock('electron-updater', () => ({
  autoUpdater: mockAutoUpdater
}))

import {
  resolveAutoUpdateServiceEnabled,
  UPDATE_CHECK_INTERVAL_MS,
  UpdateService
} from './UpdateService'
import type { IdentityHandoffSnapshot } from './IdentityHandoffService'

function emitUpdaterEvent(name: string, payload?: unknown): void {
  const handler = mockAutoUpdater.on.mock.calls.find((call) => call[0] === name)?.[1]
  if (typeof handler === 'function') {
    handler(payload)
  }
}

function createIdentityHandoffBridge(initialPhase: IdentityHandoffSnapshot['phase'] = 'ready') {
  let snapshot: IdentityHandoffSnapshot = {
    active: true,
    phase: initialPhase,
    handoffId: 'taskwraith-1.9.9-to-0.1.0-v1',
    sourceVersion: '1.9.9',
    targetVersion: '0.1.0',
    targetAppId: 'com.taskwraith.desktop',
    targetUpdateFeedChannel: 'release',
    supportUrl: 'https://github.com/boggspa/TaskWraith/releases/tag/v0.1.0',
    evidencePath: '/profile/identity-handoff-v1/state.json',
    totalBytes: 100,
    downloadedBytes: initialPhase === 'downloaded' ? 100 : 0,
    percent: initialPhase === 'downloaded' ? 100 : 0
  }
  const listeners = new Set<(value: IdentityHandoffSnapshot) => void>()
  const publish = (next: Partial<IdentityHandoffSnapshot>) => {
    snapshot = { ...snapshot, ...next }
    for (const listener of listeners) listener(snapshot)
  }
  return {
    snapshot: vi.fn(() => snapshot),
    subscribe: vi.fn((listener: (value: IdentityHandoffSnapshot) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    download: vi.fn(async () => {
      publish({ phase: 'downloaded', downloadedBytes: 100, percent: 100 })
      return snapshot
    }),
    retry: vi.fn(async () => {
      publish({ phase: 'ready', errorMessage: undefined, errorCode: undefined })
      return snapshot
    }),
    launch: vi.fn(() => true),
    publish
  }
}

describe('UpdateService', () => {
  beforeEach(() => {
    mockAutoUpdater.channel = 'latest'
    mockAutoUpdater.autoDownload = true
    mockAutoUpdater.autoInstallOnAppQuit = true
    mockAutoUpdater.autoRunAppAfterInstall = false
    mockAutoUpdater.logger = null
    mockAutoUpdater.checkForUpdates.mockClear()
    mockAutoUpdater.downloadUpdate.mockClear()
    mockAutoUpdater.quitAndInstall.mockClear()
    mockAutoUpdater.on.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('starts in `disabled` status until configured', () => {
    const svc = new UpdateService()
    expect(svc.snapshot().status).toBe('disabled')
    expect(svc.snapshot().enabled).toBe(false)
  })

  it('stays disabled when configured with channel=debug', () => {
    const svc = new UpdateService()
    svc.configure({ channel: 'debug', enabled: true })
    expect(svc.snapshot().status).toBe('disabled')
    expect(svc.snapshot().channel).toBe('debug')
  })

  it('stays disabled when enabled=false even with a real channel', () => {
    const svc = new UpdateService()
    svc.configure({ channel: 'stable', enabled: false })
    expect(svc.snapshot().status).toBe('disabled')
    expect(mockAutoUpdater.autoDownload).toBe(false)
    expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(false)
  })

  it('moves to idle when configured with a real channel + enabled', () => {
    const svc = new UpdateService({ platform: 'darwin', arch: 'arm64' })
    svc.configure({ channel: 'stable', enabled: true })
    expect(svc.snapshot().status).toBe('idle')
    expect(svc.snapshot().enabled).toBe(true)
    expect(mockAutoUpdater.channel).toBe('latest')
    expect(mockAutoUpdater.autoDownload).toBe(false)
    expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(false)
  })

  it('maps nightly channel to electron-updater beta', () => {
    const svc = new UpdateService({ platform: 'darwin', arch: 'arm64' })
    svc.configure({ channel: 'nightly', enabled: true })
    expect(mockAutoUpdater.channel).toBe('beta')
  })

  it('uses the isolated release feed for the public distribution identity', () => {
    const mac = new UpdateService({
      platform: 'darwin',
      arch: 'arm64',
      stableUpdateChannel: 'release'
    })
    mac.configure({ channel: 'stable', enabled: true })
    expect(mockAutoUpdater.channel).toBe('release')

    const windows = new UpdateService({
      platform: 'win32',
      arch: 'arm64',
      stableUpdateChannel: 'release'
    })
    windows.configure({ channel: 'stable', enabled: true })
    expect(mockAutoUpdater.channel).toBe('release-win-arm64')

    windows.configure({ channel: 'nightly', enabled: true })
    expect(windows.snapshot().channel).toBe('stable')
    expect(mockAutoUpdater.channel).toBe('release-win-arm64')
  })

  it('surfaces the explicit identity handoff even when automatic checks are off', () => {
    const identityHandoff = createIdentityHandoffBridge()
    const svc = new UpdateService({ identityHandoff })
    svc.configure({ channel: 'stable', enabled: false })

    expect(svc.snapshot()).toMatchObject({
      status: 'available',
      enabled: true,
      latestVersion: '0.1.0',
      releaseName: 'TaskWraith Release',
      identityHandoff: {
        active: true,
        phase: 'ready',
        targetAppId: 'com.taskwraith.desktop'
      }
    })
    expect(mockAutoUpdater.channel).toBe('latest')
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('routes handoff download, progress, and install through the custom bridge', async () => {
    const identityHandoff = createIdentityHandoffBridge()
    const svc = new UpdateService({ identityHandoff })
    svc.configure({ channel: 'stable', enabled: true })

    identityHandoff.publish({
      phase: 'downloading',
      downloadedBytes: 40,
      percent: 40
    })
    expect(svc.snapshot()).toMatchObject({
      status: 'downloading',
      downloadProgress: { transferred: 40, total: 100, percent: 40 }
    })

    await svc.downloadUpdate()
    expect(identityHandoff.download).toHaveBeenCalledTimes(1)
    expect(svc.snapshot()).toMatchObject({ status: 'downloaded' })
    expect(svc.quitAndInstall()).toBe(true)
    expect(identityHandoff.launch).toHaveBeenCalledTimes(1)
    expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled()
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('wires the autoUpdater event listeners exactly once', () => {
    const svc = new UpdateService()
    svc.configure({ channel: 'stable', enabled: true })
    const firstCount = mockAutoUpdater.on.mock.calls.length
    expect(firstCount).toBeGreaterThan(0)
    svc.configure({ channel: 'nightly', enabled: true })
    // Should not re-attach listeners on a re-configure.
    expect(mockAutoUpdater.on.mock.calls.length).toBe(firstCount)
  })

  it('checkForUpdates is a no-op when disabled', async () => {
    const svc = new UpdateService()
    const result = await svc.checkForUpdates()
    expect(result).toBeNull()
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('checkForUpdates transitions to checking + invokes autoUpdater', async () => {
    const svc = new UpdateService()
    svc.configure({ channel: 'stable', enabled: true })
    const listener = vi.fn()
    svc.subscribe(listener)
    await svc.checkForUpdates()
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    // First subscriber call should report `checking`; subsequent
    // transitions depend on autoUpdater events which we haven't fired
    // here.
    const statuses = listener.mock.calls.map((c) => (c[0] as { status: string }).status)
    expect(statuses).toContain('checking')
  })

  it('handles checkForUpdates errors as error status', async () => {
    mockAutoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('feed unavailable'))
    const svc = new UpdateService()
    svc.configure({ channel: 'stable', enabled: true })
    await svc.checkForUpdates()
    const snap = svc.snapshot()
    expect(snap.status).toBe('error')
    expect(snap.errorMessage).toContain('feed unavailable')
  })

  it('downloadUpdate is rejected when status is not "available"', async () => {
    const svc = new UpdateService()
    svc.configure({ channel: 'stable', enabled: true })
    await svc.downloadUpdate()
    expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('does not download an available update until the user explicitly requests it', () => {
    const svc = new UpdateService({ platform: 'darwin', arch: 'arm64' })
    svc.configure({ channel: 'stable', enabled: true })

    emitUpdaterEvent('update-available', {
      version: '1.0.73',
      files: [],
      path: 'TaskWraith-1.0.73.dmg',
      sha512: 'abc'
    })

    expect(svc.snapshot().status).toBe('available')
    expect(mockAutoUpdater.autoDownload).toBe(false)
    expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('quitAndInstall is rejected when status is not "downloaded"', () => {
    const svc = new UpdateService()
    svc.configure({ channel: 'stable', enabled: true })
    expect(svc.quitAndInstall()).toBe(false)
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('forces relaunch when handing a downloaded update to the installer', () => {
    const svc = new UpdateService({ platform: 'darwin', arch: 'arm64' })
    svc.configure({ channel: 'stable', enabled: true })
    emitUpdaterEvent('update-downloaded', {
      version: '1.0.74',
      files: [],
      path: 'TaskWraith-1.0.74.dmg',
      sha512: 'abc'
    })

    expect(svc.quitAndInstall()).toBe(true)
    expect(mockAutoUpdater.autoRunAppAfterInstall).toBe(true)
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('surfaces a synchronous installer handoff failure', () => {
    mockAutoUpdater.quitAndInstall.mockImplementationOnce(() => {
      throw new Error('native updater unavailable')
    })
    const svc = new UpdateService({ platform: 'darwin', arch: 'arm64' })
    svc.configure({ channel: 'stable', enabled: true })
    emitUpdaterEvent('update-downloaded', {
      version: '1.0.74',
      files: [],
      path: 'TaskWraith-1.0.74.dmg',
      sha512: 'abc'
    })

    expect(svc.quitAndInstall()).toBe(false)
    expect(svc.snapshot()).toMatchObject({
      status: 'error',
      errorMessage: 'native updater unavailable'
    })
  })

  it('rejects installer handoff when electron-updater reports an immediate error', () => {
    mockAutoUpdater.quitAndInstall.mockImplementationOnce(() => {
      emitUpdaterEvent('error', new Error('installer rejected update'))
    })
    const svc = new UpdateService({ platform: 'darwin', arch: 'arm64' })
    svc.configure({ channel: 'stable', enabled: true })
    emitUpdaterEvent('update-downloaded', {
      version: '1.0.74',
      files: [],
      path: 'TaskWraith-1.0.74.dmg',
      sha512: 'abc'
    })

    expect(svc.quitAndInstall()).toBe(false)
    expect(svc.snapshot()).toMatchObject({
      status: 'error',
      errorMessage: 'installer rejected update'
    })
  })

  it('subscribers receive snapshots on configure', () => {
    const svc = new UpdateService()
    const listener = vi.fn()
    svc.subscribe(listener)
    svc.configure({ channel: 'stable', enabled: true })
    expect(listener).toHaveBeenCalled()
    expect(listener.mock.calls[listener.mock.calls.length - 1][0]).toMatchObject({
      status: 'idle',
      channel: 'stable',
      enabled: true
    })
  })

  it('unsubscribe stops further updates', () => {
    const svc = new UpdateService()
    const listener = vi.fn()
    const unsub = svc.subscribe(listener)
    svc.configure({ channel: 'stable', enabled: true })
    const callsAfterFirstConfigure = listener.mock.calls.length
    unsub()
    svc.configure({ channel: 'nightly', enabled: true })
    expect(listener.mock.calls.length).toBe(callsAfterFirstConfigure)
  })

  it('listener that throws does not break other listeners', () => {
    const svc = new UpdateService({ log: vi.fn() })
    const bad = vi.fn(() => {
      throw new Error('bad listener')
    })
    const good = vi.fn()
    svc.subscribe(bad)
    svc.subscribe(good)
    svc.configure({ channel: 'stable', enabled: true })
    expect(bad).toHaveBeenCalled()
    expect(good).toHaveBeenCalled()
  })

  it('snapshot includes lastCheckedAt after a check', async () => {
    const svc = new UpdateService()
    svc.configure({ channel: 'stable', enabled: true })
    expect(svc.snapshot().lastCheckedAt).toBeUndefined()
    await svc.checkForUpdates()
    const snap = svc.snapshot()
    expect(snap.lastCheckedAt).toBeDefined()
    expect(new Date(snap.lastCheckedAt!).getTime()).toBeGreaterThan(0)
  })

  it('captures release metadata when an update is available', () => {
    const svc = new UpdateService({ platform: 'darwin', arch: 'arm64' })
    svc.configure({ channel: 'stable', enabled: true })
    emitUpdaterEvent('update-available', {
      version: '1.0.73',
      files: [],
      path: 'TaskWraith-1.0.73.dmg',
      sha512: 'abc',
      releaseName: 'TaskWraith 1.0.73',
      releaseDate: '2026-06-04T12:00:00.000Z',
      releaseNotes: 'New updater UI.'
    })

    expect(svc.snapshot()).toMatchObject({
      status: 'available',
      latestVersion: '1.0.73',
      releaseName: 'TaskWraith 1.0.73',
      releaseDate: '2026-06-04T12:00:00.000Z',
      releaseNotes: 'New updater UI.',
      updateArchitecture: {
        platform: 'darwin',
        arch: 'arm64',
        artifactName: 'TaskWraith-1.0.73.dmg',
        artifactArch: 'unknown',
        compatible: true,
        reason: 'Unknown mac update artifact architecture: TaskWraith-1.0.73.dmg'
      },
      releasePageUrl: 'https://github.com/boggspa/TaskWraith/releases/tag/v1.0.73'
    })
  })

  it('rejects an arm64-only mac update before download on Intel', async () => {
    const svc = new UpdateService({ platform: 'darwin', arch: 'x64' })
    svc.configure({ channel: 'stable', enabled: true })

    emitUpdaterEvent('update-available', {
      version: '1.0.73',
      files: [{ url: 'TaskWraith-1.0.73-arm64-mac.zip', sha512: 'abc', size: 1 }],
      path: 'TaskWraith-1.0.73-arm64-mac.zip',
      sha512: 'abc'
    })

    expect(svc.snapshot()).toMatchObject({
      status: 'error',
      errorMessage: 'Incompatible update artifact: host=darwin-x64 artifact=arm64',
      updateArchitecture: {
        platform: 'darwin',
        arch: 'x64',
        artifactName: 'TaskWraith-1.0.73-arm64-mac.zip',
        artifactArch: 'arm64',
        compatible: false
      }
    })

    await svc.downloadUpdate()
    expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('accepts a universal mac update on Intel', () => {
    const svc = new UpdateService({ platform: 'darwin', arch: 'x64' })
    svc.configure({ channel: 'stable', enabled: true })

    emitUpdaterEvent('update-available', {
      version: '1.0.73',
      files: [{ url: 'TaskWraith-1.0.73-universal-mac.zip', sha512: 'abc', size: 1 }],
      path: 'TaskWraith-1.0.73-universal-mac.zip',
      sha512: 'abc'
    })

    expect(svc.snapshot()).toMatchObject({
      status: 'available',
      updateArchitecture: {
        platform: 'darwin',
        arch: 'x64',
        artifactName: 'TaskWraith-1.0.73-universal-mac.zip',
        artifactArch: 'universal',
        compatible: true
      }
    })
  })

  it('preserves full changelog arrays when an update is downloaded', () => {
    const svc = new UpdateService({ platform: 'darwin', arch: 'arm64' })
    svc.configure({ channel: 'stable', enabled: true })
    emitUpdaterEvent('update-downloaded', {
      version: '1.0.74',
      files: [],
      path: 'TaskWraith-1.0.74.dmg',
      sha512: 'abc',
      releaseDate: '2026-06-04T13:00:00.000Z',
      releaseNotes: [
        { version: '1.0.74', note: 'Second update.' },
        { version: '1.0.73', note: null }
      ]
    })

    expect(svc.snapshot()).toMatchObject({
      status: 'downloaded',
      latestVersion: '1.0.74',
      releaseNotes: [
        { version: '1.0.74', note: 'Second update.' },
        { version: '1.0.73', note: null }
      ]
    })
  })

  it('clears stale release metadata when no update is available', () => {
    const svc = new UpdateService()
    svc.configure({ channel: 'stable', enabled: true })
    emitUpdaterEvent('update-available', {
      version: '1.0.73',
      files: [],
      path: 'TaskWraith-1.0.73.dmg',
      sha512: 'abc',
      releaseDate: '2026-06-04T12:00:00.000Z',
      releaseNotes: 'New updater UI.'
    })
    emitUpdaterEvent('update-not-available')

    expect(svc.snapshot()).toMatchObject({
      status: 'not-available',
      latestVersion: undefined,
      releaseNotes: undefined
    })
  })

  it('reconfigure to debug after enabled returns to disabled', () => {
    const svc = new UpdateService()
    svc.configure({ channel: 'stable', enabled: true })
    expect(svc.snapshot().status).toBe('idle')
    svc.configure({ channel: 'debug', enabled: true })
    expect(svc.snapshot().status).toBe('disabled')
  })

  it('polls for updates every 15 minutes when enabled', async () => {
    vi.useFakeTimers()
    try {
      mockAutoUpdater.checkForUpdates.mockImplementation(async () => {
        emitUpdaterEvent('update-not-available')
        return null
      })
      const svc = new UpdateService()
      svc.configure({ channel: 'stable', enabled: true })
      mockAutoUpdater.checkForUpdates.mockClear()

      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
      expect(svc.snapshot().status).toBe('not-available')

      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(2)
    } finally {
      mockAutoUpdater.checkForUpdates.mockImplementation(async () => null)
      vi.useRealTimers()
    }
  })

  it.each([
    ['available', 'update-available'],
    ['downloaded', 'update-downloaded']
  ] as const)(
    'does not replace an %s update with a periodic check before user action',
    async (status, eventName) => {
      vi.useFakeTimers()
      try {
        const svc = new UpdateService({ platform: 'darwin', arch: 'arm64' })
        svc.configure({ channel: 'stable', enabled: true })
        emitUpdaterEvent(eventName, {
          version: '1.0.74',
          files: [],
          path: 'TaskWraith-1.0.74.dmg',
          sha512: 'abc'
        })
        mockAutoUpdater.checkForUpdates.mockClear()

        await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)

        expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled()
        expect(svc.snapshot().status).toBe(status)
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it('stops periodic polling when auto-update is disabled', async () => {
    vi.useFakeTimers()
    try {
      const svc = new UpdateService()
      svc.configure({ channel: 'stable', enabled: true })
      svc.configure({ channel: 'debug', enabled: true })
      mockAutoUpdater.checkForUpdates.mockClear()

      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
      expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears updater flags and ignores late updater events when disabled live', () => {
    // Pin platform: on win32 the arch-specific feed gates the mac-shaped
    // update-available fixture below as incompatible (-> 'error'). This test
    // exercises disable behavior, not arch-compat, so keep it deterministic
    // across CI runners.
    const svc = new UpdateService({ platform: 'darwin' })
    svc.configure({ channel: 'stable', enabled: true })
    expect(mockAutoUpdater.autoDownload).toBe(false)
    expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(false)

    emitUpdaterEvent('update-available', {
      version: '1.0.73',
      files: [],
      path: 'TaskWraith-1.0.73.dmg',
      sha512: 'abc'
    })
    expect(svc.snapshot().status).toBe('available')

    svc.configure({ channel: 'stable', enabled: false })
    expect(mockAutoUpdater.autoDownload).toBe(false)
    expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(false)

    emitUpdaterEvent('checking-for-update')
    emitUpdaterEvent('download-progress', { percent: 50, transferred: 50, total: 100 })
    emitUpdaterEvent('update-downloaded', {
      version: '1.0.74',
      files: [],
      path: 'TaskWraith-1.0.74.dmg',
      sha512: 'def'
    })
    emitUpdaterEvent('error', new Error('late updater failure'))

    expect(svc.snapshot()).toMatchObject({
      status: 'disabled',
      latestVersion: undefined,
      downloadProgress: undefined,
      errorMessage: undefined
    })
  })
})

describe('resolveAutoUpdateServiceEnabled', () => {
  it('defaults to packaged builds when the user setting is enabled or missing', () => {
    expect(
      resolveAutoUpdateServiceEnabled({ autoUpdateEnabled: true, isPackaged: true })
    ).toBe(true)
    expect(resolveAutoUpdateServiceEnabled({ isPackaged: true })).toBe(true)
    expect(
      resolveAutoUpdateServiceEnabled({ autoUpdateEnabled: true, isPackaged: false })
    ).toBe(false)
  })

  it('lets the user disable auto-update even when the env override is on', () => {
    expect(
      resolveAutoUpdateServiceEnabled({
        autoUpdateEnabled: false,
        isPackaged: true,
        envOverride: 'on'
      })
    ).toBe(false)
  })

  it('supports env overrides for staging when the user setting allows updates', () => {
    expect(
      resolveAutoUpdateServiceEnabled({
        autoUpdateEnabled: true,
        isPackaged: false,
        envOverride: 'on'
      })
    ).toBe(true)
    expect(
      resolveAutoUpdateServiceEnabled({
        autoUpdateEnabled: true,
        isPackaged: true,
        envOverride: 'off'
      })
    ).toBe(false)
  })
})
