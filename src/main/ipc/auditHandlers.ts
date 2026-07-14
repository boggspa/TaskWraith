import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { AuditOrchestrator, StartAuditInput } from '../audit/AuditOrchestrator'
import type { AuditMode, AuditRunRecord } from '../store/types'
import { assertProviderId, optionalString, requireNonEmptyString } from '../settings/MainSanitizers'

/**
 * Audit-run IPC surface — `audit-run:start`, `audit-run:cancel`,
 * `get-audit-run`, `get-audit-runs`. Register-fn DI module, mirroring
 * `ptyHandlers` / `shellHandlers`: it owns no module-local state and reaches
 * the live AuditOrchestrator + store + cancellation bookkeeping through
 * {@link AuditHandlerDeps}, so it never imports back into index.ts (no cycle).
 *
 * The orchestrator is the single writer to the run record and already pushes
 * live updates via its `onUpdate` dep (wired in index.ts to broadcast
 * `audit-run-changed`); these handlers only kick off / cancel / read runs.
 *
 * Serialization: the orchestrator keeps per-run state in a single `this.record`
 * field, so two concurrent runs would clobber each other (and the single live
 * `activeAuditRunId` cancel scope). `audit-run:start` reserves an in-flight slot
 * SYNCHRONOUSLY via `beginAuditRun()` before calling run() and releases it in a
 * `finally`; a second start while one is running is rejected.
 *
 * Cancellation: the orchestrator's `onUpdate` (in index.ts) tracks the live run
 * id; `audit-run:cancel` flips that run's flag, which the orchestrator's
 * `isCancelled` dep observes between phases + spawns. `audit-run:start` clears
 * any stale cancel flag once its run resolves so a recycled id starts clean.
 *
 * `ipcMain` is the same Electron singleton that `installIpcValidation(ipcMain)`
 * patches in index.ts before any registration runs, so every channel below
 * still flows through `validateIpcArgs`. `IpcValidation.test.ts` statically
 * scans `src/main/ipc/*.ts`, so these channels' arg schemas stay enforced at
 * build time (added to IPC_ARGUMENT_SCHEMAS in IpcValidation.ts).
 */
export type AuditSenderScope =
  | { kind: 'main' }
  | {
      kind: 'chat'
      chatId: string
      workspacePath: string
      workspaceId?: string
    }

export interface AuditHandlerDeps {
  /** The live orchestrator (assigned in app.whenReady()); null before init. */
  getAuditOrchestrator: () => AuditOrchestrator | null
  /** Store readers for the get-* channels. */
  getAuditRun: (id: string) => AuditRunRecord | null
  getAuditRuns: (workspaceId?: string) => AuditRunRecord[]
  /** Resolve the calling renderer's durable audit authority. Non-chat popouts
   * must be rejected by the resolver rather than represented as a wider scope. */
  resolveSenderAuditScope: (event: IpcMainInvokeEvent) => AuditSenderScope
  /** Compare canonical workspace identity without trusting renderer strings. */
  workspacePathsEqual: (left: string, right: string) => boolean
  /** Validate and canonicalize the workspace path before reserving the run slot. */
  validateWorkspacePath?: (workspacePath: string) => string
  /** Reserve the single in-flight audit slot synchronously; returns false if one
   * is already running (the orchestrator can't run two at once). */
  beginAuditRun: () => boolean
  /** Release the in-flight slot once run() resolves. */
  endAuditRun: () => void
  /** Mark a run cancelled (cooperative; the orchestrator polls it). */
  markAuditRunCancelled: (auditRunId: string) => void
  /** Clear a stale cancel flag after a run of the same id resolves. */
  clearAuditRunCancelled: (auditRunId: string) => void
}

interface StartAuditRunInput {
  mode?: string
  chatId?: string
  preferredProvider?: string
  workspaceId?: string
  workspacePath?: string
}

function normalizeMode(mode: unknown): AuditMode {
  return mode === 'deep' || mode === 'release' ? mode : 'quick'
}

const AUDIT_SCOPE_ERROR = 'Audit run is unavailable to this renderer.'

function auditRecordMatchesScope(
  scope: AuditSenderScope,
  record: AuditRunRecord,
  workspacePathsEqual: AuditHandlerDeps['workspacePathsEqual']
): boolean {
  if (scope.kind === 'main') return true
  if (record.chatId !== scope.chatId) return false
  if (!workspacePathsEqual(record.workspacePath, scope.workspacePath)) return false
  if (record.workspaceId && scope.workspaceId && record.workspaceId !== scope.workspaceId) {
    return false
  }
  return true
}

function assertAuditRecordScope(
  scope: AuditSenderScope,
  record: AuditRunRecord | null,
  workspacePathsEqual: AuditHandlerDeps['workspacePathsEqual']
): asserts record is AuditRunRecord {
  if (!record || !auditRecordMatchesScope(scope, record, workspacePathsEqual)) {
    throw new Error(AUDIT_SCOPE_ERROR)
  }
}

export function registerAuditHandlers(deps: AuditHandlerDeps): void {
  const {
    getAuditOrchestrator,
    getAuditRun,
    getAuditRuns,
    resolveSenderAuditScope,
    workspacePathsEqual,
    validateWorkspacePath,
    beginAuditRun,
    endAuditRun,
    markAuditRunCancelled,
    clearAuditRunCancelled
  } = deps

  ipcMain.handle('audit-run:start', async (event, input: StartAuditRunInput) => {
    const scope = resolveSenderAuditScope(event)
    const chatId = requireNonEmptyString(input?.chatId, 'chatId')
    const rawWorkspacePath = requireNonEmptyString(input?.workspacePath, 'workspacePath')
    const workspacePath = validateWorkspacePath
      ? validateWorkspacePath(rawWorkspacePath)
      : rawWorkspacePath
    const requestedWorkspaceId = optionalString(input?.workspaceId)
    if (scope.kind === 'chat') {
      if (chatId !== scope.chatId || !workspacePathsEqual(workspacePath, scope.workspacePath)) {
        throw new Error(AUDIT_SCOPE_ERROR)
      }
      if (requestedWorkspaceId && requestedWorkspaceId !== scope.workspaceId) {
        throw new Error(AUDIT_SCOPE_ERROR)
      }
    }
    const start: StartAuditInput = {
      mode: normalizeMode(input?.mode),
      chatId,
      workspacePath,
      ...(optionalString(input?.preferredProvider)
        ? { preferredProvider: assertProviderId(input!.preferredProvider) }
        : {}),
      ...(scope.kind === 'chat' && scope.workspaceId
        ? { workspaceId: scope.workspaceId }
        : requestedWorkspaceId
          ? { workspaceId: requestedWorkspaceId }
          : {})
    }
    const orchestrator = getAuditOrchestrator()
    if (!orchestrator) {
      throw new Error('Audit orchestrator is not ready yet.')
    }
    // Reserve the single in-flight slot BEFORE awaiting anything — a second
    // overlapping /audit would otherwise clobber the orchestrator's per-run
    // state. All synchronous input validation is already complete here, so a
    // bad request cannot leak the reserved slot before the finally block is
    // installed.
    if (!beginAuditRun()) {
      throw new Error('An audit is already running — wait for it to finish or cancel it first.')
    }
    // The orchestrator creates the run record up front (status 'planning') and
    // pushes it via onUpdate (which the renderer observes through
    // 'audit-run-changed'); run() resolves with the terminal record. The live
    // run id is tracked by onUpdate, so mid-run cancel keys off the broadcast id.
    let record: AuditRunRecord | null = null
    try {
      record = await orchestrator.run(start)
      if (scope.kind === 'chat') {
        assertAuditRecordScope(scope, record, workspacePathsEqual)
      }
      return record
    } finally {
      // run() has resolved (completed / failed / cancelled) — clear the cancel
      // flag for this id so a later run reusing the (recycled) id starts clean,
      // and release the in-flight slot so the next audit can start.
      if (record) clearAuditRunCancelled(record.id)
      endAuditRun()
    }
  })

  ipcMain.handle('audit-run:cancel', async (event, auditRunId: string) => {
    const scope = resolveSenderAuditScope(event)
    const id = requireNonEmptyString(auditRunId, 'auditRunId')
    if (scope.kind === 'chat') {
      assertAuditRecordScope(scope, getAuditRun(id), workspacePathsEqual)
    }
    markAuditRunCancelled(id)
    return { ok: true }
  })

  ipcMain.handle('get-audit-run', async (event, auditRunId: string) => {
    const scope = resolveSenderAuditScope(event)
    const id = requireNonEmptyString(auditRunId, 'auditRunId')
    const record = getAuditRun(id)
    if (scope.kind === 'chat') {
      assertAuditRecordScope(scope, record, workspacePathsEqual)
    }
    return record
  })

  ipcMain.handle('get-audit-runs', async (event, workspaceId?: string) => {
    const scope = resolveSenderAuditScope(event)
    const requestedWorkspaceId = optionalString(workspaceId)
    if (scope.kind === 'main') {
      return getAuditRuns(requestedWorkspaceId)
    }
    if (requestedWorkspaceId && requestedWorkspaceId !== scope.workspaceId) {
      throw new Error(AUDIT_SCOPE_ERROR)
    }
    return getAuditRuns(scope.workspaceId).filter((record) =>
      auditRecordMatchesScope(scope, record, workspacePathsEqual)
    )
  })
}
