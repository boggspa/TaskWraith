import { describe, expect, it } from 'vitest'
import {
  buildCloseoutCommitWindow,
  CLOSEOUT_COMMIT_PAGE_SIZE,
  CLOSEOUT_COMMIT_TABLE_LIMIT
} from './taskWraithCloseoutMessage'

const rows = (count: number): string[] => Array.from({ length: count }, (_, i) => `commit-${i + 1}`)

describe('buildCloseoutCommitWindow', () => {
  it('shows everything, with no controls, when the close-out fits', () => {
    const window = buildCloseoutCommitWindow(rows(3))
    expect(window.items).toHaveLength(3)
    expect(window.canShowMore).toBe(false)
    expect(window.canShowFewer).toBe(false)
    expect(window.hiddenCount).toBe(0)
  })

  it('collapses to the table limit and offers the rest', () => {
    const window = buildCloseoutCommitWindow(rows(10))
    expect(window.items).toHaveLength(CLOSEOUT_COMMIT_TABLE_LIMIT)
    expect(window.canShowMore).toBe(true)
    expect(window.hiddenCount).toBe(2)
    // The button names what the press actually reveals, not the page size.
    expect(window.nextShowCount).toBe(2)
  })

  it('reveals a full page when more than a page remains', () => {
    const window = buildCloseoutCommitWindow(rows(100))
    expect(window.nextShowCount).toBe(CLOSEOUT_COMMIT_PAGE_SIZE)
    expect(window.nextCount).toBe(CLOSEOUT_COMMIT_TABLE_LIMIT + CLOSEOUT_COMMIT_PAGE_SIZE)
  })

  it('reaches every commit — there is no hard ceiling', () => {
    // A close-out's commits are the evidence for the work it claims to have
    // done, so a reader who keeps pressing must be able to audit all of them.
    let visible = CLOSEOUT_COMMIT_TABLE_LIMIT
    let window = buildCloseoutCommitWindow(rows(200), visible)
    let presses = 0
    while (window.canShowMore && presses < 100) {
      visible = window.nextCount
      window = buildCloseoutCommitWindow(rows(200), visible)
      presses += 1
    }
    expect(window.items).toHaveLength(200)
    expect(window.hiddenCount).toBe(0)
    expect(window.canShowMore).toBe(false)
    expect(window.canShowFewer).toBe(true)
  })

  it('never drops below the collapsed limit, however small the request', () => {
    const window = buildCloseoutCommitWindow(rows(10), 1)
    expect(window.items).toHaveLength(CLOSEOUT_COMMIT_TABLE_LIMIT)
    expect(window.canShowFewer).toBe(false)
  })

  it('clamps a request past the end instead of inventing rows', () => {
    const window = buildCloseoutCommitWindow(rows(9), 500)
    expect(window.items).toHaveLength(9)
    expect(window.visibleCount).toBe(9)
    expect(window.canShowMore).toBe(false)
    expect(window.canShowFewer).toBe(true)
  })

  it('survives an empty table', () => {
    const window = buildCloseoutCommitWindow([])
    expect(window.items).toEqual([])
    expect(window.canShowMore).toBe(false)
    expect(window.canShowFewer).toBe(false)
    expect(window.hiddenCount).toBe(0)
  })
})
