import { describe, expect, it } from 'vitest'
import {
  buildCloseoutSubagentWindow,
  CLOSEOUT_SUBAGENT_PAGE_SIZE,
  CLOSEOUT_SUBAGENT_TABLE_LIMIT
} from './taskWraithCloseoutMessage'

const rows = (count: number): string[] => Array.from({ length: count }, (_, i) => `row-${i + 1}`)

describe('buildCloseoutSubagentWindow', () => {
  it('shows everything, with no controls, when the wave fits', () => {
    const window = buildCloseoutSubagentWindow(rows(3))
    expect(window.items).toHaveLength(3)
    expect(window.canShowMore).toBe(false)
    expect(window.canShowFewer).toBe(false)
    expect(window.hiddenCount).toBe(0)
  })

  it('collapses to the table limit and offers the rest', () => {
    const window = buildCloseoutSubagentWindow(rows(10))
    expect(window.items).toHaveLength(CLOSEOUT_SUBAGENT_TABLE_LIMIT)
    expect(window.canShowMore).toBe(true)
    expect(window.hiddenCount).toBe(2)
    // The button names what the press actually reveals, not the page size.
    expect(window.nextShowCount).toBe(2)
  })

  it('reveals a full page when more than a page remains', () => {
    const window = buildCloseoutSubagentWindow(rows(100))
    expect(window.nextShowCount).toBe(CLOSEOUT_SUBAGENT_PAGE_SIZE)
    expect(window.nextCount).toBe(CLOSEOUT_SUBAGENT_TABLE_LIMIT + CLOSEOUT_SUBAGENT_PAGE_SIZE)
  })

  it('reaches every row — there is no hard ceiling', () => {
    // The whole point of the change: a reader who keeps pressing must get to
    // the end, unlike the File-changes window which caps at MAX_VISIBLE.
    let visible = CLOSEOUT_SUBAGENT_TABLE_LIMIT
    let window = buildCloseoutSubagentWindow(rows(200), visible)
    let presses = 0
    while (window.canShowMore && presses < 100) {
      visible = window.nextCount
      window = buildCloseoutSubagentWindow(rows(200), visible)
      presses += 1
    }
    expect(window.items).toHaveLength(200)
    expect(window.hiddenCount).toBe(0)
    expect(window.canShowMore).toBe(false)
    expect(window.canShowFewer).toBe(true)
  })

  it('never drops below the collapsed limit, however small the request', () => {
    const window = buildCloseoutSubagentWindow(rows(10), 1)
    expect(window.items).toHaveLength(CLOSEOUT_SUBAGENT_TABLE_LIMIT)
    expect(window.canShowFewer).toBe(false)
  })

  it('clamps a request past the end instead of inventing rows', () => {
    const window = buildCloseoutSubagentWindow(rows(9), 500)
    expect(window.items).toHaveLength(9)
    expect(window.visibleCount).toBe(9)
    expect(window.canShowMore).toBe(false)
    expect(window.canShowFewer).toBe(true)
  })

  it('survives an empty table', () => {
    const window = buildCloseoutSubagentWindow([])
    expect(window.items).toEqual([])
    expect(window.canShowMore).toBe(false)
    expect(window.canShowFewer).toBe(false)
    expect(window.hiddenCount).toBe(0)
  })
})
