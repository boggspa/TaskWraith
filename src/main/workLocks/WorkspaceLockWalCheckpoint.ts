import {
  canonicalWorkspaceLockWalJson,
  decodeWorkspaceLockWal,
  validateWorkspaceLockWalCheckpointBaseline,
  workspaceLockWalDigest,
  type WorkspaceLockWalCheckpointBaseline,
  type WorkspaceLockWalState
} from './WorkspaceLockWal'

/**
 * Checkpoint envelope for the append-only workspace-lock WAL.
 *
 * The complete protocol, its crash table, and the explicit decision about which
 * history leaves the boot path live in
 * `docs/performance/workspace-lock-wal-checkpoint.md`. In short: the id sets are
 * carried in full because refusing a reused transition or lease id is a fence;
 * event payloads older than the retained tail are sealed into a digest-bound
 * archive segment and are no longer replayable, so an idempotent retry of one
 * becomes a refusal rather than a second acquisition.
 */
export const WORKSPACE_LOCK_WAL_CHECKPOINT_SCHEMA = 'taskwraith.workspace-lock.checkpoint.v1'

/** A sealed history segment. Never read at boot; retained as audit evidence. */
export interface WorkspaceLockWalArchiveSegment {
  /** Last event sequence contained in the segment. */
  sequence: number
  filename: string
  byteLength: number
  digest: string
}

export interface WorkspaceLockWalCheckpoint extends WorkspaceLockWalCheckpointBaseline {
  schema: typeof WORKSPACE_LOCK_WAL_CHECKPOINT_SCHEMA
  archivedSegments: WorkspaceLockWalArchiveSegment[]
  /** Chains successive checkpoints; '' for the first one. */
  previousCheckpointDigest: string
  createdAt: string
  authority: { instanceId: string; generation: number }
  digest: string
}

export interface WorkspaceLockWalCompactionPlan {
  /** Last sequence sealed by this plan; `events.jsonl` keeps everything after it. */
  boundarySequence: number
  /** Exact bytes of the sealed segment, newline-terminated. */
  archivedFrames: string
  /** Exact bytes `events.jsonl` is replaced with, newline-terminated or empty. */
  retainedFrames: string
  archiveFilename: string
  archiveDigest: string
  checkpoint: WorkspaceLockWalCheckpoint
  serializedCheckpoint: string
  /** Frames the retained tail still holds; reported so callers can log honestly. */
  retainedFrameCount: number
  sealedFrameCount: number
}

/** Frames kept replayable after a checkpoint, for idempotent operation retries. */
export const WORKSPACE_LOCK_WAL_RETAINED_TAIL_EVENTS = 512

/** `events.jsonl` is only compacted once it is worth compacting. */
export const WORKSPACE_LOCK_WAL_CHECKPOINT_BYTE_THRESHOLD = 8 * 1024 * 1024

const DIGEST_PATTERN = /^[a-f0-9]{64}$/
const ARCHIVE_SEQUENCE_DIGITS = 20

export function workspaceLockWalArchiveFilename(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new Error('Workspace-lock archive sequence must be a positive safe integer.')
  }
  return `events-${String(sequence).padStart(ARCHIVE_SEQUENCE_DIGITS, '0')}.jsonl`
}

export function isWorkspaceLockWalArchiveFilename(value: string): boolean {
  return new RegExp(`^events-\\d{${ARCHIVE_SEQUENCE_DIGITS}}\\.jsonl$`).test(value)
}

export function workspaceLockWalCheckpointBaseline(
  checkpoint: WorkspaceLockWalCheckpoint
): WorkspaceLockWalCheckpointBaseline {
  return {
    sequence: checkpoint.sequence,
    lastDigest: checkpoint.lastDigest,
    lastTransitionId: checkpoint.lastTransitionId,
    transitionIds: checkpoint.transitionIds,
    leaseIds: checkpoint.leaseIds,
    maxGeneration: checkpoint.maxGeneration,
    activeLeases: checkpoint.activeLeases,
    recoveredLeases: checkpoint.recoveredLeases,
    knownMarkers: checkpoint.knownMarkers
  }
}

/** Validates an untrusted checkpoint document before it can affect replay. */
export function validateWorkspaceLockWalCheckpoint(value: unknown): WorkspaceLockWalCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Workspace-lock checkpoint must be an object.')
  }
  const record = value as Record<string, unknown>
  const expected = [
    'schema',
    'sequence',
    'lastDigest',
    'lastTransitionId',
    'transitionIds',
    'leaseIds',
    'maxGeneration',
    'activeLeases',
    'recoveredLeases',
    'knownMarkers',
    'archivedSegments',
    'previousCheckpointDigest',
    'createdAt',
    'authority',
    'digest'
  ]
  const actual = Object.keys(record).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error('Workspace-lock checkpoint has unexpected or missing properties.')
  }
  if (record.schema !== WORKSPACE_LOCK_WAL_CHECKPOINT_SCHEMA) {
    throw new Error('Unknown workspace-lock checkpoint schema.')
  }
  if (typeof record.digest !== 'string' || !DIGEST_PATTERN.test(record.digest)) {
    throw new Error('Invalid workspace-lock checkpoint digest.')
  }
  if (
    typeof record.previousCheckpointDigest !== 'string' ||
    (record.previousCheckpointDigest !== '' &&
      !DIGEST_PATTERN.test(record.previousCheckpointDigest))
  ) {
    throw new Error('Invalid workspace-lock checkpoint predecessor digest.')
  }
  if (
    typeof record.createdAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.createdAt) ||
    new Date(record.createdAt).toISOString() !== record.createdAt
  ) {
    throw new Error('Invalid workspace-lock checkpoint timestamp.')
  }
  const authority = validateAuthority(record.authority)
  const baseline = validateWorkspaceLockWalCheckpointBaseline({
    sequence: record.sequence,
    lastDigest: record.lastDigest,
    lastTransitionId: record.lastTransitionId,
    transitionIds: record.transitionIds,
    leaseIds: record.leaseIds,
    maxGeneration: record.maxGeneration,
    activeLeases: record.activeLeases,
    recoveredLeases: record.recoveredLeases,
    knownMarkers: record.knownMarkers
  })
  const archivedSegments = validateSegments(record.archivedSegments, baseline.sequence)
  const candidate = {
    schema: WORKSPACE_LOCK_WAL_CHECKPOINT_SCHEMA as typeof WORKSPACE_LOCK_WAL_CHECKPOINT_SCHEMA,
    ...baseline,
    archivedSegments,
    previousCheckpointDigest: record.previousCheckpointDigest,
    createdAt: record.createdAt,
    authority
  }
  if (workspaceLockWalDigest(candidate) !== record.digest) {
    throw new Error('Workspace-lock checkpoint digest mismatch.')
  }
  return { ...candidate, digest: record.digest }
}

export function decodeWorkspaceLockWalCheckpoint(raw: string): WorkspaceLockWalCheckpoint {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('Workspace-lock checkpoint must be non-empty UTF-8 text.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Workspace-lock checkpoint is not valid JSON.')
  }
  return validateWorkspaceLockWalCheckpoint(parsed)
}

export type WorkspaceLockWalCheckpointResolution =
  | { source: 'checkpoint'; state: WorkspaceLockWalState }
  | { source: 'legacy'; state: WorkspaceLockWalState }
  | { source: 'checkpoint-superseded'; state: WorkspaceLockWalState }

/**
 * The O(1) decision described in the design doc: parse only the first frame of
 * the tail and decide whether the checkpoint is its exact parent. Every branch
 * either yields the same state a full replay would, or refuses.
 */
export function resolveWorkspaceLockWalState(
  rawTail: string,
  checkpoint: WorkspaceLockWalCheckpoint | null
): WorkspaceLockWalCheckpointResolution {
  if (!checkpoint) {
    const firstSequence = firstFrameSequence(rawTail)
    if (firstSequence !== null && firstSequence !== 1) {
      throw new Error(
        `Workspace-lock WAL starts at sequence ${firstSequence} with no checkpoint to chain it to.`
      )
    }
    return { source: 'legacy', state: decodeWorkspaceLockWal(rawTail) }
  }
  const baseline = workspaceLockWalCheckpointBaseline(checkpoint)
  const completePrefix = completeFramePrefix(rawTail)
  if (!completePrefix) {
    return { source: 'checkpoint', state: decodeWorkspaceLockWal('', baseline) }
  }
  const first = firstFrameAnchor(completePrefix)
  if (
    first.sequence === checkpoint.sequence + 1 &&
    first.previousDigest === checkpoint.lastDigest
  ) {
    return { source: 'checkpoint', state: decodeWorkspaceLockWal(completePrefix, baseline) }
  }
  if (first.sequence === 1) {
    // Crash between publishing the checkpoint and truncating the tail. The tail
    // is still the complete history, so replay it and ignore the checkpoint.
    const state = decodeWorkspaceLockWal(completePrefix)
    if (state.sequence < checkpoint.sequence) {
      throw new Error('Workspace-lock WAL is shorter than its published checkpoint.')
    }
    return { source: 'checkpoint-superseded', state }
  }
  throw new Error(
    `Workspace-lock WAL frame ${first.sequence} does not continue checkpoint ${checkpoint.sequence}.`
  )
}

export interface WorkspaceLockWalCompactionInput {
  /** Fully replayed state for `rawTail`, produced under the transition fence. */
  state: WorkspaceLockWalState
  rawTail: string
  createdAt: string
  authority: { instanceId: string; generation: number }
  previousCheckpoint: WorkspaceLockWalCheckpoint | null
  retainedTailEvents?: number
}

/**
 * Splits the validated tail at a frame boundary and builds the checkpoint that
 * stands for everything before it. Returns null when there is nothing to seal.
 */
export function planWorkspaceLockWalCompaction(
  input: WorkspaceLockWalCompactionInput
): WorkspaceLockWalCompactionPlan | null {
  const retain = input.retainedTailEvents ?? WORKSPACE_LOCK_WAL_RETAINED_TAIL_EVENTS
  if (!Number.isSafeInteger(retain) || retain < 0) {
    throw new Error('Workspace-lock retained tail length must be a non-negative safe integer.')
  }
  const compacted = input.state.baseline ? input.state.baseline.sequence : 0
  const boundarySequence = input.state.sequence - retain
  if (boundarySequence <= compacted) return null

  const completePrefix = completeFramePrefix(input.rawTail)
  if (!completePrefix) throw new Error('Workspace-lock WAL has no complete frames to compact.')
  const lines = completePrefix.slice(0, -1).split('\n')
  if (lines.length !== input.state.sequence - compacted) {
    throw new Error('Workspace-lock WAL frame count does not match its replayed state.')
  }
  const sealedFrameCount = boundarySequence - compacted
  const archivedFrames = `${lines.slice(0, sealedFrameCount).join('\n')}\n`
  const retainedLines = lines.slice(sealedFrameCount)
  const retainedFrames = retainedLines.length ? `${retainedLines.join('\n')}\n` : ''

  // Replay only as far as the boundary; that state is what the checkpoint means.
  const boundaryState = decodeWorkspaceLockWal(archivedFrames, input.state.baseline ?? undefined)
  if (boundaryState.sequence !== boundarySequence) {
    throw new Error('Workspace-lock compaction boundary did not replay to its expected sequence.')
  }
  const baseline: WorkspaceLockWalCheckpointBaseline = {
    sequence: boundaryState.sequence,
    lastDigest: boundaryState.lastDigest,
    lastTransitionId: boundaryState.lastTransitionId,
    transitionIds: boundaryState.transitionIds,
    leaseIds: boundaryState.leaseIds,
    maxGeneration: boundaryState.maxGeneration,
    activeLeases: boundaryState.activeLeases,
    recoveredLeases: boundaryState.recoveredLeases,
    knownMarkers: boundaryState.knownMarkers
  }
  const archiveFilename = workspaceLockWalArchiveFilename(boundarySequence)
  const archiveDigest = workspaceLockWalDigest(archivedFrames)
  const archivedSegments = [
    ...(input.previousCheckpoint?.archivedSegments ?? []),
    {
      sequence: boundarySequence,
      filename: archiveFilename,
      byteLength: Buffer.byteLength(archivedFrames, 'utf8'),
      digest: archiveDigest
    }
  ]
  const unsigned = {
    schema: WORKSPACE_LOCK_WAL_CHECKPOINT_SCHEMA as typeof WORKSPACE_LOCK_WAL_CHECKPOINT_SCHEMA,
    ...baseline,
    archivedSegments,
    previousCheckpointDigest: input.previousCheckpoint?.digest ?? '',
    createdAt: input.createdAt,
    authority: validateAuthority(input.authority)
  }
  const checkpoint: WorkspaceLockWalCheckpoint = {
    ...unsigned,
    digest: workspaceLockWalDigest(unsigned)
  }
  const serializedCheckpoint = `${canonicalWorkspaceLockWalJson(checkpoint)}\n`
  // Prove the published bytes round-trip before any of them reach disk.
  validateWorkspaceLockWalCheckpoint(JSON.parse(serializedCheckpoint))
  return {
    boundarySequence,
    archivedFrames,
    retainedFrames,
    archiveFilename,
    archiveDigest,
    checkpoint,
    serializedCheckpoint,
    retainedFrameCount: retainedLines.length,
    sealedFrameCount
  }
}

function completeFramePrefix(raw: string): string {
  if (typeof raw !== 'string' || !raw) return ''
  const lastNewline = raw.lastIndexOf('\n')
  return lastNewline < 0 ? '' : raw.slice(0, lastNewline + 1)
}

function firstFrameSequence(raw: string): number | null {
  const prefix = completeFramePrefix(raw)
  if (!prefix) return null
  return firstFrameAnchor(prefix).sequence
}

function firstFrameAnchor(completePrefix: string): { sequence: number; previousDigest: string } {
  const end = completePrefix.indexOf('\n')
  const line = completePrefix.slice(0, end)
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new Error('Workspace-lock WAL is corrupt at line 1: malformed JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Workspace-lock WAL is corrupt at line 1: frame must be an object')
  }
  const frame = parsed as Record<string, unknown>
  if (!Number.isSafeInteger(frame.sequence) || (frame.sequence as number) <= 0) {
    throw new Error('Workspace-lock WAL is corrupt at line 1: invalid sequence')
  }
  if (
    typeof frame.previousDigest !== 'string' ||
    (frame.previousDigest !== '' && !DIGEST_PATTERN.test(frame.previousDigest))
  ) {
    throw new Error('Workspace-lock WAL is corrupt at line 1: invalid previous digest')
  }
  return { sequence: frame.sequence as number, previousDigest: frame.previousDigest }
}

function validateAuthority(value: unknown): { instanceId: string; generation: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid workspace-lock checkpoint authority.')
  }
  const authority = value as Record<string, unknown>
  const keys = Object.keys(authority).sort()
  if (keys.length !== 2 || keys[0] !== 'generation' || keys[1] !== 'instanceId') {
    throw new Error('Invalid workspace-lock checkpoint authority.')
  }
  if (typeof authority.instanceId !== 'string' || !authority.instanceId) {
    throw new Error('Invalid workspace-lock checkpoint authority instance id.')
  }
  if (!Number.isSafeInteger(authority.generation) || (authority.generation as number) < 0) {
    throw new Error('Invalid workspace-lock checkpoint authority generation.')
  }
  return { instanceId: authority.instanceId, generation: authority.generation as number }
}

function validateSegments(
  value: unknown,
  checkpointSequence: number
): WorkspaceLockWalArchiveSegment[] {
  if (!Array.isArray(value)) throw new Error('Workspace-lock archive segments must be an array.')
  const segments = value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('Workspace-lock archive segment must be an object.')
    }
    const segment = candidate as Record<string, unknown>
    const keys = Object.keys(segment).sort()
    const wanted = ['byteLength', 'digest', 'filename', 'sequence']
    if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
      throw new Error('Workspace-lock archive segment has unexpected or missing properties.')
    }
    if (!Number.isSafeInteger(segment.sequence) || (segment.sequence as number) <= 0) {
      throw new Error('Invalid workspace-lock archive segment sequence.')
    }
    if (
      typeof segment.filename !== 'string' ||
      !isWorkspaceLockWalArchiveFilename(segment.filename)
    ) {
      throw new Error('Invalid workspace-lock archive segment filename.')
    }
    if (segment.filename !== workspaceLockWalArchiveFilename(segment.sequence as number)) {
      throw new Error('Workspace-lock archive segment filename does not match its sequence.')
    }
    if (!Number.isSafeInteger(segment.byteLength) || (segment.byteLength as number) < 0) {
      throw new Error('Invalid workspace-lock archive segment byte length.')
    }
    if (typeof segment.digest !== 'string' || !DIGEST_PATTERN.test(segment.digest)) {
      throw new Error('Invalid workspace-lock archive segment digest.')
    }
    return {
      sequence: segment.sequence as number,
      filename: segment.filename,
      byteLength: segment.byteLength as number,
      digest: segment.digest
    }
  })
  segments.forEach((segment, index) => {
    if (index > 0 && segment.sequence <= segments[index - 1].sequence) {
      throw new Error('Workspace-lock archive segments must be strictly increasing.')
    }
  })
  const last = segments[segments.length - 1]
  if (!last || last.sequence !== checkpointSequence) {
    throw new Error('Workspace-lock checkpoint does not name the segment it seals.')
  }
  return segments
}
