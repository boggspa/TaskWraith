import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/taskwraith-codex-live-steer-test',
    getVersion: () => 'test'
  }
}))

import type { LiveSteerDeliveryHooks } from '../RunManager'
import {
  CodexAppServerClient,
  CodexAppServerJsonRpcError,
  CodexAppServerNotRunningError
} from '../CodexAppServerClient'
import { CodexAppServerRequestTimeoutError } from './CodexAppServerRequestError'
import {
  classifyCodexLiveSteerFailure,
  CodexLiveSteerTransport,
  createCodexLiveSteerTransport,
  type CodexLiveSteerClient
} from './CodexLiveSteerTransport'

function hooks(overrides: Partial<LiveSteerDeliveryHooks> = {}): LiveSteerDeliveryHooks {
  return {
    entryId: 'entry-1',
    onDelivered: vi.fn(),
    onRejected: vi.fn(),
    onAmbiguous: vi.fn(),
    ...overrides
  }
}

function client(request: CodexLiveSteerClient['request']): CodexLiveSteerClient {
  return { request }
}

describe('CodexLiveSteerTransport', () => {
  it('sends text and authorized images to the exact bound thread and turn', async () => {
    const request = vi.fn(async () => ({ turnId: 'turn-1' }))
    const delivery = hooks({
      messageId: 'message-1',
      imagePaths: ['/tmp/one.png', '/tmp/two.png']
    })
    const transport = createCodexLiveSteerTransport({
      client: client(request),
      threadId: 'thread-1',
      turnId: 'turn-1',
      timeoutMs: 4321
    })

    expect(transport.sendSteer('Use the attached references.', delivery)).toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith(
      'turn/steer',
      {
        threadId: 'thread-1',
        input: [
          { type: 'text', text: 'Use the attached references.', text_elements: [] },
          { type: 'localImage', path: '/tmp/one.png' },
          { type: 'localImage', path: '/tmp/two.png' }
        ],
        expectedTurnId: 'turn-1',
        clientUserMessageId: 'message-1'
      },
      4321
    )
    await vi.waitFor(() => expect(delivery.onDelivered).toHaveBeenCalledTimes(1))
    expect(delivery.onRejected).not.toHaveBeenCalled()
    expect(delivery.onAmbiguous).not.toHaveBeenCalled()
  })

  it('requires the response turnId to match before recording delivery', async () => {
    const mismatched = hooks()
    const transport = createCodexLiveSteerTransport({
      client: client(vi.fn(async () => ({ turnId: 'turn-other' }))),
      threadId: 'thread-1',
      turnId: 'turn-1'
    })

    expect(transport.sendSteer('Change course.', mismatched)).toBe(true)
    await vi.waitFor(() => expect(mismatched.onAmbiguous).toHaveBeenCalledTimes(1))
    expect(mismatched.onDelivered).not.toHaveBeenCalled()
    expect(mismatched.onRejected).not.toHaveBeenCalled()
    expect(mismatched.onAmbiguous).toHaveBeenCalledWith(expect.stringContaining('turn-other'))
  })

  it('treats a response without a turnId as ambiguous', async () => {
    const delivery = hooks()
    const transport = createCodexLiveSteerTransport({
      client: client(vi.fn(async () => ({}))),
      threadId: 'thread-1',
      turnId: 'turn-1'
    })

    expect(transport.sendSteer('Change course.', delivery)).toBe(true)
    await vi.waitFor(() => expect(delivery.onAmbiguous).toHaveBeenCalledTimes(1))
    expect(delivery.onDelivered).not.toHaveBeenCalled()
    expect(delivery.onRejected).not.toHaveBeenCalled()
  })

  it.each([
    new Error('Method not found: turn/steer'),
    new Error('activeTurnNotSteerable: review'),
    new Error('The active turn is not steerable.'),
    new Error('expectedTurnId does not match the active turn'),
    { code: -32602, message: 'Invalid params' },
    { codexErrorInfo: { activeTurnNotSteerable: { turnKind: 'compact' } } }
  ])('reports an explicit provider rejection without retrying (%o)', async (error) => {
    const request = vi.fn(async () => {
      throw error
    })
    const delivery = hooks()
    const transport = createCodexLiveSteerTransport({
      client: client(request),
      threadId: 'thread-1',
      turnId: 'turn-1'
    })

    expect(transport.sendSteer('Change course.', delivery)).toBe(true)
    await vi.waitFor(() => expect(delivery.onRejected).toHaveBeenCalledTimes(1))
    expect(delivery.onDelivered).not.toHaveBeenCalled()
    expect(delivery.onAmbiguous).not.toHaveBeenCalled()

    expect(transport.sendSteer('Change course.', delivery)).toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('reports timeout as ambiguous and never retries the durable entry', async () => {
    const request = vi.fn(async () => {
      throw new CodexAppServerRequestTimeoutError('turn/steer')
    })
    const delivery = hooks()
    const transport = createCodexLiveSteerTransport({
      client: client(request),
      threadId: 'thread-1',
      turnId: 'turn-1'
    })

    expect(transport.sendSteer('Change course.', delivery)).toBe(true)
    await vi.waitFor(() => expect(delivery.onAmbiguous).toHaveBeenCalledTimes(1))
    expect(delivery.onDelivered).not.toHaveBeenCalled()
    expect(delivery.onRejected).not.toHaveBeenCalled()

    expect(transport.sendSteer('Change course.', delivery)).toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
    expect(delivery.onAmbiguous).toHaveBeenCalledWith(
      expect.stringContaining('will not be retried')
    )
  })

  it('keeps unknown transport failures ambiguous', async () => {
    const delivery = hooks()
    const transport = createCodexLiveSteerTransport({
      client: client(
        vi.fn(async () => {
          throw new Error('Codex app-server stopped.')
        })
      ),
      threadId: 'thread-1',
      turnId: 'turn-1'
    })

    expect(transport.sendSteer('Change course.', delivery)).toBe(true)
    await vi.waitFor(() => expect(delivery.onAmbiguous).toHaveBeenCalledTimes(1))
    expect(delivery.onRejected).not.toHaveBeenCalled()
  })

  it.each([
    new CodexAppServerJsonRpcError({
      code: -32603,
      message: 'Internal error while handling turn/steer'
    }),
    new CodexAppServerJsonRpcError({
      code: -32042,
      message: 'Method not found after an internal dispatch failure',
      data: { kind: 'serverFailure' }
    })
  ])('keeps internal and server-defined JSON-RPC errors ambiguous (%o)', async (error) => {
    const delivery = hooks()
    const transport = createCodexLiveSteerTransport({
      client: client(
        vi.fn(async () => {
          throw error
        })
      ),
      threadId: 'thread-1',
      turnId: 'turn-1'
    })

    expect(transport.sendSteer('Change course.', delivery)).toBe(true)
    await vi.waitFor(() => expect(delivery.onAmbiguous).toHaveBeenCalledTimes(1))
    expect(delivery.onRejected).not.toHaveBeenCalled()
  })

  it('classifies a parsed internal JSON-RPC response as ambiguous end to end', async () => {
    const appClient = new CodexAppServerClient('/tmp/taskwraith-codex-home')
    const write = vi.fn()
    ;(appClient as any).proc = {
      killed: false,
      stdin: { writable: true, write }
    }
    const threadId = '7b057c8b-33fa-4eca-9efe-3313a83669f4'
    ;(appClient as any).privateHomeThreadIds.add(threadId)
    const delivery = hooks()
    const transport = createCodexLiveSteerTransport({
      client: appClient,
      threadId,
      turnId: 'turn-1'
    })

    expect(transport.sendSteer('Change course.', delivery)).toBe(true)
    const request = JSON.parse(String(write.mock.calls[0]?.[0]))
    ;(appClient as any).handleLine(
      JSON.stringify({
        id: request.id,
        error: {
          code: -32603,
          message: 'Internal error while handling turn/steer',
          data: { phase: 'dispatch' }
        }
      })
    )

    await vi.waitFor(() => expect(delivery.onAmbiguous).toHaveBeenCalledTimes(1))
    expect(delivery.onRejected).not.toHaveBeenCalled()
    expect(delivery.onDelivered).not.toHaveBeenCalled()
  })

  it('treats typed client-not-running as definitely not sent', async () => {
    const delivery = hooks()
    const transport = createCodexLiveSteerTransport({
      client: client(
        vi.fn(async () => {
          throw new CodexAppServerNotRunningError('turn/steer')
        })
      ),
      threadId: 'thread-1',
      turnId: 'turn-1'
    })

    expect(transport.sendSteer('Change course.', delivery)).toBe(true)
    await vi.waitFor(() => expect(delivery.onRejected).toHaveBeenCalledTimes(1))
    expect(delivery.onAmbiguous).not.toHaveBeenCalled()
    expect(delivery.onRejected).toHaveBeenCalledWith(expect.stringContaining('was not sent'))
  })

  it('deduplicates only the same durable entry and allows later entries', async () => {
    const request = vi.fn(async () => ({ turnId: 'turn-1' }))
    const transport = createCodexLiveSteerTransport({
      client: client(request),
      threadId: 'thread-1',
      turnId: 'turn-1'
    })

    expect(transport.sendSteer('First.', hooks({ entryId: 'entry-1' }))).toBe(true)
    expect(transport.sendSteer('Duplicate.', hooks({ entryId: 'entry-1' }))).toBe(true)
    expect(transport.sendSteer('Second.', hooks({ entryId: 'entry-2' }))).toBe(true)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('refuses input without delivery evidence and refuses new sends after cancel', () => {
    const request = vi.fn(async () => ({ turnId: 'turn-1' }))
    const transport = createCodexLiveSteerTransport({
      client: client(request),
      threadId: 'thread-1',
      turnId: 'turn-1'
    })

    expect(transport.sendSteer('No hooks.')).toBe(false)
    expect(transport.sendSteer('   ', hooks())).toBe(false)
    transport.cancel()
    expect(transport.sendSteer('Too late.', hooks())).toBe(false)
    expect(request).not.toHaveBeenCalled()
  })

  it('still settles an already-launched request after cancel', async () => {
    let resolveRequest: ((value: unknown) => void) | undefined
    const request = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolveRequest = resolve
        })
    )
    const delivery = hooks()
    const transport = createCodexLiveSteerTransport({
      client: client(request),
      threadId: 'thread-1',
      turnId: 'turn-1'
    })

    expect(transport.sendSteer('Already sent.', delivery)).toBe(true)
    transport.cancel()
    resolveRequest?.({ turnId: 'turn-1' })
    await vi.waitFor(() => expect(delivery.onDelivered).toHaveBeenCalledTimes(1))
  })

  it('contains hook failures and validates the exact binding', async () => {
    const transport = new CodexLiveSteerTransport({
      client: client(vi.fn(async () => ({ turnId: 'turn-1' }))),
      threadId: 'thread-1',
      turnId: 'turn-1'
    })
    expect(
      transport.sendSteer(
        'Change course.',
        hooks({
          onDelivered: () => {
            throw new Error('receipt storage failed')
          }
        })
      )
    ).toBe(true)
    await Promise.resolve()
    await Promise.resolve()

    expect(
      () =>
        new CodexLiveSteerTransport({
          client: client(vi.fn()),
          threadId: ' ',
          turnId: 'turn-1'
        })
    ).toThrow(/exact thread id/)
    expect(
      () =>
        new CodexLiveSteerTransport({
          client: client(vi.fn()),
          threadId: 'thread-1',
          turnId: ''
        })
    ).toThrow(/exact turn id/)
  })
})

describe('classifyCodexLiveSteerFailure', () => {
  it('distinguishes explicit JSON-RPC refusal from transport uncertainty', () => {
    expect(classifyCodexLiveSteerFailure({ code: -32601 })).toBe('rejected')
    expect(classifyCodexLiveSteerFailure(new Error('active turn is not steerable'))).toBe(
      'rejected'
    )
    expect(classifyCodexLiveSteerFailure(new CodexAppServerRequestTimeoutError('turn/steer'))).toBe(
      'ambiguous'
    )
    expect(classifyCodexLiveSteerFailure(new Error('unclassified failure'))).toBe('ambiguous')
  })

  it('does not treat internal or server-defined JSON-RPC codes as safe to replay', () => {
    expect(
      classifyCodexLiveSteerFailure(
        new CodexAppServerJsonRpcError({ code: -32603, message: 'Internal error' })
      )
    ).toBe('ambiguous')
    expect(
      classifyCodexLiveSteerFailure(
        new CodexAppServerJsonRpcError({ code: -32000, message: 'Unable to steer' })
      )
    ).toBe('ambiguous')
  })

  it('recognizes explicit provider preconditions inside structured JSON-RPC data', () => {
    expect(
      classifyCodexLiveSteerFailure(
        new CodexAppServerJsonRpcError({
          code: -32000,
          message: 'Request failed',
          data: { codexErrorInfo: { activeTurnNotSteerable: { turnKind: 'compact' } } }
        })
      )
    ).toBe('rejected')
  })
})
