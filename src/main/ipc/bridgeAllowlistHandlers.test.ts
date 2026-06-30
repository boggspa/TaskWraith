import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import {
  createBridgeNetworkingTailscaleStatusGetter,
  registerBridgeAllowlistHandlers
} from './bridgeAllowlistHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function createDeps() {
  return {
    listRemoteAllowlist: vi.fn(() => [{ workspaceId: 'ws-1' }]),
    upsertRemoteAllowlist: vi.fn((entry) => ({ ok: true, entry })),
    removeRemoteAllowlist: vi.fn((workspaceId: string) => ({ ok: true, workspaceId })),
    clearRemoteAllowlist: vi.fn(() => ({ ok: true })),
    broadcastWorkspaceList: vi.fn(),
    broadcastThreadList: vi.fn(),
    broadcastRemoteProjectionSnapshot: vi.fn(),
    getBridgeDaemonStatus: vi.fn(() => ({ running: true, status: 'running' })),
    getBridgeNetworkingTailscaleStatus: vi.fn(async () => ({
      available: true,
      dnsName: 'mac.tail.ts.net'
    }))
  }
}

describe('createBridgeNetworkingTailscaleStatusGetter', () => {
  it('caches available Tailscale status for five seconds', async () => {
    const detectTailscale = vi.fn(async () => ({
      available: true,
      dnsName: 'one.tail.ts.net'
    }))
    let now = 1_000
    const getStatus = createBridgeNetworkingTailscaleStatusGetter({
      detectTailscale,
      getNowMs: () => now
    })

    await expect(getStatus()).resolves.toMatchObject({ dnsName: 'one.tail.ts.net' })
    now = 5_500
    await expect(getStatus()).resolves.toMatchObject({ dnsName: 'one.tail.ts.net' })
    expect(detectTailscale).toHaveBeenCalledOnce()

    now = 6_100
    await expect(getStatus()).resolves.toMatchObject({ dnsName: 'one.tail.ts.net' })
    expect(detectTailscale).toHaveBeenCalledTimes(2)
  })

  it('rechecks unavailable Tailscale status immediately', async () => {
    const detectTailscale = vi.fn(async () => ({
      available: false,
      reason: 'not installed'
    }))
    let now = 1_000
    const getStatus = createBridgeNetworkingTailscaleStatusGetter({
      detectTailscale,
      getNowMs: () => now
    })

    await expect(getStatus()).resolves.toMatchObject({ available: false })
    now = 1_001
    await expect(getStatus()).resolves.toMatchObject({ available: false })
    expect(detectTailscale).toHaveBeenCalledTimes(2)
  })
})

describe('registerBridgeAllowlistHandlers', () => {
  it('registers bridge allowlist and networking IPC channels', () => {
    registerBridgeAllowlistHandlers(createDeps())

    expect(handlerFor('bridge-allowlist-list')).toBeTypeOf('function')
    expect(handlerFor('bridge-allowlist-upsert')).toBeTypeOf('function')
    expect(handlerFor('bridge-allowlist-remove')).toBeTypeOf('function')
    expect(handlerFor('bridge-allowlist-clear')).toBeTypeOf('function')
    expect(handlerFor('bridge-networking-status')).toBeTypeOf('function')
  })

  it('broadcasts visibility changes after allowlist mutations', () => {
    const deps = createDeps()
    registerBridgeAllowlistHandlers(deps)

    const entry = {
      workspaceId: 'ws-1',
      path: '/tmp/ws',
      mode: 'read-only' as const,
      allowedProviders: ['codex'],
      allowedApprovalModes: ['default']
    }

    expect(handlerFor('bridge-allowlist-upsert')({}, entry)).toEqual({ ok: true, entry })
    expect(deps.upsertRemoteAllowlist).toHaveBeenCalledWith(entry)
    expect(deps.broadcastWorkspaceList).toHaveBeenCalledOnce()
    expect(deps.broadcastThreadList).toHaveBeenCalledOnce()
    expect(deps.broadcastRemoteProjectionSnapshot).toHaveBeenCalledOnce()

    expect(handlerFor('bridge-allowlist-remove')({}, 'ws-1')).toEqual({
      ok: true,
      workspaceId: 'ws-1'
    })
    expect(handlerFor('bridge-allowlist-clear')({})).toEqual({ ok: true })
  })

  it('logs projection broadcast failures without failing allowlist mutations', () => {
    const deps = createDeps()
    deps.broadcastRemoteProjectionSnapshot.mockImplementation(() => {
      throw new Error('projection failed')
    })
    registerBridgeAllowlistHandlers(deps)

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = handlerFor('bridge-allowlist-clear')({})
    expect(result).toEqual({ ok: true })
    expect(errorSpy).toHaveBeenCalledWith(
      '[BridgeBroadcaster] allowlist visibility broadcast failed:',
      expect.any(Error)
    )

    errorSpy.mockRestore()
  })

  it('returns bridge networking status with LAN and cached Tailscale status', async () => {
    const deps = createDeps()
    registerBridgeAllowlistHandlers(deps)

    await expect(handlerFor('bridge-networking-status')({})).resolves.toEqual({
      lan: { running: true, status: 'running' },
      tailscale: { available: true, dnsName: 'mac.tail.ts.net' }
    })
    expect(deps.getBridgeDaemonStatus).toHaveBeenCalledOnce()
    expect(deps.getBridgeNetworkingTailscaleStatus).toHaveBeenCalledOnce()
  })
})
