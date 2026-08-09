import { describe, expect, it, vi } from 'vitest'
import { createHostProductionChatListCoalescer } from './HostProductionChatListCoalescer'

describe('createHostProductionChatListCoalescer', () => {
  it('reads each scope once per turn and shares one coherent array across families', () => {
    const releases: Array<() => void> = []
    let revision = 0
    const getChatList = vi.fn((workspaceId?: string) => [
      { id: `${workspaceId ?? 'all'}:${++revision}` }
    ])
    const port = createHostProductionChatListCoalescer(
      { getChatList },
      { scheduleRelease: (release) => releases.push(release) }
    )

    const threads = port.getChatList()
    const missions = port.getChatList()
    const workspaceThreads = port.getChatList('workspace-1')
    const workspaceRounds = port.getChatList('workspace-1')

    expect(threads).toBe(missions)
    expect(workspaceThreads).toBe(workspaceRounds)
    expect(threads).not.toBe(workspaceThreads)
    expect(getChatList).toHaveBeenCalledTimes(2)
    expect(releases).toHaveLength(1)
  })

  it('releases at the microtask boundary so later snapshots re-read authority', () => {
    const releases: Array<() => void> = []
    const getChatList = vi.fn(() => [{ revision: getChatList.mock.calls.length }])
    const port = createHostProductionChatListCoalescer(
      { getChatList },
      { scheduleRelease: (release) => releases.push(release) }
    )

    expect(port.getChatList()[0]?.revision).toBe(1)
    expect(port.getChatList()[0]?.revision).toBe(1)
    releases.shift()?.()
    expect(port.getChatList()[0]?.revision).toBe(2)
    expect(getChatList).toHaveBeenCalledTimes(2)
  })

  it('never caches a failed authority read as an empty or stale list', () => {
    const getChatList = vi
      .fn<() => Array<{ id: string }>>()
      .mockImplementationOnce(() => {
        throw new Error('store unavailable')
      })
      .mockReturnValueOnce([{ id: 'fresh' }])
    const port = createHostProductionChatListCoalescer({ getChatList })

    expect(() => port.getChatList()).toThrow('store unavailable')
    expect(port.getChatList()).toEqual([{ id: 'fresh' }])
    expect(getChatList).toHaveBeenCalledTimes(2)
  })

  it('validates both the source and optional scheduler', () => {
    expect(() => createHostProductionChatListCoalescer({} as never)).toThrow(
      'HostProductionChatListCoalescer requires source.getChatList'
    )
    expect(() =>
      createHostProductionChatListCoalescer(
        { getChatList: () => [] },
        { scheduleRelease: true as never }
      )
    ).toThrow('HostProductionChatListCoalescer scheduleRelease must be a function')
  })
})
