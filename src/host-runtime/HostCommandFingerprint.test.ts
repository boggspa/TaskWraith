import { describe, expect, it } from 'vitest'

import type { HostCommand, HostCommandName } from '../shared/hostProtocol'
import { fingerprintHostCommand } from './HostCommandFingerprint'

const names: readonly HostCommandName[] = [
  'snapshot.get',
  'deltas.since',
  'receipt.lookup',
  'composer.send',
  'run.cancel',
  'question.answer',
  'approval.decide',
  'ensemble.seat.toggle',
  'thread.record.persist',
  'thread.record.delete',
  'channel.member.revoke',
  'channel.close',
  'thread.select',
  'workspace.register',
  'thread.create',
  'thread.configure',
  'thread.archive',
  'provider.auth.begin',
  'provider.auth.cancel',
  'ping'
]

const goldenFingerprints: Partial<Record<HostCommandName, string>> = {
  'snapshot.get': 'd51c5a87653f1e953a821a4202e0f926d84c80f888d01a4b4a14818418408377',
  'deltas.since': '4e5322b753a6182b781727a90fb23125be9a9b3ed0bbcc5fd99b2cc966225f2b',
  'receipt.lookup': 'ded2cf022420eb388e7dc600fe7145353f116b5677f66f1997a3d63f7df57ad3',
  'composer.send': 'cfcfe561e12e6f712dd782b2acb81e5601958c37a87449e2a1c9ff352d6a3c3f',
  'run.cancel': '2c6bba7d2b9ad66eae5e2a5039a75e5fba761f82eca624b811bbab55b8eac3ee',
  'question.answer': '8cb855e78a7f2b24a2de4a3850cc4d79b3df724c9e925839557fa970a93d0324',
  'approval.decide': '078d040867c9612380942bd5511513b9b3cd82252769c37a38302dd19a97806f',
  'ensemble.seat.toggle': '64dc23341670979c912ecef29386489f358cd9477229621ae31b0307c0d70693',
  'channel.member.revoke': '51a4604f14d895086e0b85c263e6774325d6504ee8e75459f9d8689308894866',
  'channel.close': '4625fb853cf4ab722a841fedd77642f383578ece976ba99661d6d20ed8a21468',
  'thread.select': 'dd6f5b3acf5c03eaae9f553b8dae1673c105f5ea94ef3ba41dc28e76c26a5960',
  ping: 'd9a4e49d77578533bcb8e34c3449e00d73c7439fdd41be0db373e4c8aac83131'
}

function command(
  name: HostCommandName,
  target: Record<string, string> = {},
  args: Record<string, unknown> = {}
): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: 2,
    commandId: 'command-id',
    idempotencyKey: 'idempotency-key',
    actor: { actorId: 'actor-id', clientId: 'client-id', clientClass: 'desktop' },
    name,
    target,
    arguments: args,
    issuedAt: '2026-08-03T20:00:00.000Z'
  }
}

function targetFor(name: HostCommandName): Record<string, string> {
  switch (name) {
    case 'composer.send':
    case 'run.cancel':
    case 'ensemble.seat.toggle':
    case 'thread.record.persist':
    case 'thread.record.delete':
    case 'thread.select':
    case 'thread.configure':
    case 'thread.archive':
      return { threadId: 'thread-id' }
    case 'provider.auth.begin':
      return { providerId: 'provider-id' }
    case 'provider.auth.cancel':
      return { providerId: 'provider-id', operationId: 'operation-id' }
    case 'channel.member.revoke':
    case 'channel.close':
      return { channelId: 'channel-id' }
    case 'question.answer':
      return { questionId: 'question-id' }
    case 'approval.decide':
      return { approvalId: 'approval-id' }
    case 'receipt.lookup':
      return { commandId: 'command-id' }
    default:
      return {}
  }
}

describe('fingerprintHostCommand', () => {
  it('produces a 64-hex fingerprint for every command name', () => {
    for (const name of names) {
      const result = fingerprintHostCommand(command(name, targetFor(name), { text: 'golden' }))
      expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/)
      if (goldenFingerprints[name] !== undefined) {
        expect(result.fingerprint).toBe(goldenFingerprints[name])
      }
      expect(result.argsDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(result.fingerprint).not.toContain('secret-value')
      expect(JSON.stringify(result)).not.toContain('secret-value')
    }
  })

  it('binds thread.record.persist fingerprints to the canonical thread and descriptor', () => {
    const descriptor = {
      transferId: '11111111-1111-4111-8111-111111111111',
      sha256: 'a'.repeat(64),
      byteLength: 512 * 1024,
      expectedRevision: 7
    }
    const first = fingerprintHostCommand(
      command('thread.record.persist', { threadId: 'thread-id' }, descriptor)
    )
    const changedRevision = fingerprintHostCommand(
      command(
        'thread.record.persist',
        { threadId: 'thread-id' },
        {
          ...descriptor,
          expectedRevision: 8
        }
      )
    )
    const changedTransfer = fingerprintHostCommand(
      command(
        'thread.record.persist',
        { threadId: 'thread-id' },
        {
          ...descriptor,
          transferId: '22222222-2222-4222-8222-222222222222'
        }
      )
    )
    expect(first.targetKind).toBe('thread')
    expect(changedRevision.fingerprint).not.toBe(first.fingerprint)
    expect(changedTransfer.fingerprint).not.toBe(first.fingerprint)
    expect(JSON.stringify(first)).not.toContain(descriptor.transferId)
    expect(JSON.stringify(first)).not.toContain(descriptor.sha256)
  })

  it('is independent of argument key order and changes for meaningful values', () => {
    const first = fingerprintHostCommand(
      command('composer.send', { threadId: 'thread-id' }, { nested: { b: 'two', a: 'one' } })
    )
    const reordered = fingerprintHostCommand(
      command('composer.send', { threadId: 'thread-id' }, { nested: { a: 'one', b: 'two' } })
    )
    const changed = fingerprintHostCommand(
      command('composer.send', { threadId: 'thread-id' }, { nested: { a: 'different', b: 'two' } })
    )
    expect(reordered).toEqual(first)
    expect(changed.fingerprint).not.toBe(first.fingerprint)
  })

  it('uses exact primary targets and rejects ambiguous or malformed shapes', () => {
    expect(
      fingerprintHostCommand(command('composer.send', { threadId: 'thread-id' })).targetKind
    ).toBe('thread')
    expect(() =>
      fingerprintHostCommand(command('composer.send', { threadId: 'a', runId: 'b' }))
    ).toThrow('ambiguous target')
    expect(() =>
      fingerprintHostCommand(command('receipt.lookup', { commandId: 'a', idempotencyKey: 'b' }))
    ).toThrow('ambiguous target')
    expect(() => fingerprintHostCommand(command('ping', { threadId: 'a' }))).toThrow(
      'ambiguous target'
    )
    const firstCancel = fingerprintHostCommand(
      command('provider.auth.cancel', { providerId: 'provider-id', operationId: 'operation-a' })
    )
    const secondCancel = fingerprintHostCommand(
      command('provider.auth.cancel', { providerId: 'provider-id', operationId: 'operation-b' })
    )
    expect(secondCancel.fingerprint).not.toBe(firstCancel.fingerprint)
    expect(() =>
      fingerprintHostCommand(command('provider.auth.cancel', { providerId: 'provider-id' }))
    ).toThrow('ambiguous target')
  })

  it('rejects cycles, non-finite numbers, and unsupported values without echoing data', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => fingerprintHostCommand(command('ping', {}, cyclic))).toThrow('cyclic arguments')
    expect(() => fingerprintHostCommand(command('ping', {}, { value: Number.NaN }))).toThrow(
      'unsupported argument value'
    )
    expect(() => fingerprintHostCommand(command('ping', {}, { value: undefined }))).toThrow(
      'unsupported argument value'
    )
    expect(() =>
      fingerprintHostCommand(command('ping', {}, { value: () => 'raw-secret' }))
    ).toThrow('unsupported argument value')
    expect(() =>
      fingerprintHostCommand(command('ping', {}, { value: Symbol('raw-secret') }))
    ).toThrow('unsupported argument value')
  })
})
