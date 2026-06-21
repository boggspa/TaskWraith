import { afterEach, describe, expect, it } from 'vitest'
import { __resetRemoteOriginRuns, isRemoteOriginRun, markRemoteOriginRun } from './RemoteOriginRuns'

afterEach(() => __resetRemoteOriginRuns())

describe('RemoteOriginRuns', () => {
  it('marks and recognizes a remote-origin run', () => {
    expect(isRemoteOriginRun('r1')).toBe(false)
    markRemoteOriginRun('r1')
    expect(isRemoteOriginRun('r1')).toBe(true)
    expect(isRemoteOriginRun('r2')).toBe(false)
  })

  it('ignores empty / nullish ids', () => {
    markRemoteOriginRun('')
    markRemoteOriginRun(null)
    markRemoteOriginRun(undefined)
    expect(isRemoteOriginRun('')).toBe(false)
    expect(isRemoteOriginRun(null)).toBe(false)
    expect(isRemoteOriginRun(undefined)).toBe(false)
  })

  it('stays bounded, retaining the most recent', () => {
    for (let i = 0; i < 5200; i += 1) markRemoteOriginRun(`r${i}`)
    expect(isRemoteOriginRun('r5199')).toBe(true)
    expect(isRemoteOriginRun('r0')).toBe(false)
  })
})
