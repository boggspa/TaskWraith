import { describe, expect, it, vi } from 'vitest'
import { createAppshotsToolExecutors } from './AppshotsToolExecutors'
import type { DesktopToolContext } from './DesktopToolExecutors'
import type { ScopedAttachedWindowSnapshot } from '../nativeWindow/ScopedAttachedWindowState'

function context(partial: Partial<DesktopToolContext> = {}): DesktopToolContext {
  return {
    scope: 'workspace',
    cwd: '/ws',
    workspacePath: '/ws',
    appChatId: 'chat-1',
    appRunId: 'run-1',
    ...partial
  }
}

function attached(pid = 4242): ScopedAttachedWindowSnapshot {
  return {
    handleID: 'h1',
    scopeID: 's1',
    chatID: 'chat-1',
    consentEpoch: 1,
    generation: 1,
    windowMeta: {
      windowID: 9,
      title: 'Demo',
      bundleID: 'com.demo',
      applicationName: 'Demo App',
      pid,
      identityQuality: 'exact',
      processStartedAt: '2026-08-07T20:00:00.000Z',
      processIdentity: {
        pid,
        launchTimeMicros: 1,
        source: 'nsRunningApplication'
      },
      bounds: { x: 0, y: 0, width: 100, height: 100 }
    },
    attachedAt: '2026-08-07T20:00:00.000Z'
  }
}

describe('createAppshotsToolExecutors', () => {
  it('refuses when no attachment and no pid', async () => {
    const executors = createAppshotsToolExecutors({
      getBridgeDaemon: () => ({
        status: () => ({ running: true, startedAt: null, pid: 1 }),
        request: vi.fn()
      }),
      attachedWindow: {
        getForChat: () => null,
        updateStreaming: () => null,
        clearExact: () => null,
        rendererProjectionForChat: () => null
      },
      listTrackedSpawns: () => [],
      listLaunchAttempts: () => []
    })
    const result = await executors.executeAppshots({}, context())
    expect(result.isError).toBe(true)
    expect(result.structuredContent?.reason || result.structuredContent?.error).toBeTruthy()
  })

  it('captures attached window without pid and returns an image block', async () => {
    const request = vi.fn(async () => ({
      pngBase64: Buffer.from('png').toString('base64'),
      byteLength: 3,
      width: 10,
      height: 10,
      capturedAt: '2026-08-07T20:01:00.000Z',
      windowMeta: { title: 'Demo' }
    }))
    const executors = createAppshotsToolExecutors({
      getBridgeDaemon: () => ({
        status: () => ({ running: true, startedAt: null, pid: 1 }),
        request
      }),
      attachedWindow: {
        getForChat: () => attached(4242),
        updateStreaming: () => null,
        clearExact: () => null,
        rendererProjectionForChat: () => null
      },
      listTrackedSpawns: () => [],
      listLaunchAttempts: () => []
    })
    const result = await executors.executeAppshots({}, context())
    expect(result.isError).toBeFalsy()
    expect(request).toHaveBeenCalledWith(
      'attachedWindow.capture',
      expect.objectContaining({ handleID: 'h1' }),
      expect.any(Object)
    )
    expect(result.content?.some((b) => b.type === 'image')).toBe(true)
    expect(result.mediaRefHints?.groupKind).toBe('appshots')
  })

  it('captures owned spawn via captureByPid and supports interval bursts', async () => {
    const request = vi.fn(async () => ({
      pngBase64: Buffer.from('png').toString('base64'),
      byteLength: 3,
      width: 10,
      height: 10,
      captureMode: 'byPid'
    }))
    const sleep = vi.fn(async () => undefined)
    const executors = createAppshotsToolExecutors({
      getBridgeDaemon: () => ({
        status: () => ({ running: true, startedAt: null, pid: 1 }),
        request
      }),
      attachedWindow: {
        getForChat: () => null,
        updateStreaming: () => null,
        clearExact: () => null,
        rendererProjectionForChat: () => null
      },
      listTrackedSpawns: () => [{ pid: 77, chatId: 'chat-1', startedAt: '2026-08-07T20:00:00.000Z' }],
      listLaunchAttempts: () => [],
      sleep
    })
    const result = await executors.executeAppshots(
      { pid: 77, count: 3, interval_ms: 250 },
      context()
    )
    expect(result.isError).toBeFalsy()
    expect(request).toHaveBeenCalledTimes(3)
    expect(request).toHaveBeenCalledWith(
      'attachedWindow.captureByPid',
      expect.objectContaining({ pid: 77 }),
      expect.any(Object)
    )
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(result.content?.filter((b) => b.type === 'image')).toHaveLength(3)
    expect(result.mediaRefHints?.labels).toEqual(['frame-1', 'frame-2', 'frame-3'])
  })

  it('lists status targets without requiring the daemon for metadata', async () => {
    const executors = createAppshotsToolExecutors({
      getBridgeDaemon: () => null,
      attachedWindow: {
        getForChat: () => attached(4242),
        updateStreaming: () => null,
        clearExact: () => null,
        rendererProjectionForChat: () => null
      },
      listTrackedSpawns: () => [{ pid: 77, chatId: 'chat-1' }],
      listLaunchAttempts: () => [
        {
          pid: 88,
          chatId: 'chat-1',
          status: 'running',
          workspacePath: '/ws',
          cwd: '/ws',
          targetLabel: 'web'
        }
      ]
    })
    const result = await executors.executeAppshotsStatus(context())
    expect(result.structuredContent?.ok).toBe(true)
    expect(result.structuredContent?.targetCount).toBeGreaterThanOrEqual(2)
  })
})
