import {
  closeSync,
  existsSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import {
  compileExecutionGraphRevision,
  deepFreezeExecutionGraph,
  stableExecutionGraphStringify
} from './ExecutionGraphCompiler'
import {
  type ExecutionGraphLayout,
  type ExecutionGraphRevision,
  type ExecutionGraphRevisionRef,
  type JsonObject,
  type JsonValue
} from './ExecutionGraphModel'
import {
  createExecutionRunEvent,
  foldExecutionRun,
  parseExecutionRunEventLine,
  serializeExecutionRunEvent,
  type ExecutionCreatedEvent,
  type ExecutionRunEvent,
  type ExecutionRunEventInput,
  type ExecutionRunProjection
} from './ExecutionGraphRun'

const REPOSITORY_SCHEMA_VERSION = 1 as const
const CANONICAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const RUN_TEMPLATE_PREFIX = 'run-template-'
const MAX_RUN_TEMPLATE_BYTES = 1_048_576
const MAX_LAYOUT_BYTES = 262_144
const MAX_LAYOUT_POSITIONS = 1_000

interface RevisionRegistry {
  readonly schemaVersion: 1
  readonly revisions: readonly ExecutionGraphRevision[]
}

interface ExecutionRegistryEntry {
  readonly schemaVersion: 1
  readonly executionId: string
  readonly fileName: string
  readonly createdAt: string
}

interface ExecutionRegistry {
  readonly schemaVersion: 1
  readonly executions: readonly ExecutionRegistryEntry[]
}

interface LayoutRegistry {
  readonly schemaVersion: 1
  readonly layouts: readonly ExecutionGraphLayout[]
}

export interface ExecutionGraphRunTemplate {
  readonly schemaVersion: 1
  readonly templateId: string
  readonly contentDigest: string
  readonly content: JsonObject
}

interface RunTemplateRegistry {
  readonly schemaVersion: 1
  readonly templates: readonly ExecutionGraphRunTemplate[]
}

export interface AppendExecutionEventOptions {
  /** Compare-and-append guard for callers acting on a previously folded projection. */
  readonly expectedLastSequence?: number
}

export class ExecutionGraphSequenceConflictError extends Error {
  readonly code = 'execution_graph_sequence_conflict'

  constructor(
    readonly executionId: string,
    readonly expectedLastSequence: number,
    readonly actualLastSequence: number
  ) {
    super(
      `Execution "${executionId}" changed: expected sequence ${expectedLastSequence}, found ${actualLastSequence}.`
    )
    this.name = 'ExecutionGraphSequenceConflictError'
  }
}

type ExecutionCreatedEventInput = Extract<
  ExecutionRunEventInput,
  { readonly kind: 'execution_created' }
>

interface ParsedLedger {
  readonly events: readonly ExecutionRunEvent[]
  readonly completeByteLength: number
  readonly observedByteLength: number
  readonly hasTornFinalFragment: boolean
}

interface CachedExecution {
  readonly events: readonly ExecutionRunEvent[]
  readonly projection: ExecutionRunProjection
  readonly completeByteLength: number
  readonly observedByteLength: number
  readonly hasTornFinalFragment: boolean
}

export interface ExecutionGraphRepositoryDiagnostic {
  readonly code: 'execution_ledger_missing' | 'execution_ledger_corrupt'
  readonly executionId: string
  readonly fileName: string
  readonly message: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value))
}

function assertCanonicalId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !CANONICAL_ID_PATTERN.test(value)) {
    throw new Error(
      `${label} must be a canonical id (1-128 ASCII letters, numbers, period, underscore, or hyphen).`
    )
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`)
  }
}

function cloneAndFreeze<T>(value: T): T {
  const cloned = JSON.parse(JSON.stringify(value)) as T
  return deepFreezeExecutionGraph(cloned) as T
}

function assertJsonValue(value: unknown, path = 'content', depth = 0): asserts value is JsonValue {
  if (depth > 64) throw new Error(`${path} exceeds the maximum JSON nesting depth.`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain only finite JSON numbers.`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${path}[${index}]`, depth + 1))
    return
  }
  if (!isRecord(value)) throw new Error(`${path} must contain only JSON values.`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} must contain plain JSON objects.`)
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new Error(`${path}.${key} is not an allowed JSON key.`)
    }
    assertJsonValue(entry, `${path}.${key}`, depth + 1)
  }
}

function assertRevisionRef(
  value: unknown,
  label = 'baseRevision'
): asserts value is ExecutionGraphRevisionRef {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error(`${label} is invalid.`)
  assertCanonicalId(value.graphId, `${label}.graphId`)
  if (!isPositiveInteger(value.revision)) throw new Error(`${label}.revision must be positive.`)
  const expectedRevisionId = `${value.graphId}@${value.revision}`
  if (value.revisionId !== expectedRevisionId) {
    throw new Error(`${label}.revisionId does not match its graph and revision.`)
  }
  assertDigest(value.definitionDigest, `${label}.definitionDigest`)
}

function validateRevision(value: unknown): ExecutionGraphRevision {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('Execution graph revision has an unsupported schema version.')
  }
  assertCanonicalId(value.graphId, 'revision.graphId')
  if (!isPositiveInteger(value.revision)) throw new Error('revision.revision must be positive.')
  if (value.revisionId !== `${value.graphId}@${value.revision}`) {
    throw new Error('revision.revisionId does not match its graph and revision.')
  }
  assertDigest(value.definitionDigest, 'revision.definitionDigest')
  const candidate = value as unknown as ExecutionGraphRevision
  const compiled = compileExecutionGraphRevision({
    graphId: candidate.graphId,
    revision: candidate.revision,
    workspaceId: candidate.workspaceId,
    name: candidate.name,
    ...(candidate.description ? { description: candidate.description } : {}),
    createdAt: candidate.createdAt,
    steps: candidate.steps,
    edges: candidate.edges,
    limits: candidate.limits
  })
  if (!compiled.ok) {
    throw new Error(
      `Execution graph revision is invalid: ${compiled.issues.map((issue) => issue.code).join(', ')}.`
    )
  }
  if (
    stableExecutionGraphStringify(compiled.revision) !== stableExecutionGraphStringify(candidate)
  ) {
    throw new Error('Execution graph revision is not canonical or its digest is corrupt.')
  }
  return cloneAndFreeze(compiled.revision)
}

function validateLayout(value: unknown, revision?: ExecutionGraphRevision): ExecutionGraphLayout {
  if (!isRecord(value) || value.schemaVersion !== 1)
    throw new Error('Execution graph layout is invalid.')
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new Error('Execution graph layout must be JSON serializable.')
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_LAYOUT_BYTES) {
    throw new Error('Execution graph layout exceeds the 256 KiB storage limit.')
  }
  assertCanonicalId(value.graphId, 'layout.graphId')
  if (!isPositiveInteger(value.revision)) throw new Error('layout.revision must be positive.')
  if (!isRecord(value.positions)) throw new Error('layout.positions must be an object.')
  const stepIds = revision ? new Set(revision.steps.map((step) => step.id)) : undefined
  const positions = Object.entries(value.positions)
  const positionLimit = Math.min(MAX_LAYOUT_POSITIONS, stepIds?.size ?? MAX_LAYOUT_POSITIONS)
  if (positions.length > positionLimit) {
    throw new Error(
      `Execution graph layout has ${positions.length} positions, above its ${positionLimit}-position limit.`
    )
  }
  for (const [stepId, position] of positions) {
    assertCanonicalId(stepId, 'layout position step id')
    if (stepIds && !stepIds.has(stepId))
      throw new Error(`Layout references unknown step "${stepId}".`)
    if (
      !isRecord(position) ||
      typeof position.x !== 'number' ||
      !Number.isFinite(position.x) ||
      typeof position.y !== 'number' ||
      !Number.isFinite(position.y)
    ) {
      throw new Error(`Layout position for "${stepId}" must contain finite x and y values.`)
    }
  }
  if (value.collapsedGroupIds !== undefined) {
    if (!Array.isArray(value.collapsedGroupIds))
      throw new Error('layout.collapsedGroupIds is invalid.')
    for (const groupId of value.collapsedGroupIds) assertCanonicalId(groupId, 'collapsed group id')
  }
  if (value.viewport !== undefined) {
    const viewport = value.viewport
    if (
      !isRecord(viewport) ||
      typeof viewport.x !== 'number' ||
      !Number.isFinite(viewport.x) ||
      typeof viewport.y !== 'number' ||
      !Number.isFinite(viewport.y) ||
      typeof viewport.zoom !== 'number' ||
      !Number.isFinite(viewport.zoom) ||
      viewport.zoom <= 0
    ) {
      throw new Error('layout.viewport is invalid.')
    }
  }
  return cloneAndFreeze(value as unknown as ExecutionGraphLayout)
}

function expectedLedgerFileName(executionId: string): string {
  assertCanonicalId(executionId, 'executionId')
  return `execution-${executionId}.jsonl`
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset)
    if (written <= 0) throw new Error('Unable to complete durable execution-graph write.')
    offset += written
  }
}

function fsyncDirectory(path: string): void {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    fsyncSync(fd)
  } catch {
    // Directory fsync is not supported by every platform/filesystem. File fsync + rename remains atomic.
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  let fd: number | undefined
  try {
    fd = openSync(tempPath, 'wx', 0o600)
    writeAll(fd, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'))
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tempPath, path)
    fsyncDirectory(dirname(path))
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    rmSync(tempPath, { force: true })
    throw error
  }
}

function readJson(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`Repository path is not a regular file: ${path}`)
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    throw new Error(`Execution-graph registry is corrupt: ${path}`)
  }
}

function validatePermissionCeilingRef(value: unknown): void {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('execution_created.permissionCeilingRef is invalid.')
  }
  if (!isNonEmptyString(value.referenceId) || !isNonEmptyString(value.authorityDigest)) {
    throw new Error('execution_created.permissionCeilingRef is missing authoritative identity.')
  }
  if (value.workspaceId !== undefined && !isNonEmptyString(value.workspaceId)) {
    throw new Error('execution_created.permissionCeilingRef.workspaceId is invalid.')
  }
}

const EXECUTION_STATES = new Set([
  'pending',
  'running',
  'waiting',
  'requires_action',
  'succeeded',
  'failed',
  'cancelled'
])
const ACTIVATION_STATES = new Set([
  'dormant',
  'ready',
  'claimed',
  'queued',
  'running',
  'waiting_input',
  'waiting_approval',
  'waiting_retry',
  'requires_action',
  'succeeded',
  'failed',
  'cancelled',
  'skipped'
])
const ATTEMPT_STATES = new Set([
  'created',
  'claimed',
  'queued',
  'running',
  'waiting_input',
  'waiting_approval',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted'
])

function validateEventEnvelope(
  event: ExecutionRunEvent,
  executionId: string,
  sequence: number
): void {
  assertCanonicalId(event.executionId, 'event.executionId')
  if (event.executionId !== executionId)
    throw new Error('Ledger event executionId does not match its file.')
  if (event.sequence !== sequence) {
    throw new Error(`Execution ledger sequence is not contiguous at ${sequence}.`)
  }
  if (event.eventId !== `${executionId}:${sequence}`) {
    throw new Error(`Execution ledger eventId is corrupt at sequence ${sequence}.`)
  }
  if (!isTimestamp(event.timestamp))
    throw new Error(`Execution ledger timestamp is invalid at ${sequence}.`)

  switch (event.kind) {
    case 'execution_created': {
      if (
        sequence !== 1 ||
        !isNonEmptyString(event.title) ||
        !isNonEmptyString(event.workspaceId)
      ) {
        throw new Error('execution_created is missing required authoritative fields.')
      }
      if (
        !isRecord(event.tenant) ||
        !['stack', 'workflow', 'audit', 'ensemble'].includes(String(event.tenant.kind)) ||
        (event.tenant.tenantId !== undefined && !isNonEmptyString(event.tenant.tenantId))
      ) {
        throw new Error('execution_created.tenant is invalid.')
      }
      if (event.rootChatId !== undefined && !isNonEmptyString(event.rootChatId)) {
        throw new Error('execution_created.rootChatId is invalid.')
      }
      if (event.anchorRunRef !== undefined && !isNonEmptyString(event.anchorRunRef)) {
        throw new Error('execution_created.anchorRunRef is invalid.')
      }
      if (event.baseRevision !== undefined) assertRevisionRef(event.baseRevision)
      validatePermissionCeilingRef(event.permissionCeilingRef)
      break
    }
    case 'step_appended':
      if (
        !isRecord(event.append) ||
        event.append.appendedBy !== 'user' ||
        !isRecord(event.append.step) ||
        !Array.isArray(event.append.incomingEdges)
      ) {
        throw new Error('step_appended payload is invalid.')
      }
      assertCanonicalId(event.append.step.id, 'step_appended.step.id')
      assertDigest(event.previousTopologyDigest, 'step_appended.previousTopologyDigest')
      assertDigest(event.topologyDigest, 'step_appended.topologyDigest')
      break
    case 'activation_created':
      assertCanonicalId(event.activationId, 'activation_created.activationId')
      assertCanonicalId(event.stepId, 'activation_created.stepId')
      break
    case 'activation_state_changed':
      assertCanonicalId(event.activationId, 'activation_state_changed.activationId')
      if (!ACTIVATION_STATES.has(event.state)) throw new Error('Invalid activation state.')
      if (event.retryAt !== undefined && !isTimestamp(event.retryAt))
        throw new Error('Invalid retryAt.')
      break
    case 'attempt_created':
      assertCanonicalId(event.attemptId, 'attempt_created.attemptId')
      assertCanonicalId(event.activationId, 'attempt_created.activationId')
      assertCanonicalId(event.stepId, 'attempt_created.stepId')
      if (!isPositiveInteger(event.ordinal)) throw new Error('Invalid attempt ordinal.')
      break
    case 'attempt_state_changed':
      assertCanonicalId(event.attemptId, 'attempt_state_changed.attemptId')
      if (!ATTEMPT_STATES.has(event.state)) throw new Error('Invalid attempt state.')
      if (event.result !== undefined) {
        if (
          !isRecord(event.result) ||
          event.result.schemaVersion !== 1 ||
          !Array.isArray(event.result.artifactRefs)
        ) {
          throw new Error('Invalid attempt result.')
        }
        if (event.result.output !== undefined) {
          assertJsonValue(event.result.output, 'attempt result output')
        }
        for (const artifact of event.result.artifactRefs) {
          if (
            !isRecord(artifact) ||
            artifact.schemaVersion !== 1 ||
            !isNonEmptyString(artifact.id) ||
            !isNonEmptyString(artifact.createdByAttemptId) ||
            !isNonEmptyString(artifact.trust)
          ) {
            throw new Error('Invalid attempt result artifact reference.')
          }
        }
      }
      break
    case 'execution_state_changed':
      if (!EXECUTION_STATES.has(event.state)) throw new Error('Invalid execution state.')
      break
  }
}

/**
 * Main-owned, synchronous single-writer repository for the execution graph kernel.
 * Registry snapshots are atomically replaced; execution histories are only ever appended.
 */
export class ExecutionGraphRepository {
  private readonly root: string
  private readonly ledgersDirectory: string
  private readonly revisionsPath: string
  private readonly executionsPath: string
  private readonly layoutsPath: string
  private readonly templatesPath: string
  private revisions: ExecutionGraphRevision[]
  private executions: ExecutionRegistryEntry[]
  private layouts: ExecutionGraphLayout[]
  private templates: ExecutionGraphRunTemplate[]
  private readonly executionCache = new Map<string, CachedExecution>()
  private readonly repositoryDiagnostics = new Map<string, ExecutionGraphRepositoryDiagnostic>()

  constructor(storageRoot: string) {
    if (!isNonEmptyString(storageRoot)) throw new Error('Execution graph storage root is required.')
    this.root = resolve(storageRoot)
    this.ledgersDirectory = join(this.root, 'execution-graph-ledgers-v1')
    this.revisionsPath = join(this.root, 'execution-graph-revisions-v1.json')
    this.executionsPath = join(this.root, 'execution-graph-executions-v1.json')
    this.layoutsPath = join(this.root, 'execution-graph-layouts-v1.json')
    this.templatesPath = join(this.root, 'execution-graph-templates-v1.json')
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    mkdirSync(this.ledgersDirectory, { recursive: true, mode: 0o700 })
    this.templates = this.loadTemplateRegistry()
    this.revisions = this.loadRevisionRegistry()
    this.assertRevisionRunTemplates(this.revisions)
    this.executions = this.loadExecutionRegistry()
    this.layouts = this.loadLayoutRegistry()
  }

  saveRevision(revision: ExecutionGraphRevision): ExecutionGraphRevision {
    const validated = validateRevision(revision)
    this.assertRevisionRunTemplates([validated])
    const existing = this.revisions.find(
      (entry) => entry.graphId === validated.graphId && entry.revision === validated.revision
    )
    if (existing) {
      if (stableExecutionGraphStringify(existing) !== stableExecutionGraphStringify(validated)) {
        throw new Error(`Execution graph revision ${validated.revisionId} is immutable.`)
      }
      return existing
    }
    if (this.revisions.some((entry) => entry.revisionId === validated.revisionId)) {
      throw new Error(
        `Execution graph revision identity ${validated.revisionId} is already in use.`
      )
    }
    const next = [...this.revisions, validated].sort(
      (a, b) => a.graphId.localeCompare(b.graphId) || a.revision - b.revision
    )
    atomicWriteJson(this.revisionsPath, {
      schemaVersion: REPOSITORY_SCHEMA_VERSION,
      revisions: next
    } satisfies RevisionRegistry)
    this.revisions = next
    return validated
  }

  getRevision(graphId: string, revision: number): ExecutionGraphRevision | undefined {
    assertCanonicalId(graphId, 'graphId')
    if (!isPositiveInteger(revision)) throw new Error('revision must be a positive integer.')
    return this.revisions.find((entry) => entry.graphId === graphId && entry.revision === revision)
  }

  getRevisionByRef(ref: ExecutionGraphRevisionRef): ExecutionGraphRevision | undefined {
    assertRevisionRef(ref)
    const revision = this.getRevision(ref.graphId, ref.revision)
    if (!revision) return undefined
    if (
      revision.revisionId !== ref.revisionId ||
      revision.definitionDigest !== ref.definitionDigest
    ) {
      throw new Error(`Pinned execution graph revision ${ref.revisionId} has a digest mismatch.`)
    }
    return revision
  }

  listRevisions(graphId?: string): readonly ExecutionGraphRevision[] {
    if (graphId !== undefined) assertCanonicalId(graphId, 'graphId')
    return this.revisions.filter((entry) => graphId === undefined || entry.graphId === graphId)
  }

  saveRunTemplate(content: JsonObject): ExecutionGraphRunTemplate {
    assertJsonValue(content)
    if (Array.isArray(content) || content === null)
      throw new Error('Run template content must be a JSON object.')
    const canonicalContent = cloneAndFreeze(content)
    const canonical = stableExecutionGraphStringify(canonicalContent)
    if (Buffer.byteLength(canonical, 'utf8') > MAX_RUN_TEMPLATE_BYTES) {
      throw new Error('Run template content exceeds the 1 MiB authority-record limit.')
    }
    const contentDigest = createHash('sha256').update(canonical).digest('hex')
    const templateId = `${RUN_TEMPLATE_PREFIX}${contentDigest}`
    const existing = this.templates.find((entry) => entry.templateId === templateId)
    if (existing) return existing
    const record = cloneAndFreeze({
      schemaVersion: REPOSITORY_SCHEMA_VERSION,
      templateId,
      contentDigest,
      content: canonicalContent
    } satisfies ExecutionGraphRunTemplate)
    const next = [...this.templates, record].sort((a, b) =>
      a.templateId.localeCompare(b.templateId)
    )
    atomicWriteJson(this.templatesPath, {
      schemaVersion: REPOSITORY_SCHEMA_VERSION,
      templates: next
    } satisfies RunTemplateRegistry)
    this.templates = next
    return record
  }

  getRunTemplate(templateId: string): ExecutionGraphRunTemplate | undefined {
    this.assertRunTemplateId(templateId)
    return this.templates.find((entry) => entry.templateId === templateId)
  }

  listRunTemplates(): readonly ExecutionGraphRunTemplate[] {
    return [...this.templates]
  }

  saveLayout(layout: ExecutionGraphLayout): ExecutionGraphLayout {
    assertCanonicalId(layout?.graphId, 'layout.graphId')
    const revision = this.getRevision(layout.graphId, layout.revision)
    if (!revision)
      throw new Error(
        `Cannot save layout for unknown revision ${layout.graphId}@${layout.revision}.`
      )
    const validated = validateLayout(layout, revision)
    const next = this.layouts.filter(
      (entry) => !(entry.graphId === validated.graphId && entry.revision === validated.revision)
    )
    next.push(validated)
    next.sort((a, b) => a.graphId.localeCompare(b.graphId) || a.revision - b.revision)
    atomicWriteJson(this.layoutsPath, {
      schemaVersion: REPOSITORY_SCHEMA_VERSION,
      layouts: next
    } satisfies LayoutRegistry)
    this.layouts = next
    return validated
  }

  getLayout(graphId: string, revision: number): ExecutionGraphLayout | undefined {
    assertCanonicalId(graphId, 'graphId')
    if (!isPositiveInteger(revision)) throw new Error('revision must be a positive integer.')
    return this.layouts.find((entry) => entry.graphId === graphId && entry.revision === revision)
  }

  listLayouts(graphId?: string): readonly ExecutionGraphLayout[] {
    if (graphId !== undefined) assertCanonicalId(graphId, 'graphId')
    return this.layouts.filter((entry) => graphId === undefined || entry.graphId === graphId)
  }

  createExecution(input: ExecutionCreatedEventInput): ExecutionRunProjection {
    if (input.kind !== 'execution_created')
      throw new Error('createExecution requires execution_created.')
    assertCanonicalId(input.executionId, 'executionId')
    if (this.executions.some((entry) => entry.executionId === input.executionId)) {
      throw new Error(`Execution "${input.executionId}" already exists.`)
    }
    const fileName = expectedLedgerFileName(input.executionId)
    const path = join(this.ledgersDirectory, fileName)
    if (existsSync(path))
      throw new Error(`Execution ledger already exists for "${input.executionId}".`)
    const event = createExecutionRunEvent(input, 1) as ExecutionCreatedEvent
    validateEventEnvelope(event, input.executionId, 1)
    const baseRevision = event.baseRevision
      ? this.requireRevisionByRef(event.baseRevision)
      : undefined
    const projection = foldExecutionRun(input.executionId, [event], { baseRevision })
    if (projection.integrity !== 'valid') {
      throw new Error(
        `Cannot create invalid execution: ${projection.diagnostics.map((entry) => entry.code).join(', ')}.`
      )
    }

    let fd: number | undefined
    let createdLedger = false
    try {
      fd = openSync(path, 'wx', 0o600)
      createdLedger = true
      writeAll(fd, Buffer.from(serializeExecutionRunEvent(event), 'utf8'))
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      fsyncDirectory(this.ledgersDirectory)
      const entry: ExecutionRegistryEntry = {
        schemaVersion: REPOSITORY_SCHEMA_VERSION,
        executionId: input.executionId,
        fileName,
        createdAt: event.timestamp
      }
      const next = [...this.executions, entry].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt)
      )
      atomicWriteJson(this.executionsPath, {
        schemaVersion: REPOSITORY_SCHEMA_VERSION,
        executions: next
      } satisfies ExecutionRegistry)
      this.executions = next
      const serialized = serializeExecutionRunEvent(event)
      this.executionCache.set(input.executionId, {
        events: Object.freeze([event]),
        projection,
        completeByteLength: Buffer.byteLength(serialized, 'utf8'),
        observedByteLength: Buffer.byteLength(serialized, 'utf8'),
        hasTornFinalFragment: false
      })
      this.repositoryDiagnostics.delete(input.executionId)
      return projection
    } catch (error) {
      if (fd !== undefined) closeSync(fd)
      if (createdLedger) {
        rmSync(path, { force: true })
        fsyncDirectory(this.ledgersDirectory)
      }
      throw error
    }
  }

  appendExecutionEvent(
    input: ExecutionRunEventInput,
    options: AppendExecutionEventOptions = {}
  ): ExecutionRunEvent {
    return this.appendExecutionEvents([input], options)[0]
  }

  appendExecutionEvents(
    inputs: readonly ExecutionRunEventInput[],
    options: AppendExecutionEventOptions = {}
  ): readonly ExecutionRunEvent[] {
    if (inputs.length === 0) return []
    const executionId = inputs[0].executionId
    assertCanonicalId(executionId, 'executionId')
    if (inputs.some((input) => input.executionId !== executionId)) {
      throw new Error('All appended events must target the same execution.')
    }
    if (inputs.some((input) => input.kind === 'execution_created')) {
      throw new Error('execution_created may only be written by createExecution.')
    }
    const entry = this.executions.find((candidate) => candidate.executionId === executionId)
    if (!entry) throw new Error(`Unknown execution "${executionId}".`)
    let cached = this.executionCache.get(executionId)
    if (!cached) {
      throw new Error(`Execution "${executionId}" is quarantined and cannot accept events.`)
    }
    let path: string
    try {
      path = this.ledgerPath(entry)
    } catch (error) {
      this.quarantineExecution(
        entry,
        'execution_ledger_missing',
        error instanceof Error ? error.message : String(error)
      )
      throw error
    }
    const observedSize = lstatSync(path).size
    if (observedSize !== cached.observedByteLength) {
      let reparsed: ParsedLedger | undefined
      try {
        reparsed = this.parseLedger(path, executionId)
      } catch {
        // Report the stable repository diagnostic below rather than exposing parser details here.
      }
      const unchangedCompletePrefix =
        reparsed?.hasTornFinalFragment === true &&
        reparsed.completeByteLength === cached.completeByteLength &&
        stableExecutionGraphStringify(reparsed.events) ===
          stableExecutionGraphStringify(cached.events)
      if (!reparsed || !unchangedCompletePrefix) {
        const message = `Execution ledger changed outside the repository for "${executionId}".`
        this.quarantineExecution(entry, 'execution_ledger_corrupt', message)
        throw new Error(message)
      }
      cached = {
        ...cached,
        observedByteLength: reparsed.observedByteLength,
        hasTornFinalFragment: true
      }
      this.executionCache.set(executionId, cached)
    }
    const actualLastSequence = cached.projection.lastSequence
    if (
      options.expectedLastSequence !== undefined &&
      (!isNonNegativeInteger(options.expectedLastSequence) ||
        options.expectedLastSequence !== actualLastSequence)
    ) {
      throw new ExecutionGraphSequenceConflictError(
        executionId,
        options.expectedLastSequence,
        actualLastSequence
      )
    }
    if (cached.hasTornFinalFragment) {
      this.truncateTornFinalFragment(path, cached.completeByteLength)
      cached = {
        ...cached,
        observedByteLength: cached.completeByteLength,
        hasTornFinalFragment: false
      }
      this.executionCache.set(executionId, cached)
    }

    const events = inputs.map((input, index) => {
      const event = createExecutionRunEvent(input, actualLastSequence + index + 1)
      validateEventEnvelope(event, executionId, actualLastSequence + index + 1)
      if (event.kind === 'step_appended') this.assertStepRunTemplate(event.append.step)
      return event
    })
    const allEvents = [...cached.events, ...events]
    const baseRevision = this.resolveBaseRevision(allEvents)
    const projection = foldExecutionRun(executionId, allEvents, { baseRevision })
    if (projection.integrity !== 'valid') {
      throw new Error(
        `Refusing invalid execution event append: ${projection.diagnostics
          .map((entry) => entry.code)
          .join(', ')}.`
      )
    }
    let fd: number | undefined
    try {
      fd = openSync(path, 'a', 0o600)
      const serialized = events.map(serializeExecutionRunEvent).join('')
      const serializedBytes = Buffer.from(serialized, 'utf8')
      writeAll(fd, serializedBytes)
      fsyncSync(fd)
      const completeByteLength = cached.completeByteLength + serializedBytes.byteLength
      this.executionCache.set(executionId, {
        events: Object.freeze(allEvents),
        projection,
        completeByteLength,
        observedByteLength: completeByteLength,
        hasTornFinalFragment: false
      })
      return events
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }

  readExecutionEvents(executionId: string): readonly ExecutionRunEvent[] {
    assertCanonicalId(executionId, 'executionId')
    return this.executionCache.get(executionId)?.events ?? []
  }

  hasExecution(executionId: string): boolean {
    assertCanonicalId(executionId, 'executionId')
    return this.executionCache.has(executionId)
  }

  getExecution(executionId: string): ExecutionRunProjection | undefined {
    assertCanonicalId(executionId, 'executionId')
    return this.executionCache.get(executionId)?.projection
  }

  listExecutions(): readonly ExecutionRunProjection[] {
    return this.executions.flatMap((entry) => {
      const projection = this.executionCache.get(entry.executionId)?.projection
      return projection ? [projection] : []
    })
  }

  listExecutionEvents(): readonly {
    readonly executionId: string
    readonly events: readonly ExecutionRunEvent[]
  }[] {
    return this.executions.flatMap((entry) => {
      const events = this.executionCache.get(entry.executionId)?.events
      return events ? [{ executionId: entry.executionId, events }] : []
    })
  }

  listRepositoryDiagnostics(): readonly ExecutionGraphRepositoryDiagnostic[] {
    return [...this.repositoryDiagnostics.values()]
  }

  private loadRevisionRegistry(): ExecutionGraphRevision[] {
    const raw = readJson(this.revisionsPath)
    if (raw === undefined) return []
    if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.revisions)) {
      throw new Error('Execution graph revision registry is invalid.')
    }
    const revisions = raw.revisions.map(validateRevision)
    const keys = new Set<string>()
    for (const revision of revisions) {
      const key = `${revision.graphId}:${revision.revision}`
      if (keys.has(key))
        throw new Error(`Duplicate execution graph revision ${revision.revisionId}.`)
      keys.add(key)
    }
    return revisions
  }

  private loadExecutionRegistry(): ExecutionRegistryEntry[] {
    const raw = readJson(this.executionsPath)
    let rawExecutions: unknown[] = []
    if (raw !== undefined) {
      if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.executions)) {
        throw new Error('Execution registry is invalid.')
      }
      rawExecutions = raw.executions
    }
    const seen = new Set<string>()
    const registered: ExecutionRegistryEntry[] = []
    for (const candidate of rawExecutions) {
      if (!isRecord(candidate) || candidate.schemaVersion !== 1) {
        throw new Error('Execution registry entry is invalid.')
      }
      assertCanonicalId(candidate.executionId, 'execution registry id')
      const fileName = expectedLedgerFileName(candidate.executionId)
      if (candidate.fileName !== fileName || !isTimestamp(candidate.createdAt)) {
        throw new Error(`Execution registry identity is corrupt for "${candidate.executionId}".`)
      }
      if (seen.has(candidate.executionId))
        throw new Error(`Duplicate execution "${candidate.executionId}".`)
      seen.add(candidate.executionId)
      const entry = cloneAndFreeze(candidate as unknown as ExecutionRegistryEntry)
      registered.push(entry)
      const path = join(this.ledgersDirectory, entry.fileName)
      if (!existsSync(path)) {
        this.quarantineExecution(
          entry,
          'execution_ledger_missing',
          `Execution ledger is missing for "${entry.executionId}".`
        )
        continue
      }
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Execution ledger is not a regular file for "${entry.executionId}".`)
      }
      let parsed: ParsedLedger
      try {
        parsed = this.parseLedger(path, entry.executionId)
      } catch (error) {
        this.quarantineExecution(
          entry,
          'execution_ledger_corrupt',
          error instanceof Error ? error.message : String(error)
        )
        continue
      }
      if (parsed.events[0]?.timestamp !== entry.createdAt) {
        this.quarantineExecution(
          entry,
          'execution_ledger_corrupt',
          `Execution registry createdAt does not match the ledger for "${entry.executionId}".`
        )
        continue
      }
      try {
        this.cacheParsedExecution(entry, parsed)
      } catch (error) {
        this.quarantineExecution(
          entry,
          'execution_ledger_corrupt',
          error instanceof Error ? error.message : String(error)
        )
      }
    }

    let repaired = false
    for (const fileName of readdirSync(this.ledgersDirectory)) {
      if (!fileName.startsWith('execution-') || !fileName.endsWith('.jsonl')) continue
      const executionId = fileName.slice('execution-'.length, -'.jsonl'.length)
      assertCanonicalId(executionId, 'execution ledger file id')
      if (fileName !== expectedLedgerFileName(executionId)) {
        throw new Error(`Execution ledger has a non-canonical filename: ${fileName}`)
      }
      if (seen.has(executionId)) continue
      const path = join(this.ledgersDirectory, fileName)
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Execution ledger is not a regular file for "${executionId}".`)
      }
      let parsed: ParsedLedger
      try {
        parsed = this.parseLedger(path, executionId)
      } catch (error) {
        this.quarantineExecution(
          {
            executionId,
            fileName
          },
          'execution_ledger_corrupt',
          error instanceof Error ? error.message : String(error)
        )
        continue
      }
      const created = parsed.events[0]
      if (!created || created.kind !== 'execution_created') {
        this.quarantineExecution(
          {
            executionId,
            fileName
          },
          'execution_ledger_corrupt',
          `Execution "${executionId}" is missing its authoritative creation event.`
        )
        continue
      }
      const entry = cloneAndFreeze({
        schemaVersion: REPOSITORY_SCHEMA_VERSION,
        executionId,
        fileName,
        createdAt: created.timestamp
      } satisfies ExecutionRegistryEntry)
      try {
        this.cacheParsedExecution(entry, parsed)
      } catch (error) {
        this.quarantineExecution(
          entry,
          'execution_ledger_corrupt',
          error instanceof Error ? error.message : String(error)
        )
        continue
      }
      registered.push(entry)
      seen.add(executionId)
      repaired = true
    }
    registered.sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.executionId.localeCompare(b.executionId)
    )
    if (repaired) {
      atomicWriteJson(this.executionsPath, {
        schemaVersion: REPOSITORY_SCHEMA_VERSION,
        executions: registered
      } satisfies ExecutionRegistry)
    }
    return registered
  }

  private loadLayoutRegistry(): ExecutionGraphLayout[] {
    const raw = readJson(this.layoutsPath)
    if (raw === undefined) return []
    if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.layouts)) {
      throw new Error('Execution graph layout registry is invalid.')
    }
    const seen = new Set<string>()
    return raw.layouts.map((candidate) => {
      if (!isRecord(candidate)) throw new Error('Execution graph layout entry is invalid.')
      const revision =
        typeof candidate.graphId === 'string' && typeof candidate.revision === 'number'
          ? this.revisions.find(
              (entry) =>
                entry.graphId === candidate.graphId && entry.revision === candidate.revision
            )
          : undefined
      if (!revision) throw new Error('Execution graph layout references an unknown revision.')
      const layout = validateLayout(candidate, revision)
      const key = `${layout.graphId}:${layout.revision}`
      if (seen.has(key)) throw new Error(`Duplicate execution graph layout ${key}.`)
      seen.add(key)
      return layout
    })
  }

  private loadTemplateRegistry(): ExecutionGraphRunTemplate[] {
    const raw = readJson(this.templatesPath)
    if (raw === undefined) return []
    if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.templates)) {
      throw new Error('Execution graph run-template registry is invalid.')
    }
    const seen = new Set<string>()
    return raw.templates.map((candidate) => {
      if (!isRecord(candidate) || candidate.schemaVersion !== 1 || !isRecord(candidate.content)) {
        throw new Error('Execution graph run-template entry is invalid.')
      }
      assertJsonValue(candidate.content)
      assertDigest(candidate.contentDigest, 'run template contentDigest')
      const templateId = `${RUN_TEMPLATE_PREFIX}${candidate.contentDigest}`
      if (candidate.templateId !== templateId) throw new Error('Run template identity is corrupt.')
      const actualDigest = createHash('sha256')
        .update(stableExecutionGraphStringify(candidate.content))
        .digest('hex')
      if (actualDigest !== candidate.contentDigest)
        throw new Error('Run template content digest is corrupt.')
      if (seen.has(templateId)) throw new Error(`Duplicate run template "${templateId}".`)
      seen.add(templateId)
      return cloneAndFreeze(candidate as unknown as ExecutionGraphRunTemplate)
    })
  }

  private assertRunTemplateId(templateId: string): void {
    if (
      typeof templateId !== 'string' ||
      !templateId.startsWith(RUN_TEMPLATE_PREFIX) ||
      !SHA256_PATTERN.test(templateId.slice(RUN_TEMPLATE_PREFIX.length))
    ) {
      throw new Error('Run template id is invalid.')
    }
  }

  private ledgerPath(entry: ExecutionRegistryEntry): string {
    const expected = expectedLedgerFileName(entry.executionId)
    if (entry.fileName !== expected)
      throw new Error('Execution registry contains a non-canonical path.')
    const path = join(this.ledgersDirectory, expected)
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Execution ledger is not a regular file for "${entry.executionId}".`)
    }
    return path
  }

  private parseLedger(path: string, executionId: string): ParsedLedger {
    const bytes = readFileSync(path)
    const hasTornFinalFragment = bytes.byteLength > 0 && bytes[bytes.byteLength - 1] !== 0x0a
    const finalNewline = bytes.lastIndexOf(0x0a)
    const completeByteLength = hasTornFinalFragment ? finalNewline + 1 : bytes.byteLength
    const completeText = bytes.subarray(0, completeByteLength).toString('utf8')
    const lines = completeText ? completeText.split('\n') : []
    if (lines.at(-1) === '') lines.pop()
    const events = lines.map((line, index) => {
      if (!line.trim())
        throw new Error(`Execution ledger has a blank record at sequence ${index + 1}.`)
      const event = parseExecutionRunEventLine(line)
      if (!event) throw new Error(`Execution ledger is corrupt at sequence ${index + 1}.`)
      validateEventEnvelope(event, executionId, index + 1)
      return event
    })
    if (events.length === 0 && bytes.byteLength > 0) {
      throw new Error(`Execution ledger for "${executionId}" has no complete creation event.`)
    }
    if (events.length > 0 && events[0].kind !== 'execution_created') {
      throw new Error(
        `Execution ledger for "${executionId}" does not begin with execution_created.`
      )
    }
    return {
      events: Object.freeze(events),
      completeByteLength,
      observedByteLength: bytes.byteLength,
      hasTornFinalFragment
    }
  }

  private truncateTornFinalFragment(path: string, completeByteLength: number): void {
    let fd: number | undefined
    try {
      fd = openSync(path, 'r+')
      ftruncateSync(fd, completeByteLength)
      fsyncSync(fd)
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }

  private resolveBaseRevision(
    events: readonly ExecutionRunEvent[]
  ): ExecutionGraphRevision | undefined {
    const created = events.find(
      (event): event is ExecutionCreatedEvent => event.kind === 'execution_created'
    )
    if (!created?.baseRevision) return undefined
    return this.requireRevisionByRef(created.baseRevision)
  }

  private requireRevisionByRef(ref: ExecutionGraphRevisionRef): ExecutionGraphRevision {
    const revision = this.getRevisionByRef(ref)
    if (!revision) throw new Error(`Pinned execution graph revision ${ref.revisionId} is missing.`)
    return revision
  }

  private assertStepRunTemplate(step: unknown): void {
    if (!isRecord(step) || step.kind !== 'solo_agent' || !isRecord(step.agent)) return
    const templateRef = step.agent.runTemplateRef
    if (templateRef === undefined) return
    if (typeof templateRef !== 'string' || !this.getRunTemplate(templateRef)) {
      throw new Error(`Solo-agent step references unknown run template "${String(templateRef)}".`)
    }
  }

  private assertRevisionRunTemplates(revisions: readonly ExecutionGraphRevision[]): void {
    for (const revision of revisions) {
      for (const step of revision.steps) this.assertStepRunTemplate(step)
    }
  }

  private cacheParsedExecution(entry: ExecutionRegistryEntry, parsed: ParsedLedger): void {
    for (const event of parsed.events) {
      if (event.kind === 'step_appended') this.assertStepRunTemplate(event.append.step)
    }
    const projection = foldExecutionRun(entry.executionId, parsed.events, {
      baseRevision: this.resolveBaseRevision(parsed.events)
    })
    if (projection.integrity !== 'valid') {
      throw new Error(
        `Execution ledger fold is invalid: ${projection.diagnostics
          .map((diagnostic) => diagnostic.code)
          .join(', ')}.`
      )
    }
    this.executionCache.set(entry.executionId, {
      events: parsed.events,
      projection,
      completeByteLength: parsed.completeByteLength,
      observedByteLength: parsed.observedByteLength,
      hasTornFinalFragment: parsed.hasTornFinalFragment
    })
    this.repositoryDiagnostics.delete(entry.executionId)
  }

  private quarantineExecution(
    entry: Pick<ExecutionRegistryEntry, 'executionId' | 'fileName'>,
    code: ExecutionGraphRepositoryDiagnostic['code'],
    message: string
  ): void {
    this.executionCache.delete(entry.executionId)
    this.repositoryDiagnostics.set(
      entry.executionId,
      cloneAndFreeze({
        code,
        executionId: entry.executionId,
        fileName: entry.fileName,
        message
      } satisfies ExecutionGraphRepositoryDiagnostic)
    )
  }
}
