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
  register(interaction: HostNodePendingInteraction): void
}

export interface HostNodeInteractionRegistryOptions {
  /** Maximum pending entries per kind; bounded to avoid unbounded growth. */
  readonly maxPending?: number
  /** Optional hook called when an interaction settles; domain uses it to reconcile. */
  readonly onSettled?: (
    settled: HostNodePendingInteractionSettled,
    context: HostNodeInteractionResolveContext
  ) => void
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
  constructor(
    readonly interaction: HostNodePendingInteraction,
    private readonly settleCallback: (
      entry: PendingEntry,
      context: HostNodeInteractionResolveContext
    ) => void,
    private readonly cancelCallback: (entry: PendingEntry) => void
  ) {}

  settle(context: HostNodeInteractionResolveContext): void {
    if (this.settled || this.cancelled) return
    this.settled = true
    this.settleCallback(this, context)
  }

  cancel(): void {
    if (this.settled || this.cancelled) return
    this.cancelled = true
    this.cancelCallback(this)
  }
}

/**
 * In-memory interaction registry. Tool bodies and secrets are excluded by
 * construction; only metadata crosses this boundary.
 */
export class HostNodeInteractionRegistry implements HostNodeInteractionResolver {
  private readonly pending = new Map<string, PendingEntry>()
  private readonly maxPending: number
  private readonly onSettled?: HostNodeInteractionRegistryOptions['onSettled']
  private shutdownRequested = false

  constructor(options: HostNodeInteractionRegistryOptions = {}) {
    this.maxPending = Math.max(1, Math.min(10_000, options.maxPending ?? 1_000))
    this.onSettled = options.onSettled
  }

  register(interaction: HostNodePendingInteraction): void {
    if (this.shutdownRequested) return
    if (!isValidPending(interaction)) {
      throw new Error('HostNodeInteractionRegistry: pending interaction is invalid')
    }
    if (this.pending.size >= this.maxPending) {
      // Evict oldest (creation order) to keep bounded.
      const oldest = this.pending.values().next().value as PendingEntry | undefined
      if (oldest) {
        oldest.cancel()
        this.pending.delete(oldest.interaction.id)
      }
    }
    const entry = new PendingEntry(
      interaction,
      (e, context) => {
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
        this.pending.delete(e.interaction.id)
      },
      (e) => {
        this.pending.delete(e.interaction.id)
      }
    )
    this.pending.set(interaction.id, entry)
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
    entry.settle({ actor: input.actor, target: { id: input.actor.clientId } })
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
    entry.settle({ actor: input.actor, target: { id: input.actor.clientId } })
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

  listPending(): readonly HostNodePendingInteraction[] {
    return [...this.pending.values()].map((entry) => entry.interaction)
  }

  async shutdown(): Promise<void> {
    this.shutdownRequested = true
    for (const entry of this.pending.values()) {
      entry.cancel()
    }
    this.pending.clear()
  }
}
