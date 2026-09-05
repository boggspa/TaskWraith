import { act, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebSiteLogin } from '../../../../shared/webSiteLogin'
import { useWebSiteLoginAttention } from './useWebSiteLoginAttention'

type LoginSummary = { status?: WebSiteLogin['status'] }
type LoginApi = {
  listWebSiteLogins?: () => Promise<LoginSummary[]>
  onWebSiteLoginsChanged?: (callback: () => void) => () => void
}

let root: Root | null = null
let attentionSnapshots: number[] = []

function bridgeHarness() {
  let listener: (() => void) | undefined
  const listWebSiteLogins = vi
    .fn<NonNullable<LoginApi['listWebSiteLogins']>>()
    .mockResolvedValue([])
  const unsubscribe = vi.fn(() => {
    listener = undefined
  })
  const onWebSiteLoginsChanged = vi.fn<NonNullable<LoginApi['onWebSiteLoginsChanged']>>(
    (callback) => {
      listener = callback
      return unsubscribe
    }
  )
  return {
    api: { listWebSiteLogins, onWebSiteLoginsChanged },
    listWebSiteLogins,
    onWebSiteLoginsChanged,
    unsubscribe,
    emitChange() {
      listener?.()
    }
  }
}

function Observer() {
  const attention = useWebSiteLoginAttention()
  useLayoutEffect(() => {
    attentionSnapshots.push(attention)
  }, [attention])
  return null
}

function mount(api: LoginApi = {}): void {
  class MinimalElement extends EventTarget {
    readonly nodeType = 1
  }
  class MinimalIFrame extends MinimalElement {}
  const documentTarget = Object.assign(new EventTarget(), {
    nodeType: 9,
    activeElement: null,
    body: null,
    documentElement: {}
  })
  const windowTarget = Object.assign(new EventTarget(), {
    document: documentTarget,
    HTMLElement: MinimalElement,
    HTMLIFrameElement: MinimalIFrame,
    api
  })
  Object.assign(documentTarget, { defaultView: windowTarget })
  vi.stubGlobal('window', windowTarget)
  vi.stubGlobal('document', documentTarget)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = Object.assign(new MinimalElement(), {
    ownerDocument: documentTarget,
    nodeName: 'DIV',
    tagName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    firstChild: null,
    appendChild: () => undefined,
    removeChild: () => undefined
  }) as unknown as Element
  attentionSnapshots = []
  root = createRoot(container)
  act(() => root!.render(<Observer />))
}

function unmount(): void {
  act(() => root?.unmount())
  root = null
}

function currentAttention(): number {
  return attentionSnapshots[attentionSnapshots.length - 1]
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function emitChange(harness: ReturnType<typeof bridgeHarness>): Promise<void> {
  await act(async () => {
    harness.emitChange()
    await Promise.resolve()
    await Promise.resolve()
  })
}

afterEach(() => {
  unmount()
  vi.unstubAllGlobals()
})

describe('useWebSiteLoginAttention', () => {
  it('stays at zero and does not subscribe when the optional list API is unavailable', () => {
    mount()
    expect(attentionSnapshots).toEqual([0])
  })

  it('loads and counts only sites that need the user', async () => {
    const harness = bridgeHarness()
    harness.listWebSiteLogins.mockResolvedValue([
      { status: 'expired' },
      { status: 'signed-in' },
      { status: 'expired' },
      { status: 'unknown' }
    ])
    mount(harness.api)
    expect(currentAttention()).toBe(0)
    await flush()
    expect(currentAttention()).toBe(2)
    expect(harness.listWebSiteLogins).toHaveBeenCalledExactlyOnceWith()
    expect(harness.onWebSiteLoginsChanged).toHaveBeenCalledOnce()
  })

  it('refreshes on change without replacing the subscription', async () => {
    const harness = bridgeHarness()
    harness.listWebSiteLogins.mockResolvedValueOnce([{ status: 'expired' }])
    mount(harness.api)
    await flush()
    expect(currentAttention()).toBe(1)

    harness.listWebSiteLogins.mockResolvedValueOnce([{ status: 'signed-in' }, { status: 'never' }])
    await emitChange(harness)
    expect(currentAttention()).toBe(0)
    expect(harness.listWebSiteLogins).toHaveBeenCalledTimes(2)
    expect(harness.onWebSiteLoginsChanged).toHaveBeenCalledTimes(1)
    expect(harness.unsubscribe).not.toHaveBeenCalled()
  })

  it('keeps the last count when a refresh rejects', async () => {
    const harness = bridgeHarness()
    harness.listWebSiteLogins.mockResolvedValueOnce([{ status: 'expired' }])
    mount(harness.api)
    await flush()
    expect(currentAttention()).toBe(1)

    harness.listWebSiteLogins.mockRejectedValueOnce(new Error('Unavailable'))
    await emitChange(harness)
    expect(currentAttention()).toBe(1)
  })

  it('still loads when the change subscription API is unavailable', async () => {
    const listWebSiteLogins = vi
      .fn<NonNullable<LoginApi['listWebSiteLogins']>>()
      .mockResolvedValue([{ status: 'expired' }])
    mount({ listWebSiteLogins })
    await flush()
    expect(currentAttention()).toBe(1)
  })

  it('unsubscribes and ignores an in-flight response after unmount', async () => {
    const harness = bridgeHarness()
    let resolveList!: (sites: LoginSummary[]) => void
    harness.listWebSiteLogins.mockReturnValue(
      new Promise<LoginSummary[]>((resolve) => {
        resolveList = resolve
      })
    )
    mount(harness.api)
    expect(attentionSnapshots).toEqual([0])
    unmount()
    expect(harness.unsubscribe).toHaveBeenCalledExactlyOnceWith()

    await act(async () => {
      resolveList([{ status: 'expired' }])
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(attentionSnapshots).toEqual([0])
  })
})
