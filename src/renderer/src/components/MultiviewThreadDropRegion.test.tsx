import { act, useLayoutEffect, type DragEvent, type HTMLAttributes, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMultiviewState, type UseMultiviewStateResult } from '../hooks/useMultiviewState'
import { sidebarThreadDragSession } from '../lib/sidebarThreadDragSession'
import { SIDEBAR_THREAD_DRAG_MIME } from '../lib/sidebarThreadOrder'
import { MultiviewThreadDropRegion } from './MultiviewThreadDropRegion'

// React owns the real state/effect lifecycle. A null-rendering observer exposes
// the region's handlers without a DOM dependency. These tests do not emulate
// native pointer delivery, which requires separate Electron interaction QA.
class Target extends EventTarget {
  readonly nodeType = 1
  readonly nodeName = 'DIV'
  readonly tagName = 'DIV'
  readonly namespaceURI = 'http://www.w3.org/1999/xhtml'
  dataset: { paneId?: string } = {}
  parent: Target | null = null
  firstChild = null
  ownerDocument!: EventTarget
  appendChild() {
    // The observer renders no DOM children.
  }
  removeChild() {
    // The observer renders no DOM children.
  }
  contains(node: Target): boolean {
    return node === this || Boolean(node.parent && this.contains(node.parent))
  }
  closest(): Target | null {
    return this.dataset.paneId ? this : (this.parent?.closest() ?? null)
  }
  getBoundingClientRect() {
    return { left: 200, top: 0, right: 1000, bottom: 800, width: 800, height: 800 }
  }
}

let root: Root | null = null
let model: UseMultiviewStateResult
let output: ReactElement<HTMLAttributes<HTMLDivElement>>
let region: Target
let visibleChatId: string | null
let titleAvailable: boolean
let openSingle = vi.fn<(chatId: string) => void>()

function Observer() {
  const state = useMultiviewState({ initialPaneChatId: 'alpha' })
  const rendered = MultiviewThreadDropRegion({
    children: <textarea aria-label="Composer" />,
    multiview: state,
    visibleChatId,
    resolveThreadTitle: (id) => (titleAvailable ? id : null),
    onOpenSingleThread: openSingle
  })
  useLayoutEffect(() => {
    model = state
    output = rendered
  })
  return null
}

function mount(visible: string | null = 'alpha') {
  visibleChatId = visible
  titleAvailable = true
  openSingle = vi.fn()
  const documentTarget = Object.assign(new EventTarget(), {
    nodeType: 9,
    activeElement: null,
    body: null,
    documentElement: {}
  })
  const windowTarget = Object.assign(new EventTarget(), {
    document: documentTarget,
    HTMLElement: Target,
    HTMLIFrameElement: Target,
    setTimeout: globalThis.setTimeout
  })
  Object.assign(documentTarget, { defaultView: windowTarget })
  vi.stubGlobal('window', windowTarget)
  vi.stubGlobal('document', documentTarget)
  vi.stubGlobal('Node', Target)
  vi.stubGlobal('Element', Target)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  region = new Target()
  region.ownerDocument = documentTarget
  root = createRoot(region as unknown as Element)
  act(() => root!.render(<Observer />))
}

function event(options: { x?: number; target?: Target; mime?: string; payloadId?: string } = {}) {
  const transfer = {
    types: [options.mime ?? SIDEBAR_THREAD_DRAG_MIME],
    dropEffect: 'move',
    getData: () => JSON.stringify({ listId: 'code:recents', chatId: options.payloadId ?? 'bravo' })
  }
  return {
    currentTarget: region,
    target: options.target ?? region,
    clientX: options.x ?? 950,
    clientY: 400,
    relatedTarget: null,
    dataTransfer: transfer,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn()
  } as unknown as DragEvent<HTMLDivElement>
}

function start() {
  act(() => sidebarThreadDragSession.start({ listId: 'code:recents', chatId: 'bravo' }))
}

function hover(drag = event()) {
  act(() => output.props.onDragOverCapture!(drag))
  return drag
}

function drop(drag = event()) {
  act(() => output.props.onDropCapture!(drag))
  return drag
}

function previewVisible() {
  return Boolean((output.props.children as unknown[])[1])
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  sidebarThreadDragSession.end()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('MultiviewThreadDropRegion', () => {
  it('previews without switching threads, then commits a split on release', () => {
    mount()
    const original = model.panes
    start()
    const drag = hover()
    expect(model.layout).toBe('single')
    expect(model.panes).toBe(original)
    expect(previewVisible()).toBe(true)
    expect(drag.preventDefault).toHaveBeenCalledOnce()
    expect(drag.stopPropagation).toHaveBeenCalledOnce()
    drop()
    expect(model.layout).toBe('vertical-2')
    expect(model.paneChatIds).toEqual(['alpha', 'bravo'])
    expect(openSingle).not.toHaveBeenCalled()
    expect(previewVisible()).toBe(false)
    expect(sidebarThreadDragSession.getSnapshot()).toBeNull()
  })

  it('captures a drop on a nested composer before its attachment handlers', () => {
    mount()
    act(() => model.setLayout('vertical-2'))
    const pane = new Target()
    pane.parent = region
    pane.dataset.paneId = model.panes[1].id
    const composer = new Target()
    composer.parent = pane
    start()
    hover(event({ target: composer, x: 600 }))
    const release = drop(event({ target: composer, x: 600 }))
    expect(release.preventDefault).toHaveBeenCalledOnce()
    expect(release.stopPropagation).toHaveBeenCalledOnce()
    expect(model.paneChatIds).toEqual(['alpha', 'bravo'])
  })

  it('navigates Thread Home when filling its single empty view', () => {
    mount(null)
    start()
    hover()
    drop()
    expect(model.layout).toBe('single')
    expect(model.paneChatIds).toEqual(['bravo'])
    expect(openSingle).toHaveBeenCalledExactlyOnceWith('bravo')
  })

  it('preserves existing pane refs, scroll intent and focus when splitting to the left', () => {
    mount()
    act(() => {
      model.setLayout('vertical-2')
      model.setPaneChat(1, 'charlie')
      model.setFocusedPane(1)
    })
    const originalRefs = new Map(model.panes.map((pane, index) => [pane.id, model.paneRefs[index]]))
    const firstPaneId = model.panes[0].id
    const focusedPaneId = model.panes[model.focusStore.getSnapshot()].id
    originalRefs.get(firstPaneId)!.setAutoFollow(false)
    const pane = new Target()
    pane.parent = region
    pane.dataset.paneId = firstPaneId
    start()
    hover(event({ target: pane, x: 210 }))
    drop(event({ target: pane, x: 210 }))
    expect(model.panes).toHaveLength(3)
    for (const [paneId, refs] of originalRefs) {
      const index = model.panes.findIndex((candidate) => candidate.id === paneId)
      expect(model.paneRefs[index]).toBe(refs)
    }
    expect(originalRefs.get(firstPaneId)!.autoFollowRef.current).toBe(false)
    expect(model.panes[model.focusStore.getSnapshot()].id).toBe(focusedPaneId)
  })

  it.each(['Escape', 'blur', 'dragend'])('cancels after %s without placing anything', (reason) => {
    mount()
    start()
    hover()
    act(() => {
      if (reason === 'Escape') {
        document.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }))
      } else {
        ;(reason === 'blur' ? window : document).dispatchEvent(new Event(reason))
      }
    })
    expect(previewVisible()).toBe(false)
    drop()
    expect(model.layout).toBe('single')
    expect(model.paneChatIds).toEqual(['alpha'])
    expect(openSingle).not.toHaveBeenCalled()
  })

  it('keeps the cancellation latch through a return-to-sidebar drop dispatch', async () => {
    vi.useFakeTimers()
    mount()
    start()
    hover()
    act(() => output.props.onDragLeaveCapture!(event({ x: 100 })))
    expect(previewVisible()).toBe(false)
    expect(sidebarThreadDragSession.blocksSidebarDrop()).toBe(true)
    document.dispatchEvent(new Event('drop'))
    await Promise.resolve()
    expect(sidebarThreadDragSession.blocksSidebarDrop()).toBe(true)
    expect(model.paneChatIds).toEqual(['alpha'])
    act(() => vi.runOnlyPendingTimers())
    expect(sidebarThreadDragSession.getSnapshot()).toBeNull()
  })

  it('does not erase an in-region preview when crossing between child elements', () => {
    mount()
    start()
    hover()
    const child = new Target()
    child.parent = region
    const leave = { ...event(), relatedTarget: child } as unknown as DragEvent<HTMLDivElement>
    act(() => output.props.onDragLeaveCapture!(leave))
    expect(previewVisible()).toBe(true)
  })

  it.each(['state', 'zone', 'thread', 'payload'])(
    'rejects a release when the %s no longer matches the preview',
    (change) => {
      mount()
      start()
      hover()
      if (change === 'state') act(() => model.setPaneChat(0, 'charlie'))
      if (change === 'thread') titleAvailable = false
      drop(
        event({
          x: change === 'zone' ? 210 : 950,
          payloadId: change === 'payload' ? 'other' : 'bravo'
        })
      )
      expect(model.layout).toBe('single')
      expect(model.paneChatIds).toEqual([change === 'state' ? 'charlie' : 'alpha'])
      expect(previewVisible()).toBe(false)
    }
  )

  it('leaves external file and text drops available to the composer', () => {
    mount()
    for (const mime of ['Files', 'text/plain']) {
      const drag = hover(event({ mime }))
      const release = drop(event({ mime }))
      expect(drag.preventDefault).not.toHaveBeenCalled()
      expect(drag.stopPropagation).not.toHaveBeenCalled()
      expect(release.preventDefault).not.toHaveBeenCalled()
      expect(release.stopPropagation).not.toHaveBeenCalled()
    }
    expect(model.paneChatIds).toEqual(['alpha'])
  })

  it('cancels a gesture when its drop region unmounts', () => {
    mount()
    start()
    hover()
    act(() => root!.unmount())
    root = null
    expect(sidebarThreadDragSession.getSnapshot()?.cancelled).toBe(true)
    expect(sidebarThreadDragSession.blocksSidebarDrop()).toBe(true)
  })
})
