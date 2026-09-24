import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VirtualRow } from '../lib/TranscriptVirtualWindow'
import { useTranscriptVirtualization } from './TranscriptPanel'

let root: Root | null = null
let frameId = 0
const frames = new Map<number, FrameRequestCallback>()

// Real React scheduling with synthetic geometry: the hook renders no host
// elements, and every offset below is supplied by the regression scenario.
function installRoot(): Root {
  class Element extends EventTarget {
    readonly nodeType = 1
  }
  class IFrame extends Element {}
  const documentTarget = Object.assign(new EventTarget(), {
    nodeType: 9,
    activeElement: null,
    body: null,
    documentElement: {}
  })
  const requestFrame = (callback: FrameRequestCallback): number => {
    frames.set(++frameId, callback)
    return frameId
  }
  const cancelFrame = (id: number): void => {
    frames.delete(id)
  }
  const windowTarget = Object.assign(new EventTarget(), {
    document: documentTarget,
    HTMLElement: Element,
    HTMLIFrameElement: IFrame,
    requestAnimationFrame: requestFrame,
    cancelAnimationFrame: cancelFrame
  })
  Object.assign(documentTarget, { defaultView: windowTarget })
  vi.stubGlobal('window', windowTarget)
  vi.stubGlobal('document', documentTarget)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', requestFrame)
  vi.stubGlobal('cancelAnimationFrame', cancelFrame)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }
  )
  const container = Object.assign(new Element(), {
    ownerDocument: documentTarget,
    nodeName: 'DIV',
    tagName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    firstChild: null,
    appendChild: () => undefined,
    removeChild: () => undefined
  }) as unknown as HTMLDivElement
  root = createRoot(container)
  return root
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  frames.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function drainFrames(limit = 300): void {
  for (let i = 0; frames.size && i < limit; i++) {
    const batch = [...frames.values()]
    frames.clear()
    act(() => batch.forEach((callback) => callback(i * 16)))
  }
  expect(frames.size).toBe(0)
}

function scenario({
  count,
  estimatedHeight,
  slot,
  active = false
}: {
  count: number
  estimatedHeight: number
  slot: (render: number) => number
  active?: boolean
}) {
  const rows: VirtualRow[] = Array.from({ length: count }, (_, index) => ({
    id: `row-${index}`,
    rowKey: `row-${index}#0`,
    index,
    rowType: 'assistant',
    contentVersion: 'v1',
    estimatedHeight,
    hasRunBoundary: false
  }))
  const scrollRef = {
    current: Object.assign(new EventTarget(), {
      scrollTop: 0,
      scrollHeight: 1000000,
      clientHeight: 600,
      clientWidth: 800
    }) as unknown as HTMLDivElement
  }
  const autoFollowRef = { current: true }
  const activeLiveRowKeys = new Set(active ? rows.map((row) => row.rowKey) : [])
  let renders = 0
  let latest: ReturnType<typeof useTranscriptVirtualization>
  function TranscriptGeometry() {
    renders++
    latest = useTranscriptVirtualization({
      enabled: true,
      rows,
      scrollRef,
      autoFollowRef,
      activeLiveRowKeys,
      compactDensity: false,
      chatId: 'long-thread'
    })
    const height = slot(renders)
    for (let i = latest.window.startIndex; i < latest.window.endIndex; i++) {
      latest.blockRef({
        isConnected: true,
        dataset: { vrowId: rows[i].rowKey },
        offsetTop: i * height,
        offsetHeight: height
      } as unknown as HTMLDivElement)
    }
    latest.spacerBottomRef.current = {
      isConnected: true,
      offsetTop: latest.window.endIndex * height
    } as HTMLDivElement
    return null
  }
  return {
    Component: TranscriptGeometry,
    renders: () => renders,
    heights: () => latest.heights,
    window: () => latest.window
  }
}

describe('transcript measurement scheduling in React', () => {
  it('yields while a long page reveals newly measured rows, then finishes coverage', () => {
    const root = installRoot()
    const view = scenario({ count: 500, estimatedHeight: 2000, slot: () => 8 })
    expect(() => act(() => root.render(<view.Component />))).not.toThrow()
    expect(view.renders()).toBeLessThan(12)
    drainFrames()
    expect(view.window().endIndex).toBe(500)
    expect(
      view
        .heights()
        .slice(view.window().startIndex)
        .every((height) => height === 8)
    ).toBe(true)
    act(() => root.unmount())
    expect(frames.size).toBe(0)
  })

  it('bounds alternating growth and shrinkage of an active row under the same key', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const root = installRoot()
    const view = scenario({
      count: 1,
      estimatedHeight: 120,
      active: true,
      slot: (render) => (render % 2 === 0 ? 120 : 240)
    })
    expect(() => act(() => root.render(<view.Component />))).not.toThrow()
    drainFrames()
    expect(view.renders()).toBeLessThan(30)
    expect(view.heights()[0]).toBeGreaterThan(0)
  })

  it('cancels pending page measurements when the transcript unmounts', () => {
    const root = installRoot()
    const view = scenario({ count: 500, estimatedHeight: 2000, slot: () => 8 })
    act(() => root.render(<view.Component />))
    expect(frames.size).toBeGreaterThan(0)
    act(() => root.unmount())
    expect(frames.size).toBe(0)
  })
})
