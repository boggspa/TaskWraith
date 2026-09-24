import { describe, expect, it } from 'vitest'

import type { HostAuthorityCallContext } from './HostAuthority'
import {
  HostDiagnosticAuthority,
  HOST_DIAGNOSTIC_CAPABILITIES,
  HOST_DIAGNOSTIC_WARNING_CODE
} from './HostDiagnosticAuthority'

const CONTEXT: HostAuthorityCallContext = {
  actor: { actorId: 'diagnostic-client', clientId: 'diagnostic-client', clientClass: 'test' },
  client: { clientId: 'diagnostic-client', clientClass: 'test', clientVersion: '1.0.0' }
}

describe('HostDiagnosticAuthority', () => {
  it('offers only authenticated diagnostic reads and a truthful degraded snapshot', async () => {
    const authority = new HostDiagnosticAuthority({ now: () => 1_700_000_000_000 })

    expect(HOST_DIAGNOSTIC_CAPABILITIES).toEqual(['bootstrap', 'snapshot', 'health'])
    expect(HOST_DIAGNOSTIC_CAPABILITIES).not.toContain('provider-catalog')
    expect(HOST_DIAGNOSTIC_CAPABILITIES).not.toContain('provider-auth')
    expect(HOST_DIAGNOSTIC_CAPABILITIES).not.toContain('history')
    expect(authority.getPosition()).toEqual({ generation: 0, cursor: 0 })

    const snapshot = await authority.snapshot(CONTEXT)
    expect(snapshot.ok).toBe(true)
    if (!snapshot.ok) return
    expect(snapshot.value.health).toMatchObject({ hostStatus: 'degraded', supervised: false })
    expect(snapshot.value.warnings).toEqual([
      expect.objectContaining({ code: HOST_DIAGNOSTIC_WARNING_CODE, severity: 'warning' })
    ])
    expect(snapshot.value.usage.availability).toBe('unavailable')
    expect(snapshot.value.threads).toEqual([])

    await expect(authority.deltas(CONTEXT, { generation: 0, cursor: 0 })).resolves.toEqual({
      ok: false,
      error: 'host_unavailable'
    })
  })

  it('fails closed for commands, receipts, and shutdown', async () => {
    const authority = new HostDiagnosticAuthority()
    const command = {
      type: 'host.command' as const,
      protocolVersion: 2 as const,
      commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      idempotencyKey: 'test:test:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      actor: CONTEXT.actor,
      name: 'ping' as const,
      target: {},
      arguments: {},
      issuedAt: '2026-08-24T00:00:00.000Z'
    }

    await expect(authority.command(CONTEXT, command)).resolves.toEqual({
      ok: false,
      error: 'host_unavailable'
    })
    await expect(authority.receipt(CONTEXT, { commandId: command.commandId })).resolves.toEqual({
      ok: false,
      error: 'host_unavailable'
    })
    await expect(authority.shutdown(CONTEXT)).resolves.toEqual({
      ok: false,
      error: 'host_unavailable'
    })
  })

  it('rejects a malformed authenticated context without inventing a snapshot', async () => {
    const authority = new HostDiagnosticAuthority()
    await expect(
      authority.snapshot({ ...CONTEXT, actor: { ...CONTEXT.actor, actorId: '' } })
    ).resolves.toEqual({ ok: false, error: 'invalid_lookup' })
  })

  it('requires exact actor/client id and class agreement for every authority method', async () => {
    const authority = new HostDiagnosticAuthority()
    const mismatchedClient = {
      ...CONTEXT,
      client: { ...CONTEXT.client, clientId: 'different-client' }
    }
    const mismatchedClass = {
      ...CONTEXT,
      client: { ...CONTEXT.client, clientClass: 'tui' as const }
    }
    const command = {
      type: 'host.command' as const,
      protocolVersion: 2 as const,
      commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      idempotencyKey: 'test:test:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      actor: CONTEXT.actor,
      name: 'ping' as const,
      target: {},
      arguments: {},
      issuedAt: '2026-08-24T00:00:00.000Z'
    }

    await expect(authority.snapshot(mismatchedClient)).resolves.toEqual({
      ok: false,
      error: 'invalid_lookup'
    })
    await expect(authority.deltas(mismatchedClass, { generation: 0, cursor: 0 })).resolves.toEqual({
      ok: false,
      error: 'invalid_lookup'
    })
    await expect(authority.command(mismatchedClient, command)).resolves.toEqual({
      ok: false,
      error: 'invalid_lookup'
    })
    await expect(
      authority.receipt(mismatchedClass, { commandId: command.commandId })
    ).resolves.toEqual({
      ok: false,
      error: 'invalid_lookup'
    })
    await expect(authority.health(mismatchedClient)).resolves.toEqual({
      ok: false,
      error: 'invalid_lookup'
    })
    await expect(authority.shutdown(mismatchedClass)).resolves.toEqual({
      ok: false,
      error: 'invalid_lookup'
    })
  })
})
