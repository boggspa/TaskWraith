/**
 * Node-owned pending-interaction registry for provider callbacks.
 *
 * Stores bounded metadata only (id/kind/provider/run/thread/tool/title/summary/
 * options/time). Tool bodies, secrets, and hidden reasoning never enter here.
 * Each entry is settled once by an exact `approval.decide` or `question.answer`
 * command, then reconciled into the projection donor. The registry is in-memory
 * and connection-independent; after Host crash it never replays an interaction
 * unless the provider itself proves a resume token.
 */

import {
  HOST_APPROVAL_DECIDE_DECISIONS,
  HOST_QUESTION_ANSWER_DECISIONS,
  type HostApprovalDecideDecision,
  type HostQuestionAnswerDecision
} from '../shared/hostProtocol'
import type { HostRunEventTarget } from '../host-runtime/HostRunEventTarget'

export interface HostNodePendingInteraction {
  readonly id: string
  readonly kind: 'approval' | 'question'
  readonly providerId: string
  readonly runId: string
  readonly threadId: string
  readonly toolId?: string
  readonly title: string
  readonly summary: string
  readonly options?: readonly string[]
  readonly createdAt: string
}

export interface HostNodePendingInteractionSettled {
  readonly id: string
  readonly kind: HostNodePendingInteraction['kind']
  readonly providerId: string
  readonly runId: string
  readonly threadId: string
}

export interface HostNodeInteractionSettlement {
  readonly id: string
  readonly kind: HostNodePendingInteraction['kind']
  readonly decision: HostApprovalDecideDecision | HostQuestionAnswerDecision
  readonly answer?: string
  readonly actor: HostNodeInteractionActor
}

export interface HostNodeInteractionDecision {
  readonly decision: HostApprovalDecideDecision
  readonly message?: string
}

export interface HostNodeInteractionAnswer {
  readonly decision: HostQuestionAnswerDecision
  readonly answer?: string
}

export interface HostNodeInteractionActor {
  readonly clientId: string
  readonly clientClass: string
  readonly actorId: string
}

export interface HostNodeInteractionResolveContext {
  readonly actor: HostNodeInteractionActor
  readonly target: HostRunEventTarget
}

export interface HostNodeInteractionResolver {
  register(interaction: HostNodePendingInteraction): Promise<HostNodeInteractionSettlement>
}

export interface HostNodeInteractionRegistryOptions {
  /** Maximum pending entries per kind; bounded to avoid unbounded growth. */
  readonly maxPending?: number
  /** Per-interaction timeout in milliseconds; entries reject and remove after this. */
  readonly timeoutMs?: number
  /** Optional hook called when an interaction is registered; domain uses it to reconcile. */
  readonly onRegistered?: (interaction: HostNodePendingInteraction) => void
  /** Optional hook called when an interaction settles; domain uses it to reconcile. */
  readonly onSettled?: (
    settled: HostNodePendingInteractionSettled,
    context: HostNodeInteractionResolveContext
  ) => void
  /** Optional hook called when an interaction is cancelled/times out/evicted. */
  readonly onCancelled?: (settled: HostNodePendingInteractionSettled, reason: string) => void
}

function isCanonicalId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    // eslint-disable-next-line no-control-regex -- Host identifiers reject C0 controls.
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function isValidActor(value: unknown): value is HostNodeInteractionActor {
  if (!value || typeof value !== 'object') return false
  const actor = value as Record<string, unknown>
  return (
    isCanonicalId(actor.clientId) &&
    isCanonicalId(actor.clientClass) &&
    isCanonicalId(actor.actorId)
  )
}

function isValidPending(value: unknown): value is HostNodePendingInteraction {
  if (!value || typeof value !== 'object') return false
  const p = value as Record<string, unknown>
  return (
    isCanonicalId(p.id) &&
    (p.kind === 'approval' || p.kind === 'question') &&
    isCanonicalId(p.providerId) &&
    isCanonicalId(p.runId) &&
    isCanonicalId(p.threadId) &&
    typeof p.title === 'string' &&
    p.title.length > 0 &&
    p.title.length <= 200 &&
    typeof p.summary === 'string' &&
    p.summary.length > 0 &&
    p.summary.length <= 1_000 &&
    (p.toolId === undefined || isCanonicalId(p.toolId)) &&
    (p.options === undefined ||
      (Array.isArray(p.options) &&
        p.options.length <= 16 &&
        p.options.every((o) => isCanonicalId(o)))) &&
    typeof p.createdAt === 'string'
  )
}

class PendingEntry {
  settled = false
  cancelled = false
  private resolvePromise!: (settlement: HostNodeInteractionSettlement) => void
  private rejectPromise!: (error: Error) => void
  readonly promise: Promise<HostNodeInteractionSettlement>
  private timeoutId: ReturnType<typeof setTimeout> | undefined

  constructor(
    readonly interaction: HostNodePendingInteraction,
    private readonly settleCallback: (
      entry: PendingEntry,
      context: HostNodeInteractionResolveContext
    ) => void,
    private readonly cancelCallback: (entry: PendingEntry, reason: string) => void,
    timeoutMs?: number
  ) {
    this.promise = new Promise((resolve, reject) => {
      this.resolvePromise = resolve
      this.rejectPromise = reject
    })
    if (timeoutMs !== undefined && timeoutMs > 0) {
      this.timeoutId = setTimeout(() => {
        this.timeout('HostNodeInteractionRegistry: interaction timed out')
      }, timeoutMs)
      this.timeoutId.unref?.()
    }
  }

  private clearTimeout(): void {
    if (this.timeoutId !== undefined) {
      clearTimeout(this.timeoutId)
      this.timeoutId = undefined
    }
  }

  settle(
    context: HostNodeInteractionResolveContext,
    decision: HostApprovalDecideDecision | HostQuestionAnswerDecision,
    answer?: string
  ): void {
    if (this.settled || this.cancelled) return
    this.settled = true
    this.clearTimeout()
    this.settleCallback(this, context)
    this.resolvePromise({
      id: this.interaction.id,
      kind: this.interaction.kind,
      decision,
      ...(answer !== undefined ? { answer } : {}),
      actor: context.actor
    })
  }

  cancel(reason = 'HostNodeInteractionRegistry: interaction cancelled'): void {
    if (this.settled || this.cancelled) return
    this.cancelled = true
    this.clearTimeout()
    this.cancelCallback(this, reason)
    this.rejectPromise(new Error(reason))
  }

  private timeout(reason: string): void {
    this.cancel(reason)
  }
}

/**
 * In-memory interaction registry. Tool bodies and secrets are excluded by
 * construction; only metadata crosses this boundary.
 */
export class HostNodeInteractionRegistry implements HostNodeInteractionResolver {
  private readonly pending = new Map<string, PendingEntry>()
  private readonly maxPending: number
  private readonly timeoutMs?: number
  private readonly onRegistered?: HostNodeInteractionRegistryOptions['onRegistered']
  private readonly onSettled?: HostNodeInteractionRegistryOptions['onSettled']
  private readonly onCancelled?: HostNodeInteractionRegistryOptions['onCancelled']
  private shutdownRequested = false

  constructor(options: HostNodeInteractionRegistryOptions = {}) {
    this.maxPending = Math.max(1, Math.min(10_000, options.maxPending ?? 1_000))
    this.timeoutMs = options.timeoutMs
    this.onRegistered = options.onRegistered
    this.onSettled = options.onSettled
    this.onCancelled = options.onCancelled
  }

  register(interaction: HostNodePendingInteraction): Promise<HostNodeInteractionSettlement> {
    if (this.shutdownRequested) {
      return Promise.reject(new Error('HostNodeInteractionRegistry: shutdown requested'))
    }
    if (!isValidPending(interaction)) {
      return Promise.reject(
        new Error('HostNodeInteractionRegistry: pending interaction is invalid')
      )
    }
    if (this.pending.size >= this.maxPending) {
      // Evict oldest (creation order) to keep bounded.
      const oldest = this.pending.values().next().value as PendingEntry | undefined
      if (oldest) {
        oldest.cancel('HostNodeInteractionRegistry: evicted by newer entry')
        this.pending.delete(oldest.interaction.id)
      }
    }
    const entry = new PendingEntry(
      interaction,
      (e, context) => {
        this.pending.delete(e.interaction.id)
        this.onSettled?.(
          {
            id: e.interaction.id,
            kind: e.interaction.kind,
            providerId: e.interaction.providerId,
            runId: e.interaction.runId,
            threadId: e.interaction.threadId
          },
          context
        )
      },
      (e, reason) => {
        this.pending.delete(e.interaction.id)
        this.onCancelled?.(
          {
            id: e.interaction.id,
            kind: e.interaction.kind,
            providerId: e.interaction.providerId,
            runId: e.interaction.runId,
            threadId: e.interaction.threadId
          },
          reason
        )
      },
      this.timeoutMs
    )
    this.pending.set(interaction.id, entry)
    this.onRegistered?.(interaction)
    return entry.promise
  }

  decide(input: {
    readonly id: string
    readonly decision: HostApprovalDecideDecision
    readonly actor: HostNodeInteractionActor
  }): { settled: HostNodePendingInteractionSettled | null } {
    if (!isCanonicalId(input.id)) return { settled: null }
    if (!HOST_APPROVAL_DECIDE_DECISIONS.includes(input.decision)) return { settled: null }
    if (!isValidActor(input.actor)) return { settled: null }
    const entry = this.pending.get(input.id)
    if (!entry || entry.settled || entry.cancelled || entry.interaction.kind !== 'approval') {
      return { settled: null }
    }
    entry.settle({ actor: input.actor, target: { id: input.actor.clientId } }, input.decision)
    return {
      settled: {
        id: entry.interaction.id,
        kind: 'approval',
        providerId: entry.interaction.providerId,
        runId: entry.interaction.runId,
        threadId: entry.interaction.threadId
      }
    }
  }

  answer(input: {
    readonly id: string
    readonly decision: HostQuestionAnswerDecision
    readonly answer?: string
    readonly actor: HostNodeInteractionActor
  }): { settled: HostNodePendingInteractionSettled | null } {
    if (!isCanonicalId(input.id)) return { settled: null }
    if (!HOST_QUESTION_ANSWER_DECISIONS.includes(input.decision)) return { settled: null }
    if (!isValidActor(input.actor)) return { settled: null }
    const entry = this.pending.get(input.id)
    if (!entry || entry.settled || entry.cancelled || entry.interaction.kind !== 'question') {
      return { settled: null }
    }
    entry.settle(
      { actor: input.actor, target: { id: input.actor.clientId } },
      input.decision,
      input.answer
    )
    return {
      settled: {
        id: entry.interaction.id,
        kind: 'question',
        providerId: entry.interaction.providerId,
        runId: entry.interaction.runId,
        threadId: entry.interaction.threadId
      }
    }
  }

  /** Cancel all pending interactions for a run (provider child exited). */
  cancelByRunId(
    runId: string,
    reason = 'HostNodeInteractionRegistry: provider child exited'
  ): number {
    if (!isCanonicalId(runId)) return 0
    let cancelled = 0
    for (const entry of this.pending.values()) {
      if (entry.interaction.runId === runId && !entry.settled && !entry.cancelled) {
        entry.cancel(reason)
        cancelled += 1
      }
    }
    return cancelled
  }

  /** Cancel all pending interactions for a thread. */
  cancelByThreadId(
    threadId: string,
    reason = 'HostNodeInteractionRegistry: thread closed'
  ): number {
    if (!isCanonicalId(threadId)) return 0
    let cancelled = 0
    for (const entry of this.pending.values()) {
      if (entry.interaction.threadId === threadId && !entry.settled && !entry.cancelled) {
        entry.cancel(reason)
        cancelled += 1
      }
    }
    return cancelled
  }

  /** Cancel a specific pending interaction by id. */
  cancelById(id: string, reason = 'HostNodeInteractionRegistry: interaction cancelled'): boolean {
    if (!isCanonicalId(id)) return false
    const entry = this.pending.get(id)
    if (!entry || entry.settled || entry.cancelled) return false
    entry.cancel(reason)
    return true
  }

  listPending(): readonly HostNodePendingInteraction[] {
    return [...this.pending.values()].map((entry) => entry.interaction)
  }

  async shutdown(): Promise<void> {
    this.shutdownRequested = true
    for (const entry of this.pending.values()) {
      entry.cancel('HostNodeInteractionRegistry: shutdown')
    }
    this.pending.clear()
  }
}
