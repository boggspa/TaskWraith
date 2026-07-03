import { describe, expect, it } from 'vitest'
import {
  isWorkspaceFullAccessEnabled,
  normalizeFullWorkspaceAccessPaths,
  withWorkspaceFullAccess,
  withoutWorkspaceFullAccess
} from './WorkspaceFullAccess'

describe('isWorkspaceFullAccessEnabled', () => {
  it('matches an enabled workspace regardless of trailing slash', () => {
    const settings = { fullWorkspaceAccessPaths: ['/Users/me/proj'] }
    expect(isWorkspaceFullAccessEnabled(settings, '/Users/me/proj')).toBe(true)
    expect(isWorkspaceFullAccessEnabled(settings, '/Users/me/proj/')).toBe(true)
    expect(isWorkspaceFullAccessEnabled(settings, '/Users/me/other')).toBe(false)
  })

  it('is false for empty / missing settings or path', () => {
    expect(isWorkspaceFullAccessEnabled(undefined, '/Users/me/proj')).toBe(false)
    expect(isWorkspaceFullAccessEnabled({ fullWorkspaceAccessPaths: [] }, '/Users/me/proj')).toBe(
      false
    )
    expect(
      isWorkspaceFullAccessEnabled({ fullWorkspaceAccessPaths: ['/Users/me/proj'] }, '')
    ).toBe(false)
    expect(
      isWorkspaceFullAccessEnabled({ fullWorkspaceAccessPaths: ['/Users/me/proj'] }, null)
    ).toBe(false)
  })
})

describe('normalizeFullWorkspaceAccessPaths', () => {
  it('normalizes to absolute, de-duplicated, non-empty paths', () => {
    expect(normalizeFullWorkspaceAccessPaths(['/a', '/a/', '', '   ', 42, '/b'])).toEqual([
      '/a',
      '/b'
    ])
    expect(normalizeFullWorkspaceAccessPaths('nope')).toEqual([])
    expect(normalizeFullWorkspaceAccessPaths(undefined)).toEqual([])
  })
})

describe('withWorkspaceFullAccess / withoutWorkspaceFullAccess', () => {
  it('adds and removes idempotently (dedup by normalized path)', () => {
    const added = withWorkspaceFullAccess([], '/Users/me/proj')
    expect(added).toEqual(['/Users/me/proj'])
    expect(withWorkspaceFullAccess(added, '/Users/me/proj/')).toEqual(['/Users/me/proj'])
    expect(withoutWorkspaceFullAccess(added, '/Users/me/proj')).toEqual([])
    expect(withoutWorkspaceFullAccess(added, '/Users/me/proj/')).toEqual([])
  })
})
