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
import { validateHostCommandArguments } from './HostCommandArguments'
import type { HostCommandExecutionResult } from './HostCommandExecutionResult'
import type { HostProfileDomainStore } from './HostProfileDomainStore'
import {
  consumeHostThreadRecordTransfer,
  HostThreadRecordTransferIntegrityError,
  HostThreadRecordTransferMissingError
} from './HostThreadRecordTransfer'

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
}

function failed(errorCode: string): HostCommandExecutionResult {
  return { status: 'failed', errorCode }
}

export class HostProfileRecordCommandExecutor {
  private readonly profilePath: string
  private readonly store: HostProfileRecordCommandStore

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
  }

  execute(command: HostCommand): HostCommandExecutionResult {
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

  private persistTransferredThreadRecord(command: HostCommand): HostCommandExecutionResult {
    if (!this.profilePath) return failed('thread_record_transfer_unavailable')

    let record: Record<string, unknown>
    try {
      record = consumeHostThreadRecordTransfer({
        profilePath: this.profilePath,
        descriptor: {
          transferId: command.arguments.transferId as string,
          sha256: command.arguments.sha256 as string,
          byteLength: command.arguments.byteLength as number
        }
      }).record
    } catch (error) {
      if (error instanceof HostThreadRecordTransferMissingError) {
        return failed('thread_record_transfer_missing')
      }
      if (error instanceof HostThreadRecordTransferIntegrityError) {
        return failed('thread_record_transfer_integrity')
      }
      return failed('thread_record_transfer_failed')
    }

    try {
      this.store.persistThreadRecord({
        threadId: command.target.threadId,
        record,
        expectedRevision: command.arguments.expectedRevision as number
      })
      return { status: 'succeeded', resultSummary: 'thread_record_persisted' }
    } catch (error) {
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
