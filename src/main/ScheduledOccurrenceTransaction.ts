import type { ScheduledOccurrenceRootOwner, ScheduledTask } from './store/types'
import type { ScheduledOccurrenceTerminalStatus } from './ScheduledOccurrenceMutationSemantics'
import {
  createScheduledOccurrenceOwner,
  deriveScheduledWorkflowOccurrence,
  ScheduledOccurrenceOwnerRegistry,
  type ScheduledOccurrenceOwner,
  type ScheduledWorkflowOccurrence
} from './ScheduledOccurrenceOwnerRegistry'

type ExactOccurrenceOptions = {
  expectedWorkflowOccurrence?: ScheduledWorkflowOccurrence
}

export interface ScheduledOccurrenceTransactionStore {
  claimDueScheduledTaskForRun: (
    taskId: string,
    options: ExactOccurrenceOptions & { nowMs: number; runId: string }
  ) => ScheduledTask | null
  heartbeatScheduledTaskForRun: (
    taskId: string,
    options: ExactOccurrenceOptions & { runId: string; at?: string }
  ) => ScheduledTask | null
  settleScheduledTaskForRun: (
    taskId: string,
    options: ExactOccurrenceOptions & {
      runId: string
      status: ScheduledOccurrenceTerminalStatus
      completedAt?: string
      lastError?: string
    }
  ) => ScheduledTask | null
}

export interface ScheduledOccurrenceTransactionDeps {
  store: ScheduledOccurrenceTransactionStore
  owners: ScheduledOccurrenceOwnerRegistry
  /** Main-owned workflow lookup; callers do not choose their terminal family. */
  resolveRootOwner: (task: ScheduledTask) => ScheduledOccurrenceRootOwner
  createRunId: (task: ScheduledTask, rootOwner: ScheduledOccurrenceRootOwner) => string
  now?: () => number
}

/**
 * Main-process lifecycle transaction for one scheduled occurrence.
 *
 * The durable AppStore claim is synchronous. Registration follows on the same
 * stack, before a caller can await or enter a provider adapter. Every later
 * mutation carries the same run id and workflow tuple and releases process-local
 * ownership only after the durable terminal mutation succeeds.
 */
export class ScheduledOccurrenceTransaction {
  private readonly now: () => number

  constructor(private readonly deps: ScheduledOccurrenceTransactionDeps) {
    this.now = deps.now ?? Date.now
  }

  claim(task: ScheduledTask): ScheduledOccurrenceOwner | null {
    const rootOwner = this.deps.resolveRootOwner(task)
    const expectedWorkflowOccurrence = deriveScheduledWorkflowOccurrence(task)
    const runId = this.deps.createRunId(task, rootOwner)
    const claimed = this.deps.store.claimDueScheduledTaskForRun(task.id, {
      nowMs: this.now(),
      runId,
      ...(expectedWorkflowOccurrence ? { expectedWorkflowOccurrence } : {})
    })
    if (!claimed) return null

    try {
      return this.deps.owners.register(
        createScheduledOccurrenceOwner(claimed, rootOwner)
      )
    } catch (error) {
      const rolledBack = this.deps.store.settleScheduledTaskForRun(claimed.id, {
        runId,
        status: 'failed',
        completedAt: new Date(this.now()).toISOString(),
        lastError: 'Scheduled occurrence owner registration failed.',
        ...(expectedWorkflowOccurrence ? { expectedWorkflowOccurrence } : {})
      })
      if (!rolledBack) {
        throw new Error('Scheduled occurrence claim could not be rolled back.', {
          cause: error
        })
      }
      throw error
    }
  }

  heartbeat(owner: ScheduledOccurrenceOwner, at?: string): ScheduledTask | null {
    if (!this.isLiveOwner(owner)) return null
    return this.deps.store.heartbeatScheduledTaskForRun(owner.taskId, {
      runId: owner.ownerRunId,
      ...(at ? { at } : {}),
      ...(owner.workflowOccurrence
        ? { expectedWorkflowOccurrence: owner.workflowOccurrence }
        : {})
    })
  }

  settle(
    owner: ScheduledOccurrenceOwner,
    status: ScheduledOccurrenceTerminalStatus,
    options: { completedAt?: string; lastError?: string } = {}
  ): ScheduledTask | null {
    if (!this.isLiveOwner(owner)) return null
    const settled = this.deps.store.settleScheduledTaskForRun(owner.taskId, {
      runId: owner.ownerRunId,
      status,
      ...(options.completedAt ? { completedAt: options.completedAt } : {}),
      ...(options.lastError !== undefined ? { lastError: options.lastError } : {}),
      ...(owner.workflowOccurrence
        ? { expectedWorkflowOccurrence: owner.workflowOccurrence }
        : {})
    })
    if (settled) this.deps.owners.release(owner)
    return settled
  }

  private isLiveOwner(owner: ScheduledOccurrenceOwner): boolean {
    return this.deps.owners.lookupByOwnerRunId(owner.ownerRunId) === owner
  }
}
