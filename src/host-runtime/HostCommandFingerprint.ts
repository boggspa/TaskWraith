import { createHash } from 'node:crypto'

import type { HostCommand, HostCommandName } from '../shared/hostProtocol'
import { hostCommandFingerprint } from './HostCommandReceiptStore'

export interface HostCommandFingerprintResult {
  fingerprint: string
  targetKind: string
  argsDigest: string
}

type CanonicalValue =
  | null
  | boolean
  | number
  | { sha256: string }
  | CanonicalValue[]
  | { [key: string]: CanonicalValue }

const TARGET_RULES: Record<HostCommandName, { keys: readonly string[]; kind: string }> = {
  'snapshot.get': { keys: [], kind: 'snapshot' },
  'deltas.since': { keys: [], kind: 'deltas-position' },
  'receipt.lookup': { keys: [], kind: 'receipt' },
  'composer.send': { keys: ['threadId'], kind: 'thread' },
  'run.cancel': { keys: ['threadId'], kind: 'thread' },
  'question.answer': { keys: ['questionId'], kind: 'question' },
  'approval.decide': { keys: ['approvalId'], kind: 'approval' },
  'ensemble.seat.toggle': { keys: ['threadId'], kind: 'thread' },
  'thread.record.persist': { keys: ['threadId'], kind: 'thread' },
  'thread.record.delete': { keys: ['threadId'], kind: 'thread' },
  'channel.member.revoke': { keys: ['channelId'], kind: 'channel' },
  'channel.close': { keys: ['channelId'], kind: 'channel' },
  'thread.select': { keys: ['threadId'], kind: 'thread' },
  'workspace.register': { keys: [], kind: 'workspace-register' },
  'thread.create': { keys: [], kind: 'thread-create' },
  'thread.configure': { keys: ['threadId'], kind: 'thread' },
  'thread.archive': { keys: ['threadId'], kind: 'thread' },
  'provider.auth.begin': { keys: ['providerId'], kind: 'provider-auth' },
  'provider.auth.cancel': { keys: ['providerId', 'operationId'], kind: 'provider-auth' },
  ping: { keys: [], kind: 'host' }
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function canonicalize(value: unknown, seen: Set<object>): CanonicalValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('HostCommandFingerprint: unsupported argument value')
    }
    return value
  }
  if (typeof value === 'string') {
    return { sha256: digest(value) }
  }
  if (typeof value !== 'object' || value === undefined) {
    throw new Error('HostCommandFingerprint: unsupported argument value')
  }
  if (seen.has(value)) {
    throw new Error('HostCommandFingerprint: cyclic arguments')
  }
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((item) => canonicalize(item, seen))
    }
    const record = value as Record<string, unknown>
    const output: { [key: string]: CanonicalValue } = {}
    for (const key of Object.keys(record).sort()) {
      output[key] = canonicalize(record[key], seen)
    }
    return output
  } finally {
    seen.delete(value)
  }
}

function targetFor(command: HostCommand): { kind: string; id?: string } {
  const rule = TARGET_RULES[command.name]
  const keys = Object.keys(command.target).sort()
  if (command.name === 'receipt.lookup') {
    if (keys.length !== 1 || !['commandId', 'idempotencyKey'].includes(keys[0] ?? '')) {
      throw new Error('HostCommandFingerprint: ambiguous target')
    }
    const key = keys[0]
    const id = command.target[key]
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('HostCommandFingerprint: invalid target')
    }
    return { kind: key === 'commandId' ? 'receipt-command' : 'receipt-idempotency', id }
  }
  const expected = [...rule.keys].sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error('HostCommandFingerprint: ambiguous target')
  }
  if (rule.keys.length === 0) return { kind: rule.kind }
  const targetParts = rule.keys.map((key) => command.target[key])
  if (targetParts.some((part) => typeof part !== 'string' || part.length === 0)) {
    throw new Error('HostCommandFingerprint: invalid target')
  }
  return {
    kind: rule.kind,
    id: rule.keys.length === 1 ? targetParts[0] : JSON.stringify(targetParts)
  }
}

/**
 * Canonicalize a decoded Host command into the exact store fingerprint.
 * Argument and target values are hashed before canonical argument material is
 * formed; raw values never appear in the returned result or thrown errors.
 */
export function fingerprintHostCommand(command: HostCommand): HostCommandFingerprintResult {
  const target = targetFor(command)
  const canonicalArguments = canonicalize(command.arguments, new Set())
  const argsDigest = digest(JSON.stringify(canonicalArguments))
  const fingerprint = hostCommandFingerprint({
    type: command.name,
    targetKind: target.kind,
    targetId: target.id,
    argsDigest
  })
  return { fingerprint, targetKind: target.kind, argsDigest }
}
