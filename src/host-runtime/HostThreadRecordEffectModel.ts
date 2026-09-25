/**
 * The public effects of committing one thread record (Independent Threads
 * M4, slice 4).
 *
 * A transactional persist cannot learn its effects by capturing the Host's
 * state before and after the command; it has to know them from the record it
 * commits. This module derives them from exactly the thread a publication
 * receives (the argument of `beginThreadPublication`: the decoded record with
 * the store's repairs, its revision and its stamp), through the code the
 * donor pipeline runs:
 *
 * - the catalogue projection the Host's mirror observes at commit, and the
 *   thread summary the profile projection reads from that mirror row;
 * - every run as the catalogue indexes it: the stored summary object (the
 *   decoder summarises the record after the external-import continuity strip
 *   and stores JSON) and its `run_summary_order` rank;
 * - the thread's public rows: the thread row without `activeRoundId`, the
 *   round carrying only its seats' run ids, the participants, and each run's
 *   row.
 *
 * What one thread cannot decide is left to the public window index (slice
 * 5): which runs and rounds the global windows hold, which member runs a
 * round then carries, the thread row's `activeRoundId`, the aggregate
 * warnings, and the privacy scan of assembled rows.
 *
 * A record the catalogue projection refuses is refused here: the donor
 * throws inside the publication, before the write, and the persist fails.
 *
 * Declared differences from the donor:
 * - a record the catalogue's normaliser rejects is never re-indexed, so the
 *   catalogue keeps serving the thread's previous run rows; the model
 *   describes the committed record (pinned against the real index);
 * - once the catalogue re-indexes the thread, the mirror holds the worker's
 *   projection, which can differ from the Host's: the latest run's
 *   start-time tie-break (pinned), the composer overlay, a derived title;
 * - goal timing reads the clock, as the donor's does, so a record stamped in
 *   the future times its goal against the clock of the moment (pinned);
 * - the catalogue indexes a journal or segmented source newer than the
 *   thread file in its place; the Host writes only the file (not pinned).
 *
 * Input contract: the thread's runs carry string run ids, as the store's
 * decoder guarantees. Unwired in this slice.
 */

import type { ThreadCatalogueProjection } from '../host-shared/thread-catalogue/ThreadCatalogue'
import {
  projectThreadCatalogueRunSummary,
  threadCatalogueRunOrder
} from '../host-shared/thread-catalogue/ThreadCatalogueRunSummary'
import { stripExternalProviderThreadImportContinuity } from '../shared/externalProviderThreadImport'
import type {
  HostParticipantProjection,
  HostRoundProjection,
  HostRunProjection
} from '../shared/hostProtocol'
import {
  hostCatalogueThreadSummary,
  projectHostCatalogueThread
} from './HostCatalogueThreadProjection'
import {
  assembleProfileThreadRound,
  HOST_PROFILE_RUN_PROJECTION_LIMIT,
  profileThreadRoundRunIds,
  projectProfileRunCandidate,
  projectProfileThreadRoundBase,
  projectProfileThreadRow,
  projectThreadParticipants,
  type HostProfileDomainSnapshotFamilies,
  type ProfileRun
} from './HostProfileDomainProjection'
import type { HostProfileThread } from './HostProfileDomainStore'

/**
 * The most runs one thread can place in the run window, which holds the
 * catalogue's first 1,800 runs overall: a thread's runs in the window are
 * always among its own first 1,800.
 */
export const HOST_THREAD_RECORD_RUN_CANDIDATE_LIMIT = HOST_PROFILE_RUN_PROJECTION_LIMIT

/** A run's key in the catalogue's `run_summary_order`. */
export interface HostThreadRecordRunRank {
  /** 1 while the run may still be live. */
  readonly active: 0 | 1
  /** The run's end, else its start, in epoch ms; 0 when neither parses. */
  readonly recency: number
}

export interface HostThreadRecordRunCandidate {
  /** The run's index in the record's `runs`. */
  readonly ordinal: number
  readonly runId: string
  readonly rank: HostThreadRecordRunRank
  /** The summary object the catalogue stores for this run. */
  readonly summary: Readonly<Record<string, unknown>>
  /** The run's row as the profile projection builds it. */
  readonly row: HostRunProjection
  /** The profile projection's recency for the row: its `at` in the windowed warning. */
  readonly recency: number
  /** Whether the thread's round carries this run while the run window holds it. */
  readonly roundMember: boolean
}

export interface HostThreadRecordRound {
  readonly roundId: string
  /** The round row carrying only its seats' run ids. */
  readonly row: HostRoundProjection
  /** A live round precedes terminal ones in the round window. */
  readonly live: boolean
  readonly recency: number
}

export type HostThreadRecordThreadRow = HostProfileDomainSnapshotFamilies['threads'][number]

export interface HostThreadRecordParticipants {
  readonly rows: readonly HostParticipantProjection[]
  /** Seats the projection could not decode; the participants warning sums them. */
  readonly omitted: number
  /** The thread's `updatedAt` when a seat was omitted, else 0. */
  readonly warningAt: number
}

export interface HostThreadRecordRuns {
  /** Every run the catalogue counts for the thread. */
  readonly total: number
  /** The thread's first runs in catalogue order, at most the run window's size. */
  readonly candidates: readonly HostThreadRecordRunCandidate[]
}

export interface HostThreadRecordRefused {
  readonly kind: 'refused'
  readonly threadId: string
  /** What the persist reports when its publication throws. */
  readonly errorCode: 'thread_record_persist_failed'
}

export interface HostThreadRecordModelled {
  readonly kind: 'modelled'
  readonly threadId: string
  /** What the mirror observes at commit. */
  readonly projection: ThreadCatalogueProjection
  /** The thread row without `activeRoundId`. */
  readonly thread: HostThreadRecordThreadRow
  readonly round: HostThreadRecordRound | null
  readonly participants: HostThreadRecordParticipants
  readonly runs: HostThreadRecordRuns
}

export type HostThreadRecordEffectModel = HostThreadRecordRefused | HostThreadRecordModelled

/** The rank the catalogue stores for a run summary; one without a run id ranks 0, 0. */
export function hostThreadRecordRunRank(
  summary: Readonly<Record<string, unknown>>
): HostThreadRecordRunRank {
  const order = threadCatalogueRunOrder(summary)
  return { active: order?.catalogueActive === true ? 1 : 0, recency: order?.catalogueRecency ?? 0 }
}

export interface HostThreadRecordRunPosition {
  readonly threadId: string
  readonly rank: HostThreadRecordRunRank
  readonly ordinal: number
}

/**
 * The catalogue's run order: active runs first, then the most recent, then
 * the thread id by its UTF-8 bytes (SQLite's BINARY collation), then the
 * run's ordinal.
 */
export function compareHostThreadRecordRuns(
  left: HostThreadRecordRunPosition,
  right: HostThreadRecordRunPosition
): number {
  if (left.rank.active !== right.rank.active) return left.rank.active === 1 ? -1 : 1
  if (left.rank.recency !== right.rank.recency) {
    return left.rank.recency > right.rank.recency ? -1 : 1
  }
  if (left.threadId !== right.threadId) {
    return Buffer.compare(Buffer.from(left.threadId, 'utf8'), Buffer.from(right.threadId, 'utf8'))
  }
  return left.ordinal - right.ordinal
}

/** The thread row once the round window says whether it holds the thread's round. */
export function hostThreadRecordThreadRow(
  model: HostThreadRecordModelled,
  roundInWindow: boolean
): HostThreadRecordThreadRow {
  return roundInWindow && model.round?.live
    ? { ...model.thread, activeRoundId: model.round.roundId }
    : model.thread
}

/**
 * The round row carrying the member runs the run window holds. A round names
 * at most 50 seats and the window at most 1,800 runs, so the row stays inside
 * the protocol's collection bound and its validity never depends on them.
 */
export function hostThreadRecordRoundRow(
  round: HostThreadRecordRound,
  windowedRunIds: readonly string[]
): HostRoundProjection {
  return {
    ...round.row,
    providerRunIds: [...new Set([...round.row.providerRunIds, ...windowedRunIds])].sort()
  }
}

function catalogueSummaryOf(run: unknown): Record<string, unknown> {
  // The catalogue stores JSON: -0 reads back as 0, undefined keys vanish.
  return JSON.parse(
    JSON.stringify(
      projectThreadCatalogueRunSummary(
        run as Parameters<typeof projectThreadCatalogueRunSummary>[0]
      )
    )
  ) as Record<string, unknown>
}

/** Model the public effects of committing `committed`. */
export function modelHostThreadRecordEffects(
  committed: HostProfileThread
): HostThreadRecordEffectModel {
  const threadId = committed.appChatId
  let projection: ThreadCatalogueProjection
  try {
    projection = projectHostCatalogueThread(committed)
  } catch {
    return { kind: 'refused', threadId, errorCode: 'thread_record_persist_failed' }
  }
  const summary = hostCatalogueThreadSummary(projection)
  const base = projectProfileThreadRoundBase(summary)
  const round = base ? assembleProfileThreadRound(summary, base, []) : null
  const participants = projectThreadParticipants(summary, round ?? undefined)

  const indexed = stripExternalProviderThreadImportContinuity(committed).runs
  const runs: readonly unknown[] = Array.isArray(indexed) ? indexed : []
  const candidates = runs.map((run, ordinal): HostThreadRecordRunCandidate => {
    const stored = catalogueSummaryOf(run)
    const asRun = stored as unknown as ProfileRun
    const projected = projectProfileRunCandidate(summary, asRun, 0)
    return {
      ordinal,
      runId: projected.row.runId,
      rank: hostThreadRecordRunRank(stored),
      summary: stored,
      row: projected.row,
      recency: projected.recency,
      roundMember:
        round !== null && base !== null && profileThreadRoundRunIds(base, [asRun]).length > 0
    }
  })
  candidates.sort((left, right) =>
    compareHostThreadRecordRuns({ ...left, threadId }, { ...right, threadId })
  )

  return {
    kind: 'modelled',
    threadId,
    projection,
    thread: projectProfileThreadRow(summary, undefined),
    round: round
      ? {
          roundId: round.row.roundId,
          row: round.row,
          live: round.row.status === 'running',
          recency: round.recency
        }
      : null,
    participants: {
      rows: participants.participants,
      omitted: participants.omitted,
      warningAt: participants.warningAt
    },
    runs: {
      total: runs.length,
      candidates: candidates.slice(0, HOST_THREAD_RECORD_RUN_CANDIDATE_LIMIT)
    }
  }
}
