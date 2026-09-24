import { describe, expect, it } from 'vitest'

import {
  createTranscriptGeometryReadPhase,
  type TranscriptScrollGeometrySource
} from './TranscriptGeometryReadBatch'

interface CountingSource extends TranscriptScrollGeometrySource {
  reads: { scrollTop: number; scrollHeight: number; clientHeight: number }
  writes: number[]
}

function createCountingSource(initial: {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  clampScrollTopTo?: number
}): CountingSource {
  const reads = { scrollTop: 0, scrollHeight: 0, clientHeight: 0 }
  const writes: number[] = []
  let scrollTopValue = initial.scrollTop
  const source = { reads, writes } as CountingSource
  Object.defineProperty(source, 'scrollTop', {
    get: () => {
      reads.scrollTop += 1
      return scrollTopValue
    },
    set: (value: number) => {
      writes.push(value)
      scrollTopValue =
        initial.clampScrollTopTo === undefined ? value : Math.min(value, initial.clampScrollTopTo)
    }
  })
  Object.defineProperty(source, 'scrollHeight', {
    get: () => {
      reads.scrollHeight += 1
      return initial.scrollHeight
    }
  })
  Object.defineProperty(source, 'clientHeight', {
    get: () => {
      reads.clientHeight += 1
      return initial.clientHeight
    }
  })
  return source
}

describe('createTranscriptGeometryReadPhase', () => {
  it('reads each property from the DOM once and serves repeats from the cache', () => {
    const source = createCountingSource({ scrollTop: 500, scrollHeight: 1_000, clientHeight: 200 })
    const phase = createTranscriptGeometryReadPhase(source)

    expect(phase.readScrollTop()).toBe(500)
    expect(phase.readScrollHeight()).toBe(1_000)
    expect(phase.readClientHeight()).toBe(200)
    expect(phase.readScrollTop()).toBe(500)
    expect(phase.readScrollHeight()).toBe(1_000)
    expect(phase.readClientHeight()).toBe(200)

    expect(source.reads).toEqual({ scrollTop: 1, scrollHeight: 1, clientHeight: 1 })
    expect(phase.stats).toEqual({ domReads: 3, cacheHits: 3, writes: 0 })
  })

  it('reads lazily and live: a value that changed before the first read is observed', () => {
    // The disengage path depends on this: a native scrollbar move that outran
    // its scroll event must be visible to the pass exactly as an uncached
    // read would see it.
    const source = createCountingSource({ scrollTop: 800, scrollHeight: 1_000, clientHeight: 200 })
    const phase = createTranscriptGeometryReadPhase(source)
    source.scrollTop = 300

    expect(phase.readScrollTop()).toBe(300)
  })

  it('writeScrollTop writes through and invalidates only the cached scrollTop', () => {
    const source = createCountingSource({
      scrollTop: 500,
      scrollHeight: 1_000,
      clientHeight: 200,
      clampScrollTopTo: 800
    })
    const phase = createTranscriptGeometryReadPhase(source)
    phase.readScrollTop()
    phase.readScrollHeight()
    phase.readClientHeight()

    phase.writeScrollTop(1_000)

    // The landed value is browser-clamped: the next read must hit the DOM.
    expect(phase.readScrollTop()).toBe(800)
    // A scroll write cannot change content or viewport size: those stay cached.
    expect(phase.readScrollHeight()).toBe(1_000)
    expect(phase.readClientHeight()).toBe(200)
    expect(source.writes).toEqual([1_000])
    expect(source.reads).toEqual({ scrollTop: 2, scrollHeight: 1, clientHeight: 1 })
    expect(phase.stats).toEqual({ domReads: 4, cacheHits: 2, writes: 1 })
  })

  it('caches a NaN read instead of silently re-probing a detached scroller', () => {
    let scrollTopReads = 0
    const discardedWrites: number[] = []
    const source = {
      get scrollTop() {
        scrollTopReads += 1
        return Number.NaN
      },
      set scrollTop(value: number) {
        discardedWrites.push(value)
      },
      scrollHeight: 1_000,
      clientHeight: 200
    } as TranscriptScrollGeometrySource

    const phase = createTranscriptGeometryReadPhase(source)
    expect(Number.isNaN(phase.readScrollTop())).toBe(true)
    expect(Number.isNaN(phase.readScrollTop())).toBe(true)
    expect(scrollTopReads).toBe(1)
  })
})
