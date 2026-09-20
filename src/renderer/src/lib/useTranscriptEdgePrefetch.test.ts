import { describe, expect, it, vi } from 'vitest'
import {
  observeTranscriptEdgePrefetch,
  transcriptEdgePrefetchDirection,
  type TranscriptEdgePrefetchState
} from './useTranscriptEdgePrefetch'

const bothEdges: TranscriptEdgePrefetchState = {
  hasOlder: true,
  hasNewer: true,
  nearOlder: true,
  nearNewer: true,
  following: false
}

describe('transcriptEdgePrefetchDirection', () => {
  it('does not treat both mounted overscan edges as requests at the live tail', () => {
    expect(
      transcriptEdgePrefetchDirection({
        ...bothEdges,
        following: true,
        hasNewer: false,
        scrollTop: 2000,
        scrollHeight: 2800,
        clientHeight: 800
      })
    ).toBeNull()
  })

  it('selects only the physically nearby edge while browsing collapsed history', () => {
    const geometry = { scrollHeight: 2800, clientHeight: 800 }
    expect(transcriptEdgePrefetchDirection({ ...bothEdges, ...geometry, scrollTop: 0 })).toBe(
      'older'
    )
    expect(
      transcriptEdgePrefetchDirection({ ...bothEdges, ...geometry, scrollTop: 1000 })
    ).toBeNull()
    expect(transcriptEdgePrefetchDirection({ ...bothEdges, ...geometry, scrollTop: 2000 })).toBe(
      'newer'
    )
  })

  it('keeps edge zones disjoint for a short scroll range', () => {
    const geometry = { scrollHeight: 820, clientHeight: 800 }
    expect(transcriptEdgePrefetchDirection({ ...bothEdges, ...geometry, scrollTop: 0 })).toBe(
      'older'
    )
    expect(transcriptEdgePrefetchDirection({ ...bothEdges, ...geometry, scrollTop: 10 })).toBeNull()
    expect(transcriptEdgePrefetchDirection({ ...bothEdges, ...geometry, scrollTop: 20 })).toBe(
      'newer'
    )
  })

  it('does not refill an unscrollable folded window without another gesture', () => {
    const geometry = { scrollTop: 0, scrollHeight: 400, clientHeight: 800 }
    expect(transcriptEdgePrefetchDirection({ ...bothEdges, ...geometry })).toBeNull()
    expect(transcriptEdgePrefetchDirection({ ...bothEdges, ...geometry, intent: 'older' })).toBe(
      'older'
    )
    expect(transcriptEdgePrefetchDirection({ ...bothEdges, ...geometry, intent: 'newer' })).toBe(
      'newer'
    )
    expect(
      transcriptEdgePrefetchDirection({
        ...bothEdges,
        ...geometry,
        hasOlder: false,
        intent: 'older'
      })
    ).toBeNull()
  })

  it('requires the matching mounted edge and a visible viewport', () => {
    expect(
      transcriptEdgePrefetchDirection({
        ...bothEdges,
        nearOlder: false,
        scrollTop: 0,
        scrollHeight: 2800,
        clientHeight: 800
      })
    ).toBeNull()
    expect(
      transcriptEdgePrefetchDirection({
        ...bothEdges,
        scrollTop: 0,
        scrollHeight: 2800,
        clientHeight: 0
      })
    ).toBeNull()
  })
})

function harness() {
  const scroller = Object.assign(new EventTarget(), {
    scrollTop: 2000,
    scrollHeight: 2800,
    clientHeight: 800
  }) as HTMLDivElement
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  const load = vi.fn()
  const state = { ...bothEdges }
  const dispose = observeTranscriptEdgePrefetch({
    scroller,
    readState: () => state,
    load,
    requestFrame: (callback) => {
      frames.set(++frameId, callback)
      return frameId
    },
    cancelFrame: (frame) => {
      frames.delete(frame)
    }
  })
  const flush = () => {
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach((callback) => callback(0))
  }
  return { scroller, frames, load, state, dispose, flush }
}

describe('observeTranscriptEdgePrefetch', () => {
  it('defers synchronous store publication and coalesces repeated scrolls', () => {
    const h = harness()
    h.scroller.dispatchEvent(new Event('scroll'))
    h.scroller.dispatchEvent(new Event('scroll'))
    expect(h.load).not.toHaveBeenCalled()
    expect(h.frames.size).toBe(1)
    h.flush()
    expect(h.load.mock.calls).toEqual([['newer']])
    h.dispose()
  })

  it('observes movement within an unchanged mounted band and reads fresh follow state', () => {
    const h = harness()
    h.state.following = true
    h.state.hasNewer = false
    h.flush()
    expect(h.load).not.toHaveBeenCalled()
    h.scroller.scrollTop = 0
    h.state.following = false
    h.scroller.dispatchEvent(new Event('scroll'))
    h.flush()
    expect(h.load.mock.calls).toEqual([['older']])
    h.dispose()
  })

  it('consumes one wheel request for an unscrollable window', () => {
    const h = harness()
    Object.defineProperty(h.scroller, 'scrollHeight', { value: 400 })
    h.scroller.scrollTop = 0
    h.flush()
    const wheel = Object.assign(new Event('wheel'), { deltaY: -100, ctrlKey: false })
    h.scroller.dispatchEvent(wheel)
    h.flush()
    expect(h.load.mock.calls).toEqual([['older']])
    h.scroller.dispatchEvent(new Event('scroll'))
    h.flush()
    expect(h.load).toHaveBeenCalledTimes(1)
    h.dispose()
  })

  it('cancels queued loads and listeners on navigation or unmount', () => {
    const h = harness()
    h.dispose()
    h.scroller.dispatchEvent(new Event('scroll'))
    h.flush()
    expect(h.frames.size).toBe(0)
    expect(h.load).not.toHaveBeenCalled()
  })

  it('leaves nested activity scrolling and pinch zoom with their owners', () => {
    const h = harness()
    Object.defineProperty(h.scroller, 'scrollHeight', { value: 400 })
    h.flush()
    const style = vi.fn(() => ({ overflowY: 'auto' }))
    vi.stubGlobal('getComputedStyle', style)
    try {
      const wheel = Object.assign(new Event('wheel'), { deltaY: -100, ctrlKey: false })
      Object.defineProperty(wheel, 'target', {
        value: { scrollHeight: 600, clientHeight: 100, parentElement: h.scroller }
      })
      h.scroller.dispatchEvent(wheel)
      expect(style).not.toHaveBeenCalled()
      h.flush()
      expect(style).toHaveBeenCalledTimes(1)
      expect(h.load).not.toHaveBeenCalled()
      h.scroller.dispatchEvent(Object.assign(new Event('wheel'), { deltaY: 100, ctrlKey: true }))
      expect(h.frames.size).toBe(0)
    } finally {
      h.dispose()
      vi.unstubAllGlobals()
    }
  })
})
