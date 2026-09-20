/**
 * Host-owned profile record mutations shared by the standalone Node Host and
 * the in-process Desktop compatibility Host.
 *
 * Keeping this executor in host-runtime prevents the two authorities from
 * drifting: both validate the same command, consume the same owner-only thread
 * transfer artifact, call the same lease-gated profile store, and return the
 * same stable receipt codes.
 */

import type { HostCommand } from '../shared/hostProtocol'
import type { WorkSpanRecorder } from '../host-shared/perf/WorkSpanRecorder'
import { validateHostCommandArguments } from './HostCommandArguments'
import type { HostCommandExecutionResult } from './HostCommandExecutionResult'
import type { HostProfileDomainStore } from './HostProfileDomainStore'
import {
  HostThreadRecordTransferIntegrityError,
  HostThreadRecordTransferMissingError,
  removeHostThreadRecordTransfer,
  type HostThreadRecordTransferIdentity
} from './HostThreadRecordTransfer'
import {
  readHostThreadRecordTransferOffLoop,
  type DecodedHostThreadRecordTransfer
} from './HostThreadRecordTransferWorker'

export const HOST_PROFILE_RECORD_MUTATION_NAMES = [
  'thread.record.persist',
  'thread.record.delete',
  'workspace.record.upsert',
  'workspace.record.remove',
  'workspace.records.clear'
] as const satisfies readonly HostCommand['name'][]

export type HostProfileRecordMutationName = (typeof HOST_PROFILE_RECORD_MUTATION_NAMES)[number]

const HOST_PROFILE_RECORD_MUTATION_NAME_SET = new Set<HostCommand['name']>(
  HOST_PROFILE_RECORD_MUTATION_NAMES
)

export function isHostProfileRecordMutationName(
  name: HostCommand['name']
): name is HostProfileRecordMutationName {
  return HOST_PROFILE_RECORD_MUTATION_NAME_SET.has(name)
}

export type HostProfileRecordCommandStore = Pick<
  HostProfileDomainStore,
  | 'upsertWorkspaceRecord'
  | 'removeWorkspaceRecord'
  | 'clearWorkspaceRecords'
  | 'deleteThreadRecord'
  | 'persistThreadRecord'
>

export interface HostProfileRecordCommandExecutorOptions {
  /** Canonical profile directory containing owner-only transfer artifacts. */
  readonly profilePath?: string
  readonly store: HostProfileRecordCommandStore
  /** Optional M1 durable_commit sink. Absence is safe. */
  readonly workSpanRecorder?: WorkSpanRecorder
  readonly now?: () => number
  /** Injectable verification seam; production reads/hashes/parses on the worker. */
  readonly readTransfer?: typeof readHostThreadRecordTransferOffLoop
}

function failed(errorCode: string): HostCommandExecutionResult {
  return { status: 'failed', errorCode }
}

/**
 * Best-effort artifact cleanup after verification has bound an identity: by
 * the time this runs the store has either adopted the artifact by rename (the
 * path is gone and this is a no-op) or declined it (the artifact is discarded
 * exactly as a consumed one would be). Never lets cleanup replace the
 * persistence outcome.
 */
function removePublishedTransfer(
  profilePath: string,
  transferId: string,
  expectedIdentity: HostThreadRecordTransferIdentity
): void {
  try {
    removeHostThreadRecordTransfer({ profilePath, transferId, expectedIdentity })
  } catch {
    // The persist result is the reportable outcome; a stranded artifact is
    // owner-only inside the profile and the publisher re-uses no ids.
  }
}

export class HostProfileRecordCommandExecutor {
  private readonly profilePath: string
  private readonly store: HostProfileRecordCommandStore
  private readonly workSpanRecorder?: WorkSpanRecorder
  private readonly now: () => number
  private readonly readTransfer: typeof readHostThreadRecordTransferOffLoop

  constructor(options: HostProfileRecordCommandExecutorOptions) {
    if (
      !options ||
      (options.profilePath !== undefined &&
        (typeof options.profilePath !== 'string' || options.profilePath.length === 0)) ||
      !options.store
    ) {
      throw new Error(
        'HostProfileRecordCommandExecutor requires a store and a valid optional profilePath'
      )
    }
    this.profilePath = options.profilePath ?? ''
    this.store = options.store
    this.workSpanRecorder = options.workSpanRecorder
    this.now = options.now ?? (() => Date.now())
    this.readTransfer = options.readTransfer ?? readHostThreadRecordTransferOffLoop
  }

  /**
   * thread.record.persist → durable write (A1.2 durable_commit). Ends after
   * persistThreadRecord returns; transfer-missing and CAS failures emit nothing.
   */
  private recordDurableCommit(chatId: string, commandId: string, startedAt: number): void {
    if (this.workSpanRecorder === undefined) return
    try {
      this.workSpanRecorder.record({
        chatId,
        runId: commandId,
        kind: 'durable_commit',
        resource: 'host_chain',
        startedAt,
        durationMs: Math.max(0, this.now() - startedAt)
      })
    } catch {
      // Instrumentation must never alter a persist result.
    }
  }

  execute(command: HostCommand): HostCommandExecutionResult | Promise<HostCommandExecutionResult> {
    const validated = validateHostCommandArguments(command)
    if (!validated.ok) return failed('command_invalid')
    const hostCommand = validated.value

    switch (hostCommand.name) {
      case 'workspace.record.upsert':
        return this.upsertWorkspaceRecord(hostCommand)
      case 'workspace.record.remove':
        return this.removeWorkspaceRecord(hostCommand)
      case 'workspace.records.clear':
        return this.clearWorkspaceRecords()
      case 'thread.record.delete':
        return this.deleteThreadRecord(hostCommand)
      case 'thread.record.persist':
        return this.persistTransferredThreadRecord(hostCommand)
      default:
        return failed('command_unsupported')
    }
  }

  private upsertWorkspaceRecord(command: HostCommand): HostCommandExecutionResult {
    try {
      this.store.upsertWorkspaceRecord({
        workspaceId: command.target.workspaceId,
        record: command.arguments as {
          path: string
          displayName: string
          createdAt: number
          lastOpenedAt: number
          pinned: boolean
          branch?: string
          geminiWorktree?: { enabled: boolean; name?: string }
        }
      })
      return { status: 'succeeded', resultSummary: 'workspace_record_upserted' }
    } catch {
      return failed('workspace_record_upsert_failed')
    }
  }

  private removeWorkspaceRecord(command: HostCommand): HostCommandExecutionResult {
    try {
      const removed = this.store.removeWorkspaceRecord(command.target.workspaceId)
      return {
        status: 'succeeded',
        resultSummary: removed ? 'workspace_record_removed' : 'workspace_record_already_absent'
      }
    } catch {
      return failed('workspace_record_remove_failed')
    }
  }

  private clearWorkspaceRecords(): HostCommandExecutionResult {
    try {
      const cleared = this.store.clearWorkspaceRecords()
      return {
        status: 'succeeded',
        resultSummary: cleared > 0 ? 'workspace_records_cleared' : 'workspace_records_already_empty'
      }
    } catch {
      return failed('workspace_records_clear_failed')
    }
  }

  private deleteThreadRecord(command: HostCommand): HostCommandExecutionResult {
    try {
      const deleted = this.store.deleteThreadRecord({
        threadId: command.target.threadId,
        expectedRevision: command.arguments.expectedRevision as number
      })
      return {
        status: 'succeeded',
        resultSummary: deleted ? 'thread_record_deleted' : 'thread_record_already_absent'
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (message === 'Thread persistence revision mismatch') {
        return failed('thread_record_revision_conflict')
      }
      if (message === 'Thread is active') return failed('thread_record_active')
      if (message.startsWith('Invalid ')) return failed('thread_record_invalid')
      return failed('thread_record_delete_failed')
    }
  }

  private persistTransferredThreadRecord(
    command: HostCommand
  ): HostCommandExecutionResult | Promise<HostCommandExecutionResult> {
    if (!this.profilePath) return failed('thread_record_transfer_unavailable')

    const descriptor = {
      transferId: command.arguments.transferId as string,
      sha256: command.arguments.sha256 as string,
      byteLength: command.arguments.byteLength as number
    }
    try {
      const verified = this.readTransfer({
        profilePath: this.profilePath,
        descriptor
      })
      if (verified instanceof Promise) {
        return verified.then(
          (value) => this.persistVerifiedThreadRecord(command, value),
          (error: unknown) => this.transferFailure(error)
        )
      }
      return this.persistVerifiedThreadRecord(command, verified)
    } catch (error) {
      return this.transferFailure(error)
    }
  }

  private transferFailure(error: unknown): HostCommandExecutionResult {
    if (error instanceof HostThreadRecordTransferMissingError) {
      return failed('thread_record_transfer_missing')
    }
    if (error instanceof HostThreadRecordTransferIntegrityError) {
      return failed('thread_record_transfer_integrity')
    }
    return failed('thread_record_transfer_failed')
  }

  private persistVerifiedThreadRecord(
    command: HostCommand,
    verified: DecodedHostThreadRecordTransfer
  ): HostCommandExecutionResult {
    const { record, descriptor } = verified
    try {
      let startedAt: number | undefined
      try {
        startedAt = this.now()
      } catch {
        startedAt = undefined
      }
      this.store.persistThreadRecord({
        threadId: command.target.threadId,
        record,
        expectedRevision: command.arguments.expectedRevision as number,
        // Hand over the verified artifact: when the record is stamped ahead of
        // the CAS base the store adopts the bytes by rename instead of
        // re-serializing, which is what keeps a large-record persist off the
        // Host event loop. Otherwise the store rewrites normally and this
        // best-effort removal discards the artifact either way.
        verifiedTransfer: {
          path: verified.path,
          identity: verified.identity,
          byteLength: descriptor.byteLength
        }
      })
      removePublishedTransfer(this.profilePath, descriptor.transferId, verified.identity)
      if (startedAt !== undefined) {
        this.recordDurableCommit(command.target.threadId, command.commandId, startedAt)
      }
      return { status: 'succeeded', resultSummary: 'thread_record_persisted' }
    } catch (error) {
      removePublishedTransfer(this.profilePath, descriptor.transferId, verified.identity)
      const message = error instanceof Error ? error.message : ''
      if (message === 'Thread persistence revision mismatch' || message === 'Thread is not found') {
        return failed('thread_record_revision_conflict')
      }
      if (message === 'Thread identity mismatch') {
        return failed('thread_record_identity_mismatch')
      }
      if (message.startsWith('Invalid ')) return failed('thread_record_invalid')
      return failed('thread_record_persist_failed')
    }
  }
}
