import { createHash, randomBytes, randomUUID } from 'crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { dirname } from 'path'

import type { HumanCollaborationSafeStorage } from './HumanCollaborationIdentityStore'
import { normalizeContributionRules } from './HumanContributionRules'
import {
  copyChannelMemberPresentation,
  isChannelMemberPresentation,
  type ChannelMemberPresentation
} from '../../shared/collaboration/ChannelMemberPresentation'
import {
  DEFAULT_CHANNEL_INVITE_TTL_MS,
  ChannelError,
  ChannelStore,
  hashChannelInviteToken,
  type ChannelInvite,
  type ChannelStoreMigrationMutation
} from './ChannelStore'
import { channelStoreSubsetDigest } from './ChannelStoreSubsetDigest'
import {
  PEOPLE_TO_CHANNEL_HISTORY_MATERIALIZATION_VERSION,
  type PeopleToChannelMigrationHistoryMaterialization
} from './PeopleToChannelMigrationHistory'
import {
  PEOPLE_TO_CHANNEL_MATERIALIZATION_VERSION,
  type PeopleToChannelMigrationMaterialization,
  type PeopleToChannelPendingAdmissionPolicy,
  type PeopleToChannelPendingAdmissionReissue
} from './PeopleToChannelMigrationMaterializer'

export const PEOPLE_TO_CHANNEL_ADMISSION_REISSUE_VERSION = 2
export const MAX_PEOPLE_TO_CHANNEL_REISSUES = 512
export const MAX_PEOPLE_TO_CHANNEL_REISSUE_ESCROW_BYTES = 4 * 1024 * 1024

export type PeopleToChannelReissuedAdmissionPurpose = 'pending-collaborator' | 'open-invite'

export interface PeopleToChannelReissuedAdmission {
  sourceShareId: string
  channelId: string
  purpose: PeopleToChannelReissuedAdmissionPurpose
  sourceCollaboratorId?: string
  /** Host-only recipient label, protected by the encrypted admission escrow. */
  recipientLabel?: string
  openInviteOrdinal?: number
  memberPresentation?: ChannelMemberPresentation
  policy: PeopleToChannelPendingAdmissionPolicy
  inviteId: string
  roomId: string
  inviteToken: string
  createdAt: number
  expiresAt: number
}

export interface PeopleToChannelAdmissionReissueResult {
  metadataApplied: boolean
  channelIds: string[]
  invitations: PeopleToChannelReissuedAdmission[]
  escrowDigest: string | null
}

export interface PeopleToChannelAdmissionEscrowResult {
  invitations: PeopleToChannelReissuedAdmission[]
  escrowDigest: string | null
}

export interface PeopleToChannelAdmissionReissueOptions {
  storagePath: string
  safeStorage: HumanCollaborationSafeStorage
  channels: ChannelStore
  now?: () => number
  randomToken?: () => string
  randomId?: () => string
  /** Test/observability seam invoked only after the encrypted escrow is durable. */
  afterEscrowDurable?: () => void
  /** Test/observability seam invoked only after Channel metadata is durable. */
  afterChannelApplied?: () => void
}

interface ReissueTask {
  sourceShareId: string
  channelId: string
  purpose: PeopleToChannelReissuedAdmissionPurpose
  sourceCollaboratorId?: string
  recipientLabel?: string
  openInviteOrdinal?: number
  memberPresentation?: ChannelMemberPresentation
  policy: PeopleToChannelPendingAdmissionPolicy
}

interface ReissuePayload {
  schemaVersion: typeof PEOPLE_TO_CHANNEL_ADMISSION_REISSUE_VERSION
  planId: string
  manifestDigest: string
  createdAt: number
  invitations: PeopleToChannelReissuedAdmission[]
}

interface PersistedReissueEscrow {
  schemaVersion: typeof PEOPLE_TO_CHANNEL_ADMISSION_REISSUE_VERSION
  planId: string
  manifestDigest: string
  payloadDigest: string
  encryptedPayload: string
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,200}$/
const OUTER_KEYS = new Set([
  'schemaVersion',
  'planId',
  'manifestDigest',
  'payloadDigest',
  'encryptedPayload'
])
const PAYLOAD_KEYS = new Set([
  'schemaVersion',
  'planId',
  'manifestDigest',
  'createdAt',
  'invitations'
])
const PENDING_POLICY_KEYS = new Set([
  'sourceDigest',
  'rules',
  'requiresHostApproval',
  'fullHistory'
])
const PENDING_INVITATION_KEYS = new Set([
  'sourceShareId',
  'channelId',
  'purpose',
  'sourceCollaboratorId',
  'recipientLabel',
  'policy',
  'inviteId',
  'roomId',
  'inviteToken',
  'createdAt',
  'expiresAt'
])
const PENDING_PRESENTATION_KEYS = new Set(['sourceCollaboratorId', 'presentation'])
const PENDING_LABEL_KEYS = new Set(['sourceCollaboratorId', 'recipientLabel'])
const OPEN_INVITATION_KEYS = new Set([
  'sourceShareId',
  'channelId',
  'purpose',
  'openInviteOrdinal',
  'policy',
  'inviteId',
  'roomId',
  'inviteToken',
  'createdAt',
  'expiresAt'
])

export class PeopleToChannelMigrationAdmissionReissueError extends Error {
  readonly code = 'recovery_blocked'

  constructor(message: string) {
    super(message)
    this.name = 'PeopleToChannelMigrationAdmissionReissueError'
  }
}

function blocked(message: string): never {
  throw new PeopleToChannelMigrationAdmissionReissueError(message)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function safeRecipientLabel(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 120) {
    return false
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => [key, canonicalize(entry)])
  )
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function exactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.size && keys.every((key) => expected.has(key))
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function safeTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function safeReissueTime(value: unknown): value is number {
  return (
    safeTimestamp(value) &&
    (value as number) <= Number.MAX_SAFE_INTEGER - DEFAULT_CHANNEL_INVITE_TTL_MS
  )
}

function safeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && SAFE_IDENTIFIER_PATTERN.test(value)
}

function strictPendingPolicy(value: unknown): PeopleToChannelPendingAdmissionPolicy | null {
  const raw = objectRecord(value)
  const normalized = normalizeContributionRules(raw?.rules)
  if (
    !raw ||
    !exactKeys(raw, PENDING_POLICY_KEYS) ||
    typeof raw.sourceDigest !== 'string' ||
    !SHA256_PATTERN.test(raw.sourceDigest) ||
    !normalized ||
    normalized.providerDispatch !== 'never' ||
    canonicalJson(normalized) !== canonicalJson(raw.rules) ||
    typeof raw.requiresHostApproval !== 'boolean' ||
    typeof raw.fullHistory !== 'boolean'
  ) {
    return null
  }
  return {
    sourceDigest: raw.sourceDigest,
    rules: clone(normalized),
    requiresHostApproval: raw.requiresHostApproval,
    fullHistory: raw.fullHistory
  }
}

function materializationDigest(materialization: PeopleToChannelMigrationMaterialization): string {
  const { materializationDigest: _recorded, ...withoutDigest } = materialization
  return sha256(canonicalJson(withoutDigest))
}

function historyExecutionDigest(history: PeopleToChannelMigrationHistoryMaterialization): string {
  const { executionDigest: _recorded, ...withoutDigest } = history
  return sha256(canonicalJson(withoutDigest))
}

function validateInputs(args: {
  base: PeopleToChannelMigrationMaterialization
  history: PeopleToChannelMigrationHistoryMaterialization
}): void {
  const { base, history } = args
  if (
    base.schemaVersion !== PEOPLE_TO_CHANNEL_MATERIALIZATION_VERSION ||
    history.schemaVersion !== PEOPLE_TO_CHANNEL_HISTORY_MATERIALIZATION_VERSION ||
    !SHA256_PATTERN.test(base.planId) ||
    !SHA256_PATTERN.test(base.sourceDigest) ||
    !SHA256_PATTERN.test(base.materializationDigest) ||
    materializationDigest(base) !== base.materializationDigest ||
    !SHA256_PATTERN.test(history.executionDigest) ||
    historyExecutionDigest(history) !== history.executionDigest ||
    history.planId !== base.planId ||
    history.sourceDigest !== base.sourceDigest ||
    history.baseMaterializationDigest !== base.materializationDigest
  ) {
    blocked('People migration admission inputs do not match')
  }
}

function reissueTasks(reissues: readonly PeopleToChannelPendingAdmissionReissue[]): ReissueTask[] {
  if (!Array.isArray(reissues) || reissues.length > MAX_PEOPLE_TO_CHANNEL_REISSUES) {
    blocked('People migration admission reissue count exceeds its bound')
  }
  const validated: Array<{
    sourceShareId: string
    channelId: string
    pendingCollaboratorIds: string[]
    pendingCollaboratorLabels: Array<{
      sourceCollaboratorId: string
      recipientLabel: string
    }>
    pendingMemberPresentations: Array<{
      sourceCollaboratorId: string
      presentation: ChannelMemberPresentation
    }>
    openInviteCount: number
    policy: PeopleToChannelPendingAdmissionPolicy
  }> = []
  for (const candidate of reissues as readonly unknown[]) {
    const reissue = objectRecord(candidate)
    const collaborators = reissue?.pendingCollaboratorIds
    const labels = reissue?.pendingCollaboratorLabels
    const presentations = reissue?.pendingMemberPresentations
    const policy = strictPendingPolicy(reissue?.policy)
    if (
      !reissue ||
      !safeIdentifier(reissue.sourceShareId) ||
      !safeIdentifier(reissue.channelId) ||
      !Array.isArray(collaborators) ||
      collaborators.length > MAX_PEOPLE_TO_CHANNEL_REISSUES ||
      collaborators.some((collaboratorId) => !safeIdentifier(collaboratorId)) ||
      !Array.isArray(labels) ||
      labels.length > MAX_PEOPLE_TO_CHANNEL_REISSUES ||
      !Array.isArray(presentations) ||
      presentations.length > MAX_PEOPLE_TO_CHANNEL_REISSUES ||
      !safeCount(reissue.openInviteCount) ||
      reissue.openInviteCount > MAX_PEOPLE_TO_CHANNEL_REISSUES ||
      !policy
    ) {
      blocked('People migration admission manifest is invalid')
    }
    const pendingCollaboratorLabels = labels.map((candidate) => {
      const entry = objectRecord(candidate)
      if (
        !entry ||
        !exactKeys(entry, PENDING_LABEL_KEYS) ||
        !safeIdentifier(entry.sourceCollaboratorId) ||
        !safeRecipientLabel(entry.recipientLabel)
      ) {
        blocked('People migration pending recipient label is invalid')
      }
      return {
        sourceCollaboratorId: entry.sourceCollaboratorId,
        recipientLabel: entry.recipientLabel
      }
    })
    const pendingMemberPresentations = presentations.map((candidate) => {
      const entry = objectRecord(candidate)
      if (
        !entry ||
        !exactKeys(entry, PENDING_PRESENTATION_KEYS) ||
        !safeIdentifier(entry.sourceCollaboratorId) ||
        !isChannelMemberPresentation(entry.presentation, { allowSeatDisabled: true })
      ) {
        blocked('People migration pending presentation manifest is invalid')
      }
      return {
        sourceCollaboratorId: entry.sourceCollaboratorId,
        presentation: copyChannelMemberPresentation(entry.presentation)
      }
    })
    validated.push({
      sourceShareId: reissue.sourceShareId,
      channelId: reissue.channelId,
      pendingCollaboratorIds: collaborators as string[],
      pendingCollaboratorLabels,
      pendingMemberPresentations,
      openInviteCount: reissue.openInviteCount,
      policy
    })
  }
  const shareIds = new Set<string>()
  const channelIds = new Set<string>()
  const tasks: ReissueTask[] = []
  for (const reissue of validated.sort((left, right) =>
    compareText(left.sourceShareId, right.sourceShareId)
  )) {
    if (shareIds.has(reissue.sourceShareId) || channelIds.has(reissue.channelId)) {
      blocked('People migration admission manifest is invalid')
    }
    shareIds.add(reissue.sourceShareId)
    channelIds.add(reissue.channelId)
    const collaborators = [...new Set(reissue.pendingCollaboratorIds)].sort(compareText)
    const labelByCollaborator = new Map(
      reissue.pendingCollaboratorLabels.map((entry) => [entry.sourceCollaboratorId, entry] as const)
    )
    const presentationByCollaborator = new Map(
      reissue.pendingMemberPresentations.map(
        (entry) => [entry.sourceCollaboratorId, entry] as const
      )
    )
    if (
      collaborators.length !== reissue.pendingCollaboratorIds.length ||
      labelByCollaborator.size !== reissue.pendingCollaboratorLabels.length ||
      reissue.pendingCollaboratorLabels.some(
        (entry) => !collaborators.includes(entry.sourceCollaboratorId)
      ) ||
      presentationByCollaborator.size !== reissue.pendingMemberPresentations.length ||
      reissue.pendingMemberPresentations.some(
        (entry) => !collaborators.includes(entry.sourceCollaboratorId)
      ) ||
      (collaborators.length === 0 && reissue.openInviteCount === 0)
    ) {
      blocked('People migration pending collaborator manifest is invalid')
    }
    if (
      tasks.length + collaborators.length + reissue.openInviteCount >
      MAX_PEOPLE_TO_CHANNEL_REISSUES
    ) {
      blocked('People migration admission reissue count exceeds its bound')
    }
    for (const sourceCollaboratorId of collaborators) {
      tasks.push({
        sourceShareId: reissue.sourceShareId,
        channelId: reissue.channelId,
        purpose: 'pending-collaborator',
        sourceCollaboratorId,
        recipientLabel: labelByCollaborator.get(sourceCollaboratorId)!.recipientLabel,
        ...(presentationByCollaborator.get(sourceCollaboratorId)
          ? {
              memberPresentation: copyChannelMemberPresentation(
                presentationByCollaborator.get(sourceCollaboratorId)!.presentation
              )
            }
          : {}),
        policy: clone(reissue.policy)
      })
    }
    for (let ordinal = 1; ordinal <= reissue.openInviteCount; ordinal += 1) {
      tasks.push({
        sourceShareId: reissue.sourceShareId,
        channelId: reissue.channelId,
        purpose: 'open-invite',
        openInviteOrdinal: ordinal,
        policy: clone(reissue.policy)
      })
    }
  }
  return tasks
}

function manifestDigest(args: {
  base: PeopleToChannelMigrationMaterialization
  history: PeopleToChannelMigrationHistoryMaterialization
  tasks: readonly ReissueTask[]
}): string {
  return sha256(
    canonicalJson({
      planId: args.base.planId,
      sourceDigest: args.base.sourceDigest,
      baseMaterializationDigest: args.base.materializationDigest,
      historyExecutionDigest: args.history.executionDigest,
      tasks: args.tasks
    })
  )
}

function admissionContext(args: {
  base: PeopleToChannelMigrationMaterialization
  history: PeopleToChannelMigrationHistoryMaterialization
}): { tasks: ReissueTask[]; expectedManifestDigest: string } {
  validateInputs(args)
  const tasks = reissueTasks(args.base.pendingAdmissionReissues)
  if (!Array.isArray(args.base.requirements)) {
    blocked('People migration admission requirement does not match its manifest')
  }
  const requirementCount = args.base.requirements.filter(
    (requirement) => requirement === 'pending_admission_reissue'
  ).length
  // Materialization v4 checkpoints created before invite-expiry reconciliation
  // may over-declare this requirement with an empty manifest. That state can
  // mint no authority and must remain recoverable; a non-empty manifest still
  // requires exactly one declaration, and duplicate declarations stay invalid.
  if (requirementCount > 1 || (tasks.length > 0 && requirementCount !== 1)) {
    blocked('People migration admission requirement does not match its manifest')
  }
  return { tasks, expectedManifestDigest: manifestDigest({ ...args, tasks }) }
}

function encryptionAvailable(safeStorage: HumanCollaborationSafeStorage): boolean {
  try {
    return safeStorage?.isEncryptionAvailable() === true
  } catch {
    return false
  }
}

function readEscrow(path: string): Buffer | null {
  if (!existsSync(path)) return null
  try {
    const before = lstatSync(path)
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size > MAX_PEOPLE_TO_CHANNEL_REISSUE_ESCROW_BYTES
    ) {
      blocked('People migration admission escrow path is unsafe')
    }
    const bytes = readFileSync(path)
    const after = lstatSync(path)
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.nlink !== 1 ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== bytes.length
    ) {
      blocked('People migration admission escrow changed while being read')
    }
    return bytes
  } catch (error) {
    if (error instanceof PeopleToChannelMigrationAdmissionReissueError) throw error
    blocked('People migration admission escrow could not be read')
  }
}

function syncDirectory(path: string): void {
  try {
    const descriptor = openSync(path, 'r')
    try {
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
  } catch {
    // Some supported platforms do not allow directory fsync.
  }
}

function persistEscrow(path: string, bytes: Buffer): void {
  if (bytes.length > MAX_PEOPLE_TO_CHANNEL_REISSUE_ESCROW_BYTES) {
    blocked('People migration admission escrow exceeds its byte bound')
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const directoryStat = lstatSync(dirname(path))
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    blocked('People migration admission escrow directory is unsafe')
  }
  chmodSync(dirname(path), 0o700)
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  let descriptor: number | null = null
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, bytes)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = null
    // A hard link gives us an atomic no-replace publication. A second runner
    // may mint a losing candidate, but it can never overwrite the escrow that
    // owns the restart-stable credentials.
    linkSync(temporary, path)
    chmodSync(path, 0o600)
    syncDirectory(dirname(path))
    unlinkSync(temporary)
    syncDirectory(dirname(path))
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
    throw error instanceof PeopleToChannelMigrationAdmissionReissueError
      ? error
      : new PeopleToChannelMigrationAdmissionReissueError(
          'People migration admission escrow could not be persisted'
        )
  }
}

function invitationMatchesTask(
  invitation: Record<string, unknown>,
  task: ReissueTask,
  createdAt: number
): boolean {
  const expectedKeys = new Set(
    task.purpose === 'pending-collaborator' ? PENDING_INVITATION_KEYS : OPEN_INVITATION_KEYS
  )
  if (task.memberPresentation) expectedKeys.add('memberPresentation')
  if (
    !exactKeys(invitation, expectedKeys) ||
    invitation.sourceShareId !== task.sourceShareId ||
    invitation.channelId !== task.channelId ||
    invitation.purpose !== task.purpose ||
    invitation.sourceCollaboratorId !== task.sourceCollaboratorId ||
    invitation.recipientLabel !== task.recipientLabel ||
    invitation.openInviteOrdinal !== task.openInviteOrdinal ||
    canonicalJson(invitation.memberPresentation) !== canonicalJson(task.memberPresentation) ||
    canonicalJson(invitation.policy) !== canonicalJson(task.policy) ||
    !safeIdentifier(invitation.inviteId) ||
    !safeIdentifier(invitation.roomId) ||
    typeof invitation.inviteToken !== 'string' ||
    !/^[A-Za-z0-9_-]{32}$/.test(invitation.inviteToken) ||
    invitation.createdAt !== createdAt ||
    invitation.expiresAt !== createdAt + DEFAULT_CHANNEL_INVITE_TTL_MS
  ) {
    return false
  }
  return true
}

function parsePayload(args: {
  plaintext: string
  planId: string
  expectedManifestDigest: string
  tasks: readonly ReissueTask[]
}): ReissuePayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(args.plaintext)
  } catch {
    blocked('People migration admission escrow payload is malformed')
  }
  const raw = objectRecord(parsed)
  if (
    !raw ||
    !exactKeys(raw, PAYLOAD_KEYS) ||
    raw.schemaVersion !== PEOPLE_TO_CHANNEL_ADMISSION_REISSUE_VERSION ||
    raw.planId !== args.planId ||
    raw.manifestDigest !== args.expectedManifestDigest ||
    !safeReissueTime(raw.createdAt) ||
    !Array.isArray(raw.invitations) ||
    raw.invitations.length !== args.tasks.length
  ) {
    blocked('People migration admission escrow payload is invalid')
  }
  const inviteIds = new Set<string>()
  const roomIds = new Set<string>()
  const tokenHashes = new Set<string>()
  const createdAt = raw.createdAt
  const invitations = raw.invitations.map((value, index) => {
    const invitation = objectRecord(value)
    if (!invitation || !invitationMatchesTask(invitation, args.tasks[index], createdAt)) {
      blocked('People migration admission escrow invitation is invalid')
    }
    const inviteId = invitation.inviteId as string
    const roomId = invitation.roomId as string
    const tokenHash = hashChannelInviteToken(invitation.inviteToken as string)
    if (inviteIds.has(inviteId) || roomIds.has(roomId) || tokenHashes.has(tokenHash)) {
      blocked('People migration admission escrow invitation is duplicated')
    }
    inviteIds.add(inviteId)
    roomIds.add(roomId)
    tokenHashes.add(tokenHash)
    return clone(invitation) as unknown as PeopleToChannelReissuedAdmission
  })
  return {
    schemaVersion: PEOPLE_TO_CHANNEL_ADMISSION_REISSUE_VERSION,
    planId: args.planId,
    manifestDigest: args.expectedManifestDigest,
    createdAt,
    invitations
  }
}

function encryptedEscrow(args: {
  payload: ReissuePayload
  safeStorage: HumanCollaborationSafeStorage
}): { bytes: Buffer; payloadDigest: string } {
  const plaintext = canonicalJson(args.payload)
  const payloadDigest = sha256(plaintext)
  let encrypted: Buffer
  try {
    encrypted = args.safeStorage.encryptString(plaintext)
  } catch {
    blocked('People migration admission escrow encryption failed')
  }
  if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
    blocked('People migration admission escrow encryption failed')
  }
  const persisted: PersistedReissueEscrow = {
    schemaVersion: PEOPLE_TO_CHANNEL_ADMISSION_REISSUE_VERSION,
    planId: args.payload.planId,
    manifestDigest: args.payload.manifestDigest,
    payloadDigest,
    encryptedPayload: encrypted.toString('base64')
  }
  return {
    bytes: Buffer.from(`${JSON.stringify(persisted, null, 2)}\n`, 'utf8'),
    payloadDigest
  }
}

function decryptEscrow(args: {
  bytes: Buffer
  safeStorage: HumanCollaborationSafeStorage
  planId: string
  expectedManifestDigest: string
  tasks: readonly ReissueTask[]
}): ReissuePayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(args.bytes.toString('utf8'))
  } catch {
    blocked('People migration admission escrow is malformed')
  }
  const raw = objectRecord(parsed)
  if (
    !raw ||
    !exactKeys(raw, OUTER_KEYS) ||
    raw.schemaVersion !== PEOPLE_TO_CHANNEL_ADMISSION_REISSUE_VERSION ||
    raw.planId !== args.planId ||
    raw.manifestDigest !== args.expectedManifestDigest ||
    typeof raw.payloadDigest !== 'string' ||
    !SHA256_PATTERN.test(raw.payloadDigest) ||
    typeof raw.encryptedPayload !== 'string' ||
    !raw.encryptedPayload
  ) {
    blocked('People migration admission escrow does not match')
  }
  const encryptedPayload = Buffer.from(raw.encryptedPayload, 'base64')
  if (
    encryptedPayload.length === 0 ||
    encryptedPayload.toString('base64') !== raw.encryptedPayload
  ) {
    blocked('People migration admission escrow ciphertext is malformed')
  }
  let plaintext: string
  try {
    plaintext = args.safeStorage.decryptString(encryptedPayload)
  } catch {
    blocked('People migration admission escrow could not be decrypted')
  }
  if (typeof plaintext !== 'string') {
    blocked('People migration admission escrow could not be decrypted')
  }
  if (sha256(plaintext) !== raw.payloadDigest) {
    blocked('People migration admission escrow payload digest does not match')
  }
  return parsePayload({
    plaintext,
    planId: args.planId,
    expectedManifestDigest: args.expectedManifestDigest,
    tasks: args.tasks
  })
}

function invitationsFor(args: {
  tasks: readonly ReissueTask[]
  planId: string
  manifestDigest: string
  createdAt: number
  randomToken: () => string
  randomId: () => string
}): ReissuePayload {
  const invitations = args.tasks.map(
    (task): PeopleToChannelReissuedAdmission => ({
      ...task,
      inviteId: args.randomId(),
      roomId: args.randomId(),
      inviteToken: args.randomToken(),
      createdAt: args.createdAt,
      expiresAt: args.createdAt + DEFAULT_CHANNEL_INVITE_TTL_MS
    })
  )
  return parsePayload({
    plaintext: canonicalJson({
      schemaVersion: PEOPLE_TO_CHANNEL_ADMISSION_REISSUE_VERSION,
      planId: args.planId,
      manifestDigest: args.manifestDigest,
      createdAt: args.createdAt,
      invitations
    }),
    planId: args.planId,
    expectedManifestDigest: args.manifestDigest,
    tasks: args.tasks
  })
}

function mutationsFor(args: {
  history: PeopleToChannelMigrationHistoryMaterialization
  invitations: readonly PeopleToChannelReissuedAdmission[]
}): ChannelStoreMigrationMutation[] {
  const metadataByChannel = new Map(
    args.history.metadataMutations.map(
      (mutation) => [mutation.channel.channelId, mutation] as const
    )
  )
  if (metadataByChannel.size !== args.history.metadataMutations.length) {
    blocked('People migration admission metadata target is duplicated')
  }
  const invitationChannelIds = new Set(args.invitations.map((invitation) => invitation.channelId))
  if ([...invitationChannelIds].some((channelId) => !metadataByChannel.has(channelId))) {
    blocked('People migration admission target metadata is missing')
  }
  return [...args.history.metadataMutations]
    .sort((left, right) => compareText(left.channel.channelId, right.channel.channelId))
    .map((metadata) => {
      const channelId = metadata.channel.channelId
      const invitations = args.invitations
        .filter((invitation) => invitation.channelId === channelId)
        .map(
          (invitation): ChannelInvite => ({
            inviteId: invitation.inviteId,
            channelId,
            roomId: invitation.roomId,
            tokenHash: hashChannelInviteToken(invitation.inviteToken),
            createdAt: invitation.createdAt,
            expiresAt: invitation.expiresAt,
            ...(invitation.memberPresentation
              ? {
                  memberPresentation: copyChannelMemberPresentation(invitation.memberPresentation)
                }
              : {})
          })
        )
      return {
        mode: metadata.mode,
        beforeDigest: metadata.beforeDigest,
        channel: clone(metadata.channel),
        members: metadata.members.map(clone),
        invites: [...metadata.invites.map(clone), ...invitations]
      }
    })
}

function preflightBeforeState(
  channels: ChannelStore,
  mutations: readonly ChannelStoreMigrationMutation[]
): void {
  const allInviteIds = new Set(
    channels
      .listChannels()
      .flatMap((channel) =>
        channels.listInvites(channel.channelId).map((invite) => invite.inviteId)
      )
  )
  const allRoomIds = new Set(
    channels
      .listChannels()
      .flatMap((channel) => [
        ...channels
          .listMembers(channel.channelId)
          .flatMap((member) => (member.roomId ? [member.roomId] : [])),
        ...channels.listInvites(channel.channelId).map((invite) => invite.roomId)
      ])
  )
  const allTokenHashes = new Set(
    channels
      .listChannels()
      .flatMap((channel) => channels.listInvites(channel.channelId))
      .map((invite) => invite.tokenHash)
  )
  for (const mutation of mutations) {
    const current = channels.getChannel(mutation.channel.channelId)
    const currentInvites = current ? channels.listInvites(current.channelId) : []
    const beforeMatches = current
      ? mutation.mode === 'merge' &&
        channelStoreSubsetDigest(
          current,
          channels.listMembers(current.channelId),
          currentInvites
        ) === mutation.beforeDigest
      : mutation.mode === 'create' && mutation.beforeDigest === null
    if (!beforeMatches) {
      blocked('People migration admission target changed before reissue')
    }
    const newInvites = mutation.invites.slice(currentInvites.length)
    for (const invite of newInvites) {
      if (
        allInviteIds.has(invite.inviteId) ||
        allRoomIds.has(invite.roomId) ||
        allTokenHashes.has(invite.tokenHash)
      ) {
        blocked('People migration admission identifier collides with Channel state')
      }
      allInviteIds.add(invite.inviteId)
      allRoomIds.add(invite.roomId)
      allTokenHashes.add(invite.tokenHash)
    }
  }
}

/**
 * Reissues only newly generated Channel credentials. The encrypted escrow is
 * durable before Channel metadata, so restart never copies an old People token,
 * loses a new token, or mints a second authority for the same pending admission.
 */
export class PeopleToChannelMigrationAdmissionReissue {
  private readonly now: () => number
  private readonly randomToken: () => string
  private readonly randomId: () => string

  constructor(private readonly options: PeopleToChannelAdmissionReissueOptions) {
    this.now = options.now ?? Date.now
    this.randomToken = options.randomToken ?? (() => randomBytes(24).toString('base64url'))
    this.randomId = options.randomId ?? randomUUID
  }

  recoverEscrow(args: {
    base: PeopleToChannelMigrationMaterialization
    history: PeopleToChannelMigrationHistoryMaterialization
  }): PeopleToChannelAdmissionEscrowResult {
    const { tasks, expectedManifestDigest } = admissionContext(args)
    const escrowBytes = readEscrow(this.options.storagePath)
    if (tasks.length === 0) {
      if (escrowBytes) blocked('People migration admission escrow exists without a manifest')
      return { invitations: [], escrowDigest: null }
    }
    if (
      !this.options.storagePath ||
      !this.options.storagePath.trim() ||
      !encryptionAvailable(this.options.safeStorage)
    ) {
      blocked('People migration admission escrow encryption is unavailable')
    }
    if (!escrowBytes) blocked('People migration admission escrow is missing')
    const payload = decryptEscrow({
      bytes: escrowBytes,
      safeStorage: this.options.safeStorage,
      planId: args.base.planId,
      expectedManifestDigest,
      tasks
    })
    return {
      invitations: payload.invitations.map(clone),
      escrowDigest: sha256(escrowBytes)
    }
  }

  apply(args: {
    base: PeopleToChannelMigrationMaterialization
    history: PeopleToChannelMigrationHistoryMaterialization
  }): PeopleToChannelAdmissionReissueResult {
    const { tasks, expectedManifestDigest } = admissionContext(args)
    if (tasks.length === 0) {
      if (readEscrow(this.options.storagePath)) {
        blocked('People migration admission escrow exists without a manifest')
      }
      return { metadataApplied: false, channelIds: [], invitations: [], escrowDigest: null }
    }
    if (
      !this.options.storagePath ||
      !this.options.storagePath.trim() ||
      !encryptionAvailable(this.options.safeStorage)
    ) {
      blocked('People migration admission escrow encryption is unavailable')
    }
    let escrowBytes = readEscrow(this.options.storagePath)
    let payload: ReissuePayload
    if (escrowBytes) {
      payload = decryptEscrow({
        bytes: escrowBytes,
        safeStorage: this.options.safeStorage,
        planId: args.base.planId,
        expectedManifestDigest,
        tasks
      })
    } else {
      const createdAt = this.now()
      if (!safeReissueTime(createdAt)) {
        blocked('People migration admission reissue time is invalid')
      }
      payload = invitationsFor({
        tasks,
        planId: args.base.planId,
        manifestDigest: expectedManifestDigest,
        createdAt,
        randomToken: this.randomToken,
        randomId: this.randomId
      })
      const candidateMutations = mutationsFor({
        history: args.history,
        invitations: payload.invitations
      })
      preflightBeforeState(this.options.channels, candidateMutations)
      const encrypted = encryptedEscrow({ payload, safeStorage: this.options.safeStorage })
      persistEscrow(this.options.storagePath, encrypted.bytes)
      escrowBytes = encrypted.bytes
      this.options.afterEscrowDurable?.()
    }

    const mutations = mutationsFor({ history: args.history, invitations: payload.invitations })
    const applied = this.options.channels.applyMigrationBatch(mutations)
    this.options.afterChannelApplied?.()
    return {
      metadataApplied: applied.applied,
      channelIds: applied.channelIds,
      invitations: payload.invitations.map(clone),
      escrowDigest: sha256(escrowBytes)
    }
  }
}

export function isPeopleToChannelAdmissionReissueError(
  error: unknown
): error is PeopleToChannelMigrationAdmissionReissueError | ChannelError {
  return (
    (error instanceof PeopleToChannelMigrationAdmissionReissueError ||
      error instanceof ChannelError) &&
    error.code === 'recovery_blocked'
  )
}
