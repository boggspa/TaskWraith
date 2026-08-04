import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  HOST_PROTOCOL_VERSION,
  type HostActorIdentity,
  type HostCommand
} from '../../shared/hostProtocol'
import { fingerprintHostCommand } from './HostCommandFingerprint'
import {
  HOST_DEFERRED_COMMAND_ENVELOPE_JOURNAL_FILENAME,
  type HostDeferredCommandEnvelopePutInput
} from './HostDeferredCommandEnvelopeStore'
import {
  HostRuntimeBootstrap,
  type HostRuntimeDeferredRecoveryRecord
} from './HostRuntimeBootstrap'

const ACTOR = {
  clientId: 'test-client',
  actorId: 'actor-1',
  clientClass: 'test' as const
}

const ENVELOPE_ACTOR: HostActorIdentity = {
  actorId: 'actor-1',
  clientId: 'client-1',
  clientClass: 'desktop'
}

const COMMAND_ID = '11111111-1111-4111-8111-111111111111'
const IDEMPOTENCY_UUID = '22222222-2222-4222-8222-222222222221'
const DEFERRED_ID = '33333333-3333-4333-8333-333333333331'
const CHALLENGE_ID = '44444444-4444-4444-8444-444444444441'
const SECRET_TEXT = 'bootstrap-envelope private composer text'

function envelopeCommand(text: string = SECRET_TEXT): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: COMMAND_ID,
    idempotencyKey: `${ENVELOPE_ACTOR.clientClass}:${ENVELOPE_ACTOR.clientId}:${IDEMPOTENCY_UUID}`,
    actor: ENVELOPE_ACTOR,
    name: 'composer.send',
    target: { threadId: 'thread-1' },
    arguments: { text },
    issuedAt: '2026-08-04T02:00:00.000Z'
  }
}

function envelopePutInput(
  hostCommand: HostCommand = envelopeCommand()
): HostDeferredCommandEnvelopePutInput {
  return {
    deferredId: DEFERRED_ID,
    challengeId: CHALLENGE_ID,
    challengeKind: 'approval',
    commandFingerprint: fingerprintHostCommand(hostCommand).fingerprint,
    command: hostCommand
  }
}

describe('HostRuntimeBootstrap', () => {
  let hostDataDir: string

  beforeEach(() => {
    hostDataDir = mkdtempSync(join(tmpdir(), 'host-runtime-'))
  })

  afterEach(() => {
    rmSync(hostDataDir, { recursive: true, force: true })
  })

  it('composes both durable stores under one injected Host directory', () => {
    const runtime = new HostRuntimeBootstrap({ hostDataDir })

    expect(runtime.getPosition()).toEqual({ generation: 1, cursor: 0 })
    expect(runtime.getRecoverySummary()).toMatchObject({
      position: { generation: 1, cursor: 0 },
      receipts: { size: 0, indeterminate: 0 }
    })
    expect(runtime.getRecoverySummary().deferred).toEqual({
      availability: 'available',
      size: 0,
      indeterminate: 0,
      uniqueIndeterminateCommandCount: 0
    })
    expect(runtime.getRecoverySummary().envelopes).toEqual({
      availability: 'available',
      size: 0,
      stored: 0,
      consumed: 0,
      quarantined: 0,
      storedCommandIds: [],
      quarantinedCommandIds: []
    })

    const delta = runtime.deltaStore.append({
      kind: 'upsert',
      family: 'thread',
      entityId: 'thread-1',
      payload: { title: 'bounded' }
    })
    expect(delta.kind).toBe('appended')

    const receipt = runtime.receiptStore.begin({
      commandId: 'command-1',
      idempotencyKey: 'idem-1',
      commandName: 'composer.send',
      commandFingerprint: 'a'.repeat(64),
      actor: ACTOR,
      target: { kind: 'thread', id: 'thread-1' },
      authority: { decision: 'allowed' }
    })
    expect(receipt.kind).toBe('created')
    if (receipt.kind !== 'created') return
    // Position sourced only through delta-backed bootstrap callback.
    expect(receipt.receipt.generation).toBe(1)
    expect(receipt.receipt.cursor).toBe(1)
    expect(receipt.receipt.commandName).toBe('composer.send')
    expect(runtime.getPosition()).toEqual({ generation: 1, cursor: 1 })
  })

  it('constructs a readonly envelope store under the same injected Host directory', () => {
    const runtime = new HostRuntimeBootstrap({ hostDataDir })

    expect(runtime.envelopeStore).toBeDefined()
    expect(runtime.envelopeStore.size).toBe(0)
    expect(runtime.envelopeStore.getRecoverySummary().availability).toBe('available')

    const put = runtime.envelopeStore.put(envelopePutInput())
    expect(put).toEqual({ kind: 'created' })
    expect(runtime.envelopeStore.size).toBe(1)
    expect(runtime.getRecoverySummary().envelopes).toEqual({
      availability: 'available',
      size: 1,
      stored: 1,
      consumed: 0,
      quarantined: 0,
      storedCommandIds: [COMMAND_ID],
      quarantinedCommandIds: []
    })
    expect(runtime.getRecoverySummary().deferred).toEqual({
      availability: 'available',
      size: 1,
      indeterminate: 0,
      uniqueIndeterminateCommandCount: 0
    })
  })

  it('reopens the envelope store across bootstrap instances without cross-store interference', () => {
    const first = new HostRuntimeBootstrap({ hostDataDir })
    first.deltaStore.append({
      kind: 'upsert',
      family: 'thread',
      entityId: 'thread-keep',
      payload: { title: 'delta-row' }
    })
    first.receiptStore.begin({
      commandId: 'receipt-keep',
      idempotencyKey: 'idem-keep',
      commandName: 'ping',
      commandFingerprint: 'c'.repeat(64),
      actor: ACTOR,
      target: { kind: 'host', id: 'host-1' },
      authority: { decision: 'allowed' }
    })
    expect(first.envelopeStore.put(envelopePutInput())).toEqual({ kind: 'created' })

    const restarted = new HostRuntimeBootstrap({ hostDataDir })
    expect(restarted.getPosition()).toEqual({ generation: 1, cursor: 1 })
    expect(restarted.receiptStore.list()).toHaveLength(1)
    const found = restarted.envelopeStore.getByCommandId(COMMAND_ID, ENVELOPE_ACTOR)
    expect(found.kind).toBe('found')
    if (found.kind !== 'found') return
    expect(found.record.state).toBe('stored')
    expect(found.record.command?.arguments).toEqual({ text: SECRET_TEXT })
    expect(restarted.getRecoverySummary().envelopes).toMatchObject({
      availability: 'available',
      size: 1,
      stored: 1,
      storedCommandIds: [COMMAND_ID]
    })

    // Delta/receipt mutations do not disturb envelope recovery; envelope put does not disturb them.
    restarted.deltaStore.append({
      kind: 'upsert',
      family: 'warning',
      entityId: 'w-extra'
    })
    expect(restarted.envelopeStore.size).toBe(1)
    expect(restarted.receiptStore.list()).toHaveLength(1)
  })

  it('surfaces an unavailable envelope store in recovery and never heals or hides it', () => {
    const first = new HostRuntimeBootstrap({ hostDataDir })
    expect(first.envelopeStore.put(envelopePutInput())).toEqual({ kind: 'created' })

    const journalPath = join(hostDataDir, HOST_DEFERRED_COMMAND_ENVELOPE_JOURNAL_FILENAME)
    appendFileSync(journalPath, '{not-json}\n', 'utf8')
    const evidence = readFileSync(journalPath, 'utf8')

    const restarted = new HostRuntimeBootstrap({
      hostDataDir,
      deferredRecovery: {
        list: () => [{ commandId: 'bridge-still-lists', state: 'indeterminate' }]
      }
    })

    expect(restarted.envelopeStore.getRecoverySummary().availability).toBe('unavailable')
    expect(restarted.getRecoverySummary().envelopes).toEqual({
      availability: 'unavailable',
      size: null,
      stored: null,
      consumed: null,
      quarantined: null,
      storedCommandIds: null,
      quarantinedCommandIds: null
    })
    // Fail-closed: bridge adapter must not heal/hide envelope unavailability.
    expect(restarted.getRecoverySummary().deferred).toEqual({
      availability: 'unavailable',
      size: null,
      indeterminate: null,
      uniqueIndeterminateCommandCount: null
    })
    expect(readFileSync(journalPath, 'utf8')).toBe(evidence)

    const serialized = JSON.stringify(restarted.getRecoverySummary())
    expect(serialized).not.toContain(SECRET_TEXT)
    expect(serialized).not.toContain('thread-1')
    expect(serialized).not.toContain('bridge-still-lists')
  })

  it('keeps envelope recovery body-free even when a private command body is stored', () => {
    const runtime = new HostRuntimeBootstrap({ hostDataDir })
    expect(runtime.envelopeStore.put(envelopePutInput())).toEqual({ kind: 'created' })

    const summary = runtime.getRecoverySummary()
    const serialized = JSON.stringify(summary)
    expect(serialized).not.toContain(SECRET_TEXT)
    expect(serialized).not.toContain('thread-1')
    expect(summary.envelopes).toEqual({
      availability: 'available',
      size: 1,
      stored: 1,
      consumed: 0,
      quarantined: 0,
      storedCommandIds: [COMMAND_ID],
      quarantinedCommandIds: []
    })
  })

  it('reports available deferred recovery and deduplicates indeterminate command ids', () => {
    const first = new HostRuntimeBootstrap({ hostDataDir })
    first.receiptStore.begin({
      commandId: 'shared-command',
      idempotencyKey: 'idem-shared',
      commandName: 'ping',
      commandFingerprint: 'a'.repeat(64),
      actor: ACTOR,
      target: { kind: 'host', id: 'host-1' },
      authority: { decision: 'allowed' }
    })

    const restarted = new HostRuntimeBootstrap({
      hostDataDir,
      deferredRecovery: {
        list: () => [
          { commandId: 'shared-command', state: 'indeterminate' },
          { commandId: 'deferred-only', state: 'indeterminate' },
          { commandId: 'completed-deferred', state: 'succeeded' }
        ]
      }
    })
    const summary = restarted.getRecoverySummary()

    expect(summary.receipts).toMatchObject({ size: 1, indeterminate: 1 })
    expect(summary.deferred).toEqual({
      availability: 'available',
      size: 3,
      indeterminate: 2,
      uniqueIndeterminateCommandCount: 2
    })
    expect(summary.envelopes?.availability).toBe('available')
  })

  it('reports unavailable deferred recovery when the source throws or returns invalid records', () => {
    const throwing = new HostRuntimeBootstrap({
      hostDataDir,
      deferredRecovery: {
        list: () => {
          throw new Error('bridge unavailable')
        }
      }
    })
    expect(throwing.getRecoverySummary().deferred).toEqual({
      availability: 'unavailable',
      size: null,
      indeterminate: null,
      uniqueIndeterminateCommandCount: null
    })
    expect(throwing.getRecoverySummary().envelopes?.availability).toBe('available')

    const invalid = new HostRuntimeBootstrap({
      hostDataDir,
      deferredRecovery: {
        list: () => [{ commandId: 'missing-state' } as unknown as HostRuntimeDeferredRecoveryRecord]
      }
    })
    expect(invalid.getRecoverySummary().deferred).toEqual({
      availability: 'unavailable',
      size: null,
      indeterminate: null,
      uniqueIndeterminateCommandCount: null
    })
  })

  it('fails closed when deferred recovery exceeds the bounded record limit', () => {
    const runtime = new HostRuntimeBootstrap({
      hostDataDir,
      deferredRecovery: {
        list: () =>
          Array.from({ length: 2_001 }, (_, index) => ({
            commandId: `command-${index}`,
            state: 'indeterminate' as const
          }))
      }
    })

    expect(runtime.getRecoverySummary().deferred).toEqual({
      availability: 'unavailable',
      size: null,
      indeterminate: null,
      uniqueIndeterminateCommandCount: null
    })
  })

  it('reconstructs delta position and promotes pending receipts to indeterminate', () => {
    const first = new HostRuntimeBootstrap({ hostDataDir })
    first.deltaStore.append({
      kind: 'upsert',
      family: 'mission',
      entityId: 'mission-1',
      payload: { title: 'durable' }
    })
    first.deltaStore.resetGeneration('restart-boundary')

    first.receiptStore.begin({
      commandId: 'command-pending',
      idempotencyKey: 'idem-pending',
      commandName: 'ping',
      commandFingerprint: 'b'.repeat(64),
      actor: ACTOR,
      target: { kind: 'mission', id: 'mission-1' },
      authority: { decision: 'allowed' }
    })

    const restarted = new HostRuntimeBootstrap({ hostDataDir })
    expect(restarted.getPosition()).toEqual({ generation: 2, cursor: 1 })
    expect(restarted.deltaStore.getByCursor(1)?.envelope.kind).toBe('generation-reset')
    const pending = restarted.receiptStore.getByCommandId('command-pending', ACTOR)
    expect(pending.kind).toBe('found')
    if (pending.kind !== 'found') return
    expect(pending.receipt.status).toBe('indeterminate')
    expect(pending.receipt.recoveryState).toBe('recoverable-indeterminate')
    // Mint-time position preserved across reopen (generation-reset cursor 1).
    expect(pending.receipt.generation).toBe(2)
    expect(pending.receipt.cursor).toBe(1)
    expect(restarted.getRecoverySummary().receipts.indeterminate).toBe(1)
  })

  it('flushes both stores through their existing compaction boundaries', () => {
    const runtime = new HostRuntimeBootstrap({ hostDataDir })
    runtime.deltaStore.append({ kind: 'upsert', family: 'warning', entityId: 'w1' })
    expect(runtime.envelopeStore.put(envelopePutInput())).toEqual({ kind: 'created' })
    runtime.flush()

    const reopened = new HostRuntimeBootstrap({ hostDataDir })
    expect(reopened.getPosition()).toEqual({ generation: 1, cursor: 1 })
    expect(reopened.deltaStore.getByCursor(1)?.envelope.entityId).toBe('w1')
    expect(reopened.envelopeStore.getRecoverySummary()).toMatchObject({
      availability: 'available',
      size: 1,
      stored: 1,
      storedCommandIds: [COMMAND_ID]
    })
  })
})
