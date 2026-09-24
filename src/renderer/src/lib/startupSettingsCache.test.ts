import { describe, expect, it, vi } from 'vitest'

import { createCoalescedRequest } from './startupSettingsCache'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  const box = {} as {
    promise: Promise<T>
    resolve: (value: T) => void
    reject: (error: unknown) => void
  }
  box.promise = new Promise<T>((resolve, reject) => {
    box.resolve = resolve
    box.reject = reject
  })
  return box
}

describe('createCoalescedRequest', () => {
  it('serves concurrent callers from one underlying request', async () => {
    const gate = deferred<string>()
    const fetch = vi.fn(() => gate.promise)
    const coalesced = createCoalescedRequest(fetch)

    const first = coalesced.request()
    const second = coalesced.request()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(coalesced.sharedCount()).toBe(1)

    gate.resolve('settings')
    expect(await first).toBe('settings')
    expect(await second).toBe('settings')
  })

  it('does not serve a settled result, so a later read is genuinely fresh', async () => {
    let calls = 0
    const fetch = vi.fn(async () => `value-${++calls}`)
    const coalesced = createCoalescedRequest(fetch)

    expect(await coalesced.request()).toBe('value-1')
    expect(await coalesced.request()).toBe('value-2')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('lets a failed boot fetch be retried instead of latching the rejection', async () => {
    let calls = 0
    const fetch = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new Error('main not ready')
      return 'settings'
    })
    const coalesced = createCoalescedRequest(fetch)

    await expect(coalesced.request()).rejects.toThrow('main not ready')
    expect(await coalesced.request()).toBe('settings')
  })

  it('propagates one rejection to every concurrent caller', async () => {
    const gate = deferred<string>()
    const coalesced = createCoalescedRequest(() => gate.promise)
    const first = coalesced.request()
    const second = coalesced.request()
    gate.reject(new Error('boom'))
    await expect(first).rejects.toThrow('boom')
    await expect(second).rejects.toThrow('boom')
  })
})
