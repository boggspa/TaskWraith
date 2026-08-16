import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync
} from 'node:fs'
import { dirname, join } from 'node:path'

export const MISSION_FACT_SCHEMA_VERSION = 1 as const
export const MISSION_FACT_GENESIS_HASH = '0'.repeat(64)

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const MAX_ID_CHARS = 512
const MAX_OBJECTIVE_CHARS = 4_000
const MAX_REASON_CHARS = 800
const MAX_PLAN_TITLE_CHARS = 200
const MAX_PLAN_BODY_CHARS = 80_000
const MAX_WORK_ITEM_TITLE_CHARS = 500
const MAX_WORK_ITEM_BODY_CHARS = 4_000
const MAX_PATH_CHARS = 2_000

export type MissionStatus = 'active' | 'paused' | 'blocked' | 'completed' | 'cancelled' | 'failed'

export type MissionFactSurface = 'goal' | 'plan' | 'board' | 'orchestrator' | 'migration'
export type MissionFactActor = 'user' | 'agent' | 'system'

export interface MissionFactProvenance {
  readonly surface: MissionFactSurface
  readonly actor: MissionFactActor
  readonly sourceId?: string
  readonly chatId?: string
  readonly workspaceId?: string
  readonly roundId?: string
  readonly runId?: string
  readonly participantId?: string
  readonly provider?: string
}

export interface MissionPlanState {
  readonly planId: string
  readonly title: string
  readonly body: string
  readonly status: 'pending' | 'approved' | 'dismissed'
  readonly artifactPath?: string
}

export type MissionWorkItemStatus =
  | 'pending'
  | 'running'
  | 'needs-input'
  | 'blocked'
  | 'review-ready'
  | 'done'
  | 'archived'
  | 'cancelled'

export interface MissionWorkItemState {
  readonly workItemId: string
  readonly title: string
  readonly status: MissionWorkItemStatus
  readonly body?: string
  readonly blockedReason?: string
  readonly nextStep?: string
  readonly sortOrder?: number
  /** Stable legacy surface scope, for example a workspace-board id. */
  readonly sourceScopeId?: string
}

export type MissionFactPayload =
  | { readonly kind: 'mission_defined'; readonly objective: string }
  | { readonly kind: 'mission_objective_set'; readonly objective: string }
  | {
      readonly kind: 'mission_status_set'
      readonly status: MissionStatus
      readonly reason?: string
    }
  | { readonly kind: 'plan_set'; readonly plan: MissionPlanState }
  | { readonly kind: 'plan_cleared'; readonly planId?: string }
  | { readonly kind: 'work_item_upserted'; readonly item: MissionWorkItemState }
  | { readonly kind: 'work_item_removed'; readonly workItemId: string }

export interface MissionFactInput {
  readonly factId?: string
  readonly missionId: string
  readonly timestamp?: string
  readonly provenance: MissionFactProvenance
  readonly payload: MissionFactPayload
}

export interface MissionFactRecord {
  readonly schemaVersion: typeof MISSION_FACT_SCHEMA_VERSION
  readonly factId: string
  readonly missionId: string
  readonly sequence: number
  readonly previousHash: string
  readonly timestamp: string
  readonly provenance: MissionFactProvenance
  readonly payload: MissionFactPayload
  readonly hash: string
}

export interface MissionFactSourceStamp {
  readonly factId: string
  readonly sequence: number
  readonly timestamp: string
  readonly provenance: MissionFactProvenance
}

export interface MissionProjection {
  readonly schemaVersion: typeof MISSION_FACT_SCHEMA_VERSION
  readonly missionId: string
  readonly objective: string
  readonly status?: MissionStatus
  readonly statusReason?: string
  readonly plan?: MissionPlanState
  readonly workItems: readonly MissionWorkItemState[]
  readonly lastSequence: number
  readonly tailHash: string
  readonly sources: {
    readonly objective: MissionFactSourceStamp
    readonly status?: MissionFactSourceStamp
    readonly plan?: MissionFactSourceStamp
    readonly workItems: Readonly<Record<string, MissionFactSourceStamp>>
  }
}

export type MissionFactDiagnosticCode =
  | 'invalid-record'
  | 'mission-mismatch'
  | 'sequence-gap'
  | 'previous-hash-mismatch'
  | 'hash-mismatch'
  | 'duplicate-fact-id'
  | 'mission-not-defined'
  | 'mission-defined-twice'
  | 'torn-tail'

export interface MissionFactDiagnostic {
  readonly code: MissionFactDiagnosticCode
  readonly message: string
  readonly line?: number
  readonly sequence?: number
}

export interface MissionFactReplay {
  readonly records: readonly MissionFactRecord[]
  readonly projection: MissionProjection | null
  readonly valid: boolean
  readonly diagnostics: readonly MissionFactDiagnostic[]
}

export interface AppendMissionFactOptions {
  readonly expectedLastSequence?: number
}

export interface MissionFactLedgerOptions {
  readonly rootPath: string
  readonly now?: () => string
  readonly idFactory?: () => string
}

export class MissionFactSequenceConflictError extends Error {
  readonly code = 'mission_fact_sequence_conflict'

  constructor(
    readonly missionId: string,
    readonly expectedLastSequence: number,
    readonly actualLastSequence: number
  ) {
    super(
      `Mission "${missionId}" changed: expected sequence ${expectedLastSequence}, found ${actualLastSequence}.`
    )
    this.name = 'MissionFactSequenceConflictError'
  }
}

export class MissionFactLedgerCorruptError extends Error {
  readonly code = 'mission_fact_ledger_corrupt'

  constructor(
    readonly missionId: string,
    readonly diagnostics: readonly MissionFactDiagnostic[]
  ) {
    super(
      `Mission "${missionId}" ledger is invalid: ${diagnostics.map((item) => item.message).join('; ')}`
    )
    this.name = 'MissionFactLedgerCorruptError'
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const canonical: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) {
    if (record[key] !== undefined) canonical[key] = canonicalize(record[key])
  }
  return canonical
}

function hashUnsignedMissionFact(record: Omit<MissionFactRecord, 'hash'>): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(record)), 'utf8')
    .digest('hex')
}

export function hashMissionFactRecord(record: Omit<MissionFactRecord, 'hash'>): string {
  return hashUnsignedMissionFact(record)
}

function requiredText(value: unknown, label: string, maxChars: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  const normalized = value.trim()
  if (normalized.length > maxChars) throw new Error(`${label} exceeds ${maxChars} characters.`)
  return normalized
}

function optionalText(value: unknown, label: string, maxChars: number): string | undefined {
  if (value === undefined) return undefined
  return requiredText(value, label, maxChars)
}

function normalizedTimestamp(value: unknown, label: string): string {
  const timestamp = requiredText(value, label, 100)
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${label} must be an ISO timestamp.`)
  return new Date(timestamp).toISOString()
}

function normalizeProvenance(value: MissionFactProvenance): MissionFactProvenance {
  if (!value || typeof value !== 'object') throw new Error('Mission fact provenance is required.')
  const surfaces: readonly MissionFactSurface[] = [
    'goal',
    'plan',
    'board',
    'orchestrator',
    'migration'
  ]
  const actors: readonly MissionFactActor[] = ['user', 'agent', 'system']
  if (!surfaces.includes(value.surface)) throw new Error('Mission fact surface is invalid.')
  if (!actors.includes(value.actor)) throw new Error('Mission fact actor is invalid.')
  const normalized: MissionFactProvenance = { surface: value.surface, actor: value.actor }
  for (const key of [
    'sourceId',
    'chatId',
    'workspaceId',
    'roundId',
    'runId',
    'participantId',
    'provider'
  ] as const) {
    const text = optionalText(value[key], `Mission fact provenance ${key}`, MAX_ID_CHARS)
    if (text) Object.assign(normalized, { [key]: text })
  }
  return normalized
}

function normalizePlan(value: MissionPlanState): MissionPlanState {
  if (!value || typeof value !== 'object') throw new Error('Mission plan is required.')
  if (!['pending', 'approved', 'dismissed'].includes(value.status)) {
    throw new Error('Mission plan status is invalid.')
  }
  const artifactPath = optionalText(
    value.artifactPath,
    'Mission plan artifact path',
    MAX_PATH_CHARS
  )
  return {
    planId: requiredText(value.planId, 'Mission plan id', MAX_ID_CHARS),
    title: requiredText(value.title, 'Mission plan title', MAX_PLAN_TITLE_CHARS),
    body: requiredText(value.body, 'Mission plan body', MAX_PLAN_BODY_CHARS),
    status: value.status,
    ...(artifactPath ? { artifactPath } : {})
  }
}

function normalizeWorkItem(value: MissionWorkItemState): MissionWorkItemState {
  if (!value || typeof value !== 'object') throw new Error('Mission work item is required.')
  const statuses: readonly MissionWorkItemStatus[] = [
    'pending',
    'running',
    'needs-input',
    'blocked',
    'review-ready',
    'done',
    'archived',
    'cancelled'
  ]
  if (!statuses.includes(value.status)) throw new Error('Mission work item status is invalid.')
  const sortOrder = value.sortOrder
  if (sortOrder !== undefined && (!Number.isFinite(sortOrder) || sortOrder < 0)) {
    throw new Error('Mission work item sortOrder must be a non-negative number.')
  }
  const body = optionalText(value.body, 'Mission work item body', MAX_WORK_ITEM_BODY_CHARS)
  const blockedReason = optionalText(
    value.blockedReason,
    'Mission work item blocked reason',
    MAX_REASON_CHARS
  )
  const nextStep = optionalText(
    value.nextStep,
    'Mission work item next step',
    MAX_WORK_ITEM_BODY_CHARS
  )
  const sourceScopeId = optionalText(
    value.sourceScopeId,
    'Mission work item source scope',
    MAX_ID_CHARS
  )
  return {
    workItemId: requiredText(value.workItemId, 'Mission work item id', MAX_ID_CHARS),
    title: requiredText(value.title, 'Mission work item title', MAX_WORK_ITEM_TITLE_CHARS),
    status: value.status,
    ...(body ? { body } : {}),
    ...(blockedReason ? { blockedReason } : {}),
    ...(nextStep ? { nextStep } : {}),
    ...(sortOrder !== undefined ? { sortOrder } : {}),
    ...(sourceScopeId ? { sourceScopeId } : {})
  }
}

function normalizePayload(value: MissionFactPayload): MissionFactPayload {
  if (!value || typeof value !== 'object') throw new Error('Mission fact payload is required.')
  switch (value.kind) {
    case 'mission_defined':
    case 'mission_objective_set':
      return {
        kind: value.kind,
        objective: requiredText(value.objective, 'Mission objective', MAX_OBJECTIVE_CHARS)
      }
    case 'mission_status_set': {
      const statuses: readonly MissionStatus[] = [
        'active',
        'paused',
        'blocked',
        'completed',
        'cancelled',
        'failed'
      ]
      if (!statuses.includes(value.status)) throw new Error('Mission status is invalid.')
      const reason = optionalText(value.reason, 'Mission status reason', MAX_REASON_CHARS)
      return { kind: value.kind, status: value.status, ...(reason ? { reason } : {}) }
    }
    case 'plan_set':
      return { kind: value.kind, plan: normalizePlan(value.plan) }
    case 'plan_cleared': {
      const planId = optionalText(value.planId, 'Mission plan id', MAX_ID_CHARS)
      return { kind: value.kind, ...(planId ? { planId } : {}) }
    }
    case 'work_item_upserted':
      return { kind: value.kind, item: normalizeWorkItem(value.item) }
    case 'work_item_removed':
      return {
        kind: value.kind,
        workItemId: requiredText(value.workItemId, 'Mission work item id', MAX_ID_CHARS)
      }
    default:
      throw new Error('Mission fact kind is invalid.')
  }
}

function stamp(record: MissionFactRecord): MissionFactSourceStamp {
  return {
    factId: record.factId,
    sequence: record.sequence,
    timestamp: record.timestamp,
    provenance: record.provenance
  }
}

export function createMissionFactRecord(
  input: MissionFactInput,
  sequence: number,
  previousHash: string,
  options: { now?: () => string; idFactory?: () => string } = {}
): MissionFactRecord {
  const missionId = requiredText(input.missionId, 'Mission id', MAX_ID_CHARS)
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new Error('Mission fact sequence must be a positive integer.')
  }
  if (!SHA256_PATTERN.test(previousHash)) {
    throw new Error('Mission fact previousHash must be a lowercase SHA-256 digest.')
  }
  const factId = requiredText(
    input.factId || options.idFactory?.() || randomUUID(),
    'Mission fact id',
    MAX_ID_CHARS
  )
  const timestamp = normalizedTimestamp(
    input.timestamp || options.now?.() || new Date().toISOString(),
    'Mission fact timestamp'
  )
  const unsigned: Omit<MissionFactRecord, 'hash'> = {
    schemaVersion: MISSION_FACT_SCHEMA_VERSION,
    factId,
    missionId,
    sequence,
    previousHash,
    timestamp,
    provenance: normalizeProvenance(input.provenance),
    payload: normalizePayload(input.payload)
  }
  return { ...unsigned, hash: hashUnsignedMissionFact(unsigned) }
}

function recordShapeIsValid(value: unknown): value is MissionFactRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as MissionFactRecord
  if (
    record.schemaVersion !== MISSION_FACT_SCHEMA_VERSION ||
    typeof record.factId !== 'string' ||
    typeof record.missionId !== 'string' ||
    !Number.isInteger(record.sequence) ||
    record.sequence < 1 ||
    typeof record.previousHash !== 'string' ||
    typeof record.timestamp !== 'string' ||
    typeof record.hash !== 'string'
  ) {
    return false
  }
  try {
    const factId = requiredText(record.factId, 'Mission fact id', MAX_ID_CHARS)
    const missionId = requiredText(record.missionId, 'Mission id', MAX_ID_CHARS)
    const timestamp = normalizedTimestamp(record.timestamp, 'Mission fact timestamp')
    const provenance = normalizeProvenance(record.provenance)
    const payload = normalizePayload(record.payload)
    const allowedKeys = [
      'factId',
      'hash',
      'missionId',
      'payload',
      'previousHash',
      'provenance',
      'schemaVersion',
      'sequence',
      'timestamp'
    ]
    return (
      JSON.stringify(Object.keys(record).sort()) === JSON.stringify(allowedKeys) &&
      factId === record.factId &&
      missionId === record.missionId &&
      timestamp === record.timestamp &&
      JSON.stringify(canonicalize(provenance)) ===
        JSON.stringify(canonicalize(record.provenance)) &&
      JSON.stringify(canonicalize(payload)) === JSON.stringify(canonicalize(record.payload)) &&
      SHA256_PATTERN.test(record.previousHash) &&
      SHA256_PATTERN.test(record.hash)
    )
  } catch {
    return false
  }
}

export function parseMissionFactLine(line: string): MissionFactRecord | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const value = JSON.parse(trimmed) as unknown
    return recordShapeIsValid(value) ? value : null
  } catch {
    return null
  }
}

export function serializeMissionFactRecord(record: MissionFactRecord): string {
  return `${JSON.stringify(record)}\n`
}

export function replayMissionFacts(
  missionId: string,
  records: readonly MissionFactRecord[],
  initialDiagnostics: readonly MissionFactDiagnostic[] = []
): MissionFactReplay {
  const normalizedMissionId = requiredText(missionId, 'Mission id', MAX_ID_CHARS)
  const diagnostics: MissionFactDiagnostic[] = [...initialDiagnostics]
  const factIds = new Set<string>()
  let previousHash = MISSION_FACT_GENESIS_HASH

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    const expectedSequence = index + 1
    if (!recordShapeIsValid(record)) {
      diagnostics.push({
        code: 'invalid-record',
        message: `Fact ${expectedSequence} has an invalid shape.`,
        sequence: expectedSequence
      })
      continue
    }
    if (record.missionId !== normalizedMissionId) {
      diagnostics.push({
        code: 'mission-mismatch',
        message: `Fact ${record.sequence} belongs to mission "${record.missionId}".`,
        sequence: record.sequence
      })
    }
    if (record.sequence !== expectedSequence) {
      diagnostics.push({
        code: 'sequence-gap',
        message: `Expected sequence ${expectedSequence}, found ${record.sequence}.`,
        sequence: record.sequence
      })
    }
    if (record.previousHash !== previousHash) {
      diagnostics.push({
        code: 'previous-hash-mismatch',
        message: `Fact ${record.sequence} does not extend the prior hash.`,
        sequence: record.sequence
      })
    }
    const { hash, ...unsigned } = record
    if (hashUnsignedMissionFact(unsigned) !== hash) {
      diagnostics.push({
        code: 'hash-mismatch',
        message: `Fact ${record.sequence} hash does not match its content.`,
        sequence: record.sequence
      })
    }
    if (factIds.has(record.factId)) {
      diagnostics.push({
        code: 'duplicate-fact-id',
        message: `Fact id "${record.factId}" appears more than once.`,
        sequence: record.sequence
      })
    }
    factIds.add(record.factId)
    previousHash = record.hash
  }

  if (diagnostics.length > 0) {
    return { records: [...records], projection: null, valid: false, diagnostics }
  }
  if (records.length === 0) {
    return { records: [], projection: null, valid: true, diagnostics: [] }
  }

  const first = records[0]
  if (first.payload.kind !== 'mission_defined') {
    diagnostics.push({
      code: 'mission-not-defined',
      message: 'The first mission fact must define the mission.',
      sequence: first.sequence
    })
  }
  for (const record of records.slice(1)) {
    if (record.payload.kind === 'mission_defined') {
      diagnostics.push({
        code: 'mission-defined-twice',
        message: 'A mission can be defined only once.',
        sequence: record.sequence
      })
    }
  }
  if (diagnostics.length > 0) {
    return { records: [...records], projection: null, valid: false, diagnostics }
  }

  let objective = first.payload.kind === 'mission_defined' ? first.payload.objective : ''
  let objectiveSource = stamp(first)
  let status: MissionStatus | undefined
  let statusReason: string | undefined
  let statusSource: MissionFactSourceStamp | undefined
  let plan: MissionPlanState | undefined
  let planSource: MissionFactSourceStamp | undefined
  const workItems = new Map<string, MissionWorkItemState>()
  const workItemSources: Record<string, MissionFactSourceStamp> = Object.create(null)

  for (const record of records.slice(1)) {
    const payload = record.payload
    switch (payload.kind) {
      case 'mission_objective_set':
        objective = payload.objective
        objectiveSource = stamp(record)
        break
      case 'mission_status_set':
        status = payload.status
        statusReason = payload.reason
        statusSource = stamp(record)
        break
      case 'plan_set':
        plan = payload.plan
        planSource = stamp(record)
        break
      case 'plan_cleared':
        if (!payload.planId || payload.planId === plan?.planId) {
          plan = undefined
          planSource = stamp(record)
        }
        break
      case 'work_item_upserted':
        workItems.set(payload.item.workItemId, payload.item)
        workItemSources[payload.item.workItemId] = stamp(record)
        break
      case 'work_item_removed':
        workItems.delete(payload.workItemId)
        workItemSources[payload.workItemId] = stamp(record)
        break
      case 'mission_defined':
        break
    }
  }

  const orderedWorkItems = [...workItems.values()].sort(
    (left, right) =>
      (left.sortOrder ?? Number.MAX_SAFE_INTEGER) - (right.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
      left.workItemId.localeCompare(right.workItemId)
  )
  const tail = records[records.length - 1]
  const projection: MissionProjection = {
    schemaVersion: MISSION_FACT_SCHEMA_VERSION,
    missionId: normalizedMissionId,
    objective,
    ...(status ? { status } : {}),
    ...(statusReason ? { statusReason } : {}),
    ...(plan ? { plan } : {}),
    workItems: orderedWorkItems,
    lastSequence: tail.sequence,
    tailHash: tail.hash,
    sources: {
      objective: objectiveSource,
      ...(statusSource ? { status: statusSource } : {}),
      ...(planSource ? { plan: planSource } : {}),
      workItems: workItemSources
    }
  }
  return { records: [...records], projection, valid: true, diagnostics: [] }
}

export function appendMissionFactRecord(
  records: readonly MissionFactRecord[],
  input: MissionFactInput,
  options: AppendMissionFactOptions & { now?: () => string; idFactory?: () => string } = {}
): MissionFactRecord {
  const replay = replayMissionFacts(input.missionId, records)
  if (!replay.valid) throw new MissionFactLedgerCorruptError(input.missionId, replay.diagnostics)
  const actualLastSequence = replay.projection?.lastSequence ?? 0
  if (
    options.expectedLastSequence !== undefined &&
    options.expectedLastSequence !== actualLastSequence
  ) {
    throw new MissionFactSequenceConflictError(
      input.missionId,
      options.expectedLastSequence,
      actualLastSequence
    )
  }
  const record = createMissionFactRecord(
    input,
    actualLastSequence + 1,
    replay.projection?.tailHash ?? MISSION_FACT_GENESIS_HASH,
    options
  )
  const candidate = replayMissionFacts(input.missionId, [...records, record])
  if (!candidate.valid)
    throw new MissionFactLedgerCorruptError(input.missionId, candidate.diagnostics)
  return record
}

function ledgerFileName(missionId: string): string {
  const digest = createHash('sha256').update(missionId, 'utf8').digest('hex')
  return `mission-${digest}.jsonl`
}

function fsyncDirectory(path: string): void {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    fsyncSync(fd)
  } catch {
    // Some filesystems do not allow fsync on directories. The fact file itself
    // is still fsync'd; a later read remains fail-closed.
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export class MissionFactLedgerRepository {
  private readonly rootPath: string
  private readonly now: () => string
  private readonly idFactory: () => string

  constructor(options: MissionFactLedgerOptions) {
    this.rootPath = requiredText(options?.rootPath, 'Mission ledger root path', MAX_PATH_CHARS)
    this.now = options.now ?? (() => new Date().toISOString())
    this.idFactory = options.idFactory ?? (() => randomUUID())
  }

  read(missionId: string): MissionFactReplay {
    const normalizedMissionId = requiredText(missionId, 'Mission id', MAX_ID_CHARS)
    const filePath = join(this.rootPath, ledgerFileName(normalizedMissionId))
    if (!existsSync(filePath)) return replayMissionFacts(normalizedMissionId, [])
    const content = readFileSync(filePath, 'utf8')
    const diagnostics: MissionFactDiagnostic[] = []
    if (content && !content.endsWith('\n')) {
      diagnostics.push({
        code: 'torn-tail',
        message: 'Mission ledger does not end at a complete JSONL record.'
      })
    }
    const records: MissionFactRecord[] = []
    const lines = content.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (!line) continue
      const record = parseMissionFactLine(line)
      if (!record) {
        diagnostics.push({
          code: 'invalid-record',
          message: `Mission ledger line ${index + 1} is invalid.`,
          line: index + 1
        })
      } else {
        records.push(record)
      }
    }
    return replayMissionFacts(normalizedMissionId, records, diagnostics)
  }

  append(input: MissionFactInput, options: AppendMissionFactOptions = {}): MissionFactRecord {
    const replay = this.read(input.missionId)
    if (!replay.valid) throw new MissionFactLedgerCorruptError(input.missionId, replay.diagnostics)
    const record = appendMissionFactRecord(replay.records, input, {
      ...options,
      now: this.now,
      idFactory: this.idFactory
    })
    const directoryExisted = existsSync(this.rootPath)
    mkdirSync(this.rootPath, { recursive: true })
    if (!directoryExisted) fsyncDirectory(dirname(this.rootPath))
    const filePath = join(this.rootPath, ledgerFileName(record.missionId))
    const fileExisted = existsSync(filePath)
    const fd = openSync(filePath, 'a')
    try {
      writeSync(fd, serializeMissionFactRecord(record), undefined, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    if (!fileExisted) fsyncDirectory(this.rootPath)

    const verified = this.read(record.missionId)
    const tail = verified.records[verified.records.length - 1]
    if (!verified.valid || tail?.factId !== record.factId || tail.hash !== record.hash) {
      throw new MissionFactLedgerCorruptError(record.missionId, verified.diagnostics)
    }
    return record
  }
}
