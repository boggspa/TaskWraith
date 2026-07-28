import { describe, expect, it, vi } from 'vitest'

import { createNativeProcessStartedAtResolver } from './NativeProcessIdentityResolver'

describe('createNativeProcessStartedAtResolver', () => {
  it('accepts only the exact live proc_bsdinfo response', async () => {
    const request = vi.fn(async () => ({
      pid: 42,
      launchTimeMicros: 1_234_567,
      source: 'procBSDInfo',
      processStartedAt: 'procBSDInfo:1234567'
    }))
    const resolve = createNativeProcessStartedAtResolver({
      daemon: { request },
      platform: 'darwin'
    })

    await expect(resolve(42)).resolves.toBe('procBSDInfo:1234567')
    expect(request).toHaveBeenCalledWith(
      'nativeWindow.processIdentity',
      { pid: 42 },
      { timeoutMs: 2_000 }
    )
  })

  it.each([
    {
      pid: 42,
      launchTimeMicros: 1_234_567,
      source: 'procBSDInfo',
      processStartedAt: 'procBSDInfo:1234567',
      extra: true
    },
    {
      pid: 43,
      launchTimeMicros: 1_234_567,
      source: 'procBSDInfo',
      processStartedAt: 'procBSDInfo:1234567'
    },
    {
      pid: 42,
      launchTimeMicros: 1_234_567,
      source: 'nsRunningApplication',
      processStartedAt: 'nsRunningApplication:1234567'
    },
    {
      pid: 42,
      launchTimeMicros: 1_234_567,
      source: 'procBSDInfo',
      processStartedAt: 'procBSDInfo:7654321'
    }
  ])('rejects malformed, mismatched, or expanded responses', async (response) => {
    const resolve = createNativeProcessStartedAtResolver({
      daemon: { request: vi.fn(async () => response) },
      platform: 'darwin'
    })

    await expect(resolve(42)).resolves.toBeNull()
  })

  it('fails closed without querying on unsupported hosts or invalid PIDs', async () => {
    const request = vi.fn()
    const resolve = createNativeProcessStartedAtResolver({
      daemon: { request },
      platform: 'linux'
    })

    await expect(resolve(42)).resolves.toBeNull()
    await expect(resolve(0)).resolves.toBeNull()
    expect(request).not.toHaveBeenCalled()
  })

  it('leaves a launch view-only when the daemon lookup fails', async () => {
    const resolve = createNativeProcessStartedAtResolver({
      daemon: {
        request: vi.fn(async () => {
          throw new Error('private daemon detail')
        })
      },
      platform: 'darwin'
    })

    await expect(resolve(42)).resolves.toBeNull()
  })
})
