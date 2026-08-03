export const WORK_PROVENANCE_PROJECTION_VERSION = 1
export const WORK_PROVENANCE_CLASSIFIER_VERSION = 1
export const WORK_PROVENANCE_EVENT_SCHEMA_VERSION = 1
export const WORK_PROVENANCE_QUERY_LIMIT = 200

export type WorkProvenanceConfidence =
  | 'exact'
  | 'observed-native'
  | 'correlated-claim'
  | 'ambiguous'
  | 'unknown'

export type WorkProvenanceLiveness = 'live' | 'runtime' | 'decayed' | 'absent'
export type WorkProvenanceLifecycle =
  | 'unresolved'
  | 'resolved'
  | 'adopted'
  | 'recovered'
  | 'discarded'

export interface WorkProvenanceRepositoryIdentity {
  root: string
  gitDir: string
  gitCommonDir: string
  repositoryId: string
  worktreeId: string
}

export interface WorkProvenanceActor {
  sessionId?: string
  taskId?: string
  runId?: string
  chatId?: string
  chatTitle?: string
  provider?: string
  participantId?: string
  participantRole?: string
  laneId?: string
  displayName?: string
  markerFile?: string
  markerObservationId?: string
  lockOwnerId?: string
  authorityInstanceId?: string
  processBirthReceiptHash?: string
}

export interface WorkProvenanceEvidence {
  originEventId: string | null
  source: string
  recordedAt: string | null
  operation: {
    id: string
    name?: string
    outcome?: string
    exclusive?: boolean
  } | null
  claim: {
    kind?: 'workspace' | 'tree' | 'file' | 'hunk'
    hunk?: {
      baseline: string
      startLine: number
      endLine: number
    }
    paths?: string[]
  } | null
  authority: {
    lockOwnerId?: string
    authorityInstanceId?: string
    acquisitionTransitionId?: string
    leaseIds?: string[]
  } | null
  relationship?: 'current' | 'predecessor' | 'historical'
}

export interface WorkProvenanceContributor {
  actor: WorkProvenanceActor
  confidence: WorkProvenanceConfidence
  confidenceReason: string
  evidence: WorkProvenanceEvidence[]
}

export interface WorkProvenanceResolution {
  eventId: string
  recordedAt: string
  originEventId: string
  reason: 'clean' | 'committed' | 'reverted' | 'adopted' | 'superseded' | 'recovered' | 'discarded'
  actor?: WorkProvenanceActor
  successorOriginEventId?: string
}

export interface WorkProvenanceRecovery {
  ref: string
  commit: string
  tree: string
  pinnedAt: string
  pinned: boolean
  available: boolean
  refCommit: string | null
}

export interface WorkProvenanceFingerprint {
  state: 'missing' | 'file' | 'directory' | 'symlink' | 'other' | 'unstable' | 'unreadable'
  sha256?: string
  sizeBytes?: number
  linkTarget?: string
}

export interface WorkProvenanceItem {
  workItemId: string
  repositoryId: string
  worktreeId: string
  path: string
  lifecycle: WorkProvenanceLifecycle
  confidence: WorkProvenanceConfidence
  confidenceReason: string
  liveness: WorkProvenanceLiveness
  currentDirty: boolean
  currentStatus: string | null
  renamedFrom: string | null
  currentFingerprint: WorkProvenanceFingerprint | null
  currentContributors: WorkProvenanceContributor[]
  contributors: WorkProvenanceContributor[]
  recovery: WorkProvenanceRecovery | null
  resolutions: WorkProvenanceResolution[]
  lineageOriginEventIds: string[]
  lineageResolutions: WorkProvenanceResolution[]
  correlatedCommits: string[]
  correlatedCommitsIncluded?: boolean
  firstObservedAt: string | null
  lastObservedAt: string | null
}

export interface WorkProvenanceGitGeneration {
  id: string
  coherent: boolean
  reason: string | null
  attempt: number
  observedAt: string
  headCommit: string | null
  statusDigest: string | null
  numstatDigest: string | null
  fingerprintDigest: string | null
}

export interface WorkProvenanceAttributionTotals {
  files: number
  trackedFiles: number
  untrackedFiles: number
  binaryFiles: number
  additions: number
  deletions: number
}

export interface WorkProvenanceAttributionPath {
  path: string
  status: string
  renamedFrom: string | null
  additions: number | null
  deletions: number | null
  binary: boolean
  untracked: boolean
  workItemId: string | null
  confidence: WorkProvenanceConfidence
  contributorCount: number
}

export interface WorkProvenanceAttributionBucket extends WorkProvenanceAttributionTotals {
  paths: WorkProvenanceAttributionPath[]
}

export interface WorkProvenanceAttribution {
  root: WorkProvenanceAttributionTotals
  unique: WorkProvenanceAttributionBucket
  sharedAmbiguous: WorkProvenanceAttributionBucket
  unclaimedUnknown: WorkProvenanceAttributionBucket
  invariant: {
    files: boolean
    additions: boolean
    deletions: boolean
    satisfied: boolean
  }
}

export interface WorkProvenanceProjection {
  projectionVersion: number
  classifierVersion: number
  eventSchemaVersion: number
  cursor: string
  generatedAt: string
  repository: WorkProvenanceRepositoryIdentity | null
  gitGeneration: WorkProvenanceGitGeneration | null
  attribution: WorkProvenanceAttribution
  window: {
    limit: number
    totalItems: number
    returnedItems: number
    truncated: boolean
  }
  workItems: WorkProvenanceItem[]
  unavailableReason?: string
}

export interface WorkProvenanceSnapshot extends WorkProvenanceProjection {
  available: boolean
  stale: boolean
  reason?: string
}

function emptyAttribution(): WorkProvenanceAttribution {
  const bucket = (): WorkProvenanceAttributionBucket => ({
    files: 0,
    trackedFiles: 0,
    untrackedFiles: 0,
    binaryFiles: 0,
    additions: 0,
    deletions: 0,
    paths: []
  })
  return {
    root: {
      files: 0,
      trackedFiles: 0,
      untrackedFiles: 0,
      binaryFiles: 0,
      additions: 0,
      deletions: 0
    },
    unique: bucket(),
    sharedAmbiguous: bucket(),
    unclaimedUnknown: bucket(),
    invariant: { files: true, additions: true, deletions: true, satisfied: true }
  }
}

export function unavailableWorkProvenanceSnapshot(reason: string): WorkProvenanceSnapshot {
  return {
    available: false,
    stale: false,
    reason,
    projectionVersion: WORK_PROVENANCE_PROJECTION_VERSION,
    classifierVersion: WORK_PROVENANCE_CLASSIFIER_VERSION,
    eventSchemaVersion: WORK_PROVENANCE_EVENT_SCHEMA_VERSION,
    cursor: '',
    generatedAt: new Date().toISOString(),
    repository: null,
    gitGeneration: null,
    attribution: emptyAttribution(),
    window: {
      limit: WORK_PROVENANCE_QUERY_LIMIT,
      totalItems: 0,
      returnedItems: 0,
      truncated: false
    },
    workItems: []
  }
}
