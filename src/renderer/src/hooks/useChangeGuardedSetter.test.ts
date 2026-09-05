import { describe, expect, it, vi } from 'vitest'
import { createChangeGuardedSetter } from './useChangeGuardedSetter'

describe('createChangeGuardedSetter', () => {
  it('forwards the first write and every change, skipping repeats of the last value', () => {
    const setter = vi.fn()
    const commit = createChangeGuardedSetter<{ id: number } | null>(setter)
    const first = { id: 1 }
    commit(first)
    commit(first)
    expect(setter).toHaveBeenCalledTimes(1)
    commit(null)
    commit(null)
    expect(setter).toHaveBeenCalledTimes(2)
    commit({ id: 1 })
    expect(setter).toHaveBeenCalledTimes(3)
    expect(setter).toHaveBeenLastCalledWith({ id: 1 })
  })

  it('compares with Object.is, so NaN repeats are skipped and -0/+0 are distinct', () => {
    const setter = vi.fn()
    const commit = createChangeGuardedSetter<number>(setter)
    commit(Number.NaN)
    commit(Number.NaN)
    expect(setter).toHaveBeenCalledTimes(1)
    commit(0)
    commit(-0)
    expect(setter).toHaveBeenCalledTimes(3)
  })
})
