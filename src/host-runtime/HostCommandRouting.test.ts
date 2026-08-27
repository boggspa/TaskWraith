import { describe, expect, it } from 'vitest'

import type { HostCommandName } from '../shared/hostProtocol'
import {
  HOST_AUTHORITY_RPC_READ_ALIAS_NAMES,
  HOST_COMMAND_NAMES,
  HOST_COMMAND_ROUTING_CLASS,
  HOST_GOVERNED_MUTATION_COMMAND_NAMES,
  HOST_SETUP_MUTATION_COMMAND_NAMES,
  classifyHostCommandName,
  hostCommandRoutingClassFor,
  isAuthorityRpcReadAliasName,
  isGovernedMutationCommandName,
  isSetupMutationCommandName,
  parseAuthorityRpcReadAliasName,
  parseGovernedMutationCommandName,
  parseHostCommandName,
  parseSetupMutationCommandName
} from './HostCommandRouting'

/** Canonical HostCommandName set from shared protocol (test oracle only). */
const PROTOCOL_COMMAND_NAMES: readonly HostCommandName[] = [
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

const EXPECTED_SETUP: readonly HostCommandName[] = [
  'workspace.register',
  'thread.create',
  'thread.configure',
  'thread.archive',
  'provider.auth.begin',
  'provider.auth.cancel'
]

const EXPECTED_READ_ALIASES: readonly HostCommandName[] = [
  'snapshot.get',
  'deltas.since',
  'receipt.lookup',
  'ping'
]

const EXPECTED_GOVERNED: readonly HostCommandName[] = [
  'composer.send',
  'run.cancel',
  'question.answer',
  'approval.decide',
  'ensemble.seat.toggle',
  'thread.record.persist',
  'thread.record.delete',
  'channel.member.revoke',
  'channel.close',
  'thread.select'
]

describe('HostCommandRouting', () => {
  it('covers every HostCommandName exactly once via the typed map', () => {
    expect(new Set(HOST_COMMAND_NAMES)).toEqual(new Set(PROTOCOL_COMMAND_NAMES))
    expect(HOST_COMMAND_NAMES).toHaveLength(PROTOCOL_COMMAND_NAMES.length)
    for (const name of PROTOCOL_COMMAND_NAMES) {
      expect(HOST_COMMAND_ROUTING_CLASS[name]).toBeDefined()
    }
  })

  it('partitions read aliases, Bridge-governed mutations, and setup mutations', () => {
    expect([...HOST_AUTHORITY_RPC_READ_ALIAS_NAMES].sort()).toEqual(
      [...EXPECTED_READ_ALIASES].sort()
    )
    expect([...HOST_GOVERNED_MUTATION_COMMAND_NAMES].sort()).toEqual([...EXPECTED_GOVERNED].sort())
    expect([...HOST_SETUP_MUTATION_COMMAND_NAMES].sort()).toEqual([...EXPECTED_SETUP].sort())

    const union = new Set([
      ...HOST_AUTHORITY_RPC_READ_ALIAS_NAMES,
      ...HOST_GOVERNED_MUTATION_COMMAND_NAMES,
      ...HOST_SETUP_MUTATION_COMMAND_NAMES
    ])
    expect(union.size).toBe(HOST_COMMAND_NAMES.length)
    expect(union).toEqual(new Set(HOST_COMMAND_NAMES))

    for (const name of HOST_AUTHORITY_RPC_READ_ALIAS_NAMES) {
      expect(HOST_GOVERNED_MUTATION_COMMAND_NAMES).not.toContain(name)
      expect(isAuthorityRpcReadAliasName(name)).toBe(true)
      expect(isGovernedMutationCommandName(name)).toBe(false)
      expect(hostCommandRoutingClassFor(name)).toBe('authority-rpc-read-alias')
    }
    for (const name of HOST_GOVERNED_MUTATION_COMMAND_NAMES) {
      expect(HOST_AUTHORITY_RPC_READ_ALIAS_NAMES).not.toContain(name)
      expect(isGovernedMutationCommandName(name)).toBe(true)
      expect(isAuthorityRpcReadAliasName(name)).toBe(false)
      expect(hostCommandRoutingClassFor(name)).toBe('governed-mutation')
    }
    for (const name of HOST_SETUP_MUTATION_COMMAND_NAMES) {
      expect(HOST_GOVERNED_MUTATION_COMMAND_NAMES).not.toContain(name)
      expect(isSetupMutationCommandName(name)).toBe(true)
      expect(isGovernedMutationCommandName(name)).toBe(false)
      expect(isAuthorityRpcReadAliasName(name)).toBe(false)
      expect(hostCommandRoutingClassFor(name)).toBe('setup-mutation')
    }
  })

  it.each([
    ['snapshot.get', 'authority-rpc-read-alias'],
    ['deltas.since', 'authority-rpc-read-alias'],
    ['receipt.lookup', 'authority-rpc-read-alias'],
    ['ping', 'authority-rpc-read-alias'],
    ['composer.send', 'governed-mutation'],
    ['run.cancel', 'governed-mutation'],
    ['question.answer', 'governed-mutation'],
    ['approval.decide', 'governed-mutation'],
    ['ensemble.seat.toggle', 'governed-mutation'],
    ['thread.record.persist', 'governed-mutation'],
    ['thread.record.delete', 'governed-mutation'],
    ['channel.member.revoke', 'governed-mutation'],
    ['channel.close', 'governed-mutation'],
    ['thread.select', 'governed-mutation'],
    ['workspace.register', 'setup-mutation'],
    ['thread.create', 'setup-mutation'],
    ['thread.configure', 'setup-mutation'],
    ['thread.archive', 'setup-mutation'],
    ['provider.auth.begin', 'setup-mutation'],
    ['provider.auth.cancel', 'setup-mutation']
  ] as const)('classifies %s as %s', (name, routingClass) => {
    expect(classifyHostCommandName(name)).toBe(routingClass)
    expect(hostCommandRoutingClassFor(name)).toBe(routingClass)
    expect(parseHostCommandName(name)).toBe(name)
  })

  it('parseGovernedMutationCommandName admits only governed mutations', () => {
    for (const name of EXPECTED_GOVERNED) {
      expect(parseGovernedMutationCommandName(name)).toBe(name)
    }
    for (const name of EXPECTED_READ_ALIASES) {
      expect(parseGovernedMutationCommandName(name)).toBeNull()
    }
    for (const name of EXPECTED_SETUP) {
      expect(parseGovernedMutationCommandName(name)).toBeNull()
    }
  })

  it('parseSetupMutationCommandName admits only setup mutations', () => {
    for (const name of EXPECTED_SETUP) expect(parseSetupMutationCommandName(name)).toBe(name)
    for (const name of [...EXPECTED_READ_ALIASES, ...EXPECTED_GOVERNED]) {
      expect(parseSetupMutationCommandName(name)).toBeNull()
    }
  })

  it('parseAuthorityRpcReadAliasName admits only reserved read aliases', () => {
    for (const name of EXPECTED_READ_ALIASES) {
      expect(parseAuthorityRpcReadAliasName(name)).toBe(name)
    }
    for (const name of EXPECTED_GOVERNED) {
      expect(parseAuthorityRpcReadAliasName(name)).toBeNull()
    }
  })

  it.each([
    undefined,
    null,
    0,
    1,
    true,
    false,
    {},
    [],
    { name: 'ping' },
    '',
    ' ',
    'Ping',
    'PING',
    'snapshot',
    'snapshot.get ',
    ' snapshot.get',
    'composer',
    'composer.Send',
    'health',
    'host.snapshot',
    'deltas',
    'receipt',
    'unknown',
    'shutdown',
    'bootstrap',
    'command',
    'run.start'
  ])('fails closed for untrusted input %# (%j)', (value) => {
    expect(parseHostCommandName(value)).toBeNull()
    expect(classifyHostCommandName(value)).toBeNull()
    expect(parseGovernedMutationCommandName(value)).toBeNull()
    expect(parseSetupMutationCommandName(value)).toBeNull()
    expect(parseAuthorityRpcReadAliasName(value)).toBeNull()
  })

  it('does not smuggle read aliases into the governed-mutation gate', () => {
    // Later command() integration must reject reserved aliases here.
    expect(parseGovernedMutationCommandName('snapshot.get')).toBeNull()
    expect(parseGovernedMutationCommandName('deltas.since')).toBeNull()
    expect(parseGovernedMutationCommandName('receipt.lookup')).toBeNull()
    expect(parseGovernedMutationCommandName('ping')).toBeNull()
  })

  it('does not smuggle governed mutations into the Authority-RPC read gate', () => {
    expect(parseAuthorityRpcReadAliasName('composer.send')).toBeNull()
    expect(parseAuthorityRpcReadAliasName('run.cancel')).toBeNull()
    expect(parseAuthorityRpcReadAliasName('question.answer')).toBeNull()
    expect(parseAuthorityRpcReadAliasName('approval.decide')).toBeNull()
    expect(parseAuthorityRpcReadAliasName('ensemble.seat.toggle')).toBeNull()
    expect(parseAuthorityRpcReadAliasName('thread.select')).toBeNull()
  })
})
