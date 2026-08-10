import type { SignedChannelAgentPost } from '../../shared/collaboration/ChannelAgentProtocol'
import type { ProviderId } from '../store/types'
import type { ChannelAuditInput, ChannelAuditLike } from './ChannelAuditLog'
import type { ChannelAgentDispatchConsumption } from './ChannelAgentAuthorityState'
import { channelAgentDispatchAuditDedupeKey } from './ChannelAgentDispatchCoordinator'
import {
  ChannelAgentDispatchJournalState,
  type ChannelAgentDispatchAbandonReason,
  type ChannelAgentDispatchJournalBinding,
  type ChannelAgentDispatchJournalSnapshot,
  type ChannelAgentDispatchRecoveryDirective,
  type ChannelAgentDispatchTerminalInput
} from './ChannelAgentDispatchJournalState'
import type { ChannelAgentDispatchJournalStore } from './ChannelAgentDispatchJournalStore'
import type { ChannelAppendResult } from './ChannelMessageLog'

const MAX_RECOVERY_TRANSITIONS = 12

type JournalPort = Pick<
  ChannelAgentDispatchJournalStore,
  | 'listChannel'
  | 'snapshot'
  | 'commitConsumption'
  | 'recordTerminal'
  | 'recordSignedPost'
  | 'recordPosted'
  | 'abandon'
  | 'complete'
>

export type ChannelAgentConsumptionInspection =
  | { readonly kind: 'found'; readonly consumption: ChannelAgentDispatchConsumption }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unavailable' }

export type ChannelAgentReservedRecoveryResult =
  | { readonly kind: 'retried' }
  | { readonly kind: 'retained' }

export type ChannelAgentRunReconciliation =
  | { readonly kind: 'active' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'definitively_absent' }
  | {
      readonly kind: 'terminal'
      readonly runId: string
      readonly provider: ProviderId
      readonly terminal: ChannelAgentDispatchTerminalInput
    }

export type ChannelAgentTerminalPostRecovery =
  | { readonly kind: 'signed'; readonly signedPost: SignedChannelAgentPost }
  | { readonly kind: 'denied' }
  | { readonly kind: 'unavailable' }

export interface ChannelAgentDispatchRecoveryOptions {
  readonly journal: JournalPort
  /** Must distinguish authoritative absence from unavailable/corrupt authority. */
  readonly inspectConsumption: (
    snapshot: ChannelAgentDispatchJournalSnapshot
  ) => ChannelAgentConsumptionInspection | Promise<ChannelAgentConsumptionInspection>
  /** Re-admits only a still-reserved trigger through the normal production path. */
  readonly retryReserved: (
    snapshot: ChannelAgentDispatchJournalSnapshot
  ) => ChannelAgentReservedRecoveryResult | Promise<ChannelAgentReservedRecoveryResult>
  /** Never launches. It may only inspect the exact deterministic run id. */
  readonly reconcileRun: (
    snapshot: ChannelAgentDispatchJournalSnapshot
  ) => ChannelAgentRunReconciliation | Promise<ChannelAgentRunReconciliation>
  readonly signTerminalPost: (args: {
    readonly snapshot: ChannelAgentDispatchJournalSnapshot
    readonly at: number
  }) => ChannelAgentTerminalPostRecovery | Promise<ChannelAgentTerminalPostRecovery>
  readonly appendSignedPost: (args: {
    readonly signedPost: SignedChannelAgentPost
    readonly now: number
  }) => ChannelAppendResult | Promise<ChannelAppendResult>
  readonly audit: ChannelAuditLike
  readonly now?: () => number
}

export type ChannelAgentDispatchRecoveryDisposition = 'completed' | 'retained'

export type ChannelAgentDispatchRecoveryCode =
  | 'completed_abandoned'
  | 'completed_posted'
  | 'completed_reserved_retry'
  | 'consumption_unavailable'
  | 'post_append_unavailable'
  | 'recovery_failed'
  | 'reserved_retained'
  | 'reserved_retry_incomplete'
  | 'run_active'
  | 'run_unavailable'
  | 'signing_unavailable'

export interface ChannelAgentDispatchRecoveryItem {
  readonly channelId: string
  readonly dispatchId: string
  readonly runId: string
  readonly initialDirective: ChannelAgentDispatchRecoveryDirective
  readonly finalDirective: ChannelAgentDispatchRecoveryDirective | null
  readonly disposition: ChannelAgentDispatchRecoveryDisposition
  readonly code: ChannelAgentDispatchRecoveryCode
}

export interface ChannelAgentDispatchRecoveryReport {
  readonly channelId: string
  readonly items: readonly ChannelAgentDispatchRecoveryItem[]
  readonly completed: number
  readonly retained: number
}

export type ChannelAgentDispatchRecoveryErrorCode =
  | 'busy'
  | 'invalid_channel'
  | 'invalid_options'
  | 'storage_unavailable'

export class ChannelAgentDispatchRecoveryError extends Error {
  constructor(
    readonly code: ChannelAgentDispatchRecoveryErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ChannelAgentDispatchRecoveryError'
  }
}

function recoveryError(
  code: ChannelAgentDispatchRecoveryErrorCode,
  message: string,
  _cause?: unknown
): ChannelAgentDispatchRecoveryError {
  // Persistence/provider failures may contain prompt, output, or local paths.
  return new ChannelAgentDispatchRecoveryError(code, message)
}

function isIdentifier(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value
  ) {
    return false
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function lastAt(snapshot: ChannelAgentDispatchJournalSnapshot): number {
  return snapshot.events.at(-1)?.at ?? snapshot.binding.reservedAt
}

function directive(
  snapshot: ChannelAgentDispatchJournalSnapshot
): ChannelAgentDispatchRecoveryDirective {
  return ChannelAgentDispatchJournalState.restore(snapshot).recoveryDirective()
}

function strictSnapshot(
  snapshot: ChannelAgentDispatchJournalSnapshot,
  expected: ChannelAgentDispatchJournalBinding
): ChannelAgentDispatchJournalSnapshot {
  const state = ChannelAgentDispatchJournalState.restore(snapshot)
  const binding = state.binding()
  if (JSON.stringify(binding) !== JSON.stringify(expected)) {
    throw new Error('rebound journal')
  }
  return state.snapshot()
}

function terminalEvent(snapshot: ChannelAgentDispatchJournalSnapshot) {
  return snapshot.events.find((event) => event.kind === 'run.terminal')
}

function launchEvent(snapshot: ChannelAgentDispatchJournalSnapshot) {
  return snapshot.events.find((event) => event.kind === 'launch.intent')
}

function signedEvent(snapshot: ChannelAgentDispatchJournalSnapshot) {
  return snapshot.events.find((event) => event.kind === 'post.signed')
}

function committedEvent(snapshot: ChannelAgentDispatchJournalSnapshot) {
  return snapshot.events.find((event) => event.kind === 'post.committed')
}

function abandonedEvent(snapshot: ChannelAgentDispatchJournalSnapshot) {
  return snapshot.events.find((event) => event.kind === 'dispatch.abandoned')
}

function completeCode(
  snapshot: ChannelAgentDispatchJournalSnapshot
): Extract<ChannelAgentDispatchRecoveryCode, 'completed_abandoned' | 'completed_posted'> {
  return abandonedEvent(snapshot) ? 'completed_abandoned' : 'completed_posted'
}

/**
 * Root-free restart reconciler. It can invoke the normal dispatcher only for a
 * pristine reservation. Once a consumption intent exists, every path either
 * proves durable state, resumes signing/idempotent append, or retains evidence;
 * it never invokes provider dispatch.
 */
export class ChannelAgentDispatchRecovery {
  private readonly activeChannels = new Set<string>()
  private readonly now: () => number

  constructor(private readonly options: ChannelAgentDispatchRecoveryOptions) {
    if (
      !options ||
      typeof options.journal?.listChannel !== 'function' ||
      typeof options.journal?.snapshot !== 'function' ||
      typeof options.journal?.commitConsumption !== 'function' ||
      typeof options.journal?.recordTerminal !== 'function' ||
      typeof options.journal?.recordSignedPost !== 'function' ||
      typeof options.journal?.recordPosted !== 'function' ||
      typeof options.journal?.abandon !== 'function' ||
      typeof options.journal?.complete !== 'function' ||
      typeof options.inspectConsumption !== 'function' ||
      typeof options.retryReserved !== 'function' ||
      typeof options.reconcileRun !== 'function' ||
      typeof options.signTerminalPost !== 'function' ||
      typeof options.appendSignedPost !== 'function' ||
      typeof options.audit?.append !== 'function'
    ) {
      throw recoveryError(
        'invalid_options',
        'Channel agent dispatch recovery ports are unavailable'
      )
    }
    this.now = options.now ?? Date.now
  }

  async recoverChannel(channelId: string): Promise<ChannelAgentDispatchRecoveryReport> {
    if (!isIdentifier(channelId)) {
      throw recoveryError('invalid_channel', 'Channel agent recovery Channel id is invalid')
    }
    if (this.activeChannels.has(channelId)) {
      throw recoveryError('busy', 'Channel agent recovery is already active for this Channel')
    }
    this.activeChannels.add(channelId)
    try {
      let snapshots: ChannelAgentDispatchJournalSnapshot[]
      try {
        snapshots = this.options.journal.listChannel(channelId)
      } catch (error) {
        throw recoveryError(
          'storage_unavailable',
          'Channel agent recovery journals are unavailable',
          error
        )
      }
      const seen = new Set<string>()
      const items: ChannelAgentDispatchRecoveryItem[] = []
      for (const candidate of snapshots) {
        let state: ChannelAgentDispatchJournalState
        try {
          state = ChannelAgentDispatchJournalState.restore(candidate)
        } catch (error) {
          throw recoveryError(
            'storage_unavailable',
            'Channel agent recovery journal is invalid',
            error
          )
        }
        const binding = state.binding()
        if (binding.channelId !== channelId || seen.has(binding.dispatchId)) {
          throw recoveryError(
            'storage_unavailable',
            'Channel agent recovery journal listing is inconsistent'
          )
        }
        seen.add(binding.dispatchId)
        items.push(await this.recoverOne(state.snapshot()))
      }
      return Object.freeze({
        channelId,
        items: Object.freeze(items),
        completed: items.filter((item) => item.disposition === 'completed').length,
        retained: items.filter((item) => item.disposition === 'retained').length
      })
    } finally {
      this.activeChannels.delete(channelId)
    }
  }

  private async recoverOne(
    seed: ChannelAgentDispatchJournalSnapshot
  ): Promise<ChannelAgentDispatchRecoveryItem> {
    let snapshot = ChannelAgentDispatchJournalState.restore(seed).snapshot()
    const binding = snapshot.binding
    const initialDirective = directive(snapshot)
    const retained = (
      code: Exclude<
        ChannelAgentDispatchRecoveryCode,
        'completed_abandoned' | 'completed_posted' | 'completed_reserved_retry'
      >
    ): ChannelAgentDispatchRecoveryItem => ({
      channelId: binding.channelId,
      dispatchId: binding.dispatchId,
      runId: binding.runId,
      initialDirective,
      finalDirective: directive(snapshot),
      disposition: 'retained',
      code
    })
    const completed = (
      code: Extract<
        ChannelAgentDispatchRecoveryCode,
        'completed_abandoned' | 'completed_posted' | 'completed_reserved_retry'
      >
    ): ChannelAgentDispatchRecoveryItem => ({
      channelId: binding.channelId,
      dispatchId: binding.dispatchId,
      runId: binding.runId,
      initialDirective,
      finalDirective: null,
      disposition: 'completed',
      code
    })

    try {
      for (let transition = 0; transition < MAX_RECOVERY_TRANSITIONS; transition += 1) {
        const state = ChannelAgentDispatchJournalState.restore(snapshot)
        switch (state.recoveryDirective()) {
          case 'retry_before_consumption': {
            const result = await this.options.retryReserved(snapshot)
            if (result?.kind === 'retained') return retained('reserved_retained')
            if (result?.kind !== 'retried') return retained('recovery_failed')
            const next = this.read(binding)
            if (!next) return completed('completed_reserved_retry')
            snapshot = next
            if (directive(snapshot) === 'retry_before_consumption') {
              return retained('reserved_retry_incomplete')
            }
            break
          }
          case 'inspect_atomic_consumption': {
            const inspection = await this.options.inspectConsumption(snapshot)
            if (inspection?.kind === 'unavailable') {
              return retained('consumption_unavailable')
            }
            if (inspection?.kind === 'found') {
              snapshot = strictSnapshot(
                this.options.journal.commitConsumption(
                  binding.channelId,
                  binding.dispatchId,
                  inspection.consumption
                ),
                binding
              )
              break
            }
            if (inspection?.kind !== 'absent') return retained('recovery_failed')
            snapshot = this.abandon(snapshot, 'preflight_declined')
            break
          }
          case 'abandon_consumed_without_launch':
            snapshot = this.abandon(snapshot, 'consumed_before_launch_recovery')
            break
          case 'reconcile_exact_run_without_redispatch': {
            const reconciliation = await this.options.reconcileRun(snapshot)
            if (reconciliation?.kind === 'active') return retained('run_active')
            if (reconciliation?.kind === 'unavailable') return retained('run_unavailable')
            if (reconciliation?.kind === 'definitively_absent') {
              snapshot = this.abandon(
                snapshot,
                state.phase() === 'launching'
                  ? 'launch_outcome_unknown'
                  : 'run_terminal_unavailable'
              )
              break
            }
            if (reconciliation?.kind !== 'terminal') return retained('recovery_failed')
            const launch = launchEvent(snapshot)
            if (
              !launch ||
              reconciliation.runId !== binding.runId ||
              reconciliation.provider !== launch.seal.provider
            ) {
              return retained('recovery_failed')
            }
            snapshot = strictSnapshot(
              this.options.journal.recordTerminal(
                binding.channelId,
                binding.dispatchId,
                reconciliation.terminal
              ),
              binding
            )
            break
          }
          case 'sign_terminal_post': {
            const signing = await this.options.signTerminalPost({
              snapshot,
              at: this.currentTime(lastAt(snapshot))
            })
            if (signing?.kind === 'unavailable') return retained('signing_unavailable')
            if (signing?.kind === 'denied') {
              snapshot = this.abandon(snapshot, 'post_authority_unavailable')
              break
            }
            if (signing?.kind !== 'signed') return retained('recovery_failed')
            snapshot = strictSnapshot(
              this.options.journal.recordSignedPost(
                binding.channelId,
                binding.dispatchId,
                signing.signedPost
              ),
              binding
            )
            break
          }
          case 'append_signed_post': {
            const signed = signedEvent(snapshot)
            if (!signed) return retained('recovery_failed')
            let appended: ChannelAppendResult
            try {
              appended = await this.options.appendSignedPost({
                signedPost: signed.signedPost,
                now: this.currentTime(lastAt(snapshot))
              })
            } catch {
              return retained('post_append_unavailable')
            }
            if (appended.record.kind !== 'agent.text') return retained('recovery_failed')
            snapshot = strictSnapshot(
              this.options.journal.recordPosted(
                binding.channelId,
                binding.dispatchId,
                appended.record,
                appended.deduplicated
              ),
              binding
            )
            break
          }
          case 'complete': {
            this.auditTerminal(snapshot)
            const code = completeCode(snapshot)
            const removed = this.options.journal.complete(binding.channelId, binding.dispatchId)
            if (!removed && this.options.journal.snapshot(binding.channelId, binding.dispatchId)) {
              return retained('recovery_failed')
            }
            return completed(code)
          }
        }
      }
    } catch {
      return retained('recovery_failed')
    }
    return retained('recovery_failed')
  }

  private read(
    binding: ChannelAgentDispatchJournalBinding
  ): ChannelAgentDispatchJournalSnapshot | null {
    const snapshot = this.options.journal.snapshot(binding.channelId, binding.dispatchId)
    return snapshot ? strictSnapshot(snapshot, binding) : null
  }

  private abandon(
    snapshot: ChannelAgentDispatchJournalSnapshot,
    reason: ChannelAgentDispatchAbandonReason
  ): ChannelAgentDispatchJournalSnapshot {
    return strictSnapshot(
      this.options.journal.abandon(
        snapshot.binding.channelId,
        snapshot.binding.dispatchId,
        reason,
        this.currentTime(lastAt(snapshot))
      ),
      snapshot.binding
    )
  }

  private currentTime(floor: number): number {
    let value: number
    try {
      value = this.now()
    } catch {
      throw new Error('clock unavailable')
    }
    if (!isTimestamp(value)) throw new Error('clock unavailable')
    return Math.max(value, floor)
  }

  private auditTerminal(snapshot: ChannelAgentDispatchJournalSnapshot): void {
    const binding = snapshot.binding
    const launch = launchEvent(snapshot)
    const terminal = terminalEvent(snapshot)
    const committed = committedEvent(snapshot)
    const abandoned = abandonedEvent(snapshot)
    if (launch) {
      this.appendAudit({
        kind: 'agent.dispatch.started',
        binding,
        code: launch.seal.provider,
        contentHash: binding.triggerContentHash,
        detail: `provider=${launch.seal.provider}`,
        at: launch.at
      })
    }
    if (committed) {
      const signed = signedEvent(snapshot)
      if (!launch || !terminal || !signed) throw new Error('posted journal evidence missing')
      this.appendAudit({
        kind: 'agent.dispatch.completed',
        binding,
        code: terminal.status,
        contentHash: terminal.contentHash,
        detail: `provider=${launch.seal.provider};status=${terminal.status}`,
        at: terminal.at
      })
      this.appendAudit({
        kind: 'agent.post.committed',
        binding,
        code: committed.deduplicated ? 'deduplicated' : 'appended',
        contentHash: signed.signedPost.post.contentHash,
        detail: `sequence=${committed.messageSequence}`,
        at: committed.at
      })
      return
    }
    if (!abandoned) throw new Error('terminal journal evidence missing')
    this.appendAudit({
      kind: 'agent.dispatch.failed',
      binding,
      code: abandoned.reason,
      contentHash: terminal?.contentHash ?? binding.triggerContentHash,
      at: abandoned.at
    })
  }

  private appendAudit(args: {
    readonly kind: Extract<
      ChannelAuditInput['kind'],
      | 'agent.dispatch.started'
      | 'agent.dispatch.completed'
      | 'agent.dispatch.failed'
      | 'agent.post.committed'
    >
    readonly binding: ChannelAgentDispatchJournalBinding
    readonly code: string
    readonly contentHash: string
    readonly detail?: string
    readonly at: number
  }): void {
    this.options.audit.append({
      kind: args.kind,
      channelId: args.binding.channelId,
      memberId: args.binding.agentMemberId,
      code: args.code,
      contentHash: args.contentHash,
      ...(args.detail ? { detail: args.detail } : {}),
      dedupeKey: channelAgentDispatchAuditDedupeKey(args.kind, args.binding.dispatchId),
      at: args.at
    })
  }
}
