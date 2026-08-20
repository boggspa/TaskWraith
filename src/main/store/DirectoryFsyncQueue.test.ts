import { describe, it, expect, vi } from 'vitest'
import { createDirectoryFsyncQueue } from './DirectoryFsyncQueue'

/** Adapters whose fsync completion is controlled by the test. */
function controllable() {
  const fsyncCalls: number[] = []
  const releases: Array<() => void> = []
  const closed: number[] = []
  let nextFd = 1
  const queue = createDirectoryFsyncQueue({
    open: (_dir, cb) => cb(null, nextFd++),
    fsync: (fd, cb) => {
      fsyncCalls.push(fd)
      releases.push(() => cb(null))
    },
    close: (fd, cb) => {
      closed.push(fd)
      cb(null)
    }
  })
  return {
    queue,
    fsyncCalls,
    releases,
    closed,
    releaseAll: () => {
      while (releases.length) releases.shift()!()
    }
  }
}

describe('createDirectoryFsyncQueue', () => {
  it('flushes a scheduled directory', async () => {
    const { queue, fsyncCalls, releaseAll } = controllable()
    queue.schedule('/data/chats')
    expect(fsyncCalls).toHaveLength(1)
    releaseAll()
    await queue.drain()
    expect(queue.pending()).toBe(0)
  })

  it('does NOT drop a request that arrives while a flush is in flight', async () => {
    // The load-bearing case: the in-flight fsync may have started BEFORE this
    // newer rename, so dropping the request would leave that rename covered by
    // no fsync at all.
    const { queue, fsyncCalls, releases, releaseAll } = controllable()
    queue.schedule('/data/chats')
    expect(fsyncCalls).toHaveLength(1)

    queue.schedule('/data/chats')
    expect(fsyncCalls).toHaveLength(1) // still coalesced, not run concurrently
    expect(queue.pending()).toBe(2) // ...but remembered

    releases.shift()!()
    expect(fsyncCalls).toHaveLength(2) // trailing run happened
    releaseAll()
    await queue.drain()
  })

  it('collapses many writes to one directory into two flushes, not N', async () => {
    const { queue, fsyncCalls, releases, releaseAll } = controllable()
    queue.schedule('/data/chats')
    for (let i = 0; i < 20; i++) queue.schedule('/data/chats')
    expect(fsyncCalls).toHaveLength(1)
    releases.shift()!()
    expect(fsyncCalls).toHaveLength(2)
    releaseAll()
    await queue.drain()
    expect(fsyncCalls).toHaveLength(2)
  })

  it('keeps separate directories independent', async () => {
    const { queue, fsyncCalls, releaseAll } = controllable()
    queue.schedule('/data/chats')
    queue.schedule('/data/usage')
    expect(fsyncCalls).toHaveLength(2)
    releaseAll()
    await queue.drain()
  })

  it('closes the descriptor it opened', async () => {
    const { queue, closed, releaseAll } = controllable()
    queue.schedule('/data/chats')
    releaseAll()
    await queue.drain()
    expect(closed).toHaveLength(1)
  })

  it('tolerates an open failure without wedging the queue', async () => {
    const queue = createDirectoryFsyncQueue({
      open: (_dir, cb) => cb(Object.assign(new Error('EACCES'), { code: 'EACCES' }), -1),
      fsync: (_fd, cb) => cb(null),
      close: (_fd, cb) => cb(null)
    })
    queue.schedule('/data/chats')
    await queue.drain()
    expect(queue.pending()).toBe(0)
  })

  it('tolerates a throwing fsync without wedging the queue', async () => {
    const close = vi.fn((_fd: number, cb: (e: null) => void) => cb(null))
    const queue = createDirectoryFsyncQueue({
      open: (_dir, cb) => cb(null, 7),
      fsync: () => {
        throw new Error('fsync exploded')
      },
      close
    })
    queue.schedule('/data/chats')
    await queue.drain()
    expect(queue.pending()).toBe(0)
    expect(close).toHaveBeenCalledWith(7, expect.any(Function))
  })

  it('drain resolves immediately when idle', async () => {
    const { queue } = controllable()
    await expect(queue.drain()).resolves.toBeUndefined()
  })

  it('ignores an empty directory path', () => {
    const { queue, fsyncCalls } = controllable()
    queue.schedule('')
    expect(fsyncCalls).toHaveLength(0)
  })
})
