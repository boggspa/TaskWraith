import { describe, expect, it } from 'vitest'

import {
  HOST_PROTOCOL_VERSION,
  type HostActorIdentity,
  type HostAuthenticatedClientIdentity,
  type HostCommand,
  type HostCommandReceipt,
  type HostCursorPosition,
  type HostDeltasSinceResult,
  type HostHealthProjection,
  type HostSnapshot
} from '../../shared/hostProtocol'
import {
  hostActorsMatchExact,
  hostAuthorityCommandActorMatchesContext,
  hostAuthorityReceiptResultHasBody,
  isExactHostActorIdentity,
  parseHostAuthorityReceiptLookup,
  type HostAuthority,
  type HostAuthorityCallContext,
  type HostAuthorityReceiptLookup,
  type HostAuthorityReceiptResult,
  type HostAuthorityResult,
  type HostAuthorityShutdownResult
} from './HostAuthority'

const ACTOR_A: HostActorIdentity = {
  actorId: 'actor-a',
  clientId: 'client-a',
  clientClass: 'desktop'
}

const ACTOR_B: HostActorIdentity = {
  actorId: 'actor-b',
  clientId: 'client-b',
  clientClass: 'tui'
}

const CLIENT_A: HostAuthenticatedClientIdentity = {
  clientId: 'client-a',
  clientClass: 'desktop',
  clientVersion: '1.9.2'
}

function contextFor(
  actor: HostActorIdentity,
  client?: HostAuthenticatedClientIdentity
): HostAuthorityCallContext {
  return {
    actor,
    client:
      client ??
      ({
        clientId: actor.clientId,
        clientClass: actor.clientClass,
        clientVersion: 'test'
      } satisfies HostAuthenticatedClientIdentity)
  }
}

function fingerprint(seed: string): string {
  return seed.padEnd(64, '0').slice(0, 64)
}

function makeCommand(
  overrides: Partial<HostCommand> & Pick<HostCommand, 'commandId' | 'idempotencyKey' | 'actor'>
): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    name: 'ping',
    target: {},
    arguments: {},
    issuedAt: '2026-08-03T21:00:00.000Z',
    ...overrides
  }
}

function makeReceipt(
  command: HostCommand,
  status: HostCommandReceipt['status'] = 'succeeded'
): HostCommandReceipt {
  return {
    type: 'host.receipt',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    name: command.name,
    actor: { ...command.actor },
    authority:
      status === 'denied'
        ? { decision: 'deny', reason: 'command actor does not match call context' }
        : { decision: 'allow' },
    status,
    commandFingerprint: fingerprint(command.commandId),
    generation: 1,
    cursor: 1,
    createdAt: '2026-08-03T21:00:00.000Z',
    updatedAt: '2026-08-03T21:00:01.000Z'
  }
}

/**
 * Fake Authority — locks the interface contract without a real runtime.
 * Intentionally does not fabricate HostSnapshot / empty defaults.
 */
class FakeHostAuthority implements HostAuthority {
  private stopped = false
  private readonly receipts = new Map<string, HostCommandReceipt>()
  private readonly byIdempotency = new Map<string, string>()

  healthProjection: HostHealthProjection = {
    hostStatus: 'ok',
    connectionPhase: 'live',
    supervised: true,
    freshness: 'live'
  }

  snapshotValue: HostSnapshot | null = null
  deltasValue: HostDeltasSinceResult = {
    kind: 'deltas',
    generation: 1,
    fromCursor: 0,
    toCursor: 0,
    deltas: []
  }

  private gateContext(context: HostAuthorityCallContext): HostAuthorityResult<true> {
    if (this.stopped) return { ok: false, error: 'shutting_down' }
    if (!isExactHostActorIdentity(context.actor)) {
      return { ok: false, error: 'invalid_lookup' }
    }
    return { ok: true, value: true }
  }

  async snapshot(
    context: HostAuthorityCallContext,
    _cursor?: HostCursorPosition
  ): Promise<HostAuthorityResult<HostSnapshot>> {
    const gate = this.gateContext(context)
    if (!gate.ok) return gate
    if (!this.snapshotValue) return { ok: false, error: 'host_unavailable' }
    return { ok: true, value: this.snapshotValue }
  }

  async deltas(
    context: HostAuthorityCallContext,
    _since: HostCursorPosition
  ): Promise<HostAuthorityResult<HostDeltasSinceResult>> {
    const gate = this.gateContext(context)
    if (!gate.ok) return gate
    return { ok: true, value: this.deltasValue }
  }

  async command(
    context: HostAuthorityCallContext,
    command: HostCommand
  ): Promise<HostAuthorityResult<HostCommandReceipt>> {
    const gate = this.gateContext(context)
    if (!gate.ok) return gate
    // Contract: decoded command actor must match call context.
    if (!hostAuthorityCommandActorMatchesContext(context, command)) {
      const denied = makeReceipt(command, 'denied')
      this.receipts.set(denied.commandId, denied)
      this.byIdempotency.set(denied.idempotencyKey, denied.commandId)
      return { ok: true, value: denied }
    }
    const existingId = this.byIdempotency.get(command.idempotencyKey)
    if (existingId && existingId !== command.commandId) {
      const conflict = makeReceipt(command, 'conflict')
      this.receipts.set(conflict.commandId, conflict)
      return { ok: true, value: conflict }
    }
    const receipt = makeReceipt(command, 'succeeded')
    this.receipts.set(receipt.commandId, receipt)
    this.byIdempotency.set(receipt.idempotencyKey, receipt.commandId)
    return { ok: true, value: receipt }
  }

  async receipt(
    context: HostAuthorityCallContext,
    lookup: HostAuthorityReceiptLookup
  ): Promise<HostAuthorityReceiptResult> {
    if (this.stopped) return { ok: false, error: 'shutting_down' }
    const parsed = parseHostAuthorityReceiptLookup(lookup)
    if (!parsed) return { ok: false, error: 'invalid_lookup' }
    if (!isExactHostActorIdentity(context.actor)) {
      return { ok: true, outcome: 'incomplete' }
    }

    let receipt: HostCommandReceipt | undefined
    if ('commandId' in parsed && typeof parsed.commandId === 'string') {
      receipt = this.receipts.get(parsed.commandId)
    } else if ('idempotencyKey' in parsed && typeof parsed.idempotencyKey === 'string') {
      const id = this.byIdempotency.get(parsed.idempotencyKey)
      receipt = id ? this.receipts.get(id) : undefined
    }
    if (!receipt) return { ok: true, outcome: 'not_found' }
    if (!hostActorsMatchExact(receipt.actor, context.actor)) {
      return { ok: true, outcome: 'actor_mismatch' }
    }
    return { ok: true, outcome: 'found', receipt }
  }

  async health(
    context: HostAuthorityCallContext
  ): Promise<HostAuthorityResult<HostHealthProjection>> {
    const gate = this.gateContext(context)
    if (!gate.ok) return gate
    return { ok: true, value: this.healthProjection }
  }

  async shutdown(
    context: HostAuthorityCallContext
  ): Promise<HostAuthorityResult<HostAuthorityShutdownResult>> {
    if (!isExactHostActorIdentity(context.actor)) {
      return { ok: false, error: 'invalid_lookup' }
    }
    if (this.stopped) {
      return { ok: true, value: { stopped: true, alreadyStopped: true } }
    }
    this.stopped = true
    return { ok: true, value: { stopped: true, alreadyStopped: false } }
  }
}

describe('HostAuthority contract', () => {
  it('exposes the six async operations on a conforming implementation', async () => {
    const authority: HostAuthority = new FakeHostAuthority()
    const ctx = contextFor(ACTOR_A, CLIENT_A)
    expect(typeof authority.snapshot).toBe('function')
    expect(typeof authority.deltas).toBe('function')
    expect(typeof authority.command).toBe('function')
    expect(typeof authority.receipt).toBe('function')
    expect(typeof authority.health).toBe('function')
    expect(typeof authority.shutdown).toBe('function')

    const health = await authority.health(ctx)
    expect(health).toEqual({
      ok: true,
      value: {
        hostStatus: 'ok',
        connectionPhase: 'live',
        supervised: true,
        freshness: 'live'
      }
    })

    const deltas = await authority.deltas(ctx, { generation: 1, cursor: 0 })
    expect(deltas.ok).toBe(true)

    // No fabricated empty snapshot — unavailable until an explicit value is supplied.
    const snap = await authority.snapshot(ctx)
    expect(snap).toEqual({ ok: false, error: 'host_unavailable' })
  })

  it('requires exact actor identity helpers', () => {
    expect(isExactHostActorIdentity(ACTOR_A)).toBe(true)
    expect(isExactHostActorIdentity({ actorId: '', clientId: 'c', clientClass: 'desktop' })).toBe(
      false
    )
    expect(
      isExactHostActorIdentity({
        actorId: 'a',
        clientId: 'c',
        clientClass: 'not-a-class' as HostActorIdentity['clientClass']
      })
    ).toBe(false)
    expect(hostActorsMatchExact(ACTOR_A, ACTOR_A)).toBe(true)
    expect(hostActorsMatchExact(ACTOR_A, ACTOR_B)).toBe(false)
  })

  it('requires command.actor to match call context', () => {
    const ctx = contextFor(ACTOR_A)
    const matching = makeCommand({
      commandId: 'cmd-1',
      idempotencyKey: 'idem-1',
      actor: ACTOR_A
    })
    const mismatch = makeCommand({
      commandId: 'cmd-2',
      idempotencyKey: 'idem-2',
      actor: ACTOR_B
    })
    expect(hostAuthorityCommandActorMatchesContext(ctx, matching)).toBe(true)
    expect(hostAuthorityCommandActorMatchesContext(ctx, mismatch)).toBe(false)
  })

  it('returns a durable denied receipt on command actor mismatch (not thrown success)', async () => {
    const authority = new FakeHostAuthority()
    const ctx = contextFor(ACTOR_A)
    const command = makeCommand({
      commandId: 'cmd-denied',
      idempotencyKey: 'idem-denied',
      actor: ACTOR_B
    })
    const result = await authority.command(ctx, command)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.status).toBe('denied')
    expect(result.value.authority.decision).toBe('deny')
    expect(result.value.commandId).toBe('cmd-denied')
  })

  it('returns a durable conflict receipt without treating it as operational failure', async () => {
    const authority = new FakeHostAuthority()
    const ctx = contextFor(ACTOR_A)
    const first = makeCommand({
      commandId: 'cmd-a',
      idempotencyKey: 'shared-key',
      actor: ACTOR_A
    })
    const second = makeCommand({
      commandId: 'cmd-b',
      idempotencyKey: 'shared-key',
      actor: ACTOR_A
    })
    const ok = await authority.command(ctx, first)
    expect(ok.ok).toBe(true)
    const conflict = await authority.command(ctx, second)
    expect(conflict.ok).toBe(true)
    if (!conflict.ok) return
    expect(conflict.value.status).toBe('conflict')
  })

  it('receipt lookup requires exactly one stable key', () => {
    expect(parseHostAuthorityReceiptLookup({ commandId: 'c1' })).toEqual({ commandId: 'c1' })
    expect(parseHostAuthorityReceiptLookup({ idempotencyKey: 'k1' })).toEqual({
      idempotencyKey: 'k1'
    })
    expect(parseHostAuthorityReceiptLookup({})).toBeNull()
    expect(parseHostAuthorityReceiptLookup({ commandId: 'c1', idempotencyKey: 'k1' })).toBeNull()
    expect(parseHostAuthorityReceiptLookup({ commandId: '' })).toBeNull()
    expect(parseHostAuthorityReceiptLookup({ idempotencyKey: '' })).toBeNull()
    expect(parseHostAuthorityReceiptLookup(null)).toBeNull()
    expect(parseHostAuthorityReceiptLookup('commandId')).toBeNull()
  })

  it('receipt miss / actor-mismatch / incomplete never carry a receipt body', async () => {
    const authority = new FakeHostAuthority()
    const ownerCtx = contextFor(ACTOR_A)
    const otherCtx = contextFor(ACTOR_B)
    const command = makeCommand({
      commandId: 'cmd-owned',
      idempotencyKey: 'idem-owned',
      actor: ACTOR_A
    })
    await authority.command(ownerCtx, command)

    const notFound = await authority.receipt(ownerCtx, { commandId: 'missing' })
    expect(notFound).toEqual({ ok: true, outcome: 'not_found' })
    expect(hostAuthorityReceiptResultHasBody(notFound)).toBe(false)
    expect('receipt' in notFound).toBe(false)

    const mismatch = await authority.receipt(otherCtx, { commandId: 'cmd-owned' })
    expect(mismatch).toEqual({ ok: true, outcome: 'actor_mismatch' })
    expect(hostAuthorityReceiptResultHasBody(mismatch)).toBe(false)
    expect('receipt' in mismatch).toBe(false)

    const incomplete = await authority.receipt(
      {
        actor: { actorId: '', clientId: 'x', clientClass: 'desktop' },
        client: CLIENT_A
      },
      { commandId: 'cmd-owned' }
    )
    expect(incomplete).toEqual({ ok: true, outcome: 'incomplete' })
    expect(hostAuthorityReceiptResultHasBody(incomplete)).toBe(false)

    const invalid = await authority.receipt(ownerCtx, {
      commandId: 'a',
      idempotencyKey: 'b'
    } as unknown as HostAuthorityReceiptLookup)
    expect(invalid).toEqual({ ok: false, error: 'invalid_lookup' })
    expect(hostAuthorityReceiptResultHasBody(invalid)).toBe(false)

    const found = await authority.receipt(ownerCtx, { commandId: 'cmd-owned' })
    expect(found.ok).toBe(true)
    if (!found.ok || found.outcome !== 'found') {
      throw new Error('expected found receipt')
    }
    expect(hostAuthorityReceiptResultHasBody(found)).toBe(true)
    expect(found.receipt.commandId).toBe('cmd-owned')

    const byKey = await authority.receipt(ownerCtx, { idempotencyKey: 'idem-owned' })
    expect(byKey.ok && byKey.outcome === 'found').toBe(true)
  })

  it('shutdown is explicit and idempotent', async () => {
    const authority = new FakeHostAuthority()
    const ctx = contextFor(ACTOR_A)

    const first = await authority.shutdown(ctx)
    expect(first).toEqual({ ok: true, value: { stopped: true, alreadyStopped: false } })

    const second = await authority.shutdown(ctx)
    expect(second).toEqual({ ok: true, value: { stopped: true, alreadyStopped: true } })

    const after = await authority.health(ctx)
    expect(after).toEqual({ ok: false, error: 'shutting_down' })

    const cmd = await authority.command(
      ctx,
      makeCommand({ commandId: 'post-stop', idempotencyKey: 'post-stop', actor: ACTOR_A })
    )
    expect(cmd).toEqual({ ok: false, error: 'shutting_down' })
  })

  it('narrow error vocabulary never embeds internals', async () => {
    const authority = new FakeHostAuthority()
    const ctx = contextFor(ACTOR_A)
    const unavailable = await authority.snapshot(ctx)
    expect(unavailable).toEqual({ ok: false, error: 'host_unavailable' })
    expect(JSON.stringify(unavailable)).not.toMatch(/stack|AppStore|Bridge|password|token/i)

    await authority.shutdown(ctx)
    const shuttingDown = await authority.deltas(ctx, { generation: 1, cursor: 0 })
    expect(shuttingDown).toEqual({ ok: false, error: 'shutting_down' })
  })
})
