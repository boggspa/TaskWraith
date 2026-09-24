import { act, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ChannelIpcApi,
  ChannelIpcChangeEvent,
  ChannelIpcChannel
} from '../../../../shared/collaboration/ChannelIpc'
import { useCollaborationChatIds } from './useCollaborationChatIds'

type ListResult = Awaited<ReturnType<ChannelIpcApi['list']>>
let root: Root | null = null
let snapshots: Set<string>[] = []

function harness() {
  let listener: ((event: ChannelIpcChangeEvent) => void) | undefined
  const list = vi.fn<ChannelIpcApi['list']>().mockResolvedValue({ ok: true, value: [] })
  const off = vi.fn(() => {
    listener = undefined
  })
  const onChanged = vi.fn<ChannelIpcApi['onChanged']>((callback) => {
    listener = callback
    return off
  })
  return {
    channels: { list, onChanged },
    off,
    change(reason: ChannelIpcChangeEvent['reason'] = 'channel') {
      listener?.({ channelId: 'channel-1', reason })
    }
  }
}

function channel(
  channelId: string,
  chatId: string,
  status: ChannelIpcChannel['status'] = 'active'
): ChannelIpcChannel {
  return {
    channelId,
    chatId,
    ownerMemberId: 'owner-1',
    status,
    createdAt: 1,
    updatedAt: 2,
    membershipRevision: 1,
    messageCount: 0,
    display: { title: channelId, status, memberCount: 1, messageCount: 0 },
    availability: 'ready'
  }
}

// A null-rendering observer needs only this minimal DOM, as in the adjacent
// roster-preset bridge tests. React itself runs the state/effect lifecycle.
function mount(channels?: Partial<ChannelIpcApi>): void {
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
    api: { channels }
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
  snapshots = []
  root = createRoot(container)
  render()
}

function Observer() {
  const ids = useCollaborationChatIds()
  useLayoutEffect(() => {
    snapshots.push(ids)
  }, [ids])
  return null
}

function render(): void {
  act(() => root!.render(<Observer />))
}

function unmount(): void {
  act(() => root?.unmount())
  root = null
}

function currentIds(): Set<string> {
  return snapshots[snapshots.length - 1]
}

async function flushList(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

afterEach(() => {
  unmount()
  vi.unstubAllGlobals()
})

describe('useCollaborationChatIds', () => {
  it('starts with an empty Set and publishes only unique active chat IDs after the list resolves', async () => {
    const bridge = harness()
    let resolveList!: (value: ListResult) => void
    bridge.channels.list.mockReturnValue(
      new Promise<ListResult>((resolve) => {
        resolveList = resolve
      })
    )
    mount(bridge.channels)
    expect(snapshots).toEqual([new Set()])
    expect(bridge.channels.list).toHaveBeenCalledExactlyOnceWith()
    expect(bridge.channels.onChanged).toHaveBeenCalledOnce()

    await act(async () => {
      resolveList({
        ok: true,
        value: [
          channel('channel-1', 'chat-a'),
          channel('channel-2', 'chat-b'),
          channel('channel-3', 'chat-a'),
          channel('channel-4', 'chat-closed', 'closed')
        ]
      })
    })
    expect(currentIds()).toEqual(new Set(['chat-a', 'chat-b']))
    expect(snapshots).toHaveLength(2)
  })

  it.each(['channel', 'membership', 'message'] as const)(
    'refreshes after a %s event and unsubscribes on unmount',
    async (reason) => {
      const bridge = harness()
      bridge.channels.list.mockResolvedValueOnce({
        ok: true,
        value: [channel('channel-1', 'chat-old')]
      })
      mount(bridge.channels)
      await flushList()
      expect(currentIds()).toEqual(new Set(['chat-old']))

      bridge.channels.list.mockResolvedValueOnce({
        ok: true,
        value: [channel('channel-2', 'chat-new'), channel('channel-1', 'chat-old', 'closed')]
      })
      await act(async () => bridge.change(reason))
      expect(bridge.channels.list).toHaveBeenCalledTimes(2)
      expect(currentIds()).toEqual(new Set(['chat-new']))

      bridge.channels.list.mockResolvedValueOnce({ ok: true, value: [] })
      await act(async () => bridge.change())
      expect(currentIds()).toEqual(new Set())
      unmount()
      expect(bridge.off).toHaveBeenCalledOnce()
      bridge.change()
      expect(bridge.channels.list).toHaveBeenCalledTimes(3)
    }
  )

  it('preserves its Set and subscriptions across an unrelated rerender', async () => {
    const bridge = harness()
    mount(bridge.channels)
    await flushList()
    const previous = currentIds()
    const renderCount = snapshots.length
    render()
    expect(currentIds()).toBe(previous)
    expect(snapshots).toHaveLength(renderCount)
    expect(bridge.channels.list).toHaveBeenCalledTimes(1)
    expect(bridge.channels.onChanged).toHaveBeenCalledTimes(1)
    expect(bridge.off).not.toHaveBeenCalled()
  })

  it.each(['not-ok', 'rejected'] as const)(
    'retains prior IDs when a refresh is %s and remains subscribed',
    async (failure) => {
      const bridge = harness()
      bridge.channels.list.mockResolvedValueOnce({
        ok: true,
        value: [channel('channel-1', 'chat-kept')]
      })
      mount(bridge.channels)
      await flushList()
      const previous = currentIds()
      if (failure === 'not-ok') {
        bridge.channels.list.mockResolvedValueOnce({
          ok: false,
          error: { code: 'internal_error', message: 'Unavailable' }
        })
      } else {
        bridge.channels.list.mockRejectedValueOnce(new Error('Disconnected'))
      }
      await act(async () => bridge.change())
      expect(currentIds()).toBe(previous)
      expect(currentIds()).toEqual(new Set(['chat-kept']))
      expect(bridge.off).not.toHaveBeenCalled()
      await act(async () => bridge.change())
      expect(currentIds()).toEqual(new Set())
      expect(bridge.channels.list).toHaveBeenCalledTimes(3)
    }
  )

  it.each(['not-ok', 'rejected'] as const)(
    'keeps the initial empty Set when the first list is %s',
    async (failure) => {
      const bridge = harness()
      if (failure === 'not-ok') {
        bridge.channels.list.mockResolvedValueOnce({
          ok: false,
          error: { code: 'not_authorized', message: 'Not available' }
        })
      } else {
        bridge.channels.list.mockRejectedValueOnce(new Error('Disconnected'))
      }
      mount(bridge.channels)
      const initial = currentIds()
      await flushList()
      expect(currentIds()).toBe(initial)
      expect(currentIds()).toEqual(new Set())
      expect(snapshots).toHaveLength(1)
      unmount()
      expect(bridge.off).toHaveBeenCalledOnce()
    }
  )

  it('keeps an empty Set when an older preload has no channels API', async () => {
    expect(() => mount()).not.toThrow()
    await flushList()
    expect(snapshots).toEqual([new Set()])
    expect(() => unmount()).not.toThrow()
  })

  it('supports a preload with list but no optional change subscription', async () => {
    const bridge = harness()
    bridge.channels.list.mockResolvedValueOnce({
      ok: true,
      value: [channel('channel-1', 'chat-a')]
    })
    mount({ list: bridge.channels.list })
    await flushList()
    expect(currentIds()).toEqual(new Set(['chat-a']))
    expect(bridge.channels.onChanged).not.toHaveBeenCalled()
    expect(() => unmount()).not.toThrow()
  })
})
