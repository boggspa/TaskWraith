import { collectIpcSubscriptions, type IpcUnsubscribe } from './useScopedIpc'
import { describe, it, expect, vi } from 'vitest'

describe('collectIpcSubscriptions', () => {
  it('returns count 0 and a no-op unsubscribeAll for an empty array', () => {
    const { count, unsubscribeAll } = collectIpcSubscriptions([])
    expect(count).toBe(0)
    expect(() => unsubscribeAll()).not.toThrow()
  })

  it('filters falsy entries and counts only functions', () => {
    const fn1 = vi.fn()
    const fn2 = vi.fn()
    const { count, unsubscribeAll } = collectIpcSubscriptions([
      fn1,
      false,
      null,
      undefined,
      fn2,
    ])
    expect(count).toBe(2)
    unsubscribeAll()
    expect(fn1).toHaveBeenCalledTimes(1)
    expect(fn2).toHaveBeenCalledTimes(1)
  })

  it('runs unsubscribes in reverse order', () => {
    const order: number[] = []
    const fn1 = vi.fn(() => order.push(1))
    const fn2 = vi.fn(() => order.push(2))
    const fn3 = vi.fn(() => order.push(3))
    const { unsubscribeAll } = collectIpcSubscriptions([fn1, fn2, fn3])
    unsubscribeAll()
    expect(order).toEqual([3, 2, 1])
  })

  it('continues cleanup even when one unsubscribe throws', () => {
    const fn1 = vi.fn()
    const fn2 = vi.fn(() => {
      throw new Error('boom')
    })
    const fn3 = vi.fn()
    const { unsubscribeAll } = collectIpcSubscriptions([fn1, fn2, fn3])
    expect(() => unsubscribeAll()).not.toThrow()
    expect(fn1).toHaveBeenCalledTimes(1)
    expect(fn2).toHaveBeenCalledTimes(1)
    expect(fn3).toHaveBeenCalledTimes(1)
  })

  it('tolerates all-falsy arrays', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { count, unsubscribeAll } = collectIpcSubscriptions([false, null, undefined])
    expect(count).toBe(0)
    expect(() => unsubscribeAll()).not.toThrow()
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('logs an error when a non-function truthy entry is encountered', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fn = vi.fn()
    const { count } = collectIpcSubscriptions([fn, 'not-a-function' as unknown as IpcUnsubscribe, 42 as unknown as IpcUnsubscribe])
    expect(count).toBe(1)
    expect(errorSpy).toHaveBeenCalledTimes(2)
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      '[collectIpcSubscriptions] non-function entry encountered — expected IpcUnsubscribe or falsy, got:',
      'not-a-function'
    )
    expect(errorSpy).toHaveBeenNthCalledWith(
      2,
      '[collectIpcSubscriptions] non-function entry encountered — expected IpcUnsubscribe or falsy, got:',
      42
    )
    errorSpy.mockRestore()
  })

  it('logs an error when an unsubscribe throws', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fn1 = vi.fn()
    const fn2 = vi.fn(() => {
      throw new Error('unsub-boom')
    })
    const { unsubscribeAll } = collectIpcSubscriptions([fn1, fn2])
    unsubscribeAll()
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith(
      '[collectIpcSubscriptions] unsubscribe threw:',
      expect.any(Error)
    )
    errorSpy.mockRestore()
  })
})
