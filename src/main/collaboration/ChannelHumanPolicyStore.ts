import { randomUUID } from 'crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { dirname, join, resolve } from 'path'

import {
  contributionRulesForPreset,
  normalizeContributionRules,
  type HumanContributionRules
} from './HumanContributionRules'

export const CHANNEL_HUMAN_POLICY_SCHEMA_VERSION = 1
export const CHANNEL_HUMAN_POLICY_FILENAME = 'human-policies.json'
export const MAX_CHANNEL_HUMAN_POLICY_BYTES = 4 * 1024 * 1024

export interface ChannelHumanPolicyRecord {
  schemaVersion: typeof CHANNEL_HUMAN_POLICY_SCHEMA_VERSION
  migrationPlanId: string
  channelId: string
  memberId: string
  sourceShareId: string
  sourceCollaboratorId: string
  sourceDigest: string
  rules: HumanContributionRules
  requiresHostApproval: boolean
  fullHistory: boolean
  createdAt: number
  updatedAt: number
}

export interface ChannelHumanMigrationPolicyInput {
  channelId: string
  memberId: string
  sourceShareId: string
  sourceCollaboratorId: string
  sourceDigest: string
  rules: HumanContributionRules
  requiresHostApproval: boolean
  fullHistory: boolean
}

export type ChannelHumanContributionIntent = 'comment' | 'requestHostAction'
export type ChannelHumanPolicyDenialCode = 'read_only' | 'rule_denied' | 'quota_exceeded'

export type ChannelHumanPolicyDecision =
  | {
      outcome: 'append'
      policy: ChannelHumanPolicyRecord | null
    }
  | {
      outcome: 'host_review' | 'auto_draft'
      policy: ChannelHumanPolicyRecord
    }
  | {
      outcome: 'deny'
      code: ChannelHumanPolicyDenialCode
      message: string
      policy: ChannelHumanPolicyRecord | null
    }

interface ChannelHumanPolicySnapshot {
  schemaVersion: typeof CHANNEL_HUMAN_POLICY_SCHEMA_VERSION
  policies: ChannelHumanPolicyRecord[]
}

export class ChannelHumanPolicyError extends Error {
  readonly code = 'recovery_blocked'

  constructor(message: string) {
    super(message)
    this.name = 'ChannelHumanPolicyError'
  }
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const ROOT_KEYS = new Set(['schemaVersion', 'policies'])
const RECORD_KEYS = new Set([
  'schemaVersion',
  'migrationPlanId',
  'channelId',
  'memberId',
  'sourceShareId',
  'sourceCollaboratorId',
  'sourceDigest',
  'rules',
  'requiresHostApproval',
  'fullHistory',
  'createdAt',
  'updatedAt'
])

function blocked(message: string): never {
  throw new ChannelHumanPolicyError(message)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalize(entry)])
  )
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return (
    Object.keys(value).length === allowed.size &&
    Object.keys(value).every((key) => allowed.has(key))
  )
}

function identifier(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 512 || value.trim() !== value) {
    return false
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value)
}

function timestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function strictRules(value: unknown): HumanContributionRules | null {
  const normalized = normalizeContributionRules(value)
  if (!normalized || canonicalJson(normalized) !== canonicalJson(value)) return null
  return normalized.providerDispatch === 'never' ? normalized : null
}

function parseRecord(value: unknown): ChannelHumanPolicyRecord | null {
  const raw = objectRecord(value)
  if (!raw || !exactKeys(raw, RECORD_KEYS)) return null
  const rules = strictRules(raw.rules)
  if (
    raw.schemaVersion !== CHANNEL_HUMAN_POLICY_SCHEMA_VERSION ||
    !digest(raw.migrationPlanId) ||
    !identifier(raw.channelId) ||
    !identifier(raw.memberId) ||
    !identifier(raw.sourceShareId) ||
    !identifier(raw.sourceCollaboratorId) ||
    !digest(raw.sourceDigest) ||
    !rules ||
    typeof raw.requiresHostApproval !== 'boolean' ||
    typeof raw.fullHistory !== 'boolean' ||
    !timestamp(raw.createdAt) ||
    !timestamp(raw.updatedAt) ||
    raw.updatedAt < raw.createdAt
  ) {
    return null
  }
  return clone(raw) as unknown as ChannelHumanPolicyRecord
}

function parseSnapshot(value: unknown): ChannelHumanPolicySnapshot | null {
  const raw = objectRecord(value)
  if (
    !raw ||
    !exactKeys(raw, ROOT_KEYS) ||
    raw.schemaVersion !== CHANNEL_HUMAN_POLICY_SCHEMA_VERSION ||
    !Array.isArray(raw.policies)
  ) {
    return null
  }
  const policies = raw.policies.map(parseRecord)
  if (policies.some((record) => record === null)) return null
  const complete = policies as ChannelHumanPolicyRecord[]
  const keys = complete.map((record) => `${record.channelId}\u0000${record.memberId}`)
  if (new Set(keys).size !== keys.length) return null
  return {
    schemaVersion: CHANNEL_HUMAN_POLICY_SCHEMA_VERSION,
    policies: complete.sort((left, right) =>
      `${left.channelId}\u0000${left.memberId}`.localeCompare(
        `${right.channelId}\u0000${right.memberId}`
      )
    )
  }
}

function policyIdentity(
  value: ChannelHumanPolicyRecord | ChannelHumanMigrationPolicyInput
): unknown {
  return {
    channelId: value.channelId,
    memberId: value.memberId,
    sourceShareId: value.sourceShareId,
    sourceCollaboratorId: value.sourceCollaboratorId,
    sourceDigest: value.sourceDigest,
    rules: value.rules,
    requiresHostApproval: value.requiresHostApproval,
    fullHistory: value.fullHistory
  }
}

function validateInput(value: ChannelHumanMigrationPolicyInput): void {
  if (
    !identifier(value.channelId) ||
    !identifier(value.memberId) ||
    !identifier(value.sourceShareId) ||
    !identifier(value.sourceCollaboratorId) ||
    !digest(value.sourceDigest) ||
    !strictRules(value.rules) ||
    typeof value.requiresHostApproval !== 'boolean' ||
    typeof value.fullHistory !== 'boolean'
  ) {
    blocked('Channel human migration policy is invalid')
  }
}

function safeNow(value: number): number {
  if (!timestamp(value)) blocked('Channel human policy time is invalid')
  return value
}

function policyKey(channelId: string, memberId: string): string {
  return `${channelId}\u0000${memberId}`
}

export function channelHumanPolicyPath(userDataPath: string): string {
  if (
    typeof userDataPath !== 'string' ||
    !userDataPath.trim() ||
    userDataPath.trim() !== userDataPath
  ) {
    blocked('Channel human policy store requires userDataPath')
  }
  return join(resolve(userDataPath), 'channels', CHANNEL_HUMAN_POLICY_FILENAME)
}

/**
 * Main-owned, migration-bound human policy authority. Missing policy means an
 * ordinary Channel member and therefore preserves pre-P4 Channel behavior.
 */
export class ChannelHumanPolicyStore {
  private snapshot: ChannelHumanPolicySnapshot = {
    schemaVersion: CHANNEL_HUMAN_POLICY_SCHEMA_VERSION,
    policies: []
  }
  private recoveryBlocked = false

  constructor(private readonly storagePath?: string) {
    this.snapshot = this.load()
  }

  get(channelId: string, memberId: string): ChannelHumanPolicyRecord | null {
    this.assertHealthy()
    if (!identifier(channelId) || !identifier(memberId)) {
      blocked('Channel human policy identity is invalid')
    }
    return clone(
      this.snapshot.policies.find(
        (record) => record.channelId === channelId && record.memberId === memberId
      ) ?? null
    )
  }

  list(channelId?: string): ChannelHumanPolicyRecord[] {
    this.assertHealthy()
    if (channelId !== undefined && !identifier(channelId)) {
      blocked('Channel human policy identity is invalid')
    }
    return this.snapshot.policies
      .filter((record) => channelId === undefined || record.channelId === channelId)
      .map(clone)
  }

  applyMigrationPolicies(input: {
    migrationPlanId: string
    policies: readonly ChannelHumanMigrationPolicyInput[]
    now?: number
  }): ChannelHumanPolicyRecord[] {
    this.assertHealthy()
    if (!digest(input.migrationPlanId) || !Array.isArray(input.policies)) {
      blocked('Channel human migration policy batch is invalid')
    }
    input.policies.forEach(validateInput)
    const requestedKeys = input.policies.map((policy) =>
      policyKey(policy.channelId, policy.memberId)
    )
    if (new Set(requestedKeys).size !== requestedKeys.length) {
      blocked('Channel human migration policy batch contains duplicates')
    }
    const at = safeNow(input.now ?? Date.now())
    const next = clone(this.snapshot)
    const applied: ChannelHumanPolicyRecord[] = []
    let changed = false
    for (const policy of input.policies) {
      const existing = next.policies.find(
        (record) => record.channelId === policy.channelId && record.memberId === policy.memberId
      )
      if (existing) {
        if (
          existing.migrationPlanId !== input.migrationPlanId ||
          canonicalJson(policyIdentity(existing)) !== canonicalJson(policyIdentity(policy))
        ) {
          blocked('Channel human migration policy conflicts with durable authority')
        }
        applied.push(existing)
        continue
      }
      const record: ChannelHumanPolicyRecord = {
        schemaVersion: CHANNEL_HUMAN_POLICY_SCHEMA_VERSION,
        migrationPlanId: input.migrationPlanId,
        ...clone(policy),
        createdAt: at,
        updatedAt: at
      }
      next.policies.push(record)
      applied.push(record)
      changed = true
    }
    if (changed) {
      next.policies.sort((left, right) =>
        policyKey(left.channelId, left.memberId).localeCompare(
          policyKey(right.channelId, right.memberId)
        )
      )
      this.persist(next)
      this.snapshot = next
    }
    return applied.map(clone)
  }

  evaluate(input: {
    channelId: string
    memberId: string
    intent: ChannelHumanContributionIntent
    contentBytes: number
  }): ChannelHumanPolicyDecision {
    const policy = this.get(input.channelId, input.memberId)
    if (!Number.isSafeInteger(input.contentBytes) || input.contentBytes < 1) {
      return {
        outcome: 'deny',
        code: 'quota_exceeded',
        message: 'Channel contribution size is invalid',
        policy
      }
    }
    const maximumBytes =
      policy?.rules.maxContributionBytes ??
      contributionRulesForPreset('comments').maxContributionBytes
    if (input.contentBytes > maximumBytes) {
      return {
        outcome: 'deny',
        code: 'quota_exceeded',
        message: policy
          ? 'Channel contribution exceeds the member policy limit'
          : 'Channel contribution exceeds the protocol limit',
        policy
      }
    }
    if (!policy) return { outcome: 'append', policy: null }
    if (
      policy.rules.allowedCollaboratorIds?.length &&
      !policy.rules.allowedCollaboratorIds.includes(policy.sourceCollaboratorId)
    ) {
      return {
        outcome: 'deny',
        code: 'rule_denied',
        message: 'Channel member is not allowed to contribute under this policy',
        policy
      }
    }
    if (input.intent === 'comment') {
      if (!policy.rules.appendComment) {
        return {
          outcome: 'deny',
          code: 'read_only',
          message: 'Channel member policy is read-only',
          policy
        }
      }
      return { outcome: policy.requiresHostApproval ? 'host_review' : 'append', policy }
    }
    if (!policy.rules.requestHostAction) {
      return {
        outcome: 'deny',
        code: 'rule_denied',
        message: 'Channel member policy does not allow host-action requests',
        policy
      }
    }
    return {
      outcome: policy.rules.createHostDraft === 'auto-draft' ? 'auto_draft' : 'host_review',
      policy
    }
  }

  purgeChannels(channelIds: readonly string[]): number {
    this.assertHealthy()
    const ids = new Set(channelIds)
    for (const channelId of ids) {
      if (!identifier(channelId)) blocked('Channel human policy identity is invalid')
    }
    const retained = this.snapshot.policies.filter((record) => !ids.has(record.channelId))
    const removed = this.snapshot.policies.length - retained.length
    if (removed === 0) return 0
    const next: ChannelHumanPolicySnapshot = {
      schemaVersion: CHANNEL_HUMAN_POLICY_SCHEMA_VERSION,
      policies: retained
    }
    this.persist(next)
    this.snapshot = next
    return removed
  }

  private load(): ChannelHumanPolicySnapshot {
    if (!this.storagePath || !existsSync(this.storagePath)) {
      return { schemaVersion: CHANNEL_HUMAN_POLICY_SCHEMA_VERSION, policies: [] }
    }
    try {
      const stat = lstatSync(this.storagePath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CHANNEL_HUMAN_POLICY_BYTES) {
        throw new Error('unsafe')
      }
      const bytes = readFileSync(this.storagePath)
      const parsed = parseSnapshot(JSON.parse(bytes.toString('utf8')))
      if (!parsed) throw new Error('invalid')
      return parsed
    } catch {
      this.recoveryBlocked = true
      return { schemaVersion: CHANNEL_HUMAN_POLICY_SCHEMA_VERSION, policies: [] }
    }
  }

  private persist(snapshot: ChannelHumanPolicySnapshot): void {
    if (!this.storagePath) return
    const bytes = Buffer.from(JSON.stringify(snapshot), 'utf8')
    if (bytes.length > MAX_CHANNEL_HUMAN_POLICY_BYTES) {
      blocked('Channel human policy store exceeds its byte bound')
    }
    mkdirSync(dirname(this.storagePath), { recursive: true })
    const temporary = `${this.storagePath}.${process.pid}.${randomUUID()}.tmp`
    let descriptor: number | null = null
    try {
      descriptor = openSync(temporary, 'wx', 0o600)
      writeFileSync(descriptor, bytes)
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = null
      renameSync(temporary, this.storagePath)
      this.syncDirectory()
    } catch (error) {
      if (descriptor !== null) {
        try {
          closeSync(descriptor)
        } catch {
          // Preserve the original persistence failure.
        }
      }
      if (existsSync(temporary)) {
        try {
          unlinkSync(temporary)
        } catch {
          // Preserve the original persistence failure.
        }
      }
      throw error
    }
  }

  private syncDirectory(): void {
    if (!this.storagePath) return
    try {
      const descriptor = openSync(dirname(this.storagePath), 'r')
      try {
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
    } catch {
      // Some supported platforms do not permit directory fsync.
    }
  }

  private assertHealthy(): void {
    if (this.recoveryBlocked) blocked('Channel human policy authority is recovery-blocked')
  }
}

export function ordinaryChannelHumanPolicy(): HumanContributionRules {
  return contributionRulesForPreset('comments')
}
