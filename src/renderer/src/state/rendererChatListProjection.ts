import type { ChatListItem, ChatRecord, ChatRun, EnsembleConfig } from '../../../main/store/types'
import { isTranscriptPagedShell } from '../../../shared/transcriptPage'
import { deepEqual } from '../lib/messagesRenderEqual'
import { isChatSummaryRecord } from '../lib/chatRecordMerge'
import { projectThreadRunWallMs, readThreadRunWallMs } from '../../../shared/threadRunWallTime'

/*
 * Pure projection over immutable renderer records. Retained lean chrome may be
 * structurally shared, but this module never writes through an input reference.
 */

/** Mirrors AppStore's private marker on a lean list-only ensemble projection. */
const CHAT_LIST_ENSEMBLE_PROJECTION_FLAG = '__chatListProjection'

/** Transcript/detail fields that must never enter the renderer's React list. */
const PROJECTED_AWAY_CHAT_FIELDS = new Set([
  'messages',
  'runs',
  'summaryOnly',
  'transcriptPaged',
  'messageCount',
  'runCount',
  'runWallMs',
  'lastRun',
  'runsSummary',
  'searchText',
  'searchPreview',
  'sourceChatMtimeMs',
  'sourceChatSize',
  'ensemble',
  'ollamaSessionMemory',
  'ollamaSessionMemories'
])

/** Main-authored fields that only a list/index read can provide. */
const PRESERVED_LIST_FIELDS = [
  'runsSummary',
  'searchText',
  'searchPreview',
  'sourceChatMtimeMs',
  'sourceChatSize'
] as const satisfies readonly (keyof ChatListItem)[]

/**
 * Keep the list's last-run projection useful without retaining run diffs,
 * snapshots, prompt envelopes, tool detail, or provider raw metadata.
 */
const MAIN_LAST_RUN_PROJECTION_FIELDS = [
  'runId',
  'provider',
  'providerRunId',
  'providerThreadId',
  'startedAt',
  'endedAt',
  'requestedModel',
  'actualModel',
  'approvalMode',
  'workflowMode',
  'status',
  'cancelled',
  'exitCode',
  'runtimeProfileId',
  'geminiAuthProfileId',
  'ensembleRoundId',
  'ensembleParticipantId',
  'ensembleLaneId',
  'ensembleRole',
  'ensembleStageRole',
  'ensembleOrder'
] as const satisfies readonly (keyof ChatRun)[]

/** Extra bounded fields used by renderer status/identity consumers. */
const EXTRA_LAST_RUN_PROJECTION_FIELDS = [
  'suppressRunSummary',
  'activeGoalId'
] as const satisfies readonly (keyof ChatRun)[]

type ProjectionRecord = ChatRecord &
  Partial<ChatListItem> & {
    transcriptPaged?: unknown
  }

function hasOwn(value: object | null | undefined, key: PropertyKey): boolean {
  return Boolean(value && Object.prototype.hasOwnProperty.call(value, key))
}

function copyOwnField(
  target: Record<string, unknown>,
  source: ProjectionRecord | ChatListItem | null | undefined,
  key: (typeof PRESERVED_LIST_FIELDS)[number]
): void {
  if (hasOwn(source, key)) target[key] = source![key]
}

function compactLastRun(run: ChatRun | undefined, previous?: ChatRun): ChatRun | undefined {
  if (!run) return undefined
  const compact: Record<string, unknown> = {}
  // Match AppStore.summarizeLastRun's in-memory key shape, including optional
  // keys whose value is undefined, so a healthy main-produced row stays
  // referentially stable when a full canonical update carries no list change.
  for (const key of MAIN_LAST_RUN_PROJECTION_FIELDS) {
    compact[key] = run[key]
  }
  for (const key of EXTRA_LAST_RUN_PROJECTION_FIELDS) {
    if (hasOwn(run, key)) compact[key] = run[key]
  }
  const projected = compact as unknown as ChatRun
  return previous && deepEqual(previous, projected) ? previous : projected
}

/**
 * Renderer counterpart of AppStore.toChatListEnsembleProjection. The prior row
 * may be reused by identity, but fresh canonical status always wins first.
 */
function projectLeanEnsemble(
  ensemble: EnsembleConfig | undefined,
  previous?: EnsembleConfig
): EnsembleConfig | undefined {
  if (!ensemble) return undefined
  const {
    roundSummaries: _roundSummaries,
    blackboard: _blackboard,
    blackboardTombstones: _blackboardTombstones,
    wakeups: _wakeups,
    sessionActivityLedger: _sessionActivityLedger,
    ...rest
  } = ensemble
  const projected = {
    ...rest,
    participants: (rest.participants || []).map((participant) => ({
      ...participant,
      instructions: ''
    })),
    [CHAT_LIST_ENSEMBLE_PROJECTION_FLAG]: true
  } as EnsembleConfig
  return previous && deepEqual(previous, projected) ? previous : projected
}

function finiteCount(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback
}

function buildProjection(canonical: ChatRecord, previous?: ChatListItem): ChatListItem {
  const source = canonical as ProjectionRecord
  const incomingSummary = isChatSummaryRecord(canonical) ? source : null
  // Fresh main list rows always carry `runsSummary` (including `[]`); paged
  // shells and renderer LRU demotions do not. Only the former may
  // authoritatively clear optional list-index metadata.
  const incomingListSummary =
    incomingSummary &&
    !isTranscriptPagedShell(canonical) &&
    Array.isArray(incomingSummary.runsSummary)
      ? incomingSummary
      : null
  const messages = Array.isArray(canonical.messages) ? canonical.messages : []
  const runs = Array.isArray(canonical.runs) ? canonical.runs : []
  const projected: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(source)) {
    if (!PROJECTED_AWAY_CHAT_FIELDS.has(key)) projected[key] = value
  }

  projected.messages = []
  projected.runs = []
  projected.summaryOnly = true
  // O(1) on the streaming path. Main's authoritative list projection owns
  // one-time filtering of retired legacy channel rows; walking a 15k-message
  // canonical transcript here would recreate the stall this split removes.
  projected.messageCount = incomingSummary
    ? finiteCount(incomingSummary.messageCount, 0)
    : messages.length
  projected.runCount = incomingSummary ? finiteCount(incomingSummary.runCount, 0) : runs.length
  // Thread wall time follows runCount exactly: measured from the canonical
  // array here, carried forward when the incoming row already had none. A row
  // that never learned it stays absent rather than reading as a zeroed thread.
  const carriedWallMs = incomingSummary
    ? (readThreadRunWallMs(incomingSummary.runWallMs) ?? readThreadRunWallMs(previous?.runWallMs))
    : projectThreadRunWallMs(runs)
  if (carriedWallMs !== null && carriedWallMs !== undefined) projected.runWallMs = carriedWallMs

  // Paged shells and renderer demotions are surface/residency projections, not
  // list-index rows. They carry no search/source/runsSummary fields, so retain
  // those from the prior row.
  const listFieldSource = incomingListSummary || previous
  for (const key of PRESERVED_LIST_FIELDS) {
    copyOwnField(projected, listFieldSource, key)
  }

  const latestCanonicalRun = incomingSummary ? incomingSummary.lastRun : runs[runs.length - 1]
  const lastRun = compactLastRun(latestCanonicalRun, previous?.lastRun)
  if (lastRun) projected.lastRun = lastRun

  const ensemble = projectLeanEnsemble(canonical.ensemble, previous?.ensemble)
  if (ensemble) projected.ensemble = ensemble

  return projected as unknown as ChatListItem
}

/**
 * Project one canonical record into a list-only row.
 *
 * `updatedAt` and `persistenceRevision` advance on every token save but do not
 * change list presentation by themselves. Compare with those two fields pinned
 * to the prior row; if everything else is unchanged, return the exact prior
 * object so React list consumers are not woken by transcript-only churn.
 */
export function projectRendererChatListItem(
  canonical: ChatRecord,
  previous?: ChatListItem
): ChatListItem {
  const compatiblePrevious = previous?.appChatId === canonical.appChatId ? previous : undefined
  const projected = buildProjection(canonical, compatiblePrevious)
  if (!compatiblePrevious) return projected

  const comparable = {
    ...projected,
    updatedAt: compatiblePrevious.updatedAt
  } as Record<string, unknown>
  if (hasOwn(compatiblePrevious, 'persistenceRevision')) {
    comparable.persistenceRevision = compatiblePrevious.persistenceRevision
  } else {
    delete comparable.persistenceRevision
  }
  return deepEqual(compatiblePrevious, comparable) ? compatiblePrevious : projected
}

/** Project a complete list while retaining both row and array identity on no-op. */
export function projectRendererChatList(
  canonical: readonly ChatRecord[],
  previous: readonly ChatListItem[] = []
): ChatListItem[] {
  const previousById = new Map(previous.map((chat) => [chat.appChatId, chat]))
  const projected = canonical.map((chat) =>
    projectRendererChatListItem(chat, previousById.get(chat.appChatId))
  )
  if (
    projected.length === previous.length &&
    projected.every((chat, index) => chat === previous[index])
  ) {
    return previous as ChatListItem[]
  }
  return projected
}
