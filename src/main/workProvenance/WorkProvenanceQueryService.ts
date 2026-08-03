import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  unavailableWorkProvenanceSnapshot,
  WORK_PROVENANCE_CLASSIFIER_VERSION,
  WORK_PROVENANCE_EVENT_SCHEMA_VERSION,
  WORK_PROVENANCE_PROJECTION_VERSION,
  WORK_PROVENANCE_QUERY_LIMIT,
  type WorkProvenanceAttribution,
  type WorkProvenanceProjection,
  type WorkProvenanceRepositoryIdentity,
  type WorkProvenanceSnapshot
} from '../../shared/workProvenance'
import type { WorkProvenanceQueryDriver } from './WorkProvenanceWorkerScan'

const CACHE_TTL_MS = 4_000
const SHA256 = /^[0-9a-f]{64}$/i

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').trim().slice(0, 320) || 'Unknown provenance query error.'
}

function validIdentity(value: unknown): value is WorkProvenanceRepositoryIdentity {
  return (
    isRecord(value) &&
    typeof value.root === 'string' &&
    typeof value.gitDir === 'string' &&
    typeof value.gitCommonDir === 'string' &&
    typeof value.repositoryId === 'string' &&
    SHA256.test(value.repositoryId) &&
    typeof value.worktreeId === 'string' &&
    SHA256.test(value.worktreeId)
  )
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function validAttribution(value: unknown): value is WorkProvenanceAttribution {
  if (!isRecord(value) || !isRecord(value.invariant)) return false
  if (
    value.invariant.files !== true ||
    value.invariant.additions !== true ||
    value.invariant.deletions !== true ||
    value.invariant.satisfied !== true
  ) {
    return false
  }
  const buckets = ['root', 'unique', 'sharedAmbiguous', 'unclaimedUnknown'] as const
  for (const bucketName of buckets) {
    const bucket = value[bucketName]
    if (!isRecord(bucket)) return false
    for (const field of [
      'files',
      'trackedFiles',
      'untrackedFiles',
      'binaryFiles',
      'additions',
      'deletions'
    ]) {
      if (!nonNegativeInteger(bucket[field])) return false
    }
    if (bucketName !== 'root') {
      if (!Array.isArray(bucket.paths) || bucket.paths.length > 20_000) return false
      if (
        bucket.paths.some(
          (path) =>
            !isRecord(path) ||
            typeof path.path !== 'string' ||
            path.path.length === 0 ||
            path.path.length > 4_096
        )
      ) {
        return false
      }
    }
  }
  const root = value.root as UnknownRecord
  for (const field of [
    'files',
    'trackedFiles',
    'untrackedFiles',
    'binaryFiles',
    'additions',
    'deletions'
  ]) {
    const sum = ['unique', 'sharedAmbiguous', 'unclaimedUnknown'].reduce(
      (total, bucket) => total + Number((value[bucket] as UnknownRecord)[field]),
      0
    )
    if (sum !== root[field]) return false
  }
  return true
}

async function parseProjection(
  value: unknown,
  expectedRoot: string
): Promise<WorkProvenanceSnapshot> {
  if (!isRecord(value)) throw new Error('Work provenance projection is malformed.')
  if (
    value.projectionVersion !== WORK_PROVENANCE_PROJECTION_VERSION ||
    value.classifierVersion !== WORK_PROVENANCE_CLASSIFIER_VERSION ||
    value.eventSchemaVersion !== WORK_PROVENANCE_EVENT_SCHEMA_VERSION
  ) {
    throw new Error(
      `Unsupported work provenance contract ${String(value.projectionVersion)}/${String(value.classifierVersion)}/${String(value.eventSchemaVersion)}.`
    )
  }
  if (!validIdentity(value.repository)) {
    throw new Error(
      typeof value.unavailableReason === 'string'
        ? value.unavailableReason
        : 'Work provenance repository identity is unavailable.'
    )
  }
  const repository = value.repository
  const projectionRoot = await realpath(repository.root).catch(() => resolve(repository.root))
  if (projectionRoot !== expectedRoot) {
    throw new Error('Work provenance projection belongs to a different Git worktree.')
  }
  if (!isRecord(value.window) || !Array.isArray(value.workItems)) {
    throw new Error('Work provenance projection window is malformed.')
  }
  if (
    !nonNegativeInteger(value.window.limit) ||
    Number(value.window.limit) > WORK_PROVENANCE_QUERY_LIMIT ||
    !nonNegativeInteger(value.window.totalItems) ||
    !nonNegativeInteger(value.window.returnedItems) ||
    value.window.returnedItems !== value.workItems.length ||
    value.workItems.length > WORK_PROVENANCE_QUERY_LIMIT
  ) {
    throw new Error('Work provenance projection exceeded its bounded window.')
  }
  if (!validAttribution(value.attribution)) {
    throw new Error('Work provenance attribution partition is invalid.')
  }
  if (!isRecord(value.gitGeneration) || typeof value.gitGeneration.coherent !== 'boolean') {
    throw new Error('Work provenance Git generation is unavailable.')
  }
  if (
    value.workItems.some(
      (item) =>
        !isRecord(item) ||
        typeof item.workItemId !== 'string' ||
        typeof item.path !== 'string' ||
        !Array.isArray(item.contributors) ||
        !Array.isArray(item.currentContributors) ||
        item.contributors.length > 1_000 ||
        item.currentContributors.length > 1_000
    )
  ) {
    throw new Error('Work provenance items are malformed or unbounded.')
  }
  return {
    ...(value as unknown as WorkProvenanceProjection),
    repository: value.repository,
    available: true,
    stale: false
  }
}

/**
 * Main-owned cache and coherence boundary for the read-only provenance worker.
 * Failures never become an empty/clean assertion: retain a matching coherent
 * generation as stale, otherwise return an explicitly unavailable snapshot.
 */
export class WorkProvenanceQueryService {
  private readonly cache = new Map<
    string,
    { expiresAt: number; snapshot: WorkProvenanceSnapshot }
  >()
  private readonly inFlight = new Map<string, Promise<WorkProvenanceSnapshot>>()
  private readonly lastCoherent = new Map<string, WorkProvenanceSnapshot>()

  private readonly now: () => number
  private readonly cacheTtlMs: number

  constructor(
    private readonly queryDriver: WorkProvenanceQueryDriver,
    options: { now?: () => number; cacheTtlMs?: number } = {}
  ) {
    this.now = options.now ?? Date.now
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? CACHE_TTL_MS)
  }

  async query(inputRoot: string): Promise<WorkProvenanceSnapshot> {
    const root = await realpath(resolve(inputRoot)).catch(() => resolve(inputRoot))
    const cached = this.cache.get(root)
    if (cached && cached.expiresAt > this.now()) return cached.snapshot
    const existing = this.inFlight.get(root)
    if (existing) return existing

    const pending = this.queryFresh(root).finally(() => this.inFlight.delete(root))
    this.inFlight.set(root, pending)
    return pending
  }

  private async queryFresh(root: string): Promise<WorkProvenanceSnapshot> {
    try {
      const snapshot = await parseProjection(await this.queryDriver(root), root)
      if (!snapshot.gitGeneration?.coherent) {
        return this.staleOrUnavailable(
          root,
          snapshot.gitGeneration?.reason || 'Git changed during provenance sampling.'
        )
      }
      this.lastCoherent.set(root, snapshot)
      this.cache.set(root, { expiresAt: this.now() + this.cacheTtlMs, snapshot })
      return snapshot
    } catch (error) {
      return this.staleOrUnavailable(root, safeError(error))
    }
  }

  private staleOrUnavailable(root: string, reason: string): WorkProvenanceSnapshot {
    const previous = this.lastCoherent.get(root)
    if (previous) {
      return {
        ...previous,
        stale: true,
        reason: `Retaining the last coherent provenance generation: ${reason}`
      }
    }
    return unavailableWorkProvenanceSnapshot(reason)
  }
}
