import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  THREAD_CATALOGUE_CLOSE_TIMEOUT_MS,
  THREAD_CATALOGUE_RESTART_BACKOFF_CAP_MS,
  THREAD_CATALOGUE_TERMINATE_TIMEOUT_MS,
  ThreadCatalogueClient,
  type ThreadCatalogueProcessPort
} from '../../host-shared/thread-catalogue/ThreadCatalogueClient'

class Port extends EventEmitter implements ThreadCatalogueProcessPort {
  readonly posts: Array<{ id: number; query: { method: string }; priority?: string }> = []
  terminateCalls = 0

  constructor(
    readonly terminateResult: 'resolve' | 'reject' | 'hang' = 'resolve',
    readonly answersClose = true
  ) {
    super()
  }

  postMessage(value: unknown): void {
    const message = value as { id: number; query: { method: string }; priority?: string }
    this.posts.push(message)
    if (
      message.query.method === 'initialize' ||
      (message.query.method === 'close' && this.answersClose)
    ) {
      queueMicrotask(() => this.emit('message', { id: message.id, ok: true, value: true }))
    }
  }

  terminate(): Promise<void> {
    this.terminateCalls += 1
    if (this.terminateResult === 'hang') return new Promise(() => undefined)
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

  // A production Host's lifetime-stop deadline is summed from these three
  // bounds (HOST_LIFETIME_STOP_DEADLINE_MS), so each step must wait its own.
  it('gives a worker that never answers close THREAD_CATALOGUE_CLOSE_TIMEOUT_MS, then terminates it', async () => {
    vi.useFakeTimers()
    const port = new Port('resolve', false)
    const client = new ThreadCatalogueClient(
      port,
      options(() => new Port())
    )
    await client.ready

    let disposed = false
    void client.dispose().then(() => {
      disposed = true
    })
    await vi.advanceTimersByTimeAsync(THREAD_CATALOGUE_CLOSE_TIMEOUT_MS - 1)
    expect(port.terminateCalls).toBe(0)
    expect(disposed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(port.terminateCalls).toBe(1)
    expect(disposed).toBe(true)
  })

  it('fails a disposal whose worker termination stays unconfirmed for THREAD_CATALOGUE_TERMINATE_TIMEOUT_MS', async () => {
    vi.useFakeTimers()
    const port = new Port('hang')
    const client = new ThreadCatalogueClient(
      port,
      options(() => new Port())
    )
    await client.ready

    let outcome: unknown = 'pending'
    void client.dispose().then(
      () => {
        outcome = 'disposed'
      },
      (error: unknown) => {
        outcome = error
      }
    )
    await vi.advanceTimersByTimeAsync(THREAD_CATALOGUE_TERMINATE_TIMEOUT_MS - 1)
    expect(port.terminateCalls).toBe(1)
    expect(outcome).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toBe('History worker termination is unconfirmed')
  })

  it('restarts a failed worker after at most THREAD_CATALOGUE_RESTART_BACKOFF_CAP_MS', async () => {
    vi.useFakeTimers()
    const first = new Port()
    const restart = vi.fn(() => new Port())
    // A base delay far past the cap, so the cap alone sets the wait.
    const client = new ThreadCatalogueClient(first, {
      ...options(restart),
      restartDelayMs: 10 * THREAD_CATALOGUE_RESTART_BACKOFF_CAP_MS
    })
    await client.ready

    first.emit('exit', 1)
    await vi.advanceTimersByTimeAsync(THREAD_CATALOGUE_RESTART_BACKOFF_CAP_MS - 1)
    expect(restart).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(restart).toHaveBeenCalledOnce()
    await client.ready
    await client.dispose()
  })

  // The lane rides the ENVELOPE, never the query: `decodeThreadCatalogueReadQuery`
  // is a strict allowlist that rebuilds each query field-by-field, so a key
  // tucked inside `query` is silently eaten on the Host path.
  it('carries a background request\u2019s lane beside the query, not inside it', async () => {
    const port = new Port()
    const client = new ThreadCatalogueClient(
      port,
      options(() => new Port())
    )
    await client.ready

    void client.query({ method: 'summary', chatId: 'chat-1' } as never, { priority: 'background' })
    await Promise.resolve()

    const posted = port.posts.find(({ query }) => query.method === 'summary')
    expect(posted?.priority).toBe('background')
    expect(posted?.query).not.toHaveProperty('priority')
  })

  // A foreground envelope must stay byte-identical to what every caller that
  // predates this field has always sent, so an older reader on the same wire
  // sees exactly the message it already understands.
  it('adds nothing to a foreground envelope', async () => {
    const port = new Port()
    const client = new ThreadCatalogueClient(
      port,
      options(() => new Port())
    )
    await client.ready

    void client.query({ method: 'summary', chatId: 'chat-1' } as never)
    void client.query({ method: 'summary', chatId: 'chat-2' } as never, {
      priority: 'foreground'
    })
    await Promise.resolve()

    for (const posted of port.posts.filter(({ query }) => query.method === 'summary')) {
      expect(Object.keys(posted).sort()).toEqual(['id', 'query'])
    }
  })

  it('reconstructs a closed worker error code without trusting its prose or closing the worker', async () => {
    const port = new Port()
    const client = new ThreadCatalogueClient(
      port,
      options(() => new Port())
    )
    await client.ready

    const query = client.query({ method: 'summary', chatId: 'chat-1' } as never)
    await Promise.resolve()
    const posted = port.posts.find(({ query: value }) => value.method === 'summary')!
    port.emit('message', {
      id: posted.id,
      ok: false,
      errorCode: 'source_changed',
      error: 'untrusted worker prose'
    })

    await expect(query).rejects.toMatchObject({
      name: 'ThreadCatalogueRequestError',
      code: 'source_changed',
      message: 'History changed during indexing.'
    })
    expect(client.available).toBe(true)
    expect(port.terminateCalls).toBe(0)
    await client.dispose()
  })
})
