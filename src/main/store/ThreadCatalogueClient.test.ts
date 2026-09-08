import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ThreadCatalogueClient,
  type ThreadCatalogueProcessPort
} from '../../host-shared/thread-catalogue/ThreadCatalogueClient'

class Port extends EventEmitter implements ThreadCatalogueProcessPort {
  readonly posts: Array<{ id: number; query: { method: string } }> = []
  terminateCalls = 0

  constructor(readonly terminateResult: 'resolve' | 'reject' = 'resolve') {
    super()
  }

  postMessage(value: unknown): void {
    const message = value as { id: number; query: { method: string } }
    this.posts.push(message)
    if (message.query.method === 'initialize' || message.query.method === 'close') {
      queueMicrotask(() => this.emit('message', { id: message.id, ok: true, value: true }))
    }
  }

  terminate(): Promise<void> {
    this.terminateCalls += 1
    return this.terminateResult === 'resolve'
      ? Promise.resolve()
      : Promise.reject(new Error('termination rejected'))
  }
}

const options = (restart: () => ThreadCatalogueProcessPort) => ({
  reader: {
    profilePath: join(tmpdir(), 'thread-client-regression-profile'),
    runtimeInstanceId: 'runtime',
    segmented: false
  },
  decoderPath: join(tmpdir(), 'thread-client-regression-decoder.js'),
  owner: { writer: 'desktop' as const, writerId: 'writer' },
  restart,
  restartDelayMs: 5
})

afterEach(() => vi.useRealTimers())

describe('ThreadCatalogueClient supervision regressions', () => {
  it('restarts after a proven exit without trying to terminate the exited port', async () => {
    vi.useFakeTimers()
    const first = new Port('reject')
    const replacement = new Port()
    const restart = vi.fn(() => replacement)
    const client = new ThreadCatalogueClient(first, options(restart))
    await client.ready

    first.emit('exit', 1)
    await vi.advanceTimersByTimeAsync(5)
    await client.ready

    expect(first.terminateCalls).toBe(0)
    expect(restart).toHaveBeenCalledOnce()
    await client.dispose()
  })

  it('never starts a competing actor when termination is rejected', async () => {
    vi.useFakeTimers()
    const first = new Port('reject')
    const restart = vi.fn(() => new Port())
    const client = new ThreadCatalogueClient(first, options(restart))
    await client.ready

    first.emit('error', new Error('worker error'))
    await vi.advanceTimersByTimeAsync(5)
    await vi.advanceTimersByTimeAsync(0)

    expect(restart).not.toHaveBeenCalled()
    await expect(client.dispose()).rejects.toThrow('termination rejected')
  })

  it('shares one disposal flight across concurrent callers', async () => {
    const port = new Port()
    const client = new ThreadCatalogueClient(
      port,
      options(() => new Port())
    )
    await client.ready

    const first = client.dispose()
    const second = client.dispose()
    expect(second).toBe(first)
    await Promise.all([first, second])

    expect(port.posts.filter(({ query }) => query.method === 'close')).toHaveLength(1)
    expect(port.terminateCalls).toBe(1)
  })
})
