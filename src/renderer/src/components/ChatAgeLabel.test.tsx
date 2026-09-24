import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

class TestNode extends EventTarget {
  readonly nodeType: number
  ownerDocument: TestDocument
  parentNode: TestNode | null = null
  childNodes: TestNode[] = []
  nodeValue = ''

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
    this.childNodes = this.childNodes.filter((child) => child !== node)
    node.parentNode = null
    return node
  }

  insertBefore<T extends TestNode>(node: T, before: TestNode | null): T {
    if (!before) return this.appendChild(node)
    node.parentNode = this
    this.childNodes.splice(this.childNodes.indexOf(before), 0, node)
    return node
  }

  get textContent(): string {
    return this.nodeType === 3
      ? this.nodeValue
      : this.childNodes.map((child) => child.textContent).join('')
  }

  set textContent(value: string) {
    this.childNodes = value ? [this.ownerDocument.createTextNode(value)] : []
  }
}

class TestElement extends TestNode {
  readonly nodeName: string
  readonly tagName: string
  readonly namespaceURI = 'http://www.w3.org/1999/xhtml'
  readonly attributes = new Map<string, string>()

  constructor(tag: string, ownerDocument: TestDocument) {
    super(1, ownerDocument)
    this.nodeName = this.tagName = tag.toUpperCase()
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }
}

class TestDocument extends EventTarget {
  readonly nodeType = 9
  readonly documentElement = new TestElement('html', this)
  readonly body = new TestElement('body', this)
  activeElement: TestElement | null = null
  defaultView: unknown = null

  createElement(tag: string): TestElement {
    return new TestElement(tag, this)
  }

  createElementNS(_namespace: string, tag: string): TestElement {
    return this.createElement(tag)
  }

  createTextNode(value: string): TestNode {
    const node = new TestNode(3, this)
    node.nodeValue = value
    return node
  }
}

let age: typeof import('./ChatAgeLabel')
let root: Root | null = null
let container: TestElement
let tick: () => void
const interval = vi.fn<(callback: () => void, delay: number) => number>()
const NOW = new Date(2026, 8, 5, 12, 0).getTime()

beforeAll(async () => {
  const document = new TestDocument()
  const window = Object.assign(new EventTarget(), {
    document,
    HTMLElement: TestElement,
    HTMLIFrameElement: TestElement,
    setInterval: interval.mockImplementation((callback) => {
      tick = callback
      return 1
    })
  })
  document.defaultView = window
  vi.stubGlobal('window', window)
  vi.stubGlobal('document', document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  // Import after installing window: the original timer starts at module evaluation.
  age = await import('./ChatAgeLabel')
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  vi.restoreAllMocks()
})

afterAll(() => {
  vi.unstubAllGlobals()
})

async function render(timestamp: number): Promise<void> {
  const { ChatAgeLabel } = age
  await act(async () => {
    root ??= createRoot(container as unknown as Element)
    root.render(<ChatAgeLabel timestamp={timestamp} />)
  })
}

describe('chat age formatting', () => {
  it('uses the original minute, hour and day boundaries and clamps future timestamps', () => {
    for (const [elapsed, expected] of [
      [-60_000, 'now'],
      [0, 'now'],
      [59_999, 'now'],
      [60_000, '1m'],
      [3_599_999, '59m'],
      [3_600_000, '1h'],
      [86_399_999, '23h'],
      [86_400_000, '1d'],
      [604_799_999, '6d']
    ] as const) {
      expect(age.formatChatAge(NOW - elapsed, NOW)).toBe(expected)
    }
  })

  it('uses the runtime locale for old dates and includes the year only across years', () => {
    const localDate = vi.spyOn(Date.prototype, 'toLocaleDateString').mockReturnValue('local date')
    expect(age.formatChatAge(NOW - 7 * 86_400_000, NOW)).toBe('local date')
    expect(localDate).toHaveBeenLastCalledWith([], { day: 'numeric', month: 'short' })
    const previousYear = new Date(2025, 8, 5).getTime()
    expect(age.formatChatAge(previousYear, NOW)).toBe('local date')
    expect(localDate).toHaveBeenLastCalledWith([], {
      day: 'numeric',
      month: 'short',
      year: '2-digit'
    })
  })

  it('uses the runtime locale and full date/time options for the title', () => {
    const localDate = vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('local title')
    expect(age.formatChatAgeTitle(NOW)).toBe('local title')
    expect(localDate).toHaveBeenCalledExactlyOnceWith([], {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  })

  it('omits non-finite timestamps from both the text and title', () => {
    for (const timestamp of [NaN, Infinity, -Infinity]) {
      expect(age.formatChatAge(timestamp, NOW)).toBe('')
      expect(age.formatChatAgeTitle(timestamp)).toBe('')
    }
  })
})

describe('ChatAgeLabel', () => {
  it('preserves initial markup, title and the sidebar CSS class', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const { ChatAgeLabel } = age
    const html = renderToStaticMarkup(<ChatAgeLabel timestamp={NOW - 60_000} />)
    expect(html).toContain('class="sidebar-chat-age"')
    expect(html).toContain('>1m</span>')
    expect(html).toContain('title=')
    expect(renderToStaticMarkup(<ChatAgeLabel timestamp={NaN} />)).toBe('')
  })

  it('shares one module timer and unsubscribes listeners independently', () => {
    expect(interval).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 60_000)
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribeFirst = age.subscribeAgeTick(first)
    const unsubscribeSecond = age.subscribeAgeTick(second)
    try {
      tick()
      expect(first).toHaveBeenCalledTimes(1)
      expect(second).toHaveBeenCalledTimes(1)
      unsubscribeFirst()
      unsubscribeFirst()
      tick()
      expect(first).toHaveBeenCalledTimes(1)
      expect(second).toHaveBeenCalledTimes(2)
      unsubscribeSecond()
      tick()
      expect(second).toHaveBeenCalledTimes(2)
    } finally {
      unsubscribeFirst()
      unsubscribeSecond()
    }
  })

  it('refreshes mounted labels on the shared tick and on timestamp changes', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(NOW)
    await render(NOW - 30_000)
    expect(container.textContent).toBe('now')
    now.mockReturnValue(NOW + 60_000)
    act(() => tick())
    expect(container.textContent).toBe('1m')
    await render(NOW - 3_600_000)
    expect(container.textContent).toBe('1h')
    expect((container.firstChild as TestElement).attributes.get('title')).toBe(
      age.formatChatAgeTitle(NOW - 3_600_000)
    )
  })

  it('clears an invalid timestamp then recovers when a valid timestamp arrives', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    await render(NOW - 60_000)
    expect(container.textContent).toBe('1m')
    await render(NaN)
    expect(container.firstChild).toBeNull()
    act(() => tick())
    expect(container.firstChild).toBeNull()
    await render(NOW - 120_000)
    expect(container.textContent).toBe('2m')
  })

  it('cancels queued refreshes and removes its listener when unmounted', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const queued: Array<() => void> = []
    vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((callback) => queued.push(callback))
    const { ChatAgeLabel } = age
    act(() => {
      root = createRoot(container as unknown as Element)
      root.render(<ChatAgeLabel timestamp={NOW - 60_000} />)
    })
    act(() => root?.unmount())
    root = null
    const format = vi.spyOn(Math, 'max')
    act(() => {
      queued.forEach((callback) => callback())
      tick()
    })
    expect(format).not.toHaveBeenCalled()
    expect(container.firstChild).toBeNull()
  })
})
