import { describe, expect, it } from 'vitest'
import type { ProductChangelogSnapshot } from '../../../main/store/types'
import {
  resolveSidebarQuickUpdateAction,
  shouldAutoOpenChangelog,
  shouldMarkChangelogSeenOnDismiss
} from './useChangelog'

const snapshot = (overrides: Partial<ProductChangelogSnapshot> = {}): ProductChangelogSnapshot => ({
  currentVersion: '1.7.0',
  ...overrides
})

describe('resolveSidebarQuickUpdateAction', () => {
  it('routes each update status to the expected sidebar action', () => {
    expect(resolveSidebarQuickUpdateAction('available')).toBe('download')
    expect(resolveSidebarQuickUpdateAction('downloaded')).toBe('install')
    expect(resolveSidebarQuickUpdateAction('error')).toBe('check')
    expect(resolveSidebarQuickUpdateAction('downloading')).toBe('openChangelog')
  })

  it('returns none for idle or unknown statuses', () => {
    expect(resolveSidebarQuickUpdateAction(undefined)).toBe('none')
    expect(resolveSidebarQuickUpdateAction('idle')).toBe('none')
    expect(resolveSidebarQuickUpdateAction('checking')).toBe('none')
  })

  it('opens the reviewed journey instead of one-click launching an identity handoff', () => {
    expect(resolveSidebarQuickUpdateAction('available', true)).toBe('openChangelog')
    expect(resolveSidebarQuickUpdateAction('downloaded', true)).toBe('openChangelog')
    expect(resolveSidebarQuickUpdateAction('error', true)).toBe('openChangelog')
  })
})

describe('shouldAutoOpenChangelog', () => {
  it('waits until the snapshot and app version are known', () => {
    expect(shouldAutoOpenChangelog(null, '1.7.0')).toBe(false)
    expect(shouldAutoOpenChangelog(snapshot(), 'unknown')).toBe(false)
  })

  it('opens when the pending changelog matches the running version and is unseen', () => {
    expect(
      shouldAutoOpenChangelog(
        snapshot({
          pendingUpdateChangelog: { version: '1.7.0' },
          lastSeenChangelogVersion: '1.6.8'
        }),
        '1.7.0'
      )
    ).toBe(true)
  })

  it('does not open when the pending changelog is for another version', () => {
    expect(
      shouldAutoOpenChangelog(
        snapshot({
          pendingUpdateChangelog: { version: '1.6.8' }
        }),
        '1.7.0'
      )
    ).toBe(false)
  })

  it('does not open when the current version was already seen', () => {
    expect(
      shouldAutoOpenChangelog(
        snapshot({
          pendingUpdateChangelog: { version: '1.7.0' },
          lastSeenChangelogVersion: '1.7.0'
        }),
        '1.7.0'
      )
    ).toBe(false)
  })
})

describe('shouldMarkChangelogSeenOnDismiss', () => {
  it('skips marking when there is no matching pending changelog', () => {
    expect(shouldMarkChangelogSeenOnDismiss(null, '1.7.0')).toBe(false)
    expect(
      shouldMarkChangelogSeenOnDismiss(
        snapshot({ pendingUpdateChangelog: { version: '1.6.8' } }),
        '1.7.0'
      )
    ).toBe(false)
  })

  it('marks seen when the pending changelog matches and is still unseen', () => {
    expect(
      shouldMarkChangelogSeenOnDismiss(
        snapshot({
          pendingUpdateChangelog: { version: '1.7.0' },
          lastSeenChangelogVersion: '1.6.8'
        }),
        '1.7.0'
      )
    ).toBe(true)
  })

  it('does not mark again when the version was already seen', () => {
    expect(
      shouldMarkChangelogSeenOnDismiss(
        snapshot({
          pendingUpdateChangelog: { version: '1.7.0' },
          lastSeenChangelogVersion: '1.7.0'
        }),
        '1.7.0'
      )
    ).toBe(false)
  })
})
