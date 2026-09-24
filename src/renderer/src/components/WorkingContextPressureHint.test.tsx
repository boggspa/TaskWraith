import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONTEXT_PRESSURE_WARN_PERCENT } from '../../../shared/contextCompaction'
import { WorkingContextPressureHint } from './WorkingContextPressureHint'

const QUIET_STALL_MS = 20_000

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

  get firstChild(): TestNode | null {
    return this.childNodes[0] ?? null
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
}

class TestText extends TestNode {
  nodeValue: string

  constructor(value: string, ownerDocument: TestDocument) {
    super(3, ownerDocument)
    this.nodeValue = value
  }
}

class TestElement extends TestNode {
  readonly nodeName: string
  readonly tagName: string
  readonly namespaceURI = 'http://www.w3.org/1999/xhtml'
  readonly style: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
  className = ''
  title = ''

  constructor(tagName: string, ownerDocument: TestDocument) {
    super(1, ownerDocument)
    this.tagName = tagName.toUpperCase()
    this.nodeName = this.tagName
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
    if (name === 'class') this.className = value
    if (name === 'title') this.title = value
  }

  get textContent(): string {
    return this.childNodes
      .map((child) =>
        child instanceof TestText ? child.nodeValue : (child as TestElement).textContent
      )
      .join('')
  }

  set textContent(value: string) {
    this.childNodes = value === '' ? [] : [new TestText(value, this.ownerDocument)]
  }
}

class TestDocument extends EventTarget {
  readonly nodeType = 9
  readonly documentElement: TestElement
  readonly body: TestElement
  activeElement: TestElement | null = null
  defaultView: Record<string, unknown> | null = null

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
}

function reactProps(node: TestElement): Record<string, unknown> {
  const key = Object.keys(node).find((candidate) => candidate.startsWith('__reactProps$'))
  if (!key) throw new Error('React props were not attached to mounted test node')
  return node[key as keyof TestElement] as unknown as Record<string, unknown>
}

let mountedRoot: Root | null = null
let originalDescriptors: Record<string, PropertyDescriptor | undefined> = {}

function installDom(): { container: TestElement } {
  const document = new TestDocument()
  const windowTarget = new EventTarget() as EventTarget & Record<string, unknown>
  windowTarget.document = document
  windowTarget.Node = TestNode
  windowTarget.Element = TestElement
  windowTarget.HTMLElement = TestElement
  windowTarget.HTMLIFrameElement = TestElement
  windowTarget.setInterval = globalThis.setInterval.bind(globalThis)
  windowTarget.clearInterval = globalThis.clearInterval.bind(globalThis)
  document.defaultView = windowTarget
  for (const name of [
    'window',
    'document',
    'Node',
    'Element',
    'HTMLElement',
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
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true }
  })
  return { container: document.createElement('div') }
}

function mountHint(percent: number, estimatedTokens: number): TestElement {
  const { container } = installDom()
  act(() => {
    mountedRoot = createRoot(container as unknown as Element)
    mountedRoot.render(
      (
        <WorkingContextPressureHint percent={percent} estimatedTokens={estimatedTokens} />
      ) as ReactNode
    )
  })
  return container
}

function hintSnapshot(container: TestElement): { className: string; text: string } {
  const span = container.childNodes.find((node) => node instanceof TestElement) as
    | TestElement
    | undefined
  if (!span) return { className: '', text: '' }
  const props = reactProps(span)
  return {
    className: String(props.className ?? span.className),
    text: span.textContent
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  act(() => mountedRoot?.unmount())
  mountedRoot = null
  vi.useRealTimers()
  for (const [name, descriptor] of Object.entries(originalDescriptors)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete (globalThis as Record<string, unknown>)[name]
  }
  originalDescriptors = {}
})

describe('WorkingContextPressureHint', () => {
  it('renders nothing under the warn threshold', () => {
    const html = renderToStaticMarkup(
      <WorkingContextPressureHint
        percent={CONTEXT_PRESSURE_WARN_PERCENT - 1}
        estimatedTokens={100}
      />
    )
    expect(html).toBe('')
  })

  it('renders the rounded percent at the warn threshold', () => {
    const html = renderToStaticMarkup(
      <WorkingContextPressureHint percent={CONTEXT_PRESSURE_WARN_PERCENT} estimatedTokens={100} />
    )
    expect(html).toContain('working-context-pressure-hint')
    expect(html).toContain(`context ${CONTEXT_PRESSURE_WARN_PERCENT}%`)
    expect(html).not.toContain('is-critical')
    expect(html).not.toContain('is-quiet')
  })

  it('marks occupancy at or above 90% as critical', () => {
    const html = renderToStaticMarkup(
      <WorkingContextPressureHint percent={90} estimatedTokens={100} />
    )
    expect(html).toContain('is-critical')
    expect(html).toContain('context 90%')
  })

  it('adds the quiet class after a 20s token-growth stall', () => {
    const container = mountHint(87, 40)
    expect(hintSnapshot(container)).toEqual({
      className: 'working-context-pressure-hint',
      text: 'context 87%'
    })

    act(() => {
      vi.advanceTimersByTime(QUIET_STALL_MS - 1)
    })
    expect(hintSnapshot(container).className).not.toContain('is-quiet')

    act(() => {
      vi.advanceTimersByTime(1)
    })
    const quiet = hintSnapshot(container)
    expect(quiet.className).toContain('is-quiet')
    expect(quiet.text).toBe('quiet at 87% context — likely compacting')
  })
})
