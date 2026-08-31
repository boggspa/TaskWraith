import { act, createElement, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatRecord, WorkspaceRecord } from '../../../main/store/types'
import { useSidebarHierarchyDrag } from '../hooks/useSidebarHierarchyDrag'
import { ActiveRunsSection } from './ActiveRunsSection'
import { Sidebar } from './Sidebar'

class TestNode extends EventTarget {
  readonly nodeType: number
  parentNode: TestNode | null = null
  childNodes: TestNode[] = []
  ownerDocument: TestDocument

  constructor(nodeType: number, ownerDocument: TestDocument) {
    super()
    this.nodeType = nodeType
    this.ownerDocument = ownerDocument
  }

  appendChild<T extends TestNode>(node: T): T {
    node.parentNode = this
    this.childNodes.push(node)
    return node
  }

  removeChild<T extends TestNode>(node: T): T {
    const index = this.childNodes.indexOf(node)
    if (index >= 0) this.childNodes.splice(index, 1)
    node.parentNode = null
    return node
  }

  insertBefore<T extends TestNode>(node: T, before: TestNode | null): T {
    if (!before) return this.appendChild(node)
    const index = this.childNodes.indexOf(before)
    node.parentNode = this
    this.childNodes.splice(Math.max(0, index), 0, node)
    return node
  }

  contains(node: TestNode | null): boolean {
    if (!node) return false
    if (node === this) return true
    return this.childNodes.some((child) => child.contains(node))
  }
}

class TestText extends TestNode {
  nodeValue: string

  constructor(value: string, ownerDocument: TestDocument) {
    super(3, ownerDocument)
    this.nodeValue = value
  }
}

class TestStyle {
  private readonly values = new Map<string, string>()

  setProperty(name: string, value: string): void {
    this.values.set(name, value)
  }

  removeProperty(name: string): string {
    const previous = this.values.get(name) || ''
    this.values.delete(name)
    return previous
  }
}

class TestElement extends TestNode {
  readonly nodeName: string
  readonly tagName: string
  readonly namespaceURI = 'http://www.w3.org/1999/xhtml'
  readonly style = new TestStyle()
  readonly attributes = new Map<string, string>()
  readonly dataset: Record<string, string> = {}
  disabled = false
  type = ''

  constructor(tagName: string, ownerDocument: TestDocument) {
    super(1, ownerDocument)
    this.tagName = tagName.toUpperCase()
    this.nodeName = this.tagName
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
    if (name === 'class') this.attributes.set('className', value)
    if (name.startsWith('data-')) {
      const key = name
        .slice(5)
        .replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
      this.dataset[key] = value
    }
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  get textContent(): string {
    return this.childNodes
      .map((child) =>
        child instanceof TestText ? child.nodeValue : (child as TestElement).textContent
      )
      .join('')
  }

  set textContent(value: string) {
    this.childNodes = [new TestText(value, this.ownerDocument)]
  }

  closest(selector: string): TestElement | null {
    const selectors = selector.split(',').map((entry) => entry.trim())
    const classNames = (this.attributes.get('class') || '').split(/\s+/)
    if (
      selectors.some((entry) => {
        if (entry === '[data-sidebar-section-id]') {
          return typeof this.dataset.sidebarSectionId === 'string'
        }
        return entry.startsWith('.') && classNames.includes(entry.slice(1))
      })
    ) {
      return this
    }
    return this.parentNode instanceof TestElement ? this.parentNode.closest(selector) : null
  }

  getBoundingClientRect(): DOMRect {
    return {
      left: 0,
      top: 0,
      right: 200,
      bottom: 30,
      width: 200,
      height: 30,
      x: 0,
      y: 0,
      toJSON: () => ({})
    } as DOMRect
  }
}

class TestDocument extends EventTarget {
  readonly nodeType = 9
  readonly documentElement: TestElement
  readonly body: TestElement
  activeElement: TestElement | null = null
  defaultView: Record<string, unknown> | null = null
  private hitTarget: TestElement | null = null

  constructor() {
    super()
    this.documentElement = new TestElement('html', this)
    this.body = new TestElement('body', this)
  }

  createElement(tagName: string): TestElement {
    return new TestElement(tagName, this)
  }

  createElementNS(_namespace: string, tagName: string): TestElement {
    return this.createElement(tagName)
  }

  createTextNode(value: string): TestText {
    return new TestText(value, this)
  }

  elementFromPoint(): TestElement | null {
    return this.hitTarget
  }

  setHitTarget(target: TestElement | null): void {
    this.hitTarget = target
  }
}

function maybeReactProps(node: TestElement): Record<string, unknown> | null {
  const key = Object.keys(node).find((candidate) => candidate.startsWith('__reactProps$'))
  if (!key) return null
  return node[key as keyof TestElement] as unknown as Record<string, unknown>
}

function reactProps(node: TestElement): Record<string, unknown> {
  const props = maybeReactProps(node)
  if (!props) throw new Error('React props were not attached to mounted test node')
  return props
}

function findElement(
  root: TestElement,
  predicate: (element: TestElement) => boolean
): TestElement | null {
  if (predicate(root)) return root
  for (const child of root.childNodes) {
    if (child instanceof TestElement) {
      const match = findElement(child, predicate)
      if (match) return match
    }
  }
  return null
}

function findByText(root: TestElement, text: string): TestElement {
  const match = findElement(
    root,
    (element) => element.tagName === 'BUTTON' && element.textContent.includes(text)
  )
  if (!match) throw new Error(`Could not find button containing "${text}"`)
  return match
}

function findDeepestByText(root: TestElement, text: string): TestElement | null {
  for (const child of root.childNodes) {
    if (child instanceof TestElement) {
      const match = findDeepestByText(child, text)
      if (match) return match
    }
  }
  return root.textContent.includes(text) ? root : null
}

function pointerEvent(type: string, clientX: number, clientY: number): PointerEvent {
  return Object.assign(new Event(type), { clientX, clientY, pointerId: 1 }) as PointerEvent
}

let mountedRoot: Root | null = null
let originalDescriptors: Record<string, PropertyDescriptor | undefined> = {}

function installDom(): {
  document: TestDocument
  container: TestElement
  storage: Map<string, string>
} {
  const document = new TestDocument()
  const storage = new Map<string, string>()
  const windowTarget = new EventTarget() as EventTarget & Record<string, unknown>
  windowTarget.document = document
  windowTarget.Node = TestNode
  windowTarget.Element = TestElement
  windowTarget.HTMLElement = TestElement
  windowTarget.HTMLIFrameElement = TestElement
  windowTarget.setTimeout = globalThis.setTimeout
  windowTarget.clearTimeout = globalThis.clearTimeout
  windowTarget.setInterval = globalThis.setInterval
  windowTarget.clearInterval = globalThis.clearInterval
  windowTarget.requestAnimationFrame = (callback: FrameRequestCallback) =>
    globalThis.setTimeout(() => callback(Date.now()), 0)
  windowTarget.cancelAnimationFrame = (id: ReturnType<typeof setTimeout>) =>
    globalThis.clearTimeout(id)
  windowTarget.localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key)
  }
  windowTarget.api = {
    getRunQueueJobs: async () => []
  }
  document.defaultView = windowTarget
  for (const name of [
    'window',
    'document',
    'Node',
    'Element',
    'HTMLElement',
    'localStorage',
    'IS_REACT_ACT_ENVIRONMENT'
  ]) {
    originalDescriptors[name] = Object.getOwnPropertyDescriptor(globalThis, name)
  }
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: windowTarget },
    document: { configurable: true, value: document },
    Node: { configurable: true, value: TestNode },
    Element: { configurable: true, value: TestElement },
    HTMLElement: { configurable: true, value: TestElement },
    localStorage: { configurable: true, value: windowTarget.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true }
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  return { document, container, storage }
}

afterEach(() => {
  act(() => mountedRoot?.unmount())
  mountedRoot = null
  for (const [name, descriptor] of Object.entries(originalDescriptors)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete (globalThis as Record<string, unknown>)[name]
  }
  originalDescriptors = {}
})

describe('threads sidebar disclosure interactions', () => {
  it.each([
    ['plain click', []],
    ['small pointer jitter', [pointerEvent('pointermove', 15, 12)]]
  ])('keeps a section pill toggle clickable after a %s', async (_label, moves) => {
    const { document, container } = installDom()
    const onReorder = vi.fn()

    function Harness(): ReactNode {
      const [expanded, setExpanded] = useState(true)
      const { handleSectionPointerDown } = useSidebarHierarchyDrag(['recents', 'git'], onReorder)
      return createElement(
        'div',
        {
          'data-sidebar-section-id': 'recents',
          onPointerDown: (event: unknown) =>
            handleSectionPointerDown(
              event as Parameters<typeof handleSectionPointerDown>[0],
              'recents',
              'Recents'
            )
        },
        createElement(
          'button',
          {
            type: 'button',
            className: 'sidebar-section-header-toggle',
            'aria-expanded': expanded,
            onClick: () => setExpanded((current) => !current)
          },
          'Recents'
        )
      )
    }

    await act(async () => {
      mountedRoot = createRoot(container as unknown as Element)
      mountedRoot.render(createElement(Harness))
    })
    const button = findByText(container, 'Recents')
    const wrapper = button.parentNode as TestElement
    document.setHitTarget(wrapper)

    act(() => {
      ;(reactProps(wrapper).onPointerDown as (event: unknown) => void)({
        button: 0,
        clientX: 10,
        clientY: 10,
        pointerId: 1,
        target: button
      })
      for (const move of moves) document.dispatchEvent(move)
      document.dispatchEvent(pointerEvent('pointerup', 15, 12))
      ;(reactProps(button).onClick as () => void)()
    })

    expect(reactProps(button)['aria-expanded']).toBe(false)
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('reorders after an above-threshold drag without toggling the source pill', async () => {
    const { document, container } = installDom()
    const onReorder = vi.fn()

    function Harness(): ReactNode {
      const [recentsExpanded, setRecentsExpanded] = useState(true)
      const { handleSectionPointerDown } = useSidebarHierarchyDrag(['recents', 'git'], onReorder)
      const section = (
        sectionId: 'recents' | 'git',
        label: string,
        expanded: boolean,
        onClick: () => void
      ): ReactNode =>
        createElement(
          'div',
          {
            'data-sidebar-section-id': sectionId,
            onPointerDown: (event: unknown) =>
              handleSectionPointerDown(
                event as Parameters<typeof handleSectionPointerDown>[0],
                sectionId,
                label
              )
          },
          createElement(
            'button',
            {
              type: 'button',
              className: 'sidebar-section-header-toggle',
              'aria-expanded': expanded,
              onClick
            },
            label
          )
        )

      return createElement(
        'div',
        null,
        section('recents', 'Recents', recentsExpanded, () =>
          setRecentsExpanded((current) => !current)
        ),
        section('git', 'Git', true, () => undefined)
      )
    }

    await act(async () => {
      mountedRoot = createRoot(container as unknown as Element)
      mountedRoot.render(createElement(Harness))
    })
    const recentsButton = findByText(container, 'Recents')
    const gitButton = findByText(container, 'Git')
    const recentsWrapper = recentsButton.parentNode as TestElement
    const gitWrapper = gitButton.parentNode as TestElement
    document.setHitTarget(gitWrapper)

    act(() => {
      ;(reactProps(recentsWrapper).onPointerDown as (event: unknown) => void)({
        button: 0,
        clientX: 10,
        clientY: 10,
        pointerId: 1,
        target: recentsButton
      })
      document.dispatchEvent(pointerEvent('pointermove', 30, 10))
      document.dispatchEvent(pointerEvent('pointerup', 30, 10))
    })

    expect(onReorder).toHaveBeenCalledWith(['git', 'recents'])
    expect(reactProps(recentsButton)['aria-expanded']).toBe(true)
  })

  it('toggles and restores a workspace row disclosure', async () => {
    const { container, storage } = installDom()
    storage.set(
      'taskwraith-sidebar-collapsed-sections',
      JSON.stringify([
        'active-runs',
        'local-servers',
        'workflows',
        'workspace-boards',
        'pinned',
        'recents',
        'git',
        'ensembles',
        'chats',
        'shared'
      ])
    )
    storage.set('taskwraith-sidebar-collapsed-sections-default-version', 'hierarchy-disclosures-v2')
    storage.set('taskwraith-sidebar-expanded-workspaces', JSON.stringify(['ws-1']))
    const workspace = {
      id: 'ws-1',
      path: '/repo',
      displayName: 'Repo',
      lastOpenedAt: 1,
      createdAt: 1,
      pinned: false
    } as WorkspaceRecord
    const chat = {
      appChatId: 'chat-1',
      scope: 'workspace',
      provider: 'codex',
      title: 'Workspace thread',
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      pinned: false,
      messages: [],
      runs: []
    } as ChatRecord
    const props = {
      workspaces: [workspace],
      currentWorkspace: workspace,
      chats: [chat],
      currentChat: chat,
      activeChatId: chat.appChatId,
      usageSummary: [],
      runningChatIds: [],
      onSelectWorkspace: () => undefined,
      onRemoveWorkspace: () => undefined,
      onSelectWorkspaceDialog: () => undefined,
      onNewChat: () => undefined,
      onNewGlobalChat: () => undefined,
      onNewEnsemble: () => undefined,
      onSelectChat: () => undefined,
      onOpenSettings: () => undefined
    }

    await act(async () => {
      mountedRoot = createRoot(container as unknown as Element)
      mountedRoot.render(createElement(Sidebar, props))
      await Promise.resolve()
      await Promise.resolve()
    })
    const chatRowText = findDeepestByText(container, 'Workspace thread')
    expect(chatRowText).not.toBeNull()
    let ancestor = chatRowText!.parentNode
    let disclosure: TestElement | null = null
    while (ancestor && ancestor !== container) {
      const workspaceRow = ancestor.childNodes.find(
        (child): child is TestElement =>
          child instanceof TestElement &&
          child.textContent.includes('Repo') &&
          !child.textContent.includes('Workspace thread')
      )
      disclosure =
        workspaceRow?.childNodes.find(
          (child): child is TestElement =>
            child instanceof TestElement && child.tagName === 'BUTTON'
        ) ?? null
      if (disclosure) break
      ancestor = ancestor.parentNode
    }
    expect(disclosure).not.toBeNull()

    act(() => {
      ;(
        reactProps(disclosure!).onClick as (event: {
          preventDefault: () => void
          stopPropagation: () => void
        }) => void
      )({
        preventDefault: () => undefined,
        stopPropagation: () => undefined
      })
    })

    expect(
      findElement(
        container,
        (element) =>
          element.tagName === 'BUTTON' && element.textContent.includes('Workspace thread')
      )
    ).toBeNull()
    expect(storage.get('taskwraith-sidebar-expanded-workspaces')).toBe(JSON.stringify([]))

    const activeRunsButton = findByText(container, 'Active Runs')
    expect(reactProps(activeRunsButton)['aria-expanded']).toBe(false)
    const searchInput = findElement(container, (element) => element.tagName === 'INPUT')
    expect(searchInput).not.toBeNull()
    act(() => {
      ;(reactProps(searchInput!).onChange as (event: { target: { value: string } }) => void)({
        target: { value: 'Workspace' }
      })
    })
    expect(reactProps(activeRunsButton)['aria-expanded']).toBe(true)
    expect(findDeepestByText(container, 'Workspace thread')).not.toBeNull()

    act(() => {
      ;(reactProps(searchInput!).onChange as (event: { target: { value: string } }) => void)({
        target: { value: '' }
      })
    })
    expect(reactProps(activeRunsButton)['aria-expanded']).toBe(false)
    expect(findDeepestByText(container, 'Workspace thread')).toBeNull()

    act(() => mountedRoot?.unmount())
    mountedRoot = null
    await act(async () => {
      mountedRoot = createRoot(container as unknown as Element)
      mountedRoot.render(createElement(Sidebar, props))
      await Promise.resolve()
    })

    expect(
      findElement(container, (element) => maybeReactProps(element)?.title === 'Expand chats')
    ).not.toBeNull()
  })

  it('preserves an Active Runs collapse across a sidebar remount', async () => {
    const { container, storage } = installDom()
    const storageKey = 'taskwraith-sidebar-collapsed-sections'

    function Harness(): ReactNode {
      const [collapsed, setCollapsed] = useState(() => {
        const raw = window.localStorage.getItem(storageKey)
        return raw ? (JSON.parse(raw) as string[]).includes('active-runs') : false
      })
      return createElement(ActiveRunsSection, {
        chats: [],
        currentChat: null,
        onSelectChat: () => undefined,
        collapsed,
        onToggleCollapsed: () =>
          setCollapsed((current) => {
            const next = !current
            window.localStorage.setItem(storageKey, JSON.stringify(next ? ['active-runs'] : []))
            return next
          })
      })
    }

    await act(async () => {
      mountedRoot = createRoot(container as unknown as Element)
      mountedRoot.render(createElement(Harness))
      await Promise.resolve()
    })
    const button = findByText(container, 'Active Runs')
    act(() => {
      ;(reactProps(button).onClick as () => void)()
    })
    expect(reactProps(button)['aria-expanded']).toBe(false)

    act(() => mountedRoot?.unmount())
    mountedRoot = null
    expect(storage.get(storageKey)).toBe(JSON.stringify(['active-runs']))

    await act(async () => {
      mountedRoot = createRoot(container as unknown as Element)
      mountedRoot.render(createElement(Harness))
      await Promise.resolve()
    })
    const remountedButton = findByText(container, 'Active Runs')
    expect(reactProps(remountedButton)['aria-expanded']).toBe(false)
  })
})
