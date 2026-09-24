import { describe, expect, it } from 'vitest'

import {
  SharedWorkspaceRecordCache,
  type SharedWorkspaceRecordFileIdentity
} from './SharedWorkspaceRecordCache'

function identity(seed: number): SharedWorkspaceRecordFileIdentity {
  return {
    dev: 1n,
    ino: BigInt(seed),
    size: BigInt(seed),
    mtimeNs: BigInt(seed),
    ctimeNs: BigInt(seed),
    mode: 0o100600n
  }
}

describe('SharedWorkspaceRecordCache', () => {
  it('uses least-recently-used count eviction', () => {
    const cache = new SharedWorkspaceRecordCache<string>(2, 100)
    cache.set('/a', identity(1), 10, 'a')
    cache.set('/b', identity(2), 10, 'b')
    expect(cache.get('/a', identity(1))).toBe('a')
    cache.set('/c', identity(3), 10, 'c')

    expect(cache.get('/a', identity(1))).toBe('a')
    expect(cache.get('/b', identity(2))).toBeUndefined()
    expect(cache.get('/c', identity(3))).toBe('c')
  })

  it('bounds cached bytes and invalidates a changed identity', () => {
    const cache = new SharedWorkspaceRecordCache<string>(10, 15)
    cache.set('/a', identity(1), 10, 'a')
    cache.set('/b', identity(2), 10, 'b')
    expect(cache.get('/a', identity(1))).toBeUndefined()
    expect(cache.get('/b', identity(2))).toBe('b')

    expect(cache.get('/b', { ...identity(2), ctimeNs: 3n })).toBeUndefined()
    expect(cache.get('/b', identity(2))).toBeUndefined()
  })
})
