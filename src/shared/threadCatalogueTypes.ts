import type { TaskWraithControlThreadFacts } from './taskWraithControlProjection'
import type { MessageActivityRequest } from './messageActivityAggregate'
export interface ThreadCataloguePresentation {
  status:
    | 'idle'
    | 'queued'
    | 'running'
    | 'awaitingApproval'
    | 'awaitingQuestion'
    | 'success'
    | 'failed'
    | 'cancelled'
  runId?: string
  startedAt?: string
  runningRunCount: number
}
export interface ThreadCatalogueReadContext {
  runtimeInstanceId: string
  defaultProvider?: string
}
export interface ThreadCatalogueRun {
  runId: string
  startedAt: string
  provider?: string
  status?: string
  endedAt?: string
  requestedModel?: string
  [key: string]: unknown
}
export interface ThreadCatalogueChrome {
  sourceChatSize?: number
  searchText?: string
  searchPreview?: string
  [key: string]: unknown
}
/** List data has no transcript, historical run array, prompt, or arbitrary record spread. */
export interface ThreadCatalogueSummary {
  chatId: string
  title: string
  provider: string
  chatKind: 'single' | 'ensemble'
  scope: 'workspace' | 'global'
  workspaceId?: string
  workspacePath?: string
  parentChatId?: string
  parentChatRelation?: 'subThread' | 'sideChat'
  createdAt: number
  updatedAt: number
  archived: boolean
  messageCount: number
  runCount: number
  /** Union of completed run intervals, ms. Absent on rows projected before the
   *  field existed; a consumer treats absence as unknown, never as zero. */
  runWallMs?: number
  chrome?: ThreadCatalogueChrome
  lastRun?: ThreadCatalogueRun
  presentation?: ThreadCataloguePresentation
  control?: TaskWraithControlThreadFacts
}

/** Counts discover work; the corresponding records are queried in bounded pages. */
export interface ThreadCatalogueRecovery {
  unsettledRuns: number
  ensembleWakeups: number
  soloWakeups: number
  workerEvents: number
  joinPolicies: number
  nextBlackboardExpiryAt: number | null
}

export interface ThreadCatalogueProjection {
  /** A usable canonical fallback is display evidence, never complete recovery evidence. */
  sourceComplete?: false
  summary: ThreadCatalogueSummary
  recovery: ThreadCatalogueRecovery
  revision: number
}

export interface ThreadCatalogueEpoch {
  global: string
  chat: string
}

export interface ThreadCatalogueTicket {
  chatId: string
  writer: 'desktop' | 'host'
  writerId: string
  operationId: string
  operationOrdinal: number
  sequence: number
  epoch: ThreadCatalogueEpoch
}

/** An actual source durability acknowledgement, not the return of a deferred append. */
export interface ThreadCatalogueDurabilityReceipt {
  operationId: string
  sequence: number
  revision: number
  sourceWitness: string
}

export interface ThreadCatalogueSourceHeads {
  desktop: string | null
  host: string | null
}

export interface ThreadCatalogueIndexReference {
  databaseId: string
  generation: string
}

export interface HostCatalogueRunOrigin {
  schemaVersion: 1
  kind: 'host-node'
  hostId: string
  incarnation: string
}
export interface TerminalChatRunSessionLike {
  runId: string
  appChatId?: string
  provider?: string
  status?: string
  updatedAt: number
}
export interface StaleChatRunSettlement {
  chatId: string
  runId: string
  previousStatus: string
}
export interface TerminalChatRunRecovery {
  chatId: string
  runId: string
  previousStatus: string
  recoveredStatus: 'success' | 'failed' | 'cancelled'
}
export type ThreadIndexedObjectKind =
  | 'control'
  | 'introspection'
  | 'remote'
  | 'people-donor'
  | 'message'
  | 'run'
  | 'run-summary'
  | 'shell'
  | 'recovery'
  | 'record'

export interface ThreadIndexedGeneration {
  databaseId: string
  chatId: string
  generation: string
  sourceWitness: string
  epoch: ThreadCatalogueEpoch
  heads: ThreadCatalogueSourceHeads
}

export interface ThreadIndexedObjectRef {
  chatId: string
  generation: string
  kind: ThreadIndexedObjectKind
  ordinal: number
  byteLength: number
  sha256: string
}

export type ThreadIndexedObject =
  | { kind: 'inline'; ordinal: number; value: unknown; byteLength: number; sha256: string }
  | { kind: 'chunked'; ordinal: number; reference: ThreadIndexedObjectRef; preview: unknown }

export type ThreadIndexObjectFrame =
  | {
      type: 'start'
      kind: ThreadIndexedObjectKind
      ordinal: number
      recordId: string
      previewJson: string
    }
  | {
      type: 'chunk'
      kind: ThreadIndexedObjectKind
      ordinal: number
      chunkNo: number
      payload: Uint8Array
    }
  | {
      type: 'finish'
      kind: ThreadIndexedObjectKind
      ordinal: number
      byteLength: number
      sha256: string
    }

export type ThreadCatalogueMutation =
  | { kind: 'repair-title'; at: string }
  | {
      kind: 'settle-runs'
      nowIso: string
      minAgeMs: number
      runs: Array<{ runId: string; session?: TerminalChatRunSessionLike }>
    }
  | { kind: 'prune-blackboard'; atMs: number }
  | { kind: 'recover-worker-control'; at: string }
  | {
      kind: 'expire-wakeup'
      family: 'ensemble' | 'solo'
      wakeupId: string
      expectedWakeAt: string
      expiredAt: string
      message?: string
    }

export interface PreparedThreadFile {
  name: string
  byteLength: number
  sha256: string
  device: string
  inode: string
  modified: string
  changed: string
}

export interface PreparedThreadMutation {
  preparedId: string
  chatId: string
  epoch: ThreadCatalogueEpoch
  heads: ThreadCatalogueSourceHeads
  sourceWitness: string
  previousRevision: number
  projection: ThreadCatalogueProjection
  record: PreparedThreadFile
  checkpoint: PreparedThreadFile
  checkedRuns: Array<{ runId: string; session?: TerminalChatRunSessionLike }>
  settlements: StaleChatRunSettlement[]
  terminalRecoveries: TerminalChatRunRecovery[]
}

export interface ThreadCatalogueOwner {
  pid?: number
  writer: 'desktop' | 'host'
  writerId: string
}

export interface ThreadCatalogueActivityPage {
  rows: Array<{
    chatId: string
    dayKey: string
    lifetimeCount: number
    rangeCount: number
    hasAny: boolean
  }>
  next: { chatId: string; dayKey: string } | null
  coverage: 'complete' | 'partial'
}

export type ThreadCatalogueQuery =
  | {
      method: 'introspection'
      window: { windowStart: string; windowEnd: string; workspaceId?: string }
      after?: { chatId: string; ordinal: number }
    }
  | {
      method: 'message-activity'
      request: MessageActivityRequest
      after?: { chatId: string; dayKey: string }
    }
  | { method: 'repair-source'; chatId: string }
  | { method: 'host-runs'; offset?: number }
  | { method: 'page-runs'; leaseId: string; start: number; end: number; maximum?: number }
  | { method: 'ordinal'; leaseId: string; kind: ThreadIndexedObjectKind; recordId: string }
  | { method: 'begin-recovery'; chatId: string; desktopWriterId: string }
  | { method: 'end-recovery'; chatId: string; recoveryToken: string }
  | { method: 'adopt-prepared'; chatId: string; recoveryToken: string; preparedId: string }
  | {
      method: 'prepare'
      chatId: string
      sourceWitness: string
      mutation: ThreadCatalogueMutation
      recoveryToken: string
    }
  | { method: 'prepared'; preparedId: string }
  | { method: 'discard-prepared'; preparedId: string }
  | { method: 'changes'; position?: { incarnation: string; sequence: number } }
  | {
      method: 'list'
      workspaceId?: string
      parentChatId?: string
      before?: { updatedAt: number; chatId: string }
      limit?: number
    }
  | { method: 'summary'; chatId: string }
  | {
      method: 'open'
      chatId: string
      mode: 'metadata' | 'pages' | 'record' | 'runs' | 'remote' | 'control'
      projectionOptions?: string
      readContext?: ThreadCatalogueReadContext
    }
  | {
      method: 'objects'
      leaseId: string
      kind: ThreadIndexedObjectKind
      before?: number
      after?: number
      direction?: 'older' | 'newer'
      maxObjects?: number
      maxBytes?: number
    }
  | {
      method: 'chunk'
      leaseId: string
      reference: ThreadIndexedObjectRef
      offset: number
      maximum?: number
    }
  | { method: 'release'; leaseId: string }
  | { method: 'run'; runId: string }
  | { method: 'known-run'; runId: string }
  | { method: 'changed'; chatId: string }
  | { method: 'owner'; owner: ThreadCatalogueOwner }
  | { method: 'erase'; chatId?: string }
  | { method: 'finish-erasure'; chatId?: string; generation: string }

export interface ThreadCatalogueOpenResult {
  leaseId: string
  entry: ThreadIndexedGeneration & { projection: ThreadCatalogueProjection; snapshot: boolean }
}
