import { describe, expect, it } from 'vitest'
import {
  actScript,
  describeTargetScript,
  CANVAS_ISOLATED_STATE_KEY,
  CLEAR_SECRET_REDACTION_SCRIPT,
  REDACT_SECRETS_SCRIPT,
  SNAPSHOT_SCRIPT
} from './CanvasWebDriver'
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
  childNodes: Array<StubElement | { nodeType: 3; textContent: string }>
  textContent: string
  className: string
  value?: string
  checked?: boolean
  options?: Array<{ value: string; textContent: string }>
  scrollLeft: number
  scrollTop: number
  clicks: number
  focuses: number
  scrolls: number
  dispatched: string[]
  rect: { left: number; top: number; width: number; height: number }
  readonly childElementCount: number
  getAttribute(name: string): string | null
  hasAttribute(name: string): boolean
  matches(selector: string): boolean
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
  scrollBy(input: { left?: number; top?: number } | number, y?: number): void
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
    options?: Array<{ value: string; textContent: string }>
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
    childNodes: [],
    textContent: '',
    className: opts.className || '',
    clicks: 0,
    focuses: 0,
    scrolls: 0,
    dispatched: [],
    scrollLeft: 0,
    scrollTop: 0,
    rect: opts.rect || { left: 10, top: 10, width: 100, height: 40 },
    get childElementCount() {
      return el.children.length
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(el.attrs, name) ? el.attrs[name] : null
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(el.attrs, name)
    },
    matches(selector) {
      const type = (el.attrs.type || '').toLowerCase()
      const autocomplete = (el.attrs.autocomplete || '').toLowerCase()
      return (
        (selector.includes('input[type=password]') &&
          el.tagName === 'INPUT' &&
          type === 'password') ||
        (selector.includes('autocomplete*="password"') && autocomplete.includes('password')) ||
        (selector.includes('autocomplete="one-time-code"') && autocomplete === 'one-time-code') ||
        (selector.includes('[data-tw-secret]') && el.hasAttribute('data-tw-secret'))
      )
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
    scrollBy(input, y) {
      if (typeof input === 'number') {
        el.scrollLeft += input
        el.scrollTop += y || 0
      } else {
        el.scrollLeft += input.left || 0
        el.scrollTop += input.top || 0
      }
      el.scrolls += 1
    },
    dispatchEvent(event) {
      el.dispatched.push(event.type)
      return true
    }
  }
  if (opts.value !== undefined) el.value = opts.value
  if (opts.checked !== undefined) el.checked = opts.checked
  if (opts.options !== undefined) el.options = opts.options
  return el
}

function appendChild(parent: StubElement, child: StubElement): StubElement {
  parent.children.push(child)
  parent.childNodes.push(child)
  child.parentElement = parent
  return child
}

interface ActOutcome {
  ok: boolean
  found: boolean
  action: string
  executed: boolean
  verified: 'changed' | 'unchanged' | 'unknown'
  refusalReason?: string
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
  /** Page-world registry after a hostile whole-global replacement. */
  pageRefElement?: StubElement
  /** Isolated renderer-side trusted-input epoch at dispatch time. */
  trustedInputEpoch?: number
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
    scrollingElement: body,
    documentElement: body,
    querySelector: (_selector: string) => opts.selectorElement || null,
    elementFromPoint: (_x: number, _y: number) =>
      opts.hitTest === undefined ? opts.refElement || null : opts.hitTest
  }
  const loc = { href: 'http://localhost:5173/app' }
  const win: Record<string, unknown> = {
    innerWidth: 1280,
    innerHeight: 800,
    scrollBy: (input: { left?: number; top?: number } | number, y?: number) =>
      body.scrollBy(input, y),
    __twCanvas__: {
      refs:
        (opts.pageRefElement ?? opts.refElement) && action.ref
          ? { [action.ref]: opts.pageRefElement ?? opts.refElement }
          : {},
      ids:
        opts.recordedIdentity !== undefined && action.ref
          ? { [action.ref]: opts.recordedIdentity }
          : {}
    }
  }
  const isolatedGlobal: Record<string, unknown> = {
    [CANVAS_ISOLATED_STATE_KEY]: {
      refs: opts.refElement && action.ref ? { [action.ref]: opts.refElement } : {},
      ids:
        opts.recordedIdentity !== undefined && action.ref
          ? { [action.ref]: opts.recordedIdentity }
          : {},
      trustedInputEpoch: opts.trustedInputEpoch ?? 0
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
    'KeyboardEvent',
    'Event',
    'globalThis',
    `return ${source}`
  )
  return evaluate(win, doc, loc, StubEvent, StubEvent, StubEvent, isolatedGlobal) as ActOutcome
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

function runSnapshot(
  attrs: Record<string, string>,
  value: string
): {
  result: { root: { value?: string } }
  listeners: Array<(event: { isTrusted?: boolean }) => void>
  state: { trustedInputEpoch: number }
} {
  const body = makeElement('body')
  appendChild(body, makeElement('input', { attrs, value }))
  const listeners: Array<(event: { isTrusted?: boolean }) => void> = []
  const isolatedGlobal: Record<string, unknown> = {
    addEventListener: (_type: string, listener: unknown) => {
      if (typeof listener === 'function') {
        listeners.push(listener as (event: { isTrusted?: boolean }) => void)
      }
    }
  }
  const win = {
    innerWidth: 1280,
    innerHeight: 800,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' })
  }
  const doc = { body, title: 'Snapshot' }
  const evaluate = new Function(
    'window',
    'document',
    'location',
    'globalThis',
    `return ${SNAPSHOT_SCRIPT}`
  )
  const result = evaluate(win, doc, { href: 'http://localhost:5173/' }, isolatedGlobal) as {
    root: { value?: string }
  }
  return {
    result,
    listeners,
    state: isolatedGlobal[CANVAS_ISOLATED_STATE_KEY] as { trustedInputEpoch: number }
  }
}

describe('canvas actuation preconditions', () => {
  it('binds ref actions to the isolated snapshot registry after page-global replacement', () => {
    const original = makeElement('button', { attrs: { 'aria-label': 'Save' } })
    const attacker = makeElement('button', { attrs: { 'aria-label': 'Delete everything' } })
    const result = runAct(
      { kind: 'click', ref: 'e1' },
      {
        refElement: original,
        pageRefElement: attacker,
        recordedIdentity: identityOf(original)
      }
    )

    expect(result.executed).toBe(true)
    expect(original.clicks).toBe(1)
    expect(attacker.clicks).toBe(0)
  })

  it('atomically refuses an action when the isolated trusted-input epoch changed', () => {
    const button = makeElement('button')
    const result = runAct(
      { kind: 'click', ref: 'e1', expectedInputEpoch: 4 },
      { refElement: button, trustedInputEpoch: 5 }
    )

    expect(result.executed).toBe(false)
    expect(result.refusalReason).toBe('stale_input_epoch')
    expect(button.clicks).toBe(0)
  })

  it('refuses a detached target instead of reporting a phantom success', () => {
    // The D1 regression. Before the fix this returned { ok: true, found: true }.
    const button = makeElement('button', { isConnected: false })
    const result = runAct({ kind: 'click', ref: 'e4' }, { refElement: button })

    expect(result.ok).toBe(false)
    expect(result.executed).toBe(false)
    expect(result.refusalReason).toBe('stale_target')
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
    expect(result.refusalReason).toBe('stale_target')
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
    expect(result.refusalReason).toBeUndefined()
    expect(button.clicks).toBe(1)
  })

  it('refuses when the target centre is covered by an unrelated element', () => {
    const button = makeElement('button')
    const overlay = makeElement('div')

    const result = runAct({ kind: 'click', ref: 'e1' }, { refElement: button, hitTest: overlay })

    expect(result.executed).toBe(false)
    expect(result.found).toBe(true)
    expect(result.refusalReason).toBe('occluded')
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
    expect(result.refusalReason).toBe('not_found')
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

  it('dispatches structured hover events without clicking', () => {
    const menu = makeElement('div')
    const result = runAct({ kind: 'hover', ref: 'e1' }, { refElement: menu })
    expect(result.executed).toBe(true)
    expect(menu.dispatched).toEqual(['mouseover', 'mouseenter', 'mousemove'])
    expect(menu.clicks).toBe(0)
  })

  it('selects an option by label and fires input/change', () => {
    const select = makeElement('select', {
      value: '',
      options: [
        { value: 'a', textContent: 'Option A' },
        { value: 'b', textContent: 'Option B' }
      ]
    })
    const result = runAct({ kind: 'select', ref: 'e1', value: 'Option B' }, { refElement: select })
    expect(result.executed).toBe(true)
    expect(select.value).toBe('b')
    expect(select.dispatched).toEqual(['input', 'change'])
  })

  it('scrolls a target by bounded CSS-pixel deltas', () => {
    const panel = makeElement('div')
    const result = runAct(
      { kind: 'scroll', ref: 'e1', deltaX: 10, deltaY: 200 },
      { refElement: panel }
    )
    expect(result.executed).toBe(true)
    expect(panel.scrollLeft).toBe(10)
    expect(panel.scrollTop).toBe(200)
  })

  it('dispatches allowlisted non-text keyboard keys and refuses arbitrary text', () => {
    const button = makeElement('button')
    const accepted = runAct({ kind: 'key', ref: 'e1', key: 'Enter' }, { refElement: button })
    expect(accepted.executed).toBe(true)
    expect(button.dispatched).toEqual(['keydown', 'keyup'])

    const refused = runAct({ kind: 'key', ref: 'e1', key: 'hunter2' }, { refElement: button })
    expect(refused.executed).toBe(false)
    expect(refused.refusalReason).toBe('unsupported_action')
  })

  it('reports a present wait_for target without dispatching', () => {
    const target = makeElement('div')
    const result = runAct(
      { kind: 'wait_for', selector: '[data-ready]', timeoutMs: 500 },
      { selectorElement: target }
    )
    expect(result).toMatchObject({ ok: true, found: true, executed: false })
    expect(target.dispatched).toEqual([])
  })

  describe('credential fields', () => {
    // The user authenticates INSIDE the agent-drivable surface, and frames leave
    // the machine when a hosted provider is driving. The dedicated profile may
    // retain the site session; the agent must never handle credential values.
    const cases: Array<[string, Record<string, string>]> = [
      ['type=password', { type: 'password' }],
      ['revealed password (autocomplete)', { type: 'text', autocomplete: 'current-password' }],
      ['new-password', { type: 'text', autocomplete: 'new-password' }],
      ['one-time-code', { type: 'text', autocomplete: 'one-time-code' }],
      ['author opt-out marker', { type: 'text', 'data-tw-secret': '' }]
    ]

    for (const [label, attrs] of cases) {
      it(`refuses to fill ${label}`, () => {
        const input = makeElement('input', { attrs, value: '' })
        const result = runAct({ kind: 'fill', ref: 'e1', value: 'hunter2' }, { refElement: input })

        expect(result.ok).toBe(false)
        expect(result.executed).toBe(false)
        expect(result.refusalReason).toBe('secret_field')
        // Neither written nor focused — no keystroke path at all.
        expect(input.value).toBe('')
        expect(input.focuses).toBe(0)
      })
    }

    it('still fills an ordinary text field', () => {
      const input = makeElement('input', { attrs: { type: 'text' }, value: '' })
      const result = runAct({ kind: 'fill', ref: 'e1', value: 'hello' }, { refElement: input })

      expect(result.executed).toBe(true)
      expect(input.value).toBe('hello')
    })

    it('does not refuse a username field just because it sits next to a password', () => {
      const input = makeElement('input', {
        attrs: { type: 'text', autocomplete: 'username' },
        value: ''
      })
      const result = runAct({ kind: 'fill', ref: 'e1', value: 'ada' }, { refElement: input })

      expect(result.executed).toBe(true)
      expect(input.value).toBe('ada')
    })
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
    expect(result.refusalReason).toBe('not_fillable')
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

describe('snapshot secret and trusted-input boundaries', () => {
  it.each([
    ['password', { type: 'password' }],
    ['revealed password autocomplete', { type: 'text', autocomplete: 'current-password' }],
    ['one-time-code autocomplete', { type: 'text', autocomplete: 'one-time-code' }],
    ['author secret marker', { type: 'text', 'data-tw-secret': '' }]
  ])('redacts the snapshot value for every %s selector', (_label, attrs) => {
    const { result } = runSnapshot(attrs, 'secret-visible-value')

    expect(result.root.value).toBe('[redacted]')
  })

  it('keeps an ordinary non-secret field value observable', () => {
    const { result } = runSnapshot({ type: 'text', autocomplete: 'username' }, 'ada')

    expect(result.root.value).toBe('ada')
  })

  it('increments the renderer epoch only for browser-trusted input events', () => {
    const { listeners, state } = runSnapshot({ type: 'text' }, 'ordinary')
    expect(listeners.length).toBeGreaterThan(0)

    for (const listener of listeners) listener({ isTrusted: false })
    expect(state.trustedInputEpoch).toBe(0)

    listeners[0]?.({ isTrusted: true })
    expect(state.trustedInputEpoch).toBe(1)
  })
})

/**
 * Screenshot-side credential protection. Snapshots already redact secret input
 * VALUES, but a screenshot captures the rendered field, so it needs its own
 * guard — and frames leave the machine whenever a hosted provider is driving.
 */
describe('screenshot secret redaction', () => {
  interface FakeNode {
    tagName: string
    style: { cssText: string }
    id: string
    children: FakeNode[]
    removed?: boolean
    appendChild(child: FakeNode): FakeNode
    remove(): void
  }

  function node(tagName = 'div'): FakeNode {
    const n: FakeNode = {
      tagName,
      style: { cssText: '' },
      id: '',
      children: [],
      appendChild(child) {
        n.children.push(child)
        return child
      },
      remove() {
        n.removed = true
      }
    } as FakeNode & { removed?: boolean }
    return n
  }

  function runRedaction(fields: Array<{ width: number; height: number; focused?: boolean }>): {
    count: number
    layer: FakeNode | null
    selector: string
    status: string
  } {
    let selector = ''
    const root = node('html')
    const byId = new Map<string, FakeNode>()
    const fieldNodes = fields.map((field) => {
      const fieldNode = {
        getBoundingClientRect: () => ({
          left: 10,
          top: 20,
          width: field.width,
          height: field.height
        }),
        contains: (candidate: unknown) => candidate === fieldNode
      }
      return { field, fieldNode }
    })
    const doc = {
      querySelectorAll: (sel: string) => {
        selector = sel
        return fieldNodes.map(({ fieldNode }) => fieldNode)
      },
      activeElement: fieldNodes.find(({ field }) => field.focused)?.fieldNode ?? null,
      getElementById: (id: string) => byId.get(id) ?? null,
      createElement: (tagName: string) => node(tagName),
      documentElement: root
    }
    const evaluate = new Function('document', `return ${REDACT_SECRETS_SCRIPT}`)
    const result = evaluate(doc) as { status: string; secretsRedacted: number }
    const layer = root.children[0] ?? null
    if (layer) byId.set('__twSecretRedaction', layer)
    return {
      count: result.secretsRedacted,
      layer,
      selector,
      status: result.status
    }
  }

  it('paints one opaque box per visible secret field', () => {
    const { count, layer } = runRedaction([
      { width: 200, height: 30 },
      { width: 160, height: 30 }
    ])

    expect(count).toBe(2)
    expect(layer?.children).toHaveLength(2)
    // Opaque fill, not merely a blur or an outline.
    expect(layer?.children[0]?.style.cssText).toContain('background:#111827')
    expect(layer?.children[0]?.style.cssText).toContain('left:10px')
  })

  it('matches revealed and one-time-code fields, not just type=password', () => {
    const { selector } = runRedaction([{ width: 10, height: 10 }])

    expect(selector).toContain('input[type=password]')
    expect(selector).toContain('autocomplete*="password"')
    expect(selector).toContain('one-time-code')
    expect(selector).toContain('data-tw-secret')
  })

  it('touches nothing when the page has no secret fields', () => {
    // No overlay means no flicker on the overwhelmingly common screenshot.
    const { count, layer } = runRedaction([])

    expect(count).toBe(0)
    expect(layer).toBeNull()
  })

  it('ignores zero-size fields so a hidden input cannot inflate the count', () => {
    const { count } = runRedaction([{ width: 0, height: 0 }])

    expect(count).toBe(0)
  })

  it('reports a focused secret before creating any screenshot overlay', () => {
    const { count, layer, status } = runRedaction([{ width: 200, height: 30, focused: true }])

    expect(status).toBe('focused_secret')
    expect(count).toBe(0)
    expect(layer).toBeNull()
  })

  it('reports probe failure instead of treating an unreadable page as secret-free', () => {
    const doc = {
      querySelectorAll: () => {
        throw new Error('page blocked the probe')
      }
    }
    const evaluate = new Function('document', `return ${REDACT_SECRETS_SCRIPT}`)

    expect(evaluate(doc)).toEqual({ status: 'probe_failed', secretsRedacted: 0 })
  })

  it('the teardown script removes the overlay by id', () => {
    const layer = node('div')
    const doc = { getElementById: (id: string) => (id === '__twSecretRedaction' ? layer : null) }
    const evaluate = new Function('document', `return ${CLEAR_SECRET_REDACTION_SCRIPT}`)

    expect(evaluate(doc)).toBe(true)
    expect((layer as FakeNode & { removed?: boolean }).removed).toBe(true)
  })
})

describe('describeTargetScript', () => {
  function runDescribe(
    action: CanvasActionInput,
    opts: {
      refElement?: StubElement
      selectorElement?: StubElement
      hitTest?: StubElement | null
      trustedInputEpoch?: number
    }
  ): { found: boolean; label: string | null; inputEpoch: number | null } {
    const doc = {
      querySelector: (_selector: string) => opts.selectorElement || null,
      elementFromPoint: (_x: number, _y: number) =>
        opts.hitTest === undefined ? null : opts.hitTest
    }
    const isolatedGlobal: Record<string, unknown> = {
      [CANVAS_ISOLATED_STATE_KEY]: {
        refs: opts.refElement && action.ref ? { [action.ref]: opts.refElement } : {},
        trustedInputEpoch: opts.trustedInputEpoch ?? 0
      }
    }
    const evaluate = new Function(
      'document',
      'globalThis',
      `return ${describeTargetScript(action)}`
    )
    return evaluate(doc, isolatedGlobal)
  }

  it('reports the accessible label and the current trusted epoch', () => {
    const button = makeElement('BUTTON', { attrs: { 'aria-label': 'Delete account' } })
    const result = runDescribe(
      { kind: 'click', ref: 'e5' },
      { refElement: button, trustedInputEpoch: 12 }
    )
    expect(result).toEqual({ found: true, label: 'Delete account', inputEpoch: 12 })
  })

  it('reads button text when there is no aria-label', () => {
    const button = makeElement('BUTTON')
    button.textContent = '  Delete   account  '
    const result = runDescribe({ kind: 'click', ref: 'e5' }, { refElement: button })
    expect(result.label).toBe('Delete account')
  })

  it('never dispatches, focuses or scrolls', () => {
    const button = makeElement('BUTTON', { attrs: { 'aria-label': 'Pay now' } })
    runDescribe({ kind: 'click', ref: 'e5' }, { refElement: button })
    expect(button.clicks).toBe(0)
    expect(button.focuses).toBe(0)
    expect(button.scrolls).toBe(0)
    expect(button.dispatched).toEqual([])
  })

  it('reports a detached or unresolved target as not found, still with the epoch', () => {
    const detached = makeElement('BUTTON', { attrs: { 'aria-label': 'Delete' } })
    detached.isConnected = false
    expect(
      runDescribe({ kind: 'click', ref: 'e5' }, { refElement: detached, trustedInputEpoch: 3 })
    ).toEqual({ found: false, label: null, inputEpoch: 3 })
    expect(runDescribe({ kind: 'click', ref: 'gone' }, { trustedInputEpoch: 3 })).toEqual({
      found: false,
      label: null,
      inputEpoch: 3
    })
  })

  it('bounds a hostile label rather than carrying it whole', () => {
    const button = makeElement('BUTTON', { attrs: { 'aria-label': 'Delete ' + 'x'.repeat(5000) } })
    const result = runDescribe({ kind: 'click', ref: 'e5' }, { refElement: button })
    expect(result.label?.length).toBe(200)
  })
})
