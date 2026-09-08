/**
 * taskWraithControlProjection.ts — the bounded projections behind the local
 * TaskWraith TUI, as a contract between the control facade (main) and the
 * thread-catalogue worker.
 *
 * The facade used to build every TUI frame from full chat records: the whole
 * corpus for the 450 ms snapshot poll, and the selected thread's record on
 * every poll for the transcript pane. This module names what those frames
 * need so the catalogue can attach the list facts to each row and the worker
 * can answer the selected-thread projection from the canonical record,
 * bounded, keyed by persistence revision. `projectTaskWraithControl*` in
 * `src/main/control/TaskWraithControlProjector.ts` is the pure reference
 * implementation of both; a worker runs the same functions, so the two sides
 * cannot drift.
 *
 * Two facts stay with the facade because only main holds them: the wall-clock
 * (`wallTimeMs` is derived from `runWindow` at read time) and the ensemble
 * preset NAME (the preset cache lives in main, so the id travels instead).
 */

import type {
  TaskWraithControlEnsembleSummary,
  TaskWraithControlProviderPresentation,
  TaskWraithControlThread,
  TaskWraithControlTranscriptRow
} from './taskWraithControlProtocol'

/** The run whose clock the TUI shows: the active run, else the latest one. */
export interface TaskWraithControlRunWindow {
  startedAt: string
  endedAt?: string
}

/** Ensemble summary minus the preset name; the facade resolves `presetId`. */
export type TaskWraithControlEnsembleFacts = Omit<TaskWraithControlEnsembleSummary, 'preset'> & {
  presetId?: string
}

/**
 * Everything one TUI thread row shows, distilled from the canonical record at
 * one persistence revision. Attached to a catalogue row as
 * `ChatListItem.catalogueControl`; `thread` omits only the facade-side fields.
 */
export interface TaskWraithControlThreadFacts {
  revision: number
  thread: Omit<TaskWraithControlThread, 'wallTimeMs' | 'costText' | 'ensemble'>
  runWindow?: TaskWraithControlRunWindow
  ensemble?: TaskWraithControlEnsembleFacts
}

export interface TaskWraithControlThreadProjectionRequest {
  threadId: string
  /** Newest transcript rows to keep; the projector clamps to 1..200. */
  limit: number
  /** Revision the caller already holds, so a backend may answer `unchanged`. */
  knownRevision?: number
}

/** External path grants travel as paths; workspace names resolve in the facade. */
export interface TaskWraithControlGrantFacts {
  path: string
  access: 'read' | 'write'
}

export interface TaskWraithControlThreadContextFacts {
  workspaceId: string | null
  workspaceAccess: 'read' | 'write'
  grants: TaskWraithControlGrantFacts[]
  provider: TaskWraithControlProviderPresentation
  reasoning?: string
  permission?: string
  tokenEstimate?: number
  costText?: string
}

/**
 * The selected thread's pane at one revision: bounded (at most `limit` rows,
 * each preview capped by the projector) and free of clocks, so it is safe to
 * cache until the row's revision moves.
 */
export interface TaskWraithControlThreadProjection {
  threadId: string
  revision: number
  generatedAt: string
  facts: TaskWraithControlThreadFacts
  rows: TaskWraithControlTranscriptRow[]
  totalRows: number
  hasMoreAbove: boolean
  context: TaskWraithControlThreadContextFacts
}

export type TaskWraithControlThreadProjectionResult =
  | { kind: 'projection'; projection: TaskWraithControlThreadProjection }
  /** The record is still at `knownRevision`; the caller keeps what it holds. */
  | { kind: 'unchanged'; revision: number }
  | { kind: 'missing' }

/** Async so the answer can come from the catalogue worker, never main's disk walk. */
export type TaskWraithControlThreadProjectionProvider = (
  request: TaskWraithControlThreadProjectionRequest
) => Promise<TaskWraithControlThreadProjectionResult>

export const TASKWRAITH_CONTROL_THREAD_ROW_LIMIT = 200

export const clampTaskWraithControlThreadLimit = (limit: number): number =>
  Math.min(TASKWRAITH_CONTROL_THREAD_ROW_LIMIT, Math.max(1, Math.floor(limit) || 1))
