import { describe, expect, it, vi } from 'vitest'

import { HostProjectionTransportError } from '../../host-client/HostProjectionClient'
import type {
  HostLocalTransportThreadOwnerParams,
  HostLocalTransportSuccessResult
} from '../../shared/hostProtocolTransport'
import { ThreadOwnershipClient, type ThreadOwnershipClaimFacts } from './ThreadOwnershipClient'

type OwnerResult = Extract<HostLocalTransportSuccessResult, { kind: 'thread.owner' }>
const HOST = 'a'.repeat(64)
const NEXT_HOST = 'b'.repeat(64)

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function fixture(enabled = true) {
  let now = 100
  let facts: ThreadOwnershipClaimFacts | null = {
    baseRevision: 7,
    headRevision: 7,
    lineageToken: {}
  }
  const pending: Array<ReturnType<typeof deferred<OwnerResult>>> = []
  const requestThreadOwner = vi.fn((_params: HostLocalTransportThreadOwnerParams) => {
    const reply = deferred<OwnerResult>()
    pending.push(reply)
    return reply.promise
  })
  const readClaimFacts = vi.fn(() => facts)
  const client = new ThreadOwnershipClient({
    enabled,
    writerId: 'writer-process',
    transport: { requestThreadOwner },
    readClaimFacts,
    now: () => now
  })
  const grant = (index = 0, host = HOST, number = 1) => {
    const request = requestThreadOwner.mock.calls[index][0]
    if (request.action !== 'claim') throw new Error('Expected claim')
    pending[index].resolve({
      kind: 'thread.owner',
      action: 'claim',
      reply: {
        threadId: request.threadId,
        claimId: request.claimId,
        granted: true,
        epoch: { host, grant: number }
      }
    })
  }
  return {
    client,
    pending,
    requestThreadOwner,
    readClaimFacts,
    grant,
    setFacts: (next: ThreadOwnershipClaimFacts | null) => (facts = next),
    advance: (ms: number) => (now += ms)
  }
}

describe('ThreadOwnershipClient negotiation', () => {
  it('does no I/O on construction and claims nothing while off or disconnected', async () => {
    const off = fixture(false)
    expect(off.requestThreadOwner).not.toHaveBeenCalled()
    expect(off.readClaimFacts).not.toHaveBeenCalled()
    off.client.onWelcome({ bootEpoch: HOST })
    const offAttempt = off.client.requestClaim('thread')
    expect(off.requestThreadOwner).not.toHaveBeenCalled()
    expect(await offAttempt).toEqual({
      kind: 'not_requested',
      reason: 'disabled'
    })
    const f = fixture()
    expect(await f.client.requestClaim('thread')).toEqual({
      kind: 'not_requested',
      reason: 'disconnected'
    })
    expect(off.requestThreadOwner).not.toHaveBeenCalled()
    expect(f.requestThreadOwner).not.toHaveBeenCalled()
  })

  it('uses only bootEpoch and requires a confirmed base before probing', async () => {
    const f = fixture()
    f.client.onWelcome({})
    expect(await f.client.requestClaim('thread')).toEqual({
      kind: 'not_requested',
      reason: 'missing_boot_epoch'
    })
    f.client.onWelcome({ bootEpoch: HOST })
    f.setFacts(null)
    expect(await f.client.requestClaim('thread')).toEqual({
      kind: 'not_requested',
      reason: 'no_confirmed_base'
    })
    expect(f.requestThreadOwner).not.toHaveBeenCalled()
  })

  it('captures immutable confirmed facts and exposes a network grant, never append readiness', async () => {
    const f = fixture()
    const facts = { baseRevision: 7, headRevision: 9, lineageToken: {} }
    f.setFacts(facts)
    f.client.onWelcome({ bootEpoch: HOST })
    const answer = f.client.requestClaim('thread')
    expect(f.requestThreadOwner).toHaveBeenCalledExactlyOnceWith({
      action: 'claim',
      threadId: 'thread',
      writerId: 'writer-process',
      claimId: 1,
      baseRevision: 7,
      headRevision: 9
    })
    facts.baseRevision = 99
    facts.headRevision = 100
    expect(f.client.stateOf('thread')).toEqual({ kind: 'claiming' })
    f.grant()
    const outcome = await answer
    expect(outcome.kind).toBe('network_grant')
    if (outcome.kind !== 'network_grant') throw new Error('Expected network grant')
    expect(outcome.grant.facts).toEqual({
      baseRevision: 7,
      headRevision: 9,
      lineageToken: facts.lineageToken
    })
    expect(Object.isFrozen(outcome.grant)).toBe(true)
    expect(Object.isFrozen(outcome.grant.epoch)).toBe(true)
    expect(Object.isFrozen(outcome.grant.facts)).toBe(true)
    expect(f.client.stateOf('thread')).toEqual(outcome)
    expect(await f.client.requestClaim('thread')).toEqual(outcome)
    expect(f.requestThreadOwner).toHaveBeenCalledTimes(1)
    expect('owns' in f.client || 'canAppend' in f.client || 'ready' in f.client).toBe(false)
  })

  it.each([HOST, NEXT_HOST])('ignores late grants across reconnect to %s', async (nextHost) => {
    const f = fixture()
    f.client.onWelcome({ bootEpoch: HOST })
    const stale = f.client.requestClaim('thread')
    f.client.onDisconnected()
    expect(f.client.stateOf('thread')).toEqual({ kind: 'unclaimed' })
    f.client.onWelcome({ bootEpoch: nextHost })
    const current = f.client.requestClaim('thread')
    f.grant(0)
    expect(await stale).toEqual({ kind: 'stale' })
    expect(f.client.stateOf('thread')).toEqual({ kind: 'claiming' })
    f.grant(1, nextHost, 2)
    expect((await current).kind).toBe('network_grant')
  })

  it('drops granted state on disconnect and on every welcome, even with the same boot', async () => {
    const f = fixture()
    f.client.onWelcome({ bootEpoch: HOST })
    const granted = f.client.requestClaim('thread')
    f.grant()
    await granted
    f.client.onWelcome({ bootEpoch: HOST })
    expect(f.client.stateOf('thread')).toEqual({ kind: 'unclaimed' })
    const reasserted = f.client.requestClaim('thread')
    expect(f.requestThreadOwner).toHaveBeenCalledTimes(2)
    f.grant(1)
    await reasserted
    f.client.onDisconnected()
    expect(f.client.stateOf('thread')).toEqual({ kind: 'unclaimed' })
  })

  it.each(['disabled', 'unknown_request_kind'])(
    'falls back for %s until reconnect',
    async (kind) => {
      const f = fixture()
      f.client.onWelcome({ bootEpoch: HOST })
      const first = f.client.requestClaim('thread')
      if (kind === 'disabled') {
        f.pending[0].resolve({
          kind: 'thread.owner',
          action: 'claim',
          reply: {
            threadId: 'thread',
            claimId: 1,
            granted: false,
            reason: 'disabled',
            revision: null
          }
        })
        expect(await first).toEqual({ kind: 'refused', reason: 'disabled', revision: null })
      } else {
        f.pending[0].reject(new HostProjectionTransportError('unknown_request_kind'))
        expect(await first).toEqual({ kind: 'not_requested', reason: 'unsupported' })
      }
      f.advance(10_000)
      expect((await f.client.requestClaim('other')).kind).toBe('not_requested')
      expect(f.requestThreadOwner).toHaveBeenCalledTimes(1)
      f.client.onWelcome({ bootEpoch: HOST })
      const next = f.client.requestClaim('thread')
      f.grant(1)
      expect((await next).kind).toBe('network_grant')
    }
  )

  it('does not let a stale unknown-request rejection disable the replacement connection', async () => {
    const f = fixture()
    f.client.onWelcome({ bootEpoch: HOST })
    const old = f.client.requestClaim('thread')
    f.client.onWelcome({ bootEpoch: HOST })
    f.pending[0].reject(new HostProjectionTransportError('unknown_request_kind'))
    expect(await old).toEqual({ kind: 'stale' })
    const next = f.client.requestClaim('thread')
    f.grant(1)
    expect((await next).kind).toBe('network_grant')
  })

  it('retains the retry interval without polling and ignores a superseded claim', async () => {
    const f = fixture()
    f.client.onWelcome({ bootEpoch: HOST })
    const old = f.client.requestClaim('thread')
    expect(await f.client.requestClaim('thread')).toEqual({
      kind: 'not_requested',
      reason: 'retry_pending'
    })
    f.advance(999)
    const beforeRetry = f.client.requestClaim('thread')
    expect(f.requestThreadOwner).toHaveBeenCalledTimes(1)
    expect(await beforeRetry).toEqual({
      kind: 'not_requested',
      reason: 'retry_pending'
    })
    f.advance(1)
    const next = f.client.requestClaim('thread')
    f.grant(0)
    expect(await old).toEqual({ kind: 'stale' })
    f.grant(1)
    expect((await next).kind).toBe('network_grant')
    expect(f.requestThreadOwner).toHaveBeenCalledTimes(2)
  })

  it('allows a bounded retry after request failure without closing the transport', async () => {
    const f = fixture()
    f.client.onWelcome({ bootEpoch: HOST })
    const first = f.client.requestClaim('thread')
    f.pending[0].reject(new Error('request failed'))
    expect(await first).toEqual({ kind: 'failed' })
    expect((await f.client.requestClaim('thread')).kind).toBe('not_requested')
    f.advance(1_000)
    const retry = f.client.requestClaim('thread')
    f.grant(1)
    expect((await retry).kind).toBe('network_grant')
  })

  it('keeps an ahead-Host refusal and waits before trying again', async () => {
    const f = fixture()
    f.client.onWelcome({ bootEpoch: HOST })
    const first = f.client.requestClaim('thread')
    f.pending[0].resolve({
      kind: 'thread.owner',
      action: 'claim',
      reply: { threadId: 'thread', claimId: 1, granted: false, reason: 'host_ahead', revision: 10 }
    })
    expect(await first).toEqual({ kind: 'refused', reason: 'host_ahead', revision: 10 })
    expect(f.client.stateOf('thread')).toEqual({ kind: 'unclaimed' })
    expect(await f.client.requestClaim('thread')).toEqual({
      kind: 'not_requested',
      reason: 'retry_pending'
    })
    f.advance(1_000)
    f.setFacts({ baseRevision: 10, headRevision: 10, lineageToken: {} })
    const next = f.client.requestClaim('thread')
    f.grant(1)
    expect((await next).kind).toBe('network_grant')
  })

  it('cannot accept another pending thread grant as the answer to this request', async () => {
    const f = fixture()
    f.client.onWelcome({ bootEpoch: HOST })
    const first = f.client.requestClaim('first')
    const other = f.client.requestClaim('other')
    f.pending[0].resolve({
      kind: 'thread.owner',
      action: 'claim',
      reply: { threadId: 'other', claimId: 2, granted: true, epoch: { host: HOST, grant: 1 } }
    })
    expect(await first).toEqual({ kind: 'failed' })
    expect(f.client.stateOf('first')).toEqual({ kind: 'claiming' })
    expect(f.client.stateOf('other')).toEqual({ kind: 'claiming' })
    f.grant(1)
    expect((await other).kind).toBe('network_grant')
  })

  it('ignores a grant from a different Host boot on the current connection', async () => {
    const f = fixture()
    f.client.onWelcome({ bootEpoch: HOST })
    const first = f.client.requestClaim('thread')
    f.grant(0, NEXT_HOST)
    expect(await first).toEqual({ kind: 'stale' })
    expect(f.client.stateOf('thread')).toEqual({ kind: 'claiming' })
  })

  it.each([
    { baseRevision: -1, headRevision: 0 },
    { baseRevision: 2, headRevision: 1 },
    { baseRevision: NaN, headRevision: 1 },
    { baseRevision: 1, headRevision: Infinity },
    { baseRevision: 1, headRevision: Number.MAX_SAFE_INTEGER + 1 }
  ])('rejects invalid confirmed facts before sending: %j', async (revisions) => {
    const f = fixture()
    f.client.onWelcome({ bootEpoch: HOST })
    f.setFacts({ ...revisions, lineageToken: {} })
    await expect(f.client.requestClaim('thread')).rejects.toThrow(
      'Invalid confirmed claim revisions'
    )
    expect(f.requestThreadOwner).not.toHaveBeenCalled()
  })
})
