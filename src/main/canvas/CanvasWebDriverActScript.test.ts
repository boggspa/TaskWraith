import { describe, expect, it } from 'vitest'
import { actScript } from './CanvasWebDriver'
import type { CanvasActionInput } from './canvasTypes'

/**
 * The canvas actuation preconditions live inside the injected page script, so
 * asserting on TypeScript alone would prove nothing. There is no jsdom in this
 * project, so these tests evaluate the REAL generated source against a minimal
 * DOM stub.
 *
 * The bug being pinned (2026-07-26): a ref resolved out of the frozen snapshot
 * registry is not proof the element is still real. `el.click()` on a detached
 * node does not throw and `scrollIntoView` no-ops, so the old script returned
 * `{ ok: true, found: true }` for an element that had been re-rendered away.
 * The agent then re-observed, saw no change, and escalated — a silent-empty-
 * success loop against a live application.
 */

interface StubElement {
  nodeType: 1
  tagName: string
  attrs: Record<string, string>
  isConnected: boolean
  parentElement: StubElement | null
  children: StubElement[]
  className: string
  value?: string
  checked?: boolean
  clicks: number
  focuses: number
  scrolls: number
  dispatched: string[]
  rect: { left: number; top: number; width: number; height: number }
  readonly childElementCount: number
  getAttribute(name: string): string | null
  contains(other: unknown): boolean
  getBoundingClientRect(): {
    left: number
    top: number
    width: number
    height: number
    right: number
    bottom: number
  }
  click(): void
  focus(): void
  scrollIntoView(): void
  dispatchEvent(event: { type: string }): boolean
}

function makeElement(
  tagName: string,
  opts: {
    attrs?: Record<string, string>
    isConnected?: boolean
    className?: string
    value?: string
    checked?: boolean
    rect?: { left: number; top: number; width: number; height: number }
  } = {}
): StubElement {
  const el: StubElement = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    attrs: opts.attrs || {},
    isConnected: opts.isConnected !== false,
    parentElement: null,
    children: [],
    className: opts.className || '',
    clicks: 0,
    focuses: 0,
    scrolls: 0,
    dispatched: [],
    rect: opts.rect || { left: 10, top: 10, width: 100, height: 40 },
    get childElementCount() {
      return el.children.length
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(el.attrs, name) ? el.attrs[name] : null
    },
    contains(other) {
      if (other === el) return true
      return el.children.some((child) => child.contains(other))
    },
    getBoundingClientRect() {
      return {
        left: el.rect.left,
        top: el.rect.top,
        width: el.rect.width,
        height: el.rect.height,
        right: el.rect.left + el.rect.width,
        bottom: el.rect.top + el.rect.height
      }
    },
    click() {
      el.clicks += 1
    },
    focus() {
      el.focuses += 1
    },
    scrollIntoView() {
      el.scrolls += 1
    },
    dispatchEvent(event) {
      el.dispatched.push(event.type)
      return true
    }
  }
  if (opts.value !== undefined) el.value = opts.value
  if (opts.checked !== undefined) el.checked = opts.checked
  return el
}

function appendChild(parent: StubElement, child: StubElement): StubElement {
  parent.children.push(child)
  child.parentElement = parent
  return child
}

interface ActOutcome {
  ok: boolean
  found: boolean
  action: string
  executed: boolean
  verified: 'changed' | 'unchanged' | 'unknown'
  staleReason?: string
  message?: string
}

interface HarnessOptions {
  /** Element registered under the ref, if any. */
  refElement?: StubElement
  /** Identity string recorded for the ref at snapshot time. */
  recordedIdentity?: string
  /** What document.elementFromPoint returns; defaults to the target itself. */
  hitTest?: StubElement | null
  selectorElement?: StubElement
  /**
   * Runs during dispatch so a test can simulate the page reacting. Receives the
   * live document stub so the mutation is one the script can actually observe.
   */
  onInteract?: (doc: { title: string }) => void
}

/**
 * Evaluates the real generated script. `window`/`document`/`location` and the
 * event constructors are passed as parameters so they shadow the Node globals.
 */
function runAct(action: CanvasActionInput, opts: HarnessOptions): ActOutcome {
  const body = makeElement('body')
  const doc = {
    title: 'Start',
    body,
    querySelector: (_selector: string) => opts.selectorElement || null,
    elementFromPoint: (_x: number, _y: number) =>
      opts.hitTest === undefined ? opts.refElement || null : opts.hitTest
  }
  const loc = { href: 'http://localhost:5173/app' }
  const win: Record<string, unknown> = {
    innerWidth: 1280,
    innerHeight: 800,
    __twCanvas__: {
      refs: opts.refElement && action.ref ? { [action.ref]: opts.refElement } : {},
      ids:
        opts.recordedIdentity !== undefined && action.ref
          ? { [action.ref]: opts.recordedIdentity }
          : {}
    }
  }

  class StubEvent {
    type: string
    constructor(type: string) {
      this.type = type
      if (opts.onInteract) opts.onInteract(doc)
    }
  }

  const source = actScript(action)
  const evaluate = new Function(
    'window',
    'document',
    'location',
    'MouseEvent',
    'Event',
    `return ${source}`
  )
  return evaluate(win, doc, loc, StubEvent, StubEvent) as ActOutcome
}

/** Mirrors the __twIdentity digest for a stub element. */
function identityOf(el: StubElement): string {
  const label = (
    el.getAttribute('aria-label') ||
    el.getAttribute('alt') ||
    el.getAttribute('title') ||
    el.getAttribute('placeholder') ||
    ''
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  let path = ''
  let node: StubElement | null = el
  let depth = 0
  while (node && node.nodeType === 1 && depth < 6) {
    const parent: StubElement | null = node.parentElement
    let index = 0
    if (parent) {
      for (const sibling of parent.children) {
        if (sibling === node) break
        if (sibling.tagName === node.tagName) index += 1
      }
    }
    path = `/${node.tagName}[${index}]${path}`
    node = parent
    depth += 1
  }
  return `${el.tagName}|${el.getAttribute('role') || ''}|${el.getAttribute('type') || ''}|${label}|${path}`
}

describe('canvas actuation preconditions', () => {
  it('refuses a detached target instead of reporting a phantom success', () => {
    // The D1 regression. Before the fix this returned { ok: true, found: true }.
    const button = makeElement('button', { isConnected: false })
    const result = runAct({ kind: 'click', ref: 'e4' }, { refElement: button })

    expect(result.ok).toBe(false)
    expect(result.executed).toBe(false)
    expect(result.staleReason).toBe('stale_target')
    expect(button.clicks).toBe(0)
    expect(button.dispatched).toEqual([])
  })

  it('refuses when the ref now points at a different element than the snapshot saw', () => {
    const root = makeElement('div')
    const button = appendChild(root, makeElement('button', { attrs: { 'aria-label': 'Save' } }))
    const staleIdentity = identityOf(button).replace('Save', 'Delete everything')

    const result = runAct(
      { kind: 'click', ref: 'e9' },
      { refElement: button, recordedIdentity: staleIdentity }
    )

    expect(result.executed).toBe(false)
    expect(result.staleReason).toBe('stale_target')
    expect(button.clicks).toBe(0)
  })

  it('accepts a ref whose recomputed identity still matches', () => {
    const root = makeElement('div')
    const button = appendChild(root, makeElement('button', { attrs: { 'aria-label': 'Save' } }))

    const result = runAct(
      { kind: 'click', ref: 'e9' },
      { refElement: button, recordedIdentity: identityOf(button) }
    )

    expect(result.executed).toBe(true)
    expect(result.staleReason).toBeUndefined()
    expect(button.clicks).toBe(1)
  })

  it('refuses when the target centre is covered by an unrelated element', () => {
    const button = makeElement('button')
    const overlay = makeElement('div')

    const result = runAct({ kind: 'click', ref: 'e1' }, { refElement: button, hitTest: overlay })

    expect(result.executed).toBe(false)
    expect(result.found).toBe(true)
    expect(result.staleReason).toBe('occluded')
    expect(button.clicks).toBe(0)
  })

  it('still acts when the hit-test lands on a descendant of the target', () => {
    const button = makeElement('button')
    const label = appendChild(button, makeElement('span'))

    const result = runAct({ kind: 'click', ref: 'e1' }, { refElement: button, hitTest: label })

    expect(result.executed).toBe(true)
    expect(button.clicks).toBe(1)
  })

  it('reports not_found without executing when nothing resolves', () => {
    const result = runAct({ kind: 'click', selector: '#gone' }, {})

    expect(result.ok).toBe(false)
    expect(result.found).toBe(false)
    expect(result.executed).toBe(false)
    expect(result.staleReason).toBe('not_found')
  })

  it('reports verified:changed when the page reacts synchronously', () => {
    const button = makeElement('button')
    const result = runAct(
      { kind: 'click', ref: 'e1' },
      {
        refElement: button,
        onInteract: (doc) => {
          doc.title = 'Saved'
        }
      }
    )

    expect(result.executed).toBe(true)
    expect(result.verified).toBe('changed')
  })

  it('reports verified:unchanged — never a bare success — when nothing moves', () => {
    const button = makeElement('button')
    const result = runAct({ kind: 'click', ref: 'e1' }, { refElement: button })

    expect(result.executed).toBe(true)
    expect(result.verified).toBe('unchanged')
  })

  it('detects a change when the interaction mutates the target', () => {
    const input = makeElement('input', { attrs: { type: 'text' }, value: '' })
    const result = runAct({ kind: 'fill', ref: 'e2', value: 'hello' }, { refElement: input })

    expect(result.executed).toBe(true)
    expect(result.verified).toBe('changed')
    expect(input.value).toBe('hello')
  })

  it('refuses a fill against a non-field without executing', () => {
    const div = makeElement('div')
    const result = runAct({ kind: 'fill', ref: 'e3', value: 'x' }, { refElement: div })

    expect(result.executed).toBe(false)
    expect(result.staleReason).toBe('not_fillable')
  })

  it('does not scroll a target that is already in view', () => {
    const button = makeElement('button', { rect: { left: 40, top: 40, width: 80, height: 30 } })
    runAct({ kind: 'click', ref: 'e1' }, { refElement: button })

    expect(button.scrolls).toBe(0)
  })

  it('scrolls a target that is outside the viewport', () => {
    const button = makeElement('button', { rect: { left: 40, top: 4000, width: 80, height: 30 } })
    runAct({ kind: 'click', ref: 'e1' }, { refElement: button })

    expect(button.scrolls).toBe(1)
  })
})
