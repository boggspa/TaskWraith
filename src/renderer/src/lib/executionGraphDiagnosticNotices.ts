import type { ExecutionGraphDiagnosticsSnapshot } from '../../../main/ipc/executionGraphHandlers'
import type { AppNotificationAction } from '../../../shared/appNotifications'
import type { DynamicAppNotification } from './dynamicAppNotifications'

/**
 * Execution-graph diagnostics as first-class tray notices.
 *
 * The collapsed root aside this replaces showed a count, could not be
 * dismissed, offered nothing to do and pointed at no stack. Each service,
 * repository and startup-recovery diagnostic becomes one notice carrying a
 * severity, the stack id, a bounded message and the actions that resolve it.
 * Derivation is pure, so a snapshot refreshed after a retry or archive simply
 * re-derives: a diagnostic that resolved has no notice any more.
 *
 * A notice id hashes kind + stack id + message. The same refusal reported at
 * every launch therefore keeps the same id (a dismissal outlives the launch,
 * and identical entries in one snapshot collapse into one), while a new
 * message on the same stack surfaces as a fresh notice.
 */

export type ExecutionGraphNoticeKind = 'service' | 'repository' | 'recovery'
export type ExecutionGraphNoticeSeverity = 'warning' | 'error'
export type ExecutionGraphNoticeActionId = 'open-stack' | 'retry-recovery' | 'archive-stack'

export interface ExecutionGraphDiagnosticNotice {
  readonly id: string
  readonly kind: ExecutionGraphNoticeKind
  readonly severity: ExecutionGraphNoticeSeverity
  readonly executionId?: string
  readonly title: string
  /** Redacted and capped at EXECUTION_GRAPH_NOTICE_MESSAGE_MAX_CHARS. */
  readonly message: string
  readonly actions: readonly ExecutionGraphNoticeActionId[]
}

export interface ExecutionGraphNoticeActionHandlers {
  readonly openStack: (executionId: string) => void
  readonly retryRecovery: (executionId: string) => void
  readonly archiveStack: (executionId: string) => void
}

export const EXECUTION_GRAPH_NOTICE_MESSAGE_MAX_CHARS = 512
export const EXECUTION_GRAPH_NOTICE_ID_PREFIX = 'stack-diagnostic-'

export const EXECUTION_GRAPH_NOTICE_ACTION_LABELS: Readonly<
  Record<ExecutionGraphNoticeActionId, string>
> = {
  'open-stack': 'Open stack',
  'retry-recovery': 'Retry recovery',
  'archive-stack': 'Archive stack'
}

/** Quarantined ledgers are unreadable: nothing in the run vocabulary can open or close them. */
const REPOSITORY_ACTIONS: readonly ExecutionGraphNoticeActionId[] = []
const RECOVERY_ACTIONS: readonly ExecutionGraphNoticeActionId[] = [
  'open-stack',
  'retry-recovery',
  'archive-stack'
]

/** FNV-1a over UTF-16 code units: a stable, dependency-free notice id. */
function fnv1a(key: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function noticeId(key: string): string {
  return `${EXECUTION_GRAPH_NOTICE_ID_PREFIX}${fnv1a(key)}${fnv1a([...key].reverse().join(''))}`
}

/**
 * One notice per distinct (kind, stack id, message); order follows the
 * snapshot: service first, then repository, then recovery.
 */
export function deriveExecutionGraphDiagnosticNotices(
  snapshot: ExecutionGraphDiagnosticsSnapshot | null | undefined,
  redact: (value: string) => string = (value) => value
): ExecutionGraphDiagnosticNotice[] {
  if (!snapshot) return []
  const bounded = (value: unknown): string =>
    redact(typeof value === 'string' ? value : String(value ?? '')).slice(
      0,
      EXECUTION_GRAPH_NOTICE_MESSAGE_MAX_CHARS
    )
  const byKey = new Map<string, ExecutionGraphDiagnosticNotice>()
  const add = (notice: Omit<ExecutionGraphDiagnosticNotice, 'id'>): void => {
    const key = JSON.stringify([notice.kind, notice.executionId ?? '', notice.message])
    if (byKey.has(key)) return
    byKey.set(key, Object.freeze({ id: noticeId(key), ...notice }))
  }
  for (const diagnostic of snapshot.serviceDiagnostics ?? []) {
    add({
      kind: 'service',
      severity: 'error',
      title: 'Stack service needs attention',
      message: bounded(diagnostic.message),
      actions: []
    })
  }
  for (const diagnostic of snapshot.repositoryDiagnostics ?? []) {
    add({
      kind: 'repository',
      severity: 'error',
      executionId: diagnostic.executionId,
      title: 'Stack history is damaged',
      message: bounded(diagnostic.message),
      actions: REPOSITORY_ACTIONS
    })
  }
  for (const diagnostic of snapshot.recoveryDiagnostics ?? []) {
    add({
      kind: 'recovery',
      severity: 'warning',
      executionId: diagnostic.executionId,
      title: 'Stack recovery paused',
      message: bounded(diagnostic.message),
      actions: RECOVERY_ACTIONS
    })
  }
  return [...byKey.values()]
}

/**
 * The tray cards for those notices. `failures` carries the last refused
 * action per stack (an archive the coordinator would not close, a retry that
 * threw) so the reason lands on the notice itself rather than in a thread log
 * the orphan does not have.
 */
export function executionGraphDiagnosticAppNotifications(
  notices: readonly ExecutionGraphDiagnosticNotice[],
  handlers: ExecutionGraphNoticeActionHandlers,
  failures: Readonly<Record<string, string>> = {}
): DynamicAppNotification[] {
  return notices.map((notice) => {
    const executionId = notice.executionId
    const failure = executionId ? failures[executionId] : undefined
    const stack = executionId ? `Stack ${executionId}: ` : ''
    const actions = notice.actions.map(
      (id): AppNotificationAction => ({
        id,
        label: EXECUTION_GRAPH_NOTICE_ACTION_LABELS[id],
        ...(id === 'archive-stack' ? { tone: 'danger' as const } : {})
      })
    )
    return {
      id: notice.id,
      kind: notice.severity === 'error' ? 'error' : 'warning',
      title: notice.title,
      body: `${stack}${notice.message}${failure ? ` ${failure}` : ''}`,
      dismissible: true,
      ...(actions.length > 0 ? { actions } : {}),
      onAction: (actionId: string): void => {
        if (!executionId) return
        if (!notice.actions.includes(actionId as ExecutionGraphNoticeActionId)) return
        if (actionId === 'open-stack') handlers.openStack(executionId)
        else if (actionId === 'retry-recovery') handlers.retryRecovery(executionId)
        else if (actionId === 'archive-stack') handlers.archiveStack(executionId)
      }
    }
  })
}

/** The failures map without one stack's entry; the same object when it had none. */
export function clearExecutionGraphNoticeFailure(
  failures: Readonly<Record<string, string>>,
  executionId: string
): Readonly<Record<string, string>> {
  if (!(executionId in failures)) return failures
  const next = { ...failures }
  delete next[executionId]
  return next
}
