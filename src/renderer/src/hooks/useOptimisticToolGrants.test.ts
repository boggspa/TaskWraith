import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgenticServiceId } from '../../../main/store/types'
import { useOptimisticToolGrants, type ToolGrantToggleHandler } from './useOptimisticToolGrants'

let mountedRoot: Root | null = null
let savedWindow: PropertyDescriptor | undefined
let savedDocument: PropertyDescriptor | undefined
let savedNode: PropertyDescriptor | undefined
let savedHTMLElement: PropertyDescriptor | undefined
let savedElement: PropertyDescriptor | undefined
let savedActEnvironment: PropertyDescriptor | undefined

afterEach(() => {
  act(() => mountedRoot?.unmount())
  mountedRoot = null
  if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow)
  if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument)
  if (savedNode) Object.defineProperty(globalThis, 'Node', savedNode)
  if (savedHTMLElement) Object.defineProperty(globalThis, 'HTMLElement', savedHTMLElement)
  if (savedElement) Object.defineProperty(globalThis, 'Element', savedElement)
  else delete (globalThis as Record<string, unknown>).Element
  if (savedActEnvironment) {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', savedActEnvironment)
  } else {
    delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT
  }
})

function installMinimalRendererDom(): Element {
  savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  savedNode = Object.getOwnPropertyDescriptor(globalThis, 'Node')
  savedHTMLElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement')
  savedElement = Object.getOwnPropertyDescriptor(globalThis, 'Element')
  savedActEnvironment = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
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

interface HookSnapshot {
  effectiveEnabledGrantIds: Set<AgenticServiceId>
  isGrantPending: (service: AgenticServiceId) => boolean
  toggleGrant: (service: AgenticServiceId) => void
}

function mountHook(
  enabledGrantIds: Set<AgenticServiceId>,
  onToggleGrant: ToolGrantToggleHandler
): () => HookSnapshot {
  const container = installMinimalRendererDom()
  let snapshot: HookSnapshot | null = null
  function Harness(): null {
    snapshot = useOptimisticToolGrants({ enabledGrantIds, onToggleGrant })
    return null
  }
  act(() => {
    mountedRoot = createRoot(container)
    mountedRoot.render(createElement(Harness))
  })
  return () => {
    if (!snapshot) throw new Error('Tool-grant hook did not render')
    return snapshot
  }
}

describe('useOptimisticToolGrants', () => {
  it('updates the checkbox immediately and coalesces a rapid reversal', async () => {
    const pending: Array<(value: boolean) => void> = []
    const onToggleGrant = vi.fn(
      () => new Promise<boolean>((resolve) => pending.push(resolve))
    ) as ToolGrantToggleHandler
    const current = mountHook(new Set(), onToggleGrant)

    act(() => current().toggleGrant('shellCommands'))
    expect(current().effectiveEnabledGrantIds.has('shellCommands')).toBe(true)
    expect(current().isGrantPending('shellCommands')).toBe(true)
    expect(onToggleGrant).toHaveBeenLastCalledWith('shellCommands', true)

    act(() => current().toggleGrant('shellCommands'))
    expect(current().effectiveEnabledGrantIds.has('shellCommands')).toBe(false)
    expect(onToggleGrant).toHaveBeenCalledTimes(1)

    await act(async () => {
      pending.shift()?.(true)
      await Promise.resolve()
    })
    expect(onToggleGrant).toHaveBeenLastCalledWith('shellCommands', false)
    expect(onToggleGrant).toHaveBeenCalledTimes(2)
  })

  it('rolls an optimistic value back when the durable mutation fails', async () => {
    let resolveWrite: ((value: boolean) => void) | null = null
    const onToggleGrant = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveWrite = resolve
        })
    ) as ToolGrantToggleHandler
    const current = mountHook(new Set(), onToggleGrant)

    act(() => current().toggleGrant('fileChanges'))
    expect(current().effectiveEnabledGrantIds.has('fileChanges')).toBe(true)

    await act(async () => {
      resolveWrite?.(false)
      await Promise.resolve()
    })
    expect(current().effectiveEnabledGrantIds.has('fileChanges')).toBe(false)
    expect(current().isGrantPending('fileChanges')).toBe(false)
  })
})
