import { createHash } from 'crypto'
import { existsSync, readFileSync, statSync } from 'fs'

import {
  contributionModeForRules,
  normalizeContributionRules,
  type HumanContributionRules
} from './HumanContributionRules'
import {
  normalizeDisplayName,
  type HumanCollaborationInvite,
  type HumanCollaborationShare,
  type HumanCollaborationSnapshot,
  type HumanCollaboratorParticipant
} from './HumanCollaborationStore'
import { isContactColorIndex } from './HumanCollaborationContactsStore'
import type { PeopleToChannelInventoryPeoplePort } from './PeopleToChannelMigrationInventory'

export const MAX_PEOPLE_MIGRATION_SOURCE_BYTES = 16 * 1024 * 1024

export class PeopleToChannelMigrationSourceError extends Error {
  readonly code = 'recovery_blocked'

  constructor(message: string) {
    super(message)
    this.name = 'PeopleToChannelMigrationSourceError'
  }
}

export interface PeopleToChannelMigrationSourceRead {
  path: string
  exists: boolean
  bytes: number
  fileSha256: string | null
  snapshot: HumanCollaborationSnapshot
}

const ROOT_KEYS = new Set(['shares'])
const SHARE_KEYS = new Set([
  'shareId',
  'chatId',
  'mode',
  'enabled',
  'createdAt',
  'updatedAt',
  'nextSequence',
  'participants',
  'invites',
  'idempotency',
  'contributionRules',
  'requiresHostApproval',
  'fullHistory'
])
const PARTICIPANT_KEYS = new Set([
  'collaboratorId',
  'displayName',
  'publicKeyId',
  'status',
  'joinedAt',
  'revokedAt',
  'seatOrder',
  'colorIndex',
  'seatDisabled'
])
const INVITE_KEYS = new Set([
  'inviteId',
  'tokenHash',
  'createdAt',
  'expiresAt',
  'consumedAt',
  'collaboratorId',
  'roomId'
])
const RULE_KEYS = new Set([
  'schemaVersion',
  'preset',
  'viewProjection',
  'appendComment',
  'requestHostAction',
  'createHostDraft',
  'providerDispatch',
  'maxContributionBytes',
  'rateLimitProfile',
  'allowedCollaboratorIds',
  'auditLevel'
])

function blocked(message: string): never {
  throw new PeopleToChannelMigrationSourceError(message)
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    blocked(`${label} is invalid`)
  }
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length > 0) blocked(`${label} has unsupported fields`)
}

function nonBlank(value: unknown, label: string, max = 512): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.trim() !== value ||
    value.length > max ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return code < 0x20 || code === 0x7f
    })
  ) {
    blocked(`${label} is invalid`)
  }
  return value
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) blocked(`${label} is invalid`)
  return value as number
}

function optionalTimestamp(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : timestamp(value, label)
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') blocked(`${label} is invalid`)
  return value
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

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))
}

function identityPublicKey(value: unknown): string {
  const encoded = nonBlank(value, 'People participant public key', 256)
  try {
    const raw = Buffer.from(encoded, 'base64')
    if (raw.length !== 32 || raw.toString('base64') !== encoded) throw new Error('invalid key')
  } catch {
    blocked('People participant public key is invalid')
  }
  return encoded
}

function contributionRules(value: unknown, mode: 'readOnly' | 'comments'): HumanContributionRules {
  const raw = objectRecord(value, 'People contribution rules')
  exactKeys(raw, RULE_KEYS, 'People contribution rules')
  const normalized = normalizeContributionRules(raw)
  if (!normalized || !sameJson(raw, normalized)) {
    blocked('People contribution rules require repair before migration')
  }
  if (contributionModeForRules(normalized) !== mode) {
    blocked('People contribution rules conflict with the legacy share mode')
  }
  return normalized
}

function participant(value: unknown): HumanCollaboratorParticipant {
  const raw = objectRecord(value, 'People participant')
  exactKeys(raw, PARTICIPANT_KEYS, 'People participant')
  const status = raw.status
  if (status !== 'pending' && status !== 'active' && status !== 'revoked') {
    blocked('People participant status is invalid')
  }
  const displayName = nonBlank(raw.displayName, 'People participant display name', 80)
  if (normalizeDisplayName(displayName) !== displayName) {
    blocked('People participant display name requires repair before migration')
  }
  const joinedAt = optionalTimestamp(raw.joinedAt, 'People participant joined time')
  const revokedAt = optionalTimestamp(raw.revokedAt, 'People participant revoked time')
  if (status === 'active' && joinedAt === undefined) {
    blocked('An active People participant has no joined time')
  }
  if ((status === 'revoked') !== (revokedAt !== undefined)) {
    blocked('People participant revocation state is inconsistent')
  }
  if (joinedAt !== undefined && revokedAt !== undefined && revokedAt < joinedAt) {
    blocked('People participant revocation predates admission')
  }
  if (
    raw.seatOrder !== undefined &&
    (!Number.isInteger(raw.seatOrder) ||
      (raw.seatOrder as number) < 0 ||
      (raw.seatOrder as number) > 4096)
  ) {
    blocked('People participant seat order is invalid')
  }
  if (raw.colorIndex !== undefined && !isContactColorIndex(raw.colorIndex)) {
    blocked('People participant color is invalid')
  }
  const seatDisabled = optionalBoolean(raw.seatDisabled, 'People participant disabled state')
  return {
    collaboratorId: nonBlank(raw.collaboratorId, 'People collaborator id'),
    displayName,
    publicKeyId: identityPublicKey(raw.publicKeyId),
    status,
    ...(joinedAt !== undefined ? { joinedAt } : {}),
    ...(revokedAt !== undefined ? { revokedAt } : {}),
    ...(raw.seatOrder !== undefined ? { seatOrder: raw.seatOrder as number } : {}),
    ...(raw.colorIndex !== undefined ? { colorIndex: raw.colorIndex as number } : {}),
    ...(seatDisabled === true ? { seatDisabled: true } : {})
  }
}

function invite(value: unknown): HumanCollaborationInvite {
  const raw = objectRecord(value, 'People invite')
  exactKeys(raw, INVITE_KEYS, 'People invite')
  const createdAt = timestamp(raw.createdAt, 'People invite creation time')
  const expiresAt = timestamp(raw.expiresAt, 'People invite expiry time')
  if (expiresAt <= createdAt) blocked('People invite expiry is invalid')
  const consumedAt = optionalTimestamp(raw.consumedAt, 'People invite consumption time')
  const collaboratorId =
    raw.collaboratorId === undefined
      ? undefined
      : nonBlank(raw.collaboratorId, 'People invite collaborator id')
  if (consumedAt !== undefined && collaboratorId === undefined) {
    blocked('A consumed People invite has no collaborator binding')
  }
  if (consumedAt !== undefined && (consumedAt < createdAt || consumedAt > expiresAt)) {
    blocked('People invite consumption time is inconsistent')
  }
  const roomId =
    raw.roomId === undefined ? undefined : nonBlank(raw.roomId, 'People invite room id')
  return {
    inviteId: nonBlank(raw.inviteId, 'People invite id'),
    tokenHash: nonBlank(raw.tokenHash, 'People invite token hash', 512),
    createdAt,
    expiresAt,
    ...(consumedAt !== undefined ? { consumedAt } : {}),
    ...(collaboratorId ? { collaboratorId } : {}),
    ...(roomId ? { roomId } : {})
  }
}

function idempotency(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  const raw = objectRecord(value, 'People idempotency map')
  const result: Record<string, string> = {}
  for (const [key, messageId] of Object.entries(raw)) {
    result[nonBlank(key, 'People idempotency key', 1_024)] = nonBlank(
      messageId,
      'People idempotency message id'
    )
  }
  return result
}

function share(value: unknown): HumanCollaborationShare {
  const raw = objectRecord(value, 'People share')
  exactKeys(raw, SHARE_KEYS, 'People share')
  if (raw.mode !== 'readOnly' && raw.mode !== 'comments') blocked('People share mode is invalid')
  if (typeof raw.enabled !== 'boolean') blocked('People share enabled state is invalid')
  if (!Number.isSafeInteger(raw.nextSequence) || (raw.nextSequence as number) < 1) {
    blocked('People share sequence is invalid')
  }
  if (!Array.isArray(raw.participants) || !Array.isArray(raw.invites)) {
    blocked('People share membership is invalid')
  }
  const participants = raw.participants.map(participant)
  const invites = raw.invites.map(invite)
  if (new Set(participants.map((entry) => entry.collaboratorId)).size !== participants.length) {
    blocked('People participant ids are duplicated')
  }
  if (new Set(participants.map((entry) => entry.publicKeyId)).size !== participants.length) {
    blocked('People participant identities are duplicated')
  }
  if (new Set(invites.map((entry) => entry.inviteId)).size !== invites.length) {
    blocked('People invite ids are duplicated')
  }
  const requiresHostApproval = optionalBoolean(raw.requiresHostApproval, 'People host-review state')
  const fullHistory = optionalBoolean(raw.fullHistory, 'People full-history state')
  const createdAt = timestamp(raw.createdAt, 'People share creation time')
  const updatedAt = timestamp(raw.updatedAt, 'People share update time')
  if (updatedAt < createdAt) blocked('People share update predates creation')
  return {
    shareId: nonBlank(raw.shareId, 'People share id'),
    chatId: nonBlank(raw.chatId, 'People share chat id'),
    mode: raw.mode,
    enabled: raw.enabled,
    createdAt,
    updatedAt,
    nextSequence: raw.nextSequence as number,
    participants,
    invites,
    idempotency: idempotency(raw.idempotency),
    ...(raw.contributionRules !== undefined
      ? { contributionRules: contributionRules(raw.contributionRules, raw.mode) }
      : {}),
    ...(requiresHostApproval === true ? { requiresHostApproval: true } : {}),
    ...(fullHistory === true ? { fullHistory: true } : {})
  }
}

function snapshot(value: unknown): HumanCollaborationSnapshot {
  const raw = objectRecord(value, 'People migration source')
  exactKeys(raw, ROOT_KEYS, 'People migration source')
  if (!Array.isArray(raw.shares)) blocked('People migration source has no share list')
  const shares = raw.shares.map(share)
  if (new Set(shares.map((entry) => entry.shareId)).size !== shares.length) {
    blocked('People share ids are duplicated')
  }
  return { shares }
}

/** Strict migration-only reader; unlike the legacy runtime store, corruption never means empty. */
export class PeopleToChannelMigrationSource implements PeopleToChannelInventoryPeoplePort {
  constructor(private readonly path: string) {}

  read(): PeopleToChannelMigrationSourceRead {
    if (!existsSync(this.path)) {
      return {
        path: this.path,
        exists: false,
        bytes: 0,
        fileSha256: null,
        snapshot: { shares: [] }
      }
    }
    let bytes: Buffer
    try {
      const stat = statSync(this.path)
      if (!stat.isFile() || stat.size > MAX_PEOPLE_MIGRATION_SOURCE_BYTES) {
        blocked('People migration source is not a bounded regular file')
      }
      bytes = readFileSync(this.path)
      if (bytes.length > MAX_PEOPLE_MIGRATION_SOURCE_BYTES) {
        blocked('People migration source is not a bounded regular file')
      }
    } catch (error) {
      if (error instanceof PeopleToChannelMigrationSourceError) throw error
      blocked('People migration source could not be read')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(bytes.toString('utf8'))
    } catch {
      blocked('People migration source is not valid JSON')
    }
    return {
      path: this.path,
      exists: true,
      bytes: bytes.length,
      fileSha256: createHash('sha256').update(bytes).digest('hex'),
      snapshot: snapshot(parsed)
    }
  }

  readMigrationSnapshot(): HumanCollaborationSnapshot {
    return this.read().snapshot
  }
}
