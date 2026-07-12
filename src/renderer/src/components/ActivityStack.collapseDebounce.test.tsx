import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolActivity } from '../../../main/store/types'
import {
  buildTimelineItems,
  useCollapseDebouncedTimelineItems,
  type ActivityTimelineItem
} from './ActivityStack'

const COLLAPSE_DEBOUNCE_MS = 160

function activity(id: string, status: ToolActivity['status']): ToolActivity {
  return {
    id,
    toolName: 'read_file',
    displayName: 'Read file',
    category: 'read',
    status
  }
}

function itemsWithStatuses(
  entries: Array<[id: string, status: ToolActivity['status']]>
): ActivityTimelineItem[] {
  return buildTimelineItems(entries.map(([id, status]) => activity(id, status)))
}

interface HookHarness {
  current(): ActivityTimelineItem[]
  rerender(items: ActivityTimelineItem[]): void
}

let mountedRoot: Root | null = null
let savedWindow: PropertyDescriptor | undefined
let savedDocument: PropertyDescriptor | undefined
let savedNode: PropertyDescriptor | undefined
let savedHTMLElement: PropertyDescriptor | undefined
let savedActEnvironment: PropertyDescriptor | undefined

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor)
  } else {
    delete (globalThis as Record<string, unknown>)[name]
  }
}

function installMinimalDom(): Element {
  class MinimalNode {
    readonly nodeType: number = 0
  }
  class MinimalHTMLElement extends MinimalNode {
    override readonly nodeType: number = 1
  }
  class MinimalHTMLIFrameElement extends MinimalHTMLElement {}

  const documentTarget = {
    nodeType: 9,
    activeElement: null,
    body: null,
    documentElement: {},
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  }
  const windowTarget = {
    document: documentTarget,
    event: undefined,
    HTMLElement: MinimalHTMLElement,
    HTMLIFrameElement: MinimalHTMLIFrameElement,
    setTimeout: (...args: Parameters<typeof setTimeout>) => globalThis.setTimeout(...args),
    clearTimeout: (timeoutId: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(timeoutId)
  }
  Object.assign(documentTarget, { defaultView: windowTarget })
  Object.defineProperties(globalThis, {
    window: { configurable: true, writable: true, value: windowTarget },
    document: { configurable: true, writable: true, value: documentTarget },
    Node: { configurable: true, writable: true, value: MinimalNode },
    HTMLElement: {
      configurable: true,
      writable: true,
      value: windowTarget.HTMLElement
    },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true }
  })

  return {
    nodeType: 1,
    nodeName: 'DIV',
    tagName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: documentTarget,
    firstChild: null,
    lastChild: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    appendChild: () => undefined,
    removeChild: () => undefined
  } as unknown as Element
}

function mountHook(initialItems: ActivityTimelineItem[]): HookHarness {
  let renderedItems: ActivityTimelineItem[] | undefined
  const container = installMinimalDom()

  function Harness({ items }: { items: ActivityTimelineItem[] }): ReactNode {
    renderedItems = useCollapseDebouncedTimelineItems(items)
    return null
  }

  act(() => {
    mountedRoot = createRoot(container)
    mountedRoot.render(<Harness items={initialItems} />)
  })

  return {
    current: () => {
      if (!renderedItems) throw new Error('Hook did not render')
      return renderedItems
    },
    rerender: (items) => {
      act(() => mountedRoot?.render(<Harness items={items} />))
    }
  }
}

beforeEach(() => {
  savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  savedNode = Object.getOwnPropertyDescriptor(globalThis, 'Node')
  savedHTMLElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement')
  savedActEnvironment = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
  vi.useFakeTimers()
})

afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount())
  mountedRoot = null
  vi.useRealTimers()
  restoreGlobal('window', savedWindow)
  restoreGlobal('document', savedDocument)
  restoreGlobal('Node', savedNode)
  restoreGlobal('HTMLElement', savedHTMLElement)
  restoreGlobal('IS_REACT_ACT_ENVIRONMENT', savedActEnvironment)
})

describe('useCollapseDebouncedTimelineItems', () => {
  it('preserves the original hold and deadline across an equivalent compact replacement', () => {
    const running = itemsWithStatuses([
      ['read-1', 'running'],
      ['read-2', 'running']
    ])
    const compact = itemsWithStatuses([
      ['read-1', 'success'],
      ['read-2', 'success']
    ])
    const harness = mountHook(running)

    harness.rerender(compact)
    expect(harness.current()).toBe(running)

    act(() => vi.advanceTimersByTime(COLLAPSE_DEBOUNCE_MS / 2))
    const equivalentCompactReplacement = itemsWithStatuses([
      ['read-1', 'success'],
      ['read-2', 'success']
    ])
    harness.rerender(equivalentCompactReplacement)
    expect(harness.current()).toBe(running)

    act(() => vi.advanceTimersByTime(COLLAPSE_DEBOUNCE_MS / 2 - 1))
    expect(harness.current()).toBe(running)

    act(() => vi.advanceTimersByTime(1))
    expect(harness.current()).toBe(equivalentCompactReplacement)
  })

  it.each(['warning', 'error'] as const)(
    'releases held rows immediately when a %s status appears',
    (alertStatus) => {
      const running = itemsWithStatuses([
        ['read-1', 'running'],
        ['read-2', 'running']
      ])
      const compact = itemsWithStatuses([
        ['read-1', 'success'],
        ['read-2', 'success']
      ])
      const alert = itemsWithStatuses([
        ['read-1', 'success'],
        ['read-2', alertStatus]
      ])
      const harness = mountHook(running)

      expect(compact.map((item) => item.type)).toEqual(['compact-group'])
      expect(alert.map((item) => item.type)).toEqual(
        alertStatus === 'warning' ? ['compact-group'] : ['activity', 'activity']
      )
      harness.rerender(compact)
      expect(harness.current()).toBe(running)
      act(() => vi.advanceTimersByTime(40))
      harness.rerender(alert)

      expect(harness.current()).toBe(alert)
      act(() => vi.advanceTimersByTime(COLLAPSE_DEBOUNCE_MS))
      expect(harness.current()).toBe(alert)
    }
  )

  it('releases held rows immediately when the compact activity ids change', () => {
    const running = itemsWithStatuses([
      ['read-1', 'running'],
      ['read-2', 'running']
    ])
    const compact = itemsWithStatuses([
      ['read-1', 'success'],
      ['read-2', 'success']
    ])
    const changedIds = itemsWithStatuses([
      ['read-1', 'success'],
      ['read-3', 'success']
    ])
    const harness = mountHook(running)

    harness.rerender(compact)
    expect(harness.current()).toBe(running)
    act(() => vi.advanceTimersByTime(40))
    harness.rerender(changedIds)

    expect(harness.current()).toBe(changedIds)
    act(() => vi.advanceTimersByTime(COLLAPSE_DEBOUNCE_MS))
    expect(harness.current()).toBe(changedIds)
  })

  it('gives a genuine superseding collapse its own full hold deadline', () => {
    const running = itemsWithStatuses([
      ['read-1', 'running'],
      ['read-2', 'running'],
      ['read-3', 'running']
    ])
    const firstCollapse = itemsWithStatuses([
      ['read-1', 'success'],
      ['read-2', 'success'],
      ['read-3', 'running']
    ])
    const finalCollapse = itemsWithStatuses([
      ['read-1', 'success'],
      ['read-2', 'success'],
      ['read-3', 'success']
    ])
    const harness = mountHook(running)

    harness.rerender(firstCollapse)
    expect(harness.current()).toBe(running)
    act(() => vi.advanceTimersByTime(40))
    harness.rerender(finalCollapse)
    expect(harness.current()).toBe(firstCollapse)

    act(() => vi.advanceTimersByTime(120))
    expect(harness.current()).toBe(firstCollapse)
    act(() => vi.advanceTimersByTime(39))
    expect(harness.current()).toBe(firstCollapse)
    act(() => vi.advanceTimersByTime(1))
    expect(harness.current()).toBe(finalCollapse)
  })
})
