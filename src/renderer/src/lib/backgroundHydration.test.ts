import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveWithinDeadline } from './backgroundHydration'

describe('resolveWithinDeadline', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the fallback when a non-critical request does not settle', async () => {
    vi.useFakeTimers()
    let resolveRequest!: (value: string) => void
    const request = new Promise<string>((resolve) => {
      resolveRequest = resolve
    })

    const result = resolveWithinDeadline(request, 'empty', 100)
    await vi.advanceTimersByTimeAsync(100)
    await expect(result).resolves.toBe('empty')

    // A late provider result is harmless once the current render has escaped.
    resolveRequest('late')
    await Promise.resolve()
  })

  it('returns a prompt result before the deadline', async () => {
    await expect(resolveWithinDeadline(Promise.resolve('ready'), 'empty', 100)).resolves.toBe(
      'ready'
    )
  })
})
