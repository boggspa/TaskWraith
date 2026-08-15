import { Profiler, act, createElement, type MutableRefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { StructuralGutterSpyProps } from './TranscriptUserMessageGutter'
import type { TranscriptScrollSpy } from './TranscriptVirtualWindow'
import { useGutterLiveSpy } from './useGutterLiveSpy'

let mountedRoot: Root | null = null
let savedGlobals: Map<string, PropertyDescriptor | undefined> | null = null

afterEach(() => {
  act(() => mountedRoot?.unmount())
  mountedRoot = null
  if (!savedGlobals) return
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete (globalThis as Record<string, unknown>)[name]
  }
  savedGlobals = null
})

function installMinimalRendererDom(): Element {
  const names = ['window', 'document', 'Node', 'HTMLElement', 'Element', 'IS_REACT_ACT_ENVIRONMENT']
  savedGlobals = new Map(
    names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
  )
  class MinimalNode extends EventTarget {
    readonly nodeType: number = 0
  }
  class MinimalHTMLElement extends MinimalNode {
    override readonly nodeType: number = 1
  }
  class MinimalHTMLIFrameElement extends MinimalHTMLElement {}
  const documentTarget = new EventTarget() as EventTarget & Record<string, unknown>
  documentTarget.nodeType = 9
  documentTarget.activeElement = null
  documentTarget.body = null
  documentTarget.documentElement = {}
  const windowTarget = new EventTarget() as EventTarget & Record<string, unknown>
  windowTarget.document = documentTarget
  windowTarget.Node = MinimalNode
  windowTarget.HTMLElement = MinimalHTMLElement
  windowTarget.HTMLIFrameElement = MinimalHTMLIFrameElement
  windowTarget.setTimeout = globalThis.setTimeout
  windowTarget.clearTimeout = globalThis.clearTimeout
  documentTarget.defaultView = windowTarget
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: windowTarget },
    document: { configurable: true, value: documentTarget },
    Node: { configurable: true, value: MinimalNode },
    HTMLElement: { configurable: true, value: MinimalHTMLElement },
    Element: { configurable: true, value: MinimalHTMLElement },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true }
  })
  return Object.assign(new MinimalHTMLElement(), {
    ownerDocument: documentTarget,
    nodeName: 'DIV',
    tagName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    firstChild: null,
    appendChild: () => undefined,
    removeChild: () => undefined
  }) as unknown as Element
}

describe('useGutterLiveSpy', () => {
  it('invalidates structural changes without a passive follow-up commit and re-latches', () => {
    const container = installMinimalRendererDom()
    const spySinkRef: MutableRefObject<((snapshot: TranscriptScrollSpy) => void) | null> = {
      current: null
    }
    let renderedSpy: TranscriptScrollSpy | null = null
    let commits = 0

    function Harness({ structuralProps }: { structuralProps: StructuralGutterSpyProps }): null {
      renderedSpy = useGutterLiveSpy(spySinkRef, structuralProps)
      return null
    }

    const render = (structuralProps: StructuralGutterSpyProps): void => {
      mountedRoot?.render(
        createElement(
          Profiler,
          {
            id: 'gutter-live-spy',
            onRender: () => {
              commits += 1
            }
          },
          createElement(Harness, { structuralProps })
        )
      )
    }

    mountedRoot = createRoot(container)
    act(() =>
      render({
        scrollProgress: 0.4,
        scrollViewportFraction: 0.2,
        activeScrollRowKey: 'u#0'
      })
    )
    const snapshot = { rowIndex: 12, progress: 0.4, viewportFraction: 0.2 }
    act(() => spySinkRef.current?.(snapshot))
    expect(renderedSpy).toEqual(snapshot)

    commits = 0
    act(() =>
      render({
        scrollProgress: 0.35,
        scrollViewportFraction: 0.18,
        activeScrollRowKey: 'u#0'
      })
    )
    expect(renderedSpy).toBeNull()
    expect(commits).toBe(1)

    act(() => spySinkRef.current?.(snapshot))
    expect(renderedSpy).toEqual(snapshot)

    for (let index = 0; index < 75; index += 1) {
      act(() =>
        render({
          scrollProgress: 0.35 + index / 10_000,
          scrollViewportFraction: 0.18,
          activeScrollRowKey: `u#${index % 3}`
        })
      )
      act(() =>
        spySinkRef.current?.({
          rowIndex: index,
          progress: 0.35 + index / 10_000,
          viewportFraction: 0.18
        })
      )
    }
    expect(commits).toBeLessThanOrEqual(152)
  })
})
