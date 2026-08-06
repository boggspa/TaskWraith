import { describe, expect, it, vi } from 'vitest'

import { createNativeWindowProcessAncestryResolver } from './NativeWindowProcessAncestryClient'

const ROOT_RECEIPT = 'procBSDInfo:1774843200100000'
const WINDOW_RECEIPT = 'procBSDInfo:1774843200900000'

function chain() {
  return [
    {
      pid: 199,
      ppid: 150,
      launchTimeMicros: 1774843200900000,
      source: 'procBSDInfo',
      processStartedAt: WINDOW_RECEIPT
    },
    {
      pid: 150,
      ppid: 101,
      launchTimeMicros: 1774843200500000,
      source: 'procBSDInfo',
      processStartedAt: 'procBSDInfo:1774843200500000'
    },
    {
      pid: 101,
      ppid: 1,
      launchTimeMicros: 1774843200100000,
      source: 'procBSDInfo',
      processStartedAt: ROOT_RECEIPT
    }
  ]
}

function resolver(
  request: (method: string, params?: unknown) => Promise<unknown>,
  platform: NodeJS.Platform = 'darwin'
) {
  return createNativeWindowProcessAncestryResolver({ daemon: { request }, platform })
}

const endpoints = {
  leafPid: 199,
  leafProcessStartedAt: WINDOW_RECEIPT,
  rootPid: 101,
  rootProcessStartedAt: ROOT_RECEIPT
}

describe('createNativeWindowProcessAncestryResolver', () => {
  it('returns a verified proof for a real descendant chain', async () => {
    const request = vi.fn().mockResolvedValue({ chain: chain() })
    const proof = await resolver(request)(endpoints)

    expect(proof).toMatchObject({ leafPid: 199, rootPid: 101, depth: 2 })
    expect(request).toHaveBeenCalledWith(
      'nativeWindow.processAncestry',
      { pid: 199, ancestorPid: 101, maxDepth: expect.any(Number) },
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    )
  })

  it('drops daemon fields the proof has no use for', async () => {
    const proof = await resolver(vi.fn().mockResolvedValue({ chain: chain() }))(endpoints)
    expect(proof?.chain[0]).toEqual({ pid: 199, ppid: 150, processStartedAt: WINDOW_RECEIPT })
  })

  it('returns null when the daemon chain fails verification', async () => {
    const broken = chain()
    broken[1] = { ...broken[1], ppid: 777 }
    expect(await resolver(vi.fn().mockResolvedValue({ chain: broken }))(endpoints)).toBeNull()
  })

  it('returns null when the daemon refuses or is unavailable', async () => {
    const rejecting = vi.fn().mockRejectedValue(new Error('not a descendant'))
    expect(await resolver(rejecting)(endpoints)).toBeNull()

    for (const malformed of [null, {}, { chain: 'nope' }, { chain: [] }]) {
      expect(await resolver(vi.fn().mockResolvedValue(malformed))(endpoints)).toBeNull()
    }
  })

  it('never calls the daemon off darwin or for invalid endpoints', async () => {
    const request = vi.fn()
    expect(await resolver(request, 'win32')(endpoints)).toBeNull()
    expect(await resolver(request)({ ...endpoints, leafPid: 0 })).toBeNull()
    expect(await resolver(request)({ ...endpoints, rootProcessStartedAt: 'nope' })).toBeNull()
    expect(request).not.toHaveBeenCalled()
  })

  it('does not ask the daemon when the window is the launch process itself', async () => {
    const request = vi.fn()
    const proof = await resolver(request)({
      leafPid: 101,
      leafProcessStartedAt: ROOT_RECEIPT,
      rootPid: 101,
      rootProcessStartedAt: ROOT_RECEIPT
    })
    expect(proof).toMatchObject({ depth: 0 })
    expect(request).not.toHaveBeenCalled()
  })

  it('refuses to prove a protected host window is drivable', async () => {
    const proof = await resolver(vi.fn().mockResolvedValue({ chain: chain() }))({
      ...endpoints,
      hostProtectedPids: new Set([199])
    })
    expect(proof).toBeNull()
  })
})
