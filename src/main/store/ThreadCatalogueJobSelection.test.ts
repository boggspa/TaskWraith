import { describe, expect, it } from 'vitest'
import {
  BACKGROUND_STARVATION_FLOOR,
  isFastLaneCatalogueJob,
  selectNextCatalogueJob,
  type CatalogueJobLane
} from './ThreadCatalogueJobSelection'

const repair = (): CatalogueJobLane => ({ mode: 'metadata' })
const opened = (): CatalogueJobLane => ({ mode: 'metadata', priority: true })
const paged = (): CatalogueJobLane => ({ mode: 'pages' })

describe('isFastLaneCatalogueJob', () => {
  it('puts an unprioritised metadata job in the slow lane and everything else in the fast one', () => {
    expect(isFastLaneCatalogueJob(repair())).toBe(false)
    expect(isFastLaneCatalogueJob(opened())).toBe(true)
    expect(isFastLaneCatalogueJob(paged())).toBe(true)
    expect(isFastLaneCatalogueJob({ mode: 'metadata', priority: false })).toBe(false)
  })
})

describe('selectNextCatalogueJob', () => {
  // The defect: the recovery drain opens every thread at mode 'metadata', and
  // the worker escalated every open into the fast lane, so repair sat FIFO with
  // a user's chat open.
  it('takes a fast-lane job over an older slow-lane one', () => {
    const selection = selectNextCatalogueJob([repair(), repair(), opened()], 0)
    expect(selection.index).toBe(2)
  })

  it('takes the head when nothing is in the fast lane', () => {
    const selection = selectNextCatalogueJob([repair(), repair()], 0)
    expect(selection.index).toBe(0)
    expect(selection.consecutiveFastPicks).toBe(0)
  })

  it('counts consecutive fast-lane picks', () => {
    let picks = 0
    for (let i = 0; i < 3; i += 1) {
      picks = selectNextCatalogueJob([repair(), opened()], picks).consecutiveFastPicks
    }
    expect(picks).toBe(3)
  })

  // Strict priority is only safe while nothing uses the slow lane. Recovery's
  // own pump is serial, so one starved chat stops the whole corpus — and
  // `quiesce()` gives up after 30s, which on quit skips `dispose()` and
  // `flushAllChatSaves()`.
  it('takes the queue head once the floor is reached, even with a fast job waiting', () => {
    const queue = [repair(), opened()]
    const selection = selectNextCatalogueJob(queue, BACKGROUND_STARVATION_FLOOR)
    expect(selection.index).toBe(0)
    expect(selection.consecutiveFastPicks).toBe(0)
  })

  it('never passes over a slow-lane job more than the floor allows', () => {
    let picks = 0
    const chosen: number[] = []
    for (let i = 0; i < BACKGROUND_STARVATION_FLOOR + 2; i += 1) {
      const selection = selectNextCatalogueJob([repair(), opened()], picks)
      chosen.push(selection.index)
      picks = selection.consecutiveFastPicks
    }
    expect(chosen.slice(0, BACKGROUND_STARVATION_FLOOR).every((index) => index === 1)).toBe(true)
    expect(chosen[BACKGROUND_STARVATION_FLOOR]).toBe(0)
    // ...and the counter resets, so the fast lane is served again straight after.
    expect(chosen[BACKGROUND_STARVATION_FLOOR + 1]).toBe(1)
  })

  it('leaves the counter alone for an empty queue', () => {
    expect(selectNextCatalogueJob([], 3)).toEqual({ index: 0, consecutiveFastPicks: 3 })
  })

  it('honours a floor passed explicitly', () => {
    expect(selectNextCatalogueJob([repair(), opened()], 1, 1).index).toBe(0)
    expect(selectNextCatalogueJob([repair(), opened()], 0, 1).index).toBe(1)
  })
})
