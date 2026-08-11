import { createHash, randomUUID } from 'crypto'
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
import { dirname, join, resolve } from 'path'

import {
  PEOPLE_TO_CHANNEL_CUTOVER_DECISIONS,
  PEOPLE_TO_CHANNEL_MIGRATION_PLAN_VERSION,
  type PeopleToChannelMigrationPlan
} from './PeopleToChannelMigrationPlan'
import {
  PeopleToChannelMigrationRecoveryError,
  PeopleToChannelMigrationRecoveryStore,
  peopleToChannelMigrationRecoveryPaths,
  type PeopleToChannelMigrationCutoverDecisions,
  type PeopleToChannelMigrationRecoveryRecord
} from './PeopleToChannelMigrationRecoveryStore'
import { RECORDED_PEOPLE_TO_CHANNEL_CUTOVER_DECISIONS } from './PeopleToChannelMigrationRecordedDecisions'
import { ChannelError, ChannelStore } from './ChannelStore'

export const PEOPLE_TO_CHANNEL_CUTOVER_MANIFEST_VERSION = 1
export const PEOPLE_TO_CHANNEL_CUTOVER_MANIFEST_FILENAME = 'cutover-soak.json'
export const MAX_PEOPLE_TO_CHANNEL_CUTOVER_MANIFEST_BYTES = 16 * 1024 * 1024
export const MAX_PEOPLE_TO_CHANNEL_CUTOVER_ROUTES = 100_000

export const PEOPLE_TO_CHANNEL_SOAK_POSTURE = Object.freeze({
  ordinaryChatAuthority: 'channels-primary-people-writable',
  workspaceBootstrapAuthority: 'people-retained-for-p5'
} as const)

export type PeopleToChannelCutoverRouteOrigin = 'general' | 'people' | 'general-and-people'

export interface PeopleToChannelCutoverRoute {
  chatId: string
  channelId: string
  origin: PeopleToChannelCutoverRouteOrigin
}

export interface PeopleToChannelCutoverManifest {
  schemaVersion: typeof PEOPLE_TO_CHANNEL_CUTOVER_MANIFEST_VERSION
  status: 'soak'
  planId: string
  planDigest: string
  sourceDigest: string
  channelStateDigest: string
  preparedAt: number
  decisions: PeopleToChannelMigrationCutoverDecisions
  peoplePosture: typeof PEOPLE_TO_CHANNEL_SOAK_POSTURE
  routes: PeopleToChannelCutoverRoute[]
}

export type PeopleToChannelCutoverCoordinatorStage = 'manifest_durable' | 'recovery_durable'

export interface PeopleToChannelMigrationCutoverCoordinatorOptions {
  userDataPath: string
  recovery: PeopleToChannelMigrationRecoveryStore
  channels: ChannelStore
  now?: () => number
  /** Test/observability seam invoked only after the named state is durable. */
  afterStage?: (stage: PeopleToChannelCutoverCoordinatorStage) => void
}

export interface PeopleToChannelMigrationCutoverAppliedResult {
  schemaVersion: typeof PEOPLE_TO_CHANNEL_CUTOVER_MANIFEST_VERSION
  phase: 'cutover_applied'
  planId: string
  cutoverStateDigest: string
  routes: PeopleToChannelCutoverRoute[]
  manifestWrittenThisRun: boolean
  recoveryAdvancedThisRun: boolean
  recovery: PeopleToChannelMigrationRecoveryRecord
}

export class PeopleToChannelMigrationCutoverCoordinatorError extends Error {
  readonly code = 'recovery_blocked'

  constructor(message: string) {
    super(message)
    this.name = 'PeopleToChannelMigrationCutoverCoordinatorError'
  }
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const ROOT_KEYS = new Set([
  'schemaVersion',
  'status',
  'planId',
  'planDigest',
  'sourceDigest',
  'channelStateDigest',
  'preparedAt',
  'decisions',
  'peoplePosture',
  'routes'
])
const DECISION_KEYS = new Set([
  'generalChatScope',
  'legacyProjectionHistory',
  'peopleRetirementTiming'
])
const POSTURE_KEYS = new Set(['ordinaryChatAuthority', 'workspaceBootstrapAuthority'])
const ROUTE_KEYS = new Set(['chatId', 'channelId', 'origin'])

function blocked(message: string): never {
  throw new PeopleToChannelMigrationCutoverCoordinatorError(message)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
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

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function exactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.size && keys.every((key) => expected.has(key))
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value)
}

function timestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
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

function decisionMatches(value: unknown): value is PeopleToChannelMigrationCutoverDecisions {
  const raw = objectRecord(value)
  return Boolean(
    raw &&
    exactKeys(raw, DECISION_KEYS) &&
    canonicalJson(raw) === canonicalJson(RECORDED_PEOPLE_TO_CHANNEL_CUTOVER_DECISIONS)
  )
}

function routeOrigin(value: unknown): value is PeopleToChannelCutoverRouteOrigin {
  return value === 'general' || value === 'people' || value === 'general-and-people'
}

function parseManifest(value: unknown): PeopleToChannelCutoverManifest | null {
  const raw = objectRecord(value)
  const posture = objectRecord(raw?.peoplePosture)
  if (
    !raw ||
    !exactKeys(raw, ROOT_KEYS) ||
    raw.schemaVersion !== PEOPLE_TO_CHANNEL_CUTOVER_MANIFEST_VERSION ||
    raw.status !== 'soak' ||
    !digest(raw.planId) ||
    !digest(raw.planDigest) ||
    !digest(raw.sourceDigest) ||
    !digest(raw.channelStateDigest) ||
    !timestamp(raw.preparedAt) ||
    !decisionMatches(raw.decisions) ||
    !posture ||
    !exactKeys(posture, POSTURE_KEYS) ||
    canonicalJson(posture) !== canonicalJson(PEOPLE_TO_CHANNEL_SOAK_POSTURE) ||
    !Array.isArray(raw.routes) ||
    raw.routes.length > MAX_PEOPLE_TO_CHANNEL_CUTOVER_ROUTES
  ) {
    return null
  }
  const routes: PeopleToChannelCutoverRoute[] = []
  for (const value of raw.routes) {
    const route = objectRecord(value)
    if (
      !route ||
      !exactKeys(route, ROUTE_KEYS) ||
      !identifier(route.chatId) ||
      !identifier(route.channelId) ||
      !routeOrigin(route.origin)
    ) {
      return null
    }
    routes.push({
      chatId: route.chatId,
      channelId: route.channelId,
      origin: route.origin
    })
  }
  const sorted = [...routes].sort((left, right) =>
    compareText(`${left.chatId}\u0000${left.channelId}`, `${right.chatId}\u0000${right.channelId}`)
  )
  if (
    canonicalJson(routes) !== canonicalJson(sorted) ||
    new Set(routes.map((route) => route.chatId)).size !== routes.length ||
    new Set(routes.map((route) => route.channelId)).size !== routes.length
  ) {
    return null
  }
  return {
    schemaVersion: PEOPLE_TO_CHANNEL_CUTOVER_MANIFEST_VERSION,
    status: 'soak',
    planId: raw.planId,
    planDigest: raw.planDigest,
    sourceDigest: raw.sourceDigest,
    channelStateDigest: raw.channelStateDigest,
    preparedAt: raw.preparedAt,
    decisions: clone(RECORDED_PEOPLE_TO_CHANNEL_CUTOVER_DECISIONS),
    peoplePosture: PEOPLE_TO_CHANNEL_SOAK_POSTURE,
    routes
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
    // Some supported platforms do not permit directory fsync.
  }
}

function manifestBytes(manifest: PeopleToChannelCutoverManifest): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

function readManifestBytes(path: string): Buffer | null {
  if (!existsSync(path)) return null
  try {
    const before = lstatSync(path)
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size > MAX_PEOPLE_TO_CHANNEL_CUTOVER_MANIFEST_BYTES ||
      (before.mode & 0o077) !== 0
    ) {
      blocked('People migration cutover manifest path is unsafe')
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
      blocked('People migration cutover manifest changed while being read')
    }
    return bytes
  } catch (error) {
    if (error instanceof PeopleToChannelMigrationCutoverCoordinatorError) throw error
    blocked('People migration cutover manifest could not be read')
  }
}

function persistManifest(path: string, bytes: Buffer): boolean {
  if (bytes.length > MAX_PEOPLE_TO_CHANNEL_CUTOVER_MANIFEST_BYTES) {
    blocked('People migration cutover manifest exceeds its byte bound')
  }
  const existing = readManifestBytes(path)
  if (existing) {
    if (!existing.equals(bytes)) blocked('People migration cutover manifest conflicts')
    return false
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const directory = lstatSync(dirname(path))
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    blocked('People migration cutover manifest directory is unsafe')
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
    linkSync(temporary, path)
    chmodSync(path, 0o600)
    syncDirectory(dirname(path))
    unlinkSync(temporary)
    syncDirectory(dirname(path))
    return true
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
    const raced = readManifestBytes(path)
    if (raced && raced.equals(bytes)) return false
    throw error instanceof PeopleToChannelMigrationCutoverCoordinatorError
      ? error
      : new PeopleToChannelMigrationCutoverCoordinatorError(
          'People migration cutover manifest could not be persisted'
        )
  }
}

export function peopleToChannelCutoverManifestPath(userDataPath: string): string {
  if (
    typeof userDataPath !== 'string' ||
    !userDataPath.trim() ||
    userDataPath.trim() !== userDataPath
  ) {
    blocked('People migration cutover manifest requires userDataPath')
  }
  const recoveryRoot = peopleToChannelMigrationRecoveryPaths(resolve(userDataPath)).root
  return join(recoveryRoot, PEOPLE_TO_CHANNEL_CUTOVER_MANIFEST_FILENAME)
}

/** Digest binding a durable cutover manifest to its recovery intent. */
export function peopleToChannelCutoverManifestDigest(
  manifest: PeopleToChannelCutoverManifest
): string {
  return sha256(canonicalJson(manifest))
}

export function loadPeopleToChannelCutoverManifest(
  userDataPath: string
): PeopleToChannelCutoverManifest | null {
  const bytes = readManifestBytes(peopleToChannelCutoverManifestPath(userDataPath))
  if (!bytes) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    blocked('People migration cutover manifest is malformed')
  }
  const manifest = parseManifest(parsed)
  if (!manifest || !manifestBytes(manifest).equals(bytes)) {
    blocked('People migration cutover manifest is invalid')
  }
  return clone(manifest)
}

interface RouteDraft {
  chatId: string
  channelId: string
  general: boolean
  people: boolean
}

function deriveRoutes(args: {
  plan: PeopleToChannelMigrationPlan
  recovery: PeopleToChannelMigrationRecoveryRecord
  channels: ChannelStore
}): PeopleToChannelCutoverRoute[] {
  const { plan, recovery, channels } = args
  if (
    plan.schemaVersion !== PEOPLE_TO_CHANNEL_MIGRATION_PLAN_VERSION ||
    !digest(plan.planId) ||
    !digest(plan.sourceDigest) ||
    recovery.planId !== plan.planId ||
    recovery.sourceDigest !== plan.sourceDigest ||
    recovery.planDigest !== sha256(canonicalJson(plan)) ||
    !digest(recovery.channelStateDigest) ||
    !decisionMatches(recovery.decisions) ||
    canonicalJson(plan.cutoverDecisions) !== canonicalJson(PEOPLE_TO_CHANNEL_CUTOVER_DECISIONS) ||
    !Array.isArray(plan.entries) ||
    !Array.isArray(plan.generalChats)
  ) {
    blocked('People migration cutover inputs do not match durable recovery')
  }

  const activeEntries = plan.entries.filter((entry) => entry.source.enabled)
  const retainedEntries = plan.entries.filter((entry) => !entry.source.enabled)
  if (
    activeEntries.some(
      (entry) =>
        (entry.disposition !== 'create' && entry.disposition !== 'merge') ||
        entry.blockers.length > 0 ||
        !entry.target
    ) ||
    retainedEntries.some(
      (entry) => entry.disposition !== 'retain_legacy' || entry.blockers.length > 0
    ) ||
    plan.generalChats.some(
      (entry) =>
        (entry.disposition !== 'create' &&
          entry.disposition !== 'existing' &&
          entry.disposition !== 'covered_by_people') ||
        entry.blockers.length > 0 ||
        !entry.target
    )
  ) {
    blocked('People migration cutover scope is not executable')
  }

  const drafts = new Map<string, RouteDraft>()
  const addRoute = (chatId: string, channelId: string, origin: 'general' | 'people'): void => {
    if (!identifier(chatId) || !identifier(channelId)) {
      blocked('People migration cutover route is invalid')
    }
    const existing = drafts.get(chatId)
    if (existing && existing.channelId !== channelId) {
      blocked('People migration cutover route has conflicting Channel authority')
    }
    const draft = existing ?? { chatId, channelId, general: false, people: false }
    draft[origin] = true
    drafts.set(chatId, draft)
  }

  for (const entry of activeEntries) {
    addRoute(entry.source.chatId, entry.target!.channelId, 'people')
  }
  for (const entry of plan.generalChats) {
    addRoute(entry.source.chatId, entry.target!.channelId, 'general')
  }

  if (drafts.size > MAX_PEOPLE_TO_CHANNEL_CUTOVER_ROUTES) {
    blocked('People migration cutover route count exceeds its bound')
  }
  const channelIds = new Set<string>()
  const currentChannels = channels.listChannels()
  const currentById = new Map(
    currentChannels.map((channel) => [channel.channelId, channel] as const)
  )
  const channelCountByChat = new Map<string, number>()
  for (const channel of currentChannels) {
    channelCountByChat.set(channel.chatId, (channelCountByChat.get(channel.chatId) ?? 0) + 1)
  }
  const routes = [...drafts.values()]
    .map((draft): PeopleToChannelCutoverRoute => {
      const channel = currentById.get(draft.channelId)
      if (
        !channel ||
        channel.chatId !== draft.chatId ||
        channel.status !== 'active' ||
        channelCountByChat.get(draft.chatId) !== 1 ||
        channelIds.has(channel.channelId)
      ) {
        blocked('People migration cutover Channel route is not durable')
      }
      channelIds.add(channel.channelId)
      return {
        chatId: draft.chatId,
        channelId: draft.channelId,
        origin:
          draft.general && draft.people
            ? 'general-and-people'
            : draft.general
              ? 'general'
              : 'people'
      }
    })
    .sort((left, right) =>
      compareText(
        `${left.chatId}\u0000${left.channelId}`,
        `${right.chatId}\u0000${right.channelId}`
      )
    )
  return routes
}

function expectedManifest(args: {
  plan: PeopleToChannelMigrationPlan
  recovery: PeopleToChannelMigrationRecoveryRecord
  channels: ChannelStore
}): PeopleToChannelCutoverManifest {
  return {
    schemaVersion: PEOPLE_TO_CHANNEL_CUTOVER_MANIFEST_VERSION,
    status: 'soak',
    planId: args.plan.planId,
    planDigest: args.recovery.planDigest,
    sourceDigest: args.plan.sourceDigest,
    channelStateDigest: args.recovery.channelStateDigest!,
    preparedAt: args.recovery.preparedAt,
    decisions: clone(args.recovery.decisions),
    peoplePosture: PEOPLE_TO_CHANNEL_SOAK_POSTURE,
    routes: deriveRoutes(args)
  }
}

/**
 * Establishes the additive P4 soak boundary. The Channel store remains the
 * sole chat-to-Channel mapping authority; this immutable manifest only pins
 * the migrated route set and the explicit policy that ordinary People sharing
 * stays writable until final acceptance. It never reads or mutates People.
 */
export class PeopleToChannelMigrationCutoverCoordinator {
  readonly manifestPath: string
  private readonly now: () => number

  constructor(private readonly options: PeopleToChannelMigrationCutoverCoordinatorOptions) {
    this.manifestPath = peopleToChannelCutoverManifestPath(options.userDataPath)
    this.now = options.now ?? Date.now
  }

  apply(args: {
    plan: PeopleToChannelMigrationPlan
  }): PeopleToChannelMigrationCutoverAppliedResult {
    const recoveryBefore = this.options.recovery.load()
    if (!recoveryBefore) blocked('People migration cutover recovery intent is missing')
    if (
      recoveryBefore.phase !== 'channels_applied' &&
      recoveryBefore.phase !== 'cutover_applied' &&
      recoveryBefore.phase !== 'finalizing' &&
      recoveryBefore.phase !== 'committed'
    ) {
      blocked('People migration cutover phase is out of order')
    }

    const manifest = expectedManifest({
      ...args,
      recovery: recoveryBefore,
      channels: this.options.channels
    })
    const bytes = manifestBytes(manifest)
    const cutoverStateDigest = sha256(canonicalJson(manifest))

    if (recoveryBefore.phase !== 'channels_applied') {
      const existing = loadPeopleToChannelCutoverManifest(this.options.userDataPath)
      if (
        !existing ||
        canonicalJson(existing) !== canonicalJson(manifest) ||
        recoveryBefore.cutoverStateDigest !== cutoverStateDigest
      ) {
        blocked('People migration durable cutover evidence changed')
      }
      return {
        schemaVersion: PEOPLE_TO_CHANNEL_CUTOVER_MANIFEST_VERSION,
        phase: 'cutover_applied',
        planId: manifest.planId,
        cutoverStateDigest,
        routes: manifest.routes.map(clone),
        manifestWrittenThisRun: false,
        recoveryAdvancedThisRun: false,
        recovery: clone(recoveryBefore)
      }
    }

    const manifestWrittenThisRun = persistManifest(this.manifestPath, bytes)
    this.options.afterStage?.('manifest_durable')
    const recovery = this.options.recovery.markCutoverApplied({
      planId: manifest.planId,
      cutoverStateDigest,
      now: this.now()
    })
    this.options.afterStage?.('recovery_durable')
    return {
      schemaVersion: PEOPLE_TO_CHANNEL_CUTOVER_MANIFEST_VERSION,
      phase: 'cutover_applied',
      planId: manifest.planId,
      cutoverStateDigest,
      routes: manifest.routes.map(clone),
      manifestWrittenThisRun,
      recoveryAdvancedThisRun: true,
      recovery
    }
  }
}

export function isPeopleToChannelMigrationCutoverCoordinatorError(
  error: unknown
): error is
  | PeopleToChannelMigrationCutoverCoordinatorError
  | PeopleToChannelMigrationRecoveryError
  | ChannelError {
  return (
    (error instanceof PeopleToChannelMigrationCutoverCoordinatorError ||
      error instanceof PeopleToChannelMigrationRecoveryError ||
      error instanceof ChannelError) &&
    error.code === 'recovery_blocked'
  )
}
